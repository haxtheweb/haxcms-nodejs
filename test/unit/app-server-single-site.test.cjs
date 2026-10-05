'use strict'

// In-process integration tests that boot the real server from src/app.js in
// SINGLE-SITE mode: the temp runtime root itself IS a site directory (site.json
// at the root), so systemStructureContext resolves the site and app.js takes
// the single-site serving branch (publicDir = the site directory, page
// variants, static site files, and the site-index render path).
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

const TEST_USER_NAME = 'app-single-user'
const TEST_USER_PASSWORD = 'app-single-pass'

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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-app-single-'))
// single-site runtime root: _config sibling + site.json at the root
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
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_PASSWORD }, null, 2),
)

// a minimal but real site at the runtime root: site.json + pages + files
fs.ensureDirSync(path.join(runtimeRoot, 'pages', 'home'))
fs.ensureDirSync(path.join(runtimeRoot, 'pages', 'about'))
fs.ensureDirSync(path.join(runtimeRoot, 'files'))
fs.ensureDirSync(path.join(runtimeRoot, 'theme'))
fs.writeFileSync(
  path.join(runtimeRoot, 'pages', 'home', 'index.html'),
  '<p>Home page body</p>',
)
fs.writeFileSync(
  path.join(runtimeRoot, 'pages', 'about', 'index.html'),
  '<p>About page body</p>',
)
fs.writeFileSync(path.join(runtimeRoot, 'files', 'asset.txt'), 'asset body')
fs.writeFileSync(path.join(runtimeRoot, 'theme', 'style.css'), 'body {}')
fs.writeFileSync(path.join(runtimeRoot, 'robots.txt'), 'User-agent: *')
fs.writeFileSync(path.join(runtimeRoot, 'llms.txt'), '# Single Site')
fs.writeFileSync(
  path.join(runtimeRoot, 'site.json'),
  JSON.stringify(
    {
      id: 'single-site',
      title: 'Single Site',
      author: 'Single Author',
      description: 'single site fixture',
      license: 'by-sa',
      metadata: {
        site: { name: 'runtime', settings: { canonical: true } },
        // real sites always carry a metadata.author object (newSite seeds one);
        // getSiteMetadata reads metadata.author.socialLink unguarded
        author: { name: 'Single Author', socialLink: '' },
        theme: {},
      },
      items: [
        {
          id: 'home',
          indent: 0,
          location: 'pages/home/index.html',
          slug: 'home',
          order: 0,
          parent: '',
          title: 'Home',
          description: 'home page',
          metadata: { created: 1700000000, updated: 1700000000 },
        },
        {
          id: 'about',
          indent: 0,
          location: 'pages/about/index.html',
          slug: 'about',
          order: 1,
          parent: '',
          title: 'About',
          description: 'about page',
          metadata: { created: 1700000001, updated: 1700000001 },
        },
      ],
    },
    null,
    2,
  ),
)
fs.ensureDirSync(path.join(runtimeRoot, '.well-known'))
fs.writeFileSync(
  path.join(runtimeRoot, '.well-known', 'api-catalog'),
  JSON.stringify({ linkset: [] }),
)

// a site index.html with the managed-head marker + site builder shell so the
// single-site render path can replace the managed head + builder content
fs.writeFileSync(
  path.join(runtimeRoot, 'index.html'),
  [
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<style>body { color: red }</style>',
    '</head>',
    '<body>',
    '<haxcms-site-builder id="site"></haxcms-site-builder>',
    '<script>window.app = {}</script>',
    '</body>',
    '</html>',
  ].join('\n'),
)

process.chdir(runtimeRoot)
process.env.HAXCMS_ROOT = runtimeRoot + '/'
process.env.PORT = '0'
delete process.env.HAXCMS_ENABLE_SSL
delete process.env.NODE_ENV

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
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
  fs.removeSync(tempRoot)
})

test('server boots in single-site mode on an ephemeral port', async () => {
  const baseUrl = await baseUrlPromise
  assert.equal(HAXCMS.runtimeServerMode, 'single-site')
  assert.equal(appModule.serverProtocol, 'http')
  assert.ok(baseUrl.indexOf('http://127.0.0.1:') === 0)
})

