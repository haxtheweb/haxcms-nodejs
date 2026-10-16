const { HAXCMS } = require('../../../lib/HAXCMS.js');
const magicLinks = require('../../../lib/magicLinks.js');
const refreshAccessToken = require('./refreshAccessToken.js');
const {
  getAttemptKey,
  getTrackerEntry,
  clearTrackerEntry,
  isBlocked,
  registerFailedAttempt,
} = require('../../../lib/loginRateLimiter.js');

// Rate-limit bucket shared by every consume attempt from one client IP. Kept
// separate from password-login buckets so a lockout on one does not block the
// other recovery path.
const RATE_LIMIT_SUBJECT = '__haxcms_magic_link__';
const GENERIC_FAILURE = 'This sign-in link is invalid or has expired. Generate a new one and try again.';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSubmittedToken(req) {
  if (req && req.body && typeof req.body.token === 'string' && req.body.token !== '') {
    return req.body.token;
  }
  if (req && req.query && typeof req.query.token === 'string') {
    return req.query.token;
  }
  return '';
}

function wantsJson(req) {
  var accept = req && req.headers && typeof req.headers.accept === 'string' ? req.headers.accept : '';
  var contentType = req && req.headers && typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
  return accept.indexOf('application/json') !== -1 || contentType.indexOf('application/json') !== -1;
}

function getAppRoot() {
  return typeof HAXCMS.basePath === 'string' && HAXCMS.basePath !== '' ? HAXCMS.basePath : '/';
}

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  // keep the token out of Referer headers sent to anything the page loads
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function renderPage(title, bodyHtml) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>' +
    'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#1e1e1e}' +
    '@media (prefers-color-scheme:dark){body{background:#1e1e1e;color:#f5f7fa}main{background:#262626!important}}' +
    'main{background:#fff;padding:2rem;border-radius:8px;max-width:28rem;margin:1rem;box-shadow:0 2px 8px rgba(0,0,0,.15)}' +
    'h1{font-size:1.5rem;margin:0 0 1rem}p{line-height:1.5}' +
    'button,a.button{font:inherit;font-weight:700;padding:.75rem 1.5rem;border:0;border-radius:4px;background:#001e44;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}' +
    'button:focus-visible,a.button:focus-visible{outline:3px solid #009cde;outline-offset:2px}' +
    '</style></head><body><main>' + bodyHtml + '</main></body></html>';
}

function sendFailure(req, res, status, message) {
  HAXCMS.setRefreshTokenCookie(res, '', 1);
  if (wantsJson(req)) {
    return res.status(status).json({ status: status, data: { message: message } });
  }
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(renderPage('Sign-in link not valid',
    '<h1>Sign-in link not valid</h1><p>' + escapeHtml(message) + '</p>' +
    '<p><a class="button" href="' + escapeHtml(getAppRoot()) + '">Go to site</a></p>'));
}

// When the feature is turned off the endpoint behaves as if it doesn't exist:
// no confirmation page, nothing that suggests a recovery path is available.
function sendNotFound(res) {
  return res.status(404).json({ status: 404, data: { message: 'Not found' } });
}

/**
 * GET: show a confirmation page. GET never consumes the link, so link
 * scanners / chat unfurlers / browser prefetch cannot burn it.
 */
function magicLinkConfirm(req, res) {
  setNoStoreHeaders(res);
  if (!magicLinks.isMagicLinkEnabled(HAXCMS)) {
    return sendNotFound(res);
  }
  var token = getSubmittedToken(req);
  if (!magicLinks.isWellFormedToken(token)) {
    return sendFailure(req, res, 400, GENERIC_FAILURE);
  }
  if (wantsJson(req)) {
    return res.status(405).json({
      status: 405,
      data: { message: 'POST the token to this endpoint to complete sign-in.' },
    });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // token is validated against a strict [A-Za-z0-9_-.] shape above and still
  // escaped, so it is safe to place in the form
  return res.send(renderPage('Sign in to HAXcms',
    '<h1>Sign in to HAXcms</h1>' +
    '<p>This one-time link signs you in. It stops working once used or when it expires.</p>' +
    '<form method="post"><input type="hidden" name="token" value="' + escapeHtml(token) + '">' +
    '<button type="submit">Sign in</button></form>'));
}

/**
 * POST: redeem the link once, issue the same refresh cookie as a password
 * login, then hand off to the app (which bootstraps via session/connection-test).
 */
function magicLinkConsume(req, res) {
  setNoStoreHeaders(res);
  if (!magicLinks.isMagicLinkEnabled(HAXCMS)) {
    return sendNotFound(res);
  }
  if (!refreshAccessToken.isSameOriginRequest(req)) {
    return sendFailure(req, res, 403, 'Cross-origin request denied');
  }
  var settings = HAXCMS.getLoginRateLimitSettings();
  var now = Date.now();
  var attemptKey = getAttemptKey(req, RATE_LIMIT_SUBJECT);
  var entry = getTrackerEntry(attemptKey, now, settings);
  if (settings.enabled && isBlocked(entry, now)) {
    var retryAfterSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
    if (retryAfterSeconds > 0) {
      res.set('Retry-After', String(retryAfterSeconds));
    }
    return sendFailure(req, res, 429, 'Too many failed sign-in attempts. Please try again later.');
  }
  var result = magicLinks.consumeMagicLink(HAXCMS, getSubmittedToken(req), now);
  if (!result.ok) {
    if (settings.enabled) {
      registerFailedAttempt(entry, now, settings);
    }
    return sendFailure(req, res, 401, GENERIC_FAILURE);
  }
  clearTrackerEntry(attemptKey);
  HAXCMS.setRefreshTokenCookie(res, HAXCMS.getRefreshToken(result.user), 24 * 60 * 60 * 1000);
  if (wantsJson(req)) {
    return res.json({
      status: 200,
      jwt: HAXCMS.getJWT(result.user),
    });
  }
  return res.redirect(303, getAppRoot());
}

module.exports = {
  magicLinkConfirm: magicLinkConfirm,
  magicLinkConsume: magicLinkConsume,
};
