'use strict'

// Unit tests for the HAXCMSClass core helpers in src/lib/HAXCMS.js:
// credential handling, JWT / refresh-token session machinery, rate-limit and
// security settings resolution, machine-name / slug helpers, registry JSON
// loaders, and the misc form/parser helpers.
//
// The HAXCMS singleton is constructed when HAXCMS.js is first required, which
// reads/writes the on-disk config directory at load time. A temp runtime with a
// seeded _config (marked with .isHAXcmsConfig) is created and cwd is moved into
// it BEFORE the first require so config discovery (discoverConfigPath walks up
// from cwd) stays inside the temp tree and never touches the user's home.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const JWT = require('jsonwebtoken')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const TEST_USER_NAME = 'unit-core-user'
const TEST_USER_PASSWORD = 'unit-core-pass'
const GIT_AUTHOR_NAME = 'HAXcms Unit Core'
const GIT_AUTHOR_EMAIL = 'unit-core@local.invalid'

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-unit-core-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')

function seedRuntimeConfig() {
  fs.ensureDirSync(configRoot)
  fs.writeFileSync(path.join(configRoot, '.isHAXcmsConfig'), '')
  const seedFiles = [
    'config.json',
    'my-custom-elements.js',
    'userData.json',
    'config.php',
    '.htaccess',
    '.user-files-htaccess',
  ]
  for (let i = 0; i < seedFiles.length; i++) {
    fs.copySync(
      path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
      path.join(configRoot, seedFiles[i]),
    )
  }
  fs.ensureDirSync(path.join(configRoot, 'tmp'))
  fs.ensureDirSync(path.join(configRoot, 'cache'))
  fs.ensureDirSync(path.join(configRoot, 'user'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'settings'))
  fs.ensureDirSync(path.join(configRoot, 'node_modules'))
}

// intentionally corrupt config.json so the constructor exercises the
// loadConfigJson parse-failure -> boilerplate in-memory fallback branch
fs.ensureDirSync(runtimeRoot)
seedRuntimeConfig()
fs.writeFileSync(path.join(configRoot, 'config.json'), '{ this is not valid json')

// seed a plaintext .user so the constructor takes the loaded-from-disk
// credential path (credentialsLoadedFromDisk = true)
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_PASSWORD }, null, 2),
)

process.chdir(runtimeRoot)
// trailing slash required: HAXCMS.js string-concats HAXCMS_ROOT + sitesDirectory
process.env.HAXCMS_ROOT = runtimeRoot + '/'
process.env.GIT_AUTHOR_NAME = GIT_AUTHOR_NAME
process.env.GIT_AUTHOR_EMAIL = GIT_AUTHOR_EMAIL
process.env.GIT_COMMITTER_NAME = GIT_AUTHOR_NAME
process.env.GIT_COMMITTER_EMAIL = GIT_AUTHOR_EMAIL

const { HAXCMS, HAXCMSClass, HAXCMSSite, systemStructureContext } = require('../../src/lib/HAXCMS.js')

function fakeRes() {
  return {
    statusCode: null,
    headers: {},
    cookies: [],
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    send(body) {
      this.body = body
      return this
    },
    sendStatus(code) {
      this.statusCode = code
      this.body = code
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options })
    },
  }
}

test.after(() => {
  process.chdir(originalCwd)
  delete process.env.HAXCMS_ROOT
  fs.removeSync(tempRoot)
})

// ---------------------------------------------------------------------------
// constructor + config loading branches
// ---------------------------------------------------------------------------
test('constructor loads the plaintext .user from disk and marks credentials loaded from disk', () => {
  assert.equal(HAXCMS.user.name, TEST_USER_NAME)
  assert.equal(HAXCMS.user.password, TEST_USER_PASSWORD)
  assert.equal(HAXCMS.superUser.name, TEST_USER_NAME)
  assert.equal(HAXCMS.credentialsLoadedFromDisk, true)
})

test('constructor falls back to an in-memory config when config.json is corrupt', () => {
  assert.ok(HAXCMS.config && typeof HAXCMS.config === 'object')
  assert.ok(HAXCMS.config.themes && typeof HAXCMS.config.themes === 'object')
  assert.ok(HAXCMS.config.site && HAXCMS.config.site.git)
  assert.ok(HAXCMS.config.security && HAXCMS.config.security.loginRateLimit)
})

test('constructor created the secret files inside the temp config directory', () => {
  assert.ok(fs.pathExistsSync(path.join(configRoot, 'SALT.txt')))
  assert.ok(fs.pathExistsSync(path.join(configRoot, '.pk')))
  assert.ok(fs.pathExistsSync(path.join(configRoot, '.rpk')))
  assert.equal(typeof HAXCMS.salt, 'string')
  assert.equal(typeof HAXCMS.privateKey, 'string')
  assert.equal(typeof HAXCMS.refreshPrivateKey, 'string')
})

test('constructor seeded the expected config directory subdirectories', () => {
  assert.ok(fs.statSync(path.join(configRoot, 'skeletons')).isDirectory())
  assert.ok(fs.statSync(path.join(configRoot, 'user', 'skeletons')).isDirectory())
  assert.ok(fs.statSync(path.join(configRoot, 'settings')).isDirectory())
})

test('systemStructureContext resolves null when no site.json exists at the runtime root', async () => {
  assert.equal(await systemStructureContext(runtimeRoot), null)
})

test('operating context falls back to single because the constructor guard awaits an async probe', () => {
  // systemStructureContext() is async, so !systemStructureContext() is always
  // false at construction time and the else (single) branch runs. Multi-site
  // detection happens later in app.js via systemStructureContext().then().
  assert.equal(HAXCMS.operatingContext, 'single')
  assert.equal(HAXCMS.sitesDirectory, '_sites')
})

// ---------------------------------------------------------------------------
// credential helpers
// ---------------------------------------------------------------------------
test('safeStringCompare is length-safe and constant-time for equal strings', () => {
  assert.equal(HAXCMS.safeStringCompare('abc', 'abc'), true)
  assert.equal(HAXCMS.safeStringCompare('abc', 'abd'), false)
  assert.equal(HAXCMS.safeStringCompare('abc', 'abcd'), false)
  assert.equal(HAXCMS.safeStringCompare(null, 'abc'), false)
  assert.equal(HAXCMS.safeStringCompare('abc', null), false)
})

test('hashPassword returns a scrypt$ hash and round-trips through verifyStoredPassword', () => {
  const hash = HAXCMS.hashPassword('round-trip-pass')
  assert.ok(hash.indexOf('scrypt$') === 0)
  const parts = hash.split('$')
  assert.equal(parts.length, 3)
  assert.equal(HAXCMS.verifyStoredPassword(hash, 'round-trip-pass'), true)
  assert.equal(HAXCMS.verifyStoredPassword(hash, 'wrong-pass'), false)
})

test('hashPassword returns an empty string for empty or non-string input', () => {
  assert.equal(HAXCMS.hashPassword(''), '')
  assert.equal(HAXCMS.hashPassword(null), '')
  assert.equal(HAXCMS.hashPassword(42), '')
})

