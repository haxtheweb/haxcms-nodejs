'use strict'

// Security (SEC-DEPLOY): unit tests for the server listen-host selection
// (src/lib/listenHost.js). No server is started here; the real bind in
// no-login mode is covered by local-server-open.test.cjs.
//
// Constraints honored: CommonJS (.cjs), require(), node:test +
// node:assert/strict, NO optional chaining.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const {
  LOOPBACK_HOST,
  selectListenHost,
  isLoopbackHost,
  getBypassExposureWarning,
  getBrowserHost,
} = require(path.join(__dirname, '..', '..', 'src', 'lib', 'listenHost.js'))

test('default (auth on, no HAXCMS_HOST) keeps binding all interfaces', () => {
  assert.equal(selectListenHost({ env: {}, jwtChecksDisabled: false }), undefined)
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: '' }, jwtChecksDisabled: false }), undefined)
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: '   ' }, jwtChecksDisabled: false }), undefined)
})

test('no-login bypass without HAXCMS_HOST binds 127.0.0.1', () => {
  assert.equal(LOOPBACK_HOST, '127.0.0.1')
  assert.equal(selectListenHost({ env: {}, jwtChecksDisabled: true }), '127.0.0.1')
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: '' }, jwtChecksDisabled: true }), '127.0.0.1')
})

test('HAXCMS_HOST always wins (escape hatch and general use)', () => {
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: '0.0.0.0' }, jwtChecksDisabled: true }), '0.0.0.0')
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: ' 10.0.0.5 ' }, jwtChecksDisabled: true }), '10.0.0.5')
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: '127.0.0.1' }, jwtChecksDisabled: false }), '127.0.0.1')
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: '::' }, jwtChecksDisabled: false }), '::')
  assert.equal(selectListenHost({ env: { HAXCMS_HOST: '[::1]' }, jwtChecksDisabled: true }), '::1')
})

test('selectListenHost reads process.env when no env is passed', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'HAXCMS_HOST')
  const prev = process.env.HAXCMS_HOST
  try {
    process.env.HAXCMS_HOST = '192.168.1.20'
    assert.equal(selectListenHost({ jwtChecksDisabled: true }), '192.168.1.20')
    delete process.env.HAXCMS_HOST
    assert.equal(selectListenHost({ jwtChecksDisabled: true }), '127.0.0.1')
    assert.equal(selectListenHost(), undefined)
  } finally {
    if (had) process.env.HAXCMS_HOST = prev
    else delete process.env.HAXCMS_HOST
  }
})

test('isLoopbackHost recognises loopback forms only', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(h), true, h)
  }
  for (const h of [undefined, null, '', '0.0.0.0', '::', '10.0.0.1', '192.168.0.2', '128.0.0.1', 'example.com']) {
    assert.equal(isLoopbackHost(h), false, String(h))
  }
})

test('bypass on a non-loopback bind produces a loud warning', () => {
  assert.equal(getBypassExposureWarning('127.0.0.1', true), null)
  assert.equal(getBypassExposureWarning('0.0.0.0', false), null)
  assert.equal(getBypassExposureWarning(undefined, false), null)
  const wildcard = getBypassExposureWarning('0.0.0.0', true)
  assert.ok(wildcard && wildcard.indexOf('SECURITY WARNING') !== -1)
  assert.ok(wildcard.indexOf('0.0.0.0') !== -1)
  const all = getBypassExposureWarning(undefined, true)
  assert.ok(all && all.indexOf('all interfaces') !== -1)
})

test('getBrowserHost keeps localhost for wildcard/loopback binds', () => {
  assert.equal(getBrowserHost(undefined), 'localhost')
  assert.equal(getBrowserHost('127.0.0.1'), 'localhost')
  assert.equal(getBrowserHost('0.0.0.0'), 'localhost')
  assert.equal(getBrowserHost('::'), 'localhost')
  assert.equal(getBrowserHost('::1'), 'localhost')
  assert.equal(getBrowserHost('10.0.0.5'), '10.0.0.5')
  assert.equal(getBrowserHost('fd00::5'), '[fd00::5]')
})
