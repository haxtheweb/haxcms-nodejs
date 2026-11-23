"use strict";

// lib/dashboardRoutes.js: which paths the dashboard answers as pages.
// haxcms-php keeps the same list (HAXCMSDashboardRoutes.php); the cases here
// match its HAXCMSDashboardRoutesTest.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  dashboardRelativePath,
  isDashboardRoutePath,
} = require("../../src/lib/dashboardRoutes.js");

test("dashboard pages are routes", () => {
  [
    "/",
    "",
    "/home",
    "/home/",
    "/index.html",
    "/index.php",
    "/search",
    "/search?q=x",
    "/createSite-step-1",
    "/createSite-step-3",
  ].forEach((p) => assert.equal(isDashboardRoutePath(p), true, p));
});

test("anything else is not a dashboard route", () => {
  [
    "/totally-random-page",
    "/homework",
    "/search/deeper",
    "/createSite",
    "/x/api",
    "/index.htm",
  ].forEach((p) => assert.equal(isDashboardRoutePath(p), false, p));
});

test("paths are read relative to the base path", () => {
  assert.equal(dashboardRelativePath("/hax/search", "/hax/"), "search");
  assert.equal(dashboardRelativePath("/hax/", "/hax/"), "");
  assert.equal(dashboardRelativePath("/hax", "/hax/"), "");
  assert.equal(isDashboardRoutePath("/hax/home", "/hax/"), true);
  assert.equal(isDashboardRoutePath("/hax/nope", "/hax/"), false);
  // a path outside the base path is read as given
  assert.equal(dashboardRelativePath("/other/home", "/hax/"), "other/home");
});
