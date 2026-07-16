'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const vm = require('node:vm')
const util = require('node:util')
const childProcess = require('node:child_process')
const axios = require('axios')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const SITE_DIRECTORY_NAME = '_sites'
const TEST_USER_NAME = process.env.HAXCMS_TEST_USERNAME || 'api-conformance-user'
const TEST_USER_PASSWORD = process.env.HAXCMS_TEST_PASSWORD || 'api-conformance-pass'
const TEST_GIT_AUTHOR_NAME = 'API Conformance Harness'
const TEST_GIT_AUTHOR_EMAIL = 'api-conformance@local.invalid'
const execFile = util.promisify(childProcess.execFile)

const ITEM_EXPORT_FORMATS = ['pdf', 'docx', 'html', 'md', 'json', 'yaml', 'xml', 'epub']
const SITE_EXPORT_FORMATS = ['pdf', 'docx', 'html', 'epub']

const EXPECTED_MEDIA_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  md: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  xml: 'application/xml',
  epub: 'application/epub+zip',
}

// Binary signature checks: first bytes of the response body
function getBinarySignature(buffer, format) {
  const hex = Buffer.from(buffer).slice(0, 8).toString('hex').toUpperCase()
  switch (format) {
    case 'pdf':
      // %PDF-1.x
      return hex.startsWith('25504446') // %PDF
    case 'docx':
    case 'epub':
      // ZIP: PK\x03\x04
      return hex.startsWith('504B0304')
    default:
      return null // text formats checked by content, not signature
  }
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(String(value || ''))
  } catch (error) {
    return null
  }
}

function parseConnectionSettingsScript(scriptSource) {
  const sandbox = { window: {} }
  vm.runInNewContext(String(scriptSource || ''), sandbox, { timeout: 1000 })
  if (!sandbox.window || !sandbox.window.appSettings || typeof sandbox.window.appSettings !== 'object') {
    throw new Error('Unable to parse appSettings from connectionSettings response')
  }
  return sandbox.window.appSettings
}

async function sendHttpRequest(requestConfig) {
  const response = await axios({
    method: requestConfig.method,
    url: requestConfig.url,
    headers: requestConfig.headers,
    data: requestConfig.body,
    validateStatus: () => true,
    responseType: requestConfig.responseType || 'text',
    transformResponse: [(data) => data],
  })
  return {
    status: response.status,
    headers: response.headers || {},
    bodyText: typeof response.data === 'string' ? response.data : '',
    data: response.data,
  }
}

async function loginForJwt(baseUrl) {
  const loginResponse = await sendHttpRequest({
    method: 'POST',
    url: `${baseUrl}/system/api/v1/session/login`,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER_NAME, password: TEST_USER_PASSWORD }),
  })
  assert.equal(loginResponse.status, 200, `Login failed: ${loginResponse.status}`)
  const loginBody = parseJsonSafely(loginResponse.bodyText)
  assert.ok(loginBody && typeof loginBody.jwt === 'string', 'No jwt in login response')
  return loginBody.jwt
}

async function requestConnectionSettings(baseUrl, refererPath = '') {
  const headers = { accept: 'application/javascript' }
  if (refererPath) headers.referer = `${baseUrl}${refererPath}`
  const settingsResponse = await sendHttpRequest({
    method: 'GET',
    url: `${baseUrl}/system/api/v1/session/connection-settings`,
    headers,
  })
  assert.equal(settingsResponse.status, 200, `connectionSettings failed: ${settingsResponse.status}`)
  return parseConnectionSettingsScript(settingsResponse.bodyText)
}

