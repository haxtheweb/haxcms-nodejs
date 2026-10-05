'use strict'

// In-process integration tests that boot the real server from src/app.js in
// MULTI-SITE mode (no site.json at the runtime root) against a temp runtime:
// seeded _config, a created site, ephemeral port via PORT=0, and runtime
// credential overrides. Follows the conformance harness boot pattern
// (require src/app.js, await serverReady, drive the real HTTP surface).
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
const vm = require('node:vm')
const axios = require('axios')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const SITE_NAME = 'appmultisite'
const TEST_USER_NAME = 'app-server-user'
const TEST_USER_PASSWORD = 'app-server-pass'
const GIT_AUTHOR_NAME = 'HAXcms App Server Unit'
const GIT_AUTHOR_EMAIL = 'app-server-unit@local.invalid'

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
  GIT_AUTHOR_NAME: captureEnv('GIT_AUTHOR_NAME'),
  GIT_AUTHOR_EMAIL: captureEnv('GIT_AUTHOR_EMAIL'),
  GIT_COMMITTER_NAME: captureEnv('GIT_COMMITTER_NAME'),
  GIT_COMMITTER_EMAIL: captureEnv('GIT_COMMITTER_EMAIL'),
}

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-app-multisite-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')
const sitesRoot = path.join(runtimeRoot, '_sites')

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

fs.ensureDirSync(sitesRoot)
seedRuntimeConfig()
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_PASSWORD }, null, 2),
)
// deployment-root agent skills discovery fixture
fs.ensureDirSync(path.join(runtimeRoot, '.well-known', 'agent-skills'))
fs.writeFileSync(
  path.join(runtimeRoot, '.well-known', 'agent-skills', 'index.json'),
  JSON.stringify({ skills: [{ name: 'unit-skill', url: 'unit-skill/SKILL.md' }] }),
)
// published directory fixture served by the _published route
fs.ensureDirSync(path.join(runtimeRoot, '_published'))
fs.writeFileSync(path.join(runtimeRoot, '_published', 'pub.txt'), 'published asset')

