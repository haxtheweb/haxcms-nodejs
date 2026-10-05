'use strict'

// Unit tests for the importHtml route handler (src/systemRoutes/v1/routes/
// importHtml.js): multipart upload validation (file presence, D37 field-name
// allowlist, .html/.htm extension, readable + non-empty file), html
// sanitization of the upload (script stripping), and the happy path running
// the REAL importHtmlToItems heading walker against a real .html temp file.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { importHtml } = require('../../src/systemRoutes/v1/routes/importHtml.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
  }
}

function uploadReq(file, body) {
  return {
    files: file ? [file] : [],
    body: body || {},
  }
}

let tmpDir

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-html-'))
})

test.after(() => {
  fs.removeSync(tmpDir)
})

test('missing upload returns 400 before reading anything', async () => {
  const res = stubRes()
  await importHtml(uploadReq(null), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'No file uploaded')
})

test('an unexpected upload field name returns 400 from the D37 allowlist', async () => {
  const res = stubRes()
  await importHtml(uploadReq({ fieldname: 'payload', originalname: 'import.html', path: '/tmp/x.html' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Unexpected upload field name `payload`; expected one of: upload, file, file-upload',
  )
  assert.equal(res.body.data.filename, 'import.html')
})

test('a non-html extension returns 400 with the filename echoed', async () => {
  const res = stubRes()
  await importHtml(uploadReq({ fieldname: 'upload', originalname: 'notes.txt', path: '/tmp/x.txt' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Invalid file type. Expected .html or .htm, got: notes.txt')
})

test('an unreadable upload returns 400 with a read error', async () => {
  const res = stubRes()
  await importHtml(
    uploadReq({ fieldname: 'upload', originalname: 'missing.html', path: path.join(tmpDir, 'no-such.html') }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to read uploaded file/)
})

test('a whitespace-only html file returns 400 as empty', async () => {
  const blankPath = path.join(tmpDir, 'blank.html')
  fs.writeFileSync(blankPath, '   \n  ')
  const res = stubRes()
  await importHtml(uploadReq({ fieldname: 'upload', originalname: 'blank.html', path: blankPath }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Uploaded file is empty')
})

test('a valid html upload converts headings into items with scripts stripped', async () => {
  const htmlPath = path.join(tmpDir, 'course.html')
  fs.writeFileSync(
    htmlPath,
    '<h1>Course Home</h1><p>Course intro content</p>' +
      '<h2>Unit One</h2><p>Unit one content</p>' +
      '<script>evilPayload()</script>',
  )
  const res = stubRes()
  await importHtml(uploadReq({ fieldname: 'upload', originalname: 'course.html', path: htmlPath }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'course.html')

  const items = res.body.data.items
  assert.equal(items.length, 2)
  assert.equal(items[0].title, 'Course Home')
  assert.ok(items[0].contents.indexOf('Course intro content') !== -1)
  assert.equal(items[1].title, 'Unit One')
  assert.equal(items[1].parent, items[0].id)
  assert.equal(items[1].indent, 1)
  assert.ok(items[1].contents.indexOf('Unit one content') !== -1)
  // the script was stripped by sanitizeUntrustedHtml before import
  assert.ok(items[1].contents.indexOf('evilPayload') === -1, 'script content sanitized away')
})

test('method + type + parentId form fields thread through to the import', async () => {
  const htmlPath = path.join(tmpDir, 'typed.html')
  fs.writeFileSync(htmlPath, '<h1>Typed Page</h1><p>Typed body</p>')
  const res = stubRes()
  await importHtml(
    uploadReq(
      { fieldname: 'file', originalname: 'typed.html', path: htmlPath },
      { method: 'page', type: 'course', parentId: 'node-5' },
    ),
    res,
  )
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 1)
  assert.equal(res.body.data.items[0].title, 'typed')
  assert.equal(res.body.data.items[0].parent, 'node-5')
})

test('headings with no body content fall back to the type template content', async () => {
  const htmlPath = path.join(tmpDir, 'bare.html')
  fs.writeFileSync(htmlPath, '<h1>Bare Page</h1>')
  const res = stubRes()
  await importHtml(
    uploadReq({ fieldname: 'upload', originalname: 'bare.html', path: htmlPath }, { type: 'course' }),
    res,
  )
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 1)
  assert.ok(
    res.body.data.items[0].contents.indexOf('lesson-overview') !== -1,
    'course type fallback content injected',
  )
})