async function createHarnessSite(baseUrl, jwt, dashboardSettings, siteName) {
  const createSitePath = (dashboardSettings && typeof dashboardSettings.createSite === 'string' && dashboardSettings.createSite.trim() !== '') ? dashboardSettings.createSite : '/system/api/v1/sites'
  const createSiteHeaders = (dashboardSettings && dashboardSettings.createSiteHeaders && typeof dashboardSettings.createSiteHeaders === 'object') ? dashboardSettings.createSiteHeaders : {}
  const requestHeaders = { accept: 'application/json', 'content-type': 'application/json', Authorization: `Bearer ${jwt}`, ...createSiteHeaders }
  const normalizedCreateSitePath = String(createSitePath || '').trim()
  const createSiteUrl = /^https?:\/\//i.test(normalizedCreateSitePath) ? normalizedCreateSitePath : `${baseUrl}${normalizedCreateSitePath.charAt(0) === '/' ? '' : '/'}${normalizedCreateSitePath}`
  const createSiteResponse = await sendHttpRequest({
    method: 'POST',
    url: createSiteUrl,
    headers: requestHeaders,
    body: JSON.stringify({ jwt, token: dashboardSettings.token, site: { name: siteName, description: 'Runtime export integration test site' } }),
  })
  assert.equal(createSiteResponse.status, 200, `createSite failed: ${createSiteResponse.status}`)
}

function getGitIdentityEnvironment(baseEnvironment) {
  const merged = { ...(baseEnvironment || process.env) }
  merged.GIT_AUTHOR_NAME = TEST_GIT_AUTHOR_NAME
  merged.GIT_AUTHOR_EMAIL = TEST_GIT_AUTHOR_EMAIL
  merged.GIT_COMMITTER_NAME = TEST_GIT_AUTHOR_NAME
  merged.GIT_COMMITTER_EMAIL = TEST_GIT_AUTHOR_EMAIL
  return merged
}

async function runGitCommand(cwd, args) {
  const result = await execFile('git', ['--no-pager'].concat(args || []), { cwd, env: getGitIdentityEnvironment(process.env), maxBuffer: 1024 * 1024 * 10 })
  return (typeof result.stdout === 'string' ? result.stdout : '').trim()
}

async function ensureSiteHasInitialCommit(runtimeRoot, siteName) {
  const siteDirectory = path.join(runtimeRoot, SITE_DIRECTORY_NAME, siteName)
  if (!fs.pathExistsSync(siteDirectory)) return
  try {
    await runGitCommand(siteDirectory, ['rev-parse', '--verify', 'HEAD'])
    return
  } catch (error) {}
  let isGitRepository = true
  try {
    const insideWorkTree = await runGitCommand(siteDirectory, ['rev-parse', '--is-inside-work-tree'])
    if (insideWorkTree !== 'true') isGitRepository = false
  } catch (error) { isGitRepository = false }
  if (!isGitRepository) await runGitCommand(siteDirectory, ['init'])
  await runGitCommand(siteDirectory, ['add', '.'])
  await runGitCommand(siteDirectory, ['commit', '--no-gpg-sign', '--allow-empty', '-m', 'Initialize export integration test site'])
}

function ensureSiteApiCatalog(runtimeRoot, siteName) {
  const siteDirectory = path.join(runtimeRoot, SITE_DIRECTORY_NAME, siteName)
  fs.ensureDirSync(siteDirectory)
  const sourceApiCatalogPath = path.join(REPO_ROOT, 'src', 'boilerplate', 'site', '.well-known', 'api-catalog')
  const targetWellKnownDirectory = path.join(siteDirectory, '.well-known')
  fs.ensureDirSync(targetWellKnownDirectory)
  if (fs.pathExistsSync(sourceApiCatalogPath)) {
    fs.copyFileSync(sourceApiCatalogPath, path.join(targetWellKnownDirectory, 'api-catalog'))
  }
}

function seedRuntimeConfig(runtimeConfigRoot) {
  fs.ensureDirSync(runtimeConfigRoot)
  fs.writeFileSync(path.join(runtimeConfigRoot, '.isHAXcmsConfig'), '')
  const configSourceRoot = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')
  const configSeedFiles = ['config.json', 'my-custom-elements.js', 'userData.json', 'config.php', '.htaccess', '.user-files-htaccess']
  for (let i = 0; i < configSeedFiles.length; i++) {
    fs.copySync(path.join(configSourceRoot, configSeedFiles[i]), path.join(runtimeConfigRoot, configSeedFiles[i]))
  }
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'tmp'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'cache'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'settings'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'node_modules'))
}

