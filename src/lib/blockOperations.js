"use strict";

/**
 * Block operations: change one element in a page's stored HTML without
 * re-saving the page (haxtheweb/issues#3270).
 *
 * The stored page is a string. scanElements() walks it once and records each
 * element's exact source span; nothing is re-serialized, so every byte
 * outside a changed element stays as it was stored.
 *
 * A target is { tag, index, before }:
 *   tag    element name
 *   index  0-based position among elements with that tag, in document order
 *          of the stored source (computed with this same scanner; a browser
 *          DOM can number elements differently)
 *   before the element's exact stored source, start tag to end tag. If the
 *          stored bytes there are not exactly `before`, nothing is written.
 *          If `index` points elsewhere but exactly one element of that tag
 *          has source equal to `before`, that one is used (content was added
 *          above it); two or more is refused as ambiguous.
 *
 * Operations:
 *   setAttributes { set: { name: value | null } }
 *     rewrites only that attribute's bytes in the start tag; null removes.
 *     Names must be in the per-tag allowlist (haxcmsBlockAttributes.json);
 *     values are normalized by kind (text / url).
 *   replaceBlock { after }
 *     replaces the whole element; `after` is one complete element with the
 *     same tag, and the tag must be in the allowlist.
 *
 * runBlockOperations() then
 *   - checks the change against the storage sanitizer: each new attribute
 *     must survive it unchanged on a bare copy of the element; a new block
 *     must come out of it structurally unchanged (the rest of the page is
 *     not re-sanitized, so older markup is left exactly as stored)
 *   - parses the page before and after with a real HTML parser and requires
 *     the target element(s) to be the only difference.
 *
 * Parity: haxcms-php lib/BlockOperations.php implements the same rules and
 * codes; test/fixtures/block-operations-vectors.json runs in both.
 */

const { JSDOM } = require("jsdom");
const ALLOWLIST = require("./haxcmsBlockAttributes.json");

