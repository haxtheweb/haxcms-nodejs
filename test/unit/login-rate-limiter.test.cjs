'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getClientIP,
  getAttemptKey,
  getTrackerEntry,
  clearTrackerEntry,
  isBlocked,
  registerFailedAttempt,
} = require('../../src/lib/loginRateLimiter.js')

// Unique key generator so each test gets its own tracker entry
// and tests never interfere with one another via the shared in-memory store.
let keyCounter = 0
function uniqueKey() {
  keyCounter += 1
  return 'test-key-' + keyCounter + '-' + Date.now()
}

test('getClientIP returns req.ip when present', () => {
  assert.equal(getClientIP({ ip: '1.2.3.4' }), '1.2.3.4')
  assert.equal(getClientIP({ ip: '::1' }), '::1')
})

test('getClientIP prefers req.ip over connection.remoteAddress', () => {
  assert.equal(
    getClientIP({ ip: '1.2.3.4', connection: { remoteAddress: '5.6.7.8' } }),
    '1.2.3.4',
  )
})

test('getClientIP falls back to connection.remoteAddress when req.ip absent', () => {
  assert.equal(
    getClientIP({ connection: { remoteAddress: '5.6.7.8' } }),
    '5.6.7.8',
  )
})

test('getClientIP returns unknown when no IP source is available', () => {
  assert.equal(getClientIP({}), 'unknown')
  assert.equal(getClientIP(null), 'unknown')
  assert.equal(getClientIP(undefined), 'unknown')
})

test('getAttemptKey joins IP and username with double-colon separator', () => {
  assert.equal(getAttemptKey({ ip: '1.2.3.4' }, 'admin'), '1.2.3.4::admin')
  assert.equal(getAttemptKey({ ip: '1.2.3.4' }, ''), '1.2.3.4::')
  assert.equal(getAttemptKey({ ip: '1.2.3.4' }, null), '1.2.3.4::')
  assert.equal(getAttemptKey({ ip: '1.2.3.4' }, undefined), '1.2.3.4::')
  assert.equal(getAttemptKey({}, 'admin'), 'unknown::admin')
})

test('first N failed attempts do not trigger a block', () => {
  const settings = { windowMs: 60000, maxAttempts: 3, blockMs: 300000 }
  const key = uniqueKey()
  const now = 1000
  try {
    const entry = getTrackerEntry(key, now, settings)
    assert.ok(!isBlocked(entry, now))

    registerFailedAttempt(entry, now, settings)
    assert.ok(!isBlocked(entry, now))

    registerFailedAttempt(entry, now, settings)
    assert.ok(!isBlocked(entry, now))
  } finally {
    clearTrackerEntry(key)
  }
})

test('the Nth failed attempt within the window triggers a block', () => {
  const settings = { windowMs: 60000, maxAttempts: 3, blockMs: 300000 }
  const key = uniqueKey()
  const now = 1000
  try {
    const entry = getTrackerEntry(key, now, settings)
    registerFailedAttempt(entry, now, settings)
    registerFailedAttempt(entry, now, settings)
    registerFailedAttempt(entry, now, settings)

    assert.ok(isBlocked(entry, now))
    // blockedUntil should be now + blockMs = 1000 + 300000 = 301000
    assert.equal(entry.blockedUntil, 301000)
  } finally {
    clearTrackerEntry(key)
  }
})

test('block persists until blockMs elapses then expires', () => {
  const settings = { windowMs: 60000, maxAttempts: 2, blockMs: 5000 }
  const key = uniqueKey()
  const now = 1000
  try {
    const entry = getTrackerEntry(key, now, settings)
    registerFailedAttempt(entry, now, settings)
    registerFailedAttempt(entry, now, settings)

    // blockedUntil = 1000 + 5000 = 6000
    assert.ok(isBlocked(entry, 1000))
    assert.ok(isBlocked(entry, 5999))
    assert.ok(!isBlocked(entry, 6000))
    assert.ok(!isBlocked(entry, 6001))
  } finally {
    clearTrackerEntry(key)
  }
})

