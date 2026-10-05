'use strict'

// Direct handler unit tests for three site route modules:
//   src/siteRoutes/v1/schemas.js (schemas — descriptor list, kind filters,
//     webcomponent haxProperties loading through a temp siteDirectory
//     node_modules-style search root with HAXCMS.getWCRegistryJson mocked)
//   src/siteRoutes/v1/blocks.js (listBlocks, blockDetail, blockUsage —
//     usage from real page content, autoloader + enabledBlocks settings,
//     registry imports/packages, unknown-block 404s)
//   src/siteRoutes/v1/reports.js (listReports, reportDetail — JOSHelpers
//     stubbed at the module boundary BEFORE reports.js is required, with
//     fixture contentData/linkData/mediaData driving the annotation loops)
//
// Site resolution runs through the real resolveSiteForRequest with
// HAXCMS.loadSite mocked per test (auth-context siteName).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

// stub JOSHelpers at the module boundary before reports.js binds them
const josHelpers = require('../../src/lib/JOSHelpers.js')
let courseStatsFixture = {}
let siteHtmlFixture = ''
josHelpers.courseStatsFromOutline = async () => courseStatsFixture
josHelpers.siteHTMLContent = async () => siteHtmlFixture

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const schemasRoute = require('../../src/siteRoutes/v1/schemas.js')
const {
  listBlocks,
  blockDetail,
  blockUsage,
} = require('../../src/siteRoutes/v1/blocks.js')
const {
  listReports,
  reportDetail,
} = require('../../src/siteRoutes/v1/reports.js')

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

function makeReq(overrides) {
  const req = {
    headers: {},
    query: {},
    params: {},
    body: {},
    originalUrl: '/_sites/demo/x/api/v1/schemas',
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'tester',
      siteName: 'demo',
    },
  }
  return Object.assign(req, overrides || {})
}

// fake site with real page contents for usage scanning
function makeFakeSite(t, overrides) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schemas-routes-'))
  const siteDirectory = path.join(tmpRoot, 'demo')
  t.after(() => {
    fs.removeSync(tmpRoot)
  })
  const items = [
    {
      id: 'item-1',
      title: 'First Page',
      slug: 'first-page',
      parent: null,
      indent: 0,
      order: 0,
      location: 'pages/item-1/index.html',
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
      metadata: { hideInMenu: true },
    },
  ]
  const contents = {
    'item-1': '<p>text</p><video-player source="one.mp4"></video-player><my-widget value="a"></my-widget>',
    'item-2': '<p>more</p><video-player source="two.mp4"></video-player>',
  }
  const site = {
    siteDirectory: siteDirectory,
    name: 'demo',
    manifest: {
      items: items,
      orderTree(list) {
        return list.slice().sort((a, b) => a.order - b.order)
      },
      getItemById(id) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].id === id) {
            return items[i]
          }
        }
        return false
      },
      metadata: {
        site: { name: 'demo', settings: { lang: 'es' } },
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
    async getPageContent(target) {
      return contents[target.id] !== undefined ? contents[target.id] : ''
    },
  }
  return Object.assign(site, overrides || {})
}