const MAX_OPS = 200;
const MAX_TEXT_LENGTH = 4000;
const MAX_URL_LENGTH = 2048;
const MAX_BLOCK_LENGTH = 200000;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// content is raw text up to the matching end tag
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);
// start tags that implicitly close an open <p>
const CLOSES_P = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);
// phrasing elements a <p> close looks through
const PHRASING = new Set([
  "span",
  "a",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "small",
  "code",
  "sub",
  "sup",
  "mark",
]);
// tag -> start tags that implicitly close it when it is the current node
const IMPLIED_BY = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr", "tbody", "thead", "tfoot"]),
  td: new Set(["td", "th", "tr", "tbody", "thead", "tfoot"]),
  th: new Set(["td", "th", "tr", "tbody", "thead", "tfoot"]),
  option: new Set(["option", "optgroup"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot"]),
};
// elements whose markup carries page metadata; never block targets
const NEVER_TARGET = new Set(["page-break", "script", "style", "template"]);
// attribute names never settable, whatever the allowlist says
const BLOCKED_ATTRS = /^(on|srcdoc$|style$|formaction$)/i;
const TAG_NAME = /^[a-z][a-z0-9-]*$/;
const ATTR_NAME = /^[a-z_:][a-z0-9_.:-]*$/;
// elements parsed in a specific parent context for the sanitizer probe
const CONTEXT = {
  td: ["<table><tbody><tr>", "</tr></tbody></table>"],
  th: ["<table><tbody><tr>", "</tr></tbody></table>"],
  tr: ["<table><tbody>", "</tbody></table>"],
  tbody: ["<table>", "</table>"],
  thead: ["<table>", "</table>"],
  tfoot: ["<table>", "</table>"],
  caption: ["<table>", "</table>"],
  colgroup: ["<table>", "</table>"],
  col: ["<table><colgroup>", "</colgroup></table>"],
  li: ["<ul>", "</ul>"],
  dt: ["<dl>", "</dl>"],
  dd: ["<dl>", "</dl>"],
  option: ["<select>", "</select>"],
  source: ["<video>", "</video>"],
  track: ["<video>", "</video>"],
  area: ['<map name="m">', "</map>"],
};

// Value rules shared with haxcms-php byte for byte:
//  - names are lower-cased in ASCII only (as HTML does)
//  - lengths count code points, not UTF-16 units or bytes
//  - trimming removes exactly the characters String.prototype.trim removes
//    (the sanitizer trims attribute values the same way)
const TRIM_CLASS =
  "\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const TRIM_RE = new RegExp(`^[${TRIM_CLASS}]+|[${TRIM_CLASS}]+$`, "g");
const URL_FORBIDDEN_RE = new RegExp(`[${TRIM_CLASS}\\u0000-\\u001f\\u007f]`);
const TEXT_FORBIDDEN_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// a lone UTF-16 surrogate cannot be stored as UTF-8 (PHP refuses it in JSON)
const LONE_SURROGATE_RE = /\p{Cs}/u;
// http(s) URLs: ASCII host name, optional port, no user info
// (https://good.example@evil.example), then anything without spaces.
// Bracketed IPv6 hosts are refused: haxcms-php stores through libxml, which
// percent-encodes the brackets. Site paths: no scheme, not protocol-relative.
const HTTP_URL_RE =
  /^https?:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?(?:[/?#].*)?$/is;
// URL values are stored percent-encoded wherever haxcms-php's libxml would
// encode them on save (non-ASCII and " $ [ ] ^ ` { | }), so both backends
// store the same bytes and the value sent reads back exactly.
const URL_ENCODE_RE = /[^\u0000-\u007f]|["$[\]^`{|}]/gu;
// DOMPurify drops an attribute whose value holds one of these (mXSS guard);
// refuse them in both backends rather than store what one would drop.
// ASCII case only, like the sanitizer (no u flag).
const MARKUP_CLOSE_RE =
  /(--!?|\])>|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i;
function canonicalUrl(value) {
  return value.replace(URL_ENCODE_RE, (ch) => encodeURIComponent(ch));
}
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
function isAllowedUrl(value) {
  if (value === "" || value.indexOf("//") === 0 || value.indexOf("\\") !== -1) {
    return value === "";
  }
  if (/^https?:/i.test(value)) {
    return HTTP_URL_RE.test(value);
  }
  // a colon before any / ? # means a scheme (javascript:, data:, mailto:)
  return !SCHEME_RE.test(value);
}
function asciiLower(value) {
  return String(value).replace(/[A-Z]/g, (c) => c.toLowerCase());
}
function codePoints(value) {
  return Array.from(value).length;
}

function isWhitespace(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

/**
 * Parse the attributes of a start tag from `i` (just past the tag name).
 * { attrs: [{ name, start, end, valueStart, valueEnd, quote }], end,
 *   selfClosing }; end is the index just past '>' or -1 if unterminated.
 */
function scanAttributes(html, i) {
  const attrs = [];
  const n = html.length;
  while (i < n) {
    while (i < n && (isWhitespace(html[i]) || html[i] === "/")) {
      if (html[i] === "/" && html[i + 1] === ">") {
        return { attrs, end: i + 2, selfClosing: true };
      }
      i++;
    }
    if (i >= n) {
      break;
    }
    if (html[i] === ">") {
      return { attrs, end: i + 1, selfClosing: false };
    }
    const start = i;
    // a leading = belongs to the name, as in the HTML tokenizer
    i++;
    while (
      i < n &&
      !isWhitespace(html[i]) &&
      html[i] !== "/" &&
      html[i] !== ">" &&
      html[i] !== "="
    ) {
      i++;
    }
    const name = asciiLower(html.slice(start, i));
    let j = i;
    while (j < n && isWhitespace(html[j])) {
      j++;
    }
    if (html[j] === "=") {
      j++;
      while (j < n && isWhitespace(html[j])) {
        j++;
      }
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close === -1) {
          return { attrs, end: -1, selfClosing: false };
        }
        attrs.push({
          name,
          start,
          end: close + 1,
          valueStart: j + 1,
          valueEnd: close,
          quote: q,
        });
        i = close + 1;
      } else {
        let k = j;
        while (k < n && !isWhitespace(html[k]) && html[k] !== ">") {
          k++;
        }
        attrs.push({
          name,
          start,
          end: k,
          valueStart: j,
          valueEnd: k,
          quote: "",
        });
        i = k;
      }
    } else {
      attrs.push({
        name,
        start,
        end: i,
        valueStart: -1,
        valueEnd: -1,
        quote: "",
      });
    }
  }
  return { attrs, end: -1, selfClosing: false };
}

function isNameStart(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/**
 * Every element in `html` with its source spans, in document order:
 * [{ tag, start, openEnd, end, explicit, index, depth, attrs }].
 * explicit: the element has an exact end (void, or a matching end tag); end
 * is -1 when it never closes. A custom element written <x-y /> is an open
 * tag, as browsers parse it: the following content is inside it.
 */
function scanElements(html) {
  const out = [];
  const stack = [];
  const perTag = {};
  const n = html.length;
  let i = 0;
  function closeImplicit(el, at) {
    el.end = at;
    el.explicit = false;
  }
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    i = lt;
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const close = html.indexOf(">", i + 2);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (html[i + 1] === "/") {
      if (!isNameStart(html[i + 2] || "")) {
        const close = html.indexOf(">", i + 2);
        i = close === -1 ? n : close + 1;
        continue;
      }
      let j = i + 2;
      while (
        j < n &&
        !isWhitespace(html[j]) &&
        html[j] !== "/" &&
        html[j] !== ">"
      ) {
        j++;
      }
      const name = asciiLower(html.slice(i + 2, j));
      const close = html.indexOf(">", j);
      const after = close === -1 ? n : close + 1;
      let k = stack.length - 1;
      while (k >= 0 && stack[k].tag !== name) {
        k--;
      }
      if (k >= 0) {
        while (stack.length - 1 > k) {
          closeImplicit(stack.pop(), i);
        }
        const el = stack.pop();
        el.end = after;
        el.explicit = close !== -1;
      }
      i = after;
      continue;
    }
    if (!isNameStart(html[i + 1] || "")) {
      i++;
      continue;
    }
    let j = i + 1;
    while (
      j < n &&
      !isWhitespace(html[j]) &&
      html[j] !== "/" &&
      html[j] !== ">"
    ) {
      j++;
    }
    const tag = asciiLower(html.slice(i + 1, j));
    const parsed = scanAttributes(html, j);
    if (parsed.end === -1) {
      // unterminated start tag: nothing after it is addressable
      break;
    }
    const top = stack.length ? stack[stack.length - 1] : null;
    if (top && IMPLIED_BY[top.tag] && IMPLIED_BY[top.tag].has(tag)) {
      closeImplicit(stack.pop(), i);
    }
    if (CLOSES_P.has(tag)) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === "p") {
          while (stack.length - 1 >= k) {
            closeImplicit(stack.pop(), i);
          }
          break;
        }
        if (!PHRASING.has(stack[k].tag)) {
          break;
        }
      }
    }
    if (!Object.prototype.hasOwnProperty.call(perTag, tag)) {
      perTag[tag] = 0;
    }
    const el = {
      tag,
      start: i,
      openEnd: parsed.end,
      end: -1,
      explicit: false,
      index: perTag[tag]++,
      depth: stack.length,
      attrs: parsed.attrs,
    };
    out.push(el);
    i = parsed.end;
    if (VOID.has(tag)) {
      el.end = parsed.end;
      el.explicit = true;
      continue;
    }
    if (RAW_TEXT.has(tag)) {
      // case-insensitive end tag search on the original string: lowercasing
      // the page can change its length (e.g. U+0130) and shift offsets
      const endTag = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, "gi");
      endTag.lastIndex = i;
      const found = endTag.exec(html);
      const close = found ? html.indexOf(">", found.index) : -1;
      if (close === -1) {
        el.end = -1;
        i = n;
        continue;
      }
      el.end = close + 1;
      el.explicit = true;
      i = close + 1;
      continue;
    }
    stack.push(el);
  }
  while (stack.length) {
    closeImplicit(stack.pop(), -1);
  }
  return out;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {});
}