test('window reset after time advances clears the attempt counter', () => {
  const settings = { windowMs: 1000, maxAttempts: 2, blockMs: 10000 }
  const key = uniqueKey()
  const now = 1000
  try {
    const entry = getTrackerEntry(key, now, settings)
    registerFailedAttempt(entry, now, settings)
    registerFailedAttempt(entry, now, settings)
    assert.ok(isBlocked(entry, now))

    // Advance past both block and window: blockMs=10000, windowMs=1000
    // At t=11001 the block has expired (blockedUntil=11000 <= 11001)
    // and the window has elapsed (11001 - 1000 > 1000).
    const later = 11001
    const refreshed = getTrackerEntry(key, later, settings)
    assert.ok(!isBlocked(refreshed, later))
    assert.equal(refreshed.failedAttempts, 0)
    assert.equal(refreshed.blockedUntil, 0)

    // A single new attempt should not re-trigger the block
    registerFailedAttempt(refreshed, later, settings)
    assert.ok(!isBlocked(refreshed, later))
    assert.equal(refreshed.failedAttempts, 1)
  } finally {
    clearTrackerEntry(key)
  }
})

test('window reset does not clear an active block that has not yet expired', () => {
  const settings = { windowMs: 1000, maxAttempts: 2, blockMs: 10000 }
  const key = uniqueKey()
  const now = 1000
  try {
    const entry = getTrackerEntry(key, now, settings)
    registerFailedAttempt(entry, now, settings)
    registerFailedAttempt(entry, now, settings)
    // blockedUntil = 1000 + 10000 = 11000

    // Advance past the window (1000ms) but NOT past the block (10000ms).
    // At t=2500 the window has elapsed but the block is still active.
    const later = 2500
    const refreshed = getTrackerEntry(key, later, settings)
    assert.ok(isBlocked(refreshed, later))
    assert.equal(refreshed.blockedUntil, 11000)
  } finally {
    clearTrackerEntry(key)
  }
})

test('clearTrackerEntry removes the entry so a new one starts fresh', () => {
  const settings = { windowMs: 60000, maxAttempts: 2, blockMs: 300000 }
  const key = uniqueKey()
  const now = 1000
  try {
    const entry = getTrackerEntry(key, now, settings)
    registerFailedAttempt(entry, now, settings)
    registerFailedAttempt(entry, now, settings)
    assert.ok(isBlocked(entry, now))

    clearTrackerEntry(key)

    const fresh = getTrackerEntry(key, now, settings)
    assert.equal(fresh.failedAttempts, 0)
    assert.equal(fresh.blockedUntil, 0)
    assert.ok(!isBlocked(fresh, now))
  } finally {
    clearTrackerEntry(key)
  }
})

test('isBlocked returns a falsy value for null, empty, or zero-blockedUntil entries', () => {
  assert.ok(!isBlocked(null, 1000))
  assert.ok(!isBlocked(undefined, 1000))
  assert.ok(!isBlocked({}, 1000))
  assert.ok(!isBlocked({ blockedUntil: 0 }, 1000))
})

test('isBlocked returns a truthy value only when blockedUntil is in the future', () => {
  assert.ok(isBlocked({ blockedUntil: 2000 }, 1000))
  assert.ok(!isBlocked({ blockedUntil: 1000 }, 1000))
  assert.ok(!isBlocked({ blockedUntil: 999 }, 1000))
})

test('registerFailedAttempt resets counter after triggering a block', () => {
  const settings = { windowMs: 60000, maxAttempts: 2, blockMs: 300000 }
  const key = uniqueKey()
  const now = 1000
  try {
    const entry = getTrackerEntry(key, now, settings)
    registerFailedAttempt(entry, now, settings)
    registerFailedAttempt(entry, now, settings)

    // After the block triggers, the counter resets to 0
    assert.equal(entry.failedAttempts, 0)
    assert.equal(entry.blockedUntil, 301000)
    assert.equal(entry.firstAttempt, 1000)
  } finally {
    clearTrackerEntry(key)
  }
})

