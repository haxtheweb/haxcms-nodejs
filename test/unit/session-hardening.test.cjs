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

// set / clear the HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS env override
// for one test (null = unset, so the config default FALSE applies)
function withRequireSessionFlag(t, value) {
  const saved = process.env.HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS
  if (value === null) {
    delete process.env.HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS
  } else {
    process.env.HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS = value
  }
  t.after(() => {
    if (saved === undefined) {
      delete process.env.HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS
    } else {
      process.env.HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS = saved
    }
  })
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
  test('legacy token (no family claim) is accepted and seeded into a new family', async (t) => {
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

  test('legacy token issued before a legacy logout tombstone is rejected', async (t) => {
    isolateStore(t)
    const decoded = HAXCMS.decodeRefreshToken(legacyRefreshToken(ACTIVE_USER, -10))
    HAXCMS.revokeRefreshSession(ACTIVE_USER, null)
    assert.equal(HAXCMS.checkRefreshSession(decoded).ok, false)
    assert.equal(HAXCMS.checkRefreshSession(decoded).reason, 'revoked')
    assert.equal(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), decoded), null)
  })

  test('family-bearing token with no store entry is rejected (no accept+seed)', async (t) => {
    const storePath = isolateStore(t)
    const decoded = { user: ACTIVE_USER, family: 'never-recorded', jti: 'j1', iat: 1 }
    assert.equal(HAXCMS.checkRefreshSession(decoded).reason, 'no_entry')
    assert.equal(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), decoded), null)
    // and nothing got seeded for it
    assert.equal(fs.existsSync(storePath) ? !!(readStore(storePath).users[ACTIVE_USER] &&
      readStore(storePath).users[ACTIVE_USER].families['never-recorded'] &&
      !readStore(storePath).users[ACTIVE_USER].families['never-recorded'].revoked) : false, false)
  })

  test('family claim without a jti is rejected as invalid', async (t) => {
    isolateStore(t)
    assert.equal(HAXCMS.checkRefreshSession({ user: ACTIVE_USER, family: 'f' }).reason, 'invalid')
  })

  test('matching jti rotates; previous jti is honoured within the grace window', async (t) => {
    isolateStore(t)
    const first = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    const res = fakeRes()
    assert.ok(HAXCMS.rotateRefreshTokenAndCookie(res, first))
    const second = HAXCMS.decodeRefreshToken(lastCookie(res))
    assert.equal(second.family, first.family)
    assert.equal(HAXCMS.checkRefreshSession(second).reason, 'current')
    assert.equal(HAXCMS.checkRefreshSession(first).reason, 'previous')
  })

  test('stale jti tombstones the family and every later attempt is rejected', async (t) => {
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

  test('logout tombstones only the presented family; other devices stay signed in', async (t) => {
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

  test('a v1 store file is migrated on load so live sessions survive the upgrade', async (t) => {
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

  test('expired live entries and expired tombstones are pruned on write', async (t) => {
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

  test('tombstones outlive the refresh-token lifetime', async (t) => {
    const storePath = isolateStore(t)
    HAXCMS.revokeRefreshSession(ACTIVE_USER, 'some-family')
    const tomb = readStore(storePath).users[ACTIVE_USER].families['some-family']
    assert.ok(tomb.exp >= Math.floor(Date.now() / 1000) + 24 * 60 * 60)
  })

  test('an unwritable store falls back to a legacy (no-family) token so login still works', async (t) => {
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
  test('login -> refresh -> replay of the old cookie revokes the family', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const r1 = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r1)
    assert.equal(r1.body.status, 200)
    const rotatedCookie = lastCookie(r1)
    // a second rotation moves login.cookie out of the grace slot
    const r2 = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: rotatedCookie } }, r2)
    assert.equal(r2.body.status, 200)
    const latest = lastCookie(r2)
    // attacker replays the original login cookie
    const r3 = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r3)
    assert.equal(r3.statusCode, 401)
    // the legitimate latest cookie is now revoked too
    const r4 = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: latest } }, r4)
    assert.equal(r4.statusCode, 401)
    assert.equal(lastCookie(r4), '')
  })

  test('logout makes the refresh cookie unusable for refresh and connection-test', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, fakeRes())
    const r1 = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r1)
    assert.equal(r1.statusCode, 401)
    const r2 = fakeRes()
    await connectionTest({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, r2)
    assert.equal(r2.body.authenticated, false)
    assert.equal(r2.body.reason, 'no_session')
    // and it no longer authenticates a request
    assert.equal(
      HAXCMS.getRequestAuthenticatedUserName({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }),
      '',
    )
  })

  test('logout with a legacy cookie tombstones legacy tokens for that user', async (t) => {
    isolateStore(t)
    const legacy = legacyRefreshToken(ACTIVE_USER, -5)
    logoutRoute({ headers: {}, cookies: { haxcms_refresh_token: legacy } }, fakeRes())
    const res = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: legacy } }, res)
    assert.equal(res.statusCode, 401)
  })

  test('connection-test recovers a live session and rotates the cookie', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const res = fakeRes()
    await connectionTest({ headers: {}, cookies: { haxcms_refresh_token: login.cookie } }, res)
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

  test('cross-origin connection-test with a refresh cookie is denied before rotating', async (t) => {
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
    await connectionTest({
      headers: { origin: 'https://evil.example' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.reason, 'cross_origin')
    assert.equal(res.body.message, 'Cross-origin request denied')
    assert.equal(rotated, 0)
    assert.equal(lastCookie(res), '')
  })

  test('same-origin connection-test with a refresh cookie proceeds', async (t) => {
    isolateStore(t)
    trustedOrigin(t)
    const login = realLogin(t)
    const res = fakeRes()
    await connectionTest({
      headers: { origin: 'https://cms.example.com', 'sec-fetch-site': 'same-origin' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.body.authenticated, true)
  })

  test('Sec-Fetch-Site: cross-site is rejected even without Origin/Referer', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const res = fakeRes()
    await connectionTest({
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.statusCode, 403)
    const refreshRes = fakeRes()
    await refreshAccessToken({
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, refreshRes)
    assert.equal(refreshRes.statusCode, 403)
    assert.equal(refreshRes.body.data.message, 'Cross-origin request denied')
  })

  test('Sec-Fetch-Site same-site / none / same-origin are not rejected by the header alone', async () => {
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'none' } }), true)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-site' } }), true)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { 'sec-fetch-site': 'Cross-Site' } }), false)
  })

  test('an anonymous cross-origin probe without a cookie still answers 200 no_session', async (t) => {
    trustedOrigin(t)
    const res = fakeRes()
    await connectionTest({ headers: { origin: 'https://evil.example' }, cookies: {} }, res)
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

  test('anonymous callers get the payload with siteToken/userToken omitted (flag on)', async (t) => {
    isolateStore(t)
    withRequireSessionFlag(t, '1')
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

  test('a revoked refresh cookie or a bad bearer gets no tokens (flag on)', async (t) => {
    isolateStore(t)
    withRequireSessionFlag(t, 'true')
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

  test('flag off (default): anonymous same-origin callers still get the tokens', async (t) => {
    isolateStore(t)
    withRequireSessionFlag(t, null)
    const res = fakeRes()
    await connectionSettings({ headers: { 'sec-fetch-site': 'same-origin' }, cookies: {} }, res)
    const settings = parse(res)
    assert.equal(settings.userToken, HAXCMS.getRequestToken(ACTIVE_USER))
    assert.equal(settings.getUserDataHeaders['X-HAXCMS-User-Token'], settings.userToken)
    assert.equal(settings.appStore.headers['X-HAXCMS-Site-Token'], settings.siteToken)
  })

  test('Sec-Fetch-Site cross-site omits the tokens even for an authenticated caller', async (t) => {
    isolateStore(t)
    withRequireSessionFlag(t, null)
    const res = fakeRes()
    await connectionSettings({
      headers: { 'sec-fetch-site': 'cross-site', authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER) },
      cookies: {},
    }, res)
    const settings = parse(res)
    assert.equal(settings.userToken, undefined)
    assert.equal(settings.siteToken, undefined)
    assert.equal(JSON.stringify(settings.getUserDataHeaders), '{}')
    assert.equal(JSON.stringify(settings.appStore.headers), '{}')
  })

  // full decision matrix: Sec-Fetch-Site x flag x authenticated
  const fetchSites = ['cross-site', 'same-site', 'same-origin', 'none', null]
  for (const fetchSite of fetchSites) {
    for (const flag of [true, false]) {
      for (const authed of [true, false]) {
        const blockedBySite = fetchSite === 'cross-site' || fetchSite === 'same-site'
        const expected = !blockedBySite && (authed || !flag)
        test('decision: Sec-Fetch-Site=' + (fetchSite || 'absent') + ' flag=' + (flag ? 'on' : 'off') +
          ' ' + (authed ? 'authenticated' : 'anonymous') + ' -> ' + (expected ? 'include' : 'omit'), async (t) => {
          isolateStore(t)
          withRequireSessionFlag(t, flag ? 'yes' : '0')
          const headers = {}
          if (fetchSite) {
            headers['sec-fetch-site'] = fetchSite
          }
          if (authed) {
            headers.authorization = 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER)
          }
          const decision = HAXCMS.shouldIncludeRequestTokens({ headers: headers, cookies: {} })
          assert.equal(decision.include, expected)
          const res = fakeRes()
          await connectionSettings({ headers: headers, cookies: {} }, res)
          const settings = parse(res)
          assert.equal(Object.prototype.hasOwnProperty.call(settings, 'userToken'), expected)
          assert.equal(Object.prototype.hasOwnProperty.call(settings, 'siteToken'), expected)
          assert.equal(Object.keys(settings.getUserDataHeaders).length === 1, expected)
          assert.equal(Object.keys(settings.appStore.headers).length === 1, expected)
        })
      }
    }
  }

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

  test('boolean true is rejected with a one-time warning and falls back to false', async (t) => {
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

  test('the string "true" is rejected too', async (t) => {
    t.mock.method(console, 'warn', () => {})
    withTrustProxy(t, 'true')
    assert.equal(HAXCMS.getTrustProxySetting(), false)
  })

  test('hop counts, IP/CIDR strings and lists are accepted', async (t) => {
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

  test('non-IAM deployments are always allowed (default behaviour unchanged)', async () => {
    assert.deepEqual(
      HAXCMS.validateIAMRouteAuthorization(true, { headers: {}, cookies: {} }),
      { allowed: true, status: 200, message: '' },
    )
    assert.equal(HAXCMS.isIAMEnabled(), false)
  })

  test('IAM requires an authenticated user', async (t) => {
    withIAM(t, '/srv/haxiam/')
    const result = HAXCMS.validateIAMRouteAuthorization(true, { headers: {}, cookies: {}, originalUrl: '/system/api/v1/x' })
    assert.equal(result.allowed, false)
    assert.equal(result.status, 403)
    assert.equal(result.message, 'Access denied')
    assert.equal(HAXCMS.validateIAMRouteAuthorization(false, { headers: {}, cookies: {} }).allowed, true)
  })

  test('IAM binds the authenticated user to the tenant from HAXCMS_ROOT', async (t) => {
    withIAM(t, '/var/www/users/' + ACTIVE_USER + '/')
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, bearer(ACTIVE_USER)).allowed, true)
    // different tenant root -> denied
    HAXCMS.HAXCMS_ROOT = '/var/www/users/someone-else/'
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, bearer(ACTIVE_USER)).allowed, false)
  })

  test('IAM denies when the tenant root and the request path user disagree', async (t) => {
    withIAM(t, '/var/www/users/' + ACTIVE_USER + '/')
    const req = bearer(ACTIVE_USER, '/other-tenant/system/api/v1/session')
    assert.equal(HAXCMS.getRequestPathUserName(req), 'other-tenant')
    assert.equal(HAXCMS.validateIAMRouteAuthorization(true, req).allowed, false)
  })

  test('IAM falls back to the request path tenant and ignores /system paths', async (t) => {
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

// ---------------------------------------------------------------------------
// review follow-ups: concurrent-tab grace path, host-only origin check, and
// request tokens on successful session responses
// ---------------------------------------------------------------------------
describe('concurrent tabs refreshing with the same cookie (grace path)', () => {
  async function refreshWith(cookie) {
    const res = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: cookie } }, res)
    return res
  }

  for (const order of ['A-first', 'B-first']) {
    test('both tabs get the same successor and whichever cookie is kept still works (' + order + ')', async (t) => {
      const storePath = isolateStore(t)
      const login = realLogin(t)
      // tabs A and B both send the SAME old cookie; the server processes one
      // first (current-jti path), the other second (previous-within-grace path)
      const first = await refreshWith(login.cookie)
      const second = await refreshWith(login.cookie)
      assert.equal(first.body.status, 200)
      assert.equal(second.body.status, 200)
      const cookieFirst = lastCookie(first)
      const cookieSecond = lastCookie(second)
      const jtiFirst = HAXCMS.decodeRefreshToken(cookieFirst).jti
      const jtiSecond = HAXCMS.decodeRefreshToken(cookieSecond).jti
      assert.equal(jtiFirst, jtiSecond, 'deterministic successor: same jti for both tabs')
      // the browser keeps whichever Set-Cookie arrived LAST
      const kept = order === 'A-first' ? cookieSecond : cookieFirst
      const next = await refreshWith(kept)
      assert.equal(next.body.status, 200, 'kept cookie still refreshes')
      const store = readStore(storePath)
      const fam = HAXCMS.decodeRefreshToken(kept).family
      assert.notEqual(store.users[ACTIVE_USER].families[fam].revoked, true, 'family not tombstoned')
      // and the chain continues normally
      const after = await refreshWith(lastCookie(next))
      assert.equal(after.body.status, 200)
    })
  }

  test('the grace-path accept leaves current/previous untouched', (t) => {
    const storePath = isolateStore(t)
    const x = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    assert.ok(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), x))
    const before = readStore(storePath).users[ACTIVE_USER].families[x.family]
    assert.ok(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), x))
    const afterEntry = readStore(storePath).users[ACTIVE_USER].families[x.family]
    assert.equal(afterEntry.currentJtiHash, before.currentJtiHash)
    assert.equal(afterEntry.previousJtiHash, before.previousJtiHash)
    assert.equal(afterEntry.previousValidUntil, before.previousValidUntil)
    assert.equal(afterEntry.currentJtiHash, HAXCMS._hashJti(HAXCMS.successorJti(x.family, x.jti)))
  })

  test('a token outside the grace slot is still a stale replay', (t) => {
    isolateStore(t)
    const x = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(ACTIVE_USER))
    const r1 = fakeRes()
    HAXCMS.rotateRefreshTokenAndCookie(r1, x)
    const y = HAXCMS.decodeRefreshToken(lastCookie(r1))
    HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), y)
    assert.equal(HAXCMS.checkRefreshSession(x).reason, 'stale_jti')
    assert.equal(HAXCMS.rotateRefreshTokenAndCookie(fakeRes(), x), null)
  })
})

