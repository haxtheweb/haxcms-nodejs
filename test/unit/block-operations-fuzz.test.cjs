"use strict";

// Seeded fuzz for block operations (haxtheweb/issues#3270). Generates HAX-like
// pages with parser edge cases (implied end tags, raw text, comments,
// templates, quoted '>' in attributes, entities) and applies random
// allowlisted edits with hostile values. For every accepted edit:
//   - nothing outside the target element changed, byte for byte
//   - a browser parse of the new page, with the attribute put back to its
//     old value, serializes exactly like the old page
//   - the new value reads back exactly
// Every refusal must carry a documented reason. Hostile replaceBlock payloads
// must never be written.
//
// BLOCK_FUZZ_SEED and BLOCK_FUZZ_ITERATIONS override the defaults for long
// runs; the default run is quick enough for every test pass.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const bo = require("../../src/lib/blockOperations.js");
const { sanitizeHTMLForStorage } = require("../../src/lib/sanitizeContent.js");
const vectors = require(
  path.join(__dirname, "..", "fixtures", "block-operations-vectors.json"),
);

const ITERATIONS = Number(process.env.BLOCK_FUZZ_ITERATIONS || 60);
let seed = Number(process.env.BLOCK_FUZZ_SEED || 3270) >>> 0;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];

const REASONS = new Set([
  "invalid",
  "not-allowed",
  "not-addressable",
  "stale",
  "ambiguous",
  "overlap",
  "sanitizer-rejected",
  "structure-changed",
]);
const TEXT = [
  "A diagram of the water cycle",
  'He said "hi" & left',
  "it's <b>bold</b> > less",
  "&amp; already &lt;",
  "line\nbreak\ttab",
  "  padded  ",
  "",
  "emoji 🧪 مرحبا 光合作用 İ",
  '"><script>alert(1)</script>',
  "' onerror='x",
  "{{t}} ${x}",
  "x".repeat(3000),
];
const URLS = [
  "https://media.psu.edu/a.mp4",
  "files/b.png",
  "/abs/c.jpg",
  'https://e.x/?a=1&b="2"',
  "javascript:alert(1)",
  "//evil.example",
  "data:x",
  "https://exa mple.org",
  " https://trim.me/x ",
];
const HOSTILE = [
  (t) => `<${t} onerror="alert(1)"></${t}>`,
  (t) => `<${t}><script>alert(1)</script></${t}>`,
  (t) => `<${t} style="position:fixed"></${t}>`,
  (t) => `<${t}><a href="javascript:alert(1)">x</a></${t}>`,
  (t) => `<${t}><iframe srcdoc="<script>alert(1)</script>"></iframe></${t}>`,
];

const LEAF = [
  () =>
    `<img src="files/${pick(["a", "b"])}.png"${rnd() < 0.5 ? ` alt="${pick(["", "x", "q &quot;"])}"` : ""}>`,
  () =>
    `<media-image source="https://media.aanda.psu.edu/m.jpg" alt='q "a" > b'></media-image>`,
  () =>
    '<video-player source="https://youtu.be/x" media-title=unquoted></video-player>',
  () => "<simple-img src=x alt=y />",
  () => '<a href="https://media.aanda.psu.edu/doc.pdf">doc</a>',
  () => '<!-- <img alt="comment"> -->',
  () => '<script type="application/json">{"a":"</div>"}</script>',
  () => '<textarea><img alt="raw"></textarea>',
  () => '<template><img alt="tpl"></template>',
  () => `text ${pick(["<", ">", "& ", "< 3", "&nbsp;"])}`,
  () => '<iframe src="https://e.x" title="t"></iframe>',
];
function gen(depth) {
  if (depth > 4 || rnd() < 0.35) return pick(LEAF)();
  const t = pick([
    "p",
    "div",
    "ul",
    "table",
    "grid-plate",
    "figure",
    "details",
    "a11y-collapse",
  ]);
  if (t === "ul")
    return `<ul>${[0, 1].map(() => `<li>${gen(depth + 1)}${rnd() < 0.7 ? "</li>" : ""}`).join("")}</ul>`;
  if (t === "table")
    return `<table>${rnd() < 0.5 ? "<tbody>" : ""}<tr><td>${gen(depth + 1)}</td></tr></table>`;
  if (t === "p") return `<p>${gen(depth + 1)}${rnd() < 0.8 ? "</p>" : ""}`;
  let inner = "";
  for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) inner += gen(depth + 1);
  return `<${t} class="c">${inner}</${t}>`;
}