function mockSite(t, site) {
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schemas-config-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

// ---------------------------------------------------------------------------
// schemas.js
// ---------------------------------------------------------------------------
describe('schemas route', () => {
  test('answers the full descriptor list with links', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({}))
    const res = stubRes()
    await schemasRoute(makeReq(), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.count, 10)
    const ids = res.body.data.schemas.map((schema) => schema.id)
    assert.ok(ids.indexOf('json-outline-schema') !== -1)
    assert.ok(ids.indexOf('hax-schema') !== -1)
    assert.equal(res.body.data.links.self, '/_sites/demo/x/api/v1/schemas')
    // the generic webcomponent descriptors use the * tag by default
    const haxElementSchema = res.body.data.schemas.filter(
      (schema) => schema.id === 'hax-element-schema',
    )[0]
    assert.equal(haxElementSchema.schema.tag, '*')
  })

  test('filter.kind narrows the list to matching descriptors', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({}))
    const res = stubRes()
    await schemasRoute(makeReq({ query: { 'filter.kind': 'jsonOutlineSchema' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.schemas[0].id, 'json-outline-schema')
    const resUnknown = stubRes()
    await schemasRoute(makeReq({ query: { 'filter.kind': 'bogus' } }), resUnknown)
    assert.equal(resUnknown.statusCode, 200)
    assert.equal(resUnknown.body.data.count, 0)
  })

  test('filter.webcomponentName loads real haxProperties from the site tree', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    // a site-local search root with the component's haxProperties file
    const packageDir = path.join(
      site.siteDirectory,
      'build',
      'es6',
      'node_modules',
      '@demo',
      'my-widget',
    )
    fs.ensureDirSync(path.join(packageDir, 'lib'))
    fs.writeFileSync(
      path.join(packageDir, 'lib', 'my-widget.haxProperties.json'),
      JSON.stringify({
        api: '2',
        canScale: false,
        canPosition: true,
        canEditSource: false,
        gizmo: { title: 'My Widget' },
      }),
    )
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({
      'my-widget': { path: '@demo/my-widget/lib/my-widget.js' },
    }))
    const res = stubRes()
    await schemasRoute(
      makeReq({ query: { 'filter.webcomponentName': 'my-widget' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const haxProperties = res.body.data.schemas.filter(
      (schema) => schema.id === 'hax-properties',
    )[0]
    assert.equal(haxProperties.schema.tag, 'my-widget')
    assert.equal(haxProperties.schema.gizmo.title, 'My Widget')
    const haxSchema = res.body.data.schemas.filter(
      (schema) => schema.id === 'hax-schema',
    )[0]
    assert.equal(haxSchema.schema.api, '2')
    assert.equal(haxSchema.schema.canScale, false)
    assert.equal(haxSchema.schema.canEditSource, false)
    // an unknown webcomponent falls back to the default descriptor shapes
    const resUnknown = stubRes()
    await schemasRoute(
      makeReq({ query: { 'filter.webcomponentName': 'ghost-widget' } }),
      resUnknown,
    )
    assert.equal(resUnknown.statusCode, 200)
    const haxPropertiesUnknown = resUnknown.body.data.schemas.filter(
      (schema) => schema.id === 'hax-properties',
    )[0]
    assert.deepEqual(haxPropertiesUnknown.schema.properties.settings.properties.configure, {
      type: 'array',
    })
  })

  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await schemasRoute(makeReq(), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/schemas',
    )
  })
})

