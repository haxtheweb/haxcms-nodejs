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
  // if we have a valid refresh token then issue a new access token
  if (validRefresh) {
    res.send({
      status: 200,
      jwt: HAXCMS.getJWT(validRefresh.user)
    });
  }
  else {
    // Security (HAX-SEC / PHP [M3] parity): clear via the centralized helper so
    // the Secure/SameSite/HttpOnly flags match how the cookie was set (required
    // for the browser to actually delete it).
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    res.sendStatus(401);
  }
}
module.exports = refreshAccessToken;