// Security (SEC-STATIC-DOTFILES, SEC-LOCAL-ORIGIN): pure request
// guards shared by the static file handlers and the no-login (local mode)
// middleware in src/app.js. Kept dependency-free so they can be unit tested
// without booting the server.
//
// 1. Static dotfiles. `res.sendFile` is told `dotfiles: "allow"` so that
//    `/.well-known/*` (security.txt, api-catalog, agent-skills) can be served.
//    That decision must never be made with a regex on the RAW url:
//    `/.well-known/../.git/config` (or `%2e%2e`) would match, `send` normalizes the
//    path afterwards, and `.git` would be served. Every decision here is made on
//    the DECODED path split into segments, and any `..` segment is refused.
//
// 2. Local mode cross-site writes. With HAXCMS_DISABLE_JWT_CHECKS every
//    request is treated as the superuser. The Host guard stops DNS rebinding,
//    but a hostile page can still submit a cross-site form POST to
//    http://localhost:<port>. Non-safe methods with a foreign Origin (or a
//    Sec-Fetch-Site of cross-site) are refused in that mode.

const WELL_KNOWN_SEGMENT = ".well-known";
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

// decode once (falling back to the raw value) and split into path segments on
// both separators; the query string is never part of the decision
function getDecodedPathSegments(url = "") {
  let pathOnly = String(url || "").split("?")[0];
  try {
    pathOnly = decodeURIComponent(pathOnly);
  } catch {
    // malformed escapes: decide on the raw path
  }
  return pathOnly.split("\\").join("/").split("/");
}

// true when any decoded path segment is a parent directory reference.
// Browsers and HTTP clients normalize these away before sending, so only a
// hand-crafted request (curl --path-as-is, %2e%2e) ever contains one.
function hasParentDirectorySegment(url = "") {
  const segments = getDecodedPathSegments(url);
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "..") {
      return true;
    }
  }
  return false;
}

// dotfiles may only be served when the request targets .well-known and no
// other segment is a dotfile/dot-directory (so .git, .github, .env stay hidden)
function shouldAllowWellKnownDotfiles(url = "") {
  const segments = getDecodedPathSegments(url);
  let sawWellKnown = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment.charAt(0) !== ".") {
      continue;
    }
    if (segment.toLowerCase() === WELL_KNOWN_SEGMENT) {
      sawWellKnown = true;
      continue;
    }
    // "..", ".git", ".env", etc.
    return false;
  }
  return sawWellKnown;
}

// HAXCMS_DISABLE_JWT_CHECKS used to be enabled by ANY value, so `=false` or
// `=0` in a .env turned login off. Only explicit truthy values count now.
function isEnabledFlagValue(value) {
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function getHeaderValue(req, name) {
  if (!req || !req.headers) {
    return "";
  }
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

// host[:port] of an Origin header, lowercased; "" when it is not http(s)
function getOriginHost(origin) {
  let parsed = null;
  try {
    parsed = new URL(origin);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }
  return parsed.host.toLowerCase();
}

// Should a request be refused because it is a cross-site write while the
// no-login bypass is active? Requests with no Origin and no Sec-Fetch-Site
// (CLI tools, curl, server-to-server) are allowed: only browsers attach those
// headers, and the attack is a browser being driven by a hostile page.
// `allowedOrigins` holds extra exact origins that may write (the configured
// security.allowedOrigin).
function isCrossSiteLocalModeWrite(req, allowedOrigins) {
  const method = req && typeof req.method === "string" ? req.method : "GET";
  if (SAFE_METHODS.indexOf(method.toUpperCase()) !== -1) {
    return false;
  }
  const fetchSite = getHeaderValue(req, "sec-fetch-site").trim().toLowerCase();
  if (fetchSite === "cross-site") {
    return true;
  }
  const origin = getHeaderValue(req, "origin").trim();
  if (origin === "") {
    return false;
  }
  const extraOrigins = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  for (let i = 0; i < extraOrigins.length; i++) {
    if (
      typeof extraOrigins[i] === "string" &&
      extraOrigins[i].trim() !== "" &&
      extraOrigins[i].trim().toLowerCase() === origin.toLowerCase()
    ) {
      return false;
    }
  }
  // "null" (sandboxed iframes, file://) and non-http origins never match
  const originHost = getOriginHost(origin);
  const requestHost = getHeaderValue(req, "host").trim().toLowerCase();
  if (originHost === "" || requestHost === "") {
    return true;
  }
  return originHost !== requestHost;
}

module.exports = {
  getDecodedPathSegments,
  hasParentDirectorySegment,
  shouldAllowWellKnownDotfiles,
  isEnabledFlagValue,
  isCrossSiteLocalModeWrite,
};
