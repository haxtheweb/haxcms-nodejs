'use strict'

// Security (review 2026-10): listen-host selection. No-login mode
// (HAXCMS_DISABLE_JWT_CHECKS, the `npx @haxtheweb/haxcms-nodejs` bin) disables
// every auth check, so it must bind to loopback unless HAXCMS_HOST opts in.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { resolveListenHost, isLoopbackHost, LOOPBACK_HOST } = require(
  path.join(__dirname, '..', '..', 'src', 'lib', 'serverHost.js'),
)

test('no-login mode without HAXCMS_HOST binds to 127.0.0.1 (not all interfaces)', () => {
  const r = resolveListenHost({ authDisabled: true })
  assert.equal(r.host, '127.0.0.1')
  assert.equal(r.host, LOOPBACK_HOST)
  assert.equal(r.warning, null)
  // empty / whitespace values count as unset
  assert.equal(resolveListenHost({ authDisabled: true, envHost: '' }).host, '127.0.0.1')
  assert.equal(resolveListenHost({ authDisabled: true, envHost: '   ' }).host, '127.0.0.1')
})

test('no-login mode honours an explicit loopback HAXCMS_HOST without warning', () => {
  const hosts = ['localhost', '::1', '[::1]', '127.0.0.2', '::ffff:127.0.0.1']
  for (let i = 0; i < hosts.length; i++) {
    const r = resolveListenHost({ authDisabled: true, envHost: hosts[i] })
    assert.equal(r.warning, null, hosts[i])
    assert.ok(isLoopbackHost(r.host), hosts[i])
  }
  assert.equal(resolveListenHost({ authDisabled: true, envHost: '[::1]' }).host, '::1')
})

test('no-login mode with a non-loopback HAXCMS_HOST binds it but warns loudly', () => {
  const hosts = ['0.0.0.0', '::', '192.168.1.20', 'my-laptop.local']
  for (let i = 0; i < hosts.length; i++) {
    const r = resolveListenHost({ authDisabled: true, envHost: hosts[i] })
    assert.equal(r.host, hosts[i])
    assert.ok(r.warning, hosts[i])
    assert.match(r.warning, /SECURITY WARNING/)
    assert.match(r.warning, /DISABLED/)
  }
})

test('auth mode keeps the default all-interfaces bind unless HAXCMS_HOST is set', () => {
  const unset = resolveListenHost({ authDisabled: false })
  assert.equal(unset.host, undefined)
  assert.equal(unset.warning, null)
  const set = resolveListenHost({ authDisabled: false, envHost: '10.0.0.5' })
  assert.equal(set.host, '10.0.0.5')
  assert.equal(set.warning, null)
  assert.equal(resolveListenHost({ authDisabled: false, envHost: '127.0.0.1' }).host, '127.0.0.1')
})

test('isLoopbackHost rejects lookalikes', () => {
  const notLoopback = ['', '0.0.0.0', '::', '128.0.0.1', '127.0.0.1.evil.com', 'localhost.evil.com', null, undefined]
  for (let i = 0; i < notLoopback.length; i++) {
    assert.equal(isLoopbackHost(notLoopback[i]), false, String(notLoopback[i]))
  }
})
