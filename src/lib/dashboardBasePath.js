"use strict";

// The dashboard page (public/index.html) is a static file whose <app-hax>
// says it is served from the web root: base-path="/". When HAXcms is mounted
// under a path (HAXCMS.basePath is not "/"), the site list it receives has
// links that start with that path, so the dashboard has to be told the same
// path or its router cannot match them and reports a missing page.
// haxcms-php prints HAXCMS->basePath into the same attribute (index.php).
//
// Security: the value goes into an HTML attribute, so it is escaped here.

const ROOT_MARKER = '<app-hax base-path="/"';

function normalizeBasePath(basePath) {
  let value = typeof basePath === "string" ? basePath.trim() : "";
  if (value === "") {
    return "/";
  }
  if (value.charAt(0) !== "/") {
    value = "/" + value;
  }
  if (value.charAt(value.length - 1) !== "/") {
    value += "/";
  }
  return value;
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Give the dashboard page the base path HAXcms is served from.
 * At the web root ("/") the page is returned unchanged.
 */
function stampDashboardBasePath(indexFile, basePath) {
  const output = String(indexFile || "");
  const normalized = normalizeBasePath(basePath);
  if (normalized === "/") {
    return output;
  }
  return output
    .split(ROOT_MARKER)
    .join('<app-hax base-path="' + escapeAttribute(normalized) + '"');
}

module.exports = {
  stampDashboardBasePath,
  ROOT_MARKER,
};