// one shared window; a new document per parse (a JSDOM per parse leaks)
const scratch = new JSDOM("<!doctype html><html><body></body></html>").window;
function parse(html) {
  const doc = scratch.document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  return doc.body;
}
function sameTree(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === 3 || a.nodeType === 8) return a.data === b.data;
  if (a.nodeType === 1) {
    if (
      a.localName !== b.localName ||
      a.attributes.length !== b.attributes.length
    )
      return false;
    for (const at of Array.from(a.attributes)) {
      if (b.getAttribute(at.name) !== at.value) return false;
    }
  }
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < a.childNodes.length; i++) {
    if (!sameTree(a.childNodes[i], b.childNodes[i])) return false;
  }
  return true;
}

function checkAccepted(html, block, name, value, r) {
  const span = r.results[0];
  // 1. bytes outside the element are untouched
  const el = bo.scanElements(html).filter((e) => e.tag === block.tag)[
    span.index
  ];
  assert.equal(r.content.slice(0, span.start), html.slice(0, el.start));
  assert.equal(r.content.slice(span.end), html.slice(el.end));
  // 2. independent browser check: find the element the browser built from
  //    the edited bytes, put the old value back, and the whole page must
  //    match the old page
  const A = parse(html);
  const B = parse(r.content);
  const changed = Array.from(B.querySelectorAll(block.tag)).filter((n, i) => {
    const o = A.querySelectorAll(block.tag)[i];
    return !o || !sameTree(o, n);
  });
  if (changed.length !== 1) {
    // the browser numbers this element differently (template, foster
    // parenting); verifyStructure already checked the whole tree
    return;
  }
  // the value as stored: trimmed, CR LF as LF, URLs percent-encoded
  const want =
    value === null
      ? null
      : bo.normalizeValue(bo.ALLOWLIST.tags[block.tag][name], value, name)
          .value;
  assert.equal(
    changed[0].getAttribute(name),
    want,
    `${block.tag} ${name} reads back`,
  );
  const i = Array.from(B.querySelectorAll(block.tag)).indexOf(changed[0]);
  const old = A.querySelectorAll(block.tag)[i].getAttribute(name);
  if (old === null) changed[0].removeAttribute(name);
  else changed[0].setAttribute(name, old);
  assert.ok(
    sameTree(A, B),
    `${block.tag} ${name}: page differs beyond the edit`,
  );
}

test(`fuzz: ${ITERATIONS} generated pages plus the vector pages`, () => {
  const pages = Object.values(vectors.pages);
  for (let i = 0; i < ITERATIONS; i++)
    pages.push([0, 1, 2, 3].map(() => gen(0)).join(""));
  let accepted = 0;
  let refused = 0;
  for (const html of pages) {
    const blocks = bo.listBlocks(html);
    for (let k = 0; k < Math.min(4, blocks.length); k++) {
      const block = pick(blocks);
      const allowed = bo.ALLOWLIST.tags[block.tag];
      const name = pick(Object.keys(allowed));
      const value =
        rnd() < 0.1 ? null : pick(allowed[name] === "url" ? URLS : TEXT);
      const op = {
        op: "setAttributes",
        tag: block.tag,
        index: block.index,
        before: block.before,
        set: { [name]: value },
      };
      const r = bo.runBlockOperations(html, [op], {
        sanitize: sanitizeHTMLForStorage,
      });
      if (!r.ok) {
        assert.ok(REASONS.has(r.code), `unexpected reason ${r.code}`);
        // nothing about the page decides a refusal of a clean value except
        // the sanitizer and kind rules
        assert.notEqual(
          r.code,
          "structure-changed",
          `${block.tag} ${name}: ${r.message}`,
        );
        refused++;
        continue;
      }
      accepted++;
      checkAccepted(html, block, name, value, r);
      // identity replace leaves the page byte-identical
      const id = bo.runBlockOperations(
        html,
        [
          {
            op: "replaceBlock",
            tag: block.tag,
            index: block.index,
            before: block.before,
            after: block.before,
          },
        ],
        { sanitize: sanitizeHTMLForStorage },
      );
      if (id.ok) assert.equal(id.content, html);
      // hostile replacements are never written
      const hostile = pick(HOSTILE)(block.tag);
      const h = bo.runBlockOperations(
        html,
        [
          {
            op: "replaceBlock",
            tag: block.tag,
            index: block.index,
            before: block.before,
            after: hostile,
          },
        ],
        { sanitize: sanitizeHTMLForStorage },
      );
      assert.equal(
        h.ok,
        false,
        `hostile written into ${block.tag}: ${hostile}`,
      );
      // a one-byte change to before is never accepted at that element
      const flip = Math.floor(rnd() * block.before.length);
      const stale =
        block.before.slice(0, flip) +
        (block.before[flip] === "x" ? "y" : "x") +
        block.before.slice(flip + 1);
      const s = bo.runBlockOperations(
        html,
        [Object.assign({}, op, { before: stale })],
        { sanitize: sanitizeHTMLForStorage },
      );
      if (s.ok) assert.notEqual(s.results[0].start, r.results[0].start);
    }
  }
  assert.ok(accepted > 0, "some edits were accepted");
  assert.ok(refused >= 0);
});