function allowedAttributes(tag, allowlist) {
  const list = allowlist || ALLOWLIST;
  if (
    !list ||
    !list.tags ||
    !Object.prototype.hasOwnProperty.call(list.tags, tag)
  ) {
    return null;
  }
  return list.tags[tag];
}

/**
 * Normalize a value by its allowlist kind. Returns { ok, value } or a
 * failure. text: trimmed, no control characters except tab and newline;
 * url: trimmed, no whitespace or control characters, http(s) or a path,
 * then percent-encoded where storage would encode it (canonicalUrl).
 */
function normalizeValue(kind, raw, name) {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return fail("invalid", `${name} must be a string or null`);
  }
  // the sanitizer trims attribute values; trim first so the value sent is
  // the value stored. HTML stores CR LF and a lone CR as LF.
  const value = raw.replace(/\r\n?/g, "\n").replace(TRIM_RE, "");
  if (MARKUP_CLOSE_RE.test(value)) {
    return fail(
      "invalid",
      `${name} cannot contain "-->", "]>" or a closing tag such as "</title"`,
    );
  }
  if (kind === "url") {
    if (URL_FORBIDDEN_RE.test(value) || LONE_SURROGATE_RE.test(value)) {
      return fail(
        "invalid",
        `${name} cannot contain spaces or control characters`,
      );
    }
    if (!isAllowedUrl(value)) {
      return fail("invalid", `${name} must be an http(s) URL or a site path`);
    }
    const encoded = canonicalUrl(value);
    if (encoded.length > MAX_URL_LENGTH) {
      return fail(
        "invalid",
        `${name} is longer than ${MAX_URL_LENGTH} characters`,
      );
    }
    return { ok: true, value: encoded };
  }
  if (codePoints(value) > MAX_TEXT_LENGTH) {
    return fail(
      "invalid",
      `${name} is longer than ${MAX_TEXT_LENGTH} characters`,
    );
  }
  if (TEXT_FORBIDDEN_RE.test(value) || LONE_SURROGATE_RE.test(value)) {
    return fail("invalid", `${name} cannot contain control characters`);
  }
  return { ok: true, value };
}

