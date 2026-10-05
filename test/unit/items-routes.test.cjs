'use strict'

// Direct handler tests for src/siteRoutes/v1/items.js:
//   listItems, itemDetail, updateItem, createItem, deleteItem
//
// Site resolution runs through the real resolveSiteForRequest with
// HAXCMS.loadSite mocked per test (auth-context siteName, save-settings
// pattern). updateItem runs the real applyNodeDetailOperation against the
// fake site; createItem/deleteItem delegate into the real createNode /
// deleteNode routes with HAXCMS.recurseCopy mocked so no boilerplate is
// copied to disk.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const {
  listItems,
  itemDetail,
  updateItem,
  createItem,
  deleteItem,
} = require('../../src/siteRoutes/v1/items.js')

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
    originalUrl: '/_sites/demo/x/api/v1/items',
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'tester',
      siteName: 'demo',
    },
  }
  return Object.assign(req, overrides || {})
}

// fake site: three pages (one hidden, one unpublished), ordered like the tree
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
      metadata: {
        published: true,
        tags: ['alpha'],
        region: 'header',
        created: 1700000000,
        updated: 1700000000,
      },
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
      metadata: { published: false, tags: ['beta'] },
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
      metadata: { hideInMenu: true, pageType: 'two-col' },
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
    deleteNode: [],
    addItem: [],
    saveCalls: [],
  }
  const site = {
    siteDirectory: '/tmp/demo',
    name: 'demo',
    calls: calls,
    contents: contents,
    manifest: {
      items: items,
      orderTree(list) {
        return list.slice().sort((a, b) => a.order - b.order)
      },
      addItem(item) {
        calls.addItem.push(item)
        items.push(item)
        return items.length
      },
      metadata: {
        site: { name: 'demo', settings: { lang: 'es' }, updated: 1700000000 },
        theme: {},
      },
      async save(reorder) {
        calls.saveCalls.push(typeof reorder === 'boolean' ? reorder : true)
      },
    },
    loadNode(id) {
      for (let i = 0; i < items.length; i++) {
        if (items[i] && items[i].id === id) {
          return items[i]
        }
      }
      return null
    },
    async getPageContent(page) {
      return contents[page.id] !== undefined ? contents[page.id] : ''
    },
    async writePageAlternateFormats() {
      calls.writePageAlternateFormats++
    },
    updateAlternateFormats() {
      calls.updateAlternateFormats++
    },
    async gitCommit(message) {
      calls.gitCommits.push(message)
    },
    async deleteNode(page) {
      calls.deleteNode.push(page.id)
      const index = items.indexOf(page)
      if (index !== -1) {
        items.splice(index, 1)
      }
      return true
    },
  }
  return Object.assign(site, overrides || {})
}