async function setupRuntime() {
  const runtime = {
    originalCwd: process.cwd(),
    envSnapshots: {
      PORT: process.env.PORT, HOME: process.env.HOME, HAXCMS_ROOT: process.env.HAXCMS_ROOT,
      HAXCMS_DISABLE_JWT_CHECKS: process.env.HAXCMS_DISABLE_JWT_CHECKS, HAXCMS_ALLOW_DEFAULT_CREDS: process.env.HAXCMS_ALLOW_DEFAULT_CREDS,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    },
  }
  runtime.testStartTimestamp = Date.now()
  runtime.createdSiteName = `haxcms-export-test-${runtime.testStartTimestamp}`
  runtime.tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-export-int-'))
  runtime.runtimeRoot = path.join(runtime.tempDirectory, 'runtime')
  runtime.homeDirectory = path.join(runtime.tempDirectory, 'home')
  runtime.runtimeConfigRoot = path.join(runtime.runtimeRoot, '_config')
  fs.ensureDirSync(runtime.runtimeRoot)
  fs.ensureDirSync(runtime.homeDirectory)
  fs.ensureDirSync(path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME))
  seedRuntimeConfig(runtime.runtimeConfigRoot)
  process.chdir(runtime.runtimeRoot)
  process.env.HOME = runtime.homeDirectory
  process.env.HAXCMS_ROOT = runtime.runtimeRoot
  process.env.PORT = '0'
  process.env.GIT_AUTHOR_NAME = TEST_GIT_AUTHOR_NAME
  process.env.GIT_AUTHOR_EMAIL = TEST_GIT_AUTHOR_EMAIL
  process.env.GIT_COMMITTER_NAME = TEST_GIT_AUTHOR_NAME
  process.env.GIT_COMMITTER_EMAIL = TEST_GIT_AUTHOR_EMAIL
  delete process.env.HAXCMS_DISABLE_JWT_CHECKS
  globalThis.HAXCMS_RUNTIME_CREDENTIALS = { username: TEST_USER_NAME, password: TEST_USER_PASSWORD }
  globalThis.HAXCMS_RUNTIME_USERNAME = TEST_USER_NAME
  globalThis.HAXCMS_RUNTIME_PASSWORD = TEST_USER_PASSWORD
  delete require.cache[require.resolve(APP_ENTRY_PATH)]
  runtime.appModule = require(APP_ENTRY_PATH)
  runtime.port = await runtime.appModule.serverReady
  runtime.baseUrl = `http://127.0.0.1:${runtime.port}`
  runtime.jwt = await loginForJwt(runtime.baseUrl)
  runtime.dashboardSettings = await requestConnectionSettings(runtime.baseUrl)
  await createHarnessSite(runtime.baseUrl, runtime.jwt, runtime.dashboardSettings, runtime.createdSiteName)
  ensureSiteApiCatalog(runtime.runtimeRoot, runtime.createdSiteName)
  await ensureSiteHasInitialCommit(runtime.runtimeRoot, runtime.createdSiteName)
  runtime.siteSettings = await requestConnectionSettings(runtime.baseUrl, `/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/`)
  runtime.siteApiBasePath = runtime.siteSettings.siteApiBasePath
  // Resolve the first item (created sites ship with a default page)
  const itemsResponse = await sendHttpRequest({
    method: 'GET',
    url: `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/${runtime.siteApiBasePath}/v1/items`,
    headers: { accept: 'application/json' },
  })
  const itemsBody = parseJsonSafely(itemsResponse.bodyText)
  const items = (itemsBody && itemsBody.data && Array.isArray(itemsBody.data.items)) ? itemsBody.data.items : []
  assert.ok(items.length > 0, 'Expected at least one item in the created site')
  runtime.firstItem = items[0]
  runtime.firstItemLookup = String(runtime.firstItem.slug || runtime.firstItem.id || '').trim()
  assert.ok(runtime.firstItemLookup !== '', 'First item has no slug or id')
  return runtime
}

