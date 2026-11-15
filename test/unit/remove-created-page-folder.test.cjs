"use strict";

// HAXCMSSite.removeCreatedPageFolder() (haxtheweb/issues#3287, FI-OUT-01 /
// FI-NODE-02): removes a page folder a failed save created, and nothing
// outside the site's pages/ directory. haxcms-php mirrors it
// (RemoveCreatedPageFolderTest.php).
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-page-folder-"));
process.env.HAXCMS_ROOT = root + "/";

const { HAXCMSSite } = require("../../src/lib/HAXCMS.js");

test.after(() => {
  fs.removeSync(root);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, "case-"));
  const siteDirectory = path.join(dir, "demo");
  fs.ensureDirSync(path.join(siteDirectory, "pages", "new-page", "assets"));
  fs.writeFileSync(
    path.join(siteDirectory, "pages", "new-page", "index.html"),
    "<p></p>",
  );
  fs.writeFileSync(
    path.join(siteDirectory, "pages", "new-page", "assets", "a.txt"),
    "a",
  );
  fs.writeFileSync(path.join(siteDirectory, "site.json"), "{}");
  fs.ensureDirSync(path.join(dir, "outside"));
  t.after(() => fs.removeSync(dir));
  const site = new HAXCMSSite();
  site.siteDirectory = siteDirectory;
  return { dir: dir, site: site, siteDirectory: siteDirectory };
}

test("removes a page folder under pages/", (t) => {
  const f = fixture(t);
  const folder = path.join(f.siteDirectory, "pages", "new-page");
  assert.equal(f.site.removeCreatedPageFolder(folder), true);
  assert.equal(fs.existsSync(folder), false);
  assert.ok(fs.existsSync(path.join(f.siteDirectory, "pages")));
});

test("never removes anything outside pages/", (t) => {
  const f = fixture(t);
  [
    path.join(f.siteDirectory, "pages"),
    f.siteDirectory,
    path.join(f.dir, "outside"),
    path.join(f.siteDirectory, "pages", "..", "..", "outside"),
    "",
    null,
  ].forEach((folder) => {
    assert.equal(f.site.removeCreatedPageFolder(folder), false, String(folder));
  });
  assert.ok(fs.existsSync(path.join(f.dir, "outside")));
  assert.ok(fs.existsSync(path.join(f.siteDirectory, "site.json")));
  if (process.platform !== "win32") {
    const linked = path.join(f.siteDirectory, "pages", "linked");
    fs.symlinkSync(path.join(f.dir, "outside"), linked);
    assert.equal(f.site.removeCreatedPageFolder(linked), false);
    assert.ok(fs.existsSync(path.join(f.dir, "outside")));
  }
});
