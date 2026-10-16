'use strict'

// Security (SEC-SESSION) unit tests for the session hardening PR:
//   1. session/connection-settings only hands siteToken / userToken (and the
//      token headers) to authenticated callers, and never mutates the HAXCMS
//      singleton from an attacker-controlled Referer.
//   2. refresh-token revocation is real: tombstones instead of deletes, the
//      accept/reject truth table (legacy / no entry / current / previous /
//      stale / revoked), v1 store migration, multi-device families, pruning.
//   3. connection-test (and session/refresh) apply the same-origin gate and
//      reject `Sec-Fetch-Site: cross-site`.
//   6. config.security.trustProxy=true is rejected.
//   7. validateIAMRouteAuthorization / userCanAccessSite exist, are no-ops in
//      non-IAM mode, and gate the lifecycle routes in IAM mode.
//
// The refresh-session store is redirected to a temp file per test so tests
// stay hermetic and never touch the developer's config directory.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const { describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const JWT = require('jsonwebtoken')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const loginRoute = require('../../src/systemRoutes/v1/routes/login.js')
const logoutRoute = require('../../src/systemRoutes/v1/routes/logout.js')
const refreshAccessToken = require('../../src/systemRoutes/v1/routes/refreshAccessToken.js')
const connectionTest = require('../../src/systemRoutes/v1/routes/connectionTest.js')
const connectionSettings = require('../../src/systemRoutes/v1/routes/connectionSettings.js')
const lifecycle = require('../../src/systemRoutes/v1/lifecycle.js')

const ACTIVE_USER = HAXCMS.getActiveUserName()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-sec-session-'))
let storeCounter = 0

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

// redirect the refresh-session store to a fresh temp file for this test
function isolateStore(t) {
  storeCounter += 1
  const storePath = path.join(tempRoot, 'store-' + storeCounter, 'refreshSessions.json')
  t.mock.method(HAXCMS, 'getRefreshSessionsPath', () => storePath)
  return storePath
}

function readStore(storePath) {
  return JSON.parse(fs.readFileSync(storePath, 'utf8'))
}

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
    set(name, value) {
      this.headers[name] = value
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    sendStatus(code) {
      this.statusCode = code
      return this
    },
    cookie(name, value, options) {
      this.cookies.push({ name: name, value: value, options: options })
    },
  }
}

// last refresh cookie value written onto a response ('' when cleared)
function lastCookie(res) {
  for (let i = res.cookies.length - 1; i >= 0; i--) {
    if (res.cookies[i].name === 'haxcms_refresh_token') {
      return res.cookies[i].value
    }
  }
  return null
}

// login through the real route so the cookie + store are produced for real
function realLogin(t) {
  t.mock.method(HAXCMS, 'testLogin', () => true)
  const res = fakeRes()
  loginRoute({ body: { username: ACTIVE_USER, password: 'x' }, headers: {}, ip: '10.9.9.' + storeCounter }, res)
  assert.equal(res.body.status, 200)
  const cookie = lastCookie(res)
  assert.ok(cookie && cookie.length > 0)
  return { cookie: cookie, jwt: res.body.jwt }
}

function legacyRefreshToken(user, iatOffset) {
  const now = Math.floor(Date.now() / 1000) + (iatOffset || 0)
  return JWT.sign(
    { user: user, iat: now, exp: now + 3600 },
    HAXCMS.refreshPrivateKey + HAXCMS.salt,
  )
}

