'use strict'

// Unit tests for the OpenStax importer (#2912).
//
// The importer reads a book through OpenStax's archive API: the release
// manifest, a slug lookup, the book tree, then one JSON document per page.
// Every request goes through safeFetch, which these tests stub, so the suite
// never touches the network.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')

const safeFetchLib = require('../../src/lib/safeFetch.js')
const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const { convertOpenstaxToSite, LIMITS } = require('../../src/systemRoutes/v1/routes/imports/convertOpenstaxToSite.js')

const BOOK_ID = '052b8372-0c5e-4ff6-8fd3-326377e9e91f'
const BOOK_VERSION = '56af1c4'
const ARCHIVE = '/apps/archive/20260604.144757'
const PAGE_ONE = '11111111-1111-1111-1111-111111111111'
const PAGE_TWO = '22222222-2222-2222-2222-222222222222'
const PREFACE = '33333333-3333-3333-3333-333333333333'
// a 1x1 PNG, standing in for an archive image resource
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

// OpenStax page XHTML, with the styling layer and structure it really ships
const PAGE_ONE_CONTENT = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>/* STYLING_FOR_DEVS */ .os-figure { color: red; }</style></head>
<body><div data-type="page" id="page-1">
  <h1 data-type="document-title" id="fs-id111"><span class="os-number">1.1</span><span class="os-text">What Is Finance?</span></h1>
  <div data-type="abstract" class="os-abstract">By the end of this section you will be able to explain finance.</div>
  <p class="os-para" id="fs-id222">Finance is the <strong class="os-strong">study of money</strong>.</p>
  <figure id="Figure_01" class="medium"><span data-type="media" data-alt="a chart"><img src="../resources/abc123def456" alt="A bar chart of returns" class="os-img"/></span><div class="os-caption-container"><span class="os-title-label">Figure 1.1</span><span class="os-caption">Returns over time.</span></div></figure>
  <div data-type="note" class="finance tip" id="fs-id333"><h3 class="os-title"><span class="os-title-label">Link to Learning</span></h3><div class="body"><p>See <a href="/contents/${PAGE_TWO}#anchor">the next section</a> and <a href="https://example.org/paper">an external paper</a>.</p></div></div>
  <div data-type="example" id="fs-id444"><h3 data-type="title">Worked Example</h3><p>Compute <math display="inline"><semantics><mrow><mn>2</mn><mo stretchy="false">+</mo><mn>2</mn></mrow><annotation encoding="TeX">2+2</annotation></semantics></math>.</p></div>
  <table class="os-table" id="fs-id555"><thead><tr><th scope="col" class="os-th">Year</th></tr></thead><tbody><tr><td colspan="1" class="os-td">2024</td></tr></tbody></table>
</div></body></html>`

const PAGE_TWO_CONTENT = `<div data-type="page"><h1 data-type="document-title">1.2 The Role of Finance</h1><p class="os-para">Second section body.</p></div>`
const PREFACE_CONTENT = `<div data-type="page"><h1 data-type="document-title">Preface</h1><p>Welcome to the book.</p></div>`

function treeNode(id, title, slug, contents) {
  const node = { id: id + '@' + BOOK_VERSION, title: title, slug: slug }
  if (contents) {
    node.contents = contents
  }
  return node
}

function defaultRoutes() {
  return {
    'https://openstax.org/rex/release.json': {
      json: { archiveUrl: ARCHIVE, books: { [BOOK_ID]: { defaultVersion: BOOK_VERSION } } },
    },
    'https://openstax.org/apps/cms/api/v2/pages/?type=books.Book&fields=title,cnx_id&slug=principles-finance': {
      json: { items: [{ title: 'Principles of Finance', cnx_id: BOOK_ID }] },
    },
    [`https://openstax.org${ARCHIVE}/contents/${BOOK_ID}@${BOOK_VERSION}.json`]: {
      json: {
        title: 'Principles of Finance',
        license: {
          name: 'Creative Commons Attribution-NonCommercial-ShareAlike License',
          url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
        },
        tree: {
          contents: [
            treeNode(PREFACE, 'Preface', 'preface'),
            treeNode(BOOK_ID, '<span class="os-number">Chapter 1</span><span class="os-text">Introduction to Finance</span>', '1-introduction-to-finance', [
              treeNode(PAGE_ONE, '<span class="os-number">1.1</span><span class="os-text">What Is Finance?</span>', '1-1-what-is-finance'),
              treeNode(PAGE_TWO, '1.2 The Role of Finance', '1-2-the-role-of-finance'),
            ]),
          ],
        },
      },
    },
    [`https://openstax.org${ARCHIVE}/contents/${BOOK_ID}@${BOOK_VERSION}:${PREFACE}.json`]: {
      json: { slug: 'preface', title: 'Preface', content: PREFACE_CONTENT },
    },
    [`https://openstax.org${ARCHIVE}/contents/${BOOK_ID}@${BOOK_VERSION}:${PAGE_ONE}.json`]: {
      json: { slug: '1-1-what-is-finance', title: 'What Is Finance?', abstract: 'Explain finance.', content: PAGE_ONE_CONTENT },
    },
    [`https://openstax.org${ARCHIVE}/contents/${BOOK_ID}@${BOOK_VERSION}:${PAGE_TWO}.json`]: {
      json: { slug: '1-2-the-role-of-finance', title: 'The Role of Finance', content: PAGE_TWO_CONTENT },
    },
    [`https://openstax.org${ARCHIVE}/resources/abc123def456`]: {
      buffer: PNG,
      contentType: 'image/png',
    },
  }
}

