const { HAXCMS } = require("../../../lib/HAXCMS.js");
/**
 * @OA\Get(
 *    path="/refreshAccessToken",
 *    tags={"cms","user"},
 *    @OA\Response(
 *        response="200",
 *        description="User access token for refreshing JWT when it goes stale"
 *   )
 * )
 */
// Security (SEC-SESSION): the refresh endpoint authenticates via a
// SameSite=Lax cookie and performs a state-changing token rotation. SameSite=Lax
// still sends the cookie on cross-site top-level GET navigations, so verify the
// Origin (falling back to Referer) matches the request's trusted host/protocol
// before honoring the cookie. The check lives in
// HAXCMS.isSameOriginRequest (shared with session/connection-test) and also
// rejects `Sec-Fetch-Site: cross-site` when the browser sends it.
function isSameOriginRequest(req) {
  return HAXCMS.isSameOriginRequest(req);
}
// Security: GET session/refresh is the one cookie-authenticated, state-changing
// endpoint a browser can reach with a plain top-level navigation (SameSite=Lax
// still sends the cookie on cross-site GETs). The rule, identical in both
// backends (haxcms-php mirrors it):
//   1. Sec-Fetch-Site present  -> allow 'same-origin' and 'none' only;
//      reject 'same-site' and 'cross-site'.
//   2. Sec-Fetch-Site absent but Origin or Referer present -> the existing
//      same-origin host check (HAXCMS.isSameOriginRequest); reject on mismatch.
//   3. Sec-Fetch-Site, Origin and Referer ALL absent -> allow (non-browser
//      clients such as haxcms-mcp rely on this).
// POST refresh keeps the shared isSameOriginRequest behaviour.
function isRefreshGetRequestAllowed(req) {
  const headers = req && req.headers ? req.headers : {};
  if (typeof headers["sec-fetch-site"] === "string") {
    const fetchSite = headers["sec-fetch-site"].trim().toLowerCase();
    return fetchSite === "same-origin" || fetchSite === "none";
  }
  const hasOrigin =
    typeof headers.origin === "string" && headers.origin.trim() !== "";
  const hasReferer =
    typeof headers.referer === "string" && headers.referer.trim() !== "";
  if (hasOrigin || hasReferer) {
    return isSameOriginRequest(req);
  }
  return true;
}
function isRefreshRequestAllowed(req) {
  const method =
    req && typeof req.method === "string" ? req.method.toUpperCase() : "";
  if (method === "GET" || method === "HEAD") {
    return isRefreshGetRequestAllowed(req);
  }
  return isSameOriginRequest(req);
}
async function refreshAccessToken(req, res) {
  // Security (SEC-SESSION): reject cross-site cookie-bearing requests
  // to this state-changing refresh endpoint before validating the refresh token.
  if (!isRefreshRequestAllowed(req)) {
    HAXCMS.setRefreshTokenCookie(res, "", 1);
    return res.status(403).json({
      status: 403,
      data: { message: "Cross-origin request denied" },
    });
  }
  // check that we have a valid refresh token
  const validRefresh = HAXCMS.validateRefreshToken(false, req, res);
  // if we have a valid refresh token then rotate it and issue a new access token
  if (validRefresh) {
    // Security (SEC-SESSION): rotate the refresh token (family/jti) and set a
    // new cookie so a stolen old refresh token dies on the legitimate user's
    // next refresh. Legacy tokens without family/jti are upgraded in place.
    const rotatedAccessJwt = HAXCMS.rotateRefreshTokenAndCookie(
      res,
      validRefresh,
    );
    if (rotatedAccessJwt) {
      // Security (SEC-SESSION): include fresh request tokens (userToken, and
      // siteToken when a site context is resolvable) so an editor that booted
      // anonymously can pick them up without reloading connection-settings.
      let sessionTokens = {};
      try {
        sessionTokens = await HAXCMS.getSessionRequestTokens(req);
      } catch {
        sessionTokens = {};
      }
      res.send(
        Object.assign(
          {
            status: 200,
            jwt: rotatedAccessJwt,
          },
          sessionTokens,
        ),
      );
      return;
    }
    // rotation rejected (possible replay/theft) -> revoke family and clear
    if (validRefresh && validRefresh.user) {
      HAXCMS.revokeRefreshSession(
        validRefresh.user,
        validRefresh.family || null,
      );
    }
    HAXCMS.setRefreshTokenCookie(res, "", 1);
    return res
      .status(401)
      .json({
        status: 401,
        data: { message: "Refresh token validation failed" },
      });
  } else {
    // Security (SEC-SESSION), PHP parity: clear via the centralized helper so
    // the Secure/SameSite/HttpOnly flags match how the cookie was set (required
    // for the browser to actually delete it).
    HAXCMS.setRefreshTokenCookie(res, "", 1);
    return res
      .status(401)
      .json({
        status: 401,
        data: { message: "Refresh token validation failed" },
      });
  }
}
module.exports = refreshAccessToken;
module.exports.isRefreshGetRequestAllowed = isRefreshGetRequestAllowed;