test('isPasswordHashed only accepts scrypt$-prefixed strings', () => {
  assert.equal(HAXCMS.isPasswordHashed('scrypt$aa$bb'), true)
  assert.equal(HAXCMS.isPasswordHashed('plaintext'), false)
  assert.equal(HAXCMS.isPasswordHashed(null), false)
})

test('verifyStoredPassword rejects malformed hashes and empty inputs', () => {
  assert.equal(HAXCMS.verifyStoredPassword('scrypt$onlyonepart', 'x'), false)
  assert.equal(HAXCMS.verifyStoredPassword('scrypt$zz$zz', 'x'), false)
  assert.equal(HAXCMS.verifyStoredPassword('scrypt$68656c6c6f$', 'x'), false)
  assert.equal(HAXCMS.verifyStoredPassword('', 'x'), false)
  assert.equal(HAXCMS.verifyStoredPassword('stored', ''), false)
})

test('verifyStoredPassword compares legacy plaintext in constant time', () => {
  assert.equal(HAXCMS.verifyStoredPassword('legacy-pass', 'legacy-pass'), true)
  assert.equal(HAXCMS.verifyStoredPassword('legacy-pass', 'other-pass'), false)
})

test('maybeUpgradePlaintextPassword rewrites a plaintext .user with a scrypt hash', () => {
  HAXCMS.user = { name: 'admin', password: 'plain-admin-pass' }
  HAXCMS.credentialsLoadedFromDisk = true
  try {
    HAXCMS.maybeUpgradePlaintextPassword('user', 'plain-admin-pass')
    assert.ok(HAXCMS.isPasswordHashed(HAXCMS.user.password))
    const stored = JSON.parse(fs.readFileSync(path.join(configRoot, '.user'), 'utf8'))
    assert.equal(stored.name, 'admin')
    assert.ok(HAXCMS.isPasswordHashed(stored.password))
  }
  finally {
    HAXCMS.user = { name: TEST_USER_NAME, password: TEST_USER_PASSWORD }
  }
})

test('maybeUpgradePlaintextPassword is a no-op for runtime overrides and non-user accounts', () => {
  HAXCMS.credentialsLoadedFromDisk = false
  assert.doesNotThrow(() => HAXCMS.maybeUpgradePlaintextPassword('user', 'x'))
  HAXCMS.credentialsLoadedFromDisk = true
  assert.doesNotThrow(() => HAXCMS.maybeUpgradePlaintextPassword('superUser', 'x'))
  const before = HAXCMS.user.password
  HAXCMS.maybeUpgradePlaintextPassword('superUser', 'x')
  assert.equal(HAXCMS.user.password, before)
})

test('generateSecurePassword returns a 32-char hex string', () => {
  const password = HAXCMS.generateSecurePassword()
  assert.equal(typeof password, 'string')
  assert.equal(password.length, 32)
  assert.ok(/^[0-9a-f]+$/.test(password))
})

test('hasDefaultCredentials only flags an unhashed admin/admin pair', () => {
  HAXCMS.user = { name: 'admin', password: 'admin' }
  assert.equal(HAXCMS.hasDefaultCredentials(), true)
  HAXCMS.user = { name: 'admin', password: HAXCMS.hashPassword('admin') }
  assert.equal(HAXCMS.hasDefaultCredentials(), false)
  HAXCMS.user = { name: 'other', password: 'admin' }
  assert.equal(HAXCMS.hasDefaultCredentials(), false)
  HAXCMS.user = { name: TEST_USER_NAME, password: TEST_USER_PASSWORD }
  assert.equal(HAXCMS.hasDefaultCredentials(), false)
})

test('shouldAllowDefaultCredentials honors 1/true/yes values only', () => {
  const saved = process.env.HAXCMS_ALLOW_DEFAULT_CREDS
  try {
    const truthy = ['1', 'true', 'YES', 'Yes']
    for (let i = 0; i < truthy.length; i++) {
      process.env.HAXCMS_ALLOW_DEFAULT_CREDS = truthy[i]
      assert.equal(HAXCMS.shouldAllowDefaultCredentials(), true)
    }
    const falsey = ['0', 'false', 'no', '']
    for (let i = 0; i < falsey.length; i++) {
      process.env.HAXCMS_ALLOW_DEFAULT_CREDS = falsey[i]
      assert.equal(HAXCMS.shouldAllowDefaultCredentials(), false)
    }
    delete process.env.HAXCMS_ALLOW_DEFAULT_CREDS
    assert.equal(HAXCMS.shouldAllowDefaultCredentials(), false)
  }
  finally {
    if (saved !== undefined) {
      process.env.HAXCMS_ALLOW_DEFAULT_CREDS = saved
    }
  }
})

test('getRuntimeCredentialOverride reads username/password aliases from the runtime credentials global', () => {
  const savedCreds = globalThis.HAXCMS_RUNTIME_CREDENTIALS
  try {
    globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
      username: 'alias-user',
      password: 'alias-pass',
    }
    assert.deepEqual(HAXCMS.getRuntimeCredentialOverride(), {
      name: 'alias-user',
      password: 'alias-pass',
    })
    globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
      name: 'name-user',
      pass: 'name-pass',
    }
    assert.deepEqual(HAXCMS.getRuntimeCredentialOverride(), {
      name: 'name-user',
      password: 'name-pass',
    })
    globalThis.HAXCMS_RUNTIME_CREDENTIALS = { username: '   ', password: '' }
    assert.equal(HAXCMS.getRuntimeCredentialOverride(), null)
  }
  finally {
    if (savedCreds === undefined) {
      delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
    }
    else {
      globalThis.HAXCMS_RUNTIME_CREDENTIALS = savedCreds
    }
  }
})

test('getRuntimeCredentialOverride falls back to the standalone username/password globals', () => {
  const savedCreds = globalThis.HAXCMS_RUNTIME_CREDENTIALS
  const savedUser = globalThis.HAXCMS_RUNTIME_USERNAME
  const savedPass = globalThis.HAXCMS_RUNTIME_PASSWORD
  try {
    delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
    globalThis.HAXCMS_RUNTIME_USERNAME = 'standalone-user'
    globalThis.HAXCMS_RUNTIME_PASSWORD = 'standalone-pass'
    assert.deepEqual(HAXCMS.getRuntimeCredentialOverride(), {
      name: 'standalone-user',
      password: 'standalone-pass',
    })
    globalThis.HAXCMS_RUNTIME_USERNAME = ''
    assert.equal(HAXCMS.getRuntimeCredentialOverride(), null)
  }
  finally {
    if (savedCreds === undefined) {
      delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
    }
    else {
      globalThis.HAXCMS_RUNTIME_CREDENTIALS = savedCreds
    }
    if (savedUser === undefined) {
      delete globalThis.HAXCMS_RUNTIME_USERNAME
    }
    else {
      globalThis.HAXCMS_RUNTIME_USERNAME = savedUser
    }
    if (savedPass === undefined) {
      delete globalThis.HAXCMS_RUNTIME_PASSWORD
    }
    else {
      globalThis.HAXCMS_RUNTIME_PASSWORD = savedPass
    }
  }
})

