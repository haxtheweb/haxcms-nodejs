const { HAXCMS } = require('../../../lib/HAXCMS.js');
function logoutRoute(req, res)  {
    // DRAFT plugin platform: who is signing out, for user.after.logout below
    let pluginUserName = '';
    // Security (SEC-SESSION): revoke the refresh-token family server-side
    // so a refresh token exfiltrated before logout can't mint new access tokens
    // after this user logs out. Best-effort.
    try {
      if (req && req.cookies && req.cookies.haxcms_refresh_token) {
        const decoded = HAXCMS.decodeRefreshToken(req.cookies.haxcms_refresh_token);
        if (decoded && decoded.user) {
          // Security (SEC-SESSION): tombstone the presented family (or, for a
          // legacy no-family token, every legacy token issued so far) so the
          // revoked token can never be re-seeded.
          HAXCMS.revokeRefreshSession(decoded.user, decoded.family || null);
          pluginUserName = String(decoded.user);
        }
      }
    }
    catch {
      // intentionally ignored
    }
    // Security (SEC-SESSION), PHP parity: clear via the centralized helper so
    // the Secure/SameSite/HttpOnly flags match how the cookie was set (required
    // for the browser to actually delete it).
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    res.send({
        "status" : 200,
        "data" : 'loggedout',
    })
    // DRAFT plugin platform: user.after.logout (spec/06), once the session has ended and the answer is sent.
    // Sign-out is never held up or stopped by a plugin, so there is no before hook here.
    if (pluginUserName) {
      const pluginSystem = require('../../../lib/plugins/pluginSystem.js');
      pluginSystem
        .event(null, 'user.after.logout', pluginSystem.userRecord(pluginUserName), { user: null })
        .catch(() => {});
    }
}

module.exports = logoutRoute;