/** Resolve one op's target; { ok, el, relocated } or a failure. */
function resolveTarget(html, scan, op) {
  const tag = typeof op.tag === "string" ? asciiLower(op.tag) : "";
  if (!TAG_NAME.test(tag)) {
    return fail("invalid", "tag must be an element name");
  }
  if (NEVER_TARGET.has(tag)) {
    return fail(
      "not-allowed",
      `<${tag}> cannot be changed with block operations`,
    );
  }
  if (typeof op.before !== "string" || op.before === "") {
    return fail("invalid", "before is required");
  }
  const candidates = scan.filter((e) => e.tag === tag);
  const at =
    Number.isInteger(op.index) && op.index >= 0
      ? candidates[op.index]
      : undefined;
  if (
    at &&
    at.explicit &&
    at.end !== -1 &&
    html.slice(at.start, at.end) === op.before
  ) {
    return { ok: true, el: at, relocated: false };
  }
  const same = candidates.filter(
    (e) =>
      e.explicit && e.end !== -1 && html.slice(e.start, e.end) === op.before,
  );
  if (same.length === 1) {
    return { ok: true, el: same[0], relocated: true };
  }
  if (same.length > 1) {
    return fail(
      "ambiguous",
      "more than one matching element and index does not point at one",
    );
  }
  if (
    at &&
    (!at.explicit || at.end === -1) &&
    html.slice(at.start, at.openEnd) ===
      op.before.slice(0, at.openEnd - at.start)
  ) {
    return fail(
      "not-addressable",
      "this element has no exact end in the stored page",
    );
  }
  return fail("stale", "the stored element no longer matches before");
}