test('applyRuntimeCredentialOverride swaps the user in memory and clears the disk flag', () => {
  const savedCreds = globalThis.HAXCMS_RUNTIME_CREDENTIALS
  try {
    globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
      username: 'override-user',
      password: 'override-pass',
    }
    assert.equal(HAXCMS.applyRuntimeCredentialOverride(), true)
    assert.equal(HAXCMS.user.name, 'override-user')
    assert.equal(HAXCMS.user.password, 'override-pass')
    assert.equal(HAXCMS.superUser.name, 'override-user')
    assert.equal(HAXCMS.credentialsLoadedFromDisk, false)
    delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
    assert.equal(HAXCMS.applyRuntimeCredentialOverride(), false)
  }
  finally {
    if (savedCreds === undefined) {
      delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
    }
    else {
      globalThis.HAXCMS_RUNTIME_CREDENTIALS = savedCreds
    }
    HAXCMS.user = { name: TEST_USER_NAME, password: TEST_USER_PASSWORD }
    HAXCMS.superUser = { name: TEST_USER_NAME, password: TEST_USER_PASSWORD }
    HAXCMS.credentialsLoadedFromDisk = true
  }
})

test('testLogin verifies the user account, the super-user fallback, and rejects bad creds', () => {
  assert.equal(HAXCMS.testLogin(TEST_USER_NAME, TEST_USER_PASSWORD), true)
  assert.equal(HAXCMS.testLogin(TEST_USER_NAME, 'wrong'), false)
  assert.equal(HAXCMS.testLogin('ghost', 'nope'), false)
  assert.equal(HAXCMS.testLogin('ghost', 'nope', true), false)
  HAXCMS.superUser = { name: 'super-name', password: 'super-pass' }
  assert.equal(HAXCMS.testLogin('super-name', 'super-pass', true), true)
  assert.equal(HAXCMS.testLogin('super-name', 'super-pass', false), false)
  HAXCMS.superUser = { name: TEST_USER_NAME, password: TEST_USER_PASSWORD }
})

test('validateUser accepts the active and super user names only', () => {
  assert.equal(HAXCMS.validateUser(TEST_USER_NAME), true)
  assert.equal(HAXCMS.validateUser('ghost-user'), false)
})

test('getActiveUserName prefers the user account and falls back to the super user', () => {
  assert.equal(HAXCMS.getActiveUserName(), TEST_USER_NAME)
  const savedUser = HAXCMS.user
  HAXCMS.user = { name: '', password: 'x' }
  assert.equal(HAXCMS.getActiveUserName(), TEST_USER_NAME)
  HAXCMS.user = savedUser
})

// ---------------------------------------------------------------------------
// request tokens + JWT helpers
// ---------------------------------------------------------------------------
test('hmacBase64 produces a url-safe base64 digest without padding', () => {
  const digest = HAXCMS.hmacBase64('payload', 'key')
  assert.equal(typeof digest, 'string')
  assert.ok(digest.indexOf('+') === -1)
  assert.ok(digest.indexOf('/') === -1)
  assert.ok(digest.indexOf('=') === -1)
  assert.ok(digest.length > 0)
})

test('getRequestToken is deterministic for the same value', () => {
  assert.equal(HAXCMS.getRequestToken('user'), HAXCMS.getRequestToken('user'))
  assert.notEqual(HAXCMS.getRequestToken('user'), HAXCMS.getRequestToken('site'))
})

test('validateRequestToken accepts a matching token and a query token fallback', () => {
  const token = HAXCMS.getRequestToken('user')
  assert.equal(HAXCMS.validateRequestToken(token, 'user'), true)
  assert.equal(HAXCMS.validateRequestToken(null, 'user', { token: token }), true)
  assert.equal(HAXCMS.validateRequestToken('wrong', 'user'), false)
  assert.equal(HAXCMS.validateRequestToken(null, 'user', {}), false)
})

test('getJWT returns a signed token that decodes with the expected claims', () => {
  const token = HAXCMS.getJWT('jwt-user')
  const decoded = HAXCMS.decodeJWT(token)
  assert.ok(decoded)
  assert.equal(decoded.user, 'jwt-user')
  assert.equal(decoded.id, HAXCMS.getRequestToken('user'))
  assert.ok(decoded.exp > decoded.iat)
})

test('decodeJWT returns false for garbage and wrong-signature tokens', () => {
  assert.equal(HAXCMS.decodeJWT('not-a-jwt'), false)
  const forged = JWT.sign(
    { id: HAXCMS.getRequestToken('user'), user: 'jwt-user', iat: 1, exp: 9999999999 },
    'attacker-secret',
  )
  assert.equal(HAXCMS.decodeJWT(forged), false)
})

// note: decodeJWT's issued-in-the-future guard is not reachable through
// JWT.sign because jsonwebtoken overwrites the iat claim at signing time; the
// expired-token path is covered below instead.

test('validateJWT accepts the authorization header bearer token for a known user', () => {
  const token = HAXCMS.getJWT(TEST_USER_NAME)
  assert.equal(
    HAXCMS.validateJWT({ headers: { authorization: 'Bearer ' + token } }, null),
    true,
  )
  assert.equal(
    HAXCMS.validateJWT({ headers: { authorization: 'bearer ' + token } }, null),
    true,
  )
})

test('validateJWT rejects missing, malformed, and foreign-user tokens', () => {
  assert.equal(HAXCMS.validateJWT({ headers: {} }, null), false)
  assert.equal(HAXCMS.validateJWT({ headers: { authorization: 'Basic abc' } }, null), false)
  const foreignUser = HAXCMS.getJWT('ghost-user')
  assert.equal(
    HAXCMS.validateJWT({ headers: { authorization: 'Bearer ' + foreignUser } }, null),
    false,
  )
  const now = Math.floor(Date.now() / 1000)
  const expired = JWT.sign(
    {
      id: HAXCMS.getRequestToken('user'),
      user: TEST_USER_NAME,
      iat: now - 3600,
      exp: now - 1800,
    },
    HAXCMS.privateKey + HAXCMS.salt,
  )
  assert.equal(
    HAXCMS.validateJWT({ headers: { authorization: 'Bearer ' + expired } }, null),
    false,
  )
})

test('validateJWT honors the sessionJwt when no header was supplied', () => {
  const savedSession = HAXCMS.sessionJwt
  try {
    HAXCMS.sessionJwt = HAXCMS.getJWT(TEST_USER_NAME)
    assert.equal(HAXCMS.validateJWT({ headers: {} }, null), true)
  }
  finally {
    HAXCMS.sessionJwt = savedSession
  }
})

test('validateJWT and validateRequestToken short-circuit when JWT checks are disabled', () => {
  HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = true
  try {
    assert.equal(HAXCMS.validateJWT({}, null), true)
    assert.equal(HAXCMS.validateRequestToken(null, 'user'), true)
  }
  finally {
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = false
  }
})