// ---------------------------------------------------------------------------
// blocks.js
// ---------------------------------------------------------------------------
describe('blocks routes', () => {
  function mockRegistry(t) {
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({
      'my-widget': { path: '@demo/my-widget/lib/my-widget.js' },
      'grid-plate': { path: '@haxtheweb/grid-plate/grid-plate.js' },
    }))
  }

  function useAutoloaderConfig(t, autoloader) {
    const originalAppStore = HAXCMS.config.appStore
    HAXCMS.config.appStore = { autoloader: autoloader }
    t.after(() => {
      if (originalAppStore === undefined) {
        delete HAXCMS.config.appStore
      } else {
        HAXCMS.config.appStore = originalAppStore
      }
    })
  }

  test('listBlocks reports usage, imports, and enabled flags', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    mockRegistry(t)
    useTempConfigDirectory(t)
    useAutoloaderConfig(t, ['grid-plate', 'unused-widget'])
    const res = stubRes()
    await listBlocks(makeReq({ originalUrl: '/_sites/demo/x/api/v1/blocks' }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    const blocks = res.body.data.blocks
    const byTag = {}
    for (let i = 0; i < blocks.length; i++) {
      byTag[blocks[i].tag] = blocks[i]
    }
    // usage from both page contents (authenticated requests see every page)
    assert.equal(byTag['video-player'].usageCount, 2)
    assert.equal(byTag['video-player'].used, true)
    assert.equal(byTag['video-player'].import, '')
    assert.equal(byTag['my-widget'].usageCount, 1)
    assert.equal(byTag['my-widget'].import, '@demo/my-widget/lib/my-widget.js')
    assert.equal(byTag['my-widget'].package, '@demo/my-widget')
    // autoloader entries ride along with zero usage
    assert.equal(byTag['unused-widget'].usageCount, 0)
    assert.equal(byTag['unused-widget'].used, false)
    assert.equal(byTag['grid-plate'].usageCount, 0)
    // schema links point at the schemas route
    assert.equal(
      byTag['my-widget'].related[1].href,
      '/_sites/demo/x/api/v1/schemas?filter.kind=haxProperties&filter.webcomponentName=my-widget',
    )
    // sort by usage descending by default
    const usageCounts = blocks.map((block) => block.usageCount)
    assert.deepEqual(usageCounts, [...usageCounts].sort((a, b) => b - a))
  })

  test('listBlocks honors filter.tag, paging, fields, and enabled settings', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    mockRegistry(t)
    const configDir = useTempConfigDirectory(t)
    fs.ensureDirSync(path.join(configDir, 'settings'))
    fs.writeFileSync(
      path.join(configDir, 'settings', 'enabledBlocks.json'),
      JSON.stringify(['video-player', 'grid-plate']),
    )
    useAutoloaderConfig(t, ['grid-plate'])
    const resFilter = stubRes()
    await listBlocks(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks',
        query: { 'filter.tag': 'video' },
      }),
      resFilter,
    )
    assert.equal(resFilter.statusCode, 200)
    // the filter tag itself joins the tag set and self-matches
    assert.deepEqual(
      resFilter.body.data.blocks.map((block) => block.tag),
      ['video-player', 'video'],
    )
    const resFields = stubRes()
    await listBlocks(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks',
        query: { 'filter.tag': 'my-widget', fields: 'tag,enabled' },
      }),
      resFields,
    )
    // my-widget is not in the enabled settings list
    assert.deepEqual(resFields.body.data.blocks, [
      { tag: 'my-widget', enabled: false },
    ])
    const resPage = stubRes()
    await listBlocks(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks',
        query: { 'page.limit': '1', 'page.offset': '1' },
      }),
      resPage,
    )
    assert.equal(resPage.body.data.count, 1)
    assert.equal(resPage.body.data.page.offset, 1)
  })

  test('blockDetail answers usage details and unknown-block 404s', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    mockRegistry(t)
    useTempConfigDirectory(t)
    useAutoloaderConfig(t, ['grid-plate'])
    const res = stubRes()
    await blockDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks/my-widget',
        params: { webcomponentName: 'my-widget' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const data = res.body.data
    assert.equal(data.tag, 'my-widget')
    assert.equal(data.usageCount, 1)
    // usedIn entries are plain item id strings
    assert.deepEqual(data.usedIn, ['item-1'])
    assert.equal(data.usedInDetails[0].instances.length, 1)
    assert.equal(data.usedInDetails[0].instances[0].haxElementSchema.tag, 'my-widget')
    assert.equal(data.usedInDetails[0].instances[0].haxElementSchema.properties.value, 'a')
    // an unlisted blank name answers 404
    const resBlank = stubRes()
    await blockDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks/%20',
        params: { webcomponentName: ' ' },
      }),
      resBlank,
    )
    assert.equal(resBlank.statusCode, 404)
    assert.equal(resBlank.body.data.message, 'Block not found')
    // a tag that is neither in the registry, usage, nor autoloader 404s
    const resUnknown = stubRes()
    await blockDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks/ghost-widget',
        params: { webcomponentName: 'ghost-widget' },
      }),
      resUnknown,
    )
    assert.equal(resUnknown.statusCode, 404)
    assert.equal(resUnknown.body.data.message, 'Block "ghost-widget" not found')
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await blockDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks/my-widget',
        params: { webcomponentName: 'my-widget' },
      }),
      resNoSite,
    )
    assert.equal(resNoSite.statusCode, 404)
  })

  test('blockUsage answers the using pages and unknown-block 404', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    mockRegistry(t)
    useTempConfigDirectory(t)
    useAutoloaderConfig(t, ['grid-plate'])
    const res = stubRes()
    await blockUsage(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks/video-player/usage',
        params: { webcomponentName: 'video-player' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    // both pages use video-player, sorted by usage count
    assert.equal(res.body.data.count, 2)
    assert.equal(res.body.data.items[0].id, 'item-1')
    assert.equal(res.body.data.items[0].usageCount, 1)
    assert.equal(res.body.data.items[1].id, 'item-2')
    assert.equal(
      res.body.data.links.self,
      '/_sites/demo/x/api/v1/blocks/video-player/usage',
    )
    // an unknown block (no registry, usage, or autoloader entry) answers 404
    const resUnknown = stubRes()
    await blockUsage(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks/ghost-widget/usage',
        params: { webcomponentName: 'ghost-widget' },
      }),
      resUnknown,
    )
    assert.equal(resUnknown.statusCode, 404)
    assert.equal(resUnknown.body.data.message, 'Block "ghost-widget" not found')
    // a blank name answers the plain 404
    const resBlank = stubRes()
    await blockUsage(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/blocks/%20/usage',
        params: { webcomponentName: ' ' },
      }),
      resBlank,
    )
    assert.equal(resBlank.statusCode, 404)
    assert.equal(resBlank.body.data.message, 'Block not found')
  })

  test('listBlocks answers 404 without a site', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await listBlocks(makeReq({ originalUrl: '/_sites/demo/x/api/v1/blocks' }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/blocks',
    )
  })
})

