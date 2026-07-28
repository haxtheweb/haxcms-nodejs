'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const axios = require('axios')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const SITE_DIRECTORY_NAME = '_sites'

const TEST_USER_NAME = process.env.HAXCMS_TEST_USERNAME || 'api-conformance-user'
const TEST_USER_PASSWORD = process.env.HAXCMS_TEST_PASSWORD || 'api-conformance-pass'
const TEST_GIT_AUTHOR_NAME = 'API Conformance Harness'
const TEST_GIT_AUTHOR_EMAIL = 'api-conformance@local.invalid'

function captureEnvValue(key) {
  return {
    exists: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }
}

function restoreEnvValue(key, snapshot) {
  if (!snapshot || snapshot.exists !== true) {
    delete process.env[key]
    return
  }
  process.env[key] = snapshot.value
}

function seedRuntimeConfig(runtimeConfigRoot) {
  fs.ensureDirSync(runtimeConfigRoot)
  fs.writeFileSync(path.join(runtimeConfigRoot, '.isHAXcmsConfig'), '')
  const configSourceRoot = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')
  const configSeedFiles = [
    'config.json',
    'my-custom-elements.js',
    'userData.json',
    'config.php',
    '.htaccess',
    '.user-files-htaccess',
  ]
  for (let i = 0; i < configSeedFiles.length; i++) {
    fs.copySync(
      path.join(configSourceRoot, configSeedFiles[i]),
      path.join(runtimeConfigRoot, configSeedFiles[i]),
    )
  }
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'tmp'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'cache'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'settings'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'node_modules'))
}

async function sendHttpRequest(requestConfig) {
  const response = await axios({
    method: requestConfig.method,
    url: requestConfig.url,
    headers: requestConfig.headers,
    data: requestConfig.data,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
  let bodyText = ''
  if (typeof response.data === 'string') {
    bodyText = response.data
  } else if (typeof response.data === 'undefined' || response.data === null) {
    bodyText = ''
  } else {
    bodyText = JSON.stringify(response.data)
  }
  return {
    status: response.status,
    headers: response.headers || {},
    bodyText,
  }
}

async function loginForJwt(baseUrl) {
  const loginResponse = await sendHttpRequest({
    method: 'POST',
    url: `${baseUrl}/system/api/v1/session/login`,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    data: JSON.stringify({
      username: TEST_USER_NAME,
      password: TEST_USER_PASSWORD,
    }),
  })
  assert.equal(
    loginResponse.status,
    200,
    `Expected login success but received ${loginResponse.status}: ${loginResponse.bodyText}`,
  )
  const loginBody = JSON.parse(loginResponse.bodyText)
  assert.ok(
    loginBody && typeof loginBody.jwt === 'string' && loginBody.jwt !== '',
    'Login response did not include jwt',
  )
  return loginBody.jwt
}

async function setupRuntime() {
  const runtime = {
    originalCwd: process.cwd(),
    envSnapshots: {
      PORT: captureEnvValue('PORT'),
      HOME: captureEnvValue('HOME'),
      HAXCMS_ROOT: captureEnvValue('HAXCMS_ROOT'),
      HAXCMS_DISABLE_JWT_CHECKS: captureEnvValue('HAXCMS_DISABLE_JWT_CHECKS'),
      GIT_AUTHOR_NAME: captureEnvValue('GIT_AUTHOR_NAME'),
      GIT_AUTHOR_EMAIL: captureEnvValue('GIT_AUTHOR_EMAIL'),
      GIT_COMMITTER_NAME: captureEnvValue('GIT_COMMITTER_NAME'),
      GIT_COMMITTER_EMAIL: captureEnvValue('GIT_COMMITTER_EMAIL'),
    },
  }
  runtime.testStartTimestamp = Date.now()
  runtime.tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'haxcms-ssrf-conformance-'),
  )
  runtime.runtimeRoot = path.join(runtime.tempDirectory, 'runtime')
  runtime.homeDirectory = path.join(runtime.tempDirectory, 'home')
  runtime.runtimeConfigRoot = path.join(runtime.runtimeRoot, '_config')

  fs.ensureDirSync(runtime.runtimeRoot)
  fs.ensureDirSync(runtime.homeDirectory)
  fs.ensureDirSync(path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME))
  seedRuntimeConfig(runtime.runtimeConfigRoot)

  process.chdir(runtime.runtimeRoot)
  process.env.HOME = runtime.homeDirectory
  // Trailing slash is required: HAXCMS concatenates HAXCMS_ROOT + sitesDirectory
  // (string concat, not path.join) when resolving the sites directory, so
  // '<root>' + '_sites' would otherwise produce a sibling '<root>_sites' dir.
  process.env.HAXCMS_ROOT = runtime.runtimeRoot + '/'
  process.env.PORT = '0'
  process.env.GIT_AUTHOR_NAME = TEST_GIT_AUTHOR_NAME
  process.env.GIT_AUTHOR_EMAIL = TEST_GIT_AUTHOR_EMAIL
  process.env.GIT_COMMITTER_NAME = TEST_GIT_AUTHOR_NAME
  process.env.GIT_COMMITTER_EMAIL = TEST_GIT_AUTHOR_EMAIL
  delete process.env.HAXCMS_DISABLE_JWT_CHECKS

  globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
    username: TEST_USER_NAME,
    password: TEST_USER_PASSWORD,
  }
  globalThis.HAXCMS_RUNTIME_USERNAME = TEST_USER_NAME
  globalThis.HAXCMS_RUNTIME_PASSWORD = TEST_USER_PASSWORD

  delete require.cache[require.resolve(APP_ENTRY_PATH)]
  runtime.appModule = require(APP_ENTRY_PATH)
  runtime.port = await runtime.appModule.serverReady
  runtime.baseUrl = `http://127.0.0.1:${runtime.port}`
  runtime.jwt = await loginForJwt(runtime.baseUrl)

  return runtime
}

