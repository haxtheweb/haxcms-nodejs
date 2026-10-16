'use strict'

// Security (review 2026-10): upload temp-file lifecycle + files/ force-download
// guard, exercised against a real booted server (same harness pattern as
// actions-spec.conformance.test.cjs).
//  - anonymous multipart POSTs are rejected BEFORE multer writes anything
//  - temp files are removed once the response finishes (success or failure)
//  - a file the handler keeps (moved into files/) survives the cleanup
//  - /files/x%2ehtml (encoded dot) still gets Content-Disposition: attachment

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const axios = require('axios')
const JSZip = require('jszip')
const vm = require('node:vm')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const SITE_DIRECTORY_NAME = '_sites'
const TEST_USER_NAME = 'upload-lifecycle-user'
const TEST_USER_PASSWORD = 'upload-lifecycle-pass'
const SITE_NAME = 'upload-lifecycle-site'

const ENV_KEYS = [
  'PORT', 'HOME', 'HAXCMS_ROOT', 'HAXCMS_DISABLE_JWT_CHECKS',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]

let runtime = null

function seedRuntimeConfig(runtimeConfigRoot) {
  fs.ensureDirSync(runtimeConfigRoot)
  fs.writeFileSync(path.join(runtimeConfigRoot, '.isHAXcmsConfig'), '')
  const configSourceRoot = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')
  for (const fileName of ['config.json', 'my-custom-elements.js', 'userData.json', 'config.php', '.htaccess', '.user-files-htaccess']) {
    fs.copySync(path.join(configSourceRoot, fileName), path.join(runtimeConfigRoot, fileName))
  }
  for (const dir of ['tmp', 'cache', 'user', 'user/files', 'user/skeletons', 'skeletons', 'settings', 'node_modules']) {
    fs.ensureDirSync(path.join(runtimeConfigRoot, dir))
  }
}

async function send(config) {
  const response = await axios({
    method: config.method,
    url: config.url,
    headers: config.headers,
    data: config.data,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
    maxRedirects: 0,
  })
  return { status: response.status, headers: response.headers || {}, bodyText: String(response.data || '') }
}

function buildMultipartBody({ fieldName = 'file', fileName, mimeType, fileContents, extraFields = {} }) {
  const boundary = `----haxcms-upload-lifecycle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"`,
    `Content-Type: ${mimeType}`,
    '',
    Buffer.from(fileContents).toString('binary'),
  ]
  for (const key of Object.keys(extraFields)) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${key}"`, '', String(extraFields[key]))
  }
  parts.push(`--${boundary}--`, '')
  return { body: Buffer.from(parts.join('\r\n'), 'binary'), boundary }
}

async function createMinimalDocxBuffer() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Upload lifecycle</w:t></w:r></w:p></w:body>
</w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function parseAppSettings(scriptSource) {
  const sandbox = { window: {} }
  vm.runInNewContext(String(scriptSource || ''), sandbox, { timeout: 1000 })
  return sandbox.window.appSettings
}

async function connectionSettings(refererPath = '') {
  const headers = { accept: 'application/javascript' }
  if (refererPath) {
    headers.referer = `${runtime.baseUrl}${refererPath}`
  }
  const res = await send({ method: 'GET', url: `${runtime.baseUrl}/system/api/v1/session/connection-settings`, headers })
  assert.equal(res.status, 200, res.bodyText)
  return parseAppSettings(res.bodyText)
}

// every file (recursively) under the config tmp dir: multer temp files used
// to land directly in tmp/, now in tmp/uploads/; checking the whole tree
// proves nothing was written anywhere.
function listTmpFiles() {
  const root = path.join(runtime.runtimeConfigRoot, 'tmp')
  const found = []
  const walk = (dir) => {
    if (!fs.pathExistsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stats = fs.lstatSync(full)
      if (stats.isDirectory()) walk(full)
      else found.push(full)
    }
  }
  walk(root)
  return found.sort()
}

