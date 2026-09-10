'use strict'

// Security (F3) unit tests for the file-operations count-window rate limiter
// (src/lib/fileOpsRateLimiter.js). Proves: under-limit calls proceed, the
// over-threshold call is blocked, subsequent calls stay blocked until blockMs
// lapses, the window resets after windowMs, and the key is userName:siteName
// (so different sites/principals are independent).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const limiter = require('../../src/lib/fileOpsRateLimiter.js')

function settings(max, windowMs, blockMs) {
  return { enabled: true, windowMs: windowMs, max: max, blockMs: blockMs }
}

describe('fileOpsRateLimiter — count-window gating', () => {
  beforeEach(() => {
    limiter.resetForTesting()
  })

  test('getRateKey is userName::siteName', () => {
    assert.equal(limiter.getRateKey('alice', 'site-a'), 'alice::site-a')
    assert.equal(limiter.getRateKey('', ''), '::')
  })

  test('calls up to max are allowed; the max+1 call is blocked', () => {
    const s = settings(3, 60000, 5000)
    const now = 1000
    const key = limiter.getRateKey('alice', 'site-a')
    let entry = limiter.getTrackerEntry(key, now, s)
    assert.equal(limiter.isBlocked(entry, now), false)
    assert.equal(limiter.registerAttempt(entry, now, s), false) // 1
    assert.equal(limiter.registerAttempt(entry, now, s), false) // 2
    assert.equal(limiter.registerAttempt(entry, now, s), false) // 3 (== max, allowed)
    // 4th crosses max -> blocked on this call
    assert.equal(limiter.registerAttempt(entry, now, s), true)
  })

  test('once blocked, isBlocked stays true until blockMs lapses', () => {
    const s = settings(1, 60000, 5000)
    const now = 1000
    const key = limiter.getRateKey('alice', 'site-a')
    let entry = limiter.getTrackerEntry(key, now, s)
    assert.equal(limiter.registerAttempt(entry, now, s), false) // 1 (== max, allowed)
    assert.equal(limiter.registerAttempt(entry, now, s), true)  // 2 -> blocked
    assert.equal(limiter.isBlocked(entry, now + 1000), true)
    assert.equal(limiter.isBlocked(entry, now + 4999), true)
    assert.equal(limiter.isBlocked(entry, now + 5001), false) // blockMs elapsed
  })

  test('retry-after seconds are derived from blockedUntil', () => {
    const s = settings(1, 60000, 5000)
    const now = 1000
    const key = limiter.getRateKey('alice', 'site-a')
    let entry = limiter.getTrackerEntry(key, now, s)
    limiter.registerAttempt(entry, now, s) // allowed
    limiter.registerAttempt(entry, now, s) // blocked, blockedUntil = now + 5000
    assert.equal(limiter.getRetryAfterSeconds(entry, now + 0), 5)
    assert.equal(limiter.getRetryAfterSeconds(entry, now + 3000), 2)
    assert.equal(limiter.getRetryAfterSeconds(entry, now + 5001), 0)
  })

  test('window resets after windowMs elapses (fresh budget)', () => {
    const s = settings(2, 10000, 5000)
    const t0 = 1000
    const key = limiter.getRateKey('alice', 'site-a')
    let entry = limiter.getTrackerEntry(key, t0, s)
    limiter.registerAttempt(entry, t0, s) // 1
    limiter.registerAttempt(entry, t0, s) // 2 (== max)
    // after the window elapses (and no active block), getTrackerEntry resets
    const t1 = t0 + 10001
    entry = limiter.getTrackerEntry(key, t1, s)
    assert.equal(entry.attempts, 0)
    assert.equal(limiter.isBlocked(entry, t1), false)
  })

  test('distinct userName:siteName keys are independent', () => {
    const s = settings(1, 60000, 5000)
    const now = 1000
    const keyA = limiter.getRateKey('alice', 'site-a')
    const keyB = limiter.getRateKey('alice', 'site-b')
    let a = limiter.getTrackerEntry(keyA, now, s)
    let b = limiter.getTrackerEntry(keyB, now, s)
    limiter.registerAttempt(a, now, s) // alice/site-a 1 (allowed)
    limiter.registerAttempt(a, now, s) // alice/site-a 2 -> blocked, blockedUntil = now + 5000
    assert.equal(limiter.isBlocked(a, now), true)
    // alice/site-b is unaffected
    assert.equal(limiter.isBlocked(b, now), false)
    assert.equal(limiter.registerAttempt(b, now, s), false) // allowed
  })

  test('disabled settings: callers should not call register when disabled (handler gates), but module is inert', () => {
    // The handler short-circuits on settings.enabled === false; the module
    // itself has no enabled flag (callers decide). Verify registerAttempt with
    // a huge max never blocks for a small number of calls.
    const s = settings(1000, 60000, 5000)
    const now = 1000
    const key = limiter.getRateKey('alice', 'site-a')
    let entry = limiter.getTrackerEntry(key, now, s)
    for (let i = 0; i < 50; i++) {
      assert.equal(limiter.registerAttempt(entry, now, s), false)
    }
  })
})

describe('buildRateLimitMessage — states limit, window, and retry time', () => {
  test('formats the default-like settings (500/5min, 5min retry)', () => {
    const s = settings(500, 5 * 60 * 1000, 5 * 60 * 1000)
    const msg = limiter.buildRateLimitMessage(s, 300)
    assert.match(msg, /rate limit reached/)
    assert.match(msg, /500 operations per 5 minutes/)
    assert.match(msg, /retry in 5 minutes/)
  })

  test('formats seconds when retry is under a minute', () => {
    const s = settings(500, 5 * 60 * 1000, 5 * 60 * 1000)
    const msg = limiter.buildRateLimitMessage(s, 30)
    assert.match(msg, /retry in 30 seconds/)
  })

  test('uses singular "minute" for a 1-minute window', () => {
    const s = settings(3, 60 * 1000, 5000)
    const msg = limiter.buildRateLimitMessage(s, 5)
    assert.match(msg, /3 operations per 1 minute/)
    assert.match(msg, /retry in 5 seconds/)
  })

  test('includes "for this site" so the scope is clear', () => {
    const s = settings(500, 5 * 60 * 1000, 5 * 60 * 1000)
    const msg = limiter.buildRateLimitMessage(s, 300)
    assert.ok(msg.indexOf('for this site') !== -1)
  })
})