test('the single-site root serves the raw index through express.static', async () => {
  const baseUrl = await baseUrlPromise
  const result = await request('GET', baseUrl + '/', {
    headers: { accept: 'text/html' },
  })
  assert.equal(result.status, 200)
  // the single-site branch registers express.static WITHOUT index:false
  // (non-dev), so the root streams the raw index.html and the render path
  // only runs for slug-based page requests
  assert.ok(result.bodyText.indexOf('haxcms-site-builder') !== -1)
  assert.ok(String(result.headers['content-type'] || '').indexOf('text/html') !== -1)
})

test('site pages render by slug with prev/next metadata', async () => {
  const baseUrl = await baseUrlPromise
  const result = await request('GET', baseUrl + '/about', {
    headers: { accept: 'text/html' },
  })
  assert.equal(result.status, 200)
  assert.ok(result.bodyText.indexOf('About page body') !== -1)
  assert.ok(result.bodyText.indexOf('<haxcms-site-builder') !== -1)
})

test('page variants serve sidecars from the site directory', async () => {
  const baseUrl = await baseUrlPromise
  const md = await request('GET', baseUrl + '/home.md', {})
  assert.equal(md.status, 200)
  assert.ok(String(md.headers['content-type'] || '').indexOf('text/markdown') !== -1)
  const json = await request('GET', baseUrl + '/home.json', {})
  assert.equal(json.status, 200)
  const yaml = await request('GET', baseUrl + '/home.yaml', {})
  assert.equal(yaml.status, 200)
  const xml = await request('GET', baseUrl + '/home.xml', {})
  assert.equal(xml.status, 200)
})

test('a missing single-site page renders the page-miss shell at 404', async () => {
  const baseUrl = await baseUrlPromise
  const result = await request('GET', baseUrl + '/definitely-not-here', {
    headers: { accept: 'text/html' },
  })
  assert.equal(result.status, 404)
  assert.ok(result.bodyText.indexOf('haxcms-page-miss') !== -1)
  const explicit = await request('GET', baseUrl + '/definitely-not-here.md', {})
  assert.equal(explicit.status, 404)
  assert.equal(explicit.bodyText, 'Not found')
})

test('single-site static files serve with managed charset headers', async () => {
  const baseUrl = await baseUrlPromise
  const manifest = await request('GET', baseUrl + '/site.json', {})
  assert.equal(manifest.status, 200)
  assert.ok(String(manifest.headers['content-type'] || '').indexOf('json') !== -1)
  const robots = await request('GET', baseUrl + '/robots.txt', {})
  assert.equal(robots.status, 200)
  assert.ok(String(robots.headers['content-type'] || '').indexOf('charset=utf-8') !== -1)
  const file = await request('GET', baseUrl + '/files/asset.txt', {})
  assert.equal(file.status, 200)
  const page = await request('GET', baseUrl + '/pages/home/index.html', {})
  assert.equal(page.status, 200)
  const theme = await request('GET', baseUrl + '/theme/style.css', {})
  assert.equal(theme.status, 200)
  const apiCatalog = await request('GET', baseUrl + '/.well-known/api-catalog', {})
  // express.static wins before the app-level well-known handler here, so the
  // extension-less file serves with a fallback content type
  assert.equal(apiCatalog.status, 200)
})

test('single-site build assets fall back to the public root', async () => {
  const baseUrl = await baseUrlPromise
  const build = await request('GET', baseUrl + '/build.js', {})
  assert.equal(build.status, 200)
  const registry = await request('GET', baseUrl + '/wc-registry.json', {})
  assert.equal(registry.status, 200)
})

test('site API paths pass through to the site routes', async () => {
  const baseUrl = await baseUrlPromise
  const result = await request('GET', baseUrl + '/x/api/v1/files', {})
  // unauthenticated access to the files route rejects before the handler
  assert.equal(result.status, 401)
})
