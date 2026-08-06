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
function refreshAccessToken(req, res) {
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