// ---------------------------------------------------------------------------
// reports.js
// ---------------------------------------------------------------------------
describe('reports routes', () => {
  test('listReports answers the report catalog', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const res = stubRes()
    await listReports(makeReq({ originalUrl: '/_sites/demo/x/api/v1/reports' }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.deepEqual(
      res.body.data.reports.map((report) => report.id),
      ['overview', 'content', 'links', 'media'],
    )
    assert.equal(res.body.data.reports[0].label, 'Stats')
    assert.equal(
      res.body.data.reports[0].links.self,
      '/_sites/demo/x/api/v1/reports/overview',
    )
  })

  test('reportDetail answers the content report with annotated links', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = {
      contentData: [
        { slug: 'first-page', words: 100 },
        { slug: 'second-page', words: 200 },
      ],
    }
    t.after(() => {
      courseStatsFixture = {}
    })
    const res = stubRes()
    await reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/content',
        params: { report: 'content' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.id, 'content')
    assert.equal(res.body.data.label, 'Content')
    assert.equal(res.body.data.data.contentData[0].link, '/demo/first-page')
    assert.equal(res.body.data.data.contentData[1].link, '/demo/second-page')
    assert.ok(res.body.data.generatedAt !== undefined)
  })

  test('reportDetail answers the links report with page titles', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = {
      linkData: {
        'https://example.com/a': [
          { itemId: 'item-1' },
          { itemId: 'item-2' },
          { itemId: 'ghost-item' },
        ],
        'https://example.com/b': [{ itemId: 'item-2' }],
      },
    }
    t.after(() => {
      courseStatsFixture = {}
    })
    const res = stubRes()
    await reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/links',
        params: { report: 'links' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const linkData = res.body.data.data.linkData
    assert.equal(linkData['https://example.com/a'][0].link, '/demo/first-page')
    assert.equal(linkData['https://example.com/a'][0].pageTitle, 'First Page')
    assert.equal(linkData['https://example.com/a'][1].pageTitle, 'Second Page')
    // unknown items annotate with empty links/titles
    assert.equal(linkData['https://example.com/a'][2].link, '')
    assert.equal(linkData['https://example.com/a'][2].pageTitle, '')
  })

  test('reportDetail answers the media report with page annotations', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = {
      mediaData: [
        { itemId: 'item-1', type: 'image' },
        { itemId: null, type: 'video' },
      ],
    }
    t.after(() => {
      courseStatsFixture = {}
    })
    const res = stubRes()
    await reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/media',
        params: { report: 'media' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const mediaData = res.body.data.data.mediaData
    assert.equal(mediaData[0].pageLink, '/demo/first-page')
    assert.equal(mediaData[0].pageSlug, 'first-page')
    assert.equal(mediaData[0].pageTitle, 'First Page')
    assert.equal(mediaData[1].pageLink, '')
    assert.equal(mediaData[1].pageTitle, '')
  })

  test('reportDetail answers the overview report with readability', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = { totalWords: 500 }
    siteHtmlFixture = 'The cat sat on the mat. It was a good day for reading.'
    t.after(() => {
      courseStatsFixture = {}
      siteHtmlFixture = ''
    })
    const res = stubRes()
    await reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/overview',
        params: { report: 'overview' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.id, 'overview')
    assert.equal(res.body.data.data.totalWords, 500)
    // Characterization: safeReadabilityMetric invokes the text-readability
    // instance methods unbound (no `this`), so every metric currently throws
    // and answers 0 — gradeLevel then lands in the lowest band. If this
    // assertion fails after a fix, update it to the fixed contract.
    const readability = res.body.data.data.readability
    assert.equal(readability.gradeLevel, '4th grade or lower')
    assert.equal(readability.difficultWords, 0)
    assert.equal(readability.syllableCount, 0)
    assert.equal(readability.lexiconCount, 0)
    assert.equal(readability.sentenceCount, 0)
  })

  test('reportDetail honors fields projection and answers 404s', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = {}
    const resFields = stubRes()
    await reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/content',
        params: { report: 'content' },
        query: { fields: 'id,label' },
      }),
      resFields,
    )
    assert.equal(resFields.statusCode, 200)
    assert.deepEqual(Object.keys(resFields.body.data).sort(), ['id', 'label'])
    const resUnknown = stubRes()
    await reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/bogus',
        params: { report: 'bogus' },
      }),
      resUnknown,
    )
    assert.equal(resUnknown.statusCode, 404)
    assert.equal(resUnknown.body.data.message, 'Unknown report "bogus"')
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/content',
        params: { report: 'content' },
      }),
      resNoSite,
    )
    assert.equal(resNoSite.statusCode, 404)
    const resNoSiteList = stubRes()
    await listReports(
      makeReq({ originalUrl: '/_sites/demo/x/api/v1/reports' }),
      resNoSiteList,
    )
    assert.equal(resNoSiteList.statusCode, 404)
  })
})
