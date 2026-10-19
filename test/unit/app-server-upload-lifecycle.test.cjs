'use strict'

// In-process integration tests (SEC-UPLOAD) that boot the real server from
// src/app.js in MULTI-SITE mode against a temp runtime (same harness pattern
// as app-server-multisite.test.cjs) and verify:
//   - unauthenticated multipart uploads to a system action route and to the
//     site files route keep their exact status/envelope AND never leave a file
//     in <config>/tmp (auth is decided before multer writes to disk),
//   - an authenticated conversion leaves no temp file once it has responded,
//   - active content under a site files/ directory is forced to download even
//     when the extension is percent-encoded or upper-case.
//
// Server-boot discipline honored: ephemeral port only (PORT=0), temp runtime
// dirs via fs.mkdtempSync, credentials in the temp runtime only, server
// closed in test.after.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const SITE_NAME = 'uploadlifecycle'
const TEST_USER_NAME = 'upload-lifecycle-user'
const TEST_USER_PASSWORD = 'upload-lifecycle-pass'
const GIT_AUTHOR_NAME = 'HAXcms Upload Lifecycle Unit'
const GIT_AUTHOR_EMAIL = 'upload-lifecycle-unit@local.invalid'

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

const ENV_KEYS = [
  'PORT',
  'HAXCMS_ROOT',
  'HAXCMS_ENABLE_SSL',
  'NODE_ENV',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
]
const envSnapshots = {}
for (let i = 0; i < ENV_KEYS.length; i++) {
  envSnapshots[ENV_KEYS[i]] = captureEnv(ENV_KEYS[i])
}

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-app-upload-lifecycle-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')
const sitesRoot = path.join(runtimeRoot, '_sites')
const uploadTmpRoot = path.join(configRoot, 'tmp')

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
  const dirs = ['tmp', 'cache', 'user', 'user/files', 'user/skeletons', 'skeletons', 'settings', 'node_modules']
  for (let i = 0; i < dirs.length; i++) {
    fs.ensureDirSync(path.join(configRoot, dirs[i]))
  }
}

fs.ensureDirSync(sitesRoot)
seedRuntimeConfig()
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_PASSWORD }, null, 2),
)

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

const runtime = {
  baseUrl: '',
  jwt: '',
  userToken: '',
  siteToken: '',
}

// top-level entries of <config>/tmp other than the bulk-import staging dir
function listUploadTempFiles() {
  if (!fs.existsSync(uploadTmpRoot)) {
    return []
  }
  return fs.readdirSync(uploadTmpRoot).filter(function (name) {
    return name !== 'imports'
  })
}

async function waitForNoUploadTempFiles() {
  // cleanup runs on the server's res 'finish'/'close', which can land a tick
  // after the client has the full response; poll briefly.
  for (let i = 0; i < 50; i++) {
    if (listUploadTempFiles().length === 0) {
      return []
    }
    await new Promise(function (resolve) {
      setTimeout(resolve, 20)
    })
  }
  return listUploadTempFiles()
}

function buildUploadForm(fieldName, fileName, contents, type) {
  const form = new FormData()
  form.append(fieldName, new Blob([contents], { type: type }), fileName)
  return form
}

async function postMultipart(url, form, headers) {
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    headers: headers || {},
  })
  const bodyText = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    bodyText: bodyText,
  }
}

async function get(url) {
  const response = await fetch(url)
  await response.arrayBuffer()
  return response
}

function basicHeader(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64')
}

test.before(async () => {
  const port = await appModule.serverReady
  runtime.baseUrl = 'http://127.0.0.1:' + port
  await HAXCMS.createSite(SITE_NAME)
  const filesDir = path.join(sitesRoot, SITE_NAME, 'files')
  fs.writeFileSync(path.join(filesDir, 'x.html'), '<script>alert(1)</script>')
  fs.writeFileSync(path.join(filesDir, 'x.HTML'), '<script>alert(1)</script>')
  fs.writeFileSync(
    path.join(filesDir, 'x.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  )
  fs.writeFileSync(path.join(filesDir, 'x.xml'), '<a/>')
  fs.writeFileSync(path.join(filesDir, 'x.txt'), 'plain')
  fs.writeFileSync(path.join(filesDir, 'noext'), '<script>alert(1)</script>')
  const login = await fetch(runtime.baseUrl + '/system/api/v1/session/login', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER_NAME, password: TEST_USER_PASSWORD }),
  })
  const loginText = await login.text()
  assert.equal(login.status, 200, loginText)
  runtime.jwt = JSON.parse(loginText).jwt
  // derive the request tokens in-process (same derivation the
  // connection-settings route uses) so this test does not depend on that
  // route's token disclosure policy.
  runtime.userToken = HAXCMS.getRequestToken(TEST_USER_NAME)
  runtime.siteToken = HAXCMS.getRequestToken(TEST_USER_NAME + ':' + SITE_NAME)
  // start every test from an empty upload temp dir
  const leftovers = listUploadTempFiles()
  for (let i = 0; i < leftovers.length; i++) {
    fs.removeSync(path.join(uploadTmpRoot, leftovers[i]))
  }
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
  for (let i = 0; i < ENV_KEYS.length; i++) {
    restoreEnv(ENV_KEYS[i], envSnapshots[ENV_KEYS[i]])
  }
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS
  fs.removeSync(tempRoot)
})

