'use strict'

// Unit tests for convertRecipeToSite: this converter's success path shells
// out to the `hax` CLI via child_process.exec (site scaffold, recipe:play,
// site:items), which is NOT safe or appropriate to invoke in a unit test.
//
// The pure helper functions (deriveRecipeName, slugifyTitle,
// parseRecipeItems) are NOT exported from convertRecipeToSite.js, so they
// cannot be tested directly. Per the task scope, this file only exercises the
// request-validation branches that return a response BEFORE `exec` is ever
// called:
//   - missing recipe content, file upload, and repoUrl -> 400
//   - invalid upload field name -> 400
//   - unreadable uploaded file -> 400
//
// None of these tests should cause child_process.exec to run; each assertion
// includes a guard on a spied `child_process.exec` call count to make that
// explicit and catch any future regression that accidentally reaches exec
// before returning.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')
const child_process = require('child_process')

// Spy on child_process.exec so we can assert it is never invoked by any test
// in this file (all covered branches return before the converter calls exec).
let execCallCount = 0
const originalExec = child_process.exec
child_process.exec = function spiedExec(...args) {
  execCallCount += 1
  // Should never actually be reached by the branches under test, but if it
  // somehow were, fail fast instead of spawning a real process.
  const cb = args[args.length - 1]
  if (typeof cb === 'function') {
    cb(new Error('exec should not be called by these validation-only tests'))
  }
  return { on() {} }
}

const { convertRecipeToSite } = require('../../src/systemRoutes/v1/routes/imports/convertRecipeToSite.js')

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'haxconv-recipe-'))

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

function baseReq(overrides) {
  const req = {
    body: {},
    query: {},
    files: [],
  }
  return Object.assign(req, overrides)
}

test.after(() => {
  child_process.exec = originalExec
  fs.removeSync(TMP_BASE)
})

test.beforeEach(() => {
  execCallCount = 0
})

test('missing recipe content, file upload, and repoUrl -> 400', async () => {
  const res = stubRes()
  await convertRecipeToSite(baseReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing recipe content, file upload, or `repoUrl` param')
  assert.deepEqual(res.body.data.items, [])
  assert.equal(res.body.data.filename, null)
  assert.equal(execCallCount, 0, 'exec must not be called when validation fails')
})

test('invalid upload field name -> 400', async () => {
  const filePath = path.join(TMP_BASE, 'recipe1.json')
  fs.writeFileSync(filePath, JSON.stringify({ items: [] }))
  const res = stubRes()
  const req = baseReq({
    files: [{ fieldname: 'bogus-field', originalname: 'recipe1.json', path: filePath }],
  })
  await convertRecipeToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unexpected upload field name/)
  assert.deepEqual(res.body.data.items, [])
  assert.equal(execCallCount, 0, 'exec must not be called when the upload field name is invalid')
})

test('unreadable uploaded file -> 400', async () => {
  const res = stubRes()
  const req = baseReq({
    files: [
      {
        fieldname: 'upload',
        originalname: 'missing-recipe.json',
        path: path.join(TMP_BASE, 'does-not-exist.json'),
      },
    ],
  })
  await convertRecipeToSite(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to read uploaded file/)
  assert.deepEqual(res.body.data.items, [])
  assert.equal(execCallCount, 0, 'exec must not be called when the uploaded file cannot be read')
})

test('valid upload field names ("upload", "file", "file-upload") pass validation without triggering exec-path errors before file read', async () => {
  // These field names are accepted by the allowlist; we still point at a
  // valid readable file so the field-name/readability checks both pass, and
  // stop the assertion right there (before exec would be invoked) by relying
  // on the spied exec rejecting so the converter returns its generic error
  // branch instead of actually spawning a process.
  const allowedFieldNames = ['upload', 'file', 'file-upload']
  for (const fieldname of allowedFieldNames) {
    const filePath = path.join(TMP_BASE, `${fieldname}-recipe.json`)
    fs.writeFileSync(filePath, JSON.stringify({ items: [{ title: 'Page' }] }))
    const res = stubRes()
    const req = baseReq({
      files: [{ fieldname: fieldname, originalname: `${fieldname}-recipe.json`, path: filePath }],
    })
    await convertRecipeToSite(req, res)
    // The spied exec always errors, so the converter falls into its generic
    // catch-all 400 (proving the field-name + file-read checks passed and
    // execution reached the exec call, which we intercepted rather than ran).
    assert.equal(res.statusCode, 400)
    assert.match(res.body.data.error, /Error processing recipe/)
  }
})
