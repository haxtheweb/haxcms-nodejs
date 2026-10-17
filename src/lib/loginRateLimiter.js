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
const DEFAULT_MAX_TRACKED_KEYS = 10000;
let MAX_TRACKED_KEYS = DEFAULT_MAX_TRACKED_KEYS;

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
      // Security (SEC-SESSION): never evict an entry that is still actively
      // blocking (blockedUntil > now). Previously the oldest firstAttempt was
      // evicted, so an attacker could flood new usernames/IPs to push their
      // own blocked entry out and reset the block. Expired-by-window entries
      // were already pruned above; now evict the least-recently-seen
      // NON-blocked entry. If every tracked entry is blocked, nothing is
      // evicted and the map may temporarily exceed the soft cap (mirrors PHP
      // login.php, whose cache-backed tracker never drops a live block).
      // Growth stays bounded: each blocked entry costs maxAttempts failures
      // and expires after blockMs.
      var evictKey = null;
      var evictSeen = Infinity;
      for (var i = 0; i < trackedKeys.length; i++) {
        var candidate = failedLoginTracker[trackedKeys[i]];
        if (!candidate || candidate.blockedUntil > now) {
          continue;
        }
        var seen = typeof candidate.lastSeen === 'number'
          ? candidate.lastSeen
          : candidate.firstAttempt;
        if (seen < evictSeen) {
          evictSeen = seen;
          evictKey = trackedKeys[i];
        }
      }
      if (evictKey !== null) {
        delete failedLoginTracker[evictKey];
      }
    }
    entry = {
      firstAttempt: now,
      failedAttempts: 0,
      blockedUntil: 0,
      lastSeen: now,
    };
    failedLoginTracker[key] = entry;
  }
  entry.lastSeen = now;
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
  entry.lastSeen = now;
  entry.failedAttempts += 1;
  if (entry.failedAttempts >= settings.maxAttempts) {
    entry.blockedUntil = now + settings.blockMs;
    entry.failedAttempts = 0;
    entry.firstAttempt = now;
  }
}

// test hooks (not part of the runtime API)
function _resetTrackerForTests() {
  var keys = Object.keys(failedLoginTracker);
  for (var i = 0; i < keys.length; i++) {
    delete failedLoginTracker[keys[i]];
  }
}
function _setMaxTrackedKeysForTests(n) {
  MAX_TRACKED_KEYS = typeof n === 'number' && n > 0 ? n : DEFAULT_MAX_TRACKED_KEYS;
}
function _trackedKeyCountForTests() {
  return Object.keys(failedLoginTracker).length;
}

module.exports = {
  _resetTrackerForTests,
  _setMaxTrackedKeysForTests,
  _trackedKeyCountForTests,
  getClientIP,
  getAttemptKey,
  getTrackerEntry,
  clearTrackerEntry,
  isBlocked,
  registerFailedAttempt,
};