// ---------------------------------------------------------------------------
// refresh tokens + refresh sessions
// ---------------------------------------------------------------------------
test('getRefreshToken records a family/jti session when storeRefreshSession is true', () => {
  const signed = HAXCMS.getRefreshToken('refresh-user', true)
  const decoded = HAXCMS.decodeRefreshToken(signed)
  assert.ok(decoded)
  assert.equal(decoded.user, 'refresh-user')
  assert.ok(decoded.family)
  assert.ok(decoded.jti)
  const store = JSON.parse(
    fs.readFileSync(HAXCMS.getRefreshSessionsPath(), 'utf8'),
  )
  assert.ok(store['refresh-user'])
  assert.equal(store['refresh-user'].family, decoded.family)
  assert.equal(store['refresh-user'].currentJtiHash, HAXCMS._hashJti(decoded.jti))
})

test('getRefreshToken without a session store skips the family/jti claims', () => {
  const signed = HAXCMS.getRefreshToken('refresh-user', false)
  const decoded = HAXCMS.decodeRefreshToken(signed)
  assert.ok(decoded)
  assert.equal(decoded.family, undefined)
  assert.equal(decoded.jti, undefined)
})

test('decodeRefreshToken returns false for garbage input', () => {
  assert.equal(HAXCMS.decodeRefreshToken('garbage'), false)
})

test('validateRefreshToken accepts a valid cookie token and returns the decoded payload', () => {
  const signed = HAXCMS.getRefreshToken('refresh-user', true)
  const req = { cookies: { haxcms_refresh_token: signed } }
  const decoded = HAXCMS.validateRefreshToken(false, req, null)
  assert.ok(decoded)
  assert.equal(decoded.user, 'refresh-user')
})

test('validateRefreshToken clears the cookie and 401s when the cookie is missing or invalid', () => {
  const res = fakeRes()
  assert.equal(HAXCMS.validateRefreshToken(true, { cookies: {} }, res), false)
  assert.equal(res.statusCode, 401)
  assert.equal(res.cookies.length, 1)
  assert.equal(res.cookies[0].name, 'haxcms_refresh_token')
  assert.equal(res.cookies[0].value, '')
  const resBad = fakeRes()
  assert.equal(
    HAXCMS.validateRefreshToken(true, { cookies: { haxcms_refresh_token: 'garbage' } }, resBad),
    false,
  )
  assert.equal(resBad.statusCode, 401)
  const resNoEnd = fakeRes()
  assert.equal(
    HAXCMS.validateRefreshToken(false, { cookies: { haxcms_refresh_token: 'garbage' } }, resNoEnd),
    false,
  )
  assert.equal(resNoEnd.statusCode, null)
})

test('validateRefreshToken short-circuits when JWT checks are disabled', () => {
  HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = true
  try {
    assert.equal(HAXCMS.validateRefreshToken(true, { cookies: {} }, null), true)
  }
  finally {
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = false
  }
})

test('setRefreshTokenCookie writes the options and maxAge onto the response', () => {
  const res = fakeRes()
  HAXCMS.setRefreshTokenCookie(res, 'cookie-value', 12345)
  assert.equal(res.cookies.length, 1)
  assert.equal(res.cookies[0].name, 'haxcms_refresh_token')
  assert.equal(res.cookies[0].value, 'cookie-value')
  assert.equal(res.cookies[0].options.maxAge, 12345)
  assert.equal(res.cookies[0].options.httpOnly, true)
  assert.equal(res.cookies[0].options.sameSite, 'lax')
  const noMaxAgeRes = fakeRes()
  HAXCMS.setRefreshTokenCookie(noMaxAgeRes, 'x')
  assert.equal(noMaxAgeRes.cookies[0].options.maxAge, undefined)
  assert.doesNotThrow(() => HAXCMS.setRefreshTokenCookie(null, 'x', 1))
})

test('rotateRefreshSession rejects a stale jti, revokes the family, then accepts a fresh seed', () => {
  const user = 'rotate-user'
  const first = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(user, true))
  const secondSigned = HAXCMS.getRefreshToken(user, true)
  const second = HAXCMS.decodeRefreshToken(secondSigned)
  // rotating with the second jti while the store still expects the first
  const third = 'jti-three'
  assert.equal(
    HAXCMS.rotateRefreshSession(user, second.family, second.jti, third, 9999999999),
    true,
  )
  // the original (now previous, within grace) still validates
  assert.equal(HAXCMS.validateRefreshSession(user, second.family, second.jti), true)
  // replaying the first jti (outside the stored family position) revokes
  assert.equal(
    HAXCMS.rotateRefreshSession(user, second.family, first.jti, 'jti-four', 9999999999),
    false,
  )
  const store = JSON.parse(fs.readFileSync(HAXCMS.getRefreshSessionsPath(), 'utf8'))
  assert.equal(store[user], undefined)
})

test('rotateRefreshSession rejects incomplete arguments and seeds a missing store entry', () => {
  assert.equal(HAXCMS.rotateRefreshSession(null, 'f', 'a', 'b', 1), false)
  assert.equal(HAXCMS.rotateRefreshSession('user', null, 'a', 'b', 1), false)
  assert.equal(HAXCMS.rotateRefreshSession('user', 'f', null, 'b', 1), false)
  assert.equal(HAXCMS.rotateRefreshSession('user', 'f', 'a', null, 1), false)
  assert.equal(
    HAXCMS.rotateRefreshSession('legacy-user', 'legacy-family', 'legacy-jti', 'legacy-next', 9999999999),
    true,
  )
})

test('validateRefreshSession accepts legacy tokens without family/jti and rejects family mismatches', () => {
  assert.equal(HAXCMS.validateRefreshSession(null, 'f', 'j'), true)
  assert.equal(HAXCMS.validateRefreshSession('no-store-user', 'f', 'j'), true)
  const user = 'validate-user'
  const signed = HAXCMS.getRefreshToken(user, true)
  const decoded = HAXCMS.decodeRefreshToken(signed)
  assert.equal(HAXCMS.validateRefreshSession(user, decoded.family, decoded.jti), true)
  assert.equal(HAXCMS.validateRefreshSession(user, 'wrong-family', decoded.jti), false)
  assert.equal(HAXCMS.validateRefreshSession(user, decoded.family, 'wrong-jti'), false)
})

test('recordRefreshSession skips incomplete inputs', () => {
  const storePath = HAXCMS.getRefreshSessionsPath()
  const before = fs.readFileSync(storePath, 'utf8')
  HAXCMS.recordRefreshSession(null, 'f', 'j', 1)
  HAXCMS.recordRefreshSession('user', null, 'j', 1)
  HAXCMS.recordRefreshSession('user', 'f', null, 1)
  assert.equal(fs.readFileSync(storePath, 'utf8'), before)
})

test('revokeRefreshSession removes the stored family for the user only', () => {
  const user = 'revoke-user'
  HAXCMS.getRefreshToken(user, true)
  const store = JSON.parse(fs.readFileSync(HAXCMS.getRefreshSessionsPath(), 'utf8'))
  assert.ok(store[user])
  HAXCMS.revokeRefreshSession(user)
  const afterStore = JSON.parse(fs.readFileSync(HAXCMS.getRefreshSessionsPath(), 'utf8'))
  assert.equal(afterStore[user], undefined)
  HAXCMS.revokeRefreshSession(null)
  HAXCMS.revokeRefreshSession('never-existed-user')
  assert.ok(afterStore)
})

