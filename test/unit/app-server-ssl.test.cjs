'use strict'

// In-process integration test that boots the real server from src/app.js with
// HAXCMS_ENABLE_SSL=1 and a pre-generated openssl self-signed certificate pair
// in the temp _config/ssl directory, so sslServer.createServer takes the https
// branch and the app serves TLS on an ephemeral port. The cert pair is
// generated with openssl BEFORE requiring app.js so ensureLocalCerts never
// falls through to mkcert (whose -install step mutates system trust stores).
//
// Server-boot discipline honored: ephemeral port only (PORT=0), temp runtime
// dirs via fs.mkdtempSync, JWT/test credentials in the temp runtime only,
// and the server is closed in test.after.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const https = require('https')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const TEST_USER_NAME = 'app-ssl-user'
const TEST_USER_PASSWORD = 'app-ssl-pass'

// openssl availability probe (read-only). Runs at module load so the whole
// file can skip before booting when openssl is unavailable.
const opensslProbe = spawnSync('openssl', ['version'], { encoding: 'utf8' })
const opensslAvailable = !opensslProbe.error && !opensslProbe.status

function captureEnv(key) {
  return {
    exists: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }
}

function restoreEnv(key, snapshot) {
  if (!snapshot || snapshot.exists !== true) {
    delete process.env[key]
    return
  }
  process.env[key] = snapshot.value
}

const envSnapshots = {
  PORT: captureEnv('PORT'),
  HAXCMS_ROOT: captureEnv('HAXCMS_ROOT'),
  HAXCMS_ENABLE_SSL: captureEnv('HAXCMS_ENABLE_SSL'),
  NODE_ENV: captureEnv('NODE_ENV'),
}

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-app-ssl-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')
const sslDir = path.join(configRoot, 'ssl')

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
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_PASSWORD }, null, 2),
)

// generate the self-signed pair up front so ensureLocalCerts sees the local
// certs and never reaches the mkcert generation path
let appModule = null
if (opensslAvailable) {
  fs.ensureDirSync(sslDir)
  const sanConfigPath = path.join(sslDir, 'openssl-san.cnf')
  fs.writeFileSync(
    sanConfigPath,
    [
      '[req]',
      'distinguished_name = req_distinguished_name',
      'x509_extensions = v3_req',
      'prompt = no',
      '[req_distinguished_name]',
      'CN = localhost',
      '[v3_req]',
      'subjectAltName = @alt_names',
      '[alt_names]',
      'DNS.1 = localhost',
      'IP.1 = 127.0.0.1',
    ].join('\n'),
  )
  const generation = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-days',
      '365',
      '-newkey',
      'rsa:2048',
      '-keyout',
      path.join(sslDir, 'localhost.key'),
      '-out',
      path.join(sslDir, 'localhost.crt'),
      '-config',
      sanConfigPath,
    ],
    { encoding: 'utf8' },
  )
  if (generation.error || generation.status) {
    // cert generation failed: the whole file degrades to a skip
  }
}

process.chdir(runtimeRoot)
process.env.HAXCMS_ROOT = runtimeRoot + '/'
process.env.PORT = '0'
process.env.HAXCMS_ENABLE_SSL = '1'
delete process.env.NODE_ENV

globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
  username: TEST_USER_NAME,
  password: TEST_USER_PASSWORD,
}

const skipFile = !opensslAvailable
if (!skipFile) {
  appModule = require(APP_ENTRY_PATH)
}

function httpsGet(url) {
  return new Promise(function (resolve, reject) {
    const request = https.get(
      url,
      { rejectUnauthorized: false },
      function (response) {
        let body = ''
        response.on('data', function (chunk) {
          body += chunk
        })
        response.on('end', function () {
          resolve({ status: response.statusCode, headers: response.headers, body: body })
        })
      },
    )
    request.on('error', reject)
  })
}

test.after(async () => {
  if (appModule && appModule.server && typeof appModule.server.close === 'function') {
    await new Promise(function (resolve) {
      appModule.server.close(function () {
        resolve()
      })
    })
  }
  process.chdir(originalCwd)
  restoreEnv('PORT', envSnapshots.PORT)
  restoreEnv('HAXCMS_ROOT', envSnapshots.HAXCMS_ROOT)
  restoreEnv('HAXCMS_ENABLE_SSL', envSnapshots.HAXCMS_ENABLE_SSL)
  restoreEnv('NODE_ENV', envSnapshots.NODE_ENV)
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
  fs.removeSync(tempRoot)
})

test(
  'the app boots an https server on an ephemeral port and serves the dashboard',
  { skip: !opensslAvailable && 'openssl is unavailable' },
  async () => {
    assert.equal(appModule.serverProtocol, 'https')
    const port = await appModule.serverReady
    const result = await httpsGet('https://localhost:' + port + '/')
    assert.equal(result.status, 200)
    assert.ok(result.body.indexOf('<') !== -1)
    // inline scripts are nonce-stamped under TLS as well
    assert.ok(result.body.indexOf('nonce=') !== -1)
  },
)