process.chdir(runtimeRoot)
// trailing slash required: HAXCMS.js string-concats HAXCMS_ROOT + sitesDirectory
process.env.HAXCMS_ROOT = runtimeRoot + '/'
process.env.PORT = '0'
process.env.GIT_AUTHOR_NAME = GIT_AUTHOR_NAME
process.env.GIT_AUTHOR_EMAIL = GIT_AUTHOR_EMAIL
process.env.GIT_COMMITTER_NAME = GIT_AUTHOR_NAME
process.env.GIT_COMMITTER_EMAIL = GIT_AUTHOR_EMAIL
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
  if (options && Object.prototype.hasOwnProperty.call(options, 'data')) {
    config.data = options.data
  }
  if (options && options.maxRedirects === 0) {
    config.maxRedirects = 0
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

function parseAppSettings(scriptSource) {
  const sandbox = { window: {} }
  vm.runInNewContext(String(scriptSource), sandbox, { timeout: 2000 })
  if (!sandbox.window || !sandbox.window.appSettings) {
    throw new Error('Unable to parse appSettings from connection-settings response')
  }
  return sandbox.window.appSettings
}

const runtime = {
  baseUrl: '',
  jwt: '',
  userToken: '',
  siteToken: '',
  sitePageId: '',
}

test.before(async () => {
  const port = await appModule.serverReady
  runtime.baseUrl = 'http://127.0.0.1:' + port
  // create a site through the real creation path for the static/variant tests
  await HAXCMS.createSite(SITE_NAME)
  const siteDir = path.join(sitesRoot, SITE_NAME)
  fs.ensureDirSync(path.join(siteDir, 'theme'))
  fs.writeFileSync(path.join(siteDir, 'theme', 'style.css'), 'body { margin: 0 }')
  fs.writeFileSync(path.join(siteDir, 'files', 'forced-download.html'), '<p>download me</p>')
  // login through the real session route for the JWT/user token
  const login = await request('POST', runtime.baseUrl + '/system/api/v1/session/login', {
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    data: JSON.stringify({
      username: TEST_USER_NAME,
      password: TEST_USER_PASSWORD,
    }),
  })
  assert.equal(login.status, 200, login.bodyText)
  const loginBody = JSON.parse(login.bodyText)
  runtime.jwt = loginBody.jwt
  const settings = await request(
    'GET',
    runtime.baseUrl + '/system/api/v1/session/connection-settings',
    {
      headers: { accept: 'application/javascript' },
    },
  )
  assert.equal(settings.status, 200, settings.bodyText)
  const appSettings = parseAppSettings(settings.bodyText)
  runtime.userToken = appSettings.userToken
  const siteSettings = await request(
    'GET',
    runtime.baseUrl + '/system/api/v1/session/connection-settings',
    {
      headers: {
        accept: 'application/javascript',
        referer: runtime.baseUrl + '/_sites/' + SITE_NAME + '/',
      },
    },
  )
  assert.equal(siteSettings.status, 200, siteSettings.bodyText)
  const siteAppSettings = parseAppSettings(siteSettings.bodyText)
  runtime.siteToken = siteAppSettings.siteToken
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
  restoreEnv('GIT_AUTHOR_NAME', envSnapshots.GIT_AUTHOR_NAME)
  restoreEnv('GIT_AUTHOR_EMAIL', envSnapshots.GIT_AUTHOR_EMAIL)
  restoreEnv('GIT_COMMITTER_NAME', envSnapshots.GIT_COMMITTER_NAME)
  restoreEnv('GIT_COMMITTER_EMAIL', envSnapshots.GIT_COMMITTER_EMAIL)
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
  fs.removeSync(tempRoot)
})

// ---------------------------------------------------------------------------
// boot mode + dashboard
// ---------------------------------------------------------------------------
test('server boots in multisite mode on an ephemeral port', async () => {
  assert.equal(HAXCMS.runtimeServerMode, 'multisite')
  assert.equal(appModule.serverProtocol, 'http')
  assert.ok(runtime.baseUrl.indexOf('http://127.0.0.1:') === 0)
})

test('dashboard index serves the app-hax shell with nonce injection', async () => {
  const result = await request('GET', runtime.baseUrl + '/', {})
  assert.equal(result.status, 200)
  assert.ok(result.bodyText.indexOf('<') !== -1)
  // inline scripts are stamped with the per-request CSP nonce
  assert.ok(result.bodyText.indexOf('nonce=') !== -1)
  // the agentskills discovery index is advertised via the Link header
  assert.ok(
    String(result.headers.link || '').indexOf('agentskills.io/rels/skills-index') !== -1,
  )
})

test('dashboard index also serves /home, /index.html, and createSite steps', async () => {
  for (const entry of ['/home', '/createSite-step-1']) {
    const result = await request('GET', runtime.baseUrl + entry, {})
    assert.equal(result.status, 200, entry)
    assert.ok(result.bodyText.indexOf('nonce=') !== -1, entry)
  }
  // /index.html is served raw by express.static (index:false only skips /),
  // so the static file streams without nonce injection
  const indexHtml = await request('GET', runtime.baseUrl + '/index.html', {})
  assert.equal(indexHtml.status, 200)
  assert.ok(indexHtml.bodyText.indexOf('<') !== -1)
})

test('unknown non-API paths fall through to the dashboard catch-all', async () => {
  const result = await request('GET', runtime.baseUrl + '/totally-random-page', {})
  assert.equal(result.status, 200)
  assert.ok(result.bodyText.indexOf('<') !== -1)
})

test('OPTIONS preflight answers 200 for any path', async () => {
  const result = await request('OPTIONS', runtime.baseUrl + '/anything/at/all', {})
  assert.equal(result.status, 200)
})

// ---------------------------------------------------------------------------
// multisite redirects + static site assets
// ---------------------------------------------------------------------------
test('/_sites redirects to the dashboard root with a 302', async () => {
  const result = await request('GET', runtime.baseUrl + '/_sites/', { maxRedirects: 0 })
  assert.equal(result.status, 302)
  assert.equal(result.headers.location, '/')
})

test('a bare site name redirects to the trailing slash with a 301', async () => {
  const result = await request('GET', runtime.baseUrl + '/_sites/' + SITE_NAME, {
    maxRedirects: 0,
  })
  assert.equal(result.status, 301)
  assert.equal(result.headers.location, '/_sites/' + SITE_NAME + '/')
})

test('site static files serve with content types', async () => {
  const manifest = await request('GET', runtime.baseUrl + '/_sites/' + SITE_NAME + '/site.json', {})
  assert.equal(manifest.status, 200)
  assert.ok(String(manifest.headers['content-type'] || '').indexOf('json') !== -1)
  const robots = await request('GET', runtime.baseUrl + '/_sites/' + SITE_NAME + '/robots.txt', {})
  assert.equal(robots.status, 200)
  assert.ok(String(robots.headers['content-type'] || '').indexOf('text/plain') !== -1)
  const theme = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/theme/style.css',
    {},
  )
  assert.equal(theme.status, 200)
  assert.ok(String(theme.headers['content-type'] || '').indexOf('text/css') !== -1)
  const serviceWorker = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/service-worker.js',
    {},
  )
  assert.equal(serviceWorker.status, 200)
})