describe('host-only same-origin comparison', () => {
  test('TLS-terminating proxy without trusted proxies: server sees http, Origin is https', async (t) => {
    isolateStore(t)
    t.mock.method(HAXCMS, 'resolveTrustedProtocol', () => 'http')
    t.mock.method(HAXCMS, 'resolveTrustedHost', () => 'cms.example.com')
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { origin: 'https://cms.example.com' } }), true)
    const login = realLogin(t)
    const res = fakeRes()
    await connectionTest({
      headers: { origin: 'https://cms.example.com' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.body.authenticated, true)
  })

  test('Apache plain http with protossl forced: server says https, Origin is http', async (t) => {
    isolateStore(t)
    t.mock.method(HAXCMS, 'resolveTrustedProtocol', () => 'https')
    t.mock.method(HAXCMS, 'resolveTrustedHost', () => 'cms.example.com:8080')
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { referer: 'http://cms.example.com:8080/x' } }), true)
    const login = realLogin(t)
    const res = fakeRes()
    await refreshAccessToken({
      headers: { origin: 'http://cms.example.com:8080' },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.body.status, 200)
  })

  test('host or port mismatch is still rejected', (t) => {
    t.mock.method(HAXCMS, 'resolveTrustedHost', () => 'cms.example.com')
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { origin: 'https://cms.example.com:4443' } }), false)
    assert.equal(HAXCMS.isSameOriginRequest({ headers: { origin: 'https://evil.example' } }), false)
  })
})

