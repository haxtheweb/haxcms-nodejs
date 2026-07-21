'use strict'

// Shared E2E runtime harness for haxcms-nodejs.
// Boots an isolated temp runtime (config seeded from boilerplate), starts the
// server on an ephemeral port with JWT auth ENABLED, seeds runtime credentials,
// and returns a handle the test files can drive. Teardown closes the server
// and removes the temp directory.
//
// Adapted from test/api-conformance/site-spec.conformance.test.cjs
// (setupRuntime / teardownRuntime) — kept intentionally simple (KISS).

const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const axios = require('axios')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const SITE_DIRECTORY_NAME = '_sites'
const E2E_USER_NAME = process.env.HAXCMS_E2E_USERNAME || 'e2e-harness-user'
const E2E_USER_PASSWORD = process.env.HAXCMS_E2E_PASSWORD || 'e2e-harness-pass'
const E2E_GIT_AUTHOR_NAME = 'E2E Harness'
const E2E_GIT_AUTHOR_EMAIL = 'e2e-harness@local.invalid'

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

function captureGlobalValue(key) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: globalThis[key],
  }
}

function restoreGlobalValue(key, snapshot) {
  if (!snapshot || snapshot.exists !== true) {
    delete globalThis[key]
    return
  }
  globalThis[key] = snapshot.value
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
    const fileName = configSeedFiles[i]
    fs.copySync(
      path.join(configSourceRoot, fileName),
      path.join(runtimeConfigRoot, fileName),
    )
  }
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'tmp'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'cache'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'settings'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'node_modules'))
}

async function loginForJwt(baseUrl, username, password) {
  const response = await axios({
    method: 'POST',
    url: `${baseUrl}/system/api/v1/session/login`,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    data: { username, password },
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
  if (response.status !== 200) {
    throw new Error(
      `E2E login failed: status ${response.status}, body: ${response.data}`,
    )
  }
  let body = null
  try {
    body = JSON.parse(String(response.data || ''))
  } catch (e) {
    throw new Error(`E2E login returned non-JSON body: ${response.data}`)
  }
  if (!body || typeof body.jwt !== 'string' || body.jwt === '') {
    throw new Error(`E2E login response missing jwt: ${response.data}`)
  }
  return body.jwt
}

// Boot an isolated E2E runtime. Auth is ENABLED (HAXCMS_DISABLE_JWT_CHECKS is
// explicitly deleted) so the dashboard login flow is exercised for real.
async function setupE2ERuntime() {
  const runtime = {
    originalCwd: process.cwd(),
    envSnapshots: {
      PORT: captureEnvValue('PORT'),
      HOME: captureEnvValue('HOME'),
      HAXCMS_ROOT: captureEnvValue('HAXCMS_ROOT'),
      HAXCMS_DISABLE_JWT_CHECKS: captureEnvValue('HAXCMS_DISABLE_JWT_CHECKS'),
      HAXCMS_ALLOW_DEFAULT_CREDS: captureEnvValue('HAXCMS_ALLOW_DEFAULT_CREDS'),
      GIT_AUTHOR_NAME: captureEnvValue('GIT_AUTHOR_NAME'),
      GIT_AUTHOR_EMAIL: captureEnvValue('GIT_AUTHOR_EMAIL'),
      GIT_COMMITTER_NAME: captureEnvValue('GIT_COMMITTER_NAME'),
      GIT_COMMITTER_EMAIL: captureEnvValue('GIT_COMMITTER_EMAIL'),
    },
    globalSnapshots: {
      HAXCMS_RUNTIME_CREDENTIALS: captureGlobalValue('HAXCMS_RUNTIME_CREDENTIALS'),
      HAXCMS_RUNTIME_USERNAME: captureGlobalValue('HAXCMS_RUNTIME_USERNAME'),
      HAXCMS_RUNTIME_PASSWORD: captureGlobalValue('HAXCMS_RUNTIME_PASSWORD'),
    },
  }

  runtime.testStartTimestamp = Date.now()
  runtime.tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'haxcms-nodejs-e2e-'),
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
  // HAXCMS_ROOT MUST have a trailing slash: HAXCMS.js mixes string concat
  // (HAXCMS_ROOT + sitesDirectory, e.g. in createSite) and path.join (e.g. in
  // listSites). Without the trailing slash, string concat produces
  // 'runtime_sites' instead of 'runtime/_sites', so created sites are written
  // to a different path than listSites reads from. The HAXCMS.js fallback
  // (path.join(process.cwd(), '/')) includes the trailing slash for the same
  // reason.
  process.env.HAXCMS_ROOT = runtime.runtimeRoot + '/'
  process.env.PORT = '0'
  process.env.GIT_AUTHOR_NAME = E2E_GIT_AUTHOR_NAME
  process.env.GIT_AUTHOR_EMAIL = E2E_GIT_AUTHOR_EMAIL
  process.env.GIT_COMMITTER_NAME = E2E_GIT_AUTHOR_NAME
  process.env.GIT_COMMITTER_EMAIL = E2E_GIT_AUTHOR_EMAIL
  // CRITICAL: do NOT set HAXCMS_DISABLE_JWT_CHECKS — we want real auth.
  delete process.env.HAXCMS_DISABLE_JWT_CHECKS

  runtime.credentials = {
    username: E2E_USER_NAME,
    password: E2E_USER_PASSWORD,
  }
  globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
    username: E2E_USER_NAME,
    password: E2E_USER_PASSWORD,
  }
  globalThis.HAXCMS_RUNTIME_USERNAME = E2E_USER_NAME
  globalThis.HAXCMS_RUNTIME_PASSWORD = E2E_USER_PASSWORD

  delete require.cache[require.resolve(APP_ENTRY_PATH)]
  runtime.appModule = require(APP_ENTRY_PATH)
  runtime.port = await runtime.appModule.serverReady
  runtime.baseUrl = `http://127.0.0.1:${runtime.port}`

  // Smoke-login to confirm auth path works and hand tests a ready JWT.
  runtime.jwt = await loginForJwt(
    runtime.baseUrl,
    E2E_USER_NAME,
    E2E_USER_PASSWORD,
  )

  return runtime
}

