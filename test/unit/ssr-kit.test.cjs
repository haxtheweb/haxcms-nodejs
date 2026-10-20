"use strict";

// Covers src/lib/ssr: the inert browser surface, the skip list, and renderTag
// with injected lit pieces (no lit or @lit-labs/ssr needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const kit = () =>
  import(
    pathToFileURL(path.join(__dirname, "../../src/lib/ssr/index.mjs")).href
  );

// a lit stand-in: html() records its strings and values, render() yields them joined
const fakeLit = (chunks) => ({
  html: (strings, ...values) => ({ strings: [...strings], values }),
  render: (template) => (chunks ? chunks : [template.strings.join("|")]),
});

function withElements(map, fn) {
  const saved = globalThis.customElements;
  globalThis.customElements = { get: (tag) => map[tag] };
  return Promise.resolve(fn()).finally(() => {
    globalThis.customElements = saved;
  });
}

test("installInertDom adds the browser surface Lit SSR's shim lacks", async () => {
  const { installInertDom } = await kit();
  class FakeElement {}
  const target = {
    HTMLElement: FakeElement,
    document: { querySelector: () => "kept" },
  };
  installInertDom(target);
  assert.equal(target["window"], target);
  assert.equal(typeof target.addEventListener, "function");
  assert.equal(target.matchMedia("x").matches, false);
  assert.equal(target.document.querySelector(), "kept");
  assert.equal(target.document.body, undefined);
  assert.equal(new FakeElement().querySelector("a"), null);
});

test("ssrSkipReason covers the known elements and the static opt-out", async () => {
  const { ssrSkipReason, SSR_SKIP } = await kit();
  assert.ok(ssrSkipReason("model-viewer"));
  assert.ok(ssrSkipReason("midi-player"));
  assert.equal(ssrSkipReason("x-plain"), null);
  assert.equal(ssrSkipReason("x-own", { ssr: false }), "marked ssr = false");
  assert.equal(
    ssrSkipReason("x-own", { ssr: false, ssrSkipReason: "needs canvas" }),
    "needs canvas",
  );
  assert.equal(ssrSkipReason("toString"), null);
  assert.ok(Object.keys(SSR_SKIP).length >= 2);
});

test("buildTemplate binds demo properties and content", async () => {
  const { buildTemplate } = await kit();
  const t = buildTemplate(fakeLit().html, "x-a", {
    properties: { a: 1, "bad-key": 2, b: [3] },
    content: "<p>hi</p>",
  });
  assert.deepEqual(t.values, [1, [3]]);
  assert.equal(t.strings.join("|"), "<x-a .a=| .b=|><p>hi</p></x-a>");
});

test("collectCapped stops at the cap and flags it", async () => {
  const { collectCapped } = await kit();
  const small = await collectCapped(["ab", Promise.resolve("cd")], 10);
  assert.deepEqual(small, { html: "abcd", truncated: false });
  const big = await collectCapped(["aaaa", "bbbb", "cccc"], 6);
  assert.equal(big.truncated, true);
  assert.equal(big.html, "aaaabbbb");
});

test("hasContent ignores styles and the shadow-root wrapper", async () => {
  const { hasContent } = await kit();
  const shadow = (inner) =>
    `<x-a><template shadowroot="open"><style>p{}</style>${inner}</template></x-a>`;
  assert.equal(hasContent(shadow("<!--lit-part-->"), "x-a"), false);
  assert.equal(hasContent(shadow("<p>hi</p>"), "x-a"), true);
  assert.equal(hasContent(shadow("<img src=a>"), "x-a"), true);
});

test("fallbackMarkup keeps the host tag and drops the shadow root", async () => {
  const { fallbackMarkup } = await kit();
  const out = fallbackMarkup(
    '<!--lit-part--><x-a size="2"><template shadowroot="open"></template></x-a>',
    "x-a",
    "<p>fallback</p>",
  );
  assert.equal(out, '<x-a size="2"><p>fallback</p></x-a>');
  assert.equal(fallbackMarkup("<div></div>", "x-a", "<p>f</p>"), null);
});

test("renderTag skips known elements without rendering", async () => {
  const { renderTag } = await kit();
  let rendered = false;
  const lit = {
    html: () => ({}),
    render: () => {
      rendered = true;
      return [];
    },
  };
  const r = await withElements({}, () => renderTag(lit, "model-viewer"));
  assert.ok(r.skipped);
  assert.equal(rendered, false);
});

test("renderTag uses the haxHooks fallback only when the render is empty", async () => {
  const { renderTag } = await kit();
  class Hooked {
    haxHooks() {
      return { progressiveEnhancement: "enhance" };
    }
    enhance(el) {
      return `<p>${el.title}</p>`;
    }
  }
  const empty = fakeLit([
    '<x-h><template shadowroot="open"><style>a{}</style></template></x-h>',
  ]);
  const a = await withElements({ "x-h": Hooked }, () =>
    renderTag(empty, "x-h", { properties: { title: "T" } }),
  );
  assert.equal(a.usedFallback, true);
  assert.equal(a.html, "<x-h><p>T</p></x-h>");

  const full = fakeLit([
    '<x-h><template shadowroot="open"><p>real</p></template></x-h>',
  ]);
  const b = await withElements({ "x-h": Hooked }, () =>
    renderTag(full, "x-h", { properties: { title: "T" } }),
  );
  assert.equal(b.usedFallback, false);
  assert.match(b.html, /real/);
  assert.equal(b.progressive, "<p>T</p>");
});

test("renderTag can prepend the primitive stylesheet", async () => {
  const { renderTag, SSR_PRIMITIVE_CSS } = await kit();
  const lit = fakeLit([
    "<x-p><template shadowroot=open><p>x</p></template></x-p>",
  ]);
  const r = await withElements({}, () =>
    renderTag(lit, "x-p", {}, { primitives: true }),
  );
  assert.ok(r.html.startsWith("<style data-ssr-primitives>"));
  assert.ok(r.html.includes(SSR_PRIMITIVE_CSS));
  assert.ok(SSR_PRIMITIVE_CSS.length > 500);
});