async function teardownRuntime(runtime) {
  if (!runtime) {
    return
  }
  if (
    runtime.appModule &&
    runtime.appModule.server &&
    typeof runtime.appModule.server.close === 'function'
  ) {
    await new Promise((resolve) => {
      runtime.appModule.server.close(() => {
        resolve()
      })
    })
  }
  if (runtime.originalCwd) {
    process.chdir(runtime.originalCwd)
  }
  const globalKeys = [
    'HAXCMS_RUNTIME_CREDENTIALS',
    'HAXCMS_RUNTIME_USERNAME',
    'HAXCMS_RUNTIME_PASSWORD',
  ]
  for (const key of globalKeys) {
    if (Object.prototype.hasOwnProperty.call(globalThis, key)) {
      delete globalThis[key]
    }
  }
  restoreEnvValue('PORT', runtime.envSnapshots.PORT)
  restoreEnvValue('HOME', runtime.envSnapshots.HOME)
  restoreEnvValue('HAXCMS_ROOT', runtime.envSnapshots.HAXCMS_ROOT)
  restoreEnvValue('HAXCMS_DISABLE_JWT_CHECKS', runtime.envSnapshots.HAXCMS_DISABLE_JWT_CHECKS)
  restoreEnvValue('GIT_AUTHOR_NAME', runtime.envSnapshots.GIT_AUTHOR_NAME)
  restoreEnvValue('GIT_AUTHOR_EMAIL', runtime.envSnapshots.GIT_AUTHOR_EMAIL)
  restoreEnvValue('GIT_COMMITTER_NAME', runtime.envSnapshots.GIT_COMMITTER_NAME)
  restoreEnvValue('GIT_COMMITTER_EMAIL', runtime.envSnapshots.GIT_COMMITTER_EMAIL)
  if (runtime.tempDirectory && fs.pathExistsSync(runtime.tempDirectory)) {
    fs.removeSync(runtime.tempDirectory)
  }
}

function authHeaders(jwt, extraHeaders = {}) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    Authorization: `Bearer ${jwt}`,
    ...extraHeaders,
  }
}

// Create a plain site (no siteFiles) and return the machine name actually used
// on disk, so tests can resolve the site directory / a loopback URL that serves
// a real site.json for the haxcms-import strong discriminator.
async function createPlainSite(runtime, rawName) {
  const result = await sendHttpRequest({
    method: 'POST',
    url: `${runtime.baseUrl}/system/api/v1/sites`,
    headers: authHeaders(runtime.jwt),
    data: JSON.stringify({
      site: { name: rawName, description: 'SSRF conformance fixture site' },
      build: { structure: 'website' },
    }),
  })
  assert.equal(
    result.status,
    200,
    `createPlainSite failed: ${result.status}: ${result.bodyText}`,
  )
  const body = JSON.parse(result.bodyText)
  const siteName =
    body &&
    body.data &&
    body.data.metadata &&
    body.data.metadata.site &&
    body.data.metadata.site.name
      ? body.data.metadata.site.name
      : rawName
  return siteName
}

let runtime = null

test.before(async () => {
  runtime = await setupRuntime()
})

test.after(async () => {
  await teardownRuntime(runtime)
})