async function teardownRuntime(runtime) {
  if (!runtime) return
  if (runtime.appModule && runtime.appModule.server && typeof runtime.appModule.server.close === 'function') {
    await new Promise((resolve) => { runtime.appModule.server.close(() => resolve()) })
  }
  if (runtime.originalCwd) process.chdir(runtime.originalCwd)
  process.env.PORT = runtime.envSnapshots.PORT
  process.env.HOME = runtime.envSnapshots.HOME
  process.env.HAXCMS_ROOT = runtime.envSnapshots.HAXCMS_ROOT
  if (runtime.tempDirectory && fs.pathExistsSync(runtime.tempDirectory)) fs.removeSync(runtime.tempDirectory)
}

let runtime = null

test.before(async () => { runtime = await setupRuntime() })
test.after(async () => { await teardownRuntime(runtime) })

test('item export endpoints produce real file downloads across all 8 formats', async (t) => {
  const itemBase = `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/${runtime.siteApiBasePath}/v1/items/${encodeURIComponent(runtime.firstItemLookup)}/export`
  for (let i = 0; i < ITEM_EXPORT_FORMATS.length; i++) {
    const format = ITEM_EXPORT_FORMATS[i]
    await t.test(`item export ${format} returns 200 with correct content-type and disposition`, async () => {
      const result = await sendHttpRequest({
        method: 'GET',
        url: `${itemBase}/${format}`,
        headers: { accept: '*/*' },
        responseType: 'arraybuffer',
      })
      assert.equal(result.status, 200, `item export ${format} expected 200, got ${result.status}: ${result.bodyText}`)
      const contentType = String(result.headers['content-type'] || '').toLowerCase()
      const expected = EXPECTED_MEDIA_TYPES[format]
      assert.ok(
        contentType.indexOf(expected.split(';')[0]) !== -1,
        `item export ${format} content-type "${contentType}" does not include "${expected}"`,
      )
      const disposition = String(result.headers['content-disposition'] || '')
      assert.ok(
        disposition.indexOf('attachment') !== -1 && disposition.indexOf(`.${format}`) !== -1,
        `item export ${format} missing attachment disposition with .${format} extension: "${disposition}"`,
      )
      const buffer = Buffer.from(result.data || '')
      assert.ok(buffer.length > 0, `item export ${format} returned empty body`)
      // Binary signature checks for zip/pdf formats
      const sig = getBinarySignature(buffer, format)
      if (sig !== null) {
        assert.ok(sig, `item export ${format} binary signature mismatch (first bytes: ${buffer.slice(0, 8).toString('hex')})`)
      }
      // Text-format content sanity
      if (format === 'html') {
        const text = buffer.toString('utf8')
        assert.ok(text.toLowerCase().indexOf('<!doctype html') !== -1 || text.toLowerCase().indexOf('<html') !== -1, `item export html is not an HTML document`)
      }
      if (format === 'md') {
        const text = buffer.toString('utf8')
        assert.ok(text.indexOf('# ') !== -1, `item export md missing title heading`)
      }
      if (format === 'json') {
        const parsed = parseJsonSafely(buffer.toString('utf8'))
        assert.ok(parsed && (parsed.id || parsed.title || parsed.slug), `item export json not a valid item record`)
      }
      if (format === 'yaml') {
        const text = buffer.toString('utf8')
        assert.ok(text.indexOf('id:') !== -1 || text.indexOf('title:') !== -1, `item export yaml missing expected keys`)
      }
      if (format === 'xml') {
        const text = buffer.toString('utf8')
        assert.ok(text.indexOf('<?xml') !== -1 || text.indexOf('<response') !== -1 || text.indexOf('<item') !== -1, `item export xml missing xml declaration/root`)
      }
    })
  }
})