async function teardownE2ERuntime(runtime) {
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
  restoreGlobalValue(
    'HAXCMS_RUNTIME_CREDENTIALS',
    runtime.globalSnapshots.HAXCMS_RUNTIME_CREDENTIALS,
  )
  restoreGlobalValue(
    'HAXCMS_RUNTIME_USERNAME',
    runtime.globalSnapshots.HAXCMS_RUNTIME_USERNAME,
  )
  restoreGlobalValue(
    'HAXCMS_RUNTIME_PASSWORD',
    runtime.globalSnapshots.HAXCMS_RUNTIME_PASSWORD,
  )
  restoreEnvValue('PORT', runtime.envSnapshots.PORT)
  restoreEnvValue('HOME', runtime.envSnapshots.HOME)
  restoreEnvValue('HAXCMS_ROOT', runtime.envSnapshots.HAXCMS_ROOT)
  restoreEnvValue(
    'HAXCMS_DISABLE_JWT_CHECKS',
    runtime.envSnapshots.HAXCMS_DISABLE_JWT_CHECKS,
  )
  restoreEnvValue(
    'HAXCMS_ALLOW_DEFAULT_CREDS',
    runtime.envSnapshots.HAXCMS_ALLOW_DEFAULT_CREDS,
  )
  restoreEnvValue('GIT_AUTHOR_NAME', runtime.envSnapshots.GIT_AUTHOR_NAME)
  restoreEnvValue('GIT_AUTHOR_EMAIL', runtime.envSnapshots.GIT_AUTHOR_EMAIL)
  restoreEnvValue('GIT_COMMITTER_NAME', runtime.envSnapshots.GIT_COMMITTER_NAME)
  restoreEnvValue('GIT_COMMITTER_EMAIL', runtime.envSnapshots.GIT_COMMITTER_EMAIL)
  if (runtime.tempDirectory && fs.pathExistsSync(runtime.tempDirectory)) {
    fs.removeSync(runtime.tempDirectory)
  }
}

module.exports = {
  setupE2ERuntime,
  teardownE2ERuntime,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
}