// ---------------------------------------------------------------------------
// unauthenticated uploads: same envelope, nothing written to <config>/tmp
// ---------------------------------------------------------------------------
test('unauthenticated multipart POST to a system action keeps the 401 envelope and writes no temp file', async () => {
  const url = runtime.baseUrl + '/system/api/v1/actions/import-html'
  const result = await postMultipart(
    url,
    buildUploadForm('upload', 'evil.html', '<p>' + 'A'.repeat(64 * 1024) + '</p>', 'text/html'),
  )
  assert.equal(result.status, 401, result.bodyText)
  assert.deepEqual(JSON.parse(result.bodyText), {
    status: 401,
    data: { message: 'Authentication required', code: 'AUTH_REQUIRED' },
  })
  assert.deepEqual(listUploadTempFiles(), [])
})

test('invalid bearer multipart POST to a system action keeps the 403 envelope and writes no temp file', async () => {
  const url = runtime.baseUrl + '/system/api/v1/actions/docx-to-html'
  const result = await postMultipart(
    url,
    buildUploadForm('upload', 'doc.docx', 'not-a-docx', 'application/octet-stream'),
    { authorization: 'Bearer not-a-real-jwt' },
  )
  assert.equal(result.status, 403, result.bodyText)
  assert.deepEqual(JSON.parse(result.bodyText), {
    status: 403,
    data: { message: 'Invalid bearer token', code: 'AUTH_TOKEN_INVALID' },
  })
  assert.deepEqual(listUploadTempFiles(), [])
})

test('unauthenticated multipart POST to the site-scoped system import route writes no temp file', async () => {
  const url = runtime.baseUrl + '/_sites/' + SITE_NAME + '/system/api/v1/site/import/html'
  const result = await postMultipart(
    url,
    buildUploadForm('upload', 'evil.html', '<p>x</p>', 'text/html'),
  )
  assert.equal(result.status, 401, result.bodyText)
  assert.deepEqual(JSON.parse(result.bodyText), {
    status: 401,
    data: { message: 'Authentication required', code: 'AUTH_REQUIRED' },
  })
  assert.deepEqual(listUploadTempFiles(), [])
})

test('unauthenticated multipart POST to the site files route keeps the 401 envelope and writes no temp file', async () => {
  const url = runtime.baseUrl + '/_sites/' + SITE_NAME + '/x/api/v1/files'
  const result = await postMultipart(
    url,
    buildUploadForm('file-upload', 'evil.png', Buffer.alloc(64 * 1024, 1), 'image/png'),
  )
  assert.equal(result.status, 401, result.bodyText)
  assert.deepEqual(JSON.parse(result.bodyText), {
    status: 401,
    data: {
      message: 'Authorization bearer token or basic credentials are required for this endpoint',
      code: 'AUTH_REQUIRED',
    },
  })
  assert.deepEqual(listUploadTempFiles(), [])
})

test('site files multipart upload with bad basic credentials or missing site token writes no temp file', async () => {
  const url = runtime.baseUrl + '/_sites/' + SITE_NAME + '/x/api/v1/files'
  const badBasic = await postMultipart(
    url,
    buildUploadForm('file-upload', 'evil.png', Buffer.alloc(1024, 1), 'image/png'),
    { authorization: basicHeader(TEST_USER_NAME, 'wrong-pass') },
  )
  assert.equal(badBasic.status, 401, badBasic.bodyText)
  assert.deepEqual(JSON.parse(badBasic.bodyText), {
    status: 401,
    data: { message: 'Invalid basic authorization credentials', code: 'AUTH_INVALID_CREDENTIALS' },
  })
  assert.deepEqual(listUploadTempFiles(), [])
  const missingSiteToken = await postMultipart(
    url,
    buildUploadForm('file-upload', 'evil.png', Buffer.alloc(1024, 1), 'image/png'),
    { authorization: 'Bearer ' + runtime.jwt },
  )
  assert.equal(missingSiteToken.status, 403, missingSiteToken.bodyText)
  assert.deepEqual(JSON.parse(missingSiteToken.bodyText), {
    status: 403,
    data: { message: 'X-HAXCMS-Site-Token header is required for this endpoint', code: 'SITE_TOKEN_REQUIRED' },
  })
  assert.deepEqual(listUploadTempFiles(), [])
  // a wrong site token is denied too (the site name comes from the path so
  // the decision is final before the body is parsed)
  const badSiteToken = await postMultipart(
    url,
    buildUploadForm('file-upload', 'evil.png', Buffer.alloc(1024, 1), 'image/png'),
    { authorization: 'Bearer ' + runtime.jwt, 'X-HAXCMS-Site-Token': 'nope' },
  )
  assert.equal(badSiteToken.status, 403, badSiteToken.bodyText)
  assert.deepEqual(JSON.parse(badSiteToken.bodyText), {
    status: 403,
    data: { message: 'Invalid X-HAXCMS-Site-Token header', code: 'SITE_TOKEN_INVALID' },
  })
  assert.deepEqual(listUploadTempFiles(), [])
})