describe('request tokens on successful session responses', () => {
  const userToken = () => HAXCMS.getRequestToken(ACTIVE_USER)
  const siteToken = (name) => HAXCMS.getRequestToken(ACTIVE_USER + ':' + name)

  test('login returns userToken alongside the jwt', (t) => {
    isolateStore(t)
    t.mock.method(HAXCMS, 'testLogin', () => true)
    const res = fakeRes()
    loginRoute({ body: { username: ACTIVE_USER, password: 'x' }, headers: {}, ip: '10.8.8.8' }, res)
    assert.equal(res.body.status, 200)
    assert.ok(res.body.jwt)
    assert.equal(res.body.userToken, userToken())
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'siteToken'), false)
  })

  test('refresh returns userToken and a siteToken resolved from the Referer path', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const res = fakeRes()
    await refreshAccessToken({
      headers: {
        host: 'cms.example.com',
        referer: 'http://cms.example.com' + HAXCMS.basePath + HAXCMS.sitesDirectory + '/my-site/page',
      },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.userToken, userToken())
    assert.equal(res.body.siteToken, siteToken('my-site'))
  })

  test('refresh resolves the site from the body before the Referer, and omits siteToken without context', async (t) => {
    isolateStore(t)
    const login = realLogin(t)
    const res = fakeRes()
    await refreshAccessToken({
      headers: {},
      body: { site: { name: 'body-site' } },
      cookies: { haxcms_refresh_token: login.cookie },
    }, res)
    assert.equal(res.body.siteToken, siteToken('body-site'))
    const bare = fakeRes()
    await refreshAccessToken({ headers: {}, cookies: { haxcms_refresh_token: lastCookie(res) } }, bare)
    assert.equal(bare.body.status, 200)
    assert.equal(bare.body.userToken, userToken())
    assert.equal(Object.prototype.hasOwnProperty.call(bare.body, 'siteToken'), false)
  })

  test('unsafe site names are ignored rather than tokenized', async () => {
    assert.equal(await HAXCMS.resolveSessionSiteName({ body: { site: { name: '../etc' } }, headers: {} }), '')
    assert.equal(await HAXCMS.resolveSessionSiteName({ query: { siteName: 'ok_name-1' }, headers: {} }), 'ok_name-1')
  })

  test('authenticated connection-test (bearer) returns userToken and siteToken', async (t) => {
    isolateStore(t)
    const res = fakeRes()
    await connectionTest({
      headers: {
        authorization: 'Bearer ' + HAXCMS.getJWT(ACTIVE_USER),
        referer: 'http://cms.example.com' + HAXCMS.basePath + HAXCMS.sitesDirectory + '/ct-site/',
      },
      cookies: {},
    }, res)
    assert.equal(res.body.authenticated, true)
    assert.equal(res.body.userToken, userToken())
    assert.equal(res.body.siteToken, siteToken('ct-site'))
  })

  test('anonymous / failed connection-test never carries tokens', async (t) => {
    isolateStore(t)
    const res = fakeRes()
    await connectionTest({ headers: {}, cookies: {} }, res)
    assert.equal(res.body.authenticated, false)
    assert.equal(res.body.userToken, undefined)
    assert.equal(res.body.siteToken, undefined)
  })
})