/** New source for a resolved target; { ok, after, set } or a failure. */
function buildReplacement(html, el, op, allowlist) {
  const allowed = allowedAttributes(el.tag, allowlist);
  if (!allowed) {
    return fail("not-allowed", `<${el.tag}> is not in the block allowlist`);
  }
  const source = html.slice(el.start, el.end);
  if (op.op === "setAttributes") {
    if (!op.set || typeof op.set !== "object" || Array.isArray(op.set)) {
      return fail("invalid", "set must be an object of attribute names");
    }
    const names = Object.keys(op.set);
    if (!names.length) {
      return fail("invalid", "set must name at least one attribute");
    }
    const set = {};
    for (const rawName of names) {
      const name = asciiLower(rawName);
      if (!ATTR_NAME.test(name) || BLOCKED_ATTRS.test(name)) {
        return fail("not-allowed", `attribute "${name}" cannot be set`);
      }
      if (!Object.prototype.hasOwnProperty.call(allowed, name)) {
        return fail(
          "not-allowed",
          `attribute "${name}" is not in the allowlist for <${el.tag}>`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(set, name)) {
        return fail("invalid", `attribute "${name}" is named twice`);
      }
      const norm = normalizeValue(allowed[name], op.set[rawName], name);
      if (!norm.ok) {
        return norm;
      }
      set[name] = norm.value;
    }
    const edits = [];
    const seen = new Set();
    for (const a of el.attrs) {
      if (!Object.prototype.hasOwnProperty.call(set, a.name)) {
        continue;
      }
      if (seen.has(a.name)) {
        // the first of duplicate attributes is the one HTML uses
        return fail(
          "not-addressable",
          `attribute "${a.name}" appears twice on this element`,
        );
      }
      seen.add(a.name);
      const v = set[a.name];
      if (v === null) {
        let from = a.start;
        while (from > el.start && isWhitespace(html[from - 1])) {
          from--;
        }
        edits.push([from - el.start, a.end - el.start, ""]);
      } else {
        edits.push([
          a.start - el.start,
          a.end - el.start,
          `${a.name}="${escapeAttr(v)}"`,
        ]);
      }
    }
    const insertAt = 1 + el.tag.length;
    const added = Object.keys(set)
      .filter((name) => !seen.has(name) && set[name] !== null)
      .map((name) => ` ${name}="${escapeAttr(set[name])}"`)
      .join("");
    if (added) {
      edits.push([insertAt, insertAt, added]);
    }
    edits.sort((a, b) => b[0] - a[0]);
    let next = source;
    for (const [from, to, text] of edits) {
      next = next.slice(0, from) + text + next.slice(to);
    }
    return { ok: true, after: next, set };
  }
  if (op.op === "replaceBlock") {
    if (typeof op.after !== "string" || op.after === "") {
      return fail("invalid", "after is required");
    }
    if (op.after.length > MAX_BLOCK_LENGTH) {
      return fail(
        "invalid",
        `after is longer than ${MAX_BLOCK_LENGTH} characters`,
      );
    }
    const inner = scanElements(op.after);
    const top = inner.filter((e) => e.depth === 0);
    if (
      top.length !== 1 ||
      top[0].start !== 0 ||
      top[0].end !== op.after.length ||
      !top[0].explicit ||
      top[0].tag !== el.tag
    ) {
      return fail(
        "invalid",
        `after must be exactly one complete <${el.tag}> element`,
      );
    }
    if (inner.some((e) => NEVER_TARGET.has(e.tag) && e.tag === "page-break")) {
      return fail("invalid", "after cannot contain a page-break");
    }
    return { ok: true, after: op.after, set: null };
  }
  return fail("invalid", "op must be setAttributes or replaceBlock");
}

/**
 * Splice a batch of ops into one page. All or nothing.
 * { ok, content, results: [{ start, end, relocated, set }] } or a failure
 * with `op` (the index of the failing op).
 */
function applyBlockOps(html, ops, allowlist) {
  if (typeof html !== "string") {
    return fail("invalid", "the page has no stored content");
  }
  if (!Array.isArray(ops) || !ops.length) {
    return fail("invalid", "ops must be a non-empty array");
  }
  if (ops.length > MAX_OPS) {
    return fail("invalid", `at most ${MAX_OPS} ops per page`);
  }
  const scan = scanElements(html);
  const resolved = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      return fail("invalid", "each op must be an object", { op: i });
    }
    const target = resolveTarget(html, scan, op);
    if (!target.ok) {
      return Object.assign(target, { op: i });
    }
    const rep = buildReplacement(html, target.el, op, allowlist);
    if (!rep.ok) {
      return Object.assign(rep, { op: i });
    }
    resolved.push({
      i,
      el: target.el,
      after: rep.after,
      set: rep.set,
      relocated: target.relocated,
    });
  }
  const byStart = resolved.slice().sort((a, b) => a.el.start - b.el.start);
  for (let k = 1; k < byStart.length; k++) {
    if (byStart[k].el.start < byStart[k - 1].el.end) {
      return fail(
        "overlap",
        "two ops target the same element or one inside another",
        { op: byStart[k].i },
      );
    }
  }
  let content = html;
  for (let k = byStart.length - 1; k >= 0; k--) {
    const r = byStart[k];
    content = content.slice(0, r.el.start) + r.after + content.slice(r.el.end);
  }
  const results = new Array(ops.length);
  let shift = 0;
  for (const r of byStart) {
    const start = r.el.start + shift;
    results[r.i] = {
      tag: r.el.tag,
      index: r.el.index,
      start,
      end: start + r.after.length,
      relocated: r.relocated,
      set: r.set,
    };
    shift += r.after.length - (r.el.end - r.el.start);
  }
  return { ok: true, content, results };
}

