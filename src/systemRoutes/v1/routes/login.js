const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  getAttemptKey,
  getTrackerEntry,
  clearTrackerEntry,
  isBlocked,
  registerFailedAttempt,
} = require('../../../lib/loginRateLimiter.js');
function loginRoute(req, res)  {
  // primary branch: username / password login
  if (req.body && req.body.username && req.body.password) {
    const u = req.body.username;
    const p = req.body.password;
    const settings = HAXCMS.getLoginRateLimitSettings();
    const now = Date.now();
    const attemptKey = getAttemptKey(req, u);
    const entry = getTrackerEntry(attemptKey, now, settings);
    if (settings.enabled && isBlocked(entry, now)) {
      const retryAfterSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
      if (retryAfterSeconds > 0) {
        res.set('Retry-After', String(retryAfterSeconds));
      }
      return res.sendStatus(429);
    }
    // test if this is a valid user login
    if (!HAXCMS.testLogin(u, p, true)) {
      if (settings.enabled) {
        registerFailedAttempt(entry, now, settings);
      }
      return res.sendStatus(403);
    }
    clearTrackerEntry(attemptKey);
    // set a refresh_token COOKIE that will ship w/ all calls automatically
    // Security (HAX-SEC / PHP [M3] parity): use the centralized helper so
    // Secure/SameSite/HttpOnly/path flags are consistent at every call site.
    HAXCMS.setRefreshTokenCookie(res, HAXCMS.getRefreshToken(u), 24 * 60 * 60 * 1000);
    return res.json({
      status: 200,
      jwt: HAXCMS.getJWT(u),
    });
  }
  // login end point requested yet a jwt already exists
  // this is something of a revalidate case
  else if (
    (req.body && Object.keys(req.body).length && req.body['jwt']) ||
    (req.query && Object.keys(req.query).length && req.query['jwt'])
  ) {
    const valid = HAXCMS.validateJWT(req, res);
    if (valid) {
      return res.json({
        status: 200,
        jwt: valid,
      });
    }
    return res.sendStatus(403);
  }
  else {
    res.sendStatus(403);
  }
}

module.exports = loginRoute;
