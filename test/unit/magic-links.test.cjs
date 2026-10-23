'use strict'

// One-time sign-in links (haxtheweb/issues#2854): the file-backed store in
// src/lib/magicLinks.js and the session/magic-link route.
//
// Store tests use a minimal fake HAXCMS pointed at a temp _config so they never
// touch a real configuration. Route tests use the real HAXCMS (real JWT /
// refresh crypto) with configDirectory swapped to a temp dir for the duration.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require('node:test')
const { describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const magicLinks = require('../../src/lib/magicLinks.js')

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-magic-'))
  fs.mkdirSync(path.join(dir, 'settings'))
  return dir
}

function fakeHaxcms(overrides) {
  return Object.assign({
    configDirectory: tmpConfig(),
    config: {},
    getActiveUserName() { return 'admin' },
    validateUser(name) { return name === 'admin' },
  }, overrides || {})
}

function readStore(haxcms) {
  return JSON.parse(fs.readFileSync(magicLinks.getMagicLinksPath(haxcms), 'utf8')).links
}

describe('magicLinks store', () => {
  test('issue returns selector.verifier and stores only a hash of the verifier', () => {
    const h = fakeHaxcms()
    const issued = magicLinks.issueMagicLink(h)
    assert.equal(issued.user, 'admin')
    assert.ok(magicLinks.isWellFormedToken(issued.token))
    const verifier = issued.token.split('.')[1]
    const raw = fs.readFileSync(magicLinks.getMagicLinksPath(h), 'utf8')
    assert.equal(raw.indexOf(verifier), -1, 'plaintext verifier must never be persisted')
    const record = readStore(h)[issued.selector]
    assert.equal(record.user, 'admin')
    assert.equal(record.channel, 'cli')
    assert.equal(record.expiresAt - record.issuedAt, magicLinks.DEFAULT_TTL_SECONDS)
  })

  test('store file is written 0600 on POSIX', { skip: process.platform === 'win32' }, () => {
    const h = fakeHaxcms()
    magicLinks.issueMagicLink(h)
    const mode = fs.statSync(magicLinks.getMagicLinksPath(h)).mode & 0o777
    assert.equal(mode, 0o600)
  })

  test('a link can be consumed exactly once', () => {
    const h = fakeHaxcms()
    const { token } = magicLinks.issueMagicLink(h)
    assert.deepEqual(magicLinks.consumeMagicLink(h, token), { ok: true, user: 'admin', channel: 'cli' })
    const replay = magicLinks.consumeMagicLink(h, token)
    assert.equal(replay.ok, false)
    assert.equal(replay.reason, 'not_found')
  })

  test('an expired link is rejected and removed', () => {
    const h = fakeHaxcms()
    const now = Date.now()
    const { token, selector } = magicLinks.issueMagicLink(h, { ttlSeconds: 60, now: now })
    const result = magicLinks.consumeMagicLink(h, token, now + 61 * 1000)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'expired')
    assert.equal(readStore(h)[selector], undefined)
  })

  test('a wrong verifier is rejected and does not burn the real link', () => {
    const h = fakeHaxcms()
    const { token, selector } = magicLinks.issueMagicLink(h)
    const forged = selector + '.' + 'A'.repeat(43)
    assert.equal(magicLinks.consumeMagicLink(h, forged).reason, 'mismatch')
    assert.equal(magicLinks.consumeMagicLink(h, token).ok, true)
  })

  test('malformed tokens are rejected before touching the store', () => {
    const h = fakeHaxcms()
    const bad = ['', 'nodot', 'a.b', '../../etc.passwd', 'x'.repeat(20) + '.' + 'y'.repeat(20) + '.z', null, 42]
    for (const t of bad) {
      assert.equal(magicLinks.consumeMagicLink(h, t).reason, 'malformed', String(t))
    }
    assert.equal(fs.existsSync(magicLinks.getMagicLinksPath(h)), false)
  })

  test('issuing a new link revokes the user\'s earlier links by default', () => {
    const h = fakeHaxcms()
    const first = magicLinks.issueMagicLink(h)
    const second = magicLinks.issueMagicLink(h)
    assert.equal(magicLinks.consumeMagicLink(h, first.token).ok, false)
    assert.equal(magicLinks.consumeMagicLink(h, second.token).ok, true)
  })

  test('revokeOutstanding:false keeps at most maxOutstanding links', () => {
    const h = fakeHaxcms({ config: { security: { magicLink: { maxOutstanding: 2 } } } })
    const a = magicLinks.issueMagicLink(h, { revokeOutstanding: false, now: 1000000 })
    const b = magicLinks.issueMagicLink(h, { revokeOutstanding: false, now: 1001000 })
    const c = magicLinks.issueMagicLink(h, { revokeOutstanding: false, now: 1002000 })
    const links = readStore(h)
    assert.equal(links[a.selector], undefined, 'oldest dropped')
    assert.ok(links[b.selector])
    assert.ok(links[c.selector])
  })

  test('refuses to issue for an unknown user', () => {
    const h = fakeHaxcms()
    assert.throws(() => magicLinks.issueMagicLink(h, { user: 'mallory' }), { code: 'MAGIC_LINK_UNKNOWN_USER' })
  })

  test('a link for a user that no longer exists is rejected on consume', () => {
    let exists = true
    const h = fakeHaxcms({ validateUser() { return exists } })
    const { token } = magicLinks.issueMagicLink(h)
    exists = false
    assert.equal(magicLinks.consumeMagicLink(h, token).reason, 'unknown_user')
  })

  test('disabled policy blocks both issue and consume', () => {
    const h = fakeHaxcms()
    const { token } = magicLinks.issueMagicLink(h)
    h.config = { security: { magicLink: { enabled: false } } }
    assert.throws(() => magicLinks.issueMagicLink(h), { code: 'MAGIC_LINK_DISABLED' })
    assert.equal(magicLinks.consumeMagicLink(h, token).reason, 'disabled')
  })

  test('HAXCMS_MAGIC_LINK_DISABLED turns the feature off and beats config', () => {
    const h = fakeHaxcms({ config: { security: { magicLink: { enabled: true } } } })
    const { token } = magicLinks.issueMagicLink(h)
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.HAXCMS_MAGIC_LINK_DISABLED = value
      try {
        assert.equal(magicLinks.isMagicLinkEnabled(h), false, value)
        assert.throws(() => magicLinks.issueMagicLink(h), { code: 'MAGIC_LINK_DISABLED' })
        assert.equal(magicLinks.consumeMagicLink(h, token).reason, 'disabled')
      }
      finally {
        delete process.env.HAXCMS_MAGIC_LINK_DISABLED
      }
    }
    process.env.HAXCMS_MAGIC_LINK_DISABLED = '0'
    try {
      assert.equal(magicLinks.isMagicLinkEnabled(h), true, '"0" leaves it on')
    }
    finally {
      delete process.env.HAXCMS_MAGIC_LINK_DISABLED
    }
  })

  test('ttl is clamped to 60s..24h', () => {
    const h = fakeHaxcms()
    assert.equal(magicLinks.issueMagicLink(h, { ttlSeconds: 1 }).ttlSeconds, 60)
    assert.equal(magicLinks.issueMagicLink(h, { ttlSeconds: 999999 }).ttlSeconds, 86400)
  })

  test('revokeMagicLinks clears outstanding links', () => {
    const h = fakeHaxcms()
    const { token } = magicLinks.issueMagicLink(h)
    assert.equal(magicLinks.revokeMagicLinks(h), 1)
    assert.equal(magicLinks.consumeMagicLink(h, token).ok, false)
  })

  test('a corrupt store fails closed', () => {
    const h = fakeHaxcms()
    const { token } = magicLinks.issueMagicLink(h)
    fs.writeFileSync(magicLinks.getMagicLinksPath(h), '{not json')
    assert.equal(magicLinks.consumeMagicLink(h, token).ok, false)
  })
})

