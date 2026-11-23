"use strict";

// JSONOutlineSchemaItem.readLocation: the page read behind every page load.
// The rule (Security SEC-PATH): a page is read only from inside the base
// folder it is given. An empty location, a NUL byte, a ".." segment or a
// symlink whose real target lies outside the base reads nothing (false).
//
// Parity: haxcms-php carries the same scenarios, under the same names, in
// JSONOutlineSchemaItemReadLocationTest.php. Twin of
// json-outline-schema-item-write-location.test.cjs. CommonJS, NO optional
// chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const JSONOutlineSchemaItem = require("../../src/lib/JSONOutlineSchemaItem.js");

// a site directory holding pages/a/index.html, plus a secret outside it
function makeSite(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jos-item-read-"));
  t.after(() => {
    fs.removeSync(root);
  });
  const site = path.join(root, "site");
  fs.mkdirpSync(path.join(site, "pages", "a"));
  fs.writeFileSync(
    path.join(site, "pages", "a", "index.html"),
    "<p>page a</p>",
  );
  fs.mkdirpSync(path.join(root, "outside"));
  fs.writeFileSync(path.join(root, "outside", "secret.html"), "<p>secret</p>");
  return { root: root, site: site };
}

function read(site, location) {
  const item = new JSONOutlineSchemaItem();
  item.location = location;
  return item.readLocation(site + "/");
}

test("reads a page inside the base", async (t) => {
  const { site } = makeSite(t);
  assert.equal(await read(site, "pages/a/index.html"), "<p>page a</p>");
});

test("an empty location reads nothing", async (t) => {
  const { site } = makeSite(t);
  assert.equal(await read(site, ""), false);
});

test("a location that is not a string reads nothing", async (t) => {
  const { site } = makeSite(t);
  assert.equal(await read(site, null), false);
});

test("a NUL byte reads nothing", async (t) => {
  const { site } = makeSite(t);
  assert.equal(await read(site, "pages/a/index.html\0.txt"), false);
});

test("a .. segment reads nothing, even one that ends inside the base", async (t) => {
  const { site } = makeSite(t);
  assert.equal(await read(site, "../outside/secret.html"), false);
  assert.equal(await read(site, "pages/../../outside/secret.html"), false);
  assert.equal(await read(site, "pages/a/../a/index.html"), false);
});

test("a symlink to a file outside the base reads nothing", async (t) => {
  const { root, site } = makeSite(t);
  fs.symlinkSync(
    path.join(root, "outside", "secret.html"),
    path.join(site, "pages", "a", "link.html"),
  );
  assert.equal(await read(site, "pages/a/link.html"), false);
});

test("a symlink to a file inside the base is read", async (t) => {
  const { site } = makeSite(t);
  fs.symlinkSync(
    path.join(site, "pages", "a", "index.html"),
    path.join(site, "pages", "a", "alias.html"),
  );
  assert.equal(await read(site, "pages/a/alias.html"), "<p>page a</p>");
});

test("a page that does not exist reads nothing", async (t) => {
  const { site } = makeSite(t);
  assert.equal(await read(site, "pages/b/index.html"), false);
});