// ---------------------------------------------------------------------------
// 2. refresh-token revocation truth table
// ---------------------------------------------------------------------------
describe('refresh-session store truth table', () => {
  test('legacy token (no family claim) is accepted and seeded into a new family', (t) => {
    const storePath = isolateStore(t)
    const decoded = HAXCMS.decodeRefreshToken(legacyRefreshToken(ACTIVE_USER))
    assert.deepEqual(HAXCMS.checkRefreshSession(decoded), { ok: true, reason: 'legacy', legacy: true })
    const res = fakeRes()
    const access = HAXCMS.rotateRefreshTokenAndCookie(res, decoded)
    assert.ok(access)
    const rotated = HAXCMS.decodeRefreshToken(lastCookie(res))
    assert.ok(rotated.family, 'legacy token upgraded into a family')
    assert.ok(rotated.jti)
    const store = readStore(storePath)
    assert.ok(store.users[ACTIVE_USER].families[rotated.family])
    assert.equal(HAXCMS.checkRefreshSession(rotated).reason, 'current')
  })

  test('legacy token issued before a legacy logout tombstone is rejected', (t) => {
    isolateStore(t)
    const decoded = HAXCMS.decodeRefreshToken(legacyRefreshToken(ACTIVE_USER, -10))
    HAXCMS.revokeRefreshSession(ACTIVE_USER, null)
    assert.equal(HAXCMS.checkRefreshSession(decoded).ok, false)
    assert.equal(HAXCMS.checkRefreshSession(decoded).reason, 'revoked')
    assert.equal(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), decoded), null)
  })

  test('family-bearing token with no store entry is rejected (no accept+seed)', (t) => {
    const storePath = isolateStore(t)
    const decoded = { user: ACTIVE_USER, family: 'never-recorded', jti: 'j1', iat: 1 }
    assert.equal(HAXCMS.checkRefreshSession(decoded).reason, 'no_entry')
    assert.equal(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), decoded), null)
    // and nothing got seeded for it
    assert.equal(fs.existsSync(storePath) ? !!(readStore(storePath).users[ACTIVE_USER] &&
      readStore(storePath).users[ACTIVE_USER].families['never-recorded'] &&
      !readStore(storePath).users[ACTIVE_USER].families['never-recorded'].revoked) : false, false)
  })

  test('family claim without a jti is rejected as invalid', (t) => {
    isolateStore(t)
    assert.equal(HAXCMS.checkRefreshSession({ user: ACTIVE_USER, family: 'f' }).reason, 'invalid')
  })

  test('matching jti rotates; previous jti is honoured within the grace window', (t) => {
    isolateStore(t)
    const first = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    const res = fakeRes()
    assert.ok(HAXCMS.rotateRefreshTokenAndCookie(res, first))
    const second = HAXCMS.decodeRefreshToken(lastCookie(res))
    assert.equal(second.family, first.family)
    assert.equal(HAXCMS.checkRefreshSession(second).reason, 'current')
    assert.equal(HAXCMS.checkRefreshSession(first).reason, 'previous')
  })

  test('stale jti tombstones the family and every later attempt is rejected', (t) => {
    const storePath = isolateStore(t)
    const first = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    const r1 = fakeRes()
    HAXCMS.rotateRefreshTokenAndCookie(r1, first)
    const second = HAXCMS.decodeRefreshToken(lastCookie(r1))
    const r2 = fakeRes()
    HAXCMS.rotateRefreshTokenAndCookie(r2, second)
    const third = HAXCMS.decodeRefreshToken(lastCookie(r2))
    // `first` is now neither current nor previous: replay -> stale_jti
    assert.equal(HAXCMS.checkRefreshSession(first).reason, 'stale_jti')
    assert.equal(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), first), null)
    const tomb = readStore(storePath).users[ACTIVE_USER].families[first.family]
    assert.equal(tomb.revoked, true)
    assert.ok(typeof tomb.revokedAt === 'number')
    // even the legitimate latest token is now dead
    assert.equal(HAXCMS.checkRefreshSession(third).reason, 'revoked')
    assert.equal(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), third), null)
  })

  test('logout tombstones only the presented family; other devices stay signed in', (t) => {
    isolateStore(t)
    const laptop = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    const phone = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    assert.notEqual(laptop.family, phone.family)
    assert.equal(HAXCMS.checkRefreshSession(laptop).ok, true)
    assert.equal(HAXCMS.checkRefreshSession(phone).ok, true)
    HAXCMS.revokeRefreshSession(ACTIVE_USER, laptop.family)
    assert.equal(HAXCMS.checkRefreshSession(laptop).reason, 'revoked')
    assert.equal(HAXCMS.checkRefreshSession(phone).reason, 'current')
  })

  test('a v1 store file is migrated on load so live sessions survive the upgrade', (t) => {
    const storePath = isolateStore(t)
    const now = Math.floor(Date.now() / 1000)
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, JSON.stringify({
      [ACTIVE_USER]: {
        family: 'v1-family',
        currentJtiHash: HAXCMS._hashJti('v1-jti'),
        previousJtiHash: null,
        previousValidUntil: 0,
        exp: now + 3600,
      },
      __proto__: { family: 'evil' },
    }))
    const decoded = { user: ACTIVE_USER, family: 'v1-family', jti: 'v1-jti', iat: now }
    assert.equal(HAXCMS.checkRefreshSession(decoded).reason, 'current')
    const res = fakeRes()
    assert.ok(HAXCMS.rotateRefreshTokenAndCookie(res, decoded))
    const store = readStore(storePath)
    assert.equal(store.version, 2)
    assert.ok(store.users[ACTIVE_USER].families['v1-family'])
    assert.equal(Object.prototype.hasOwnProperty.call(store.users, '__proto__'), false)
  })

  test('expired live entries and expired tombstones are pruned on write', (t) => {
    const storePath = isolateStore(t)
    const now = Math.floor(Date.now() / 1000)
    HAXCMS._saveRefreshSessions({
      version: 2,
      users: {
        olduser: {
          families: {
            deadTomb: { revoked: true, revokedAt: now - 999999, exp: now - 10 },
            deadLive: { currentJtiHash: 'x', exp: now - 10 },
          },
          legacyRevokedAt: now - 999999,
          legacyRevokedExp: now - 10,
        },
        keeper: {
          families: {
            liveTomb: { revoked: true, revokedAt: now, exp: now + 100 },
          },
        },
      },
    })
    const store = readStore(storePath)
    assert.equal(store.users.olduser, undefined)
    assert.ok(store.users.keeper.families.liveTomb)
  })

  test('tombstones outlive the refresh-token lifetime', (t) => {
    const storePath = isolateStore(t)
    HAXCMS.revokeRefreshSession(ACTIVE_USER, 'some-family')
    const tomb = readStore(storePath).users[ACTIVE_USER].families['some-family']
    assert.ok(tomb.exp >= Math.floor(Date.now() / 1000) + 24 * 60 * 60)
  })

  test('an unwritable store falls back to a legacy (no-family) token so login still works', (t) => {
    isolateStore(t)
    t.mock.method(HAXCMS, '_saveRefreshSessions', () => false)
    const decoded = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    assert.equal(decoded.family, undefined)
    assert.equal(decoded.jti, undefined)
    assert.equal(HAXCMS.checkRefreshSession(decoded).ok, true)
    const res = fakeRes()
    assert.ok(HAXCMS.rotateRefreshTokenAndCookie(res, decoded))
    assert.equal(HAXCMS.decodeRefreshToken(lastCookie(res)).family, undefined)
  })
})

