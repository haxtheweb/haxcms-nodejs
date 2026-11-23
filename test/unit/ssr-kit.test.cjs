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

test("installInertDom gives elements inert children, classes and styles", async () => {
  const { installInertDom } = await kit();
  class FakeElement {}
  installInertDom({ HTMLElement: FakeElement });
  const el = new FakeElement();
  assert.deepEqual([...el.children], []);
  assert.equal(el.firstChild, null);
  el.classList.add("x");
  el.style.setProperty("--a", "b");
  el.style = "ignored";
  assert.equal(el.style.getPropertyValue("--a"), "");
});

test("installInertDom builds registered classes from document.createElement and aliases self", async () => {
  const { installInertDom } = await kit();
  class Registered {}
  const target = {
    HTMLElement: class {},
    customElements: {
      get: (tag) => (tag === "x-known" ? Registered : undefined),
    },
    document: { createElement: (tag) => ({ plain: tag }) },
  };
  installInertDom(target);
  assert.equal(target.self, target);
  assert.ok(target.document.createElement("X-Known") instanceof Registered);
  assert.deepEqual(target.document.createElement("x-other"), {
    plain: "x-other",
  });
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

test("hasContent skips comments, style, script and template tags in one pass", async () => {
  const { hasContent } = await kit();
  const shadow = (inner) =>
    `<x-a><template shadowroot="open">${inner}</template></x-a>`;
  assert.equal(hasContent(shadow("<!-- <p>x</p> -->"), "x-a"), false);
  assert.equal(hasContent(shadow("<!-- a --!>"), "x-a"), false);
  assert.equal(hasContent(shadow("<STYLE media=x>p{}</STYLE >"), "x-a"), false);
  assert.equal(hasContent(shadow("<script>if(a<b){}</script>"), "x-a"), false);
  assert.equal(hasContent(shadow("<style>p{}</style><p>hi</p>"), "x-a"), true);
  // text next to a stripped span is not spliced into a stripped construct
  assert.equal(hasContent(shadow("<sty<style></style>le>"), "x-a"), true);
  assert.equal(hasContent(shadow("a < b"), "x-a"), true);
  assert.equal(hasContent("", "x-a"), false);
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

test("globalCss puts the primitives first, then the design system's styles", async () => {
  const { globalCss, cssTextOf, SSR_PRIMITIVE_CSS } = await kit();
  // lit CSSResults, strings and nested arrays, the shapes a styles getter returns
  const styles = [
    { cssText: ":root {\n  --x-a: 1px; /* note */\n}\n" },
    [":host { --x-b: 2px }", [{ cssText: "p{margin:0}" }]],
    null,
    42,
  ];
  assert.equal(
    cssTextOf(styles),
    ":root {\n  --x-a: 1px; /* note */\n}\n:host { --x-b: 2px }p{margin:0}",
  );
  const css = globalCss(styles);
  assert.ok(css.startsWith(SSR_PRIMITIVE_CSS));
  assert.equal(
    css.slice(SSR_PRIMITIVE_CSS.length),
    ":root { --x-a: 1px; } :host { --x-b: 2px }p{margin:0}",
  );
  assert.equal(
    globalCss(styles, { primitives: false }).startsWith(":root"),
    true,
  );
  assert.equal(
    globalCss("a { b: c }  /* d */", { primitives: false, compact: false }),
    "a { b: c }  /* d */",
  );
  assert.equal(globalCss(), SSR_PRIMITIVE_CSS);
});

test("compactCss leaves quoted strings alone", async () => {
  const { compactCss } = await kit();
  assert.equal(
    compactCss(
      `a::before { content: "  /* kept */  "; }\n\n/* gone */ b { c: 'd  \\' e' }`,
    ),
    `a::before { content: "  /* kept */  "; } b { c: 'd  \\' e' }`,
  );
  assert.equal(compactCss("a{b:c} /* never closed"), "a{b:c}");
  assert.equal(compactCss('a{b:"never closed'), 'a{b:"never closed');
  assert.equal(compactCss(null), "");
});

test("withGlobalStyles emits one style element that markup cannot close early", async () => {
  const { withGlobalStyles } = await kit();
  assert.equal(
    withGlobalStyles("<x-a></x-a>", ":root{--a:1}"),
    "<style data-ssr-global>:root{--a:1}</style><x-a></x-a>",
  );
  const hostile = withGlobalStyles(
    "",
    'a{content:"</style><script>x</script>"}',
  );
  assert.equal(hostile.match(/<\/style>/g).length, 1);
  assert.ok(hostile.endsWith("</style>"));
  assert.ok(!hostile.includes("</script>"));
});

test("the build ships the kit as plain ESM", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "../..");
  const babel = require(path.join(root, "babel.config.js"));
  // not compiled (babel would turn import() into require()) but still copied
  assert.ok(babel.ignore.includes("./src/lib/ssr/**/*"));
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  assert.match(pkg.scripts.build, /babel src --out-dir dist --copy-files/);
  assert.doesNotMatch(pkg.scripts.build, /--no-copy-ignored/);
  assert.ok(pkg.files.includes("dist"));
  // an exports map would hide dist/lib/ssr/index.mjs from the hax CLI
  assert.equal(pkg.exports, undefined);
});

test("publishUrls maps file: URLs into the build to the published path", async () => {
  const { publishUrls, hasLocalPath } = await kit();
  const fs = require("node:fs");
  const os = require("node:os");
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssr-build-"));
  const inBuild =
    pathToFileURL(buildDir).href +
    "/@haxtheweb/simple-icon/lib/simple-icons.js/../svgs/code.svg";
  const local = publishUrls(
    `<image href="${inBuild}">`,
    buildDir,
    "./build/es6/node_modules/",
  );
  assert.equal(
    local,
    '<image href="./build/es6/node_modules/@haxtheweb/simple-icon/lib/svgs/code.svg">',
  );
  assert.equal(hasLocalPath(local), false);
  const cdn = publishUrls(
    `<img src='${inBuild}'>`,
    buildDir,
    "https://cdn.example/build/es6/node_modules/",
  );
  assert.equal(
    cdn,
    "<img src='https://cdn.example/build/es6/node_modules/@haxtheweb/simple-icon/lib/svgs/code.svg'>",
  );
  const elsewhere = '<img src="file:///etc/hosts">';
  assert.equal(publishUrls(elsewhere, buildDir, "./"), elsewhere);
  assert.equal(hasLocalPath(elsewhere), true);
});