test('build assets resolve from the public root', async () => {
  const build = await request('GET', runtime.baseUrl + '/_sites/' + SITE_NAME + '/build.js', {})
  assert.equal(build.status, 200)
  const registry = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/wc-registry.json',
    {},
  )
  assert.equal(registry.status, 200)
})

test('the wc-registry-graph asset serves from the public root', async () => {
  const result = await request('GET', runtime.baseUrl + '/wc-registry-graph.json', {})
  assert.equal(result.status, 200)
  assert.ok(String(result.headers['content-type'] || '').indexOf('json') !== -1)
})

test('deployment-root agent skills serve with open CORS', async () => {
  const result = await request(
    'GET',
    runtime.baseUrl + '/.well-known/agent-skills/index.json',
    {},
  )
  assert.equal(result.status, 200)
  assert.equal(result.headers['access-control-allow-origin'], '*')
  // compression appends accept-encoding to the Vary header alongside origin
  assert.ok(String(result.headers.vary || '').toLowerCase().indexOf('origin') !== -1)
})

test('site well-known api-catalog serves with the linkset content type', async () => {
  const result = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/.well-known/api-catalog',
    {},
  )
  assert.equal(result.status, 200)
  assert.ok(
    String(result.headers['content-type'] || '').indexOf('linkset+json') !== -1,
  )
  const securityTxt = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/.well-known/security.txt',
    {},
  )
  assert.equal(securityTxt.status, 200)
  assert.ok(String(securityTxt.headers['content-type'] || '').indexOf('text/plain') !== -1)
})

test('the published directory route serves files from _published', async () => {
  const result = await request('GET', runtime.baseUrl + '/_published/pub.txt', {})
  assert.equal(result.status, 200)
})

// ---------------------------------------------------------------------------
// security middleware
// ---------------------------------------------------------------------------
test('sensitive config files never web-serve and answer 404', async () => {
  const paths = [
    '/_sites/' + SITE_NAME + '/_config/.user',
    '/_sites/' + SITE_NAME + '/_config/userData.json',
    '/_sites/' + SITE_NAME + '/userData.json',
    '/_sites/' + SITE_NAME + '/apiKeys.json',
    '/%5fconfig/.user',
  ]
  for (let i = 0; i < paths.length; i++) {
    const result = await request('GET', runtime.baseUrl + paths[i], {})
    assert.equal(result.status, 404, paths[i])
  }
})

test('html files in a site files directory force a download disposition', async () => {
  const result = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/files/forced-download.html',
    {},
  )
  assert.equal(result.status, 200)
  assert.equal(String(result.headers['content-disposition'] || ''), 'attachment')
})

// ---------------------------------------------------------------------------
// page variant serving
// ---------------------------------------------------------------------------
test('site pages render the index with replaced managed head content', async () => {
  // an explicit text/html accept header opts out of variant negotiation
  // (a default application/json accept would serve the index.json sidecar)
  const result = await request('GET', runtime.baseUrl + '/_sites/' + SITE_NAME + '/', {
    headers: { accept: 'text/html' },
  })
  assert.equal(result.status, 200)
  assert.ok(result.bodyText.indexOf('haxcms-site-builder') !== -1)
  assert.ok(result.bodyText.indexOf('<haxcms-site-builder') !== -1)
  assert.ok(String(result.headers['content-type'] || '').indexOf('text/html') !== -1)
})

