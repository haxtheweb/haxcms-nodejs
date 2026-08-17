'use strict'

// Unit tests for convertHtmlToSite covering both entry paths:
//   - multipart/form-data file upload (req.files)
//   - JSON body { repoUrl } fetched via safeFetch
//
// safeFetch is mocked by mutating the shared module export BEFORE the
// converter is required, since the converter destructures { safeFetch } at
// require time (same pattern as convert-haxcms-to-site.test.cjs).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const fetchedUrls = []

function mockResp(opts) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    text: async () => (typeof opts.text === 'string' ? opts.text : ''),
  }
}

async function mockSafeFetch(url) {
  fetchedUrls.push(url)
  if (url === 'https://example.com/fail.html') {
    return mockResp({ ok: false, status: 404 })
  }
  if (url === 'https://example.com/empty.html') {
    return mockResp({ text: '' })
  }
  return mockResp({ text: '<h1>Title</h1><p>Body content</p>' })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertHtmlToSite } = require('../../src/systemRoutes/v1/routes/imports/convertHtmlToSite.js')

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'haxconv-html-'))

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

function multipartReq(files) {
  return {
    headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
    files: files,
    body: {},
  }
}

function jsonReq(body) {
  return {
    headers: {},
    body: body,
  }
}

function writeTmpFile(name, content) {
  const filePath = path.join(TMP_BASE, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

test.after(() => {
  fs.removeSync(TMP_BASE)
})

test.beforeEach(() => {
  fetchedUrls.length = 0
})

// ---------------------------------------------------------------------------
// Multipart upload path
// ---------------------------------------------------------------------------

test('multipart upload: valid field name "upload" with .html file succeeds', async () => {
  const filePath = writeTmpFile('valid1.html', '<h1>Title</h1><p>Body</p>')
  const res = stubRes()
  const req = multipartReq([{ fieldname: 'upload', originalname: 'valid1.html', path: filePath }])
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'valid1.html')
  assert.equal(res.body.data.items.length, 1)
  assert.equal(res.body.data.items[0].title, 'Title')
})

test('multipart upload: valid field name "file" succeeds', async () => {
  const filePath = writeTmpFile('valid2.htm', '<h1>Title</h1><p>Body</p>')
  const res = stubRes()
  const req = multipartReq([{ fieldname: 'file', originalname: 'valid2.htm', path: filePath }])
  await convertHtmlToSite(req, res)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'valid2.htm')
})

test('multipart upload: valid field name "file-upload" succeeds', async () => {
  const filePath = writeTmpFile('valid3.html', '<h1>Title</h1><p>Body</p>')
  const res = stubRes()
  const req = multipartReq([{ fieldname: 'file-upload', originalname: 'valid3.html', path: filePath }])
  await convertHtmlToSite(req, res)
  assert.equal(res.body.status, 200)
})

test('multipart upload: no files -> 400', async () => {
  const res = stubRes()
  const req = multipartReq([])
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'No file uploaded')
  assert.deepEqual(res.body.data.items, [])
  assert.equal(res.body.data.filename, null)
})

test('multipart upload: invalid field name -> 400', async () => {
  const filePath = writeTmpFile('valid4.html', '<h1>Title</h1><p>Body</p>')
  const res = stubRes()
  const req = multipartReq([{ fieldname: 'bogus-field', originalname: 'valid4.html', path: filePath }])
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unexpected upload field name/)
  assert.equal(res.body.data.filename, 'valid4.html')
})

test('multipart upload: non-.html/.htm extension -> 400', async () => {
  const filePath = writeTmpFile('valid5.txt', 'not html')
  const res = stubRes()
  const req = multipartReq([{ fieldname: 'upload', originalname: 'valid5.txt', path: filePath }])
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Invalid file type/)
  assert.equal(res.body.data.filename, 'valid5.txt')
})

test('multipart upload: unreadable file -> 400', async () => {
  const res = stubRes()
  const req = multipartReq([{ fieldname: 'upload', originalname: 'missing.html', path: path.join(TMP_BASE, 'does-not-exist.html') }])
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to read uploaded file/)
})

// ---------------------------------------------------------------------------
// JSON repoUrl fetch path
// ---------------------------------------------------------------------------

test('repoUrl path: successful fetch returns 200 with items via importHtmlToItems', async () => {
  const res = stubRes()
  const req = jsonReq({ repoUrl: 'https://example.com/page.html' })
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'page.html')
  assert.equal(res.body.data.items.length, 1)
  assert.equal(res.body.data.items[0].title, 'Title')
  assert.equal(res.body.data.items[0].contents, '<p>Body content</p>')
  assert.ok(fetchedUrls.indexOf('https://example.com/page.html') !== -1)
})

test('repoUrl path: fetch failure -> 400', async () => {
  const res = stubRes()
  const req = jsonReq({ repoUrl: 'https://example.com/fail.html' })
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to fetch URL/)
  assert.deepEqual(res.body.data.items, [])
})

test('repoUrl path: missing repoUrl -> 400 before any fetch', async () => {
  fetchedUrls.length = 0
  const res = stubRes()
  const req = jsonReq({})
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('repoUrl path: empty html content -> 400', async () => {
  const res = stubRes()
  const req = jsonReq({ repoUrl: 'https://example.com/empty.html' })
  await convertHtmlToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Empty HTML content')
})
