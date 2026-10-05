'use strict'

// In-process integration tests that boot the real server from src/app.js in
// DEVELOPMENT mode (NODE_ENV=development) with a linked webcomponents root
// (HAXCMS_WEBCOMPONENTS_ROOT) pointing at a fake package tree, so the linked
// dev asset resolution, import-map building, deduping-fix injection, dev
// reload script injection, and the chrome devtools routes all run.
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
const axios = require('axios')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const SITE_NAME = 'appdevsite'
const TEST_USER_NAME = 'app-dev-user'
const TEST_USER_PASSWORD = 'app-dev-pass'

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
  HAXCMS_WEBCOMPONENTS_ROOT: captureEnv('HAXCMS_WEBCOMPONENTS_ROOT'),
}

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-app-dev-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')
const sitesRoot = path.join(runtimeRoot, '_sites')
// fake linked webcomponents monorepo: packages + build assets + graph artifact
const wcRoot = path.join(tempRoot, 'wcroot')

fs.ensureDirSync(sitesRoot)
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

// fake monorepo surface the linked-dev code paths resolve against
fs.ensureDirSync(path.join(wcRoot, 'node_modules', '@haxtheweb', 'some-el'))
fs.writeJsonSync(path.join(wcRoot, 'node_modules', '@haxtheweb', 'some-el', 'package.json'), {
  name: '@haxtheweb/some-el',
  main: 'index.js',
})
fs.writeFileSync(
  path.join(wcRoot, 'node_modules', '@haxtheweb', 'some-el', 'index.js'),
  '// some-el entry',
)
fs.ensureDirSync(path.join(wcRoot, 'node_modules', 'plainpkg'))
fs.writeJsonSync(path.join(wcRoot, 'node_modules', 'plainpkg', 'package.json'), {
  name: 'plainpkg',
  module: 'lib/entry.js',
})
fs.ensureDirSync(path.join(wcRoot, 'node_modules', 'plainpkg', 'lib'))
fs.writeFileSync(
  path.join(wcRoot, 'node_modules', 'plainpkg', 'lib', 'entry.js'),
  '// plainpkg entry',
)
fs.ensureDirSync(path.join(wcRoot, 'node_modules', '@haxtheweb', 'deduping-fix'))
fs.writeFileSync(
  path.join(wcRoot, 'node_modules', '@haxtheweb', 'deduping-fix', 'deduping-fix.js'),
  '// deduping fix',
)
fs.writeFileSync(path.join(wcRoot, 'build.js'), '// linked build.js')
fs.writeJsonSync(path.join(wcRoot, 'wc-registry.json'), {
  'some-el': '@haxtheweb/some-el/some-el.js',
})
fs.writeJsonSync(path.join(wcRoot, 'wc-registry-graph.json'), {
  paths: ['@haxtheweb/some-el/index.js'],
  adj: { 0: [] },
  tags: { 'some-el': 0 },
})
fs.ensureDirSync(path.join(wcRoot, 'elements'))

process.chdir(runtimeRoot)
process.env.HAXCMS_ROOT = runtimeRoot + '/'
process.env.PORT = '0'
process.env.NODE_ENV = 'development'
process.env.HAXCMS_WEBCOMPONENTS_ROOT = wcRoot
delete process.env.HAXCMS_ENABLE_SSL

globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
  username: TEST_USER_NAME,
  password: TEST_USER_PASSWORD,
}

const appModule = require(APP_ENTRY_PATH)
const { HAXCMS } = require(path.join(REPO_ROOT, 'src', 'lib', 'HAXCMS.js'))

async function request(method, url, options) {
  const config = {
    method: method,
    url: url,
    validateStatus: function () {
      return true
    },
  }
  if (options && options.headers) {
    config.headers = options.headers
  }
  const response = await axios(config)
  return {
    status: response.status,
    headers: response.headers || {},
    bodyText:
      typeof response.data === 'string'
        ? response.data
        : response.data === null || response.data === undefined
          ? ''
          : JSON.stringify(response.data),
  }
}

