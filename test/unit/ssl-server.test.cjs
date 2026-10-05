'use strict'

// Unit tests for src/lib/sslServer.js: custom-cert detection (HAXCMS_SSL_*),
// mkcert availability probing, openssl self-signed generation, local-cert
// detection, and createServer / getServerProtocol across the http, https, and
// custom-cert branches.
//
// sslServer resolves the config directory from discoverConfigPath at module
// load, so a temp runtime with a seeded _config (marked with .isHAXcmsConfig)
// is created and cwd moved into it BEFORE the first require; the generated
// certificates land in the temp _config/ssl directory.
//
// mkcert IS available on this machine, but generateMkcertCerts runs
// `mkcert -install`, which mutates the system/browser trust stores, so that
// path is intentionally NOT exercised here; openssl self-signed generation is
// the safe path and covers the same generation flow.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const https = require('https')
const http = require('http')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-ssl-unit-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')

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
fs.ensureDirSync(path.join(configRoot, 'settings'))

process.chdir(runtimeRoot)
const sslServer = require('../../src/lib/sslServer.js')

const sslDir = path.join(configRoot, 'ssl')
const keyPath = path.join(sslDir, 'localhost.key')
const certPath = path.join(sslDir, 'localhost.crt')

const savedSslEnv = {
  key: process.env.HAXCMS_SSL_KEY,
  cert: process.env.HAXCMS_SSL_CERT,
  ca: process.env.HAXCMS_SSL_CA,
  enable: process.env.HAXCMS_ENABLE_SSL,
}

function restoreSslEnv() {
  const names = ['key', 'cert', 'ca', 'enable']
  const envNames = ['HAXCMS_SSL_KEY', 'HAXCMS_SSL_CERT', 'HAXCMS_SSL_CA', 'HAXCMS_ENABLE_SSL']
  for (let i = 0; i < names.length; i++) {
    if (savedSslEnv[names[i]] === undefined) {
      delete process.env[envNames[i]]
    }
    else {
      process.env[envNames[i]] = savedSslEnv[names[i]]
    }
  }
}

function fakeApp() {
  return function noopListener() {}
}

function closeServer(server) {
  return new Promise(function (resolve) {
    server.close(function () {
      resolve()
    })
  })
}

// openssl availability probe (read-only, no system mutation). Runs at module
// load because the skip options below evaluate at test registration time.
const { spawnSync } = require('node:child_process')
const opensslProbe = spawnSync('openssl', ['version'], { encoding: 'utf8' })
const opensslAvailable = !opensslProbe.error && !opensslProbe.status

test.after(() => {
  restoreSslEnv()
  process.chdir(originalCwd)
  fs.removeSync(tempRoot)
})

// ---------------------------------------------------------------------------
// custom certificate detection
// ---------------------------------------------------------------------------
test('hasCustomSslCerts requires both key and cert files to exist', () => {
  restoreSslEnv()
  // an unset env short-circuits the guard chain to undefined (falsy), not false
  assert.ok(!sslServer.hasCustomSslCerts())
  process.env.HAXCMS_SSL_KEY = path.join(tempRoot, 'custom.key')
  process.env.HAXCMS_SSL_CERT = path.join(tempRoot, 'custom.crt')
  assert.ok(!sslServer.hasCustomSslCerts())
  fs.writeFileSync(process.env.HAXCMS_SSL_KEY, 'key-content')
  assert.ok(!sslServer.hasCustomSslCerts())
  fs.writeFileSync(process.env.HAXCMS_SSL_CERT, 'cert-content')
  assert.equal(sslServer.hasCustomSslCerts(), true)
})

test('getCustomSslCerts reads key, cert, and an optional CA', () => {
  const certs = sslServer.getCustomSslCerts()
  assert.equal(String(certs.key), 'key-content')
  assert.equal(String(certs.cert), 'cert-content')
  assert.equal(certs.ca, undefined)
  process.env.HAXCMS_SSL_CA = path.join(tempRoot, 'custom-ca.crt')
  const withCa = sslServer.getCustomSslCerts()
  assert.equal(withCa.ca, undefined)
  fs.writeFileSync(process.env.HAXCMS_SSL_CA, 'ca-content')
  const withExistingCa = sslServer.getCustomSslCerts()
  assert.equal(String(withExistingCa.ca), 'ca-content')
})

// ---------------------------------------------------------------------------
// cert generation (openssl path) + local cert detection
// ---------------------------------------------------------------------------
test('isMkcertAvailable probes the binary without installing anything', () => {
  // read-only `mkcert --version` probe; true or false are both valid answers
  const available = sslServer.isMkcertAvailable()
  assert.equal(typeof available, 'boolean')
})

test('generateOpensslCerts creates a self-signed pair in the config ssl dir', { skip: !opensslAvailable && 'openssl is unavailable' }, () => {
  const generated = sslServer.generateOpensslCerts()
  assert.equal(generated, true)
  assert.ok(fs.statSync(keyPath).isFile())
  assert.ok(fs.statSync(certPath).isFile())
  assert.ok(fs.readFileSync(certPath, 'utf8').indexOf('BEGIN CERTIFICATE') !== -1)
})

test('local cert detection and accessors see the generated pair', { skip: !opensslAvailable && 'openssl is unavailable' }, () => {
  assert.equal(sslServer.hasLocalCerts(), true)
  assert.equal(sslServer.hasMkcertCerts(), true)
  assert.equal(sslServer.hasOpensslCerts(), true)
  const mkcertCerts = sslServer.getMkcertCerts()
  assert.ok(String(mkcertCerts.key).length > 0)
  const opensslCerts = sslServer.getOpensslCerts()
  assert.ok(String(opensslCerts.cert).indexOf('CERTIFICATE') !== -1)
  const localCerts = sslServer.getLocalCerts()
  assert.ok(String(localCerts.key).length > 0)
  assert.ok(String(localCerts.cert).length > 0)
})

test('ensureLocalCerts returns true immediately when certs already exist', { skip: !opensslAvailable && 'openssl is unavailable' }, () => {
  assert.equal(sslServer.ensureLocalCerts(), true)
})

// ---------------------------------------------------------------------------
// server creation + protocol resolution
// ---------------------------------------------------------------------------
test('createServer builds a plain http server without SSL configuration', async () => {
  restoreSslEnv()
  const server = sslServer.createServer(fakeApp())
  assert.ok(server instanceof http.Server)
  assert.equal(sslServer.getServerProtocol(), 'http')
  await closeServer(server)
})

test('createServer builds an https server from the locally generated certs', { skip: !opensslAvailable && 'openssl is unavailable' }, async () => {
  restoreSslEnv()
  process.env.HAXCMS_ENABLE_SSL = '1'
  const server = sslServer.createServer(fakeApp())
  assert.ok(server instanceof https.Server)
  assert.equal(sslServer.getServerProtocol(), 'https')
  await closeServer(server)
})

test('createServer prefers custom certs over the local generation flow', { skip: !opensslAvailable && 'openssl is unavailable' }, async () => {
  restoreSslEnv()
  // point the custom-cert env at the REAL openssl-generated pair so
  // https.createServer parses valid PEM material
  process.env.HAXCMS_SSL_KEY = keyPath
  process.env.HAXCMS_SSL_CERT = certPath
  const server = sslServer.createServer(fakeApp())
  assert.ok(server instanceof https.Server)
  assert.equal(sslServer.getServerProtocol(), 'https')
  await closeServer(server)
})
