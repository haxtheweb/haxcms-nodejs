"use strict";

// lib/shared/hax-site-check.js: the site zip import rules as one
// dependency-free file that generators run and the importer uses
// (haxtheweb/issues#3426). Invariant: what checkHaxSite calls an error is
// exactly what readSiteZip refuses, and the file runs unchanged in a browser
// (no require, no Node built-ins).
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = path.join(__dirname, "../../src/lib/shared/hax-site-check.js");
const check = require(SOURCE);
const { isSiteOutline, siteRelativePath } = require("../../src/lib/siteZip.js");

const SITE = {
  title: "My 90s page",
  description: "Under construction",
  metadata: { site: { name: "my-90s-page" } },
  items: [
    {
      id: "item-1",
      title: "Home",
      location: "pages/home/index.html",
      parent: null,
      indent: 0,
      order: 0,
      metadata: { files: [{ url: "files/guestbook.gif" }] },
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codes(result) {
  return result.problems.map((p) => p.severity + ":" + p.code);
}

test("the importer uses the shared rules (same functions)", () => {
  assert.equal(isSiteOutline, check.isSiteOutline);
  assert.equal(siteRelativePath, check.siteRelativePath);
});

test("runs in a browser-like sandbox: no require, sets globalThis.HAXSiteCheck", () => {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox);
  assert.equal(typeof sandbox.HAXSiteCheck.checkHaxSite, "function");
  const result = sandbox.HAXSiteCheck.checkHaxSite({ siteJson: SITE });
  assert.equal(result.ok, true);
  // and loading it in Node adds nothing to the global object
  assert.equal(typeof globalThis.HAXSiteCheck, "undefined");
});

test("source stays dependency free (no require or import of anything)", () => {
  // code only: the usage notes in its comments show require() on purpose
  const text = fs
    .readFileSync(SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(text, /\brequire\(/);
  assert.doesNotMatch(text, /^\s*import\s/m);
});

test("siteRelativePath matches path.posix.normalize based rules", () => {
  const legacy = (value) => {
    if (typeof value !== "string" || value === "" || value.length > 1024) {
      return "";
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.indexOf("\\") !== -1) {
      return "";
    }
    const cleaned = value.split("?")[0].split("#")[0];
    const normalized = path.posix.normalize(cleaned.replace(/^\.\//, ""));
    if (
      normalized === "" ||
      normalized === "." ||
      normalized.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      return "";
    }
    return normalized;
  };
  const fixed = [
    "pages/a/index.html",
    "./pages/a/index.html",
    "pages//a/./index.html",
    "pages/a/../b/index.html",
    "pages/../../etc/passwd",
    "../x",
    "/abs",
    "./",
    "files/",
    "files/a.png?x=1#y",
    "a/b/c/../../..",
    "a/b/c/../../../..",
    "..",
    ".",
    "",
    "http://x/y",
    "files\\a.png",
    "x".repeat(1025),
  ];
  const alphabet = [
    "a",
    "b",
    ".",
    "..",
    "",
    "/",
    "./",
    "../",
    "files",
    "pages",
  ];
  let seed = 3426;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const generated = [];
  for (let i = 0; i < 4000; i++) {
    let s = "";
    const n = 1 + rand(8);
    for (let j = 0; j < n; j++) {
      s += alphabet[rand(alphabet.length)];
      if (rand(2)) {
        s += "/";
      }
    }
    generated.push(s);
  }
  for (const value of fixed.concat(generated)) {
    assert.equal(check.siteRelativePath(value), legacy(value), value);
  }
});

test("a good site has no problems", () => {
  const result = check.checkHaxSite({
    siteJson: JSON.stringify(SITE),
    files: ["site.json", "pages/home/index.html", "files/guestbook.gif"],
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.version, check.VERSION);
});

test("every outline problem is listed, not just the first", () => {
  const site = clone(SITE);
  site.title = 5;
  site.metadata = [];
  site.items.push({ id: "item-1", location: "../x.html", metadata: [] });
  site.items.push({ id: "bad id!", location: "pages/b.html", indent: "1" });
  const result = check.checkHaxSite({ siteJson: site });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [
    "error:SITE_TITLE",
    "error:SITE_METADATA",
    "error:ITEM_ID_DUPLICATE",
    "error:ITEM_LOCATION",
    "error:ITEM_METADATA",
    "error:ITEM_ID",
    "error:ITEM_INDENT",
  ]);
  assert.equal(result.problems[2].path, "items[1].id");
  assert.equal(check.isSiteOutline(site), false);
});

test("the 255 character id limit and the 5000 page limit", () => {
  const site = clone(SITE);
  site.items[0].id = "a".repeat(256);
  assert.deepEqual(codes(check.checkHaxSite({ siteJson: site })), [
    "error:ITEM_ID",
  ]);
  site.items[0].id = "a".repeat(255);
  assert.equal(check.checkHaxSite({ siteJson: site }).ok, true);
  const many = clone(SITE);
  many.items = [];
  for (let i = 0; i < check.LIMITS.maxItems + 1; i++) {
    many.items.push({ id: "i" + i, location: "pages/p" + i + ".html" });
  }
  assert.deepEqual(codes(check.checkHaxSite({ siteJson: many })), [
    "error:ITEMS_TOO_MANY",
  ]);
});

test("site.json is found at the top or one folder down, never deeper", () => {
  const ok = check.checkHaxSite({
    siteJson: SITE,
    files: [
      "mysite/",
      "mysite/site.json",
      "mysite/pages/home/index.html",
      "mysite/files/guestbook.gif",
    ],
  });
  assert.deepEqual(ok.problems, []);
  const deep = check.checkHaxSite({
    siteJson: SITE,
    files: ["a/b/site.json"],
  });
  assert.deepEqual(codes(deep), ["error:SITE_JSON_MISSING"]);
});

test("missing pages and files are warnings: the importer still takes the site", () => {
  const result = check.checkHaxSite({ siteJson: SITE, files: ["site.json"] });
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), [
    "warning:PAGE_MISSING",
    "warning:FILE_MISSING",
  ]);
});

test("a site's own JavaScript is flagged", () => {
  const result = check.checkHaxSite({
    siteJson: SITE,
    files: [
      "site.json",
      "pages/home/index.html",
      "files/guestbook.gif",
      check.CUSTOM_BUILD,
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), ["warning:CUSTOM_CODE"]);
});

test("empty files count as ordinary files (haxtheweb/issues#3426)", () => {
  const result = check.checkHaxSite({
    siteJson: SITE,
    files: {
      "site.json": 200,
      "pages/home/index.html": 0,
      "files/guestbook.gif": 10,
      ".nojekyll": 0,
    },
  });
  assert.deepEqual(result.problems, []);
});

test("zip size limits: upload cap, inflated total and entry count", () => {
  const big = check.checkHaxSite({
    siteJson: SITE,
    zipBytes: check.LIMITS.defaultMaxUploadBytes + 1,
  });
  assert.deepEqual(codes(big), ["error:ZIP_UPLOAD_TOO_LARGE"]);
  const raised = check.checkHaxSite({
    siteJson: SITE,
    zipBytes: check.LIMITS.defaultMaxUploadBytes + 1,
    maxUploadBytes: 200 * 1024 * 1024,
  });
  assert.equal(raised.ok, true);
  const files = {
    "site.json": 10,
    "pages/home/index.html": check.LIMITS.maxInflatedBytes,
    "files/guestbook.gif": 1,
  };
  assert.deepEqual(codes(check.checkHaxSite({ siteJson: SITE, files })), [
    "error:ZIP_TOO_LARGE",
  ]);
  const entries = ["site.json"];
  for (let i = 0; i < check.LIMITS.maxZipEntries; i++) {
    entries.push("files/f" + i);
  }
  assert.ok(
    codes(check.checkHaxSite({ siteJson: SITE, files: entries })).indexOf(
      "error:ZIP_TOO_MANY_ENTRIES",
    ) !== -1,
  );
});

test("site.json that is not JSON, or not an object", () => {
  assert.deepEqual(codes(check.checkHaxSite({ siteJson: "{nope" })), [
    "error:SITE_JSON_PARSE",
  ]);
  assert.deepEqual(codes(check.checkHaxSite({ siteJson: [] })), [
    "error:SITE_NOT_OBJECT",
  ]);
  assert.deepEqual(codes(check.checkHaxSite({ siteJson: { items: [] } })), [
    "error:ITEMS_EMPTY",
  ]);
});