test('explicit page variants serve sidecar formats with headers', async () => {
  const base = runtime.baseUrl + '/_sites/' + SITE_NAME + '/welcome'
  const md = await request('GET', base + '.md', {})
  assert.equal(md.status, 200)
  assert.ok(String(md.headers['content-type'] || '').indexOf('text/markdown') !== -1)
  assert.ok(String(md.headers['content-location'] || '').indexOf('welcome.md') !== -1)
  const json = await request('GET', base + '.json', {})
  assert.equal(json.status, 200)
  assert.ok(String(json.headers['content-type'] || '').indexOf('application/json') !== -1)
  const yaml = await request('GET', base + '.yaml', {})
  assert.equal(yaml.status, 200)
  assert.ok(String(yaml.headers['content-type'] || '').indexOf('application/yaml') !== -1)
  const xml = await request('GET', base + '.xml', {})
  assert.equal(xml.status, 200)
  assert.ok(String(xml.headers['content-type'] || '').indexOf('application/xml') !== -1)
})

test('content negotiation serves the markdown variant via the Accept header', async () => {
  const result = await request('GET', runtime.baseUrl + '/_sites/' + SITE_NAME + '/welcome', {
    headers: { accept: 'text/markdown' },
  })
  assert.equal(result.status, 200)
  assert.ok(String(result.headers['content-type'] || '').indexOf('text/markdown') !== -1)
  assert.ok(String(result.headers.vary || '').toLowerCase().indexOf('accept') !== -1)
})

test('a missing page variant answers a 404 plain text body', async () => {
  const result = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/definitely-not-here.md',
    {},
  )
  assert.equal(result.status, 404)
  assert.equal(result.bodyText, 'Not found')
})

test('a missing page without an extension renders the page-miss shell at 404', async () => {
  const result = await request(
    'GET',
    runtime.baseUrl + '/_sites/' + SITE_NAME + '/definitely-not-here',
    {},
  )
  assert.equal(result.status, 404)
  assert.ok(result.bodyText.indexOf('haxcms-page-miss') !== -1)
  assert.ok(result.bodyText.indexOf('The page miss, it burns!') !== -1)
})

// ---------------------------------------------------------------------------
// site API auth matrix (validateSiteApiRouteAccess)
// ---------------------------------------------------------------------------
test('site API files route enforces the full auth matrix', async () => {
  const url = runtime.baseUrl + '/_sites/' + SITE_NAME + '/x/api/v1/files'
  const noCreds = await request('GET', url, {})
  assert.equal(noCreds.status, 401)
  assert.equal(
    JSON.parse(noCreds.bodyText).data.message,
    'Authorization bearer token or basic credentials are required for this endpoint',
  )
  const badBearer = await request('GET', url, {
    headers: { authorization: 'Bearer not-a-real-jwt' },
  })
  assert.equal(badBearer.status, 403)
  assert.equal(JSON.parse(badBearer.bodyText).data.message, 'Invalid bearer token')
  const badBasic = await request('GET', url, {
    headers: {
      authorization:
        'Basic ' + Buffer.from(TEST_USER_NAME + ':wrong-pass', 'utf8').toString('base64'),
    },
  })
  assert.equal(badBasic.status, 401)
  assert.equal(
    JSON.parse(badBasic.bodyText).data.message,
    'Invalid basic authorization credentials',
  )
  const missingSiteToken = await request('GET', url, {
    headers: { authorization: 'Bearer ' + runtime.jwt },
  })
  assert.equal(missingSiteToken.status, 403)
  assert.equal(
    JSON.parse(missingSiteToken.bodyText).data.message,
    'X-HAXCMS-Site-Token header is required for this endpoint',
  )
  const invalidSiteToken = await request('GET', url, {
    headers: {
      authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': 'invalid-site-token',
    },
  })
  assert.equal(invalidSiteToken.status, 403)
  assert.equal(
    JSON.parse(invalidSiteToken.bodyText).data.message,
    'Invalid X-HAXCMS-Site-Token header',
  )
  const allowed = await request('GET', url, {
    headers: {
      authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': runtime.siteToken,
    },
  })
  assert.equal(allowed.status, 200, allowed.bodyText)
})