function buildResponse(entry) {
  const body = entry.buffer ? entry.buffer : Buffer.from(JSON.stringify(entry.json), 'utf8')
  return {
    ok: entry.ok === false ? false : true,
    status: entry.status ? entry.status : 200,
    headers: {
      get: function (name) {
        if (String(name).toLowerCase() === 'content-type') {
          return entry.contentType ? entry.contentType : 'application/json'
        }
        return null
      },
    },
    text: function () {
      return Promise.resolve(body.toString('utf8'))
    },
    arrayBuffer: function () {
      return Promise.resolve(body)
    },
  }
}

function makeResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: function (code) {
      this.statusCode = code
      return this
    },
    json: function (payload) {
      this.body = payload
      return this
    },
  }
  return res
}

describe('convertOpenstaxToSite — #2912', () => {
  let routes
  let requested
  let originalSafeFetch
  let stagedDirectories = []
  let originalLimits

  beforeEach(() => {
    routes = defaultRoutes()
    requested = []
    originalSafeFetch = safeFetchLib.safeFetch
    originalLimits = Object.assign({}, LIMITS)
    safeFetchLib.safeFetch = function (url) {
      requested.push(url)
      const entry = routes[url]
      if (!entry) {
        return Promise.reject(new Error('unexpected request: ' + url))
      }
      return Promise.resolve(buildResponse(entry))
    }
  })

  afterEach(() => {
    safeFetchLib.safeFetch = originalSafeFetch
    Object.assign(LIMITS, originalLimits)
    // every run stages into its own directory under the import staging root;
    // drop whatever this test created so nothing is left on disk
    for (let i = 0; i < stagedDirectories.length; i++) {
      try {
        fs.removeSync(stagedDirectories[i])
      } catch (e) {}
    }
    stagedDirectories = []
  })

  // record the staging directory of every file the importer reports
  function trackStaged(res) {
    const files = res && res.body && res.body.data && res.body.data.files ? res.body.data.files : {}
    const names = Object.keys(files)
    for (let i = 0; i < names.length; i++) {
      const directory = path.dirname(files[names[i]])
      if (stagedDirectories.indexOf(directory) === -1) {
        stagedDirectories.push(directory)
      }
    }
  }

  async function importBook(repoUrl) {
    const res = makeResponse()
    await convertOpenstaxToSite({ body: { repoUrl: repoUrl || 'https://openstax.org/details/books/principles-finance' } }, res)
    trackStaged(res)
    return res
  }

  test('rejects a missing, off-site or slug-less repoUrl', async () => {
    const cases = [
      [undefined, 'missing'],
      ['https://example.org/details/books/principles-finance', 'openstax.org'],
      ['https://openstax.org/subjects/business', 'book slug'],
      ['not a url', 'valid URL'],
    ]
    for (const entry of cases) {
      const res = makeResponse()
      await convertOpenstaxToSite({ body: entry[0] ? { repoUrl: entry[0] } : {} }, res)
      assert.equal(res.statusCode, 400, JSON.stringify(res.body))
      assert.ok(
        String(res.body.data.error).indexOf(entry[1]) !== -1,
        `expected "${entry[1]}" in: ${res.body.data.error}`,
      )
    }
    assert.deepEqual(requested, [], 'nothing is fetched for a bad request')
  })

  test('reports a book OpenStax does not publish as 422', async () => {
    routes['https://openstax.org/apps/cms/api/v2/pages/?type=books.Book&fields=title,cnx_id&slug=principles-finance'].json = { items: [] }
    const res = await importBook()
    assert.equal(res.statusCode, 422)
    assert.ok(String(res.body.data.error).indexOf('no book with the slug') !== -1, res.body.data.error)
  })

  test('reports an unreadable table of contents as 422', async () => {
    routes[`https://openstax.org${ARCHIVE}/contents/${BOOK_ID}@${BOOK_VERSION}.json`].json = { title: 'Principles of Finance' }
    const res = await importBook()
    assert.equal(res.statusCode, 422)
    assert.ok(String(res.body.data.error).indexOf('no table of contents') !== -1, res.body.data.error)
  })

  test('builds the chapter and section hierarchy as JOS items', async () => {
    const res = await importBook()
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const items = res.body.data.items
    assert.equal(res.body.data.filename, 'principles-finance')
    assert.equal(items.length, 4)
    const [preface, chapter, sectionOne, sectionTwo] = items
    assert.equal(preface.title, 'Preface')
    assert.equal(preface.indent, 0)
    assert.equal(preface.parent, null)
    assert.equal(preface.slug, 'preface')
    assert.equal(chapter.title, 'Chapter 1 Introduction to Finance')
    assert.equal(chapter.indent, 0)
    assert.equal(chapter.order, 1)
    assert.equal(sectionOne.indent, 1)
    assert.equal(sectionOne.parent, chapter.id, 'sections hang off their chapter')
    assert.equal(sectionOne.order, 0)
    assert.equal(sectionTwo.order, 1)
    assert.equal(sectionOne.slug, `${chapter.slug}/1-1-what-is-finance`, 'nested slugs carry the chapter path')
    assert.equal(chapter.contents, '<p></p>', 'a chapter heading is a landing page')
  })

  test('carries the book license, source and attribution', async () => {
    const res = await importBook()
    assert.equal(res.body.data.site.license, 'by-nc-sa', 'the license is read per book, not assumed')
    const section = res.body.data.items[2]
    assert.equal(section.metadata.sourceType, 'openstax')
    assert.equal(section.metadata.source, 'https://openstax.org/books/principles-finance/pages/1-1-what-is-finance')
    assert.equal(section.metadata.openstax.bookTitle, 'Principles of Finance')
    assert.equal(section.metadata.openstax.publisher, 'OpenStax / Rice University')
    assert.equal(section.metadata.openstax.license.url, 'https://creativecommons.org/licenses/by-nc-sa/4.0/')
    assert.ok(section.metadata.openstax.accessed, 'access date recorded')
  })

  test('strips the OpenStax styling layer but keeps the structure', async () => {
    const res = await importBook()
    const html = res.body.data.items[2].contents
    for (const junk of ['os-para', 'os-figure', 'fs-id', 'data-type=', 'STYLING_FOR_DEVS', '<style', 'class=']) {
      assert.equal(html.indexOf(junk), -1, `${junk} should be gone: ${html.slice(0, 400)}`)
    }
    assert.equal(html.indexOf('<h1'), -1, 'the page title becomes the item title')
    assert.ok(html.indexOf('<figure>') !== -1, 'figures survive')
    assert.ok(html.indexOf('<table>') !== -1 && html.indexOf('<th scope="col">') !== -1, 'tables keep headers')
    assert.ok(html.indexOf('<td colspan="1">') !== -1, 'cell spans survive')
    assert.ok(html.indexOf('Returns over time.') !== -1, 'captions survive as text')
    assert.ok(html.indexOf('<strong>study of money</strong>') !== -1, 'inline markup survives')
    assert.ok(html.indexOf('By the end of this section') !== -1, 'learning objectives survive')
  })

  test('keeps MathML, including the attributes that carry notation', async () => {
    const res = await importBook()
    const html = res.body.data.items[2].contents
    assert.ok(html.indexOf('<math display="inline">') !== -1, 'math element and display attribute kept')
    assert.ok(html.indexOf('<mo stretchy="false">+</mo>') !== -1, 'attributes inside math are left alone')
    assert.ok(html.indexOf('<annotation encoding="TeX">') !== -1, 'the TeX annotation is carried along')
  })

  test('stages images into files and points the img at the site path', async () => {
    const res = await importBook()
    const files = res.body.data.files
    const names = Object.keys(files)
    assert.deepEqual(names, ['files/abc123def456.png'], 'named from the resource with the served type')
    assert.deepEqual(fs.readFileSync(files[names[0]]), PNG, 'the staged bytes are the image')
    assert.ok(
      files[names[0]].indexOf(path.join(HAXCMS.configDirectory, 'tmp', 'imports')) === 0,
      'staged where createSite accepts bulk imports',
    )
    const html = res.body.data.items[2].contents
    assert.ok(html.indexOf('<img src="files/abc123def456.png" alt="A bar chart of returns">') !== -1, html.slice(0, 300))
  })

  test('leaves an image alone when it cannot be staged', async () => {
    routes[`https://openstax.org${ARCHIVE}/resources/abc123def456`] = { buffer: Buffer.from('<svg/>'), contentType: 'image/svg+xml' }
    const res = await importBook()
    assert.deepEqual(res.body.data.files, {}, 'nothing staged for an unsupported type')
    const html = res.body.data.items[2].contents
    assert.ok(
      html.indexOf(`<img src="https://openstax.org${ARCHIVE}/resources/abc123def456"`) !== -1,
      'the image still loads from OpenStax',
    )
  })

  test('points in-book links at imported pages and absolutizes the rest', async () => {
    const res = await importBook()
    const html = res.body.data.items[2].contents
    const sectionTwo = res.body.data.items[3]
    assert.ok(html.indexOf(`<a href="${sectionTwo.slug}#anchor">`) !== -1, `in-book link rewritten: ${html}`)
    assert.ok(html.indexOf('<a href="https://example.org/paper">') !== -1, 'external links are untouched')
  })

  test('fetches each page once, in reading order', async () => {
    const res = await importBook()
    const pageIds = []
    for (let i = 0; i < requested.length; i++) {
      const match = requested[i].match(/contents\/[0-9a-f-]+@[^:]+:([0-9a-f-]+)\.json$/)
      if (match) {
        pageIds.push(match[1])
      }
    }
    assert.deepEqual(pageIds, [PREFACE, PAGE_ONE, PAGE_TWO], 'reading order, no repeats')
  })

  test('stops at the page cap and links unimported pages to their source', async () => {
    LIMITS.maxPages = 1
    const res = await importBook()
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.truncated, true, 'the caller is told the import was cut short')
    const items = res.body.data.items
    assert.ok(items[0].contents.indexOf('Welcome to the book') !== -1, 'the first page is imported')
    assert.equal(
      items[2].contents,
      '<p>Read this page on <a href="https://openstax.org/books/principles-finance/pages/1-1-what-is-finance">OpenStax</a>.</p>',
      'pages past the cap link out instead of arriving empty',
    )
  })

  test('reports an untruncated import as complete', async () => {
    const res = await importBook()
    assert.equal(res.body.data.truncated, false)
  })

  test('stops staging images at the image cap', async () => {
    LIMITS.maxImages = 0
    const res = await importBook()
    assert.deepEqual(res.body.data.files, {}, 'no image is staged once the cap is reached')
    assert.ok(
      res.body.data.items[2].contents.indexOf(`<img src="https://openstax.org${ARCHIVE}/resources/abc123def456"`) !== -1,
      'the image still loads from OpenStax',
    )
  })

  test('stops staging images at the byte budget', async () => {
    LIMITS.maxImageBytes = 1
    const res = await importBook()
    assert.deepEqual(res.body.data.files, {})
  })

  test('accepts a reader URL as well as a details URL', async () => {
    const res = await importBook('https://openstax.org/books/principles-finance/pages/1-1-what-is-finance')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.filename, 'principles-finance')
  })
})
