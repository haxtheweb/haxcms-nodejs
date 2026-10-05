'use strict'

// Unit tests for convertPressbooksToSite: discovers a Pressbooks (WordPress)
// REST API base from a repoUrl via /wp-json/ namespaces or the toc fallback,
// walks front-matter / parts+chapters / back-matter into JSONOutlineSchemaItem
// objects (chapters nesting under their part), absolutizes root-relative URLs,
// normalizes a site license, and mirrors the importHtml multipart upload path
// for .html file imports (field-name allowlist + extension validation).
//
// safeFetch is mocked by mutating the shared module export BEFORE the
// converter is required, since the converter destructures { safeFetch } at
// require time (same pattern as convert-elmsln-to-site.test.cjs).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const fetchedUrls = []

function mockResp(opts) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    json: async () => opts.json,
    text: async () => (typeof opts.text === 'string' ? opts.text : ''),
  }
}

// Pressbooks TOC shape: /wp-json/pressbooks/v2/toc returns front-matter,
// parts (each with nested chapters), and back-matter arrays. Entries with
// export: false are skipped by the importer without fetching their entity.
const TOC = {
  'front-matter': [
    { id: 10, menu_order: 0, title: 'Introduction', has_post_content: true },
    { id: 11, menu_order: 1, title: 'Hidden Front Matter', export: false },
  ],
  parts: [
    {
      id: 20,
      menu_order: 1,
      title: 'Part One',
      chapters: [
        { id: 30, menu_order: 0, title: 'Chapter One' },
        { id: 31, menu_order: 1, title: 'Hidden Chapter', export: false },
        { id: 32, menu_order: 2, title: 'Chapter Three' },
      ],
    },
  ],
  'back-matter': [{ id: 40, menu_order: 2, title: 'Appendix', has_post_content: true }],
}

// site metadata with nested copyright + a cc license string; exercises the
// recursive license-candidate collection and value normalization
const SITE_METADATA = {
  name: 'Biology Basics',
  about: { copyright: 'All rights reserved' },
  license: 'cc by-nc-sa 4.0',
}

const FRONT_MATTER_10 = {
  id: 10,
  title: { rendered: 'Introduction' },
  content: { rendered: '<p>Front matter content</p>' },
  link: 'https://pressbooks.example.com/front-matter/introduction/',
}

const PART_20 = {
  id: 20,
  title: { rendered: 'Part One' },
  content: { raw: '<p>Part one raw overview</p>' },
  link: 'https://pressbooks.example.com/part/part-one/',
}

const CHAPTER_30 = {
  id: 30,
  title: { rendered: 'Chapter One' },
  content: {
    rendered:
      '<p>Chapter body with <a href="/internal/link">link</a> and <img src="/images/pic.png"></p>',
  },
  link: 'https://pressbooks.example.com/chapter/chapter-one/',
}

const CHAPTER_32 = {
  id: 32,
  title: 'Chapter Three',
  content: 'plain string content',
  link: 'https://pressbooks.example.com/chapter/chapter-three/',
}