test('_saveRefreshSessions prunes expired entries when writing', () => {
  const user = 'prune-user'
  HAXCMS.getRefreshToken(user, true)
  const store = JSON.parse(fs.readFileSync(HAXCMS.getRefreshSessionsPath(), 'utf8'))
  store[user].exp = 1
  HAXCMS._saveRefreshSessions(store)
  const afterStore = JSON.parse(fs.readFileSync(HAXCMS.getRefreshSessionsPath(), 'utf8'))
  assert.equal(afterStore[user], undefined)
})

test('rotateRefreshTokenAndCookie rotates a valid decoded refresh and returns a fresh access JWT', () => {
  const user = 'rotate-cookie-user'
  const signed = HAXCMS.getRefreshToken(user, true)
  const decoded = HAXCMS.decodeRefreshToken(signed)
  const res = fakeRes()
  const access = HAXCMS.rotateRefreshTokenAndCookie(res, decoded)
  assert.ok(access)
  const accessDecoded = HAXCMS.decodeJWT(access)
  assert.equal(accessDecoded.user, user)
  assert.equal(res.cookies.length, 1)
  assert.equal(res.cookies[0].name, 'haxcms_refresh_token')
  assert.ok(res.cookies[0].value.length > 0)
  assert.equal(HAXCMS.rotateRefreshTokenAndCookie(res, null), null)
  assert.equal(HAXCMS.rotateRefreshTokenAndCookie(res, { user: null }), null)
})

test('rotateRefreshTokenAndCookie revokes the family on an unknown same-family jti', () => {
  const user = 'rotate-rejected-user'
  const decoded = HAXCMS.decodeRefreshToken(HAXCMS.getRefreshToken(user, true))
  // rotating with the current jti is accepted
  const resOne = fakeRes()
  assert.ok(HAXCMS.rotateRefreshTokenAndCookie(resOne, decoded))
  // an unknown jti in the SAME family is treated as theft/replay: the family
  // is revoked and the rotation returns null so the caller clears the cookie
  const resTwo = fakeRes()
  assert.equal(
    HAXCMS.rotateRefreshTokenAndCookie(resTwo, {
      user: user,
      family: decoded.family,
      jti: 'jti-never-issued',
    }),
    null,
  )
  const finalStore = JSON.parse(fs.readFileSync(HAXCMS.getRefreshSessionsPath(), 'utf8'))
  assert.equal(finalStore[user], undefined)
})

// ---------------------------------------------------------------------------
// rate limit + security settings resolution
// ---------------------------------------------------------------------------
test('getIntConfigValue clamps and falls back on invalid values', () => {
  assert.equal(HAXCMS.getIntConfigValue('50', 10, 1, 100), 50)
  assert.equal(HAXCMS.getIntConfigValue('nope', 10, 1, 100), 10)
  assert.equal(HAXCMS.getIntConfigValue('-5', 10, 1, 100), 1)
  assert.equal(HAXCMS.getIntConfigValue('99999', 10, 1, 100), 100)
})

test('getLoginRateLimitSettings returns defaults then honors config values', () => {
  const defaults = HAXCMS.getLoginRateLimitSettings()
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.maxAttempts, 5)
  assert.ok(defaults.windowMs > 0)
  assert.ok(defaults.blockMs > 0)
  HAXCMS.config.security.loginRateLimit = {
    enabled: false,
    windowMs: 60000,
    maxAttempts: 3,
    blockMs: 30000,
  }
  const configured = HAXCMS.getLoginRateLimitSettings()
  assert.equal(configured.enabled, false)
  assert.equal(configured.windowMs, 60000)
  assert.equal(configured.maxAttempts, 3)
  assert.equal(configured.blockMs, 30000)
  HAXCMS.config.security.loginRateLimit = { windowMs: 1, maxAttempts: 100000, blockMs: 1 }
  const clamped = HAXCMS.getLoginRateLimitSettings()
  assert.ok(clamped.windowMs >= 10000)
  assert.ok(clamped.maxAttempts <= 1000)
  assert.ok(clamped.blockMs >= 10000)
  delete HAXCMS.config.security.loginRateLimit
})

test('getFileOpsRateLimitSettings returns defaults then honors config values', () => {
  const defaults = HAXCMS.getFileOpsRateLimitSettings()
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.max, 500)
  HAXCMS.config.security.fileOpsRateLimit = {
    enabled: false,
    windowMs: 60000,
    max: 10,
    blockMs: 30000,
  }
  const configured = HAXCMS.getFileOpsRateLimitSettings()
  assert.equal(configured.enabled, false)
  assert.equal(configured.max, 10)
  delete HAXCMS.config.security.fileOpsRateLimit
})

test('getTrustProxySetting resolves false, truthy, trustedProxies, and legacy shapes', () => {
  assert.equal(HAXCMS.getTrustProxySetting(), false)
  HAXCMS.config.security.trustProxy = 1
  assert.equal(HAXCMS.getTrustProxySetting(), 1)
  delete HAXCMS.config.security.trustProxy
  HAXCMS.config.security.trustedProxies = ['10.0.0.9']
  assert.deepEqual(HAXCMS.getTrustProxySetting(), ['10.0.0.9'])
  HAXCMS.config.security.trustedProxies = []
  assert.equal(HAXCMS.getTrustProxySetting(), false)
  delete HAXCMS.config.security.trustedProxies
})

test('getAllowedHosts normalizes string and array inputs and drops empties', () => {
  assert.deepEqual(HAXCMS.getAllowedHosts(), [])
  HAXCMS.config.security.allowedHosts = 'one.example'
  assert.deepEqual(HAXCMS.getAllowedHosts(), ['one.example'])
  HAXCMS.config.security.allowedHosts = [' one.example ', '', 'two.example:8080']
  assert.deepEqual(HAXCMS.getAllowedHosts(), ['one.example', 'two.example:8080'])
  delete HAXCMS.config.security.allowedHosts
})

test('resolveTrustedProtocol honors forwarded proto only behind a trusted proxy', () => {
  const forwardedReq = {
    headers: { 'x-forwarded-proto': 'https, http' },
    protocol: 'http',
  }
  assert.equal(HAXCMS.resolveTrustedProtocol(forwardedReq), 'http')
  HAXCMS.config.security.trustProxy = true
  try {
    assert.equal(HAXCMS.resolveTrustedProtocol(forwardedReq), 'https')
    assert.equal(HAXCMS.resolveTrustedProtocol({ headers: {}, protocol: 'https' }), 'https')
    assert.equal(HAXCMS.resolveTrustedProtocol({ headers: {} }), 'http')
  }
  finally {
    delete HAXCMS.config.security.trustProxy
  }
})