describe('requireSessionForRequestTokens flag resolution', () => {
  function withConfigValue(t, value) {
    const saved = HAXCMS.config.security ? HAXCMS.config.security.requireSessionForRequestTokens : undefined
    if (!HAXCMS.config.security) {
      HAXCMS.config.security = {}
    }
    if (value === undefined) {
      delete HAXCMS.config.security.requireSessionForRequestTokens
    } else {
      HAXCMS.config.security.requireSessionForRequestTokens = value
    }
    t.after(() => {
      if (saved === undefined) {
        delete HAXCMS.config.security.requireSessionForRequestTokens
      } else {
        HAXCMS.config.security.requireSessionForRequestTokens = saved
      }
    })
  }

  test('defaults to false', (t) => {
    withRequireSessionFlag(t, null)
    withConfigValue(t, undefined)
    assert.equal(HAXCMS.getRequireSessionForRequestTokens(), false)
  })

  test('config.json value true turns it on', (t) => {
    withRequireSessionFlag(t, null)
    withConfigValue(t, true)
    assert.equal(HAXCMS.getRequireSessionForRequestTokens(), true)
  })

  test('env override wins over config (truthy 1/true/yes, anything else false)', (t) => {
    withConfigValue(t, true)
    withRequireSessionFlag(t, '0')
    assert.equal(HAXCMS.getRequireSessionForRequestTokens(), false)
    process.env.HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS = 'no'
    assert.equal(HAXCMS.getRequireSessionForRequestTokens(), false)
    withConfigValue(t, false)
    for (const v of ['1', 'true', 'TRUE', 'yes', ' Yes ']) {
      process.env.HAXCMS_REQUIRE_SESSION_FOR_REQUEST_TOKENS = v
      assert.equal(HAXCMS.getRequireSessionForRequestTokens(), true, v)
    }
  })
})