// ---- checks with a real parser ------------------------------------------

// One shared window; each parse gets a new document from it. A new JSDOM per
// parse keeps roughly half a megabyte alive even after window.close(), which
// a bulk save would turn into an unbounded leak.
let scratchWindow = null;
function parseBody(html) {
  if (scratchWindow === null) {
    scratchWindow = new JSDOM(
      "<!doctype html><html><head></head><body></body></html>",
    ).window;
  }
  const doc = scratchWindow.document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  return {
    body: doc.body,
    close: () => {
      doc.body.textContent = "";
    },
  };
}

function sameChildren(a, b) {
  const x = a.childNodes;
  const y = b.childNodes;
  if (x.length !== y.length) {
    return false;
  }
  for (let i = 0; i < x.length; i++) {
    if (!sameNode(x[i], y[i])) {
      return false;
    }
  }
  return true;
}

function sameNode(a, b) {
  if (a.nodeType !== b.nodeType) {
    return false;
  }
  if (a.nodeType === 3 || a.nodeType === 8) {
    return a.data === b.data;
  }
  if (a.nodeType !== 1) {
    return true;
  }
  if (
    a.localName !== b.localName ||
    a.attributes.length !== b.attributes.length
  ) {
    return false;
  }
  for (const at of Array.from(a.attributes)) {
    if (b.getAttribute(at.name) !== at.value) {
      return false;
    }
  }
  if (
    a.localName === "template" &&
    a.content &&
    b.content &&
    !sameChildren(a.content, b.content)
  ) {
    return false;
  }
  return sameChildren(a, b);
}

// differing element pairs, outermost first; stops at the first difference
function diffs(a, b, out, limit) {
  if (out.length > limit) {
    return out;
  }
  if (
    a.nodeType !== b.nodeType ||
    (a.nodeType === 1 && a.localName !== b.localName)
  ) {
    out.push({ a, b, kind: "shape" });
    return out;
  }
  if (a.nodeType === 3 || a.nodeType === 8) {
    if (a.data !== b.data) {
      out.push({ a: a.parentNode, b: b.parentNode, kind: "text" });
    }
    return out;
  }
  if (a.nodeType !== 1 && a.nodeType !== 11) {
    return out;
  }
  let attrsDiffer = false;
  if (a.nodeType === 1) {
    const names = new Set(
      Array.from(a.attributes)
        .map((t) => t.name)
        .concat(Array.from(b.attributes).map((t) => t.name)),
    );
    names.forEach((name) => {
      if (a.getAttribute(name) !== b.getAttribute(name)) {
        attrsDiffer = true;
      }
    });
  }
  if (a.childNodes.length !== b.childNodes.length) {
    out.push({ a, b, kind: "children" });
    return out;
  }
  if (attrsDiffer) {
    out.push({ a, b, kind: "attrs" });
    // keep walking: each difference below must be explained on its own (an
    // HTML4 parser can nest a following void sibling such as <track> here)
    if (sameChildren(a, b)) {
      return out;
    }
  }
  for (let i = 0; i < a.childNodes.length; i++) {
    diffs(a.childNodes[i], b.childNodes[i], out, limit);
  }
  if (a.localName === "template" && a.content && b.content) {
    diffs(a.content, b.content, out, limit);
  }
  return out;
}