describe('session/magic-link route', () => {
  const { HAXCMS } = require('../../src/lib/HAXCMS.js')
  const route = require('../../src/systemRoutes/v1/routes/magicLink.js')
  let originalConfigDirectory
  let originalSave

  before(() => {
    originalConfigDirectory = HAXCMS.configDirectory
    HAXCMS.configDirectory = tmpConfig()
    // keep the refresh-session store hermetic
    originalSave = HAXCMS._saveRefreshSessions
    HAXCMS._saveRefreshSessions = function () {}
  })
  after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    HAXCMS._saveRefreshSessions = originalSave
  })

  function res() {
    return {
      statusCode: 200, body: null, headers: {}, cookies: [], redirectedTo: null,
      status(code) { this.statusCode = code; return this },
      json(obj) { this.body = obj; return this },
      send(obj) { this.body = obj; return this },
      set(name, value) { this.headers[name] = value; return this },
      setHeader(name, value) { this.headers[name] = value },
      cookie(name, value, options) { this.cookies.push({ name, value, options }) },
      redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this },
    }
  }
  function req(opts) {
    return Object.assign({ headers: {}, query: {}, body: {}, cookies: {}, ip: '203.0.113.' + Math.floor(Math.random() * 250) }, opts)
  }

  test('GET renders a confirmation form and does not consume', () => {
    const { token } = magicLinks.issueMagicLink(HAXCMS)
    const r = res()
    route.magicLinkConfirm(req({ query: { token } }), r)
    assert.equal(r.statusCode, 200)
    assert.match(r.body, /<form method="post">/)
    assert.equal(r.headers['Cache-Control'], 'no-store')
    assert.equal(r.headers['Referrer-Policy'], 'no-referrer')
    assert.equal(magicLinks.consumeMagicLink(HAXCMS, token).ok, true, 'still redeemable after GET')
  })

  test('GET with a malformed token is a generic 400', () => {
    const r = res()
    route.magicLinkConfirm(req({ query: { token: '<script>' } }), r)
    assert.equal(r.statusCode, 400)
    assert.equal(r.body.indexOf('<script>'), -1)
  })

  test('POST (form) sets the refresh cookie and redirects to the app root', () => {
    const { token } = magicLinks.issueMagicLink(HAXCMS)
    const r = res()
    route.magicLinkConsume(req({ body: { token } }), r)
    assert.equal(r.statusCode, 303)
    assert.equal(r.redirectedTo, HAXCMS.basePath || '/')
    const cookie = r.cookies.find((c) => c.name === 'haxcms_refresh_token')
    assert.ok(cookie && cookie.value, 'refresh cookie issued')
    assert.equal(cookie.options.httpOnly, true)
    assert.ok(HAXCMS.decodeRefreshToken(cookie.value))
  })

  test('POST (json) returns a JWT for the account', () => {
    const { token, user } = magicLinks.issueMagicLink(HAXCMS)
    const r = res()
    route.magicLinkConsume(req({ headers: { accept: 'application/json' }, body: { token } }), r)
    assert.equal(r.statusCode, 200)
    assert.equal(HAXCMS.decodeJWT(r.body.jwt).user, user)
  })

  test('replay gets a generic 401 and clears the cookie', () => {
    const { token } = magicLinks.issueMagicLink(HAXCMS)
    route.magicLinkConsume(req({ body: { token } }), res())
    const r = res()
    route.magicLinkConsume(req({ headers: { accept: 'application/json' }, body: { token } }), r)
    assert.equal(r.statusCode, 401)
    const cleared = r.cookies.find((c) => c.name === 'haxcms_refresh_token')
    assert.equal(cleared.value, '')
  })

  test('with the feature disabled both methods 404 and nothing is consumed', () => {
    const { token } = magicLinks.issueMagicLink(HAXCMS)
    process.env.HAXCMS_MAGIC_LINK_DISABLED = '1'
    try {
      const g = res()
      route.magicLinkConfirm(req({ query: { token } }), g)
      assert.equal(g.statusCode, 404)
      assert.equal(typeof g.body, 'object', 'no HTML confirmation page')
      const p = res()
      route.magicLinkConsume(req({ body: { token } }), p)
      assert.equal(p.statusCode, 404)
      assert.equal(p.cookies.length, 0)
    }
    finally {
      delete process.env.HAXCMS_MAGIC_LINK_DISABLED
    }
    assert.equal(magicLinks.consumeMagicLink(HAXCMS, token).ok, true)
  })

  test('cross-origin POST is refused without consuming', () => {
    const { token } = magicLinks.issueMagicLink(HAXCMS)
    const r = res()
    route.magicLinkConsume(req({ headers: { origin: 'https://evil.example', accept: 'application/json' }, body: { token } }), r)
    assert.equal(r.statusCode, 403)
    assert.equal(magicLinks.consumeMagicLink(HAXCMS, token).ok, true)
  })
})