// ---------------------------------------------------------------------------
// 2. end-to-end route flows (real login / refresh / logout / connection-test)
// ---------------------------------------------------------------------------
describe('route flows with real tokens', () => {
  test('login -> refresh -> replay of the old cookie revokes the family', (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const r1 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r1)
    assert.equal(r1.body.status, 200)
    const rotatedCookie = lastCookie(r1)
    // a second rotation moves login.cookie out of the grace slot
    const r2 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: rotatedCookie } }, r2)
    assert.equal(r2.body.status, 200)
    const latest = lastCookie(r2)
    // attacker replays the original login cookie
    const r3 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r3)
    assert.equal(r3.statusCode, 401)
    // the legitimate latest cookie is now revoked too
    const r4 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: latest } }, r4)
    assert.equal(r4.statusCode, 401)
    assert.equal(lastCookie(r4), '')
  })

  test('logout makes the refresh cookie unusable for refresh and connection-test', (t) => {
    isolateStore(t)
    const login = realLogin(t)
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, fakeRes())
    const r1 = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r1)
    assert.equal(r1.statusCode, 401)
    const r2 = fakeRes()
    connectionTest({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r2)
    assert.equal(r2.body.authenticated, false)
    assert.equal(r2.body.reason, 'no_session')
    // and it no longer authenticates a request
    assert.equal(
      HAXCMS.getRequestAuthenticatedUserName({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }),
      '',
    )
  })

  test('logout with a legacy cookie tombstones legacy tokens for that user', (t) => {
    isolateStore(t)
    const legacy = legacyRefreshToken(ACTIVE_USER, -5)
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: legacy } }, fakeRes())
    const res = fakeRes()
    refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: legacy } }, res)
    assert.equal(res.statusCode, 401)
  })

  test('connection-test recovers a live session and rotates the cookie', (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const res = fakeRes()
    connectionTest({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, res)
    assert.equal(res.body.authenticated, true)
    assert.equal(res.body.refreshed, true)
    assert.ok(lastCookie(res))
  })
})

