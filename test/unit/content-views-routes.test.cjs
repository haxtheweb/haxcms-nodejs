'use strict'

// Direct handler unit tests for two site route modules:
//   src/siteRoutes/v1/content.js (listContent, contentDetail, updateContent,
//     replaceContent — the update/replace wrappers delegate into the real
//     saveNode/siteSearch routes under mocked site auth, matching the
//     save-settings-routes.test.cjs fixture shapes)
//   src/siteRoutes/v1/views.js (listViews, viewDetail, viewResults,
//     listDisplays, displayResults — stored views, default views, and the
//     items/tags/search result sources with anonymous visibility filtering)
//
// Site resolution runs through the real resolveSiteForRequest with
// HAXCMS.loadSite mocked per test (auth-context siteName).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const FileContentScanner = require('../../src/lib/FileContentScanner.js')
const {
  listContent,
  contentDetail,
  updateContent,
  replaceContent,
} = require('../../src/siteRoutes/v1/content.js')
const {
  listViews,
  viewDetail,
  viewResults,
  listDisplays,
  displayResults,
} = require('../../src/siteRoutes/v1/views.js')

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
    headers: { 'x-haxcms-site-token': 'token' },
    query: {},
    params: {},
    body: {},
    originalUrl: '/_sites/demo/x/api/v1/content',
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'tester',
      siteName: 'demo',
    },
  }
  return Object.assign(req, overrides || {})
}

// fake site: three pages (one hidden, one unpublished) with contents
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
      metadata: { published: true, tags: ['alpha'] },
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
      metadata: { published: false, tags: ['beta', 'alpha'] },
    },
    {
      id: 'item-3',
      title: 'Third Page',
      slug: 'third-page',
      parent: 'item-1',
      indent: 1,
      order: 2,
      location: 'pages/item-3/index.html',
      description: 'The third',
      metadata: { hideInMenu: true },
    },
  ]
  const contents = {
    'item-1': '<p>first page content</p>',
    'item-2': '<p>second page content</p>',
    'item-3': '<p>third page content</p>',
  }
  const calls = {
    gitCommits: [],
    updateAlternateFormats: 0,
    writePageAlternateFormats: 0,
    updateNode: 0,
    saveCalls: [],
  }
  const page = {
    id: 'item-1',
    title: 'First Page',
    slug: 'first-page',
    parent: null,
    location: 'pages/item-1/index.html',
    description: '',
    metadata: {},
    writeCalls: [],
    async writeLocation(content, dir) {
      page.writeCalls.push({ content: content, dir: dir })
      return 12
    },
  }
  const site = {
    siteDirectory: '/tmp/demo',
    name: 'demo',
    calls: calls,
    contents: contents,
    page: page,
    manifest: {
      items: items,
      orderTree(list) {
        return list.slice().sort((a, b) => a.order - b.order)
      },
      metadata: {
        site: {
          name: 'demo',
          settings: { lang: 'es' },
          updated: 1700000000,
        },
      },
      async save(reorder) {
        calls.saveCalls.push(typeof reorder === 'boolean' ? reorder : true)
      },
    },
    loadNode(id) {
      if (id === 'item-1') {
        return page
      }
      for (let i = 0; i < items.length; i++) {
        if (items[i].id === id) {
          return items[i]
        }
      }
      return null
    },
    async getPageContent(target) {
      return contents[target.id] !== undefined ? contents[target.id] : ''
    },
    async writePageAlternateFormats() {
      calls.writePageAlternateFormats++
    },
    updateAlternateFormats() {
      calls.updateAlternateFormats++
    },
    async updateNode() {
      calls.updateNode++
    },
    async gitCommit(message) {
      calls.gitCommits.push(message)
    },
  }
  return Object.assign(site, overrides || {})
}