// ---------------------------------------------------------------------------
// Security (SEC-SESSION): eviction at the tracked-key cap must never drop an
// entry that is still actively blocking, so an attacker cannot flood fresh
// usernames/IPs to push their own blocked entry out and reset the block.
// ---------------------------------------------------------------------------
const limiter = require('../../src/lib/loginRateLimiter.js')
// shrink the cap so the flood tests stay fast; restored in each finally
const CAP = 50

test('flooding the tracker at the cap never evicts an actively blocked entry', () => {
  limiter._resetTrackerForTests()
  limiter._setMaxTrackedKeysForTests(CAP)
  const settings = { windowMs: 60000, maxAttempts: 2, blockMs: 300000 }
  const now = 5000000
  const victimKey = 'attacker-ip::admin'
  try {
    // block the attacker's own key first so it has the OLDEST firstAttempt
    const blocked = getTrackerEntry(victimKey, now, settings)
    registerFailedAttempt(blocked, now, settings)
    registerFailedAttempt(blocked, now, settings)
    assert.ok(isBlocked(blocked, now))
    // flood well past the cap with fresh keys (all inside the window)
    for (let i = 0; i < CAP + 50; i++) {
      getTrackerEntry('flood-' + i, now + 1 + i, settings)
    }
    const after = getTrackerEntry(victimKey, now + 20000, settings)
    assert.ok(isBlocked(after, now + 20000), 'the block survived the flood')
    assert.equal(after, blocked, 'the original entry object is still tracked')
    assert.ok(limiter._trackedKeyCountForTests() <= CAP)
  }
  finally {
    limiter._resetTrackerForTests()
    limiter._setMaxTrackedKeysForTests()
  }
})

test('at the cap the least-recently-seen non-blocked entry is evicted first', () => {
  limiter._resetTrackerForTests()
  limiter._setMaxTrackedKeysForTests(CAP)
  const settings = { windowMs: 600000, maxAttempts: 5, blockMs: 300000 }
  const now = 9000000
  try {
    for (let i = 0; i < CAP; i++) {
      getTrackerEntry('fill-' + i, now + i, settings)
    }
    // touch the oldest entry so it becomes recently seen
    getTrackerEntry('fill-0', now + CAP + 1, settings)
    // adding one more key must evict fill-1 (least recently seen), not fill-0
    getTrackerEntry('newcomer', now + CAP + 2, settings)
    assert.equal(limiter._trackedKeyCountForTests(), CAP)
    const fill0 = getTrackerEntry('fill-0', now + CAP + 3, settings)
    assert.equal(fill0.firstAttempt, now, 'fill-0 kept its original entry')
    const fill1 = getTrackerEntry('fill-1', now + CAP + 4, settings)
    assert.equal(fill1.firstAttempt, now + CAP + 4, 'fill-1 was evicted and recreated')
  }
  finally {
    limiter._resetTrackerForTests()
    limiter._setMaxTrackedKeysForTests()
  }
})

test('when every tracked entry is blocked the cap is soft and nothing is evicted', () => {
  limiter._resetTrackerForTests()
  limiter._setMaxTrackedKeysForTests(CAP)
  const settings = { windowMs: 60000, maxAttempts: 1, blockMs: 300000 }
  const now = 12000000
  try {
    for (let i = 0; i < CAP; i++) {
      const e = getTrackerEntry('blocked-' + i, now, settings)
      registerFailedAttempt(e, now, settings)
    }
    getTrackerEntry('one-more', now + 1, settings)
    assert.equal(limiter._trackedKeyCountForTests(), CAP + 1)
    assert.ok(isBlocked(getTrackerEntry('blocked-0', now + 2, settings), now + 2))
  }
  finally {
    limiter._resetTrackerForTests()
    limiter._setMaxTrackedKeysForTests()
  }
})