// ---------------------------------------------------------------------------
// system route auth matrix (systemRouteHandler)
// ---------------------------------------------------------------------------
test('non-open system routes require authentication and reject bad bearers', async () => {
  const url = runtime.baseUrl + '/system/api/v1/status'
  const noCreds = await request('GET', url, {})
  assert.equal(noCreds.status, 401)
  assert.equal(JSON.parse(noCreds.bodyText).data.message, 'Authentication required')
  const badBearer = await request('GET', url, {
    headers: { authorization: 'Bearer not-a-real-jwt' },
  })
  assert.equal(badBearer.status, 403)
  assert.equal(JSON.parse(badBearer.bodyText).data.message, 'Invalid bearer token')
})

test('basic authentication satisfies non-open system routes', async () => {
  const url = runtime.baseUrl + '/system/api/v1/status'
  const result = await request('GET', url, {
    headers: {
      authorization:
        'Basic ' +
        Buffer.from(TEST_USER_NAME + ':' + TEST_USER_PASSWORD, 'utf8').toString('base64'),
      'X-HAXCMS-User-Token': runtime.userToken,
    },
  })
  assert.equal(result.status, 200, result.bodyText)
})

test('authenticated-user system routes require the user token header', async () => {
  const url = runtime.baseUrl + '/system/api/v1/skeletons'
  const missing = await request('PATCH', url, {
    headers: {
      authorization:
        'Basic ' +
        Buffer.from(TEST_USER_NAME + ':' + TEST_USER_PASSWORD, 'utf8').toString('base64'),
      'content-type': 'application/json',
    },
    data: JSON.stringify({ enabledSkeletons: {} }),
  })
  assert.equal(missing.status, 403)
  assert.equal(
    JSON.parse(missing.bodyText).data.message,
    'X-HAXCMS-User-Token header is required for this endpoint',
  )
  const invalid = await request('PATCH', url, {
    headers: {
      authorization:
        'Basic ' +
        Buffer.from(TEST_USER_NAME + ':' + TEST_USER_PASSWORD, 'utf8').toString('base64'),
      'content-type': 'application/json',
      'X-HAXCMS-User-Token': 'invalid-user-token',
    },
    data: JSON.stringify({ enabledSkeletons: {} }),
  })
  assert.equal(invalid.status, 403)
  assert.equal(JSON.parse(invalid.bodyText).data.message, 'Invalid X-HAXCMS-User-Token header')
})

test('failed basic auth attempts rate limit with a 429 and Retry-After', async () => {
  const url = runtime.baseUrl + '/system/api/v1/status'
  const badHeader =
    'Basic ' + Buffer.from('rate-limit-probe:wrong-pass', 'utf8').toString('base64')
  // exhaust the configured attempts (default max 5)
  for (let i = 0; i < 5; i++) {
    const result = await request('GET', url, { headers: { authorization: badHeader } })
    assert.equal(result.status, 401)
  }
  const blocked = await request('GET', url, { headers: { authorization: badHeader } })
  assert.equal(blocked.status, 429)
  assert.equal(
    JSON.parse(blocked.bodyText).data.message,
    'Too many failed login attempts. Please try again later.',
  )
  assert.ok(Number(blocked.headers['retry-after']) > 0)
})

// ---------------------------------------------------------------------------
// 405 + Allow dispatch and the error middleware
// ---------------------------------------------------------------------------
test('a registered route with the wrong method answers 405 with Allow', async () => {
  const result = await request('DELETE', runtime.baseUrl + '/system/api/v1/status', {})
  assert.equal(result.status, 405)
  const allow = String(result.headers.allow || '')
  assert.ok(allow.indexOf('GET') !== -1)
  assert.ok(allow.indexOf('POST') !== -1)
  const body = JSON.parse(result.bodyText)
  assert.equal(body.data.message, 'Method not allowed')
  assert.ok(body.data.methods.indexOf('GET') !== -1)
})

test('malformed JSON bodies reach the error middleware as a 500', async () => {
  const result = await request('POST', runtime.baseUrl + '/system/api/v1/session/login', {
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    data: '{ this is not valid json',
  })
  assert.equal(result.status, 500)
  assert.equal(result.bodyText, 'Server error')
})
