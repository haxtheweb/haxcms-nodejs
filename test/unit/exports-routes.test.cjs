'use strict'

// Direct handler tests for src/siteRoutes/v1/exports.js:
//   siteExport, siteExportMutation, itemExport
//
// PDF/DOCX converters are stubbed at the module boundary BEFORE exports.js
// is required (it destructures convertHtmlToDocxBuffer / htmlToPdfBuffer at
// require time — same mutate-before-require pattern as
// appstore-blocks-discovery.test.cjs), so download paths are exercised
// without booting Puppeteer. EPUB export runs the real epub-gen-memory
// against text-only content (no remote fetches). Site resolution runs
// through the real resolveSiteForRequest with HAXCMS.loadSite mocked per
// test (save-settings-routes.test.cjs pattern); page content is served from
// a fake getPageContent so no site disk tree is needed.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const JSZip = require('jszip')

const convertUtils = require('../../src/lib/convertUtils.js')
// fixture buffers (or thrown Errors) produced by the stubbed converters
let docxFixture = Buffer.from('docx-bytes')
let pdfFixture = Buffer.from('pdf-bytes')
function toFixtureResult(fixture) {
  if (fixture instanceof Error) {
    throw fixture
  }
  return fixture
}
convertUtils.convertHtmlToDocxBuffer = async () => toFixtureResult(docxFixture)
convertUtils.htmlToPdfBuffer = async () => toFixtureResult(pdfFixture)

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const {
  siteExport,
  siteExportMutation,
  itemExport,
} = require('../../src/siteRoutes/v1/exports.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(value) {
      this.sent = value
      return this
    },
    set(name, value) {
      this.headers[name] = value
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
      return this
    },
  }
}

function makeReq(overrides) {
  const req = {
    headers: { host: 'cms.example.com' },
    query: {},
    params: {},
    body: {},
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'tester',
      siteName: 'demo',
    },
  }
  return Object.assign(req, overrides || {})
}

// fake site whose pages resolve through loadNode + getPageContent
function makeFakeSite(overrides) {
  const items = [
    {
      id: 'item-1',
      title: 'First Page',
      slug: 'first-page',
      parent: null,
      indent: 0,
      order: 0,
      location: 'pages/item-1/index.html',
      description: 'The first',
      metadata: { published: true },
    },
    {
      id: 'item-2',
      title: 'Second Page',
      slug: 'second-page',
      parent: 'item-1',
      indent: 1,
      order: 1,
      location: 'pages/item-2/index.html',
      description: 'The second',
      metadata: {},
    },
  ]
  const contents = {
    'item-1': '<p>First page <strong>bold</strong> content</p>',
    'item-2': '<p>Second page content</p>',
  }
  const site = {
    siteDirectory: '/tmp/demo',
    name: 'demo',
    manifest: {
      title: 'Demo Site',
      description: 'A demo site',
      license: 'by-sa',
      metadata: {
        site: {
          name: 'demo',
          logo: 'files/logo.png',
          updated: 1700000000,
          lang: 'en',
        },
        author: { name: 'Test Author' },
      },
      items: items,
      findBranch(ancestor) {
        if (ancestor === 'item-1') {
          return [items[0], items[1]]
        }
        return []
      },
    },
    loadNode(id) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].id === id) {
          return items[i]
        }
      }
      return null
    },
    async getPageContent(page) {
      return contents[page.id] || ''
    },
  }
  return Object.assign(site, overrides || {})
}

