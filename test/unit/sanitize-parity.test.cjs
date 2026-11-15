"use strict";

// Storage sanitizer policy shared with haxcms-php (haxtheweb/issues#3273).
//  - the policy file is what scripts/generate-sanitize-policy.cjs builds
//    from the installed DOMPurify, so an upgrade that changes its lists fails
//    here instead of drifting silently
//  - DOMPurify, kept as a backstop, changes nothing the policy produced
//  - nothing dangerous survives, read as a browser reads it
//  - saving stored HTML again changes nothing
//  - the decided behaviors, one test each
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const sc = require("../../src/lib/sanitizeContent.js");
const { sanitizeUntrustedHtml } = require("../../src/lib/convertUtils.js");
const policy = require("../../src/lib/haxcmsSanitizePolicy.json");
const { buildPolicy } = require("../../scripts/generate-sanitize-policy.cjs");
const vectors = require(
  path.join(__dirname, "..", "fixtures", "sanitize-vectors.json"),
);

const store = sc.sanitizeHTMLForStorage;

// seeded markup, malformed on purpose
let seed = Number(process.env.SANITIZE_FUZZ_SEED || 3273) >>> 0;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(rnd() * list.length)];
const TAGS = [
  "a",
  "p",
  "div",
  "span",
  "img",
  "table",
  "tr",
  "td",
  "ul",
  "li",
  "iframe",
  "template",
  "form",
  "input",
  "textarea",
  "pre",
  "object",
  "embed",
  "noscript",
  "svg",
  "math",
  "style",
  "script",
  "title",
  "xmp",
  "select",
  "option",
  "video",
  "source",
  "media-image",
  "code-sample",
  "x-y",
  "image",
  "br",
];
const ATTRS = [
  "href",
  "src",
  "alt",
  "title",
  "target",
  "id",
  "name",
  "onclick",
  "style",
  "srcdoc",
  "is",
  "data-x",
  "source",
  "xmlns",
  "sandbox",
  "action",
  "formaction",
  "text-align",
  "disabled",
];
const VALUES = [
  "x",
  "_blank",
  "javascript:alert(1)",
  " java\tscript:x",
  "data:text/html,<b>",
  "data:image/png;base64,AA==",
  "a --> b",
  "x]>y",
  "</title><b>",
  "images",
  "cookie",
  "action",
  "  pad  ",
  "café",
  "/files/a b.png",
  '"><img src=x onerror=alert(1)>',
];
const TEXT = [
  "text",
  " ",
  "a & b",
  "1 < 2",
  "<!-- c -->",
  "<!-- <b> -->",
  "&lt;script&gt;",
  "\n",
  "<?php x ?>",
];
function gen(depth) {
  if (depth > 3 || rnd() < 0.3) return pick(TEXT);
  const t = pick(TAGS);
  let attrs = "";
  for (let k = 0; k < Math.floor(rnd() * 3); k++)
    attrs += ` ${pick(ATTRS)}="${pick(VALUES).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  let inner = "";
  for (let k = 0; k < Math.floor(rnd() * 3); k++) inner += gen(depth + 1);
  return `<${t}${attrs}>${inner}${rnd() < 0.85 ? `</${t}>` : ""}`;
}
const FUZZ = Number(process.env.SANITIZE_FUZZ_ITERATIONS || 300);
const inputs = vectors.cases.map((c) =>
  c.page ? vectors.pages[c.page] : c.html,
);
for (let i = 0; i < FUZZ; i++) inputs.push(gen(0) + gen(0) + gen(0));

// what a browser builds from stored HTML, checked for anything dangerous
const win = new JSDOM("<!doctype html><body></body>").window;
const allowed = new Set(policy.allowedTags);
const customRe = new RegExp(policy.customElementName);
const unsafeValue = new RegExp(policy.unsafeAttributeValue, "i");
const clobberTags = new Set(policy.clobberTags);
const clobberNames = new Set(policy.clobberNames);
const TEXT_ATTRIBUTES = new Set([
  "alt",
  "title",
  "label",
  "caption",
  "placeholder",
  "summary",
]);
function scheme(v) {
  return String(v)
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000- ]+/, "")
    .toLowerCase();
}
function dangers(html) {
  const d = win.document.implementation.createHTMLDocument("");
  d.body.innerHTML = html;
  const found = [];
  const walk = (root) => {
    for (const n of Array.from(root.childNodes)) {
      if (n.nodeType === 8 && /[<>]/.test(n.data))
        found.push("comment with markup");
      if (n.nodeType !== 1) continue;
      const tag = n.localName;
      if (n.namespaceURI !== "http://www.w3.org/1999/xhtml")
        found.push(`foreign ${tag}`);
      if (!allowed.has(tag) && !customRe.test(tag))
        found.push(`element ${tag}`);
      for (const a of Array.from(n.attributes)) {
        const name = a.name.toLowerCase();
        const isText = TEXT_ATTRIBUTES.has(name) || name.indexOf("aria-") === 0;
        if (/^on/.test(name) || ["style", "srcdoc", "is"].indexOf(name) !== -1)
          found.push(`attribute ${name}`);
        if (
          !isText &&
          /^(javascript|vbscript|livescript|mocha):/.test(scheme(a.value))
        )
          found.push(`script scheme ${tag}[${name}]`);
        if (
          !isText &&
          /^data:(?!image\/(png|jpeg|gif|webp|avif|bmp))[a-z0-9.+-]+\/[a-z0-9.+-]+/.test(
            scheme(a.value),
          )
        )
          found.push(`data URI ${tag}[${name}]`);
        if (unsafeValue.test(a.value)) found.push(`mXSS value ${tag}[${name}]`);
        if (
          (name === "id" || name === "name") &&
          clobberTags.has(tag) &&
          clobberNames.has(a.value)
        )
          found.push(`clobber ${tag}[${name}]`);
      }
      if (
        tag === "iframe" &&
        (n.getAttribute("sandbox") === null || n.childNodes.length)
      )
        found.push("iframe");
      walk(tag === "template" ? n.content : n);
    }
  };
  walk(d.body);
  return found;
}

describe("shared policy", () => {
  test("policy file is what the generator builds from the installed DOMPurify", () => {
    assert.deepEqual(policy, buildPolicy());
  });

  test("DOMPurify, the backstop, changes nothing the policy produced", () => {
    const changed = [];
    for (const html of inputs) {
      if (sc.sanitizePolicyOnly(html) !== store(html))
        changed.push(html.slice(0, 120));
    }
    assert.deepEqual(changed.slice(0, 5), []);
  });

  test("nothing dangerous survives, read as a browser reads it", () => {
    const found = [];
    for (const html of inputs) {
      for (const d of dangers(store(html)))
        found.push(`${d} in ${JSON.stringify(html.slice(0, 80))}`);
    }
    assert.deepEqual(found.slice(0, 10), []);
  });

  test("saving stored HTML again changes nothing", () => {
    const changed = [];
    for (const html of inputs) {
      const once = store(html);
      if (store(once) !== once) changed.push(html.slice(0, 120));
    }
    assert.deepEqual(changed.slice(0, 5), []);
  });
});

describe("decided behaviors", () => {
  test("links keep target and rel", () => {
    const html =
      '<a href="https://haxtheweb.org/" target="_blank" rel="noopener">HAX</a>';
    assert.equal(store(html), html);
  });

  test("HAX attributes on standard elements stay", () => {
    const html =
      '<h2 background-color="light-blue" text-align="left">T</h2><table bordered="" sort=""><tbody><tr><td>1</td></tr></tbody></table><template preserve-content=""><b>x</b></template>';
    assert.equal(store(html), html);
  });

  test("attribute values are stored as written: no trimming, no URL encoding", () => {
    const html =
      '<p data-x="  pad  " title="\ttab">a</p><a href="files/HAX.psu World é.png">x</a>';
    assert.equal(store(html), html);
  });

  test("plain comments stay, comments that could hide markup go", () => {
    assert.equal(
      store(
        "<!-- GENERATED FILE --><p>a</p><!-- <img src=x onerror=alert(1)> --><!-- a > b --><?php x ?>",
      ),
      "<!-- GENERATED FILE --><p>a</p>",
    );
  });

  test("untrusted imports drop every comment and iframe", () => {
    assert.equal(
      sanitizeUntrustedHtml(
        '<!-- secret --><p>ok</p><iframe src="https://e.x"></iframe>',
      ),
      "<p>ok</p>",
    );
  });

  test("only real DOM clobbering names are dropped", () => {
    assert.equal(
      store(
        '<div id="images">anchor</div><h2 id="title">t</h2><img name="cookie" src="a.png"><form><input name="action"><input name="q"></form>',
      ),
      '<div id="images">anchor</div><h2 id="title">t</h2><img src="a.png"><form><input><input name="q"></form>',
    );
  });

  test("plugin and fallback elements are unwrapped or removed", () => {
    assert.equal(
      store(
        '<object data="x.swf"><param name="a">fallback</object><noscript><b>n</b></noscript><xmp>x</xmp><math><mi>m</mi></math>',
      ),
      "fallback",
    );
  });

  test("mXSS sequences in attribute values remove the attribute", () => {
    assert.equal(
      store('<img src="a.png" alt="a --> b" title="</title><b>">'),
      '<img src="a.png">',
    );
  });

  test("the is attribute does not survive serialization", () => {
    assert.equal(
      store('<div is="x-y" title="t">a</div>'),
      '<div title="t">a</div>',
    );
  });

  test("a newline the parser would drop after <pre> is dropped once", () => {
    const once = store("<pre>\n\nx</pre>");
    assert.equal(once, "<pre>x</pre>");
    assert.equal(store(once), once);
  });
});