// the finish/close cleanup runs as the response is flushed, which can race
// the client reading it; poll briefly.
async function waitForTmpFiles(expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let current = listTmpFiles()
  while (Date.now() < deadline) {
    current = listTmpFiles()
    if (JSON.stringify(current) === JSON.stringify(expected)) return current
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return current
}

function userHeaders(extra = {}) {
  const headers = { accept: 'application/json', Authorization: `Bearer ${runtime.jwt}`, ...extra }
  if (runtime.dashboardSettings.userToken) {
    headers[runtime.dashboardSettings.userTokenHeader || 'X-HAXCMS-User-Token'] = runtime.dashboardSettings.userToken
  }
  return headers
}

test.before(async () => {
  runtime = { originalCwd: process.cwd(), env: {} }
  for (const key of ENV_KEYS) {
    runtime.env[key] = { exists: Object.prototype.hasOwnProperty.call(process.env, key), value: process.env[key] }
  }
  runtime.tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-upload-lifecycle-'))
  runtime.runtimeRoot = path.join(runtime.tempDirectory, 'runtime')
  runtime.runtimeConfigRoot = path.join(runtime.runtimeRoot, '_config')
  fs.ensureDirSync(path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME))
  fs.ensureDirSync(path.join(runtime.tempDirectory, 'home'))
  seedRuntimeConfig(runtime.runtimeConfigRoot)
  process.chdir(runtime.runtimeRoot)
  process.env.HOME = path.join(runtime.tempDirectory, 'home')
  // trailing separator: HAXCMS joins sitesDirectory onto HAXCMS_ROOT by string
  // concatenation, so without it sites land in "<root>_sites"
  process.env.HAXCMS_ROOT = runtime.runtimeRoot + path.sep
  process.env.PORT = '0'
  process.env.GIT_AUTHOR_NAME = 'Upload Lifecycle'
  process.env.GIT_AUTHOR_EMAIL = 'upload-lifecycle@local.invalid'
  process.env.GIT_COMMITTER_NAME = 'Upload Lifecycle'
  process.env.GIT_COMMITTER_EMAIL = 'upload-lifecycle@local.invalid'
  delete process.env.HAXCMS_DISABLE_JWT_CHECKS
  globalThis.HAXCMS_RUNTIME_CREDENTIALS = { username: TEST_USER_NAME, password: TEST_USER_PASSWORD }
  globalThis.HAXCMS_RUNTIME_USERNAME = TEST_USER_NAME
  globalThis.HAXCMS_RUNTIME_PASSWORD = TEST_USER_PASSWORD

  delete require.cache[require.resolve(APP_ENTRY_PATH)]
  runtime.appModule = require(APP_ENTRY_PATH)
  runtime.port = await runtime.appModule.serverReady
  runtime.baseUrl = `http://127.0.0.1:${runtime.port}`

  const login = await send({
    method: 'POST',
    url: `${runtime.baseUrl}/system/api/v1/session/login`,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    data: JSON.stringify({ username: TEST_USER_NAME, password: TEST_USER_PASSWORD }),
  })
  assert.equal(login.status, 200, login.bodyText)
  runtime.jwt = JSON.parse(login.bodyText).jwt
  runtime.dashboardSettings = await connectionSettings()

  const createSite = await send({
    method: 'POST',
    url: `${runtime.baseUrl}${runtime.dashboardSettings.createSite || '/system/api/v1/sites'}`,
    headers: userHeaders({ 'content-type': 'application/json' }),
    data: JSON.stringify({
      jwt: runtime.jwt,
      token: runtime.dashboardSettings.token,
      site: { name: SITE_NAME, description: 'upload lifecycle harness site' },
    }),
  })
  assert.equal(createSite.status, 200, createSite.bodyText)
  runtime.siteSettings = await connectionSettings(`/${SITE_DIRECTORY_NAME}/${SITE_NAME}/`)
  runtime.siteDirectory = path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME, SITE_NAME)
})

test.after(async () => {
  if (runtime && runtime.appModule && runtime.appModule.server) {
    await new Promise((resolve) => runtime.appModule.server.close(() => resolve()))
  }
  process.chdir(runtime.originalCwd)
  for (const key of ['HAXCMS_RUNTIME_CREDENTIALS', 'HAXCMS_RUNTIME_USERNAME', 'HAXCMS_RUNTIME_PASSWORD']) {
    delete globalThis[key]
  }
  for (const key of ENV_KEYS) {
    if (runtime.env[key].exists) process.env[key] = runtime.env[key].value
    else delete process.env[key]
  }
  fs.removeSync(runtime.tempDirectory)
})

test('anonymous multipart POST to a system action is rejected before multer writes it', async () => {
  const before = listTmpFiles()
  const { body, boundary } = buildMultipartBody({
    fileName: 'payload.html',
    mimeType: 'text/html',
    fileContents: Buffer.alloc(256 * 1024, 'a'),
  })
  for (const route of ['actions/html-to-pdf', 'actions/docx-to-html', 'actions/import-docx', 'site/import/html']) {
    for (const prefix of ['', `/${SITE_DIRECTORY_NAME}/${SITE_NAME}`]) {
      const res = await send({
        method: 'POST',
        url: `${runtime.baseUrl}${prefix}/system/api/v1/${route}`,
        headers: { accept: 'application/json', 'content-type': `multipart/form-data; boundary=${boundary}` },
        data: body,
      })
      assert.equal(res.status, 401, `${prefix}/${route}: ${res.bodyText}`)
      assert.deepEqual(JSON.parse(res.bodyText), { status: 401, data: { message: 'Authentication required' } })
    }
  }
  // invalid bearer keeps the refreshable 403 envelope, and still writes nothing
  const badBearer = await send({
    method: 'POST',
    url: `${runtime.baseUrl}/system/api/v1/actions/html-to-pdf`,
    headers: { accept: 'application/json', 'content-type': `multipart/form-data; boundary=${boundary}`, Authorization: 'Bearer not-a-jwt' },
    data: body,
  })
  assert.equal(badBearer.status, 403)
  assert.deepEqual(JSON.parse(badBearer.bodyText), { status: 403, data: { message: 'Invalid bearer token' } })
  assert.deepEqual(await waitForTmpFiles(before, 300), before)
})