test('createSite siteFiles SSRF + extension guards', async (t) => {
  // The runtime's own origin is a loopback address that DOES serve content
  // (the dashboard index, text/html). Pointing a siteFiles download at it
  // isolates the SSRF IP guard: without the guard the .html target would pass
  // the content-type check and the dashboard HTML would be written to disk;
  // with the guard safeFetch rejects 127.0.0.1 before any fetch, so no file.
  await t.test('loopback download URL is blocked (file not written)', async () => {
    const siteName = `ssrf-loop-${runtime.testStartTimestamp}`
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/sites`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        site: { name: siteName },
        build: {
          structure: 'website',
          siteFiles: {
            'theme/loop.html': `${runtime.baseUrl}/`,
          },
        },
      }),
    })
    assert.equal(result.status, 200, `createSite failed: ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    const createdName =
      body &&
      body.data &&
      body.data.metadata &&
      body.data.metadata.site &&
      body.data.metadata.site.name
        ? body.data.metadata.site.name
        : siteName
    const siteDir = path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME, createdName)
    const targetFile = path.join(siteDir, 'theme', 'loop.html')
    assert.ok(
      fs.pathExistsSync(siteDir),
      'expected the created site directory to exist',
    )
    assert.equal(
      fs.pathExistsSync(targetFile),
      false,
      'loopback siteFiles download must NOT be written to the site directory (SSRF guard)',
    )
  })

  await t.test('cloud metadata IP download URL is blocked (file not written)', async () => {
    const siteName = `ssrf-meta-${runtime.testStartTimestamp}`
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/sites`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        site: { name: siteName },
        build: {
          structure: 'website',
          siteFiles: {
            'custom/meta.txt': 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
          },
        },
      }),
    })
    assert.equal(result.status, 200, `createSite failed: ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    const createdName =
      body &&
      body.data &&
      body.data.metadata &&
      body.data.metadata.site &&
      body.data.metadata.site.name
        ? body.data.metadata.site.name
        : siteName
    const siteDir = path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME, createdName)
    const targetFile = path.join(siteDir, 'custom', 'meta.txt')
    assert.equal(
      fs.pathExistsSync(targetFile),
      false,
      'metadata-IP siteFiles download must NOT be written (SSRF guard rejects 169.254.* before fetch)',
    )
  })

  await t.test('disallowed extension is blocked before any fetch (CWE-434)', async () => {
    const siteName = `ssrf-ext-${runtime.testStartTimestamp}`
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/sites`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        site: { name: siteName },
        build: {
          structure: 'website',
          siteFiles: {
            'custom/x.php': `${runtime.baseUrl}/`,
          },
        },
      }),
    })
    assert.equal(result.status, 200, `createSite failed: ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    const createdName =
      body &&
      body.data &&
      body.data.metadata &&
      body.data.metadata.site &&
      body.data.metadata.site.name
        ? body.data.metadata.site.name
        : siteName
    const siteDir = path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME, createdName)
    assert.equal(
      fs.pathExistsSync(path.join(siteDir, 'custom', 'x.php')),
      false,
      'a .php siteFiles target must be rejected by the extension allow-list (CWE-434)',
    )
  })
})

test('site/import converters reject private/loopback repoUrl', async (t) => {
  await t.test('import/html returns 400 for loopback repoUrl', async () => {
    // Without the SSRF guard, fetch(runtime.baseUrl) returns 200 (dashboard)
    // and the converter would respond 200 with imported items. With the guard,
    // safeFetch rejects 127.0.0.1 and the converter returns 400.
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/site/import/html`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({ repoUrl: `${runtime.baseUrl}/` }),
    })
    assert.equal(
      result.status,
      400,
      `expected 400 for loopback repoUrl, got ${result.status}: ${result.bodyText}`,
    )
  })

  await t.test('import/haxcms returns 400 for loopback repoUrl', async () => {
    const fixtureName = await createPlainSite(runtime, `ssrf-hax-${runtime.testStartTimestamp}`)
    // Pointing at a real, served site.json on loopback: without the guard the
    // converter would fetch /site.json (200) and respond 200 with items; with
    // the guard safeFetch rejects 127.0.0.1 and the converter returns 400.
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/site/import/haxcms`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        repoUrl: `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${fixtureName}`,
      }),
    })
    assert.equal(
      result.status,
      400,
      `expected 400 for loopback repoUrl, got ${result.status}: ${result.bodyText}`,
    )
  })
})

test('convert action link-fetch routes reject loopback URLs', async (t) => {
  await t.test('html-to-md with type=link to loopback returns empty contents', async () => {
    // Without the guard, fetching the dashboard (200, text/html) and turndown'ing
    // it yields non-empty markdown. With the guard, safeFetch throws and the
    // route sets html='' so contents is empty.
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/html-to-md`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({ html: `${runtime.baseUrl}/`, type: 'link' }),
    })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data, 'expected a response envelope with data')
    assert.equal(
      body.data.contents,
      '',
      'loopback link-fetch must be blocked so no remote content is returned',
    )
  })
})