function mockSiteAuth(t, site) {
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// ---------------------------------------------------------------------------
// content.js — listContent / contentDetail
// ---------------------------------------------------------------------------
describe('content routes — listContent', () => {
  test('lists bundle records with page links', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await listContent(makeReq(), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.mode, 'bundle')
    assert.equal(res.body.data.count, 3)
    const record = res.body.data.content[0]
    assert.equal(record.id, 'item-1')
    assert.equal(record.format, 'html')
    assert.ok(record.body.indexOf('first page content') !== -1)
    assert.equal(record.links.self, '/_sites/demo/x/api/v1/content/first-page')
    assert.equal(record.links.page, '/demo/first-page')
    assert.equal(record.links.md, '/demo/first-page.md')
    assert.equal(res.body.data.links.self, '/_sites/demo/x/api/v1/content')
  })

  test('concat mode answers markdown content and html representations', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await listContent(makeReq({ query: { mode: 'concat' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.mode, 'concat')
    assert.ok(res.body.data.content.indexOf('# First Page') !== -1)
    assert.ok(res.body.data.content.indexOf('first page content') !== -1)
    // the md raw representation is the same markdown
    const resMd = stubRes()
    await listContent(makeReq({ query: { mode: 'concat', format: 'md' } }), resMd)
    assert.equal(resMd.statusCode, 200)
    assert.equal(typeof resMd.sent, 'string')
    assert.ok(resMd.sent.indexOf('# First Page') !== -1)
    // the html raw representation carries escaped article wrappers
    const resHtml = stubRes()
    await listContent(makeReq({ query: { mode: 'concat', format: 'html' } }), resHtml)
    assert.equal(typeof resHtml.sent, 'string')
    assert.ok(resHtml.sent.indexOf('<h2>First Page</h2>') !== -1)
    assert.ok(resHtml.sent.indexOf('first page content') !== -1)
  })

  test('anonymous access only lists published, visible pages', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await listContent(makeReq({ haxcmsSiteApiAuth: null }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.content[0].id, 'item-1')
  })

  test('sort, paging, and field projection combine', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await listContent(
      makeReq({
        query: { sort: '-order', 'page.limit': '1', 'page.offset': '1', fields: 'id,title' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.page.offset, 1)
    assert.equal(res.body.data.content[0].id, 'item-2')
    assert.deepEqual(Object.keys(res.body.data.content[0]).sort(), ['id', 'title'])
  })

  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await listContent(makeReq(), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/content',
    )
  })
})

describe('content routes — contentDetail', () => {
  test('answers the page record with links and fields projection', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await contentDetail(makeReq({ params: { idOrSlug: 'second-page' } }), res)
    assert.equal(res.statusCode, 200)
    const data = res.body.data
    assert.equal(data.id, 'item-2')
    assert.equal(data.mode, 'bundle')
    assert.ok(data.body.indexOf('second page content') !== -1)
    assert.equal(data.links.page, '/demo/second-page')
    const resFields = stubRes()
    await contentDetail(
      makeReq({ params: { idOrSlug: 'second-page' }, query: { fields: 'id,body' } }),
      resFields,
    )
    assert.deepEqual(Object.keys(resFields.body.data).sort(), ['body', 'id'])
  })

  test('unknown and anonymously hidden pages answer 404', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const resUnknown = stubRes()
    await contentDetail(makeReq({ params: { idOrSlug: 'ghost' } }), resUnknown)
    assert.equal(resUnknown.statusCode, 404)
    assert.equal(
      resUnknown.body.data.message,
      'Content not found for idOrSlug "ghost"',
    )
    const resHidden = stubRes()
    await contentDetail(
      makeReq({ params: { idOrSlug: 'second-page' }, haxcmsSiteApiAuth: null }),
      resHidden,
    )
    assert.equal(resHidden.statusCode, 404)
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await contentDetail(makeReq({ params: { idOrSlug: 'first-page' } }), resNoSite)
    assert.equal(resNoSite.statusCode, 404)
  })
})

