"use strict";

// The dashboard page tells <app-hax> where HAXcms is served from. The static
// file says "/" (the web root); when HAXcms is mounted under a path the page
// is stamped with that path, as haxcms-php does in index.php. Without it the
// dashboard's router cannot match the site links it is given (they start with
// the mount path) and clicking a site reports a missing page.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  stampDashboardBasePath,
  ROOT_MARKER,
} = require("../../src/lib/dashboardBasePath.js");

const PAGE = '<body><app-hax base-path="/"></app-hax></body>';

test("at the web root the dashboard page is returned unchanged", () => {
  assert.equal(stampDashboardBasePath(PAGE, "/"), PAGE);
  assert.equal(stampDashboardBasePath(PAGE, ""), PAGE);
  assert.equal(stampDashboardBasePath(PAGE, undefined), PAGE);
  assert.equal(stampDashboardBasePath(PAGE, null), PAGE);
});

test("under a path the dashboard page is given that path", () => {
  assert.equal(
    stampDashboardBasePath(PAGE, "/app/abc123/"),
    '<body><app-hax base-path="/app/abc123/"></app-hax></body>',
  );
  // slashes are added where missing, as HAXCMS.basePath is used elsewhere
  assert.equal(
    stampDashboardBasePath(PAGE, "hax"),
    '<body><app-hax base-path="/hax/"></app-hax></body>',
  );
});

test("the path cannot break out of the attribute", () => {
  const stamped = stampDashboardBasePath(
    PAGE,
    '/a"><script>alert(1)</script>/',
  );
  assert.equal(stamped.indexOf("<script>"), -1);
  assert.equal(stamped.indexOf('a">'), -1);
  assert.ok(stamped.indexOf("&quot;&gt;&lt;script&gt;") !== -1);
});

test("a page without the dashboard element is left alone", () => {
  const site = "<body><haxcms-site-builder></haxcms-site-builder></body>";
  assert.equal(stampDashboardBasePath(site, "/app/abc123/"), site);
});

test("the shipped dashboard page still has the element this stamps", () => {
  // if the front-end build changes how the page declares its base path,
  // stamping would silently do nothing: fail here instead
  const page = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "public", "index.html"),
    "utf8",
  );
  assert.equal(page.split(ROOT_MARKER).length - 1, 1);
});