test('resolveTrustedHost honors forwarded hosts, allowedHosts fallback, and raw host', () => {
  HAXCMS.config.security.trustProxy = true
  HAXCMS.config.security.allowedHosts = ['allowed.example']
  try {
    assert.equal(
      HAXCMS.resolveTrustedHost({
        headers: { 'x-forwarded-host': 'allowed.example, proxy.example' },
      }),
      'allowed.example',
    )
    assert.equal(
      HAXCMS.resolveTrustedHost({ headers: { host: 'allowed.example' } }),
      'allowed.example',
    )
    assert.equal(
      HAXCMS.resolveTrustedHost({ headers: { host: 'evil.example' } }),
      'allowed.example',
    )
    assert.equal(HAXCMS.resolveTrustedHost({ headers: {} }), 'allowed.example')
  }
  finally {
    delete HAXCMS.config.security.trustProxy
    delete HAXCMS.config.security.allowedHosts
  }
  assert.equal(HAXCMS.resolveTrustedHost({ headers: { host: 'raw.example' } }), 'raw.example')
})

test('isProductionRuntime reads NODE_ENV=production case-insensitively', () => {
  const saved = process.env.NODE_ENV
  try {
    assert.equal(HAXCMS.isProductionRuntime(), false)
    process.env.NODE_ENV = 'production'
    assert.equal(HAXCMS.isProductionRuntime(), true)
    process.env.NODE_ENV = 'PRODUCTION'
    assert.equal(HAXCMS.isProductionRuntime(), true)
  }
  finally {
    if (saved === undefined) {
      delete process.env.NODE_ENV
    }
    else {
      process.env.NODE_ENV = saved
    }
  }
})

test('getCorsAllowedOrigin returns the configured origin or the provided default', () => {
  assert.equal(HAXCMS.getCorsAllowedOrigin('http://localhost:3000'), 'http://localhost:3000')
  HAXCMS.config.security.allowedOrigin = 'https://cms.example '
  assert.equal(HAXCMS.getCorsAllowedOrigin('http://localhost:3000'), 'https://cms.example')
  delete HAXCMS.config.security.allowedOrigin
})

test('writeSecretFile and chmodSecretFile round-trip inside the temp config directory', () => {
  const secretPath = path.join(configRoot, 'unit-secret.txt')
  HAXCMS.writeSecretFile(secretPath, 'secret-value')
  assert.equal(fs.readFileSync(secretPath, 'utf8'), 'secret-value')
  HAXCMS.chmodSecretFile(secretPath)
  assert.ok(fs.statSync(secretPath).isFile())
  assert.doesNotThrow(() => HAXCMS.chmodSecretFile(path.join(configRoot, 'not-there.txt')))
})

// ---------------------------------------------------------------------------
// deployment profile + MCP policy helpers
// ---------------------------------------------------------------------------
test('getDeploymentProfile validates known profiles and defaults to single-site', () => {
  HAXCMS.config.deploymentProfile = 'self-hosted-multi-site'
  assert.equal(HAXCMS.getDeploymentProfile(), 'self-hosted-multi-site')
  HAXCMS.config.deploymentProfile = 'HAXIAM-MANAGED'
  assert.equal(HAXCMS.getDeploymentProfile(), 'haxiam-managed')
  HAXCMS.config.deploymentProfile = 'bogus-profile'
  assert.equal(HAXCMS.getDeploymentProfile(), 'single-site')
  delete HAXCMS.config.deploymentProfile
  assert.equal(HAXCMS.getDeploymentProfile(), 'single-site')
})

test('MCP policy helpers resolve enabled, read-only, and write states', () => {
  HAXCMS.config.mcp = { enabled: true, readOnly: false }
  assert.equal(HAXCMS.isMcpEnabled(), true)
  assert.equal(HAXCMS.isMcpReadOnly(), false)
  assert.equal(HAXCMS.isMcpWriteEnabled(), true)
  HAXCMS.config.mcp = { enabled: true, readOnly: true }
  assert.equal(HAXCMS.isMcpReadOnly(), true)
  assert.equal(HAXCMS.isMcpWriteEnabled(), false)
  HAXCMS.config.mcp = { enabled: false }
  assert.equal(HAXCMS.isMcpEnabled(), false)
  assert.equal(HAXCMS.isMcpReadOnly(), true)
  assert.equal(HAXCMS.isMcpWriteEnabled(), false)
  delete HAXCMS.config.mcp
  assert.equal(HAXCMS.isMcpEnabled(), false)
  assert.equal(HAXCMS.isMcpReadOnly(), true)
})

// ---------------------------------------------------------------------------
// machine names / slugs / titles
// ---------------------------------------------------------------------------
test('generateMachineName mirrors the hardened PHP behavior', () => {
  assert.equal(HAXCMS.generateMachineName('My Cool Theme'), 'my-cool-theme')
  assert.equal(HAXCMS.generateMachineName('  spaced   out  '), 'spaced-out')
  assert.equal(HAXCMS.generateMachineName('..%2F..%2Fetc'), 'etc')
  assert.equal(HAXCMS.generateMachineName('a//b\\c'), 'abc')
  assert.equal(HAXCMS.generateMachineName('___---'), 'default')
  assert.equal(HAXCMS.generateMachineName(null), 'default')
  assert.equal(HAXCMS.generateMachineName(undefined), 'default')
  assert.equal(HAXCMS.generateMachineName('!!!'), 'default')
})

test('generateSlugName keeps forward slashes and strips traversal', () => {
  assert.equal(HAXCMS.generateSlugName('My Slug Here'), 'my-slug-here')
  assert.equal(HAXCMS.generateSlugName('parent/child'), 'parent/child')
  assert.equal(HAXCMS.generateSlugName('../etc/passwd'), 'etc/passwd')
  assert.equal(HAXCMS.generateSlugName('/leading/slash'), 'leading/slash')
  assert.equal(HAXCMS.generateSlugName('double//slash'), 'double/slash')
  assert.equal(HAXCMS.generateSlugName(null), '')
})

test('generateUUID returns distinct v4 identifiers', () => {
  const a = HAXCMS.generateUUID()
  const b = HAXCMS.generateUUID()
  assert.equal(typeof a, 'string')
  assert.notEqual(a, b)
})

test('cleanTitle strips page path fragments and normalizes spacing', () => {
  assert.equal(HAXCMS.cleanTitle('pages/my-page/index.html'), 'my-page')
  assert.equal(HAXCMS.cleanTitle('My Page'), 'my-page')
  // slashes are intentionally preserved by the char class ([^\w\-\/]+)
  assert.equal(HAXCMS.cleanTitle('dots..and//slashes', false), 'dots-and//slashes')
  assert.equal(HAXCMS.cleanTitle('   '), 'blank')
})

test('getUniqueName appends a counter while the location collides', () => {
  assert.equal(HAXCMS.getUniqueName('never-collides-unit'), 'never-collides-unit')
  fs.mkdirpSync(path.join(runtimeRoot, '_sites', 'collide-unit'))
  assert.equal(HAXCMS.getUniqueName('collide-unit'), 'collide-unit-1')
  fs.mkdirpSync(path.join(runtimeRoot, '_sites', 'collide-unit-1'))
  assert.equal(HAXCMS.getUniqueName('collide-unit'), 'collide-unit-2')
})