test('item record advertises all 8 export formats in the exports block', async () => {
  const result = await sendHttpRequest({
    method: 'GET',
    url: `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/${runtime.siteApiBasePath}/v1/items/${encodeURIComponent(runtime.firstItemLookup)}`,
    headers: { accept: 'application/json' },
  })
  assert.equal(result.status, 200, `item detail expected 200, got ${result.status}`)
  const body = parseJsonSafely(result.bodyText)
  const exports = body && body.data && body.data.exports
  assert.ok(exports && typeof exports === 'object', 'item detail missing exports object')
  for (let i = 0; i < ITEM_EXPORT_FORMATS.length; i++) {
    const format = ITEM_EXPORT_FORMATS[i]
    assert.ok(
      Object.prototype.hasOwnProperty.call(exports, format),
      `exports block missing key "${format}" (has: ${Object.keys(exports).join(', ')})`,
    )
    assert.ok(
      String(exports[format]).indexOf(`/export/${format}`) !== -1,
      `exports.${format} does not point at the export endpoint: "${exports[format]}"`,
    )
  }
})

test('site export endpoints produce real file downloads for pdf/docx/html/epub', async (t) => {
  const siteBase = `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/${runtime.siteApiBasePath}/v1/site/export`
  for (let i = 0; i < SITE_EXPORT_FORMATS.length; i++) {
    const format = SITE_EXPORT_FORMATS[i]
    await t.test(`site export ${format} returns 200 with correct content-type and disposition`, async () => {
      const result = await sendHttpRequest({
        method: 'GET',
        url: `${siteBase}/${format}`,
        headers: { accept: '*/*' },
        responseType: 'arraybuffer',
      })
      assert.equal(result.status, 200, `site export ${format} expected 200, got ${result.status}`)
      const contentType = String(result.headers['content-type'] || '').toLowerCase()
      const expected = EXPECTED_MEDIA_TYPES[format]
      assert.ok(
        contentType.indexOf(expected.split(';')[0]) !== -1,
        `site export ${format} content-type "${contentType}" does not include "${expected}"`,
      )
      const buffer = Buffer.from(result.data || '')
      assert.ok(buffer.length > 0, `site export ${format} returned empty body`)
      const sig = getBinarySignature(buffer, format)
      if (sig !== null) {
        assert.ok(sig, `site export ${format} binary signature mismatch`)
      }
      if (format === 'html') {
        // Site HTML export is served inline (viewable document), not as a forced download.
        // The magic-CDN branch is explicitly a hydration mode (A8); the non-magic branch is
        // a standalone HTML document served with Content-Type text/html. No attachment
        // disposition is expected here, unlike the binary formats.
        const text = buffer.toString('utf8')
        assert.ok(text.toLowerCase().indexOf('<!doctype html') !== -1 || text.toLowerCase().indexOf('<html') !== -1, `site export html is not an HTML document`)
      } else {
        // Binary formats (pdf, docx, epub) must be served as attachment downloads.
        const disposition = String(result.headers['content-disposition'] || '')
        assert.ok(
          disposition.indexOf('attachment') !== -1 && disposition.indexOf(`.${format}`) !== -1,
          `site export ${format} missing attachment disposition with .${format} extension`,
        )
      }
    })
  }
})

test('unsupported item export format returns 400', async () => {
  const result = await sendHttpRequest({
    method: 'GET',
    url: `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/${runtime.siteApiBasePath}/v1/items/${encodeURIComponent(runtime.firstItemLookup)}/export/txt`,
    headers: { accept: 'application/json' },
  })
  assert.equal(result.status, 400, `unsupported format expected 400, got ${result.status}`)
  const body = parseJsonSafely(result.bodyText)
  assert.ok(body && Array.isArray(body.supportedFormats), '400 response missing supportedFormats array')
})