// how a browser stores an attribute value
function storedForm(value) {
  return String(value).replace(/\r\n?/g, "\n");
}

/**
 * The only differences between the page before and after must be the
 * targets: same element, only the set attributes changed to exactly the
 * requested values (setAttributes), or one element of the same tag at the
 * same place (replaceBlock).
 */
function verifyStructure(beforeHtml, afterHtml, ops, normalized) {
  const A = parseBody(beforeHtml);
  const B = parseBody(afterHtml);
  try {
    // never decide on a partial walk
    const limit = ops.length * 4 + 64;
    const found = diffs(A.body, B.body, [], limit);
    if (found.length > limit) {
      return fail(
        "structure-changed",
        "the change would alter more than the target elements",
      );
    }
    const used = new Set();
    // elements a replaceBlock op accounts for; everything inside them is its
    const replaced = [];
    for (const d of found) {
      if (!d.b || d.b.nodeType !== 1 || !d.a || d.a.nodeType !== 1) {
        return fail(
          "structure-changed",
          "the change would alter more than the target elements",
        );
      }
      // (a text change directly inside reports the element itself)
      if (replaced.some((node) => node.contains(d.b))) {
        continue;
      }
      // each difference must be explained by an op on that tag not yet used
      let matched = -1;
      for (let i = 0; i < ops.length; i++) {
        if (used.has(i) || asciiLower(ops[i].tag) !== d.b.localName) {
          continue;
        }
        if (ops[i].op === "setAttributes") {
          if (d.kind !== "attrs" || d.a.localName !== d.b.localName) {
            continue;
          }
          const set = normalized[i] || {};
          const names = new Set(
            Array.from(d.a.attributes)
              .map((t) => t.name)
              .concat(Array.from(d.b.attributes).map((t) => t.name)),
          );
          let ok = true;
          names.forEach((name) => {
            if (
              d.a.getAttribute(name) !== d.b.getAttribute(name) &&
              !Object.prototype.hasOwnProperty.call(set, name)
            ) {
              ok = false;
            }
          });
          Object.keys(set).forEach((name) => {
            const want = set[name] === null ? null : storedForm(set[name]);
            if (d.b.getAttribute(name) !== want) {
              ok = false;
            }
          });
          if (ok) {
            matched = i;
            break;
          }
        } else if (d.a.localName === d.b.localName) {
          matched = i;
          break;
        }
      }
      if (matched === -1) {
        return fail(
          "structure-changed",
          "the change would alter more than the target elements",
        );
      }
      used.add(matched);
      if (ops[matched].op === "replaceBlock") {
        replaced.push(d.b);
      }
    }
    return { ok: true };
  } finally {
    A.close();
    B.close();
  }
}

/**
 * Sanitize the change, not the page. `sanitize` is the backend's storage
 * sanitizer (html -> html).
 */