test('recurseCopy copies a directory tree recursively', async () => {
  const srcDir = path.join(tempRoot, 'recurse-src')
  const dstDir = path.join(tempRoot, 'recurse-dst')
  fs.ensureDirSync(path.join(srcDir, 'nested'))
  fs.writeFileSync(path.join(srcDir, 'top.txt'), 'top')
  fs.writeFileSync(path.join(srcDir, 'nested', 'deep.txt'), 'deep')
  await HAXCMS.recurseCopy(srcDir, dstDir)
  assert.equal(fs.readFileSync(path.join(dstDir, 'top.txt'), 'utf8'), 'top')
  assert.equal(fs.readFileSync(path.join(dstDir, 'nested', 'deep.txt'), 'utf8'), 'deep')
})

// ---------------------------------------------------------------------------
// form + schema helpers
// ---------------------------------------------------------------------------
test('loadForm resolves a registered form and returns form tokens', async () => {
  const loaded = await HAXCMS.loadForm('siteSettings', { site: { name: 'no-such-site' } })
  assert.ok(loaded.fields)
  assert.equal(loaded.value.haxcms_form_id, 'siteSettings')
  assert.ok(loaded.value.haxcms_form_token.length > 0)
})

test('loadForm answers a 500 payload when the form does not exist', async () => {
  const loaded = await HAXCMS.loadForm('doesNotExist')
  assert.deepEqual(loaded.fields, {
    status: 500,
    data: { message: 'doesNotExist does not exist' },
  })
})

test('processForm rejects on the undeclared fields/value assignments in class scope', async () => {
  // HAXCMSClass methods run in strict mode (class bodies are always strict),
  // so processForm's undeclared `value`/`fields` assignments reject
  await assert.rejects(
    () => HAXCMS.processForm('doesNotExistEither', {}),
    function (err) { return err instanceof ReferenceError },
  )
})

test('deepObjectLookUp walks dot-separated keys into nested objects', () => {
  const obj = {
    a: { b: { c: 'deep-value' } },
    flat: 'flat-value',
  }
  assert.equal(HAXCMS.deepObjectLookUp(obj, 'a-b-c'), 'deep-value')
  assert.equal(HAXCMS.deepObjectLookUp(obj, 'flat'), 'flat-value')
  assert.equal(HAXCMS.deepObjectLookUp(obj, 'a-b-missing-c'), undefined)
})

test('getInputMethod maps data types to input methods', () => {
  assert.equal(HAXCMS.getInputMethod('string'), 'textfield')
  assert.equal(HAXCMS.getInputMethod('number'), 'number')
  assert.equal(HAXCMS.getInputMethod('date'), 'datepicker')
  assert.equal(HAXCMS.getInputMethod('boolean'), 'boolean')
  assert.equal(HAXCMS.getInputMethod(null), 'textfield')
  assert.equal(HAXCMS.getInputMethod('weird'), 'textfield')
})

test('getConfigSchema rejects on the undeclared schema global in class scope', () => {
  // class bodies are always strict mode, so getConfigSchema's undeclared
  // `schema`/`publishing`/`props`/`hax` assignments throw before returning
  assert.throws(
    () => HAXCMS.getConfigSchema(),
    function (err) { return err instanceof ReferenceError },
  )
})

test('setUserData stores the user picture and persists userData.json', async () => {
  HAXCMS.setUserData({ userPicture: 'files/unit-avatar.png' })
  assert.equal(HAXCMS.userData.userPicture, 'files/unit-avatar.png')
  const stored = JSON.parse(fs.readFileSync(path.join(configRoot, 'userData.json'), 'utf8'))
  assert.equal(stored.userPicture, 'files/unit-avatar.png')
  HAXCMS.setUserData({ ignored: 'value' })
  assert.equal(HAXCMS.userData.ignored, undefined)
  await HAXCMS.saveUserDataFile()
  await HAXCMS.saveConfigFile()
  assert.ok(fs.pathExistsSync(path.join(configRoot, 'config.json')))
})

test('getLicenseData returns select names or the full license map', () => {
  const site = new HAXCMSSite()
  const selectData = site.getLicenseData()
  assert.equal(selectData['by'], 'Creative Commons: Attribution')
  assert.ok(selectData['by-sa'])
  const all = site.getLicenseData('all')
  assert.equal(all['by'].link, 'https://creativecommons.org/licenses/by/4.0/')
  assert.ok(all['by-nc-nd'].image)
})

// ---------------------------------------------------------------------------
// registry + connection helpers
// ---------------------------------------------------------------------------
test('getThemes returns the merged core theme registry', () => {
  const themes = HAXCMS.getThemes()
  assert.ok(themes && typeof themes === 'object')
  const names = Object.keys(themes)
  assert.ok(names.length > 0)
})

test('getWCRegistryJson resolves the registry relative to the site directory first', () => {
  const siteStub = {
    siteDirectory: path.join(tempRoot, 'wc-site'),
  }
  fs.ensureDirSync(siteStub.siteDirectory)
  fs.writeFileSync(
    path.join(siteStub.siteDirectory, 'wc-registry.json'),
    JSON.stringify({ 'unit-element': '@haxtheweb/unit-element/unit-element.js' }),
  )
  const map = HAXCMS.getWCRegistryJson(siteStub)
  assert.equal(map['unit-element'], '@haxtheweb/unit-element/unit-element.js')
  // base override wins over all candidates
  const baseDir = path.join(tempRoot, 'wc-base')
  fs.ensureDirSync(baseDir)
  fs.writeFileSync(
    path.join(baseDir, 'wc-registry.json'),
    JSON.stringify({ 'base-element': '@haxtheweb/base-element/base-element.js' }),
  )
  const baseMap = HAXCMS.getWCRegistryJson(siteStub, baseDir)
  assert.equal(baseMap['base-element'], '@haxtheweb/base-element/base-element.js')
  // corrupt registry content degrades to an empty map
  const corruptDir = path.join(tempRoot, 'wc-corrupt')
  fs.ensureDirSync(corruptDir)
  fs.writeFileSync(path.join(corruptDir, 'wc-registry.json'), '{ nope')
  assert.deepEqual(HAXCMS.getWCRegistryJson(null, corruptDir), {})
  assert.deepEqual(HAXCMS.getWCRegistryJson(null, path.join(tempRoot, 'no-registry-here')), {})
})

test('getWCRegistryJson returns an empty map in private address space runtimes', () => {
  const saved = process.env.IAM_PRIVATE_ADDRESS_SPACE
  const siteStub = {
    siteDirectory: path.join(tempRoot, 'wc-site'),
  }
  try {
    process.env.IAM_PRIVATE_ADDRESS_SPACE = '1'
    const map = HAXCMS.getWCRegistryJson(siteStub)
    assert.deepEqual(map, {})
  }
  finally {
    if (saved === undefined) {
      delete process.env.IAM_PRIVATE_ADDRESS_SPACE
    }
    else {
      process.env.IAM_PRIVATE_ADDRESS_SPACE = saved
    }
  }
})

