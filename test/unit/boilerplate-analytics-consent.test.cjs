"use strict";

// Google Analytics consent gate in the site shells (haxtheweb/issues#2955):
// whenever a gaID is set, nothing is fetched from Google until the HaxConsent
// store (localStorage "hax-consent") says "allow" for "google-analytics".
// Allowing loads it without a reload; withdrawing turns measurement off.
// The loader is run here as written in each shell, in a sandbox.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BOILERPLATE = path.join(__dirname, "..", "..", "src", "boilerplate");
const SHELLS = ["site/index.html", "site/ghpages.html"];
const START = "      // Google Analytics waits for the visitor";
const END = "        document.body.appendChild(script);\n      }\n";

function loaderSource(file) {
  const html = fs.readFileSync(path.join(BOILERPLATE, file), "utf8");
  const start = html.indexOf(START);
  const end = html.indexOf(END, start);
  assert.ok(start !== -1 && end !== -1, file + " has the consent-gated loader");
  return html.slice(start, end + END.length);
}

// a page with a manifest, a consent store and a body that records scripts
function page(gaID, stored) {
  const scripts = [];
  const listeners = {};
  const config = [];
  const storage = { "hax-consent": stored ? JSON.stringify(stored) : null };
  const sandbox = {
    analyticsLoaded: false,
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
    },
    document: {
      createElement: () => ({}),
      body: { appendChild: (el) => scripts.push(el) },
    },
    gtag: (...args) => config.push(args),
    HAXCMS: {
      requestAvailability: () => ({
        store: {
          getManifest: () => ({
            metadata: { site: { settings: { gaID: gaID } } },
          }),
        },
      }),
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (name, fn) => {
    listeners[name] = listeners[name] || [];
    listeners[name].push(fn);
  };
  return {
    sandbox,
    scripts,
    config,
    storage,
    fire: (service, value) => {
      storage["hax-consent"] = JSON.stringify(
        value ? { [service]: value } : {},
      );
      (listeners["hax-consent-changed"] || []).forEach((fn) =>
        fn({ detail: { service: service, value: value } }),
      );
    },
  };
}

function run(file, p) {
  vm.runInNewContext(
    loaderSource(file) + "\nloadAnalyticsFromManifest();",
    p.sandbox,
  );
}

describe("site shell Google Analytics consent gate", () => {
  for (const file of SHELLS) {
    test(file + " fetches nothing from Google before consent", () => {
      const p = page("G-ABC123", null);
      run(file, p);
      assert.equal(p.scripts.length, 0);
      assert.equal(p.config.length, 0);
    });

    test(file + " fetches nothing after Don't allow", () => {
      const p = page("G-ABC123", { "google-analytics": "deny" });
      run(file, p);
      assert.equal(p.scripts.length, 0);
    });

    test(file + " loads once allowed, without a reload", () => {
      const p = page("G-ABC123", null);
      run(file, p);
      p.fire("google-analytics", "allow");
      assert.equal(p.scripts.length, 1);
      assert.equal(
        p.scripts[0].src,
        "https://www.googletagmanager.com/gtag/js?id=G-ABC123",
      );
      assert.deepEqual(p.config[0], ["config", "G-ABC123"]);
      assert.equal(p.sandbox["ga-disable-G-ABC123"], false);
      // a second allow never loads it twice
      p.fire("google-analytics", "allow");
      assert.equal(p.scripts.length, 1);
    });

    test(file + " loads at once when already allowed", () => {
      const p = page("G-ABC123", { "google-analytics": "allow" });
      run(file, p);
      assert.equal(p.scripts.length, 1);
    });

    test(file + " turns measurement off when consent is withdrawn", () => {
      const p = page("G-ABC123", { "google-analytics": "allow" });
      run(file, p);
      p.fire("google-analytics", null);
      assert.equal(p.sandbox["ga-disable-G-ABC123"], true);
    });

    test(file + " ignores other services' choices", () => {
      const p = page("G-ABC123", null);
      run(file, p);
      p.fire("youtube", "allow");
      assert.equal(p.scripts.length, 0);
    });

    test(file + " never prints a malformed ID into a script URL", () => {
      const p = page("G-1');alert(1);//", { "google-analytics": "allow" });
      run(file, p);
      assert.equal(p.scripts.length, 0);
    });

    test(file + " does nothing without a gaID", () => {
      const p = page("", { "google-analytics": "allow" });
      run(file, p);
      assert.equal(p.scripts.length, 0);
    });
  }

  test("site/config.php prints the same consent-gated loader", () => {
    const php = fs.readFileSync(
      path.join(BOILERPLATE, "site", "config.php"),
      "utf8",
    );
    assert.ok(php.indexOf("localStorage.getItem('hax-consent')") !== -1);
    assert.ok(php.indexOf("choices['google-analytics']") !== -1);
    assert.ok(php.indexOf("consent() !== 'allow'") !== -1);
    assert.equal(php.indexOf("<script async src="), -1);
  });
});
