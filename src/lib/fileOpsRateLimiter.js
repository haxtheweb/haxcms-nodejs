// Shared in-memory rate limiter for authenticated file-mutation operations
// (createFile / updateFile / deleteFile). Throttles a single authenticated
// principal keyed by userName:siteName so a compromised account or stolen
// site token cannot drive unbounded upload (disk-fill) or image-op (CPU)
// traffic. Matches the threat model in the file-operations security report
// (F3): every operation is already auth-gated to a validated user:site token,
// so the principal is authoritative (not spoofable); IP is a weak key here
// (127.0.0.1 on local/DDEV installs, shared behind NAT), hence userName:site.
//
// Count-window semantics (distinct from the failed-credit-block semantics of
// loginRateLimiter): every call counts as one attempt; when attempts exceed
// `max` within `windowMs`, the key is blocked for `blockMs` and subsequent
// calls return 429 until the block lapses; the window then resets. The
// over-threshold call itself is blocked (returns true from registerAttempt).
//
// Security: the store is process-local and in-memory, capped at
// MAX_TRACKED_KEYS with lazy pruning + oldest-eviction, mirroring
// loginRateLimiter.js. For multi-instance Node deployments a Redis-backed
// store can be dropped in behind the same API; PHP uses a cache-backed
// multi-process limiter for parity reference. Defaults (500/5min) accommodate
// a realistic front-end bulk upload (N sequential single-file ops) while
// bounding runaway loops / scripted abuse.
const fileOpsTracker = {};
const MAX_TRACKED_KEYS = 10000;

function pruneExpiredEntries(now, settings) {
  var keys = Object.keys(fileOpsTracker);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var entry = fileOpsTracker[key];
    if (!entry) {
      continue;
    }
    if (entry.blockedUntil <= now && (now - entry.firstAttempt) > settings.windowMs) {
      delete fileOpsTracker[key];
    }
  }
}

function getRateKey(userName, siteName) {
  return String(userName || '') + '::' + String(siteName || '');
}

function getTrackerEntry(key, now, settings) {
  let entry = fileOpsTracker[key];
  if (!entry) {
    pruneExpiredEntries(now, settings);
    var trackedKeys = Object.keys(fileOpsTracker);
    if (trackedKeys.length >= MAX_TRACKED_KEYS) {
      var oldestKey = trackedKeys[0];
      var oldestTime = fileOpsTracker[trackedKeys[0]].firstAttempt;
      for (var i = 1; i < trackedKeys.length; i++) {
        if (fileOpsTracker[trackedKeys[i]].firstAttempt < oldestTime) {
          oldestKey = trackedKeys[i];
          oldestTime = fileOpsTracker[trackedKeys[i]].firstAttempt;
        }
      }
      delete fileOpsTracker[oldestKey];
    }
    entry = {
      firstAttempt: now,
      attempts: 0,
      blockedUntil: 0,
    };
    fileOpsTracker[key] = entry;
  }
  if (now - entry.firstAttempt > settings.windowMs) {
    entry.firstAttempt = now;
    entry.attempts = 0;
    if (entry.blockedUntil <= now) {
      entry.blockedUntil = 0;
    }
  }
  return entry;
}

function isBlocked(entry, now) {
  return !!(entry && entry.blockedUntil && entry.blockedUntil > now);
}

// Register one attempt. Returns true when the caller should be BLOCKED (429),
// false when the caller may proceed. Sets blockedUntil when this attempt
// crosses the max threshold.
function registerAttempt(entry, now, settings) {
  entry.attempts += 1;
  if (entry.attempts > settings.max) {
    entry.blockedUntil = now + settings.blockMs;
    entry.attempts = 0;
    entry.firstAttempt = now;
    return true;
  }
  return false;
}

function getRetryAfterSeconds(entry, now) {
  if (!entry || !entry.blockedUntil || entry.blockedUntil <= now) {
    return 0;
  }
  return Math.ceil((entry.blockedUntil - now) / 1000);
}

// Build a human-readable 429 message that states WHY (file-op rate limit for
// this site), the configured limit (max per window), and WHEN the caller can
// retry (derived from retryAfterSeconds). Both the limit and the retry time
// are dynamic so the message stays accurate when an operator overrides the
// defaults via config.security.fileOpsRateLimit.
function buildRateLimitMessage(settings, retryAfterSeconds) {
  var windowMinutes = Math.max(1, Math.round(settings.windowMs / 60000));
  var windowLabel = windowMinutes + ' minute' + (windowMinutes !== 1 ? 's' : '');
  var seconds = Math.max(1, retryAfterSeconds);
  var retryLabel;
  if (seconds >= 60) {
    var retryMinutes = Math.ceil(seconds / 60);
    retryLabel = retryMinutes + ' minute' + (retryMinutes !== 1 ? 's' : '');
  } else {
    retryLabel = seconds + ' second' + (seconds !== 1 ? 's' : '');
  }
  return 'File operation rate limit reached: ' + settings.max + ' operations per ' + windowLabel + ' for this site. You can retry in ' + retryLabel + '.';
}

// Test-only: clear the in-memory store so unit tests start from a known state.
function resetForTesting() {
  var keys = Object.keys(fileOpsTracker);
  for (var i = 0; i < keys.length; i++) {
    delete fileOpsTracker[keys[i]];
  }
}

module.exports = {
  getRateKey,
  getTrackerEntry,
  isBlocked,
  registerAttempt,
  getRetryAfterSeconds,
  buildRateLimitMessage,
  resetForTesting,
};