function mockSite(t, site) {
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// ---------------------------------------------------------------------------
// siteExport
// ---------------------------------------------------------------------------
describe('exports routes — siteExport', () => {
  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await siteExport(makeReq({ params: { format: 'pdf' } }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/site/export/:format',
    )
  })

  test('an unsupported format answers 400 with the supported list', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExport(makeReq({ params: { format: 'rtf' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Unsupported site export format "rtf"')
    assert.ok(res.body.data.supportedFormats.indexOf('pdf') !== -1)
  })

  test('zip and skeleton formats answer the download descriptors', async (t) => {
    mockSite(t, makeFakeSite())
    const resZip = stubRes()
    await siteExport(makeReq({ params: { format: 'zip' } }), resZip)
    assert.equal(resZip.statusCode, 200)
    assert.equal(resZip.body.status, 200)
    assert.equal(resZip.body.data.format, 'zip')
    assert.equal(resZip.body.data.export.mediaType, 'application/zip')
    assert.equal(
      resZip.body.data.export.href,
      '/system/api/v1/sites/demo/download',
    )
    assert.equal(resZip.body.data.export.method, 'POST')
    const resSkeleton = stubRes()
    await siteExport(makeReq({ params: { format: 'skeleton' } }), resSkeleton)
    assert.equal(resSkeleton.body.data.format, 'skeleton')
    assert.equal(
      resSkeleton.body.data.export.href,
      '/system/api/v1/sites/demo/download-skeleton',
    )
  })

  test('markdown and html formats answer their descriptors', async (t) => {
    mockSite(t, makeFakeSite())
    const resMd = stubRes()
    await siteExport(makeReq({ params: { format: 'markdown' } }), resMd)
    assert.equal(resMd.body.data.format, 'markdown')
    assert.equal(resMd.body.data.export.mediaType, 'text/markdown')
    assert.equal(
      resMd.body.data.export.href,
      '/x/api/v1/content?mode=concat&format=md',
    )
    assert.equal(resMd.body.data.links.self, '/x/api/v1/site/export/markdown')
    // GET format=html answers the html DOWNLOAD, so the descriptor shape is
    // only reachable through the mutation handler
    const resHtmlDescriptor = stubRes()
    await siteExportMutation(makeReq({ params: { format: 'html' } }), resHtmlDescriptor)
    assert.equal(resHtmlDescriptor.body.data.export.mediaType, 'text/html')
    assert.equal(resHtmlDescriptor.body.data.export.href, '/x/api/v1/site/export/html')
  })

  test('a pdf export downloads the converted buffer', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExport(makeReq({ params: { format: 'pdf' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'application/pdf')
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="demo.pdf"')
    assert.equal(res.headers['Content-Length'], 'pdf-bytes'.length)
    assert.equal(res.sent.toString(), 'pdf-bytes')
  })

  test('a docx export downloads the converted buffer', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExport(makeReq({ params: { format: 'docx' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(
      res.headers['Content-Type'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    assert.equal(res.sent.toString(), 'docx-bytes')
  })

  test('a converter failure answers 502 with its message', async (t) => {
    mockSite(t, makeFakeSite())
    pdfFixture = new Error('puppeteer exploded')
    t.after(() => {
      pdfFixture = Buffer.from('pdf-bytes')
    })
    const res = stubRes()
    await siteExport(makeReq({ params: { format: 'pdf' } }), res)
    assert.equal(res.statusCode, 502)
    assert.equal(res.body.data.message, 'puppeteer exploded')
    // an empty conversion output answers the empty-output 502
    pdfFixture = null
    const res2 = stubRes()
    await siteExport(makeReq({ params: { format: 'pdf' } }), res2)
    assert.equal(res2.statusCode, 502)
    assert.equal(res2.body.data.message, 'Export conversion returned empty output')
  })

  test('an html export downloads the document html', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExport(makeReq({ params: { format: 'html' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8')
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="demo.html"')
    const html = res.sent.toString()
    assert.ok(html.indexOf('<!doctype html>') === 0)
    assert.ok(html.indexOf('<h1>Demo Site</h1>') !== -1)
    assert.ok(html.indexOf('data-item-slug="first-page"') !== -1)
    assert.ok(html.indexOf('First page <strong>bold</strong> content') !== -1)
    assert.ok(html.indexOf('<h2>Second Page</h2>') !== -1)
  })

  test('an html export with an ancestor filter only includes that branch', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExport(
      makeReq({ params: { format: 'html' }, query: { 'filter.ancestor': 'item-1' } }),
      res,
    )
    const html = res.sent.toString()
    assert.ok(html.indexOf('data-item-slug="first-page"') !== -1)
    assert.ok(html.indexOf('data-item-slug="second-page"') !== -1)
    // an unknown ancestor resolves to an empty branch
    const res2 = stubRes()
    await siteExport(
      makeReq({ params: { format: 'html' }, query: { 'filter.ancestor': 'ghost' } }),
      res2,
    )
    const html2 = res2.sent.toString()
    assert.equal(html2.indexOf('data-item-slug="first-page"'), -1)
    assert.equal(html2.indexOf('data-item-slug="second-page"'), -1)
  })

  test('a loadNode crash fails document exports with the build error', async (t) => {
    const site = makeFakeSite()
    site.loadNode = () => {
      throw new Error('loadNode crashed')
    }
    mockSite(t, site)
    const resPdf = stubRes()
    await siteExport(makeReq({ params: { format: 'pdf' } }), resPdf)
    assert.equal(resPdf.statusCode, 500)
    assert.equal(
      resPdf.body.data.message,
      'Unable to build site export HTML: loadNode crashed',
    )
    const resHtml = stubRes()
    await siteExport(makeReq({ params: { format: 'html' } }), resHtml)
    assert.equal(resHtml.statusCode, 500)
    assert.equal(
      resHtml.body.data.message,
      'Unable to build site export HTML: loadNode crashed',
    )
  })

  test('a magic html export wraps the content for print rendering', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExport(
      makeReq({ params: { format: 'html' }, query: { magic: 'https://cdn.example.com/' } }),
      res,
    )
    const html = res.sent.toString()
    assert.ok(html.indexOf('<!DOCTYPE html>') === 0)
    assert.ok(html.indexOf('href="https://cdn.example.com/"') !== -1)
    assert.ok(html.indexOf('<haxcms-print-theme>') !== -1)
    assert.ok(html.indexOf('window.__appCDN="https://cdn.example.com/"') !== -1)
    assert.ok(html.indexOf('First page <strong>bold</strong> content') !== -1)
  })

  test('an epub export answers an epub zip buffer', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExport(makeReq({ params: { format: 'epub' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'application/epub+zip')
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="demo.epub"')
    assert.ok(Buffer.isBuffer(res.sent))
    assert.equal(res.sent.slice(0, 2).toString(), 'PK')
    const zip = await JSZip.loadAsync(res.sent)
    const names = Object.keys(zip.files)
    assert.ok(
      names.some((name) => name.indexOf('first-page.xhtml') !== -1),
      'first page chapter present',
    )
    assert.ok(
      names.some((name) => name.indexOf('second-page.xhtml') !== -1),
      'second page chapter present',
    )
  })

  test('an epub ancestor filter drops unpublished branches', async (t) => {
    const site = makeFakeSite()
    site.manifest.items[1].metadata = { published: false }
    mockSite(t, site)
    const res = stubRes()
    await siteExport(
      makeReq({ params: { format: 'epub' }, query: { 'filter.ancestor': 'item-1' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const zip = await JSZip.loadAsync(res.sent)
    const names = Object.keys(zip.files)
    assert.ok(names.some((name) => name.indexOf('first-page.xhtml') !== -1))
    assert.equal(
      names.some((name) => name.indexOf('second-page.xhtml') !== -1),
      false,
      'unpublished page dropped from the epub',
    )
  })
})

// ---------------------------------------------------------------------------
// siteExportMutation
// ---------------------------------------------------------------------------
describe('exports routes — siteExportMutation', () => {
  test('an unresolvable site answers 404 and a bad format 400', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await siteExportMutation(makeReq({ params: { format: 'zip' } }), res)
    assert.equal(res.statusCode, 404)
    mockSite(t, makeFakeSite())
    const res2 = stubRes()
    await siteExportMutation(makeReq({ params: { format: 'rtf' } }), res2)
    assert.equal(res2.statusCode, 400)
    assert.equal(res2.body.data.message, 'Unsupported site export format "rtf"')
  })

  test('a supported format answers the export descriptor', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await siteExportMutation(makeReq({ params: { format: 'docx' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.format, 'docx')
    assert.equal(
      res.body.data.export.href,
      '/x/api/v1/site/export/docx',
    )
    assert.equal(res.body.data.links.site, '/x/api/v1/site')
  })
})

// ---------------------------------------------------------------------------
// itemExport
// ---------------------------------------------------------------------------
describe('exports routes — itemExport', () => {
  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'pdf' } }), res)
    assert.equal(res.statusCode, 404)
  })

  test('an unknown idOrSlug answers 404', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'ghost-page', format: 'pdf' } }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.data.message, 'Item not found for idOrSlug "ghost-page"')
  })

  test('an anonymous request for a hidden item answers 404', async (t) => {
    const site = makeFakeSite()
    site.manifest.items[0].metadata = { published: false }
    mockSite(t, site)
    const res = stubRes()
    await itemExport(
      makeReq({
        // no auth context: the site resolves through the referer instead
        headers: { referer: 'http://cms.example.com/_sites/demo/first-page' },
        params: { idOrSlug: 'first-page', format: 'pdf' },
        haxcmsSiteApiAuth: null,
      }),
      res,
    )
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.data.message, 'Item not found for idOrSlug "first-page"')
    // the same request for a published item still succeeds anonymously
    const resVisible = stubRes()
    await itemExport(
      makeReq({
        headers: { referer: 'http://cms.example.com/_sites/demo/first-page' },
        params: { idOrSlug: 'item-2', format: 'pdf' },
        haxcmsSiteApiAuth: null,
      }),
      resVisible,
    )
    assert.equal(resVisible.statusCode, 200)
  })

  test('an unsupported format answers 400', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'rtf' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Unsupported item export format "rtf"')
  })

  test('a pdf export downloads the converted buffer', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'pdf' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'application/pdf')
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="first-page.pdf"')
    assert.equal(res.sent.toString(), 'pdf-bytes')
  })

  test('a docx export downloads the converted buffer', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'item-2', format: 'docx' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.sent.toString(), 'docx-bytes')
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="second-page.docx"')
  })

  test('an item converter failure answers 502', async (t) => {
    mockSite(t, makeFakeSite())
    docxFixture = new Error('docx engine failed')
    t.after(() => {
      docxFixture = Buffer.from('docx-bytes')
    })
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'docx' } }), res)
    assert.equal(res.statusCode, 502)
    assert.equal(res.body.data.message, 'docx engine failed')
  })

  test('an html export downloads the item document', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'html' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8')
    const html = res.sent.toString()
    assert.ok(html.indexOf('<title>First Page</title>') !== -1)
    assert.ok(html.indexOf('<article data-haxcms-export="item"') !== -1)
    assert.ok(html.indexOf('<h1>First Page</h1>') !== -1)
    assert.ok(html.indexOf('First page <strong>bold</strong> content') !== -1)
  })

  test('an md export downloads the item markdown', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'md' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'text/markdown; charset=utf-8')
    const markdown = res.sent.toString()
    assert.ok(markdown.indexOf('# First Page') === 0)
    assert.ok(markdown.indexOf('**bold**') !== -1)
  })

  test('an epub export answers an epub zip buffer', async (t) => {
    mockSite(t, makeFakeSite())
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'epub' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'application/epub+zip')
    assert.ok(Buffer.isBuffer(res.sent))
    assert.equal(res.sent.slice(0, 2).toString(), 'PK')
  })

  test('json, yaml, and xml exports download the serialized record', async (t) => {
    mockSite(t, makeFakeSite())
    const formats = [
      { format: 'json', mediaType: 'application/json' },
      { format: 'yaml', mediaType: 'application/yaml' },
      { format: 'xml', mediaType: 'application/xml' },
    ]
    for (let i = 0; i < formats.length; i++) {
      const res = stubRes()
      await itemExport(
        makeReq({ params: { idOrSlug: 'first-page', format: formats[i].format } }),
        res,
      )
      assert.equal(res.statusCode, 200, 'format ' + formats[i].format)
      assert.equal(res.headers['Content-Type'], formats[i].mediaType)
      assert.equal(
        res.headers['Content-Disposition'],
        'attachment; filename="first-page.' + formats[i].format + '"',
      )
      const output = res.sent.toString()
      assert.ok(output.indexOf('first-page') !== -1, 'format ' + formats[i].format)
      assert.ok(output.indexOf('First page') !== -1, 'format ' + formats[i].format)
    }
  })

  test('an item with only an id still derives a download filename', async (t) => {
    const site = makeFakeSite()
    site.manifest.items.push({ id: 'item-9', metadata: {} })
    site.loadNode = (id) => (id === 'item-9' ? site.manifest.items[2] : null)
    mockSite(t, site)
    const res = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'item-9', format: 'md' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="item-9.md"')
  })

  test('a loadNode crash degrades each export format cleanly', async (t) => {
    const site = makeFakeSite()
    site.loadNode = () => {
      throw new Error('loadNode crashed')
    }
    mockSite(t, site)
    // document exports fail with the build error
    const resPdf = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'pdf' } }), resPdf)
    assert.equal(resPdf.statusCode, 500)
    assert.equal(
      resPdf.body.data.message,
      'Unable to build item export HTML: loadNode crashed',
    )
    const resHtml = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'html' } }), resHtml)
    assert.equal(resHtml.statusCode, 500)
    assert.equal(
      resHtml.body.data.message,
      'Unable to build item export HTML: loadNode crashed',
    )
    // markdown degrades to the empty page content
    const resMd = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'md' } }), resMd)
    assert.equal(resMd.statusCode, 200)
    assert.equal(resMd.sent.toString().trim(), '# First Page')
    // epub and record exports fail with their own caught errors
    const resEpub = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'epub' } }), resEpub)
    assert.equal(resEpub.statusCode, 502)
    assert.equal(resEpub.body.data.message, 'loadNode crashed')
    const resJson = stubRes()
    await itemExport(makeReq({ params: { idOrSlug: 'first-page', format: 'json' } }), resJson)
    assert.equal(resJson.statusCode, 500)
    assert.equal(
      resJson.body.data.message,
      'Unable to build item export record: loadNode crashed',
    )
  })
})