// ---------------------------------------------------------------------------
// content.js — updateContent (delegates to saveNode)
// ---------------------------------------------------------------------------
describe('content routes — updateContent', () => {
  function mockNodeExtras(t, site) {
    t.mock.method(FileContentScanner, 'rebuildPageFilesUuids', async () => {})
    t.mock.method(HAXCMS, 'recurseCopy', async () => {})
  }

  test('answers 404 without a site or unknown item, 400 without a name or body', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await updateContent(
      makeReq({ params: { idOrSlug: 'first-page' }, body: { body: '<p>x</p>' } }),
      resNoSite,
      () => {},
    )
    assert.equal(resNoSite.statusCode, 404)
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    mockNodeExtras(t, site)
    const resUnknown = stubRes()
    await updateContent(
      makeReq({ params: { idOrSlug: 'ghost' }, body: { body: '<p>x</p>' } }),
      resUnknown,
      () => {},
    )
    assert.equal(resUnknown.statusCode, 404)
    const resNoBody = stubRes()
    await updateContent(makeReq({ params: { idOrSlug: 'first-page' } }), resNoBody, () => {})
    assert.equal(resNoBody.statusCode, 400)
    assert.equal(resNoBody.body.data.message, 'Content body is required')
    const siteNoName = makeFakeSite()
    siteNoName.manifest.metadata.site = {}
    mockSiteAuth(t, siteNoName)
    const resNoName = stubRes()
    await updateContent(
      makeReq({ params: { idOrSlug: 'first-page' }, body: { body: '<p>x</p>' } }),
      resNoName,
      () => {},
    )
    assert.equal(resNoName.statusCode, 400)
    assert.equal(
      resNoName.body.data.message,
      'Unable to resolve site name for content update operation',
    )
    const site2 = makeFakeSite()
    mockSiteAuth(t, site2)
    const resNoToken = stubRes()
    await updateContent(
      makeReq({
        params: { idOrSlug: 'first-page' },
        headers: {},
        body: { body: '<p>x</p>' },
      }),
      resNoToken,
      () => {},
    )
    assert.equal(resNoToken.statusCode, 403)
  })

  test('a body payload delegates to saveNode with the node body injected', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    mockNodeExtras(t, site)
    const res = stubRes()
    await updateContent(
      makeReq({
        params: { idOrSlug: 'first-page' },
        body: {
          body: '<page-break title="New Title"></page-break><p>updated body</p>',
          schema: [{ tag: 'img', properties: { src: 'x.png' } }],
        },
      }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    // saveNode answers through res.send
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.title, 'New Title')
    assert.equal(site.page.writeCalls.length, 1)
    assert.ok(site.page.writeCalls[0].content.indexOf('updated body') !== -1)
  })

  test('body.content and body.node.body payload shapes are accepted', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    mockNodeExtras(t, site)
    const resContent = stubRes()
    await updateContent(
      makeReq({
        params: { idOrSlug: 'first-page' },
        body: { content: '<page-break title="Via Content"></page-break><p>a</p>' },
      }),
      resContent,
      () => {},
    )
    assert.equal(resContent.sent.status, 200)
    assert.equal(site.page.title, 'Via Content')
    const resNode = stubRes()
    await updateContent(
      makeReq({
        params: { idOrSlug: 'first-page' },
        body: {
          node: { body: '<page-break title="Via Node"></page-break><p>b</p>' },
        },
      }),
      resNode,
      () => {},
    )
    assert.equal(resNode.sent.status, 200)
    assert.equal(site.page.title, 'Via Node')
  })
})

// ---------------------------------------------------------------------------
// content.js — replaceContent (delegates to siteSearch replace)
// ---------------------------------------------------------------------------
describe('content routes — replaceContent', () => {
  test('answers 404/400/403 on the shared gates', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await replaceContent(makeReq(), resNoSite, () => {})
    assert.equal(resNoSite.statusCode, 404)
    const siteNoName = makeFakeSite()
    siteNoName.manifest.metadata.site = {}
    mockSiteAuth(t, siteNoName)
    const resNoName = stubRes()
    await replaceContent(makeReq(), resNoName, () => {})
    assert.equal(resNoName.statusCode, 400)
    assert.equal(
      resNoName.body.data.message,
      'Unable to resolve site name for content replace operation',
    )
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const resNoToken = stubRes()
    await replaceContent(makeReq({ headers: {} }), resNoToken, () => {})
    assert.equal(resNoToken.statusCode, 403)
  })

  test('delegates to the siteSearch replace operation', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await replaceContent(
      makeReq({
        body: { search: 'first page', replace: 'gem', replaceConfirm: true },
      }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.operation, 'replace')
    assert.equal(res.sent.data.updatedItems, 1)
    assert.ok(site.page.writeCalls[0].content.indexOf('<p>gem content</p>') !== -1)
  })

  test('an empty operation is normalized to replace before delegating', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await replaceContent(
      makeReq({
        body: {
          operation: '  ',
          search: 'first page',
          replace: 'gem',
          replaceConfirm: true,
        },
      }),
      res,
      () => {},
    )
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.operation, 'replace')
  })
})