// ---------------------------------------------------------------------------
// 3. same-origin gate on connection-test / refresh
// ---------------------------------------------------------------------------
describe('connection-test / refresh origin gate', () => {
  function trustedOrigin(t) {
    t.mock.method(HAXCMS, 'resolveTrustedProtocol', () => 'https')
    t.mock.method(HAXCMS, 'resolveTrustedHost', () => 'cms.example.com')
  }

  test('cross-origin connection-test with a refresh cookie is denied before rotating', (t) => {
    isolateStore(t)
    trustedOrigin(t)
    const login = realLogin(t)
    let rotated = 0
    const original = HAXCMS.rotateRefreshTokenAndCookie
    t.mock.method(HAXCMS, 'rotateRefreshTokenAndCookie', function () {
      rotated += 1
      return original.apply(HAXCMS, arguments)
    })
    const res = fakeRes()
    connectionTest({
      headers: { origin: 'https://evil.example' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.reason, 'cross_origin')
    assert.equal(res.body.message, 'Cross-origin request denied')
    assert.equal(rotated, 0)
    assert.equal(lastCookie(res), '')
  })

  test('same-origin connection-test with a refresh cookie proceeds', (t) => {
    isolateStore(t)
    trustedOrigin(t)
    const login = realLogin(t)
    const res = fakeRes()
    connectionTest({
      headers: { origin: 'https://cms.example.com', 'sec-fetch-site': 'same-origin' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.body.authenticated, true)
  })

  test('Sec-Fetch-Site: cross-site is rejected even without Origin/Referer', (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const res = fakeRes()
    connectionTest({
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.statusCode, 403)
    const refreshRes = fakeRes()
    refreshAccessToken({
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, refreshRes)
    assert.equal(refreshRes.statusCode, 403)
    assert.equal(refreshRes.body.data.message, 'Cross-origin request denied')
  })

  test('Sec-Fetch-Site same-site / none / same-origin are not rejected by the header alone', () => {
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'none' } }), true)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-site' } }), true)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'Cross-Site' } }), false)
  })

  test('an anonymous cross-origin probe without a cookie still answers 200 no_session', (t) => {
    trustedOrigin(t)
    const res = fakeRes()
    connectionTest({ headers: { origin: 'https://evil.example' }, cookies: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.reason, 'no_session')
  })
})

// ---------------------------------------------------------------------------
// 1. connection-settings token gating + no global mutation
// ---------------------------------------------------------------------------
describe('connection-settings', () => {
  function parse(res) {
    const sandbox = { window: {} }
    vm.runInNewContext(String(res.body), sandbox, { timeout: 2000 })
    return sandbox.window.appSettings
  }
  function snapshotGlobals() {
    return { protocol: HAXCMS.protocol, domain: HAXCMS.domain, request_url: HAXCMS.request_url }
  }
  function restoreGlobals(t, snap) {
    t.after(() => {
      HAXCMS.protocol = snap.protocol
      HAXCMS.domain = snap.domain
      HAXCMS.request_url = snap.request_url
    })
  }

  test('anonymous callers get the payload with siteToken/userToken omitted', async (t) => {
    isolateStore(t)
    const res = fakeRes()
    await connectionSettings({ headers: {}, cookies: {} }, res)
    const settings = parse(res)
    assert.equal(Object.prototype.hasOwnProperty.call(settings, 'siteToken'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(settings, 'userToken'), false)
    assert.equal(JSON.stringify(settings.getUserDataHeaders), '{}')
    assert.equal(JSON.stringify(settings.appStore.headers), '{}')
    // boot data still present
    assert.ok(settings.login)
    assert.ok(settings.connectionTest)
    assert.ok(settings.token)
    assert.equal(settings.userTokenHeader, 'X-HAXCMS-User-Token')
    assert.equal(res.headers['Cache-Control'].indexOf('no-store'), 0)
  })

  test('a valid bearer JWT receives the tokens and the token headers', async (t) => {
    isolateStore(t)
    const res = fakeRes()
    await connectionSettings({
      headers: { authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER) },
      cookies: {},
    }, res)
    const settings = parse(res)
    assert.equal(settings.userToken, HAXCMS.getRequestToken(ACTIVE_USER))
    assert.ok(settings.siteToken)
    assert.equal(settings.getUserDataHeaders['X-HAXCMS-User-Token'], settings.userToken)
    assert.equal(settings.appStore.headers['X-HAXCMS-Site-Token'], settings.siteToken)
  })

  test('a valid refresh-cookie session receives the tokens', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const res = fakeRes()
    await connectionSettings({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, res)
    assert.equal(parse(res).userToken, HAXCMS.getRequestToken(ACTIVE_USER))
  })

  test('a revoked refresh cookie or a bad bearer gets no tokens', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, fakeRes())
    const res = fakeRes()
    await connectionSettings({
      headers: { authorization: 'Bearer not-a-jwt' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    const settings = parse(res)
    assert.equal(settings.userToken, undefined)
    assert.equal(settings.siteToken, undefined)
  })

  test('JWT-check bypass (local dev, non-production) keeps the tokens', async (t) => {
    isolateStore(t)
    const saved = HAXCMS.HAXCMS_DISABLE_JWT_CHECKS
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = true
    t.after(() => {
      HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = saved
    })
    t.mock.method(HAXCMS, 'getJWT', () => 'dev-jwt')
    const res = fakeRes()
    await connectionSettings({ headers: {}, cookies: {} }, res)
    assert.ok(parse(res).userToken)
  })

  test('an anonymous Referer never mutates HAXCMS.protocol / domain / request_url', async (t) => {
    isolateStore(t)
    const snap = snapshotGlobals()
    restoreGlobals(t, snap)
    const res = fakeRes()
    await connectionSettings({
      headers: { referer: 'https://evil.example/_sites/victim/', host: 'cms.example.com' },
      protocol: 'https',
      cookies: {},
    }, res)
    assert.equal(HAXCMS.protocol, snap.protocol)
    assert.equal(HAXCMS.domain, snap.domain)
    assert.equal(HAXCMS.request_url, snap.request_url)
    // the referer path still selects the site context (no tokens though)
    assert.equal(parse(res).appStore.params.siteName, 'victim')
  })

  test('an authenticated cross-origin Referer does not mutate the globals either', async (t) => {
    isolateStore(t)
    const snap = snapshotGlobals()
    restoreGlobals(t, snap)
    await connectionSettings({
      headers: {
        referer: 'https://evil.example/_sites/x/',
        host: 'cms.example.com',
        authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER),
      },
      protocol: 'https',
      cookies: {},
    }, fakeRes())
    assert.equal(HAXCMS.domain, snap.domain)
    assert.equal(HAXCMS.protocol, snap.protocol)
  })

  test('an authenticated same-origin load records the TRUSTED host, not referer values', async (t) => {
    isolateStore(t)
    restoreGlobals(t, snapshotGlobals())
    await connectionSettings({
      headers: {
        referer: 'https://cms.example.com/_sites/demo/page?x=1',
        host: 'cms.example.com',
        authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER),
      },
      protocol: 'https',
      cookies: {},
    }, fakeRes())
    assert.equal(HAXCMS.domain, 'cms.example.com')
    assert.equal(HAXCMS.protocol, 'https')
    assert.equal(HAXCMS.request_url.href, 'https://cms.example.com/_sites/demo/page')
  })
})

// ---------------------------------------------------------------------------
// 6. trustProxy normalization
// ---------------------------------------------------------------------------
describe('trustProxy', () => {
  function withTrustProxy(t, value) {
    const hadSecurity = !!HAXCMS.config.security
    if (!hadSecurity) {
      HAXCMS.config.security = {}
    }
    const had = Object.prototype.hasOwnProperty.call(HAXCMS.config.security, 'trustProxy')
    const saved = HAXCMS.config.security.trustProxy
    HAXCMS.config.security.trustProxy = value
    t.after(() => {
      if (had) {
        HAXCMS.config.security.trustProxy = saved
      } else {
        delete HAXCMS.config.security.trustProxy
      }
      if (!hadSecurity) {
        delete HAXCMS.config.security
      }
    })
  }

  test('boolean true is rejected with a one-time warning and falls back to false', (t) => {
    const warnings = []
    t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))
    HAXCMS.__trustProxyWarned = false
    withTrustProxy(t, true)
    assert.equal(HAXCMS.getTrustProxySetting(), false)
    assert.equal(HAXCMS.getTrustProxySetting(), false)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].indexOf('trustProxy') !== -1)
    // forwarded headers are therefore ignored
    assert.equal(
      HAXCMS.resolveTrustedProtocol({ headers: { 'x-forwarded-proto': 'https' }, protocol: 'http' }),
      'http',
    )
  })

  test('the string "true" is rejected too', (t) => {
    t.mock.method(console, 'warn', () => {})
    withTrustProxy(t, 'true')
    assert.equal(HAXCMS.getTrustProxySetting(), false)
  })

  test('hop counts, IP/CIDR strings and lists are accepted', (t) => {
    t.mock.method(console, 'warn', () => {})
    withTrustProxy(t, 1)
    assert.equal(HAXCMS.getTrustProxySetting(), 1)
    HAXCMS.config.security.trustProxy = '10.0.0.0/8, 127.0.0.1'
    assert.equal(HAXCMS.getTrustProxySetting(), '10.0.0.0/8, 127.0.0.1')
    HAXCMS.config.security.trustProxy = ['10.0.0.1', ' ', 'loopback']
    assert.deepEqual(HAXCMS.getTrustProxySetting(), ['10.0.0.1', 'loopback'])
    HAXCMS.config.security.trustProxy = -1
    assert.equal(HAXCMS.getTrustProxySetting(), false)
    HAXCMS.config.security.trustProxy = { any: 'object' }
    assert.equal(HAXCMS.getTrustProxySetting(), false)
  })
})