test('anonymous multipart POST to the site files route is rejected before multer writes it', async () => {
  const before = listTmpFiles()
  const { body, boundary } = buildMultipartBody({
    fileName: 'payload.png',
    mimeType: 'image/png',
    fileContents: Buffer.alloc(256 * 1024, 'b'),
  })
  for (const prefix of ['', `/${SITE_DIRECTORY_NAME}/${SITE_NAME}`]) {
    const res = await send({
      method: 'POST',
      url: `${runtime.baseUrl}${prefix}/x/api/v1/files`,
      headers: { accept: 'application/json', 'content-type': `multipart/form-data; boundary=${boundary}` },
      data: body,
    })
    assert.equal(res.status, 401, `${prefix}/x/api/v1/files: ${res.bodyText}`)
    assert.deepEqual(JSON.parse(res.bodyText), {
      status: 401,
      data: { message: 'Authorization bearer token or basic credentials are required for this endpoint' },
    })
  }
  assert.deepEqual(await waitForTmpFiles(before, 300), before)
})

test('authenticated conversion leaves no temp file behind after the response', async () => {
  const before = listTmpFiles()
  const { body, boundary } = buildMultipartBody({
    fileName: 'doc.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileContents: await createMinimalDocxBuffer(),
  })
  const res = await send({
    method: 'POST',
    url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-html`,
    headers: userHeaders({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
    data: body,
  })
  assert.equal(res.status, 200, res.bodyText)
  assert.match(res.bodyText, /Upload lifecycle/)
  assert.deepEqual(await waitForTmpFiles(before), before)
})

test('authenticated-but-rejected site upload (no site token) is cleaned up after the response', async () => {
  const before = listTmpFiles()
  const { body, boundary } = buildMultipartBody({
    fileName: 'payload.png',
    mimeType: 'image/png',
    fileContents: Buffer.alloc(64 * 1024, 'c'),
  })
  const res = await send({
    method: 'POST',
    url: `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${SITE_NAME}/x/api/v1/files`,
    headers: userHeaders({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
    data: body,
  })
  assert.equal(res.status, 403, res.bodyText)
  assert.deepEqual(await waitForTmpFiles(before), before)
})

test('a successful site upload keeps the moved file and leaves no temp file', async () => {
  const before = listTmpFiles()
  const { body, boundary } = buildMultipartBody({
    fileName: 'kept-upload.txt',
    mimeType: 'text/plain',
    fileContents: Buffer.from('kept upload contents\n'),
  })
  const res = await send({
    method: 'POST',
    url: `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${SITE_NAME}/x/api/v1/files`,
    headers: userHeaders({
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'X-HAXCMS-Site-Token': runtime.siteSettings.siteToken,
    }),
    data: body,
  })
  assert.equal(res.status, 200, res.bodyText)
  assert.deepEqual(await waitForTmpFiles(before), before)
  const kept = fs.readdirSync(path.join(runtime.siteDirectory, 'files')).filter((name) => /kept-upload/.test(name))
  assert.equal(kept.length, 1, 'the handler-kept upload must survive the temp cleanup')
  assert.equal(fs.readFileSync(path.join(runtime.siteDirectory, 'files', kept[0]), 'utf8'), 'kept upload contents\n')
})

test('markup in files/ is forced to download even when the path is percent-encoded', async () => {
  const filesDir = path.join(runtime.siteDirectory, 'files')
  fs.ensureDirSync(filesDir)
  fs.writeFileSync(path.join(filesDir, 'evil.html'), '<script>alert(1)</script>')
  fs.writeFileSync(path.join(filesDir, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  fs.writeFileSync(path.join(filesDir, 'plain.txt'), 'hello')
  const base = `${runtime.baseUrl}/${SITE_DIRECTORY_NAME}/${SITE_NAME}/files/`
  for (const name of ['evil.html', 'evil%2ehtml', 'evil%2Ehtml', '%65vil.html', 'evil.svg', 'evil%2esvg']) {
    const res = await send({ method: 'GET', url: `${base}${name}`, headers: {} })
    assert.equal(res.status, 200, `${name} should be served`)
    assert.equal(res.headers['content-disposition'], 'attachment', `${name} must be forced to download`)
    assert.equal(res.headers['x-content-type-options'], 'nosniff', `${name} must carry nosniff`)
  }
  const plain = await send({ method: 'GET', url: `${base}plain.txt`, headers: {} })
  assert.equal(plain.status, 200)
  assert.equal(plain.headers['content-disposition'], undefined, 'non-markup files stay inline')
  assert.equal(plain.headers['x-content-type-options'], 'nosniff')
})
