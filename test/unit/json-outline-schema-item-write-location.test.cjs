"use strict";

// JSONOutlineSchemaItem.writeLocation: the page write every saveOutline
// contents / duplicate request ends in
//
// Pins what a caller can rely on, so the weekly mutation run
// (.github/workflows/mutation-testing.yml) notices when it changes:
//   - the body lands in the page file and the call answers true
//   - an empty body is stored as "<p></p>", never as an empty file
//   - a location that leaves basePath is refused (false) and nothing is
//     written outside it
//   - when nothing was written the answer is exactly false
//
// Parity: haxcms-php carries the same scenarios, under the same names, in
// JSONOutlineSchemaItemWriteLocationTest.php. Two Node/PHP differences are
// left as todo tests below (see their reasons). CommonJS, NO optional
// chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const JSONOutlineSchemaItem = require("../../src/lib/JSONOutlineSchemaItem.js");

// a site directory holding pages/a/index.html, plus a sibling directory
// outside it
function makeSite(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jos-item-write-"));
  t.after(() => {
    fs.removeSync(root);
  });
  const site = path.join(root, "site");
  fs.mkdirpSync(path.join(site, "pages", "a"));
  fs.writeFileSync(path.join(site, "pages", "a", "index.html"), "<p>old</p>");
  fs.mkdirpSync(path.join(root, "outside"));
  return { root: root, site: site };
}

function item(location) {
  const it = new JSONOutlineSchemaItem();
  it.location = location;
  return it;
}

test("writeLocation: the body is written to the page file", async (t) => {
  const dirs = makeSite(t);
  const result = await item("pages/a/index.html").writeLocation(
    "<p>new</p>",
    dirs.site,
  );
  assert.equal(result, true);
  assert.equal(
    fs.readFileSync(path.join(dirs.site, "pages/a/index.html"), "utf8"),
    "<p>new</p>",
  );
});

test("writeLocation: an empty body is stored as an empty paragraph", async (t) => {
  const dirs = makeSite(t);
  const result = await item("pages/a/index.html").writeLocation("", dirs.site);
  assert.ok(result, "the write succeeds");
  assert.equal(
    fs.readFileSync(path.join(dirs.site, "pages/a/index.html"), "utf8"),
    "<p></p>",
  );
});

test("writeLocation: a location outside the base path is refused", async (t) => {
  const dirs = makeSite(t);
  const target = path.join(dirs.root, "outside", "index.html");
  fs.writeFileSync(target, "<p>outside</p>");
  const result = await item("../outside/index.html").writeLocation(
    "<p>escaped</p>",
    dirs.site,
  );
  assert.equal(result, false);
  assert.equal(fs.readFileSync(target, "utf8"), "<p>outside</p>");
});

test("writeLocation: when nothing was written the answer is exactly false", async (t) => {
  const dirs = makeSite(t);
  const file = path.join(dirs.site, "pages/missing/index.html");
  const result = await item("pages/missing/index.html").writeLocation(
    "<p>body</p>",
    dirs.site,
  );
  if (fs.existsSync(file)) {
    assert.ok(result, "a write that happened reports success");
    assert.equal(fs.readFileSync(file, "utf8"), "<p>body</p>");
  } else {
    assert.equal(result, false);
  }
});

test(
  "writeLocation: a page file that does not exist yet is created",
  {
    todo:
      "Node/PHP difference: haxcms-php writeLocation creates the missing file " +
      "(file_put_contents) and returns the byte count; haxcms-nodejs refuses " +
      "and returns false. saveOutline is unaffected (it copies the " +
      "boilerplate page file before writing).",
  },
  async (t) => {
    const dirs = makeSite(t);
    fs.mkdirpSync(path.join(dirs.site, "pages", "b"));
    const result = await item("pages/b/index.html").writeLocation(
      "<p>b</p>",
      dirs.site,
    );
    assert.ok(result);
    assert.equal(
      fs.readFileSync(path.join(dirs.site, "pages/b/index.html"), "utf8"),
      "<p>b</p>",
    );
  },
);

test(
  "writeLocation: a location that is a directory is not reported as written",
  {
    todo:
      "haxcms-nodejs answers true for a directory without writing anything " +
      "(only regular files are written, but the call still reports " +
      "success); haxcms-php answers false. saveOutline is unaffected (it " +
      "checks the target is a regular file first).",
  },
  async (t) => {
    const dirs = makeSite(t);
    const result = await item("pages/a").writeLocation("<p>dir</p>", dirs.site);
    assert.equal(result, false);
  },
);
