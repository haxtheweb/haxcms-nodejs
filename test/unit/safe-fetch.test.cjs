'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const dns = require('dns')
const http = require('http')
const { EventEmitter } = require('events')

const {
  safeFetch,
  assertUrlNotSSRF,
  isPrivateOrReservedIP,
  validateUrlNotSSRF,
} = require('../../src/lib/safeFetch.js')

// --- system-boundary mocking helpers ----------------------------------------
// Only dns.promises.lookup and http.request are stubbed (network boundaries).
// The module under test and its sibling lib modules are never mocked.

function useLookup(t, fn) {
  var prev = dns.promises.lookup
  dns.promises.lookup = fn
  t.after(function () { dns.promises.lookup = prev })
}

function lookupRecords(records) {
  return async function () { return records }
}

function lookupThrow(err) {
  return async function () { throw err }
}

// Build a deterministic http.request stub that replays `specs` in order
// (last spec repeats). Returns the captured request-options array so a test
// can assert pinning/headers without making a real connection.
function useHttpSequence(t, specs) {
  var prev = http.request
  var calls = []
  http.request = function (options, cb) {
    calls.push(options)
    var spec = specs[Math.min(calls.length - 1, specs.length - 1)]
    var req = new EventEmitter()
    req.write = function () {}
    req.destroy = function () {}
    req.end = function () {
      process.nextTick(function () {
        var res = new EventEmitter()
        res.statusCode = spec.status
        res.statusMessage = spec.statusText || ''
        res.headers = spec.headers || {}
        cb(res)
        process.nextTick(function () {
          if (spec.body) { res.emit('data', Buffer.from(spec.body)) }
          res.emit('end')
        })
      })
    }
    return req
  }
  t.after(function () { http.request = prev })
  return calls
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, function (err) {
    assert.equal(err.code, code)
    return true
  })
}

// --- isPrivateOrReservedIP: pure predicate, no mocks ------------------------

