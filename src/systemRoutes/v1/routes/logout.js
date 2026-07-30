const { HAXCMS } = require('../../../lib/HAXCMS.js');
function logoutRoute(req, res)  {
    // Security (H1/L2 revocation): revoke the refresh-token family server-side
    // so a refresh token exfiltrated before logout can't mint new access tokens
    // after this user logs out. Best-effort: legacy tokens without a stored
    // family simply have nothing to revoke.
    try {
      if (req && req.cookies && req.cookies.haxcms_refresh_token) {
        const decoded = HAXCMS.decodeRefreshToken(req.cookies.haxcms_refresh_token);
        if (decoded && decoded.user) {
          HAXCMS.revokeRefreshSession(decoded.user);
        }
      }
    }
    catch (e) {}
    // Security (HAX-SEC / PHP [M3] parity): clear via the centralized helper so
    // the Secure/SameSite/HttpOnly flags match how the cookie was set (required
    // for the browser to actually delete it).
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    res.send({
        "status" : 200,
        "data" : 'loggedout',
    })
}

module.exports = logoutRoute;