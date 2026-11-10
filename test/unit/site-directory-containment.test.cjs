"use strict";

// Security (code-scanning js/path-injection): a site name from a request must
// never resolve a site folder outside the sites directory. HAXCMSSite.load()
// refuses it, newSite() fails creation, and HAXCMS.loadSite() treats it as
// "not a site" (false) instead of throwing.
//
// Constraints honored: CommonJS (.cjs), node:test + node:assert/strict,
// temp dirs only, NO optional chaining.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs-extra");

const { HAXCMS, HAXCMSSite } = require("../../src/lib/HAXCMS.js");

function tmpSitesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-site-contain-"));
}

test("load() refuses a name that resolves to the sites directory itself", async (t) => {
  // cleanTitle trims "/" from both ends (so "/" becomes "blank"); a
  // passthrough stand-in proves the containment check itself still refuses
  // a name that collapses to the sites directory. Mirrors
  // SiteDirectoryContainmentTest in haxcms-php.
  t.mock.method(HAXCMS, "cleanTitle", (value) => String(value).trim());
  const sites = tmpSitesDir();
  // a site.json at the sites root must not be loadable as a "site"
  fs.writeJsonSync(path.join(sites, "site.json"), { items: [] });
  const names = ["/", "%2F", "//"];
  for (let i = 0; i < names.length; i++) {
    const site = new HAXCMSSite();
    await assert.rejects(
      site.load(sites, "/sites/", names[i]),
      /outside the sites directory/,
      names[i],
    );
    assert.equal(site.siteDirectory, undefined, names[i]);
  }
});

test("cleanTitle never maps a site name to the sites directory itself", () => {
  const names = ["/", "%2F", "//", "./", "../", ".", ".."];
  for (let i = 0; i < names.length; i++) {
    const segment = HAXCMS.cleanTitle(decodeURIComponent(names[i]), false);
    assert.equal(segment, "blank", names[i]);
  }
});

test("load() keeps traversal names inside the sites directory", async () => {
  const sites = tmpSitesDir();
  const site = new HAXCMSSite();
  // cleanTitle collapses ".." to "-", so this can only ever name a child
  try {
    await site.load(sites, "/sites/", "..%2F..%2Fetc");
  } catch {
    // a missing site.json is fine; only the resolved folder matters here
  }
  if (typeof site.siteDirectory === "string") {
    assert.equal(
      site.siteDirectory.indexOf(path.resolve(sites) + path.sep),
      0,
      site.siteDirectory,
    );
  }
});

test("load() still treats a leading slash as relative, as it always has", async () => {
  const sites = tmpSitesDir();
  fs.ensureDirSync(path.join(sites, "childsite"));
  fs.writeJsonSync(path.join(sites, "childsite", "site.json"), { items: [] });
  const site = new HAXCMSSite();
  try {
    await site.load(sites, "/sites/", "/childsite");
  } catch {
    // manifest parsing details are not under test here
  }
  assert.equal(site.siteDirectory, path.join(path.resolve(sites), "childsite"));
});

test("newSite() never targets the sites directory itself", async () => {
  const sites = tmpSitesDir();
  const site = new HAXCMSSite();
  try {
    await site.newSite(sites, "/sites/", "/");
  } catch {
    // only where it would write is under test here
  }
  // the sites root is never the site folder, and nothing lands at its top
  assert.notEqual(site.siteDirectory, path.resolve(sites));
  assert.equal(fs.existsSync(path.join(sites, "index.html")), false);
  if (typeof site.siteDirectory === "string") {
    assert.equal(
      site.siteDirectory.indexOf(path.resolve(sites) + path.sep),
      0,
      site.siteDirectory,
    );
  }
});
