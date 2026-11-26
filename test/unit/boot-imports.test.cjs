"use strict";

// haxtheweb/issues#3431: the page starts the site builder and the active
// theme loading while it is still being parsed (src/lib/bootImports.js, put
// in the managed head by getSiteMetadata), and the shells' safety net only
// lifts the loading screen once the theme holds something. haxcms-php emits
// the same markup; its tests use the same expected strings.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {
  bootImportPaths,
  bootImportsMarkup,
} = require("../../src/lib/bootImports.js");

const BUILDER = "@haxtheweb/haxcms-elements/lib/core/haxcms-site-builder.js";

// run the emitted script with import() swapped for a recorder
function imports(markup, globals) {
  const js = markup
    .replace("<script data-haxcms-boot>", "")
    .replace("</script>", "")
    .trim()
    .split("import(")
    .join("__imp(");
  const seen = [];
  const sandbox = Object.assign({}, globals || {});
  sandbox.globalThis = sandbox;
  sandbox.__imp = (url) => {
    seen.push(url);
    return { catch: () => {} };
  };
  vm.runInNewContext(js, sandbox);
  return seen;
}

describe("boot imports markup", () => {
  test("a registry theme: the builder and the theme", () => {
    assert.equal(
      bootImportsMarkup("./", "@haxtheweb/clean-two/clean-two.js"),
      '  <script data-haxcms-boot>(function(){var c=(globalThis.__appCDN||"./")+"build/es6/node_modules/";["@haxtheweb/haxcms-elements/lib/core/haxcms-site-builder.js","@haxtheweb/clean-two/clean-two.js"].forEach(function(p){import(c+p).catch(function(){});});})();</script>',
    );
  });

  test("a custom theme: the builder, then the site's own build", () => {
    assert.equal(
      bootImportsMarkup("./", "./custom/build/custom.es6.js"),
      '  <script data-haxcms-boot>(function(){var c=(globalThis.__appCDN||"./")+"build/es6/node_modules/";["@haxtheweb/haxcms-elements/lib/core/haxcms-site-builder.js"].forEach(function(p){import(c+p).catch(function(){});});if(!globalThis.__appCustomEnv){import("./custom/build/custom.es6.js").catch(function(){});}})();</script>',
    );
  });

  test("old @lrnwebcomponents theme paths load from @haxtheweb", () => {
    assert.deepEqual(
      bootImportPaths("@lrnwebcomponents/clean-one/clean-one.js").registry,
      [BUILDER, "@haxtheweb/clean-one/clean-one.js"],
    );
  });

  test("anything but a registry or custom/build path is dropped", () => {
    for (const bad of [
      "../x.js",
      "@x/../y.js",
      "./custom/build/../../x.js",
      "https://evil.example/x.js",
      "javascript:alert(1)",
      '@a/b".js',
      "@a/b<script>.js",
      "@a/b\\c.js",
      "./custom/other.js",
      "",
    ]) {
      const paths = bootImportPaths(bad);
      assert.deepEqual(paths.registry, [BUILDER], bad);
      assert.equal(paths.custom, "", bad);
      assert.ok(bootImportsMarkup("./", bad).indexOf(bad || "\u0000") === -1);
    }
  });

  test("an unrecognized base means no script, not a guess", () => {
    for (const bad of [
      '"><script>',
      "javascript:x/",
      "//cdn.example/",
      "https://cdn.example",
      "",
    ]) {
      assert.equal(bootImportsMarkup(bad, ""), "", bad);
    }
    assert.ok(
      bootImportsMarkup("https://cdn.hax.cloud/cdn/", "").indexOf(
        '(globalThis.__appCDN||"https://cdn.hax.cloud/cdn/")',
      ) !== -1,
    );
  });

  test("no escaped quotes for the managed head pass to rewrite", () => {
    assert.equal(
      bootImportsMarkup("./", "./custom/build/custom.es6.js").indexOf('\\"'),
      -1,
    );
  });

  test("imports from the place the CDN check chose", () => {
    const markup = bootImportsMarkup("./", "@haxtheweb/clean-two/clean-two.js");
    assert.deepEqual(
      imports(markup, { __appCDN: "https://cdn.hax.cloud/cdn/" }),
      [
        "https://cdn.hax.cloud/cdn/build/es6/node_modules/" + BUILDER,
        "https://cdn.hax.cloud/cdn/build/es6/node_modules/@haxtheweb/clean-two/clean-two.js",
      ],
    );
    // a live page sets __appCDN at the end of the body: the base is used
    assert.deepEqual(imports(markup, {}), [
      "./build/es6/node_modules/" + BUILDER,
      "./build/es6/node_modules/@haxtheweb/clean-two/clean-two.js",
    ]);
  });

  test("the custom build is skipped like build-haxcms.js skips it", () => {
    const markup = bootImportsMarkup("./", "./custom/build/custom.es6.js");
    assert.deepEqual(imports(markup, {}).slice(1), [
      "./custom/build/custom.es6.js",
    ]);
    assert.deepEqual(imports(markup, { __appCustomEnv: true }).slice(1), []);
  });
});

