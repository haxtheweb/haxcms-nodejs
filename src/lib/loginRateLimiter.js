// Shared in-memory login brute-force tracker.
//
// This module holds a single process-wide failed-attempt store so that every
// authentication entry point (the username/password login route and the site
// API Basic Auth path) is throttled against the same counters. Keeping the
// store here means an attacker cannot dodge the limiter by alternating between
// endpoints.
//
// Settings are passed in by callers (resolved from HAXCMS.getLoginRateLimitSettings())
// so this module stays free of configuration and circular dependencies.
const failedLoginTracker = {};

function getClientIP(req) {
  // Prefer req.ip which honors the app's configured `trust proxy` setting.
  if (req && req.ip) {
    return String(req.ip);
  }
  if (req && req.headers && req.headers['x-forwarded-for']) {
    const forwarded = String(req.headers['x-forwarded-for']).split(',')[0].trim();
    if (forwarded) {
      return forwarded;
    }
  }
  if (req && req.connection && req.connection.remoteAddress) {
    return String(req.connection.remoteAddress);
  }
  return 'unknown';
}

function getAttemptKey(req, username) {
  return getClientIP(req) + '::' + String(username || '');
}

function getTrackerEntry(key, now, settings) {
  let entry = failedLoginTracker[key];
  if (!entry) {
    entry = {
      firstAttempt: now,
      failedAttempts: 0,
      blockedUntil: 0,
    };
    failedLoginTracker[key] = entry;
  }
  if (now - entry.firstAttempt > settings.windowMs) {
    entry.firstAttempt = now;
    entry.failedAttempts = 0;
  }
  return entry;
}

function clearTrackerEntry(key) {
  if (failedLoginTracker[key]) {
    delete failedLoginTracker[key];
  }
}

function isBlocked(entry, now) {
  return entry && entry.blockedUntil && entry.blockedUntil > now;
}

function registerFailedAttempt(entry, now, settings) {
  entry.failedAttempts += 1;
  if (entry.failedAttempts >= settings.maxAttempts) {
    entry.blockedUntil = now + settings.blockMs;
    entry.failedAttempts = 0;
    entry.firstAttempt = now;
  }
}

module.exports = {
  getClientIP,
  getAttemptKey,
  getTrackerEntry,
  clearTrackerEntry,
  isBlocked,
  registerFailedAttempt,
};
