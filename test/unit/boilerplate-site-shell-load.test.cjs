"use strict";

// First-paint behavior of the site shells (index.html, ghpages.html,
// index.php and the CDN shells):
// - an inline script right after <haxcms-site-builder> preloads the exact
//   URL in the builder's `file` attribute, so the site.json download is not
//   queued behind the boot JavaScript
// - the loading screen dissolves as soon as content is ready instead of
//   first playing out its build animation
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BOILERPLATE = path.join(__dirname, "..", "..", "src", "boilerplate");
const SHELLS = [
  "site/index.html",
  "site/ghpages.html",
  "site/index.php",
  "cdns/cdn.hax.cloud.html",
  "cdns/cdn.webcomponents.psu.edu.html",
  "cdns/custom.html",
];

function read(file) {
  return fs.readFileSync(path.join(BOILERPLATE, file), "utf8");
}

function preloadScript(html) {
  const match = html.match(
    /<script data-haxcms-site-json-preload>([\s\S]*?)<\/script>/,
  );
  return match ? match[1] : null;
}

function runPreload(html, fileAttr) {
  const appended = [];
  const document = {
    head: {
      appendChild: function (el) {
        appended.push(el);
      },
    },
    getElementById: function (id) {
      if (id !== "site") {
        return null;
      }
      return {
        getAttribute: function () {
          return fileAttr;
        },
      };
    },
    createElement: function () {
      const attrs = {};
      return {
        attrs: attrs,
        setAttribute: function (k, v) {
          attrs[k] = v;
        },
      };
    },
  };
  vm.runInNewContext(preloadScript(html), { document: document });
  return appended;
}

describe("site shell first-paint loading", () => {
  for (const file of SHELLS) {
    test(file + " preloads the builder's own site.json URL", () => {
      const html = read(file);
      const script = preloadScript(html);
      assert.ok(script, file + " has the site.json preload script");
      // it must run after the builder element exists in the DOM
      assert.ok(
        html.indexOf("data-haxcms-site-json-preload") >
          html.indexOf("</haxcms-site-builder>"),
      );
      const links = runPreload(html, "site.json?abc123");
      assert.equal(links.length, 1);
      assert.equal(links[0].rel, "preload");
      assert.equal(links[0].as, "fetch");
      assert.equal(links[0].href, "site.json?abc123");
      assert.equal(links[0].crossOrigin, "anonymous");
      assert.equal(links[0].attrs.fetchpriority, "high");
      // an inline JSON blob is not a URL
      assert.equal(runPreload(html, '{"items":[]}').length, 0);
      assert.equal(runPreload(html, "").length, 0);
    });
  }

  for (const file of SHELLS) {
    const html = read(file);
    if (html.indexOf("function revealSite") === -1) {
      continue;
    }
    test(file + " dissolves the loading screen as soon as it is ready", () => {
      assert.equal(html.indexOf("finishFigure"), -1);
      const reveal = html.match(
        /function revealSite\(loadingEl\) \{([\s\S]*?)\n {6}\}/,
      );
      assert.ok(reveal, "revealSite found");
      assert.ok(reveal[1].indexOf("dissolveLoading(loadingEl, true)") !== -1);
    });
  }
});
