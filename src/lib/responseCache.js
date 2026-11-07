// Cache-Control for responses that must never be served stale
// (haxtheweb/issues#3244).
//
// `no-store` keeps a response out of every cache, and it also makes Chrome
// refuse to keep the page in the back/forward cache: one no-store page or
// one no-store fetch and the Back button always reloads. That cost is worth
// paying only when the response can hold something about a user (tokens, a
// JWT, unpublished content). A request that carries no credentials gets an
// answer that cannot be about anyone, so `private, no-cache` is enough: every
// reuse still revalidates with the server, shared caches still keep out, and
// the page stays bfcache-eligible.
//
// haxcms-php mirrors this in HAXCMS::sendUncachedResponseHeaders().

const REFRESH_COOKIE_PATTERN = /(^|;\s*)haxcms_refresh_token=/;
const USER_HEADERS = [
  "authorization",
  "x-haxcms-user-token",
  "x-haxcms-site-token",
];

const NO_STORE = "no-store, no-cache, must-revalidate, proxy-revalidate";
const REVALIDATE = "private, no-cache, must-revalidate";

// True when the request identifies (or tries to identify) a user: an
// Authorization header, a HAXcms request token header, or the refresh cookie.
function requestCarriesCredentials(req) {
  if (!req || !req.headers) {
    return false;
  }
  for (let i = 0; i < USER_HEADERS.length; i++) {
    const value = req.headers[USER_HEADERS[i]];
    if (typeof value === "string" && value.trim() !== "") {
      return true;
    }
  }
  if (req.cookies && typeof req.cookies.haxcms_refresh_token === "string") {
    return true;
  }
  return (
    typeof req.headers.cookie === "string" &&
    REFRESH_COOKIE_PATTERN.test(req.headers.cookie)
  );
}

/**
 * Headers for a response that must always come fresh from the server.
 * @param res express response
 * @param req express request
 * @param {object} [options]
 * @param {boolean} [options.sensitive] the body holds user-bound data
 *   (tokens, a JWT) whatever the request carried: always no-store
 */
function setUncachedResponseHeaders(res, req, options) {
  if (!res || typeof res.setHeader !== "function") {
    return;
  }
  const sensitive = !!(options && options.sensitive);
  const noStore = sensitive || requestCarriesCredentials(req);
  res.setHeader("Cache-Control", noStore ? NO_STORE : REVALIDATE);
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

module.exports = {
  NO_STORE,
  REVALIDATE,
  requestCarriesCredentials,
  setUncachedResponseHeaders,
};
