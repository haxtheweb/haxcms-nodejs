const { HAXCMS } = require('../../../lib/HAXCMS.js');
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
// Security (EXPRESS-CSRF-001 / M1): the refresh endpoint authenticates via a
// SameSite=Lax cookie and performs a state-changing token rotation. SameSite=Lax
// still sends the cookie on cross-site top-level GET navigations, so verify the
// Origin (falling back to Referer) matches the request's trusted host/protocol
// before honoring the cookie. If no Origin/Referer header is present (non-browser
// clients or same-origin omit), allow — SameSite=Lax + no credentialed CORS
// remains the primary control. Returns true for same-origin / no-header, false
// for a present-but-mismatched origin.
function isSameOriginRequest(req) {
  var originHeader = '';
  if (req && req.headers && typeof req.headers.origin === 'string') {
    originHeader = req.headers.origin.trim();
  }
  if (originHeader === '' && req && req.headers && typeof req.headers.referer === 'string') {
    originHeader = req.headers.referer.trim();
  }
  if (originHeader === '') {
    return true;
  }
  var parsed;
  try {
    parsed = new URL(originHeader);
  } catch (e) {
    return false;
  }
  if (!parsed || !parsed.host) {
    return false;
  }
  var expectedProtocol = HAXCMS.resolveTrustedProtocol(req);
  var expectedHost = HAXCMS.resolveTrustedHost(req);
  var originProtocol = parsed.protocol.replace(':', '');
  if (originProtocol !== expectedProtocol) {
    return false;
  }
  if (parsed.host !== expectedHost) {
    return false;
  }
  return true;
}
function refreshAccessToken(req, res) {
  // Security (EXPRESS-CSRF-001 / M1): reject cross-site cookie-bearing requests
  // to this state-changing refresh endpoint before validating the refresh token.
  if (!isSameOriginRequest(req)) {
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    return res.status(403).json({
      status: 403,
      data: { message: 'Cross-origin request denied' },
    });
  }
  // check that we have a valid refresh token
  const validRefresh = HAXCMS.validateRefreshToken(false, req, res);
  // if we have a valid refresh token then rotate it and issue a new access token
  if (validRefresh) {
    // Security (H1 rotation): rotate the refresh token (family/jti) and set a
    // new cookie so a stolen old refresh token dies on the legitimate user's
    // next refresh. Legacy tokens without family/jti are upgraded in place.
    const rotatedAccessJwt = HAXCMS.rotateRefreshTokenAndCookie(res, validRefresh);
    if (rotatedAccessJwt) {
      res.send({
        status: 200,
        jwt: rotatedAccessJwt,
      });
      return;
    }
    // rotation rejected (possible replay/theft) -> revoke family and clear
    if (validRefresh && validRefresh.user) {
      HAXCMS.revokeRefreshSession(validRefresh.user);
    }
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    return res.status(401).json({ status: 401, data: { message: 'Refresh token validation failed' } });
  }
  else {
    // Security (HAX-SEC / PHP [M3] parity): clear via the centralized helper so
    // the Secure/SameSite/HttpOnly flags match how the cookie was set (required
    // for the browser to actually delete it).
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    return res.status(401).json({ status: 401, data: { message: 'Refresh token validation failed' } });
  }
}
module.exports = refreshAccessToken;