function checkChangeSanitizes(op, tag, set, newBlock, sanitize) {
  const ctx = CONTEXT[tag] || ["", ""];
  if (op.op === "setAttributes") {
    const names = Object.keys(set).filter((n) => set[n] !== null);
    if (!names.length) {
      return { ok: true };
    }
    const attrs = names.map((n) => ` ${n}="${escapeAttr(set[n])}"`).join("");
    const probe = VOID.has(tag)
      ? `<${tag}${attrs}>`
      : `<${tag}${attrs}></${tag}>`;
    const clean = parseBody(sanitize(ctx[0] + probe + ctx[1]));
    try {
      const el = clean.body.querySelector(tag);
      if (!el) {
        return fail(
          "sanitizer-rejected",
          `the storage sanitizer removes <${tag}>`,
        );
      }
      for (const n of names) {
        if (el.getAttribute(n) !== storedForm(set[n])) {
          return fail(
            "sanitizer-rejected",
            `the storage sanitizer changes or removes "${n}"`,
          );
        }
      }
      return { ok: true };
    } finally {
      clean.close();
    }
  }
  const raw = parseBody(ctx[0] + newBlock + ctx[1]);
  const clean = parseBody(sanitize(ctx[0] + newBlock + ctx[1]));
  try {
    if (!sameChildren(raw.body, clean.body)) {
      return fail(
        "sanitizer-rejected",
        "the storage sanitizer would change this block; send clean markup",
      );
    }
    return { ok: true };
  } finally {
    raw.close();
    clean.close();
  }
}

/**
 * The whole server pipeline for one page.
 * @param {string} html stored page content
 * @param {Array} ops
 * @param {{ sanitize: Function, allowlist?: Object }} o
 * @returns {{ ok: true, content, results } | { ok: false, code, message, op? }}
 */
function runBlockOperations(html, ops, o) {
  const options = o || {};
  const applied = applyBlockOps(html, ops, options.allowlist);
  if (!applied.ok) {
    return applied;
  }
  for (let i = 0; i < ops.length; i++) {
    const r = applied.results[i];
    const block = applied.content.slice(r.start, r.end);
    const check = checkChangeSanitizes(
      ops[i],
      r.tag,
      r.set || {},
      block,
      options.sanitize,
    );
    if (!check.ok) {
      return Object.assign(check, { op: i });
    }
  }
  const normalized = applied.results.map((r) => r.set || {});
  const verified = verifyStructure(html, applied.content, ops, normalized);
  if (!verified.ok) {
    return verified;
  }
  return applied;
}

function decodeAttributes(tag, startTag) {
  const fragment = JSDOM.fragment(
    VOID.has(tag) ? startTag : `${startTag}</${tag}>`,
  );
  const el = fragment.firstElementChild;
  const out = {};
  if (el) {
    Array.from(el.attributes).forEach((a) => {
      out[a.name] = a.value;
    });
  }
  return out;
}

/**
 * Addressable elements on a page that are in the allowlist, for clients and
 * audits: [{ tag, index, before, attributes: { allowlisted name: value } }].
 * Values are decoded the way a browser reads them.
 * @param {string} html
 * @param {{ tag?: string, allowlist?: Object }} [o]
 */
function listBlocks(html, o) {
  const options = o || {};
  const filter =
    typeof options.tag === "string" && options.tag !== ""
      ? asciiLower(options.tag)
      : "";
  const out = [];
  if (typeof html !== "string" || html === "") {
    return out;
  }
  for (const el of scanElements(html)) {
    if (filter && el.tag !== filter) {
      continue;
    }
    if (!el.explicit || el.end === -1 || NEVER_TARGET.has(el.tag)) {
      continue;
    }
    const allowed = allowedAttributes(el.tag, options.allowlist);
    if (!allowed) {
      continue;
    }
    const decoded = decodeAttributes(el.tag, html.slice(el.start, el.openEnd));
    const attributes = {};
    Object.keys(allowed).forEach((name) => {
      if (Object.prototype.hasOwnProperty.call(decoded, name)) {
        attributes[name] = decoded[name];
      }
    });
    out.push({
      tag: el.tag,
      index: el.index,
      before: html.slice(el.start, el.end),
      attributes,
    });
  }
  return out;
}

module.exports = {
  ALLOWLIST,
  MAX_OPS,
  scanElements,
  scanAttributes,
  normalizeValue,
  applyBlockOps,
  verifyStructure,
  checkChangeSanitizes,
  runBlockOperations,
  listBlocks,
  escapeAttr,
};