// The shells' safety net: haxcms-ready + 2.5 s used to lift the loading
// screen whatever the theme held, showing an empty theme on a slow load.
const BOILERPLATE = path.join(__dirname, "..", "..", "src", "boilerplate");
const SHELLS = ["site/index.html", "site/ghpages.html", "site/index.php"];

function settledSource(file) {
  const html = fs.readFileSync(path.join(BOILERPLATE, file), "utf8");
  const start = html.indexOf("      function hideWhenSettled(delay) {");
  const end = html.indexOf("      function hideLoading() {", start);
  assert.ok(start !== -1 && end !== -1, file + " has hideWhenSettled");
  assert.ok(html.indexOf("hideWhenSettled(2500);") !== -1, file);
  return html.slice(start, end);
}

// a fake clock and a builder whose theme can be changed between ticks
function shell(file) {
  const timers = [];
  const state = { theme: null, hidden: 0, now: 0 };
  const sandbox = {
    setTimeout: (fn, ms) => timers.push({ at: state.now + ms, fn }),
    hideLoading: () => {
      state.hidden++;
    },
    document: {
      querySelector: (sel) => {
        assert.equal(sel, "haxcms-site-builder > .haxcms-theme-element");
        return state.theme;
      },
    },
  };
  vm.runInNewContext(settledSource(file) + "\nhideWhenSettled(2500);", sandbox);
  state.until = (ms) => {
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at);
      if (timers[0].at > ms) {
        break;
      }
      const next = timers.shift();
      state.now = next.at;
      next.fn();
    }
    state.now = ms;
  };
  return state;
}

function theme(children, busy) {
  return {
    childNodes: { length: children },
    hasAttribute: (name) => name === "aria-busy" && busy,
  };
}

describe("loading screen safety net", () => {
  for (const file of SHELLS) {
    test(file + " waits while the theme has no content", () => {
      const s = shell(file);
      s.theme = theme(0, true);
      s.until(5000);
      assert.equal(s.hidden, 0);
      s.theme = theme(3, false);
      s.until(5300);
      assert.equal(s.hidden, 1);
    });

    test(file + " lifts at 2.5 s once a 404 or route is in", () => {
      const s = shell(file);
      s.theme = theme(1, false);
      s.until(2499);
      assert.equal(s.hidden, 0);
      s.until(2500);
      assert.equal(s.hidden, 1);
    });

    test(file + " gives up 10 s after haxcms-ready", () => {
      const s = shell(file);
      s.until(9999);
      assert.equal(s.hidden, 0);
      s.until(10000);
      assert.equal(s.hidden, 1);
      s.until(20000);
      assert.equal(s.hidden, 1);
    });
  }
});

// haxtheweb/issues#3431: the live shells (index.html, index.php) render the
// page into the builder too, so they hide it and the theme under the loading
// screen and show it without JavaScript, like the static shell
describe("every shell hides the theme under the loading screen", () => {
  for (const file of SHELLS) {
    test(file, () => {
      const html = fs.readFileSync(path.join(BOILERPLATE, file), "utf8");
      const styles = /<style id="loadingstyles">([\s\S]*?)<\/style>/.exec(html);
      assert.ok(styles, file);
      assert.ok(
        styles[1].indexOf(
          'body:has(> #loading[aria-busy="true"]) haxcms-site-builder > .haxcms-theme-element {',
        ) !== -1,
        file,
      );
      const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
      assert.ok(noscript, file);
      assert.ok(noscript[1].indexOf("display: none !important") !== -1);
      assert.ok(noscript[1].indexOf("visibility: visible !important") !== -1);
      // no theme element exists without JavaScript, so the theme rule never
      // hides what the noscript style shows
      assert.ok(
        html.indexOf("<noscript>") < html.indexOf('id="loadingscript"'),
      );
    });
  }
});
