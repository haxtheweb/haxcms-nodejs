"use strict";

// The site service-worker.js managed template: Twig render plus behavior.
//
// Render (haxtheweb/issues#3064 follow-on / SW twig leak): the template uses
//   {{ swhash|json_encode(constant('JSON_PRETTY_PRINT'))|raw }}
// Twig.js has no built-in `constant` function (PHP Twig does), so without the
// extendFunction registration in HAXCMS.js, rebuildManagedFiles() throws while
// rendering service-worker.js and the catch swallows the error, leaving the
// raw boilerplate on disk. These tests require HAXCMS.js (which registers
// `constant` at module load) and render the boilerplate through Twig.
//
// Behavior: the rendered worker runs in a vm sandbox with fake fetch/caches,
// and the tests pin what it does: install fetches only the shell list,
// navigations go to the network first, uploads under files/ and API calls
// are never answered from or written to a cache, build modules are
// stale-while-revalidate, and caches left by older workers are deleted.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const path = require("path");
const vm = require("vm");

require("../../src/lib/HAXCMS.js");
const Twig = require("twig");

const BOILERPLATE_SW = path.resolve(
  __dirname,
  "..",
  "..",
  "src",
  "boilerplate",
  "site",
  "service-worker.js",
);
const SCOPE = "https://example.org/sites/demo/";

function renderSw(templateVars) {
  const fileData = fs.readFileSync(BOILERPLATE_SW, "utf8");
  const template = Twig.twig({ data: fileData, async: false });
  return template.render(templateVars);
}

function hasTwigSyntax(str) {
  return (
    String(str).indexOf("{{") !== -1 ||
    String(str).indexOf("{%") !== -1 ||
    String(str).indexOf("{#") !== -1
  );
}

// Minimal Cache Storage: Map of cache name -> Map of url -> response
function fakeCaches(initial) {
  const store = new Map();
  (initial || []).forEach(function (name) {
    store.set(name, new Map());
  });
  function keyOf(request) {
    return typeof request === "string" ? request : request.url;
  }
  function openSync(name) {
    if (!store.has(name)) {
      store.set(name, new Map());
    }
    const entries = store.get(name);
    return {
      put: function (request, response) {
        entries.set(keyOf(request), response);
        return Promise.resolve();
      },
      match: function (request) {
        return Promise.resolve(entries.get(keyOf(request)));
      },
      keys: function () {
        return Promise.resolve(
          Array.from(entries.keys()).map(function (url) {
            return { url: url };
          }),
        );
      },
      delete: function (request) {
        return Promise.resolve(entries.delete(keyOf(request)));
      },
    };
  }
  return {
    store: store,
    open: function (name) {
      return Promise.resolve(openSync(name));
    },
    keys: function () {
      return Promise.resolve(Array.from(store.keys()));
    },
    delete: function (name) {
      return Promise.resolve(store.delete(name));
    },
    match: function (request) {
      const key = keyOf(request).split("?")[0];
      for (const entries of store.values()) {
        for (const entry of entries.entries()) {
          if (entry[0].split("?")[0] === key) {
            return Promise.resolve(entry[1]);
          }
        }
      }
      return Promise.resolve(undefined);
    },
  };
}

function fakeResponse(url, body) {
  return {
    ok: true,
    status: 200,
    type: "basic",
    url: url,
    body: body || "network:" + url,
    clone: function () {
      return fakeResponse(url, body);
    },
  };
}