// ---------------------------------------------------------------------------
// views.js
// ---------------------------------------------------------------------------
describe('views routes', () => {
  test('listViews answers the default view set when none are stored', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await listViews(makeReq({ originalUrl: '/_sites/demo/x/api/v1/views' }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.deepEqual(
      res.body.data.views.map((view) => view.id),
      ['recent', 'search', 'tags'],
    )
    assert.equal(res.body.data.views[0].title, 'Recent content')
    assert.equal(
      res.body.data.views[0].links.results,
      '/_sites/demo/x/api/v1/views/recent/results',
    )
    assert.equal(res.body.data.links.self, '/_sites/demo/x/api/v1/views')
  })

  test('stored views and displays are listed with sort and paging', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site.views = [
      { id: 'zeta', title: 'Zeta View', query: { source: 'items' } },
      { id: 'alpha', title: 'Alpha View', display: { type: 'grid' } },
      { viewId: 'by-view-id', title: 'By View Id' },
    ]
    mockSiteAuth(t, site)
    const res = stubRes()
    await listViews(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views',
        query: { sort: 'id', 'page.limit': '2' },
      }),
      res,
    )
    assert.deepEqual(
      res.body.data.views.map((view) => view.id),
      ['alpha', 'by-view-id'],
    )
    assert.equal(res.body.data.total, 3)
    // the legacy displays array is used when views is absent
    const siteDisplays = makeFakeSite()
    siteDisplays.manifest.metadata.site.displays = [
      { id: 'legacy', title: 'Legacy Display' },
    ]
    mockSiteAuth(t, siteDisplays)
    const resDisplays = stubRes()
    await listDisplays(makeReq({ originalUrl: '/_sites/demo/x/api/v1/views' }), resDisplays)
    assert.deepEqual(
      resDisplays.body.data.views.map((view) => view.id),
      ['legacy'],
    )
  })

  test('viewDetail answers a stored view and 404s for unknown ids', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site.views = [
      { id: 'zeta', title: 'Zeta View', query: { source: 'items' } },
    ]
    mockSiteAuth(t, site)
    const res = stubRes()
    await viewDetail(
      makeReq({ originalUrl: '/_sites/demo/x/api/v1/views/zeta', params: { viewId: 'zeta' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.id, 'zeta')
    assert.equal(res.body.data.display.type, 'list')
    const resUnknown = stubRes()
    await viewDetail(
      makeReq({ originalUrl: '/_sites/demo/x/api/v1/views/ghost', params: { viewId: 'ghost' } }),
      resUnknown,
    )
    assert.equal(resUnknown.statusCode, 404)
    assert.equal(resUnknown.body.data.message, 'View "ghost" not found')
    const resBlank = stubRes()
    await viewDetail(
      makeReq({ originalUrl: '/_sites/demo/x/api/v1/views/%20', params: { viewId: ' ' } }),
      resBlank,
    )
    assert.equal(resBlank.statusCode, 404)
    assert.equal(resBlank.body.data.message, 'View not found')
  })

  test('viewResults answers the items source with sort, paging, and fields', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site.views = [
      { id: 'all-pages', title: 'All Pages', query: { source: 'items', sort: 'title' } },
    ]
    mockSiteAuth(t, site)
    const res = stubRes()
    await viewResults(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views/all-pages/results',
        params: { viewId: 'all-pages' },
        query: { 'page.limit': '2', fields: 'id,title' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 2)
    assert.equal(res.body.data.view.id, 'all-pages')
    const results = res.body.data.results
    assert.deepEqual(
      results.map((result) => result.title),
      ['First Page', 'Second Page'],
    )
    assert.deepEqual(Object.keys(results[0]).sort(), ['id', 'title'])
  })

  test('viewResults answers the tags source with counts', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site.views = [
      { id: 'all-tags', title: 'All Tags', query: { source: 'tags' } },
    ]
    mockSiteAuth(t, site)
    const res = stubRes()
    await viewResults(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views/all-tags/results',
        params: { viewId: 'all-tags' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data.results, [
      { tag: 'alpha', count: 2 },
      { tag: 'beta', count: 1 },
    ])
    // anonymous callers only see tags from visible pages
    const resAnonymous = stubRes()
    await viewResults(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views/all-tags/results',
        params: { viewId: 'all-tags' },
        haxcmsSiteApiAuth: null,
      }),
      resAnonymous,
    )
    assert.deepEqual(resAnonymous.body.data.results, [{ tag: 'alpha', count: 1 }])
  })

  test('viewResults answers the search source and empty queries', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site.views = [
      { id: 'find', title: 'Find', query: { source: 'search', q: 'third' } },
    ]
    mockSiteAuth(t, site)
    const res = stubRes()
    await viewResults(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views/find/results',
        params: { viewId: 'find' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.results[0].id, 'item-3')
    // a request q overrides the stored query
    const resQuery = stubRes()
    await viewResults(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views/find/results',
        params: { viewId: 'find' },
        query: { q: 'second' },
      }),
      resQuery,
    )
    assert.equal(resQuery.body.data.results[0].id, 'item-2')
    // an empty query answers empty results
    const siteEmpty = makeFakeSite()
    siteEmpty.manifest.metadata.site.views = [
      { id: 'find', title: 'Find', query: { source: 'search', q: '' } },
    ]
    mockSiteAuth(t, siteEmpty)
    const resEmpty = stubRes()
    await viewResults(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views/find/results',
        params: { viewId: 'find' },
      }),
      resEmpty,
    )
    assert.deepEqual(resEmpty.body.data.results, [])
    assert.equal(resEmpty.body.data.count, 0)
  })

  test('displayResults mirrors viewResults', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site.views = [
      { id: 'all-pages', title: 'All Pages', query: { source: 'items' } },
    ]
    mockSiteAuth(t, site)
    const res = stubRes()
    await displayResults(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/views/all-pages/results',
        params: { viewId: 'all-pages' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 3)
  })
})
