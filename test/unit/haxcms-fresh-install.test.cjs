'use strict'

// Fresh-install constructor test for the HAXCMS core singleton (src/lib/HAXCMS.js
// lines around 3556-3581): when the discovered _config has no .user file, the
// constructor seeds a default admin with a SECURE RANDOM password (stored as a
// scrypt hash, never plaintext) plus the SALT.txt / .pk / .rpk secret files,
// and prints the seeded credentials banner.
//
// This runs in its own test process (node:test isolates each file), so it can
// boot a temp runtime whose _config deliberately LACKS .user BEFORE
// src/lib/HAXCMS.js is first required — the constructor runs at require time
// with that state.
//
// Server-boot discipline honored: no server, no port; everything stays inside
// the temp tree (cwd + HAXCMS_ROOT redirected before the require).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-fresh-install-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')

// a valid _config WITHOUT .user: seed the boilerplate config so the boot stays
// quiet, but leave .user absent to trigger the fresh-install seeding branch
fs.ensureDirSync(configRoot)
fs.writeFileSync(path.join(configRoot, '.isHAXcmsConfig'), '')
const seedFiles = ['config.json', 'userData.json', 'config.php', '.htaccess']
for (let i = 0; i < seedFiles.length; i++) {
  fs.copySync(
    path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
    path.join(configRoot, seedFiles[i]),
  )
}
fs.ensureDirSync(path.join(configRoot, 'tmp'))
fs.ensureDirSync(path.join(configRoot, 'settings'))
fs.ensureDirSync(path.join(runtimeRoot, '_sites'))

process.chdir(runtimeRoot)
process.env.HAXCMS_ROOT = runtimeRoot + '/'

// the constructor prints the seeded-credentials banner via console.error;
// capture it instead of leaking the (random, test-only) password to the log
const bannerLines = []
const originalConsoleError = console.error
console.error = function () {
  for (let i = 0; i < arguments.length; i++) {
    bannerLines.push(String(arguments[i]))
  }
}

let loadError = null
let HAXCMS = null
try {
  HAXCMS = require('../../src/lib/HAXCMS.js').HAXCMS
} catch (e) {
  loadError = e
} finally {
  console.error = originalConsoleError
}

test.after(() => {
  process.chdir(originalCwd)
  delete process.env.HAXCMS_ROOT
  fs.removeSync(tempRoot)
})

test('a fresh install seeds the admin user and the secret files', () => {
  assert.equal(loadError, null)
  assert.ok(HAXCMS)
  // the seeded user is the default admin with a scrypt hash password
  assert.equal(HAXCMS.user.name, 'admin')
  assert.equal(HAXCMS.superUser.name, 'admin')
  assert.equal(HAXCMS.credentialsLoadedFromDisk, false)
  // a hash, never a plaintext password
  assert.ok(typeof HAXCMS.user.password === 'string')
  assert.ok(HAXCMS.user.password.length > 30)
  assert.notEqual(HAXCMS.user.password, 'admin')
  // .user persisted to the config directory with the hash only
  const stored = JSON.parse(fs.readFileSync(path.join(configRoot, '.user'), 'utf8'))
  assert.equal(stored.name, 'admin')
  assert.equal(stored.password, HAXCMS.user.password)
  // the other secret files were generated on the fly
  assert.ok(fs.statSync(path.join(configRoot, 'SALT.txt')).isFile())
  assert.ok(fs.statSync(path.join(configRoot, '.pk')).isFile())
  assert.ok(fs.statSync(path.join(configRoot, '.rpk')).isFile())
  // the banner announced the seeded credentials (exact random password is not
  // asserted — only that the banner printed the username line)
  assert.ok(
    bannerLines.some((line) => line.indexOf('HAXcms admin seeded credentials') !== -1),
  )
  assert.ok(bannerLines.some((line) => line.indexOf('username: admin') !== -1))
})

// Security (SEC-DEPLOY): the plaintext seeded password goes to a 0600 file in
// the config dir; under the (non-TTY) test runner it must not reach stderr.
test('the seeded password is written to a 0600 file and not to non-TTY stderr', () => {
  assert.equal(loadError, null)
  const passwordFile = path.join(configRoot, '.initial-admin-password')
  assert.ok(fs.statSync(passwordFile).isFile(), 'password file created')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(passwordFile).mode & 0o777, 0o600)
  }
  const body = fs.readFileSync(passwordFile, 'utf8')
  const match = body.match(/^password: ([0-9a-f]+)$/m)
  assert.ok(match, 'file carries the plaintext password')
  assert.ok(body.indexOf('username: admin') !== -1)
  // the file's password really is the seeded one (verifies against the hash)
  assert.equal(HAXCMS.verifyStoredPassword(HAXCMS.user.password, match[1]), true)
  // stderr only carried the path, never the password
  assert.equal(process.stderr.isTTY ? true : false, false, 'test runner stderr is not a TTY')
  const joined = bannerLines.join('\n')
  assert.equal(joined.indexOf(match[1]), -1, 'plaintext password not logged')
  assert.ok(!bannerLines.some((line) => /^password: /.test(line)))
  assert.ok(bannerLines.some((line) => line.indexOf(passwordFile) !== -1), 'file path logged')
})

test('announceSeededCredentials echoes the password only on a TTY', () => {
  assert.equal(loadError, null)
  const ttyLines = []
  const ttyFile = HAXCMS.announceSeededCredentials('admin', 'tty-secret-123', {
    isTTY: true,
    log: (line) => ttyLines.push(String(line)),
  })
  assert.equal(ttyFile, path.join(configRoot, '.initial-admin-password'))
  assert.ok(ttyLines.some((line) => line === 'password: tty-secret-123'))
  const pipedLines = []
  HAXCMS.announceSeededCredentials('admin', 'piped-secret-456', {
    isTTY: false,
    log: (line) => pipedLines.push(String(line)),
  })
  assert.equal(pipedLines.join('\n').indexOf('piped-secret-456'), -1)
  assert.ok(pipedLines.some((line) => line.indexOf(ttyFile) !== -1))
  // the file always holds the latest password and stays 0600
  assert.ok(fs.readFileSync(ttyFile, 'utf8').indexOf('password: piped-secret-456') !== -1)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(ttyFile).mode & 0o777, 0o600)
  }
})