function loadWorker(templateVars, opts) {
  const options = opts || {};
  const listeners = {};
  const fetched = [];
  const caches = fakeCaches(options.existingCaches);
  const sandbox = {
    self: {
      registration: { scope: SCOPE },
      location: { href: SCOPE + "service-worker.js" },
      addEventListener: function (type, fn) {
        listeners[type] = fn;
      },
      skipWaiting: function () {
        return Promise.resolve();
      },
      clients: {
        claim: function () {
          return Promise.resolve();
        },
      },
    },
    caches: caches,
    fetch: function (request) {
      const url = typeof request === "string" ? request : request.url;
      fetched.push(url);
      if (options.offline) {
        return Promise.reject(new Error("offline"));
      }
      return Promise.resolve(fakeResponse(url));
    },
    Request: function (url, init) {
      this.url = url;
      this.init = init;
    },
    Response: {
      error: function () {
        return { ok: false, type: "error" };
      },
    },
    URL: URL,
    Promise: Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(renderSw(templateVars), sandbox);
  return { listeners: listeners, fetched: fetched, caches: caches };
}

// dispatch a fetch event; resolves with { handled, response }
function dispatchFetch(worker, url, mode) {
  let handled = null;
  const waits = [];
  worker.listeners.fetch({
    request: { url: url, method: "GET", mode: mode || "cors" },
    respondWith: function (promise) {
      handled = promise;
    },
    waitUntil: function (promise) {
      waits.push(promise);
    },
  });
  if (!handled) {
    return Promise.resolve({ handled: false });
  }
  return handled.then(function (response) {
    return Promise.all(waits).then(function () {
      return { handled: true, response: response };
    });
  });
}

function dispatchLifecycle(worker, type) {
  let promise = Promise.resolve();
  worker.listeners[type]({
    waitUntil: function (p) {
      promise = p;
    },
  });
  return promise;
}

const SHELL = [
  ["index.html", "abc"],
  ["site.json", "def"],
  ["offline.html", "ghi"],
];

describe("service-worker.js Twig render", () => {
  test("renders the shell list as valid JS (no {{ swhash... }} leak)", () => {
    const out = renderSw({ swhash: SHELL, cdnRegex: undefined });
    assert.equal(
      hasTwigSyntax(out),
      false,
      "no Twig syntax remains anywhere in the rendered SW",
    );
    const match = out.match(/var shellFiles = ([\s\S]*?);\n/);
    assert.ok(match, "shellFiles line is present");
    assert.deepEqual(JSON.parse(match[1]), SHELL);
  });

  test("cdnRegex is optional and becomes a RegExp when set", () => {
    const without = renderSw({ swhash: [], cdnRegex: undefined });
    assert.equal(hasTwigSyntax(without), false);
    assert.notEqual(without.indexOf("var cdnPattern = null;"), -1);
    const withCdn = renderSw({ swhash: [], cdnRegex: "cdn\\.hax\\.cloud" });
    assert.equal(hasTwigSyntax(withCdn), false);
    assert.notEqual(
      withCdn.indexOf('var cdnPattern = new RegExp("cdn\\\\.hax\\\\.cloud");'),
      -1,
    );
  });

  test("no sw-precache / sw-toolbox code is left in the template", () => {
    const out = renderSw({ swhash: SHELL });
    assert.equal(out.indexOf("toolbox."), -1);
    assert.equal(out.indexOf("precacheConfig"), -1);
  });

  test("constant() Twig function is registered and returns the PHP JSON_* bitmask values", () => {
    const t = Twig.twig({
      data: "{{ constant('JSON_PRETTY_PRINT') }}|{{ constant('JSON_UNESCAPED_SLASHES') }}",
      async: false,
    });
    assert.equal(t.render({}), "128|64");
    const t2 = Twig.twig({
      data: "{{ constant('NOT_A_REAL_CONSTANT') }}",
      async: false,
    });
    assert.equal(t2.render({}), "");
  });
});

describe("service-worker.js behavior", () => {
  test("install fetches only the shell list, never the whole site", async () => {
    const worker = loadWorker({ swhash: SHELL });
    await dispatchLifecycle(worker, "install");
    assert.deepEqual(worker.fetched.sort(), [
      SCOPE + "index.html",
      SCOPE + "offline.html",
      SCOPE + "site.json",
    ]);
  });

  test("activate deletes caches left by older workers (sw-precache / toolbox)", async () => {
    const worker = loadWorker(
      { swhash: SHELL },
      {
        existingCaches: [
          "sw-precache-v3--" + SCOPE,
          "$$$toolbox-cache$$$" + SCOPE + "$$$",
          "haxcms-assets",
        ],
      },
    );
    await dispatchLifecycle(worker, "activate");
    const names = Array.from(worker.caches.store.keys());
    assert.deepEqual(names, ["haxcms-assets"]);
  });

  test("a different shell version gets a different shell cache", async () => {
    const a = loadWorker({ swhash: SHELL });
    const b = loadWorker({ swhash: [["index.html", "changed"]] });
    await dispatchLifecycle(a, "install");
    await dispatchLifecycle(b, "install");
    const nameA = Array.from(a.caches.store.keys()).filter(
      (n) => n.indexOf("haxcms-shell-") === 0,
    )[0];
    const nameB = Array.from(b.caches.store.keys()).filter(
      (n) => n.indexOf("haxcms-shell-") === 0,
    )[0];
    assert.ok(nameA && nameB);
    assert.notEqual(nameA, nameB);
  });

  test("navigations go to the network first and the page is kept for offline", async () => {
    const worker = loadWorker({ swhash: SHELL });
    const result = await dispatchFetch(worker, SCOPE + "lesson-1", "navigate");
    assert.equal(result.handled, true);
    assert.equal(result.response.body, "network:" + SCOPE + "lesson-1");
    await new Promise((r) => setTimeout(r, 0));
    const pages = worker.caches.store.get("haxcms-pages");
    assert.ok(pages && pages.has(SCOPE + "lesson-1"));
  });

  test("offline navigation to an unseen page falls back to the cached shell", async () => {
    const worker = loadWorker({ swhash: SHELL }, { offline: true });
    const shell = await worker.caches.open("haxcms-shell-x");
    await shell.put(
      SCOPE + "index.html",
      fakeResponse(SCOPE + "index.html", "shell"),
    );
    const result = await dispatchFetch(
      worker,
      SCOPE + "never-seen",
      "navigate",
    );
    assert.equal(result.response.body, "shell");
  });

  test("uploads, API calls and system paths are left to the network", async () => {
    const worker = loadWorker({ swhash: SHELL });
    for (const url of [
      SCOPE + "files/lecture.pdf",
      SCOPE + "x/api/v1/site",
      SCOPE + "system/api/v1/login",
    ]) {
      const result = await dispatchFetch(worker, url);
      assert.equal(result.handled, false, url);
    }
  });

  test("requests outside the site scope are not handled", async () => {
    const worker = loadWorker({ swhash: SHELL });
    const result = await dispatchFetch(
      worker,
      "https://example.org/other-site/page",
    );
    assert.equal(result.handled, false);
  });

  test("build modules are stale-while-revalidate, local or from a CDN", async () => {
    const worker = loadWorker({ swhash: SHELL });
    const local = SCOPE + "build/es6/node_modules/@haxtheweb/utils/utils.js";
    const first = await dispatchFetch(worker, local);
    assert.equal(first.response.body, "network:" + local);
    const assets = worker.caches.store.get("haxcms-assets");
    assert.ok(assets && assets.has(local), "stored after the first fetch");
    // second request answers from the cache and refreshes in the background
    await assets.set(local, fakeResponse(local, "cached"));
    const second = await dispatchFetch(worker, local);
    assert.equal(second.response.body, "cached");
    const cdn =
      "https://cdn.hax.cloud/cdn/build/es6/node_modules/@haxtheweb/utils/utils.js";
    const fromCdn = await dispatchFetch(worker, cdn);
    assert.equal(fromCdn.handled, true);
  });

  test("other cross-origin requests (fonts, embeds) are not handled", async () => {
    const worker = loadWorker({ swhash: SHELL });
    const result = await dispatchFetch(
      worker,
      "https://fonts.gstatic.com/s/roboto.woff2",
    );
    assert.equal(result.handled, false);
  });
});