const baseUrlPromise = appModule.serverReady.then(function (port) {
  return 'http://127.0.0.1:' + port
})

test.before(async () => {
  const baseUrl = await baseUrlPromise
  await HAXCMS.createSite(SITE_NAME)
})

test.after(async () => {
  if (appModule.server && typeof appModule.server.close === 'function') {
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
  restoreEnv('HAXCMS_WEBCOMPONENTS_ROOT', envSnapshots.HAXCMS_WEBCOMPONENTS_ROOT)
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
  fs.removeSync(tempRoot)
  // the dev-mode boot creates a chokidar watcher and a ws server that
  // app.js does not export, and they keep the event loop alive after the
  // runner finishes; schedule a delayed forced exit that only fires when
  // the natural exit is blocked (the timer is unreferenced, so a clean run
  // still exits on its own before it triggers)
  const forceExit = setTimeout(function () {
    process.exit(0)
  }, 1500)
  if (typeof forceExit.unref === 'function') {
    forceExit.unref()
  }
})

test('the dev-mode boot stays http on an ephemeral port', async () => {
  await baseUrlPromise
  assert.equal(appModule.serverProtocol, 'http')
  assert.equal(HAXCMS.runtimeServerMode, 'multisite')
})

test('the dev dashboard index injects the dev reload and linked import map', async () => {
  const baseUrl = await baseUrlPromise
  const result = await request('GET', baseUrl + '/', {})
  assert.equal(result.status, 200)
  assert.ok(result.bodyText.indexOf('data-haxcms-dev-reload') !== -1)
  assert.ok(result.bodyText.indexOf('data-haxcms-linked-dev-deduping-fix') !== -1)
  assert.ok(result.bodyText.indexOf('data-haxcms-linked-dev-importmap') !== -1)
  assert.ok(result.bodyText.indexOf('@haxtheweb/some-el') !== -1)
  assert.ok(result.bodyText.indexOf('nonce=') !== -1)
})

test('linked module assets resolve from the fake monorepo', async () => {
  const baseUrl = await baseUrlPromise
  const entry = await request(
    'GET',
    baseUrl + '/build/es6/node_modules/@haxtheweb/some-el/',
    {},
  )
  assert.equal(entry.status, 200)
  assert.ok(entry.bodyText.indexOf('some-el entry') !== -1)
  const moduleEntry = await request(
    'GET',
    baseUrl + '/build/es6/node_modules/plainpkg/lib/entry.js',
    {},
  )
  assert.equal(moduleEntry.status, 200)
  assert.ok(moduleEntry.bodyText.indexOf('plainpkg entry') !== -1)
})

test('linked root build assets serve from the fake monorepo', async () => {
  const baseUrl = await baseUrlPromise
  const build = await request('GET', baseUrl + '/build.js', {})
  assert.equal(build.status, 200)
  assert.ok(build.bodyText.indexOf('linked build.js') !== -1)
  const registry = await request('GET', baseUrl + '/wc-registry.json', {})
  assert.equal(registry.status, 200)
  const graph = await request('GET', baseUrl + '/wc-registry-graph.json', {})
  assert.equal(graph.status, 200)
  assert.ok(graph.bodyText.indexOf('some-el') !== -1)
})

test('the dev chrome devtools route answers for a known site', async () => {
  const baseUrl = await baseUrlPromise
  const result = await request(
    'GET',
    baseUrl + '/_sites/' + SITE_NAME + '/.well-known/appspecific/com.chrome.devtools.json',
    {},
  )
  assert.equal(result.status, 200)
  const body = JSON.parse(result.bodyText)
  assert.ok(body.workspace.root.indexOf(SITE_NAME) !== -1)
  const missing = await request(
    'GET',
    baseUrl + '/_sites/no-such-dev-site/.well-known/appspecific/com.chrome.devtools.json',
    {},
  )
  assert.equal(missing.status, 404)
  // note: the deployment-root devtools route is registered in the
  // single-site branch only; multisite dev boots only expose the site-scoped
  // route above
})