// ---------------------------------------------------------------------------
// 7. IAM authorization + userCanAccessSite
// ---------------------------------------------------------------------------
describe('IAM authorization', () => {
  function withIAM(t, root) {
    const savedIam = HAXCMS.config.iam
    const savedRoot = HAXCMS.HAXCMS_ROOT
    HAXCMS.config.iam = true
    if (root) {
      HAXCMS.HAXCMS_ROOT = root
    }
    t.after(() => {
      if (typeof savedIam === 'undefined') {
        delete HAXCMS.config.iam
      } else {
        HAXCMS.config.iam = savedIam
      }
      HAXCMS.HAXCMS_ROOT = savedRoot
    })
  }
  function bearer(user, url) {
    return {
      headers: { authorization: 'Bearer ' + HAXCMS.getJWT(user) },
      cookies: {},
      originalUrl: url || '/system/api/v1/session',
    }
  }

  test('non-IAM deployments are always allowed (default behaviour unchanged)', () => {
    assert.deepEqual(
      HAXCMS.validateIAMRouteAuthorization(true, { headers: {}, cookies: {} }),
      { allowed: true, status: 200, message: '' },
    )
    assert.equal(HAXCMS.isIAMEnabled(), false)
  })

  test('IAM requires an authenticated user', (t) => {
    withIAM(t, '/srv/haxiam/')
    const result = HAXCMS.validateIAMRouteAuthorization(true, { headers: {}, cookies: {}, originalUrl: '/system/api/v1/x' })
    assert.equal(result.allowed, false)
    assert.equal(result.status, 403)
    assert.equal(result.message, 'Access denied')
    assert.equal(HAXCMS.validateIAMRouteAuthorization(false, { headers: {}, cookies: {} }).allowed, true)
  })

  test('IAM binds the authenticated user to the tenant from HAXCMS_ROOT', (t) => {
    withIAM(t, '/var/www/users/' + ACTIVE_USER + '/')
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, bearer(ACTIVE_USER)).allowed, true)
    // different tenant root -> denied
    HAXCMS.HAXCMS_ROOT = '/var/www/users/someone-else/'
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, bearer(ACTIVE_USER)).allowed, false)
  })

  test('IAM denies when the tenant root and the request path user disagree', (t) => {
    withIAM(t, '/var/www/users/' + ACTIVE_USER + '/')
    const req = bearer(ACTIVE_USER, '/other-tenant/system/api/v1/session')
    assert.equal(HAXCMS.getRequestPathUserName(req), 'other-tenant')
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, req).allowed, false)
  })

  test('IAM falls back to the request path tenant and ignores /system paths', (t) => {
    withIAM(t, '/srv/haxiam/')
    assert.equal(HAXCMS.getRequestPathUserName({ originalUrl: '/system/api/v1/x' }), null)
    const own = bearer(ACTIVE_USER, '/' + ACTIVE_USER + '/x/api/v1/site')
    assert.equal(HAXCMS.getIAMTenantUserName(own), HAXCMS.generateMachineName(ACTIVE_USER))
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, own).allowed, true)
    assert.equal(
      HAXCMS.validateIAMRouteAuthorization(true, bearer(ACTIVE_USER, '/mallory/x/api/v1/site')).allowed,
      false,
    )
  })

  test('userCanAccessSite: non-IAM allows existing sites and rejects missing ones', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async (name) =>
      name === 'exists' ? { manifest: { metadata: { site: { name: 'exists' } } } } : false)
    assert.equal(await HAXCMS.userCanAccessSite('exists'), true)
    assert.equal(await HAXCMS.userCanAccessSite('missing'), false)
    assert.equal(await HAXCMS.userCanAccessSite(''), false)
  })

  test('userCanAccessSite: IAM requires the site to live in the caller\'s tenant', async (t) => {
    const userRoot = path.join(tempRoot, 'iam', 'users', 'mallory')
    fs.mkdirSync(path.join(userRoot, '_sites'), { recursive: true })
    withIAM(t, path.join(tempRoot, 'iam', 'users', 'mallory') + '/')
    t.mock.method(HAXCMS, 'loadSite', async () => ({ manifest: { metadata: { site: { name: 'shared' } } } }))
    // anonymous -> denied
    assert.equal(await HAXCMS.userCanAccessSite('shared', { headers: {}, cookies: {} }), false)
    // root is scoped to mallory but the caller is ACTIVE_USER and has no copy
    const savedDir = HAXCMS.sitesDirectory
    HAXCMS.sitesDirectory = '_sites'
    t.after(() => {
      HAXCMS.sitesDirectory = savedDir
    })
    assert.equal(await HAXCMS.userCanAccessSite('shared', bearer(ACTIVE_USER)), false)
    // give the caller a (shared/symlinked or owned) copy in their own tenant
    const callerSites = path.join(tempRoot, 'iam', 'users', HAXCMS.generateMachineName(ACTIVE_USER), '_sites', 'shared')
    fs.mkdirSync(callerSites, { recursive: true })
    assert.equal(await HAXCMS.userCanAccessSite('shared', bearer(ACTIVE_USER)), true)
    // root scoped to the caller -> allowed directly
    HAXCMS.HAXCMS_ROOT = path.join(tempRoot, 'iam', 'users', HAXCMS.generateMachineName(ACTIVE_USER)) + '/'
    assert.equal(await HAXCMS.userCanAccessSite('shared', bearer(ACTIVE_USER)), true)
  })

  test('lifecycle routes answer 403 Access denied to site in IAM mode when access is refused', async (t) => {
    withIAM(t, '/srv/haxiam/')
    t.mock.method(HAXCMS, 'userCanAccessSite', async () => false)
    const names = ['cloneSite', 'archiveSite', 'downloadSite', 'downloadSiteSkeleton', 'saveSiteAsTemplate']
    for (let i = 0; i < names.length; i++) {
      const res = fakeRes()
      await lifecycle[names[i]]({ params: { siteName: 'victim' }, body: {}, headers: {}, cookies: {} }, res)
      assert.equal(res.statusCode, 403, names[i])
      assert.deepEqual(res.body, { status: 403, data: { message: 'Access denied to site' } }, names[i])
    }
  })

  test('lifecycle routes never consult userCanAccessSite outside IAM mode', async (t) => {
    let calls = 0
    t.mock.method(HAXCMS, 'userCanAccessSite', async () => {
      calls += 1
      return false
    })
    const res = fakeRes()
    // missing site.name -> the route's own 400, proving the gate let it through
    await lifecycle.downloadSiteSkeleton({ body: {}, headers: {}, cookies: {} }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(calls, 0)
  })
})