async function mockSafeFetch(url) {
  fetchedUrls.push(String(url))
  if (String(url).endsWith('/wp-json/')) {
    if (String(url).indexOf('badtoc.example.com') !== -1 || String(url).indexOf('pressbooks.example.com') !== -1) {
      return mockResp({ json: { namespaces: ['routes/oembed', 'pressbooks/v2'] } })
    }
    if (String(url).indexOf('fallback.example.com') !== -1) {
      return mockResp({ json: { namespaces: ['wp/v2'] } })
    }
    return mockResp({ ok: false, status: 404, json: {} })
  }
  if (String(url).indexOf('/wp-json/pressbooks/v2/toc') !== -1) {
    if (String(url).indexOf('nowhere.example.com') !== -1) {
      return mockResp({ ok: false, status: 404, json: {} })
    }
    if (String(url).indexOf('badtoc.example.com') !== -1) {
      return mockResp({ json: { message: 'no toc here' } })
    }
    return mockResp({ json: TOC })
  }
  if (String(url).indexOf('/wp-json/pressbooks/v2/metadata') !== -1) {
    return mockResp({ json: SITE_METADATA })
  }
  if (String(url).indexOf('/wp-json/pressbooks/v2/front-matter/10') !== -1) {
    return mockResp({ json: FRONT_MATTER_10 })
  }
  if (String(url).indexOf('/wp-json/pressbooks/v2/parts/20') !== -1) {
    return mockResp({ json: PART_20 })
  }
  if (String(url).indexOf('/wp-json/pressbooks/v2/chapters/30') !== -1) {
    return mockResp({ json: CHAPTER_30 })
  }
  if (String(url).indexOf('/wp-json/pressbooks/v2/chapters/32') !== -1) {
    return mockResp({ json: CHAPTER_32 })
  }
  // every other pressbooks endpoint (e.g. back-matter/40 entity) 404s so the
  // importer falls back to the TOC section entry data
  return mockResp({ ok: false, status: 404, json: {} })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertPressbooksToSite } = require('../../src/systemRoutes/v1/routes/imports/convertPressbooksToSite.js')

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

function jsonReq(body) {
  return { body: body }
}

function multipartReq(file, body) {
  return {
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    files: file ? [file] : [],
    body: body || {},
  }
}

let tmpDir

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pressbooks-import-'))
})

test.after(() => {
  fs.removeSync(tmpDir)
})

test.beforeEach(() => {
  fetchedUrls.length = 0
})

