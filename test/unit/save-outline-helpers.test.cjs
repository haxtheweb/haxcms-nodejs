'use strict'

// Unit tests for the pure module-scope helper functions attached as named
// properties on the saveOutline handler export (saveOutline.<helperName>).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const { describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const saveOutline = require('../../src/siteRoutes/v1/routes/saveOutline.js')
const { HAXCMS } = require('../../src/lib/HAXCMS.js')

const {
  normalizeOutlineLocation,
  normalizeOutlineSlug,
  getValidatedWritePath,
  isLikelyHtmlContent,
  saveOutlineError,
} = saveOutline

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

describe('saveOutline.normalizeOutlineLocation', () => {
  test('accepts valid pages/... and content/... paths', () => {
    assert.equal(normalizeOutlineLocation('pages/abc/index.html'), 'pages/abc/index.html')
    assert.equal(normalizeOutlineLocation('content/foo/bar.html'), 'content/foo/bar.html')
  })

  test('rejects path traversal with ..', () => {
    assert.equal(normalizeOutlineLocation('pages/../../etc/passwd'), false)
    assert.equal(normalizeOutlineLocation('pages/..'), false)
    assert.equal(normalizeOutlineLocation('../pages/abc/index.html'), false)
  })

  test('normalizes backslashes to forward slashes', () => {
    assert.equal(normalizeOutlineLocation('pages\\abc\\index.html'), 'pages/abc/index.html')
  })

  test('rejects null-byte content', () => {
    assert.equal(normalizeOutlineLocation('pages/abc\u0000/index.html'), false)
  })

  test('rejects absolute paths', () => {
    assert.equal(normalizeOutlineLocation('/pages/abc/index.html'), false)
  })

  test('rejects non-string input', () => {
    assert.equal(normalizeOutlineLocation(null), false)
    assert.equal(normalizeOutlineLocation(undefined), false)
    assert.equal(normalizeOutlineLocation(42), false)
    assert.equal(normalizeOutlineLocation({}), false)
  })

  test('rejects locations with an empty segment or unrecognized root', () => {
    assert.equal(normalizeOutlineLocation('pages//index.html'), false)
    assert.equal(normalizeOutlineLocation('assets/abc/index.html'), false)
    assert.equal(normalizeOutlineLocation(''), false)
  })
})

describe('saveOutline.getValidatedWritePath', () => {
  let tmpDir

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-outline-'))
    fs.ensureDirSync(path.join(tmpDir, 'pages', 'item-1'))
    fs.writeFileSync(path.join(tmpDir, 'pages', 'item-1', 'index.html'), '<p>hi</p>')
    fs.ensureDirSync(path.join(tmpDir, 'pages', 'a-dir'))
  })

  test.afterEach(() => {
    fs.removeSync(tmpDir)
  })

  test('returns the resolved absolute path for a real, valid file', () => {
    const result = getValidatedWritePath(tmpDir, 'pages/item-1/index.html')
    assert.equal(result, path.resolve(tmpDir, 'pages/item-1/index.html'))
  })

  test('rejects a path that escapes the site directory', () => {
    // normalizeOutlineLocation already rejects '..' segments, so this should
    // fail at that stage and return false.
    const result = getValidatedWritePath(tmpDir, '../outside/index.html')
    assert.equal(result, false)
  })

  test('rejects a location pointing to a non-existent file', () => {
    const result = getValidatedWritePath(tmpDir, 'pages/does-not-exist/index.html')
    assert.equal(result, false)
  })

  test('rejects a location that resolves to a directory instead of a file', () => {
    const result = getValidatedWritePath(tmpDir, 'pages/a-dir')
    assert.equal(result, false)
  })

  test('rejects an invalid normalized location up front', () => {
    const result = getValidatedWritePath(tmpDir, null)
    assert.equal(result, false)
  })
})

describe('saveOutline.isLikelyHtmlContent', () => {
  test('recognizes simple html tags', () => {
    assert.equal(isLikelyHtmlContent('<p>hello</p>'), true)
    assert.equal(isLikelyHtmlContent('<div class="foo">bar</div>'), true)
    assert.equal(isLikelyHtmlContent('some text <span>then a tag</span>'), true)
  })

  test('rejects plain text with no tags', () => {
    assert.equal(isLikelyHtmlContent('just plain text'), false)
  })

  test('rejects empty or whitespace-only strings', () => {
    assert.equal(isLikelyHtmlContent(''), false)
    assert.equal(isLikelyHtmlContent('   '), false)
  })

  test('rejects non-string input', () => {
    assert.equal(isLikelyHtmlContent(null), false)
    assert.equal(isLikelyHtmlContent(undefined), false)
    assert.equal(isLikelyHtmlContent(42), false)
    assert.equal(isLikelyHtmlContent(['<p>x</p>']), false)
  })
})

describe('saveOutline.saveOutlineError', () => {
  test('sets status and json body on the response', () => {
    const res = stubRes()
    const result = saveOutlineError(res, 400, 'invalid page reference')
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.body, {
      status: 400,
      data: { message: 'invalid page reference' },
    })
    // returns the res object (chainable), matching res.status().json() usage
    assert.equal(result, res)
  })
})

describe('saveOutline.normalizeOutlineSlug', () => {
  function makeSite(existingSlugs) {
    return {
      getUniqueSlugName(slug, page, pathAuto) {
        // minimal stand-in mirroring HAXCMS.getUniqueSlugName's uniqueness
        // contract: append -N until the slug isn't already taken.
        let candidate = slug
        let loop = 0
        while (existingSlugs.indexOf(candidate) !== -1) {
          loop++
          candidate = slug + '-' + loop
        }
        return candidate
      },
    }
  }

  test('passes a normal slug through HAXCMS.generateSlugName untouched', () => {
    const site = makeSite([])
    assert.equal(normalizeOutlineSlug(site, 'My Great Page'), HAXCMS.generateSlugName('My Great Page'))
  })

  test('special-cases a generated slug of exactly "x" to "x-x"', () => {
    const site = makeSite([])
    assert.equal(HAXCMS.generateSlugName('x'), 'x')
    assert.equal(normalizeOutlineSlug(site, 'x'), 'x-x')
  })

  test('special-cases a generated slug starting with "x/" to "x-x/"', () => {
    const site = makeSite([])
    assert.equal(HAXCMS.generateSlugName('x/child'), 'x/child')
    assert.equal(normalizeOutlineSlug(site, 'x/child'), 'x-x/child')
  })

  test('special-cases an empty generated slug to "blank"', () => {
    const site = makeSite([])
    assert.equal(HAXCMS.generateSlugName('...'), '')
    assert.equal(normalizeOutlineSlug(site, '...'), 'blank')
  })

  test('delegates uniqueness resolution to site.getUniqueSlugName', () => {
    const site = makeSite(['my-page'])
    assert.equal(normalizeOutlineSlug(site, 'My Page'), 'my-page-1')
  })
})