test('getWCRegistryGraphJson resolves graph candidates and degrades safely', () => {
  const graphDir = path.join(tempRoot, 'wc-graph-site')
  fs.ensureDirSync(graphDir)
  fs.writeFileSync(
    path.join(graphDir, 'wc-registry-graph.json'),
    JSON.stringify({
      paths: ['@haxtheweb/one/one.js', '@haxtheweb/two/two.js'],
      adj: { 0: [1], 1: [] },
      tags: { 'one-element': 0 },
    }),
  )
  const graph = HAXCMS.getWCRegistryGraphJson({ siteDirectory: graphDir })
  assert.equal(graph.paths.length, 2)
  assert.deepEqual(graph.adj[0], [1])
  const corruptDir = path.join(tempRoot, 'wc-graph-corrupt')
  fs.ensureDirSync(corruptDir)
  fs.writeFileSync(path.join(corruptDir, 'wc-registry-graph.json'), 'not json')
  assert.deepEqual(HAXCMS.getWCRegistryGraphJson({ siteDirectory: corruptDir }), {})
  assert.deepEqual(
    HAXCMS.getWCRegistryGraphJson(null, path.join(tempRoot, 'no-graph-here')),
    {},
  )
})

test('buildShellModulepreloadPaths falls back to the fixed shell list without a graph artifact', () => {
  const paths = HAXCMS.buildShellModulepreloadPaths(null, path.join(tempRoot, 'no-graph-here'))
  assert.ok(paths.indexOf('@haxtheweb/wc-autoload/wc-autoload.js') !== -1)
  assert.ok(paths.indexOf('@haxtheweb/utils/utils.js') !== -1)
})

test('buildShellModulepreloadPaths walks graph adjacency, dedupes, and caps the result', () => {
  const graphSite = {
    siteDirectory: path.join(tempRoot, 'wc-graph-site'),
  }
  const withTheme = HAXCMS.buildShellModulepreloadPaths(
    graphSite,
    './',
    '@haxtheweb/two/two.js',
    5,
  )
  // the cap only limits the depth-2 adjacency walk, so the fixed shell list
  // (8 entries) plus the theme still resolves in full
  assert.ok(withTheme.indexOf('@haxtheweb/two/two.js') !== -1)
  assert.ok(withTheme.length >= 8)
  const deduped = HAXCMS.buildShellModulepreloadPaths(graphSite, './', '', 20)
  const unique = deduped.filter(function (value, index, self) {
    return self.indexOf(value) === index
  })
  assert.equal(unique.length, deduped.length)
})

test('getContentTagPath resolves registered tags and rejects unknown ones', () => {
  const siteStub = {
    siteDirectory: path.join(tempRoot, 'wc-site'),
  }
  assert.equal(
    HAXCMS.getContentTagPath(siteStub, './', 'unit-element'),
    '@haxtheweb/unit-element/unit-element.js',
  )
  assert.equal(HAXCMS.getContentTagPath(siteStub, './', 'unknown-element'), false)
})

test('siteConnectionJSON scopes the browse endpoint to the site in multisite mode', () => {
  HAXCMS.operatingContext = 'multisite'
  try {
    const connection = HAXCMS.siteConnectionJSON('site-token', 'my-site')
    assert.equal(
      connection.connection.operations.browse.endPoint,
      '_sites/my-site/x/api/v1/files',
    )
    assert.equal(connection.connection.headers['X-HAXCMS-Site-Token'], 'site-token')
    assert.equal(connection.connection.protocol, 'http')
    assert.equal(connection.details.title, 'Local files')
    const bare = HAXCMS.siteConnectionJSON('site-token', '')
    assert.equal(bare.connection.operations.browse.endPoint, 'x/api/v1/files')
  }
  finally {
    HAXCMS.operatingContext = 'single'
  }
})

test('siteConnectionJSON keeps the flat browse endpoint when neither context is multisite', () => {
  HAXCMS.operatingContext = 'single'
  HAXCMS.config.deploymentProfile = 'single-site'
  try {
    const singleContext = HAXCMS.siteConnectionJSON('site-token', 'my-site')
    assert.equal(singleContext.connection.operations.browse.endPoint, 'x/api/v1/files')
  }
  finally {
    HAXCMS.operatingContext = 'single'
    delete HAXCMS.config.deploymentProfile
  }
})

test('getURI and getDomain read the request url and domain off the singleton', () => {
  assert.equal(HAXCMS.getDomain(), 'localhost')
  const savedRequestUrl = HAXCMS.request_url
  HAXCMS.request_url = { href: 'http://unit.example/path' }
  assert.equal(HAXCMS.getURI(), 'http://unit.example/path')
  HAXCMS.request_url = null
  assert.equal(HAXCMS.getURI(), '')
  HAXCMS.request_url = savedRequestUrl
})

test('getSSHKey is a stub returning false', () => {
  assert.equal(HAXCMS.getSSHKey(), false)
})

test('gitTest returns the git version stdout', async () => {
  const version = await HAXCMS.gitTest()
  assert.ok(typeof version === 'string' && version.indexOf('git version') !== -1)
})

// ---------------------------------------------------------------------------
// parse helpers
// ---------------------------------------------------------------------------
test('parse_attributes extracts quoted and bare attributes', () => {
  const parsed = HAXCMS.parse_attributes(' title="My page" published locked')
  assert.equal(parsed['title'], 'My page')
  assert.equal(parsed['published'], null)
  assert.equal(parsed['locked'], null)
})

test('pageBreakParser splits page-break delimited content with attributes', () => {
  const body = [
    '<page-break title="First" published="published">first content</page-break>',
    '<p>between</p>',
    '<page-break title="Second" locked>second content</page-break>',
    'trailing',
  ].join('\n')
  const pages = HAXCMS.pageBreakParser(body)
  assert.ok(Array.isArray(pages))
  assert.ok(pages.length >= 2)
  // group 4 is the content that follows </page-break> up to the next tag
  assert.ok(pages[0].content.indexOf('between') !== -1)
  assert.equal(pages[0].attributes['title'], 'First')
  // pageBreakParser expands bare boolean attributes to name="name" first
  assert.equal(pages[1].attributes['locked'], 'locked')
  assert.equal(pages[0].attributes['published'], 'published')
})

test('pageBreakParser handles the empty default body', () => {
  const pages = HAXCMS.pageBreakParser()
  assert.ok(Array.isArray(pages))
})

test('itemFromParams builds a schema item with slugged location', () => {
  const site = new HAXCMSSite()
  site.manifest = { items: [] }
  site.getUniqueSlugName = function (slug) {
    return slug
  }
  const item = site.itemFromParams({
    node: {
      title: 'Unit Page',
      id: 'unit-id',
    },
    indent: 2,
    order: 5,
    parent: 'unit-parent',
    description: 'a description',
    metadata: { custom: 'value' },
    location: 'pages/old-location/index.html',
  })
  assert.equal(item.title, 'Unit Page')
  assert.equal(item.id, 'unit-id')
  assert.equal(item.location, 'pages/unit-id/index.html')
  assert.equal(item.indent, 2)
  assert.equal(item.order, 5)
  assert.equal(item.parent, 'unit-parent')
  assert.equal(item.description, 'a description')
  assert.deepEqual(item.metadata.custom, 'value')
  assert.ok(item.slug)
})

test('HAXCMSClass and HAXCMSSite are exported constructors', () => {
  assert.equal(typeof HAXCMSClass, 'function')
  assert.equal(typeof HAXCMSSite, 'function')
  assert.ok(HAXCMS instanceof HAXCMSClass)
})