test('missing repoUrl returns 400 before any fetch', async () => {
  const res = stubRes()
  await convertPressbooksToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('an array body is rejected as missing repoUrl', async () => {
  const res = stubRes()
  await convertPressbooksToSite(jsonReq(['not', 'an', 'object']), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
})

test('failed API discovery returns 422 with a descriptive error', async () => {
  const res = stubRes()
  await convertPressbooksToSite(jsonReq({ repoUrl: 'https://nowhere.example.com/book' }), res)
  assert.equal(res.statusCode, 422)
  assert.equal(
    res.body.data.error,
    'Unable to discover Pressbooks API from `repoUrl`; expected `/wp-json/pressbooks/v2/*`',
  )
})

test('discovery succeeds via the toc fallback when /wp-json/ hides the pressbooks namespace', async () => {
  const res = stubRes()
  await convertPressbooksToSite(jsonReq({ repoUrl: 'https://fallback.example.com/book' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 5)
  // both discovery probes were attempted against the first candidate
  assert.ok(
    fetchedUrls.filter((u) => u.indexOf('fallback.example.com/book/wp-json/') !== -1).length >= 1,
    'namespace probe made against the candidate base',
  )
  assert.ok(
    fetchedUrls.filter((u) => u.indexOf('fallback.example.com/book/wp-json/pressbooks/v2/toc') !== -1)
      .length >= 2,
    'toc probe used for discovery and then for the import itself',
  )
})

test('a discovered API with an invalid toc returns 422 import failed', async () => {
  const res = stubRes()
  await convertPressbooksToSite(jsonReq({ repoUrl: 'https://badtoc.example.com/book' }), res)
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.data.error, 'Pressbooks API discovered but import failed to produce content')
})

test('a discovered book converts to ordered items with nested chapters and metadata', async () => {
  const res = stubRes()
  await convertPressbooksToSite(jsonReq({ repoUrl: 'https://pressbooks.example.com/book' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'biology-basics')
  assert.deepEqual(res.body.data.files, {})
  assert.deepEqual(res.body.data.site, { license: 'by-nc-sa' })

  const items = res.body.data.items
  assert.equal(items.length, 5, 'export:false entries are skipped')

  // front matter: top level, order 0, rendered content
  assert.equal(items[0].title, 'Introduction')
  assert.equal(items[0].slug, 'introduction')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].indent, 0)
  assert.equal(items[0].parent, null)
  assert.equal(items[0].contents, '<p>Front matter content</p>')
  assert.equal(items[0].metadata.sourceType, 'front-matter')
  assert.equal(items[0].metadata.pressbooks.id, 10)
  assert.equal(items[0].metadata.pressbooks.menuOrder, 0)

  // part: top level, order 1, raw content preferred when rendered is absent
  assert.equal(items[1].title, 'Part One')
  assert.equal(items[1].slug, 'part-one')
  assert.equal(items[1].order, 1)
  assert.equal(items[1].contents, '<p>Part one raw overview</p>')
  assert.equal(items[1].metadata.sourceType, 'part')

  // chapter one nests under the part with absolutized root-relative URLs
  assert.equal(items[2].title, 'Chapter One')
  assert.equal(items[2].slug, 'part-one/chapter-one')
  assert.equal(items[2].order, 0)
  assert.equal(items[2].indent, 1)
  assert.equal(items[2].parent, items[1].id)
  assert.equal(
    items[2].contents,
    '<p>Chapter body with <a href="https://pressbooks.example.com/internal/link">link</a> and ' +
      '<img src="https://pressbooks.example.com/images/pic.png"></p>',
  )

  // chapter three uses plain string title + content entity shapes
  assert.equal(items[3].title, 'Chapter Three')
  assert.equal(items[3].slug, 'part-one/chapter-three')
  assert.equal(items[3].order, 1)
  assert.equal(items[3].contents, 'plain string content')

  // back matter entity fetch failed: title/content fall back to the toc entry
  assert.equal(items[4].title, 'Appendix')
  assert.equal(items[4].order, 2)
  assert.equal(items[4].contents, '<p></p>')
  assert.equal(items[4].metadata.sourceType, 'back-matter')
  assert.equal(items[4].metadata.pressbooks.id, 40)
})

test('parentId is threaded through to top-level items', async () => {
  const res = stubRes()
  await convertPressbooksToSite(
    jsonReq({ repoUrl: 'https://pressbooks.example.com/book', parentId: 'node-99' }),
    res,
  )
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items[0].parent, 'node-99')
  assert.equal(res.body.data.items[1].parent, 'node-99')
  // chapters still point at their generated part item
  assert.equal(res.body.data.items[2].parent, res.body.data.items[1].id)
})

test('multipart import with no files returns 400', async () => {
  const res = stubRes()
  await convertPressbooksToSite(multipartReq(null), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'No file uploaded')
})

test('multipart import rejects an unexpected upload field name', async () => {
  const res = stubRes()
  await convertPressbooksToSite(
    multipartReq({ fieldname: 'unexpected', originalname: 'import.html', path: '/tmp/x.html' }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Unexpected upload field name `unexpected`; expected one of: upload, file, file-upload',
  )
})

test('multipart import rejects a non-html extension', async () => {
  const res = stubRes()
  await convertPressbooksToSite(
    multipartReq({ fieldname: 'upload', originalname: 'notes.txt', path: '/tmp/x.txt' }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Invalid file type. Expected .html or .htm, got: notes.txt')
})

test('multipart import returns 400 when the uploaded file cannot be read', async () => {
  const res = stubRes()
  await convertPressbooksToSite(
    multipartReq({
      fieldname: 'upload',
      originalname: 'missing.html',
      path: path.join(tmpDir, 'does-not-exist.html'),
    }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to read uploaded file/)
})

test('multipart import of a valid html file converts headings into items', async () => {
  const htmlPath = path.join(tmpDir, 'import.html')
  fs.writeFileSync(htmlPath, '<h1>Imported Page</h1><p>Imported body</p>')
  const res = stubRes()
  await convertPressbooksToSite(
    multipartReq({ fieldname: 'upload', originalname: 'import.html', path: htmlPath }),
    res,
  )
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'import.html')
  assert.equal(res.body.data.items.length, 1)
  assert.equal(res.body.data.items[0].title, 'Imported Page')
  assert.equal(res.body.data.items[0].contents, '<p>Imported body</p>')
})
