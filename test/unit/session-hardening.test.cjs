'use strict'

// Regression tests for the session/auth hardening pass (security review
// 2026-10). Each block reproduces a verified exploit against the pre-fix code
// and asserts it is now closed:
//   1. session/connection-settings binds tokens to the authenticated principal
//   2. connection-settings no longer mutates HAXCMS.protocol/domain/request_url
//   3. refresh-token revocation is real (tombstones, no accept-and-seed)
//   4. login rate-limiter never evicts a blocked entry
//   5. session/connection-test + session/refresh same-origin (Sec-Fetch-Site)
//   6. validateIAMRouteAuthorization / userCanAccessSite exist and gate IAM
//   7. config.security.trustProxy: true is rejected
//
// Constraints honored: CommonJS (.cjs), node:test + node:assert/strict, no
// optional chaining. The refresh-session store is redirected to a per-file temp
// path so the tests never touch the shared ~/.haxcmsconfig store.

const test = require('node:test')
const { describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const connectionSettings = require('../../src/systemRoutes/v1/routes/connectionSettings.js')
const logoutRoute = require('../../src/systemRoutes/v1/routes/logout.js')
const refreshAccessToken = require('../../src/systemRoutes/v1/routes/refreshAccessToken.js')
const connectionTest = require('../../src/systemRoutes/v1/routes/connectionTest.js')
const sessionRoute = require('../../src/systemRoutes/v1/routes/session.js')
const limiter = require('../../src/lib/loginRateLimiter.js')

const ACTIVE_USER = HAXCMS.getActiveUserName()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-session-hardening-'))
const storePath = path.join(tmpDir, 'settings', 'refreshSessions.json')
const originalStorePath = HAXCMS.getRefreshSessionsPath
HAXCMS.getRefreshSessionsPath = () => storePath
test.after(() => {
  HAXCMS.getRefreshSessionsPath = originalStorePath
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    cookies: [],
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.body = obj
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    cookie(name, value, options) {
      this.cookies.push({ name: name, value: value, options: options })
    },
  }
}

function lastCookieValue(res) {
  for (let i = res.cookies.length - 1; i >= 0; i--) {
    if (res.cookies[i].name === 'haxcms_refresh_token') {
      return res.cookies[i].value
    }
  }
  return null
}

function parseAppSettings(body) {
  const match = String(body).match(/window\.appSettings =(\{.*\});/)
  assert.ok(match, 'appSettings payload present')
  return JSON.parse(match[1])
}

// ---------------------------------------------------------------------------
// 3. refresh-token revocation
// ---------------------------------------------------------------------------
describe('refresh-token revocation (tombstones)', () => {
  test('exploit (a): login -> logout -> replay the refresh token answers 401', () => {
    // "login": the same refresh token login.js sets as the cookie
    const refreshToken = HAXCMS.getRefreshToken(ACTIVE_USER)
    const logoutRes = fakeRes()
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: refreshToken } }, logoutRes)
    assert.equal(logoutRes.body.data, 'loggedout')
    // attacker replays the exfiltrated cookie
    const replayRes = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: refreshToken } }, replayRes)
    assert.equal(replayRes.statusCode, 401)
    assert.equal(replayRes.body.jwt, undefined)
    // and a second replay is still rejected (pre-fix: missing entry -> re-seeded)
    const replayRes2 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: refreshToken } }, replayRes2)
    assert.equal(replayRes2.statusCode, 401)
    // connection-test recovery path rejects it too
    const ctRes = fakeRes()
    connectionTest({ headers: {}, cookies: { haxcms_refresh_token: refreshToken } }, ctRes)
    assert.equal(ctRes.body.authenticated, false)
  })

  test('exploit (b): replaying a rotated (old) refresh token twice fails both times', () => {
    const token1 = HAXCMS.getRefreshToken(ACTIVE_USER)
    const res1 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: token1 } }, res1)
    assert.equal(res1.body.status, 200)
    const token2 = lastCookieValue(res1)
    assert.ok(token2 && token2 !== token1)
    const res2 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: token2 } }, res2)
    assert.equal(res2.body.status, 200)
    const token3 = lastCookieValue(res2)
    // token1 is now neither current nor previous: replay it twice
    const replay1 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: token1 } }, replay1)
    assert.equal(replay1.statusCode, 401)
    const replay2 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: token1 } }, replay2)
    assert.equal(replay2.statusCode, 401)
    // theft detection tombstoned the family: the latest token is dead too
    const res3 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: token3 } }, res3)
    assert.equal(res3.statusCode, 401)
  })

  test('a family-bearing token with no store entry is rejected (no accept-and-seed)', () => {
    const token = HAXCMS.getRefreshToken(ACTIVE_USER)
    const family = HAXCMS.decodeRefreshToken(token).family
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    delete store.families[family]
    fs.writeFileSync(storePath, JSON.stringify(store))
    const res = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: token } }, res)
    assert.equal(res.statusCode, 401)
  })

  test('a second login does not invalidate the first device (family-keyed store)', () => {
    const deviceA = HAXCMS.getRefreshToken(ACTIVE_USER)
    const deviceB = HAXCMS.getRefreshToken(ACTIVE_USER)
    const resA = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: deviceA } }, resA)
    assert.equal(resA.body.status, 200)
    const resB = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: deviceB } }, resB)
    assert.equal(resB.body.status, 200)
    // logging out on A leaves B alive
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: lastCookieValue(resA) } }, fakeRes())
    const resB2 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: lastCookieValue(resB) } }, resB2)
    assert.equal(resB2.body.status, 200)
  })

  test('legacy (no family) tokens are still seeded, but not after a logout cutoff', () => {
    const legacy = HAXCMS.getRefreshToken(ACTIVE_USER, false)
    const res = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: legacy } }, res)
    assert.equal(res.body.status, 200)
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: legacy } }, fakeRes())
    const replay = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: legacy } }, replay)
    assert.equal(replay.statusCode, 401)
  })

  test('the pre-2026-10 user-keyed store shape is migrated on read', () => {
    const now = Math.floor(Date.now() / 1000)
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, JSON.stringify({
      'old-user': {
        family: 'old-family',
        currentJtiHash: HAXCMS._hashJti('old-jti'),
        previousJtiHash: null,
        previousValidUntil: 0,
        exp: now + 3600,
      },
    }))
    assert.equal(HAXCMS.validateRefreshSession('old-user', 'old-family', 'old-jti'), true)
    assert.equal(HAXCMS.validateRefreshSession('other-user', 'old-family', 'old-jti'), false)
  })
})

