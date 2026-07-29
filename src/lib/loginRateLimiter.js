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
//
// Security (HAX-SEC-003): the store is process-local and in-memory. Entries are
// pruned lazily (on access) and capped at MAX_TRACKED_KEYS to bound memory — an
// attacker rotating usernames/IPs cannot grow it without limit. For multi-
// instance deployments, a Redis-backed store can be dropped in behind the same
// getTrackerEntry/clearTrackerEntry/isBlocked/registerFailedAttempt API;
// in-memory protection is per-process until then (PHP uses a cache-backed
// multi-process limiter for parity reference).
const failedLoginTracker = {};
const MAX_TRACKED_KEYS = 10000;

// Security (HAX-SEC-003): remove entries whose block has expired AND whose
// window has elapsed. Called lazily on new-entry creation so the map cannot
// grow without bound. Never drops an entry that is still actively blocking.
function pruneExpiredEntries(now, settings) {
  var keys = Object.keys(failedLoginTracker);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var entry = failedLoginTracker[key];
    if (!entry) {
      continue;
    }
    if (entry.blockedUntil <= now && (now - entry.firstAttempt) > settings.windowMs) {
      delete failedLoginTracker[key];
    }
  }
}

function getClientIP(req) {
  // Security (HAX-SEC-009 / PHP [M2] parity): rely solely on req.ip, which
  // honors the app's configured `trust proxy` setting (fed from
  // config.security.trustedProxies via HAXCMS.getTrustProxySetting). Do NOT
  // trust the raw x-forwarded-for header directly — a spoofable XFF lets an
  // attacker rotate the rate-limit key and evade brute-force protection.
  // req.ip falls back to the socket peer address when trust proxy is off.
  if (req && req.ip) {
    return String(req.ip);
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
    // Security (HAX-SEC-003): prune expired entries and enforce a hard cap on
    // total tracked keys to bound memory. An attacker rotating usernames/IPs
    // could otherwise grow failedLoginTracker without limit (DoS).
    pruneExpiredEntries(now, settings);
    var trackedKeys = Object.keys(failedLoginTracker);
    if (trackedKeys.length >= MAX_TRACKED_KEYS) {
      // evict the oldest entry (lowest firstAttempt) to make room
      var oldestKey = trackedKeys[0];
      var oldestTime = failedLoginTracker[trackedKeys[0]].firstAttempt;
      for (var i = 1; i < trackedKeys.length; i++) {
        if (failedLoginTracker[trackedKeys[i]].firstAttempt < oldestTime) {
          oldestKey = trackedKeys[i];
          oldestTime = failedLoginTracker[trackedKeys[i]].firstAttempt;
        }
      }
      delete failedLoginTracker[oldestKey];
    }
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
    // clear an expired block when the window resets (mirrors PHP login.php:43-45)
    if (entry.blockedUntil <= now) {
      entry.blockedUntil = 0;
    }
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
