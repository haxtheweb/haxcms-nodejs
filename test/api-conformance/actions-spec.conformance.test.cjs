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

  delete require.cache[require.resolve(APP_ENTRY_PATH)]
  runtime.appModule = require(APP_ENTRY_PATH)
  runtime.port = await runtime.appModule.serverReady
  runtime.baseUrl = `http://127.0.0.1:${runtime.port}`

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

let runtime = null

test.before(async () => {
  runtime = await setupRuntime()
})

test.after(async () => {
  await teardownRuntime(runtime)
})

test('system actions endpoints conformance', async (t) => {
  await t.test('html-to-docx returns 400 without html body', async () => {
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/html-to-docx`,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
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
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
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
      headers: {
        accept: 'application/json',
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
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
      headers: {
        accept: 'application/json',
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
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

  await t.test('docx-to-html converts valid docx to HTML', async () => {
    const docxBuffer = await createMinimalDocxBuffer()
    const multipart = buildMultipartBody({
      fileName: 'test.docx',
      fileContents: docxBuffer,
    })
    const result = await sendHttpRequest({
      method: 'POST',
      url: `${runtime.baseUrl}/system/api/v1/actions/docx-to-html`,
      headers: {
        accept: 'application/json',
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
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

  await t.test('actions endpoints are listed in system OpenAPI spec', async () => {
    const result = await sendHttpRequest({
      method: 'GET',
      url: `${runtime.baseUrl}/system/api/v1/openapi.json`,
      headers: { accept: 'application/json' },
    })
    assert.equal(result.status, 200, `Expected 200, got ${result.status}`)
    const spec = JSON.parse(result.bodyText)
    assert.ok(
      spec.paths && spec.paths['/system/api/v1/actions/docx-to-html'],
      'Expected docx-to-html in OpenAPI paths',
    )
    assert.ok(
      spec.paths && spec.paths['/system/api/v1/actions/html-to-docx'],
      'Expected html-to-docx in OpenAPI paths',
    )
    assert.ok(
      spec.tags && spec.tags.some((tag) => tag.name === 'actions'),
      'Expected actions tag in OpenAPI tags',
    )
  })
})
