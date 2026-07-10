'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const axios = require('axios')
const JSZip = require('jszip')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const SYSTEM_SPEC_PATH = path.join(REPO_ROOT, 'src', 'openapi', 'system-spec.yaml')
const SITE_DIRECTORY_NAME = '_sites'

const TEST_USER_NAME = process.env.HAXCMS_TEST_USERNAME || 'api-conformance-user'
const TEST_USER_PASSWORD =
  process.env.HAXCMS_TEST_PASSWORD || 'api-conformance-pass'
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
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Hello from test</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>This is a test paragraph.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function createMinimalXlsxBuffer() {
  const ExcelJS = require('exceljs')
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Sheet1')
  worksheet.addRow(['Name', 'Value'])
  worksheet.addRow(['Alice', '100'])
  worksheet.addRow(['Bob', '200'])
  return workbook.xlsx.writeBuffer()
}

function createMinimalPdfBuffer() {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n')
}

async function createMinimalPptxBuffer() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`)
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`)
  zip.folder('ppt').file('presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst/>
</p:presentation>`)
  return zip.generateAsync({ type: 'nodebuffer' })
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

function buildMultipartBody(options = {}) {
  const boundary = `----haxcms-actions-test-${Date.now()}-${Math.floor(Math.random() * 1000000)}`
  const fieldName =
    typeof options.fieldName === 'string' && options.fieldName.trim() !== ''
      ? options.fieldName
      : 'file'
  const fileName =
    typeof options.fileName === 'string' && options.fileName.trim() !== ''
      ? options.fileName
      : 'test.docx'
  const mimeType =
    typeof options.mimeType === 'string' && options.mimeType.trim() !== ''
      ? options.mimeType
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const fileContents = Buffer.isBuffer(options.fileContents)
    ? options.fileContents
    : Buffer.from(String(options.fileContents || ''), 'utf8')
  const extraFields =
    options.extraFields && typeof options.extraFields === 'object'
      ? options.extraFields
      : {}
  const parts = []
  parts.push(`--${boundary}`)
  parts.push(
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"`,
  )
  parts.push(`Content-Type: ${mimeType}`)
  parts.push('')
  parts.push(fileContents.toString('binary'))
  const fieldNames = Object.keys(extraFields)
  for (let i = 0; i < fieldNames.length; i++) {
    const fieldKey = fieldNames[i]
    parts.push(`--${boundary}`)
    parts.push(`Content-Disposition: form-data; name="${fieldKey}"`)
    parts.push('')
    parts.push(String(extraFields[fieldKey]))
  }
  parts.push(`--${boundary}--`)
  parts.push('')
  return {
    body: Buffer.from(parts.join('\r\n'), 'binary'),
    boundary,
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
    path.join(os.tmpdir(), 'haxcms-actions-conformance-'),
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
  process.env.HAXCMS_ROOT = runtime.runtimeRoot
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
  const globalKeys = ['HAXCMS_RUNTIME_CREDENTIALS', 'HAXCMS_RUNTIME_USERNAME', 'HAXCMS_RUNTIME_PASSWORD']
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

function multipartAuthHeaders(jwt, boundary) {
  return {
    accept: 'application/json',
    'content-type': `multipart/form-data; boundary=${boundary}`,
    Authorization: `Bearer ${jwt}`,
  }
}

let runtime = null

test.before(async () => {
  runtime = await setupRuntime()
})

test.after(async () => {
  await teardownRuntime(runtime)
})

test('system actions endpoints conformance', async (t) => {
  await t.test('authenticated action endpoints require valid JWT', async () => {
    const endpoints = [
      { path: '/system/api/v1/actions/html-to-docx', method: 'POST', body: JSON.stringify({ html: '<p>test</p>' }) },
      { path: '/system/api/v1/actions/docx-to-html', method: 'POST', body: buildMultipartBody({ fileName: 't.docx', fileContents: Buffer.alloc(0) }).body },
      { path: '/system/api/v1/actions/md-to-html', method: 'POST', body: JSON.stringify({ md: '# test' }) },
      { path: '/system/api/v1/actions/html-to-md', method: 'POST', body: JSON.stringify({ html: '<p>test</p>' }) },
      { path: '/system/api/v1/actions/pretty-html', method: 'POST', body: JSON.stringify({ html: '<p>test</p>' }) },
      { path: '/system/api/v1/actions/json-to-yaml', method: 'POST', body: JSON.stringify({ json: { a: 1 } }) },
      { path: '/system/api/v1/actions/yaml-to-json', method: 'POST', body: JSON.stringify({ yaml: 'a: 1' }) },
      { path: '/system/api/v1/actions/html-to-pdf', method: 'POST', body: JSON.stringify({ html: '<p>test</p>' }) },
      { path: '/system/api/v1/actions/xlsx-to-csv', method: 'POST', body: buildMultipartBody({ fileName: 't.xlsx', fileContents: Buffer.alloc(0), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).body },
      { path: '/system/api/v1/actions/pdf-to-html', method: 'POST', body: buildMultipartBody({ fileName: 't.pdf', fileContents: Buffer.alloc(0), mimeType: 'application/pdf' }).body },
      { path: '/system/api/v1/actions/pptx-to-html', method: 'POST', body: buildMultipartBody({ fileName: 't.pptx', fileContents: Buffer.alloc(0), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }).body },
      { path: '/system/api/v1/actions/import-docx', method: 'POST', body: buildMultipartBody({ fileName: 't.docx', fileContents: Buffer.alloc(0) }).body },
      { path: '/system/api/v1/actions/import-pptx', method: 'POST', body: buildMultipartBody({ fileName: 't.pptx', fileContents: Buffer.alloc(0), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }).body },
      { path: '/system/api/v1/actions/docx-to-pdf', method: 'POST', body: buildMultipartBody({ fileName: 't.docx', fileContents: Buffer.alloc(0) }).body },
      { path: '/system/api/v1/site/import/haxcms', method: 'POST', body: JSON.stringify({ repoUrl: 'https://example.com' }) },
    ]

    for (const endpoint of endpoints) {
      const headers = {
        accept: 'application/json',
      }
      if (typeof endpoint.body === 'string') {
        headers['content-type'] = 'application/json'
      } else {
        headers['content-type'] = 'application/octet-stream'
      }
      const result = await sendHttpRequest({
        method: endpoint.method,
        url: `${runtime.baseUrl}${endpoint.path}`,
        headers,
        data: endpoint.body,
      })
      assert.ok(
        result.status === 401 || result.status === 403,
        `${endpoint.path} should require authentication (expected 401/403, got ${result.status})`,
      )
    }
  })

  await t.test('html-to-docx returns 400 without html body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/html-to-docx`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({}),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('html-to-docx converts valid HTML to base64 docx', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/html-to-docx`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        html: '<h1>Hello World</h1><p>Test paragraph</p>',
      }),
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data === 'string', 'Expected base64 string in data')
    assert.ok(body.data.length > 100, 'Expected non-trivial base64 payload')
  })

  await t.test('docx-to-html returns 400 for empty file upload', async () => {
    const multipart = buildMultipartBody({
      fileName: 'empty.docx',
      fileContents: Buffer.alloc(0),
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('docx-to-html returns 400 for invalid file type', async () => {
    const multipart = buildMultipartBody({
      fileName: 'test.txt',
      fileContents: 'not a docx',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('invalid') !== -1,
      'Expected invalid file type error message',
    )
  })

  await t.test('docx-to-html rejects .doc (legacy Word format)', async () => {
    const multipart = buildMultipartBody({
      fileName: 'legacy.doc',
      fileContents: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
      mimeType: 'application/msword',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('expected .docx') !== -1,
      'Expected error message to mention .docx only',
    )
  })

  await t.test('docx-to-html rejects .docx with missing ZIP signature', async () => {
    const multipart = buildMultipartBody({
      fileName: 'fake.docx',
      fileContents: Buffer.from('This is not a zip file'),
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('zip signature') !== -1 ||
        String(body.data.error).toLowerCase().indexOf('zip') !== -1,
      'Expected error message about ZIP signature',
    )
  })

  await t.test('docx-to-html converts valid docx to HTML', async () => {
    const docxBuffer = await createMinimalDocxBuffer()
    const multipart = buildMultipartBody({
      fileName: 'test.docx',
      fileContents: docxBuffer,
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected HTML contents string')
    assert.ok(
      String(body.data.contents).toLowerCase().indexOf('hello') !== -1,
      'Expected converted HTML to contain test text',
    )
  })

  await t.test('md-to-html returns 400 without md body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/md-to-html`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({}),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('md-to-html converts valid Markdown to HTML', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/md-to-html`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        md: '# Hello World\n\nThis is a **test** paragraph.',
      }),
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected HTML contents string')
    assert.ok(
      String(body.data.contents).toLowerCase().indexOf('<h1>') !== -1,
      'Expected converted HTML to contain h1 tag',
    )
    assert.ok(
      String(body.data.contents).toLowerCase().indexOf('<strong>') !== -1,
      'Expected converted HTML to contain strong tag',
    )
  })

  await t.test('html-to-md returns 400 without html body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/html-to-md`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({}),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('html-to-md converts valid HTML to Markdown', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/html-to-md`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        html: '<h1>Hello World</h1><p>This is a <strong>test</strong> paragraph.</p>',
      }),
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected Markdown contents string')
    assert.ok(
      String(body.data.contents).toLowerCase().indexOf('hello world') !== -1,
      'Expected converted Markdown to contain heading text',
    )
  })

  await t.test('pretty-html returns 400 without html body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pretty-html`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({}),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('pretty-html formats valid HTML', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pretty-html`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        html: '<div><p>Hello</p><span>World</span></div>',
      }),
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected formatted HTML contents string')
    assert.ok(
      String(body.data.contents).indexOf('\n') !== -1,
      'Expected pretty-printed HTML to contain line breaks',
    )
  })

  await t.test('json-to-yaml returns 400 without json body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/json-to-yaml`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({}),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('json-to-yaml converts valid JSON to YAML', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/json-to-yaml`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        json: { name: 'test', items: [1, 2, 3] },
      }),
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected YAML contents string')
    assert.ok(
      String(body.data.contents).indexOf('name:') !== -1,
      'Expected converted YAML to contain object keys',
    )
  })

  await t.test('yaml-to-json returns 400 without yaml body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/yaml-to-json`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({}),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('yaml-to-json converts valid YAML to JSON', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/yaml-to-json`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({
        yaml: 'name: test\nitems:\n  - 1\n  - 2\n  - 3',
      }),
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected JSON contents string')
    const parsed = JSON.parse(body.data.contents)
    assert.equal(parsed.name, 'test', 'Expected parsed JSON to contain name field')
    assert.ok(Array.isArray(parsed.items), 'Expected parsed JSON to contain items array')
  })

  await t.test('html-to-pdf returns 400 without html body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/html-to-pdf`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({}),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('xlsx-to-csv returns 400 for empty file upload', async () => {
    const multipart = buildMultipartBody({
      fileName: 'empty.xlsx',
      fileContents: Buffer.alloc(0),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/xlsx-to-csv`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('xlsx-to-csv returns 400 for invalid file type', async () => {
    const multipart = buildMultipartBody({
      fileName: 'test.txt',
      fileContents: 'not an xlsx',
      mimeType: 'text/plain',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/xlsx-to-csv`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('invalid') !== -1,
      'Expected invalid file type error message',
    )
  })

  await t.test('xlsx-to-csv converts valid xlsx to CSV', async () => {
    const xlsxBuffer = await createMinimalXlsxBuffer()
    const multipart = buildMultipartBody({
      fileName: 'test.xlsx',
      fileContents: xlsxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/xlsx-to-csv`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected CSV contents string')
    assert.ok(
      String(body.data.contents).indexOf('Alice') !== -1,
      'Expected CSV to contain test data',
    )
    assert.ok(
      Array.isArray(body.data.sheetNames) && body.data.sheetNames.length > 0,
      'Expected sheetNames array in response',
    )
  })

  await t.test('pdf-to-html returns 400 for empty file upload', async () => {
    const multipart = buildMultipartBody({
      fileName: 'empty.pdf',
      fileContents: Buffer.alloc(0),
      mimeType: 'application/pdf',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pdf-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('pdf-to-html returns 400 for invalid PDF signature', async () => {
    const multipart = buildMultipartBody({
      fileName: 'fake.pdf',
      fileContents: Buffer.from('This is not a PDF'),
      mimeType: 'application/pdf',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pdf-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('pdf') !== -1,
      'Expected error message about PDF signature',
    )
  })

  await t.test('pptx-to-html returns 400 for empty file upload', async () => {
    const multipart = buildMultipartBody({
      fileName: 'empty.pptx',
      fileContents: Buffer.alloc(0),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pptx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('pptx-to-html returns 400 for invalid file type', async () => {
    const multipart = buildMultipartBody({
      fileName: 'test.txt',
      fileContents: 'not a pptx',
      mimeType: 'text/plain',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pptx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('invalid') !== -1,
      'Expected invalid file type error message',
    )
  })

  await t.test('pptx-to-html returns 400 for missing ZIP signature', async () => {
    const multipart = buildMultipartBody({
      fileName: 'fake.pptx',
      fileContents: Buffer.from('This is not a zip file'),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pptx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('zip') !== -1,
      'Expected error message about ZIP signature',
    )
  })

  await t.test('pptx-to-html converts valid pptx to HTML', async () => {
    const pptxBuffer = await createMinimalPptxBuffer()
    const multipart = buildMultipartBody({
      fileName: 'test.pptx',
      fileContents: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/pptx-to-html`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(body.data && typeof body.data.contents === 'string', 'Expected HTML contents string')
  })

  await t.test('import-docx returns 400 for empty file upload', async () => {
    const multipart = buildMultipartBody({
      fileName: 'empty.docx',
      fileContents: Buffer.alloc(0),
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/import-docx`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('import-docx returns 400 for invalid file type', async () => {
    const multipart = buildMultipartBody({
      fileName: 'test.txt',
      fileContents: 'not a docx',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/import-docx`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('invalid') !== -1,
      'Expected invalid file type error message',
    )
  })

  await t.test('docx-to-pdf returns 400 for empty file upload', async () => {
    const multipart = buildMultipartBody({
      fileName: 'empty.docx',
      fileContents: Buffer.alloc(0),
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-pdf`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('docx-to-pdf returns 400 for invalid file type', async () => {
    const multipart = buildMultipartBody({
      fileName: 'test.txt',
      fileContents: 'not a docx',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-pdf`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('invalid') !== -1,
      'Expected invalid file type error message',
    )
  })

  await t.test('docx-to-pdf converts valid docx to PDF download', async () => {
    const docxBuffer = await createMinimalDocxBuffer()
    const multipart = buildMultipartBody({
      fileName: 'test.docx',
      fileContents: docxBuffer,
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-pdf`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
      responseType: 'arraybuffer',
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    assert.ok(
      result.headers['content-type'] && result.headers['content-type'].indexOf('application/pdf') !== -1,
      'Expected Content-Type to be application/pdf',
    )
    assert.ok(
      result.headers['content-disposition'] && result.headers['content-disposition'].indexOf('test.pdf') !== -1,
      'Expected Content-Disposition to contain test.pdf',
    )
  })

  await t.test('site-import returns 400 for unsupported platform', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/site/import/unknown-platform`,
      headers: authHeaders(runtime.jwt),
      data: JSON.stringify({ repoUrl: 'https://example.com' }),
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('unsupported') !== -1,
      'Expected unsupported platform error message',
    )
  })

  await t.test('import-docx converts valid docx to site schema items', async () => {
    const docxBuffer = await createMinimalDocxBuffer()
    const multipart = buildMultipartBody({
      fileName: 'test.docx',
      fileContents: docxBuffer,
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/import-docx`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(
      body.data && Array.isArray(body.data.items) && body.data.items.length > 0,
      'Expected items array in response data',
    )
    assert.ok(
      body.data && typeof body.data.filename === 'string',
      'Expected filename in response data',
    )
  })

  await t.test('import-pptx returns 400 for empty file upload', async () => {
    const multipart = buildMultipartBody({
      fileName: 'empty.pptx',
      fileContents: Buffer.alloc(0),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/import-pptx`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
  })

  await t.test('import-pptx returns 400 for invalid file type', async () => {
    const multipart = buildMultipartBody({
      fileName: 'test.txt',
      fileContents: 'not a pptx',
      mimeType: 'text/plain',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/import-pptx`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('invalid') !== -1,
      'Expected invalid file type error message',
    )
  })

  await t.test('import-pptx returns 400 for missing ZIP signature', async () => {
    const multipart = buildMultipartBody({
      fileName: 'fake.pptx',
      fileContents: Buffer.from('This is not a zip file'),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/import-pptx`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 400, `Expected 400, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.data && body.data.error, 'Expected error in response data')
    assert.ok(
      String(body.data.error).toLowerCase().indexOf('zip') !== -1,
      'Expected error message about ZIP signature',
    )
  })

  await t.test('import-pptx converts valid pptx to site schema items', async () => {
    const pptxBuffer = await createMinimalPptxBuffer()
    const multipart = buildMultipartBody({
      fileName: 'test.pptx',
      fileContents: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/import-pptx`,
      headers: multipartAuthHeaders(runtime.jwt, multipart.boundary),
      data: multipart.body,
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.bodyText}`)
    const body = JSON.parse(result.bodyText)
    assert.ok(body && body.status === 200, 'Expected status 200 in response envelope')
    assert.ok(
      body.data && Array.isArray(body.data.items),
      'Expected items array in response data',
    )
    assert.ok(
      body.data && typeof body.data.filename === 'string',
      'Expected filename in response data',
    )
  })

  await t.test('actions endpoints are listed in system OpenAPI spec', async () => {
    const result = await sendHttpRequest({
      method: 'GET',
      url: `${runtime.baseUrl}/system/api/v1/openapi.json`,
      headers: { accept: 'application/json' },
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}`)
    const spec = JSON.parse(result.bodyText)
    const expectedPaths = [
      '/system/api/v1/actions/docx-to-html',
      '/system/api/v1/actions/html-to-docx',
      '/system/api/v1/actions/md-to-html',
      '/system/api/v1/actions/html-to-md',
      '/system/api/v1/actions/pretty-html',
      '/system/api/v1/actions/json-to-yaml',
      '/system/api/v1/actions/yaml-to-json',
      '/system/api/v1/actions/html-to-pdf',
      '/system/api/v1/actions/xlsx-to-csv',
      '/system/api/v1/actions/pdf-to-html',
      '/system/api/v1/actions/pptx-to-html',
      '/system/api/v1/actions/import-docx',
      '/system/api/v1/actions/import-pptx',
      '/system/api/v1/actions/docx-to-pdf',
      '/system/api/v1/site/import/{platform}',
    ]
    for (const expectedPath of expectedPaths) {
      assert.ok(
        spec.paths && spec.paths[expectedPath],
        `Expected ${expectedPath} in OpenAPI paths`,
      )
    }
    assert.ok(
      spec.tags && spec.tags.some((tag) => tag.name === 'actions'),
      'Expected actions tag in OpenAPI tags',
    )
  })

  await t.test('all authenticated action endpoints declare non-empty security in OpenAPI spec', async () => {
    const result = await sendHttpRequest({
      method: 'GET',
      url: `${runtime.baseUrl}/system/api/v1/openapi.json`,
      headers: { accept: 'application/json' },
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}`)
    const spec = JSON.parse(result.bodyText)
    const authenticatedPaths = [
      '/system/api/v1/actions/docx-to-html',
      '/system/api/v1/actions/html-to-docx',
      '/system/api/v1/actions/md-to-html',
      '/system/api/v1/actions/html-to-md',
      '/system/api/v1/actions/pretty-html',
      '/system/api/v1/actions/json-to-yaml',
      '/system/api/v1/actions/yaml-to-json',
      '/system/api/v1/actions/html-to-pdf',
      '/system/api/v1/actions/xlsx-to-csv',
      '/system/api/v1/actions/pdf-to-html',
      '/system/api/v1/actions/pptx-to-html',
      '/system/api/v1/actions/import-docx',
      '/system/api/v1/actions/import-pptx',
      '/system/api/v1/actions/docx-to-pdf',
      '/system/api/v1/site/import/{platform}',
    ]
    for (const path of authenticatedPaths) {
      const pathItem = spec.paths && spec.paths[path]
      assert.ok(pathItem, `Expected ${path} in OpenAPI paths`)
      const postOp = pathItem && pathItem.post
      assert.ok(postOp, `Expected POST operation for ${path}`)
      const security = postOp.security
      assert.ok(
        security && Array.isArray(security) && security.length > 0,
        `Expected non-empty security declaration for ${path}`,
      )
      const hasOpenSecurity = security.some(
        (s) => typeof s === 'object' && Object.keys(s).length === 0,
      )
      assert.ok(
        !hasOpenSecurity,
        `${path} should not have open security (security: [])`,
      )
    }
  })
})
