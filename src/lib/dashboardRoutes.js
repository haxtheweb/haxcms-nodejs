"use strict";

// Which paths the dashboard (public/index.html, app-hax) answers as its own
// pages. Everything else that reaches the dashboard catch-all still gets the
// dashboard shell, so the app can show its own "not found" view, but with a
// 404 status: a stray or mistyped URL must not look like a real page to
// browsers, crawlers and assistive tech that read the status.
//
// haxcms-php keeps the same list in
// system/backend/php/lib/HAXCMSDashboardRoutes.php; change both together.

const DASHBOARD_PAGES = ["", "home", "index.html", "index.php", "search"];
const DASHBOARD_PAGE_PREFIXES = ["createSite-step-"];

/**
 * The request path relative to where HAXcms is served, without query,
 * fragment or surrounding slashes.
 * @param {string} requestPath path as requested ("/home", "/hax/search?x")
 * @param {string} basePath where HAXcms is mounted ("/" or "/hax/")
 * @returns {string}
 */
function dashboardRelativePath(requestPath, basePath) {
  let value = typeof requestPath === "string" ? requestPath : "";
  value = value.split("?")[0].split("#")[0];
  const base =
    typeof basePath === "string" && basePath !== "" && basePath !== "/"
      ? "/" + basePath.replace(/^\/+|\/+$/g, "") + "/"
      : "/";
  if (base !== "/" && (value + "/").indexOf(base) === 0) {
    value = value.substring(base.length - 1);
  }
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * TRUE when the dashboard answers this path as one of its pages.
 * @param {string} requestPath
 * @param {string} [basePath]
 * @returns {boolean}
 */
function isDashboardRoutePath(requestPath, basePath) {
  const relative = dashboardRelativePath(requestPath, basePath);
  if (DASHBOARD_PAGES.indexOf(relative) !== -1) {
    return true;
  }
  for (let i = 0; i < DASHBOARD_PAGE_PREFIXES.length; i++) {
    if (relative.indexOf(DASHBOARD_PAGE_PREFIXES[i]) === 0) {
      return true;
    }
  }
  return false;
}

module.exports = {
  DASHBOARD_PAGES,
  DASHBOARD_PAGE_PREFIXES,
  dashboardRelativePath,
  isDashboardRoutePath,
};