test('isPrivateOrReservedIP flags IPv4 loopback (127.0.0.0/8)', () => {
  assert.equal(isPrivateOrReservedIP('127.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('127.255.255.255'), true)
  assert.equal(isPrivateOrReservedIP('127.0.0.0'), true)
})

test('isPrivateOrReservedIP flags IPv6 loopback and unspecified', () => {
  assert.equal(isPrivateOrReservedIP('::1'), true)
  assert.equal(isPrivateOrReservedIP('0:0:0:0:0:0:0:1'), true)
  assert.equal(isPrivateOrReservedIP('::'), true)
})

test('isPrivateOrReservedIP flags 0.0.0.0', () => {
  assert.equal(isPrivateOrReservedIP('0.0.0.0'), true)
})

test('isPrivateOrReservedIP flags 10.0.0.0/8 private', () => {
  assert.equal(isPrivateOrReservedIP('10.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('10.255.255.255'), true)
})

test('isPrivateOrReservedIP flags 192.168.0.0/16 private', () => {
  assert.equal(isPrivateOrReservedIP('192.168.1.1'), true)
  assert.equal(isPrivateOrReservedIP('192.168.0.0'), true)
})

test('isPrivateOrReservedIP flags 172.16.0.0/12 private at exact boundaries', () => {
  assert.equal(isPrivateOrReservedIP('172.16.0.1'), true)
  assert.equal(isPrivateOrReservedIP('172.31.255.255'), true)
  // just outside the /12
  assert.equal(isPrivateOrReservedIP('172.15.0.1'), false)
  assert.equal(isPrivateOrReservedIP('172.32.0.1'), false)
  assert.equal(isPrivateOrReservedIP('172.0.0.1'), false)
})

test('isPrivateOrReservedIP flags 169.254.0.0/16 link-local and cloud metadata', () => {
  assert.equal(isPrivateOrReservedIP('169.254.169.254'), true)
  assert.equal(isPrivateOrReservedIP('169.254.0.1'), true)
  // just outside the link-local range
  assert.equal(isPrivateOrReservedIP('169.253.0.1'), false)
  assert.equal(isPrivateOrReservedIP('169.255.0.1'), false)
})

test('isPrivateOrReservedIP flags 100.64.0.0/10 carrier-grade NAT at exact boundaries', () => {
  assert.equal(isPrivateOrReservedIP('100.64.0.1'), true)
  assert.equal(isPrivateOrReservedIP('100.127.255.255'), true)
  // just outside the CGNAT range
  assert.equal(isPrivateOrReservedIP('100.63.0.1'), false)
  assert.equal(isPrivateOrReservedIP('100.128.0.1'), false)
  assert.equal(isPrivateOrReservedIP('100.0.0.1'), false)
})

test('isPrivateOrReservedIP flags IPv6 unique-local fc00::/7 and link-local fe80::/10', () => {
  assert.equal(isPrivateOrReservedIP('fd00::1'), true)
  assert.equal(isPrivateOrReservedIP('fc00::1'), true)
  assert.equal(isPrivateOrReservedIP('fe80::1'), true)
})

test('isPrivateOrReservedIP normalizes IPv4-mapped IPv6 (::ffff:a.b.c.d)', () => {
  assert.equal(isPrivateOrReservedIP('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('::ffff:169.254.169.254'), true)
  assert.equal(isPrivateOrReservedIP('::ffff:8.8.8.8'), false)
})

test('isPrivateOrReservedIP normalizes IPv4-compatible IPv6 (::a.b.c.d)', () => {
  assert.equal(isPrivateOrReservedIP('::127.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('::8.8.8.8'), false)
})

test('isPrivateOrReservedIP returns false for public IPv4 and IPv6', () => {
  assert.equal(isPrivateOrReservedIP('8.8.8.8'), false)
  assert.equal(isPrivateOrReservedIP('1.1.1.1'), false)
  assert.equal(isPrivateOrReservedIP('93.184.216.34'), false)
  assert.equal(isPrivateOrReservedIP('2001:4860:4860::8888'), false)
  assert.equal(isPrivateOrReservedIP('2606:4700:4700::1111'), false)
})

test('isPrivateOrReservedIP treats non-string and empty input as private (fail-closed)', () => {
  assert.equal(isPrivateOrReservedIP(undefined), true)
  assert.equal(isPrivateOrReservedIP(null), true)
  assert.equal(isPrivateOrReservedIP(123), true)
  assert.equal(isPrivateOrReservedIP(''), true)
})

test('isPrivateOrReservedIP returns false for a non-IP string with no private prefix', () => {
  // 'garbage' has no ':' and no private IPv4 prefix, so it falls through to
  // the IPv4 prefix checks and matches none -> false (not treated as private).
  assert.equal(isPrivateOrReservedIP('garbage'), false)
})

// --- assertUrlNotSSRF: dns mocked at the boundary ---------------------------

test('assertUrlNotSSRF rejects an invalid URL with SSRF_INVALID_URL', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('not a url'), 'SSRF_INVALID_URL')
})

test('assertUrlNotSSRF rejects ftp: scheme with SSRF_PROTOCOL', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('ftp://example.com/x'), 'SSRF_PROTOCOL')
})

test('assertUrlNotSSRF rejects file: scheme with SSRF_PROTOCOL', async (t) => {
  // file: URLs parse with an empty hostname, but the protocol check runs first
  // and rejects before the hostname check is reached.
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('file:///etc/passwd'), 'SSRF_PROTOCOL')
})

test('assertUrlNotSSRF rejects a hostname that resolves to 127.0.0.1 with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '127.0.0.1', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://internal.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a hostname that resolves to ::1 with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '::1', family: 6 }]))
  await rejectsCode(assertUrlNotSSRF('http://v6loop.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a hostname that resolves to 10.x with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '10.0.0.1', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://internal.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a hostname that resolves to 172.16-31.x with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '172.16.0.1', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://internal.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a hostname that resolves to 192.168.x with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '192.168.1.1', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://internal.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a hostname that resolves to 169.254.x link-local with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '169.254.0.1', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://linklocal.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a hostname that resolves to cloud metadata 169.254.169.254 with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '169.254.169.254', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://metadata.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a hostname that resolves to IPv4-mapped IPv6 ::ffff:127.0.0.1 with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '::ffff:127.0.0.1', family: 6 }]))
  await rejectsCode(assertUrlNotSSRF('http://mapped.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects when ANY resolved record is private (round-robin)', async (t) => {
  useLookup(t, lookupRecords([
    { address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]))
  await rejectsCode(assertUrlNotSSRF('http://rb.test/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects with SSRF_DNS when dns.lookup throws', async (t) => {
  var err = new Error('getaddrinfo ENOTFOUND nope.test')
  err.code = 'ENOTFOUND'
  useLookup(t, lookupThrow(err))
  await rejectsCode(assertUrlNotSSRF('http://nope.test/'), 'SSRF_DNS')
})

test('assertUrlNotSSRF rejects with SSRF_DNS when dns.lookup returns no records', async (t) => {
  useLookup(t, lookupRecords([]))
  await rejectsCode(assertUrlNotSSRF('http://empty.test/'), 'SSRF_DNS')
})

test('assertUrlNotSSRF resolves to the parsed URL for a public hostname', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  var parsed = await assertUrlNotSSRF('http://example.com/path?q=1')
  assert.equal(parsed.hostname, 'example.com')
  assert.equal(parsed.pathname, '/path')
  assert.equal(parsed.search, '?q=1')
})

test('assertUrlNotSSRF rejects a literal IPv4 loopback hostname with SSRF_PRIVATE', async (t) => {
  // dns.lookup of a literal IPv4 returns that IPv4 verbatim (no network),
  // so the private-IP check sees 127.0.0.1 and rejects.
  useLookup(t, lookupRecords([{ address: '127.0.0.1', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://127.0.0.1/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF rejects a literal cloud-metadata IPv4 hostname with SSRF_PRIVATE', async (t) => {
  useLookup(t, lookupRecords([{ address: '169.254.169.254', family: 4 }]))
  await rejectsCode(assertUrlNotSSRF('http://169.254.169.254/'), 'SSRF_PRIVATE')
})

test('assertUrlNotSSRF on http://[::1]/ rejects with SSRF_DNS (bracketed IPv6 literal)', async (t) => {
  // Node's dns.promises.lookup does not strip the brackets from a URL hostname
  // like "[::1]", so a real lookup throws ENOTFOUND and the URL is rejected via
  // SSRF_DNS rather than the SSRF_PRIVATE path. It is still rejected (safe),
  // just via the DNS-failure code.
  var err = new Error('getaddrinfo ENOTFOUND [::1]')
  err.code = 'ENOTFOUND'
  useLookup(t, lookupThrow(err))
  await rejectsCode(assertUrlNotSSRF('http://[::1]/'), 'SSRF_DNS')
})

// --- validateUrlNotSSRF: boolean version, dns mocked ------------------------

test('validateUrlNotSSRF returns false for an invalid URL', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  assert.equal(await validateUrlNotSSRF('not a url'), false)
})

test('validateUrlNotSSRF returns false for ftp: scheme', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  assert.equal(await validateUrlNotSSRF('ftp://example.com/x'), false)
})

test('validateUrlNotSSRF returns false for file: scheme', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  assert.equal(await validateUrlNotSSRF('file:///etc/passwd'), false)
})

test('validateUrlNotSSRF returns false when a record resolves to 127.0.0.1', async (t) => {
  useLookup(t, lookupRecords([{ address: '127.0.0.1', family: 4 }]))
  assert.equal(await validateUrlNotSSRF('http://internal.test/'), false)
})

test('validateUrlNotSSRF returns false when a record resolves to cloud metadata', async (t) => {
  useLookup(t, lookupRecords([{ address: '169.254.169.254', family: 4 }]))
  assert.equal(await validateUrlNotSSRF('http://metadata.test/'), false)
})

test('validateUrlNotSSRF returns false on round-robin public+private records', async (t) => {
  useLookup(t, lookupRecords([
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]))
  assert.equal(await validateUrlNotSSRF('http://rb.test/'), false)
})

test('validateUrlNotSSRF returns false when dns.lookup throws', async (t) => {
  var err = new Error('getaddrinfo ENOTFOUND nope.test')
  err.code = 'ENOTFOUND'
  useLookup(t, lookupThrow(err))
  assert.equal(await validateUrlNotSSRF('http://nope.test/'), false)
})

test('validateUrlNotSSRF returns false when dns.lookup returns no records', async (t) => {
  useLookup(t, lookupRecords([]))
  assert.equal(await validateUrlNotSSRF('http://empty.test/'), false)
})

test('validateUrlNotSSRF returns true for a public http hostname', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  assert.equal(await validateUrlNotSSRF('http://example.com/'), true)
})

test('validateUrlNotSSRF returns true for a public https hostname', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  assert.equal(await validateUrlNotSSRF('https://example.com/'), true)
})

// --- safeFetch: SSRF propagation (no http mock needed; check throws first) ---

test('safeFetch propagates SSRF_PRIVATE when the target resolves to a private IP', async (t) => {
  useLookup(t, lookupRecords([{ address: '127.0.0.1', family: 4 }]))
  await rejectsCode(safeFetch('http://internal.test/', {}), 'SSRF_PRIVATE')
})

test('safeFetch propagates SSRF_PROTOCOL for an ftp: URL', async () => {
  await rejectsCode(safeFetch('ftp://example.com/x', {}), 'SSRF_PROTOCOL')
})

test('safeFetch propagates SSRF_INVALID_URL for a malformed URL', async () => {
  await rejectsCode(safeFetch('not a url', {}), 'SSRF_INVALID_URL')
})

test('safeFetch propagates SSRF_DNS when dns.lookup throws', async (t) => {
  var err = new Error('getaddrinfo ENOTFOUND nope.test')
  err.code = 'ENOTFOUND'
  useLookup(t, lookupThrow(err))
  await rejectsCode(safeFetch('http://nope.test/', {}), 'SSRF_DNS')
})

// --- safeFetch: successful fetch + IP pinning --------------------------------

test('safeFetch returns a fetch-like response and pins TCP to the validated IP', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  var calls = useHttpSequence(t, [
    { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: 'hello world' },
  ])
  var res = await safeFetch('http://target.test/path?q=1', {})
  assert.equal(res.status, 200)
  assert.equal(res.ok, true)
  assert.equal(res.statusText, 'OK')
  assert.equal(res.headers.get('content-type'), 'text/plain')
  assert.equal(await res.text(), 'hello world')
  // The TCP connection target is the SSRF-validated IP, not the hostname.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].host, '93.184.216.34')
  assert.equal(calls[0].path, '/path?q=1')
  // The Host header is forced back to the original hostname for vhosting/SNI.
  assert.equal(calls[0].headers.host, 'target.test')
})

test('safeFetch json() parses a JSON response body', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  useHttpSequence(t, [
    { status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1,"b":"x"}' },
  ])
  var res = await safeFetch('http://target.test/api', {})
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { a: 1, b: 'x' })
})

// --- safeFetch: redirect handling -------------------------------------------

test('safeFetch follows a single redirect and returns the final response', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  var calls = useHttpSequence(t, [
    { status: 302, statusText: 'Found', headers: { location: 'http://other.test/dest' } },
    { status: 200, statusText: 'OK', body: 'done' },
  ])
  var res = await safeFetch('http://target.test/', {})
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'done')
  assert.equal(calls.length, 2)
})

test('safeFetch throws SSRF_REDIRECTS after exceeding the 5-redirect cap', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  var calls = useHttpSequence(t, [
    { status: 302, statusText: 'Found', headers: { location: 'http://target.test/loop' } },
  ])
  await rejectsCode(safeFetch('http://target.test/', {}), 'SSRF_REDIRECTS')
  // 5 max redirects => 6 total hops (hop 0..5) before giving up on hop 5.
  assert.equal(calls.length, 6)
})

test('safeFetch throws SSRF_REDIRECT for an invalid Location header', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  useHttpSequence(t, [
    { status: 302, statusText: 'Found', headers: { location: 'http://[' } },
  ])
  await rejectsCode(safeFetch('http://target.test/', {}), 'SSRF_REDIRECT')
})

test('safeFetch returns a 3xx response as-is when it has no Location header', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  useHttpSequence(t, [
    { status: 304, statusText: 'Not Modified', headers: {} },
  ])
  var res = await safeFetch('http://target.test/', {})
  assert.equal(res.status, 304)
})

test('safeFetch re-validates each redirect hop and rejects a hop to a private IP', async (t) => {
  // First hop resolves to a public IP and returns a redirect to internal.test;
  // the second hop resolves to a private IP and must be rejected mid-chain.
  var lookupMap = {
    'target.test': [{ address: '93.184.216.34', family: 4 }],
    'internal.test': [{ address: '10.0.0.1', family: 4 }],
  }
  useLookup(t, async function (hostname) { return lookupMap[hostname] })
  useHttpSequence(t, [
    { status: 302, statusText: 'Found', headers: { location: 'http://internal.test/secret' } },
  ])
  await rejectsCode(safeFetch('http://target.test/', {}), 'SSRF_PRIVATE')
})

test('safeFetch does not follow a 3xx that is actually a non-redirect (304 Not Modified)', async (t) => {
  useLookup(t, lookupRecords([{ address: '93.184.216.34', family: 4 }]))
  var calls = useHttpSequence(t, [
    { status: 304, statusText: 'Not Modified', headers: {} },
  ])
  var res = await safeFetch('http://target.test/', {})
  assert.equal(res.status, 304)
  assert.equal(calls.length, 1)
})
