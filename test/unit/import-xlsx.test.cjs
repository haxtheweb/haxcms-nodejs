'use strict'

// Unit tests for the importXlsx route handler (src/systemRoutes/v1/routes/
// importXlsx.js): multipart upload validation (file presence, .xlsx/.xls
// extension, readable + non-empty buffer, parseable workbook) and the happy
// path, which runs the REAL vendored SheetJS parser (lib/vendor/xlsx) against
// real .xlsx binary fixtures generated at runtime with the same library
// (book_new/aoa_to_sheet/write, matching the pptx-in-html-out.test.cjs
// approach of building real binary fixtures instead of mocking the parser).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')

const XLSX = require('../../src/lib/vendor/xlsx/xlsx.js')
const { importXlsx } = require('../../src/systemRoutes/v1/routes/importXlsx.js')

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

// rowsToSiteItems contract: first data row is the header (Title/Slug/Parent/
// Content), following rows become items with parent resolution by slug.
function buildXlsxBuffer(rows, sheetName) {
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName || 'Sheet1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

let tmpDir

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-xlsx-'))
})

test.after(() => {
  fs.removeSync(tmpDir)
})

test('missing upload returns 400 before reading anything', async () => {
  const res = stubRes()
  await importXlsx(uploadReq(null), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'No file uploaded')
})

test('a non-xlsx extension returns 400 with the filename echoed', async () => {
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'notes.txt', path: '/tmp/x.txt' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Invalid file type. Expected .xlsx or .xls, got: notes.txt')
})

test('an unreadable upload returns 400 with a read error', async () => {
  const res = stubRes()
  await importXlsx(
    uploadReq({ originalname: 'missing.xlsx', path: path.join(tmpDir, 'no-such.xlsx') }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to read uploaded file/)
})

test('an empty file returns 400 before parsing', async () => {
  const emptyPath = path.join(tmpDir, 'empty.xlsx')
  fs.writeFileSync(emptyPath, Buffer.alloc(0))
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'empty.xlsx', path: emptyPath }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Uploaded file is empty')
})

test('a zip that is not a spreadsheet fails parsing with a processing error', async () => {
  const junkPath = path.join(tmpDir, 'junk.xlsx')
  // a plain (non-spreadsheet) ZIP archive: SheetJS rejects it deterministically
  const zip = new JSZip()
  zip.file('readme.txt', 'not a spreadsheet')
  const junkBuffer = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(junkPath, junkBuffer)
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'junk.xlsx', path: junkPath }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Error processing Excel import: Unsupported ZIP file/)
})

test('a spreadsheet with no rows at all fails as empty', async () => {
  const blankPath = path.join(tmpDir, 'blank.xlsx')
  fs.writeFileSync(blankPath, buildXlsxBuffer([]))
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'blank.xlsx', path: blankPath }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Spreadsheet is empty/)
})

test('a spreadsheet whose rows are all blank fails with no header row', async () => {
  const blankRowsPath = path.join(tmpDir, 'blank-rows.xlsx')
  // empty-string cells survive sheet_to_json as a blank row, which has no
  // header data in it
  fs.writeFileSync(blankRowsPath, buildXlsxBuffer([['', '', '', '']]))
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'blank-rows.xlsx', path: blankRowsPath }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Spreadsheet has no header row/)
})

test('a spreadsheet whose only row is the header fails as no data rows', async () => {
  const headerOnlyPath = path.join(tmpDir, 'header-only.xlsx')
  fs.writeFileSync(
    headerOnlyPath,
    buildXlsxBuffer([['Title', 'Slug', 'Parent', 'Content'], ['', '', '', '']]),
  )
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'header-only.xlsx', path: headerOnlyPath }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.deepEqual(res.body.data.items, [])
})

test('a data row without a title returns 400 with the row number', async () => {
  const noTitlePath = path.join(tmpDir, 'no-title.xlsx')
  fs.writeFileSync(
    noTitlePath,
    buildXlsxBuffer([
      ['Title', 'Slug', 'Parent', 'Content'],
      ['', 'home', '', '<p>no title</p>'],
    ]),
  )
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'no-title.xlsx', path: noTitlePath }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Row 2: title is required/)
})

test('a data row without a slug returns 400 with the row number', async () => {
  const noSlugPath = path.join(tmpDir, 'no-slug.xlsx')
  fs.writeFileSync(
    noSlugPath,
    buildXlsxBuffer([
      ['Title', 'Slug', 'Parent', 'Content'],
      ['Home', '', '', '<p>no slug</p>'],
    ]),
  )
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'no-slug.xlsx', path: noSlugPath }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Row 2: slug is required/)
})

test('duplicate slugs return 400 naming the earlier row', async () => {
  const dupPath = path.join(tmpDir, 'dup.xlsx')
  fs.writeFileSync(
    dupPath,
    buildXlsxBuffer([
      ['Title', 'Slug', 'Parent', 'Content'],
      ['First', 'same-slug', '', '<p>first</p>'],
      ['Second', 'same-slug', '', '<p>second</p>'],
    ]),
  )
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'dup.xlsx', path: dupPath }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /duplicate slug "same-slug" \(already used on row 2\)/)
})

test('a valid workbook converts rows into ordered items with parent resolution', async () => {
  const xlsxPath = path.join(tmpDir, 'outline.xlsx')
  fs.writeFileSync(
    xlsxPath,
    buildXlsxBuffer([
      ['Title', 'Slug', 'Parent', 'Content'],
      ['Home', 'home', '', '<p>Welcome home</p>'],
      ['About', 'about', 'home', '<p>About us</p>'],
      ['Orphan', 'orphan', 'ghost-parent', '<p>No such parent</p>'],
    ]),
  )
  const res = stubRes()
  await importXlsx(uploadReq({ originalname: 'outline.xlsx', path: xlsxPath }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'outline.xlsx')
  assert.equal(res.body.data.selectedSheet, 'Sheet1')

  const items = res.body.data.items
  assert.equal(items.length, 3)

  assert.equal(items[0].title, 'Home')
  assert.equal(items[0].slug, 'home')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].parent, '')
  assert.equal(items[0].contents, '<p>Welcome home</p>')

  // about resolves its parent slug to the home item's generated id
  assert.equal(items[1].title, 'About')
  assert.equal(items[1].slug, 'about')
  assert.equal(items[1].order, 1)
  assert.equal(items[1].parent, items[0].id)
  assert.equal(items[1].indent, 1)
  assert.equal(items[1].contents, '<p>About us</p>')

  // an unknown parent slug leaves the item at the root
  assert.equal(items[2].title, 'Orphan')
  assert.equal(items[2].parent, '')
  assert.equal(items[2].indent, 0)
})