function mockSite(t, site) {
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// ---------------------------------------------------------------------------
// listItems
// ---------------------------------------------------------------------------
describe('items routes — listItems', () => {
  test('lists ordered summaries with navigation links for authenticated access', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await listItems(makeReq(), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.count, 3)
    assert.equal(res.body.data.total, 3)
    assert.equal(res.body.data.links.self, '/_sites/demo/x/api/v1/items')
    const records = res.body.data.items
    assert.equal(records[0].id, 'item-1')
    assert.equal(records[0].title, 'First Page')
    assert.equal(records[0].links.self, '/_sites/demo/x/api/v1/items/first-page')
    // a root page has no parent link key at all
    assert.equal(records[0].links.parent, undefined)
    assert.equal(
      records[0].links.children,
      '/_sites/demo/x/api/v1/items?filter.parent=item-1',
    )
    // second page links previous/next/parent navigation
    assert.equal(
      records[1].links.previous,
      '/_sites/demo/x/api/v1/items/first-page',
    )
    assert.equal(records[1].links.next, '/_sites/demo/x/api/v1/items/third-page')
    assert.equal(records[1].links.parent, '/_sites/demo/x/api/v1/items/first-page')
    // exports links ride along on every record
    assert.equal(
      records[0].exports.pdf,
      '/_sites/demo/x/api/v1/items/first-page/export/pdf',
    )
    assert.equal(records[0].links.haxElementSchema.indexOf('include=haxElementSchema') !== -1, true)
  })

  test('anonymous access only lists published, visible pages', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await listItems(makeReq({ haxcmsSiteApiAuth: null }), res)
    assert.equal(res.statusCode, 200)
    // item-2 is unpublished and item-3 is hidden from the menu
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.items[0].id, 'item-1')
  })

  test('filters apply for parent, tags, published, pageType, and region', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const cases = [
      { query: { 'filter.parent': 'item-1' }, expected: ['item-2', 'item-3'] },
      { query: { 'filter.tags': 'beta' }, expected: ['item-2'] },
      { query: { 'filter.published': 'false' }, expected: ['item-2'] },
      { query: { 'filter.pageType': 'two-col' }, expected: ['item-3'] },
      { query: { 'filter.region': 'header' }, expected: ['item-1'] },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await listItems(makeReq({ query: cases[i].query }), res)
      assert.equal(res.statusCode, 200, 'case ' + i)
      assert.deepEqual(
        res.body.data.items.map((item) => item.id),
        cases[i].expected,
        'case ' + i,
      )
    }
  })

  test('sort, paging, and field projection combine', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await listItems(
      makeReq({
        query: { sort: '-order', 'page.limit': '1', 'page.offset': '1', fields: 'id,title' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.page.limit, 1)
    assert.equal(res.body.data.page.offset, 1)
    assert.equal(res.body.data.page.total, 3)
    assert.equal(res.body.data.items[0].id, 'item-2')
    assert.deepEqual(Object.keys(res.body.data.items[0]).sort(), ['id', 'title'])
  })

  test('include=content, haxElementSchema, and jsonld hydrate records', async (t) => {
    const site = makeFakeSite()
    site.contents['item-1'] =
      '<p>first page content</p><video-player source="https://example.com/v.mp4"></video-player>'
    mockSite(t, site)
    const res = stubRes()
    await listItems(
      makeReq({ query: { include: 'content,haxElementSchema,jsonld' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const first = res.body.data.items.filter((item) => item.id === 'item-1')[0]
    assert.ok(first.content.indexOf('first page content') !== -1)
    const schemaTags = first.haxElementSchema.map((node) => node.tag)
    assert.deepEqual(schemaTags, ['p', 'video-player'])
    assert.equal(
      first.haxElementSchema[1].properties.source,
      'https://example.com/v.mp4',
    )
    assert.equal(first.jsonld['@type'], 'WebPage')
    assert.equal(first.jsonld.name, 'First Page')
    assert.equal(first.jsonld.inLanguage, 'es')
    assert.equal(first.jsonld.identifier, 'item-1')
    assert.deepEqual(first.jsonld.keywords, ['alpha'])
    assert.equal(first.jsonld.datePublished, '2023-11-14T22:13:20.000Z')
    assert.equal(first.jsonld.dateModified, '2023-11-14T22:13:20.000Z')
  })

  test('an html format request sends the serialized representation', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await listItems(makeReq({ query: { format: 'html' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, null)
    assert.equal(typeof res.sent, 'string')
    assert.ok(res.sent.indexOf('First Page') !== -1)
    assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8')
  })

  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await listItems(makeReq(), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/items',
    )
  })
})

// ---------------------------------------------------------------------------
// itemDetail
// ---------------------------------------------------------------------------
describe('items routes — itemDetail', () => {
  test('answers the hydrated detail record with navigation and jsonld', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await itemDetail(makeReq({ params: { idOrSlug: 'second-page' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    const data = res.body.data
    assert.equal(data.id, 'item-2')
    assert.equal(data.title, 'Second Page')
    assert.equal(data.parent, 'item-1')
    assert.equal(data.links.parent, '/_sites/demo/x/api/v1/items/first-page')
    assert.equal(data.links.next, '/_sites/demo/x/api/v1/items/third-page')
    assert.equal(data.jsonld['@type'], 'WebPage')
    assert.equal(data.jsonld.name, 'Second Page')
    assert.equal(data.exports.docx, '/_sites/demo/x/api/v1/items/second-page/export/docx')
  })

  test('include=content hydrates the page body', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await itemDetail(
      makeReq({ params: { idOrSlug: 'first-page' }, query: { include: 'content' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.data.content.indexOf('first page content') !== -1)
  })

  test('unknown items and anonymous hidden items answer 404', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const resUnknown = stubRes()
    await itemDetail(makeReq({ params: { idOrSlug: 'ghost-page' } }), resUnknown)
    assert.equal(resUnknown.statusCode, 404)
    assert.equal(resUnknown.body.data.message, 'Item not found for idOrSlug "ghost-page"')
    const resHidden = stubRes()
    await itemDetail(
      makeReq({ params: { idOrSlug: 'second-page' }, haxcmsSiteApiAuth: null }),
      resHidden,
    )
    assert.equal(resHidden.statusCode, 404)
    assert.equal(resHidden.body.data.message, 'Item not found for idOrSlug "second-page"')
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await itemDetail(makeReq({ params: { idOrSlug: 'first-page' } }), resNoSite)
    assert.equal(resNoSite.statusCode, 404)
    assert.equal(
      resNoSite.body.data.message,
      'Unable to resolve site context for /x/api/v1/items/:idOrSlug',
    )
  })

  test('fields projection applies to the detail record', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await itemDetail(
      makeReq({ params: { idOrSlug: 'first-page' }, query: { fields: 'id,title' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(Object.keys(res.body.data).sort(), ['id', 'title'])
  })
})

// ---------------------------------------------------------------------------
// updateItem
// ---------------------------------------------------------------------------
describe('items routes — updateItem', () => {
  test('an unauthenticated request answers 403', async (t) => {
    const res = stubRes()
    await updateItem(
      makeReq({ params: { idOrSlug: 'first-page' }, haxcmsSiteApiAuth: null }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, 403)
    assert.equal(
      res.body.data.message,
      'Authenticated site access is required for this endpoint',
    )
  })

  test('an unresolvable site or unknown item answers 404, and a missing operation 400', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await updateItem(makeReq({ params: { idOrSlug: 'first-page' } }), resNoSite, () => {})
    assert.equal(resNoSite.statusCode, 404)
    const site = makeFakeSite()
    mockSite(t, site)
    const resUnknown = stubRes()
    await updateItem(makeReq({ params: { idOrSlug: 'ghost' } }), resUnknown, () => {})
    assert.equal(resUnknown.statusCode, 404)
    const resNoOperation = stubRes()
    await updateItem(makeReq({ params: { idOrSlug: 'first-page' } }), resNoOperation, () => {})
    assert.equal(resNoOperation.statusCode, 400)
    assert.equal(resNoOperation.body.data.message, 'Operation is required')
  })

  test('a setTitle operation updates the page and answers the record', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await updateItem(
      makeReq({
        params: { idOrSlug: 'first-page' },
        body: { operation: 'setTitle', title: 'Renamed Page' },
      }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.title, 'Renamed Page')
    assert.equal(site.manifest.items[0].title, 'Renamed Page')
    assert.deepEqual(site.calls.saveCalls, [false])
    assert.equal(site.calls.updateAlternateFormats, 1)
    assert.deepEqual(site.calls.gitCommits, [
      'Node operation: setTitle on Renamed Page (item-1)',
    ])
  })

  test('an unloaded node during the operation answers its status error', async (t) => {
    const site = makeFakeSite()
    site.loadNode = () => null
    mockSite(t, site)
    const res = stubRes()
    await updateItem(
      makeReq({
        params: { idOrSlug: 'first-page' },
        body: { operation: 'setTitle', title: 'Nope' },
      }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.data.message, 'Node not found')
  })

  test('a disabled outline feature answers the feature-disabled 403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { outlineDesigner: false } }
    mockSite(t, site)
    const res = stubRes()
    await updateItem(
      makeReq({
        params: { idOrSlug: 'first-page' },
        body: { operation: 'setTitle', title: 'Nope' },
      }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Outline operations are disabled for this site')
  })
})

// ---------------------------------------------------------------------------
// createItem (delegates to createNode)
// ---------------------------------------------------------------------------
describe('items routes — createItem', () => {
  function makeCreateSite(t) {
    const site = makeFakeSite()
    site.itemFromParams = (params) => ({
      id: 'item-new',
      title: params.node.title,
      slug: 'new-page',
      parent: null,
      indent: 0,
      order: 3,
      location: 'pages/item-new/index.html',
      metadata: {},
    })
    t.mock.method(HAXCMS, 'recurseCopy', async () => {})
    return site
  }

  test('answers 404 without a site, 400 without a name, 403 without a token', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await createItem(makeReq({ body: { node: { title: 'X' } } }), resNoSite, () => {})
    assert.equal(resNoSite.statusCode, 404)
    const site = makeFakeSite()
    site.manifest.metadata.site = {}
    mockSite(t, site)
    const resNoName = stubRes()
    await createItem(makeReq({ body: { node: { title: 'X' } } }), resNoName, () => {})
    assert.equal(resNoName.statusCode, 400)
    assert.equal(
      resNoName.body.data.message,
      'Unable to resolve site name for create item operation',
    )
    const site2 = makeFakeSite()
    mockSite(t, site2)
    const resNoToken = stubRes()
    await createItem(makeReq({ headers: {}, body: { node: { title: 'X' } } }), resNoToken, () => {})
    assert.equal(resNoToken.statusCode, 403)
  })

  test('a request without a node or items payload answers 400', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await createItem(makeReq({ body: {} }), res, () => {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Node payload is required')
    const resEmptyItems = stubRes()
    await createItem(makeReq({ body: { items: [] } }), resEmptyItems, () => {})
    assert.equal(resEmptyItems.statusCode, 400)
  })

  test('a node payload delegates to createNode and returns the new item', async (t) => {
    const site = makeCreateSite(t)
    mockSite(t, site)
    const res = stubRes()
    await createItem(
      makeReq({ body: { site: { name: 'demo' }, node: { title: 'Brand New Page' } } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.id, 'item-new')
    assert.equal(res.sent.data.title, 'Brand New Page')
    assert.equal(site.calls.addItem.length, 1)
    assert.equal(site.calls.writePageAlternateFormats, 1)
    assert.equal(site.calls.updateAlternateFormats, 1)
    assert.ok(site.calls.gitCommits[0].indexOf('Page added:Brand New Page') === 0)
  })
})

// ---------------------------------------------------------------------------
// deleteItem (delegates to deleteNode)
// ---------------------------------------------------------------------------
describe('items routes — deleteItem', () => {
  test('answers 404 without a site or unknown item, 400 without a name, 403 without a token', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await deleteItem(makeReq({ params: { idOrSlug: 'first-page' } }), resNoSite, () => {})
    assert.equal(resNoSite.statusCode, 404)
    const site = makeFakeSite()
    mockSite(t, site)
    const resUnknown = stubRes()
    await deleteItem(makeReq({ params: { idOrSlug: 'ghost' } }), resUnknown, () => {})
    assert.equal(resUnknown.statusCode, 404)
    const siteNoName = makeFakeSite()
    siteNoName.manifest.metadata.site = {}
    mockSite(t, siteNoName)
    const resNoName = stubRes()
    await deleteItem(makeReq({ params: { idOrSlug: 'first-page' } }), resNoName, () => {})
    assert.equal(resNoName.statusCode, 400)
    assert.equal(
      resNoName.body.data.message,
      'Unable to resolve site name for delete item operation',
    )
    const site2 = makeFakeSite()
    mockSite(t, site2)
    const resNoToken = stubRes()
    await deleteItem(makeReq({ params: { idOrSlug: 'first-page' }, headers: {} }), resNoToken, () => {})
    assert.equal(resNoToken.statusCode, 403)
  })

  test('a confirmed delete delegates to deleteNode with the item id injected', async (t) => {
    const site = makeFakeSite()
    mockSite(t, site)
    const res = stubRes()
    await deleteItem(makeReq({ params: { idOrSlug: 'second-page' } }), res, () => {})
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.id, 'item-2')
    assert.deepEqual(site.calls.deleteNode, ['item-2'])
    assert.deepEqual(site.calls.gitCommits, ['Page deleted: Second Page (item-2)'])
    // the deleted page is gone from the outline
    assert.equal(site.manifest.items.length, 2)
  })
})