test('non-multipart unauthenticated requests to upload routes are unchanged', async () => {
  const response = await fetch(runtime.baseUrl + '/system/api/v1/actions/import-html', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const bodyText = await response.text()
  assert.equal(response.status, 401, bodyText)
  assert.deepEqual(JSON.parse(bodyText), {
    status: 401,
    data: { message: 'Authentication required', code: 'AUTH_REQUIRED' },
  })
})

// ---------------------------------------------------------------------------
// authenticated uploads: temp files removed after the response
// ---------------------------------------------------------------------------
test('an authenticated conversion request leaves no temp file after the response', async () => {
  const url = runtime.baseUrl + '/system/api/v1/actions/import-html'
  const result = await postMultipart(
    url,
    buildUploadForm(
      'upload',
      'page.html',
      '<html><body><h1>Title</h1><p>Hello</p></body></html>',
      'text/html',
    ),
    {
      authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-User-Token': runtime.userToken,
    },
  )
  assert.equal(result.status, 200, result.bodyText)
  assert.deepEqual(await waitForNoUploadTempFiles(), [])
})

test('an authenticated conversion that fails validation still leaves no temp file', async () => {
  const url = runtime.baseUrl + '/system/api/v1/actions/import-html'
  const result = await postMultipart(
    url,
    buildUploadForm('upload', 'not-html.txt', 'plain text', 'text/plain'),
    {
      authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-User-Token': runtime.userToken,
    },
  )
  assert.equal(result.status, 400, result.bodyText)
  assert.deepEqual(await waitForNoUploadTempFiles(), [])
})

test('an authenticated site file upload is saved into the site and leaves no temp file', async () => {
  const url = runtime.baseUrl + '/_sites/' + SITE_NAME + '/x/api/v1/files'
  const result = await postMultipart(
    url,
    buildUploadForm('file-upload', 'notes.txt', 'hello upload', 'text/plain'),
    {
      authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': runtime.siteToken,
    },
  )
  assert.ok(result.status === 200 || result.status === 201, result.bodyText)
  assert.equal(
    fs.readFileSync(path.join(sitesRoot, SITE_NAME, 'files', 'notes.txt'), 'utf8'),
    'hello upload',
  )
  assert.deepEqual(await waitForNoUploadTempFiles(), [])
})

// ---------------------------------------------------------------------------
// active content in files/ is forced to download (decoded path)
// ---------------------------------------------------------------------------
test('html/svg/xml in a site files directory force a download, including encoded and upper-case extensions', async () => {
  const base = runtime.baseUrl + '/_sites/' + SITE_NAME + '/files/'
  const cases = ['x%2ehtml', 'x.html', 'x.HTML', 'x.svg', 'x.xml', 'x%2esvg']
  for (let i = 0; i < cases.length; i++) {
    const response = await get(base + cases[i])
    assert.equal(response.status, 200, cases[i])
    assert.equal(response.headers.get('content-disposition'), 'attachment', cases[i])
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', cases[i])
  }
})

test('other site files are not forced to download and unknown types are not served as html', async () => {
  const base = runtime.baseUrl + '/_sites/' + SITE_NAME + '/files/'
  const txt = await get(base + 'x.txt')
  assert.equal(txt.status, 200)
  assert.equal(txt.headers.get('content-disposition'), null)
  const noext = await get(base + 'noext')
  assert.equal(noext.status, 200)
  assert.equal(noext.headers.get('content-disposition'), null)
  assert.equal(noext.headers.get('content-type'), 'application/octet-stream')
  assert.equal(noext.headers.get('x-content-type-options'), 'nosniff')
})
