'use strict'

// Unit tests for the four auth/session system routes:
//   session.js, logout.js, refreshAccessToken.js, connectionTest.js
//
// These target the edge cases the e2e login/logout suite can't reach with a
// real browser: expired access tokens, malformed refresh cookies, replayed
// refresh tokens (rotation rejection), cross-origin refresh attempts, and IAM
// denial. Access/refresh tokens are minted with the real HAXCMS JWT helpers
// (real crypto, real clock checks); only the file-backed refresh-session
// store writers/validators are mocked so tests stay hermetic.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const { describe } = require('node:test')
const assert = require('node:assert/strict')
const JWT = require('jsonwebtoken')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const sessionRoute = require('../../src/systemRoutes/v1/routes/session.js')
const logoutRoute = require('../../src/systemRoutes/v1/routes/logout.js')
const refreshAccessToken = require('../../src/systemRoutes/v1/routes/refreshAccessToken.js')
const connectionTest = require('../../src/systemRoutes/v1/routes/connectionTest.js')

const ACTIVE_USER = HAXCMS.getActiveUserName()

function authRes() {
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

function bearerReq(jwt, cookies) {
  return {
    headers: { authorization: 'Bearer ' + jwt },
    cookies: cookies || {},
  }
}

function refreshReq(token, headers) {
  return {
    headers: headers || {},
    cookies: { haxcms_refresh_token: token },
  }
}

function mintAccessToken(user) {
  return HAXCMS.getJWT(user)
}

// same signing key + claims shape as getJWT, but exp in the past (beyond the
// 60s clockTolerance) so decodeJWT/validateJWT reject it for real
function mintExpiredAccessToken(user) {
  const now = Math.floor(Date.now() / 1000)
  return JWT.sign(
    {
      id: HAXCMS.getRequestToken('user'),
      user: user,
      iat: now - 3600,
      exp: now - 1800,
    },
    HAXCMS.privateKey + HAXCMS.salt,
  )
}

// same signing key + claims shape as getRefreshToken, but exp in the past
function mintExpiredRefreshToken(user) {
  const now = Math.floor(Date.now() / 1000)
  return JWT.sign(
    {
      user: user,
      iat: now - 48 * 60 * 60,
      exp: now - 24 * 60 * 60,
    },
    HAXCMS.refreshPrivateKey + HAXCMS.salt,
  )
}

function assertCookieCleared(res, expectedWrites) {
  const expected = typeof expectedWrites === 'number' ? expectedWrites : 1
  assert.equal(res.cookies.length, expected, expected + ' cookie write(s) expected')
  for (let i = 0; i < res.cookies.length; i++) {
    assert.equal(res.cookies[i].name, 'haxcms_refresh_token')
    assert.equal(res.cookies[i].value, '')
    assert.equal(res.cookies[i].options.maxAge, 1)
  }
}

// the singleton has no validateIAMRouteAuthorization, so t.mock.method cannot
// attach it (it only wraps existing methods); define + restore it directly
function mockIAMAuthorization(t, impl) {
  const original = HAXCMS.validateIAMRouteAuthorization
  HAXCMS.validateIAMRouteAuthorization = impl
  t.after(() => {
    if (original === undefined) {
      delete HAXCMS.validateIAMRouteAuthorization
    } else {
      HAXCMS.validateIAMRouteAuthorization = original
    }
  })
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------
describe('session', () => {
  test('missing Authorization header answers 401 missing_jwt', () => {
    const res = authRes()
    sessionRoute({ headers: {} }, res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.authenticated, false)
    assert.equal(res.body.reason, 'missing_jwt')
  })

  test('non-bearer Authorization header answers 401 missing_jwt', () => {
    const res = authRes()
    sessionRoute({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }, res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.reason, 'missing_jwt')
  })

  test('an expired bearer token answers 401 invalid_jwt', () => {
    const res = authRes()
    sessionRoute(bearerReq(mintExpiredAccessToken(ACTIVE_USER)), res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.reason, 'invalid_jwt')
    assert.equal(res.body.message, 'Authentication failed')
  })

  test('a wrong-signature bearer token answers 401 invalid_jwt', () => {
    const now = Math.floor(Date.now() / 1000)
    const forged = JWT.sign(
      { id: HAXCMS.getRequestToken('user'), user: ACTIVE_USER, iat: now, exp: now + 60 },
      'attacker-controlled-secret',
    )
    const res = authRes()
    sessionRoute(bearerReq(forged), res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.reason, 'invalid_jwt')
  })

  test('a valid bearer token answers 200 with the token and user', () => {
    const token = mintAccessToken(ACTIVE_USER)
    const res = authRes()
    sessionRoute(bearerReq(token), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.authenticated, true)
    assert.equal(res.body.jwt, token)
    assert.equal(res.body.user, ACTIVE_USER)
  })

  test('a lowercase bearer prefix is still accepted', () => {
    const token = mintAccessToken(ACTIVE_USER)
    const res = authRes()
    sessionRoute(
      { headers: { authorization: 'bearer ' + token }, cookies: {} },
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(res.body.authenticated, true)
  })

  test('IAM denial answers 403 not_authorized', (t) => {
    mockIAMAuthorization(t, () => ({
      allowed: false,
      status: 403,
      message: 'Access denied',
    }))
    const res = authRes()
    sessionRoute(bearerReq(mintAccessToken(ACTIVE_USER)), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.authenticated, false)
    assert.equal(res.body.reason, 'not_authorized')
    assert.equal(res.body.message, 'Access denied')
  })

  test('an IAM validation crash answers 403 Access denied', (t) => {
    mockIAMAuthorization(t, () => {
      throw new Error('IAM backend unreachable')
    })
    const res = authRes()
    sessionRoute(bearerReq(mintAccessToken(ACTIVE_USER)), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.reason, 'not_authorized')
    assert.equal(res.body.message, 'Access denied')
  })
})

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------
describe('logout', () => {
  test('logout without cookies clears the refresh cookie and answers loggedout', () => {
    const res = authRes()
    logoutRoute({ headers: {} }, res)
    assert.equal(res.statusCode, null)
    assert.deepEqual(res.body, { status: 200, data: 'loggedout' })
    assertCookieCleared(res)
  })

  test('logout revokes the refresh family of a valid refresh cookie', (t) => {
    const revoked = []
    t.mock.method(HAXCMS, 'revokeRefreshSession', (user) => {
      revoked.push(user)
    })
    const res = authRes()
    logoutRoute(refreshReq(HAXCMS.getRefreshToken(ACTIVE_USER, false)), res)
    assert.deepEqual(res.body, { status: 200, data: 'loggedout' })
    assert.deepEqual(revoked, [ACTIVE_USER])
    assertCookieCleared(res)
  })

  test('logout with a malformed refresh cookie stays 200 without revoking', (t) => {
    const revoked = []
    t.mock.method(HAXCMS, 'revokeRefreshSession', (user) => {
      revoked.push(user)
    })
    const res = authRes()
    logoutRoute(refreshReq('not.a.jwt'), res)
    assert.deepEqual(res.body, { status: 200, data: 'loggedout' })
    assert.deepEqual(revoked, [])
    assertCookieCleared(res)
  })

  test('logout with a refresh cookie that carries no user does not revoke', (t) => {
    const revoked = []
    t.mock.method(HAXCMS, 'revokeRefreshSession', (user) => {
      revoked.push(user)
    })
    const res = authRes()
    // token minted without a user: decodes, but decoded.user is falsy
    logoutRoute(refreshReq(HAXCMS.getRefreshToken(null, false)), res)
    assert.deepEqual(res.body, { status: 200, data: 'loggedout' })
    assert.deepEqual(revoked, [])
    assertCookieCleared(res)
  })

  test('logout ignores a decoding crash and still clears the cookie', (t) => {
    t.mock.method(HAXCMS, 'decodeRefreshToken', () => {
      throw new Error('decode blew up')
    })
    const res = authRes()
    logoutRoute(refreshReq('anything'), res)
    assert.deepEqual(res.body, { status: 200, data: 'loggedout' })
    assertCookieCleared(res)
  })
})

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------
describe('refreshAccessToken', () => {
  function mockTrustedOrigin(t) {
    t.mock.method(HAXCMS, 'resolveTrustedProtocol', () => 'https')
    t.mock.method(HAXCMS, 'resolveTrustedHost', () => 'cms.example.com')
  }

  test('no Origin or Referer header proceeds to token validation', () => {
    const res = authRes()
    refreshAccessToken({ headers: {}, cookies: {} }, res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.data.message, 'Refresh token validation failed')
    assertCookieCleared(res)
  })

  test('a matching Origin proceeds to token validation', (t) => {
    mockTrustedOrigin(t)
    const res = authRes()
    refreshAccessToken(
      { headers: { origin: 'https://cms.example.com' }, cookies: {} },
      res,
    )
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.data.message, 'Refresh token validation failed')
  })

  test('a mismatched Origin host answers 403 Cross-origin request denied', (t) => {
    mockTrustedOrigin(t)
    const res = authRes()
    refreshAccessToken(
      { headers: { origin: 'https://evil.example' }, cookies: {} },
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Cross-origin request denied')
    assertCookieCleared(res)
  })

  test('a mismatched Origin protocol answers 403', (t) => {
    mockTrustedOrigin(t)
    const res = authRes()
    refreshAccessToken(
      { headers: { origin: 'http://cms.example.com' }, cookies: {} },
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Cross-origin request denied')
  })

  test('Referer is checked when Origin is absent', (t) => {
    mockTrustedOrigin(t)
    const res = authRes()
    refreshAccessToken(
      { headers: { referer: 'https://evil.example/attack' }, cookies: {} },
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Cross-origin request denied')
  })

  test('a malformed Origin value answers 403', (t) => {
    mockTrustedOrigin(t)
    const res = authRes()
    refreshAccessToken(
      { headers: { origin: 'not a url at all' }, cookies: {} },
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Cross-origin request denied')
  })

  test('no refresh cookie answers 401 with the cookie cleared', () => {
    const res = authRes()
    refreshAccessToken({ headers: {}, cookies: {} }, res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.data.message, 'Refresh token validation failed')
    assertCookieCleared(res)
  })

  test('a malformed refresh cookie answers 401', () => {
    const res = authRes()
    refreshAccessToken(refreshReq('garbage.value.here'), res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.data.message, 'Refresh token validation failed')
    assertCookieCleared(res)
  })

  test('an expired refresh cookie answers 401', () => {
    const res = authRes()
    refreshAccessToken(refreshReq(mintExpiredRefreshToken(ACTIVE_USER)), res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.data.message, 'Refresh token validation failed')
    assertCookieCleared(res)
  })

  test('a valid refresh token rotates and answers 200 with a fresh access JWT', (t) => {
    const rotated = []
    t.mock.method(HAXCMS, 'rotateRefreshTokenAndCookie', (res, decodedRefresh) => {
      rotated.push(decodedRefresh.user)
      return 'rotated-access-jwt'
    })
    const res = authRes()
    refreshAccessToken(refreshReq(HAXCMS.getRefreshToken(ACTIVE_USER, false)), res)
    assert.equal(res.statusCode, null)
    assert.deepEqual(res.body, { status: 200, jwt: 'rotated-access-jwt' })
    assert.deepEqual(rotated, [ACTIVE_USER])
  })

  test('a replayed refresh token (rotation rejected) revokes the family and answers 401', (t) => {
    const revoked = []
    t.mock.method(HAXCMS, 'rotateRefreshTokenAndCookie', () => null)
    t.mock.method(HAXCMS, 'revokeRefreshSession', (user) => {
      revoked.push(user)
    })
    const res = authRes()
    refreshAccessToken(refreshReq(HAXCMS.getRefreshToken(ACTIVE_USER, false)), res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.data.message, 'Refresh token validation failed')
    assert.deepEqual(revoked, [ACTIVE_USER])
    assertCookieCleared(res)
  })

  test('a rejected rotation without a decoded user skips revocation', (t) => {
    const revoked = []
    t.mock.method(HAXCMS, 'rotateRefreshTokenAndCookie', () => null)
    t.mock.method(HAXCMS, 'revokeRefreshSession', (user) => {
      revoked.push(user)
    })
    const res = authRes()
    // decodes, but the decoded payload has no user so revoke is skipped
    refreshAccessToken(refreshReq(HAXCMS.getRefreshToken(null, false)), res)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(revoked, [])
    assertCookieCleared(res)
  })
})

// ---------------------------------------------------------------------------
// connectionTest
// ---------------------------------------------------------------------------
describe('connectionTest', () => {
  test('an anonymous probe answers 200 no_session with Cache-Control no-store', () => {
    const res = authRes()
    connectionTest({ headers: {}, cookies: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.authenticated, false)
    assert.equal(res.body.reason, 'no_session')
    assert.equal(res.body.message, 'No active session')
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assertCookieCleared(res)
  })

  test('an expired bearer token answers 401 invalid_session', () => {
    const res = authRes()
    connectionTest(bearerReq(mintExpiredAccessToken(ACTIVE_USER)), res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.authenticated, false)
    assert.equal(res.body.reason, 'invalid_session')
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assertCookieCleared(res)
  })

  test('a valid bearer token answers 200 with the token and the user', () => {
    const token = mintAccessToken(ACTIVE_USER)
    const res = authRes()
    connectionTest(bearerReq(token), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.authenticated, true)
    assert.equal(res.body.refreshed, false)
    assert.equal(res.body.jwt, token)
    assert.equal(res.body.user, ACTIVE_USER)
  })

  test('a malformed refresh cookie answers 200 no_session when no bearer was supplied', () => {
    const res = authRes()
    connectionTest(refreshReq('garbage.value.here'), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.reason, 'no_session')
    assertCookieCleared(res)
  })

  test('refresh-cookie recovery rotates and answers 200 refreshed', (t) => {
    const rotated = []
    t.mock.method(HAXCMS, 'rotateRefreshTokenAndCookie', (res, decodedRefresh) => {
      rotated.push(decodedRefresh.user)
      return 'recovered-access-jwt'
    })
    const res = authRes()
    connectionTest(refreshReq(HAXCMS.getRefreshToken(ACTIVE_USER, false)), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.authenticated, true)
    assert.equal(res.body.refreshed, true)
    assert.equal(res.body.jwt, 'recovered-access-jwt')
    assert.deepEqual(rotated, [ACTIVE_USER])
  })

  test('a revoked refresh family is rejected, revoked, and cleared', (t) => {
    const revoked = []
    t.mock.method(HAXCMS, 'validateRefreshSession', () => false)
    t.mock.method(HAXCMS, 'revokeRefreshSession', (user) => {
      revoked.push(user)
    })
    // a supplied-but-stale bearer plus a revoked refresh family answers 401
    // invalid_session, revokes the family again, and clears the cookie
    const res = authRes()
    connectionTest(
      bearerReq(mintExpiredAccessToken(ACTIVE_USER), {
        haxcms_refresh_token: HAXCMS.getRefreshToken(ACTIVE_USER, false),
      }),
      res,
    )
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.reason, 'invalid_session')
    assert.deepEqual(revoked, [ACTIVE_USER])
    // recovery-failure clear + the final no-session clear: both are clears
    assertCookieCleared(res, 2)
  })

  test('refresh recovery for an unknown user answers no session', () => {
    const res = authRes()
    connectionTest(refreshReq(HAXCMS.getRefreshToken('ghost-user', false)), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.reason, 'no_session')
    assertCookieCleared(res)
  })

  test('rotation returning null falls back to a freshly minted access token', (t) => {
    t.mock.method(HAXCMS, 'rotateRefreshTokenAndCookie', () => null)
    t.mock.method(HAXCMS, 'getJWT', (user) => 'fallback-access-jwt')
    const res = authRes()
    connectionTest(refreshReq(HAXCMS.getRefreshToken(ACTIVE_USER, false)), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.authenticated, true)
    assert.equal(res.body.refreshed, true)
    assert.equal(res.body.jwt, 'fallback-access-jwt')
  })

  test('user resolution falls back to the refresh cookie when the JWT has no user', (t) => {
    // validateJWT passes but decodeJWT yields no user: the cookie user wins
    t.mock.method(HAXCMS, 'validateJWT', () => true)
    t.mock.method(HAXCMS, 'decodeJWT', () => ({ exp: 1 }))
    t.mock.method(HAXCMS, 'decodeRefreshToken', () => ({ user: 'cookie-user' }))
    const res = authRes()
    connectionTest(bearerReq('jwt-without-user', {
      haxcms_refresh_token: 'any-cookie-value',
    }), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.authenticated, true)
    assert.equal(res.body.user, 'cookie-user')
  })

  test('IAM denial answers 403 not_authorized', (t) => {
    mockIAMAuthorization(t, () => ({
      allowed: false,
      status: 403,
      message: 'Access denied',
    }))
    const res = authRes()
    connectionTest(bearerReq(mintAccessToken(ACTIVE_USER)), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.authenticated, false)
    assert.equal(res.body.reason, 'not_authorized')
  })
})
