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

// Last activity timestamp for an entry (falls back to firstAttempt for entries
// created before lastAttempt was tracked).
function getLastActivity(entry) {
  if (entry && typeof entry.lastAttempt === 'number') {
    return entry.lastAttempt;
  }
  return entry ? entry.firstAttempt : 0;
}

// Security (HAX-SEC-003, review 2026-10): an entry is expired once it is not
// blocking AND it has been idle longer than the attempt window (mirrors the PHP
// cache TTL of window + block + 60s, measured from the last write). Never
// drops an entry that is still actively blocking.
function isExpiredEntry(entry, now, settings) {
  if (!entry) {
    return true;
  }
  if (entry.blockedUntil && entry.blockedUntil > now) {
    return false;
  }
  return (now - getLastActivity(entry)) > settings.windowMs;
}

function pruneExpiredEntries(now, settings) {
  var keys = Object.keys(failedLoginTracker);
  for (var i = 0; i < keys.length; i++) {
    if (isExpiredEntry(failedLoginTracker[keys[i]], now, settings)) {
      delete failedLoginTracker[keys[i]];
    }
  }
}

// Security (review 2026-10): make room for a new key. Previously the entry with
// the lowest firstAttempt was evicted regardless of blockedUntil (and blocking
// resets firstAttempt), so 10000 junk usernames from one IP evicted a blocked
// ip::admin entry and unblocked it. Now: expired entries are pruned first; if
// still at capacity the least-recently-active NON-blocked entry is evicted. A
// blocked entry is never evicted — if every tracked entry is blocked the map is
// allowed to exceed the cap (blocked entries self-expire after blockMs), which
// mirrors PHP login.php where blocked cache entries are never evicted early.
function makeRoomForNewEntry(now, settings) {
  pruneExpiredEntries(now, settings);
  var trackedKeys = Object.keys(failedLoginTracker);
  if (trackedKeys.length < MAX_TRACKED_KEYS) {
    return;
  }
  var evictKey = null;
  var evictTime = Infinity;
  for (var i = 0; i < trackedKeys.length; i++) {
    var entry = failedLoginTracker[trackedKeys[i]];
    if (entry && entry.blockedUntil && entry.blockedUntil > now) {
      continue;
    }
    var lastActivity = getLastActivity(entry);
    if (lastActivity < evictTime) {
      evictKey = trackedKeys[i];
      evictTime = lastActivity;
    }
  }
  if (evictKey !== null) {
    delete failedLoginTracker[evictKey];
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
    // Security (HAX-SEC-003): prune expired entries and enforce a cap on
    // total tracked keys to bound memory. An attacker rotating usernames/IPs
    // could otherwise grow failedLoginTracker without limit (DoS).
    makeRoomForNewEntry(now, settings);
    entry = {
      firstAttempt: now,
      lastAttempt: now,
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
  entry.lastAttempt = now;
  entry.failedAttempts += 1;
  if (entry.failedAttempts >= settings.maxAttempts) {
    entry.blockedUntil = now + settings.blockMs;
    entry.failedAttempts = 0;
    entry.firstAttempt = now;
  }
}

module.exports = {
  MAX_TRACKED_KEYS,
  getClientIP,
  getAttemptKey,
  getTrackerEntry,
  clearTrackerEntry,
  isBlocked,
  registerFailedAttempt,
};
