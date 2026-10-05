'use strict'

// Unit tests for the importPdf route handler (src/systemRoutes/v1/routes/
// importPdf.js): multipart upload validation (file presence, .pdf extension,
// readable file, non-empty buffer, %PDF magic) and the happy path, which runs
// the REAL pdf.js conversion (pdfToSemanticHtml) plus the REAL heading walker
// (importHtmlToItems) against a minimal-but-valid PDF generated at runtime
// (byte-exact xref offsets, same fixture approach as
// pdf-to-semantic-html.test.cjs / pptx-in-html-out.test.cjs).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { importPdf } = require('../../src/systemRoutes/v1/routes/importPdf.js')

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

// minimal one-page PDF: an h1-scale title and two body paragraphs
function buildPdfBuffer(draws) {
  function pdfString(text) {
    return text.replace(/[()\\]/g, (ch) => '\\' + ch)
  }
  let content = ''
  draws.forEach((draw) => {
    content += `BT\n/F1 ${draw.size} Tf\n${draw.x} ${draw.y} Td\n(${pdfString(draw.text)}) Tj\nET\n`
  })
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((obj, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefOffset = pdf.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((offset) => {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += xref
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const TITLE_DRAWS = [
  { size: 24, x: 72, y: 720, text: 'Document Title' },
  { size: 12, x: 72, y: 680, text: 'First paragraph line.' },
  { size: 12, x: 72, y: 660, text: 'Second paragraph line.' },
]

let tmpDir

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-pdf-'))
})

test.after(() => {
  fs.removeSync(tmpDir)
})

test('missing upload returns 400 before reading anything', async () => {
  const res = stubRes()
  await importPdf(uploadReq(null), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'No file uploaded')
})

test('a non-pdf extension returns 400 with the filename echoed', async () => {
  const res = stubRes()
  await importPdf(uploadReq({ originalname: 'notes.txt', path: '/tmp/x.txt' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Invalid file type. Expected .pdf, got: notes.txt')
  assert.equal(res.body.data.filename, 'notes.txt')
})

test('an unreadable upload returns 400 with a read error', async () => {
  const res = stubRes()
  await importPdf(
    uploadReq({ originalname: 'missing.pdf', path: path.join(tmpDir, 'no-such-file.pdf') }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to read uploaded file/)
})

test('an empty pdf file returns 400', async () => {
  const emptyPath = path.join(tmpDir, 'empty.pdf')
  fs.writeFileSync(emptyPath, Buffer.alloc(0))
  const res = stubRes()
  await importPdf(uploadReq({ originalname: 'empty.pdf', path: emptyPath }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Uploaded file is empty')
})

test('a file without the %PDF magic returns 400 as an invalid PDF', async () => {
  const fakePath = path.join(tmpDir, 'fake.pdf')
  fs.writeFileSync(fakePath, 'definitely not a pdf file')
  const res = stubRes()
  await importPdf(uploadReq({ originalname: 'fake.pdf', path: fakePath }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Uploaded file is not a valid PDF.')
})

test('a valid pdf converts into heading-derived items', async () => {
  const pdfPath = path.join(tmpDir, 'sample.pdf')
  fs.writeFileSync(pdfPath, buildPdfBuffer(TITLE_DRAWS))
  const res = stubRes()
  await importPdf(uploadReq({ originalname: 'sample.pdf', path: pdfPath }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'sample.pdf')
  assert.equal(res.body.data.items.length, 1)
  assert.equal(res.body.data.items[0].title, 'Document Title')
  assert.ok(res.body.data.items[0].contents.indexOf('First paragraph line.') !== -1)
  assert.ok(res.body.data.items[0].contents.indexOf('Second paragraph line.') !== -1)
})

test('method page + parentId produce a single page item under the given parent', async () => {
  const pdfPath = path.join(tmpDir, 'page-import.pdf')
  fs.writeFileSync(pdfPath, buildPdfBuffer(TITLE_DRAWS))
  const res = stubRes()
  await importPdf(
    uploadReq({ originalname: 'page-import.pdf', path: pdfPath }, { method: 'page', parentId: 'node-9' }),
    res,
  )
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 1)
  // single-page mode titles the item from the filename (minus extension)
  assert.equal(res.body.data.items[0].title, 'page-import')
  assert.equal(res.body.data.items[0].parent, 'node-9')
})

test('a pdf.js parse failure surfaces as a processing error', async () => {
  const brokenPath = path.join(tmpDir, 'broken.pdf')
  // valid magic but a truncated body: %PDF header only, nothing parseable
  fs.writeFileSync(brokenPath, Buffer.from('%PDF-1.4\n(nothing else', 'latin1'))
  const res = stubRes()
  await importPdf(uploadReq({ originalname: 'broken.pdf', path: brokenPath }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /pdfToSite: Error processing file|Error processing PDF import/)
})