// ---------------------------------------------------------------------------
// 5. same-origin checks
// ---------------------------------------------------------------------------
describe('same-origin checks on cookie-rotating session routes', () => {
  test('isSameOriginRequest honours Sec-Fetch-Site and no longer trusts a missing Referer from a browser', () => {
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
    // attacker page with Referrer-Policy: no-referrer (pre-fix: allowed)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-site' } }), false)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'none' } }), true)
    // cross-site wins even when a matching Origin is forged by a non-browser
    assert.equal(HAXCMS.isSameOriginRequest({
      headers: { 'sec-fetch-site': 'cross-site', origin: 'http://cms.example', host: 'cms.example' },
      protocol: 'http',
    }), false)
    // non-browser client with no headers at all is still allowed
    assert.equal(HAXCMS.isSameOriginRequest({ headers: {} }), true)
  })

  test('session/refresh rejects a cross-site request with no Origin/Referer', () => {
    const token = HAXCMS.getRefreshToken(ACTIVE_USER)
    const res = fakeRes()
    refreshAccessToken({
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { haxcms_refresh_token: token },
    }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Cross-origin request denied')
  })

  test('session/connection-test does not rotate (or clear) the cookie for a cross-site request', (t) => {
    const token = HAXCMS.getRefreshToken(ACTIVE_USER)
    let rotations = 0
    const original = HAXCMS.rotateRefreshTokenAndCookie
    t.mock.method(HAXCMS, 'rotateRefreshTokenAndCookie', function () {
      rotations += 1
      return original.apply(HAXCMS, arguments)
    })
    const res = fakeRes()
    connectionTest({
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { haxcms_refresh_token: token },
    }, res)
    assert.equal(rotations, 0)
    assert.equal(res.body.authenticated, false)
    assert.equal(res.body.jwt, undefined)
    assert.equal(res.cookies.length, 0)
    // same request from the app's own origin still recovers the session
    const sameRes = fakeRes()
    connectionTest({
      headers: { 'sec-fetch-site': 'same-origin' },
      cookies: { haxcms_refresh_token: token },
    }, sameRes)
    assert.equal(rotations, 1)
    assert.equal(sameRes.body.authenticated, true)
    assert.equal(sameRes.body.refreshed, true)
  })
})

// ---------------------------------------------------------------------------
// 1 + 2. connection-settings
// ---------------------------------------------------------------------------
describe('session/connection-settings', () => {
  test('a Referer no longer overwrites the HAXCMS protocol/domain/request_url singleton', async () => {
    const before = {
      protocol: HAXCMS.protocol,
      domain: HAXCMS.domain,
      request_url: HAXCMS.request_url,
    }
    const res = fakeRes()
    await connectionSettings({
      headers: { referer: 'https://evil.example/_sites/victim/', host: 'cms.example' },
      cookies: {},
      originalUrl: '/system/api/v1/session/connection-settings',
    }, res)
    assert.equal(HAXCMS.protocol, before.protocol)
    assert.equal(HAXCMS.domain, before.domain)
    assert.equal(HAXCMS.request_url, before.request_url)
    assert.notEqual(HAXCMS.getDomain(), 'evil.example')
    const settings = parseAppSettings(res.body)
    // the site context is still derived from the Referer path for the client
    assert.equal(settings.appStore.params.siteName, 'victim')
  })

  test('the site name comes from the request path before the Referer', async () => {
    const res = fakeRes()
    await connectionSettings({
      headers: { referer: 'http://cms.example/_sites/other/' },
      cookies: {},
      originalUrl: '/_sites/mine/system/api/v1/session/connection-settings',
    }, res)
    const settings = parseAppSettings(res.body)
    assert.equal(settings.appStore.params.siteName, 'mine')
    assert.equal(settings.siteApiBasePath, '/_sites/mine/x/api')
  })

  test('tokens are bound to the authenticated principal, not the configured fallback user', async (t) => {
    // a second valid principal (e.g. a SaaS-validated user) that differs from
    // the configured fallback
    const originalValidateUser = HAXCMS.validateUser
    t.mock.method(HAXCMS, 'validateUser', function (name) {
      return name === 'second-user' || originalValidateUser.call(HAXCMS, name)
    })
    const res = fakeRes()
    await connectionSettings({
      headers: { authorization: 'Bearer ' + HAXCMS.getJWT('second-user') },
      cookies: {},
      originalUrl: '/_sites/mine/system/api/v1/session/connection-settings',
    }, res)
    const settings = parseAppSettings(res.body)
    assert.equal(settings.userToken, HAXCMS.getRequestToken('second-user'))
    assert.equal(settings.siteToken, HAXCMS.getRequestToken('second-user:mine'))
    assert.notEqual(settings.userToken, HAXCMS.getRequestToken(ACTIVE_USER))
    // a revoked refresh cookie is not an authenticated principal
    const token = HAXCMS.getRefreshToken('second-user')
    HAXCMS.revokeRefreshSession('second-user', HAXCMS.decodeRefreshToken(token).family)
    assert.equal(HAXCMS.getAuthenticatedRawUserName({ headers: {}, cookies: { haxcms_refresh_token: token } }), null)
  })

  test('the no-login super-user JWT injection is never emitted in a production runtime', async () => {
    const savedDisable = HAXCMS.HAXCMS_DISABLE_JWT_CHECKS
    const savedEnv = process.env.NODE_ENV
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = true
    process.env.NODE_ENV = 'production'
    try {
      const res = fakeRes()
      await connectionSettings({ headers: {}, cookies: {}, originalUrl: '/' }, res)
      assert.equal(String(res.body).indexOf('window.appSettings.jwt'), -1)
      process.env.NODE_ENV = 'development'
      const devRes = fakeRes()
      await connectionSettings({ headers: {}, cookies: {}, originalUrl: '/' }, devRes)
      assert.notEqual(String(devRes.body).indexOf('window.appSettings.jwt'), -1)
    }
    finally {
      HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = savedDisable
      if (savedEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = savedEnv
      }
    }
  })

  test('siteConnectionJSON uses the per-request trusted host, not the singleton', () => {
    const connection = HAXCMS.siteConnectionJSON('tok', 'mine', {
      headers: { host: 'cms.example' },
      protocol: 'https',
    })
    assert.equal(connection.connection.protocol, 'https')
    assert.equal(connection.connection.url, 'cms.example' + HAXCMS.basePath)
  })
})

// ---------------------------------------------------------------------------
// 4. login rate limiter eviction
// ---------------------------------------------------------------------------
describe('login rate limiter eviction', () => {
  test('flooding MAX_TRACKED_KEYS junk usernames from one IP does not unblock admin', () => {
    const settings = { enabled: true, windowMs: 15 * 60 * 1000, maxAttempts: 5, blockMs: 15 * 60 * 1000 }
    const req = { ip: '203.0.113.9' }
    const adminKey = limiter.getAttemptKey(req, 'admin')
    let now = 1000000
    const adminEntry = limiter.getTrackerEntry(adminKey, now, settings)
    for (let i = 0; i < settings.maxAttempts; i++) {
      limiter.registerFailedAttempt(adminEntry, now, settings)
    }
    assert.ok(limiter.isBlocked(adminEntry, now))
    const maxKeys = limiter.MAX_TRACKED_KEYS || 10000
    for (let i = 0; i < maxKeys + 5; i++) {
      now += 1
      const junk = limiter.getTrackerEntry(limiter.getAttemptKey(req, 'junk-' + i), now, settings)
      limiter.registerFailedAttempt(junk, now, settings)
    }
    const after = limiter.getTrackerEntry(adminKey, now, settings)
    assert.ok(limiter.isBlocked(after, now), 'admin must still be blocked')
  })
})

// ---------------------------------------------------------------------------
// 6. IAM route authorization + site access
// ---------------------------------------------------------------------------
describe('validateIAMRouteAuthorization / userCanAccessSite', () => {
  function withIam(t, root) {
    const savedIam = HAXCMS.config.iam
    const savedRoot = HAXCMS.HAXCMS_ROOT
    HAXCMS.config.iam = true
    if (root) {
      HAXCMS.HAXCMS_ROOT = root
    }
    t.after(() => {
      if (savedIam === undefined) {
        delete HAXCMS.config.iam
      } else {
        HAXCMS.config.iam = savedIam
      }
      HAXCMS.HAXCMS_ROOT = savedRoot
    })
  }

  test('is a no-op (allow) when config.iam is not set', async () => {
    assert.equal(HAXCMS.config.iam, undefined)
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, { headers: {}, cookies: {} }).allowed, true)
    assert.equal(await HAXCMS.userCanAccessSite('does-not-exist', { headers: {}, cookies: {} }), true)
  })

  test('requires an authenticated principal that matches the tenant when IAM is on', (t) => {
    const tenant = HAXCMS.generateMachineName(ACTIVE_USER)
    withIam(t, '/var/www/users/' + tenant + '/')
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, { headers: {}, cookies: {} }).allowed, false)
    const ownReq = { headers: { authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER) }, cookies: {} }
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, ownReq).allowed, true)
    // a tenant path segment that disagrees with the tenant root is denied
    const otherPathReq = {
      headers: { authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER) },
      cookies: {},
      originalUrl: '/someone-else/system/api/v1/session',
    }
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, otherPathReq).allowed, false)
  })

  test('a principal from another tenant is denied by session and connection-test', (t) => {
    withIam(t, '/var/www/users/another-tenant/')
    const jwt = HAXCMS.getJWT(ACTIVE_USER)
    const res = fakeRes()
    sessionRoute({ headers: { authorization: 'Bearer ' + jwt }, cookies: {} }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.reason, 'not_authorized')
    const ctRes = fakeRes()
    connectionTest({ headers: { authorization: 'Bearer ' + jwt }, cookies: {} }, ctRes)
    assert.equal(ctRes.statusCode, 403)
  })

  test('userCanAccessSite denies a site outside the authenticated tenant under IAM', async (t) => {
    withIam(t, '/var/www/users/another-tenant/')
    const req = { headers: { authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER) }, cookies: {} }
    t.mock.method(HAXCMS, 'loadSite', async () => ({
      manifest: { metadata: { site: { name: 'their-site' } } },
    }))
    assert.equal(await HAXCMS.userCanAccessSite('their-site', req), false)
    assert.equal(await HAXCMS.userCanAccessSite('their-site', { headers: {}, cookies: {} }), false)
  })
})

// ---------------------------------------------------------------------------
// 7. trust proxy
// ---------------------------------------------------------------------------
describe('config.security.trustProxy', () => {
  test('boolean true is rejected (treated as false); hop counts / IP lists pass through', (t) => {
    t.mock.method(console, 'warn', () => {})
    const saved = HAXCMS.config.security.trustProxy
    try {
      HAXCMS.config.security.trustProxy = true
      assert.equal(HAXCMS.getTrustProxySetting(), false)
      assert.equal(HAXCMS.resolveTrustedProtocol({ headers: { 'x-forwarded-proto': 'https' }, protocol: 'http' }), 'http')
      HAXCMS.config.security.trustProxy = 'true'
      assert.equal(HAXCMS.getTrustProxySetting(), false)
      HAXCMS.config.security.trustProxy = 1
      assert.equal(HAXCMS.getTrustProxySetting(), 1)
      HAXCMS.config.security.trustProxy = '10.0.0.0/8'
      assert.equal(HAXCMS.getTrustProxySetting(), '10.0.0.0/8')
    }
    finally {
      if (saved === undefined) {
        delete HAXCMS.config.security.trustProxy
      } else {
        HAXCMS.config.security.trustProxy = saved
      }
    }
  })
})
