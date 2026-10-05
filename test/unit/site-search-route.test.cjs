'use strict'

// Direct handler tests for the siteSearch route handler
// (src/siteRoutes/v1/routes/siteSearch.js). The exported helpers have their
// own direct suite (site-search-helpers); this file drives the handler:
// auth gating, query validation, text search across fields with limits and
// case sensitivity, selector-mode search, and the confirmed bulk-replace
// operation including write failures and removal confirmations. Site loading
// is mocked through HAXCMS.loadSite per test (save-settings-routes pattern)
// with a fake site whose pages carry writeLocation spies.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMS: CMS } = require('../../src/lib/HAXCMS.js')
const siteSearch = require('../../src/siteRoutes/v1/routes/siteSearch.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.sent = obj
      return obj
    },
  }
}

function makeReq(body, headers) {
  return {
    headers: Object.assign({ 'x-haxcms-site-token': 'token' }, headers || {}),
    query: {},
    body: body,
  }
}

function makePage(overrides) {
  const page = {
    id: 'item-1',
    title: 'First Page',
    slug: 'first-page',
    parent: null,
    location: 'pages/item-1/index.html',
    description: 'The first page',
    metadata: {},
    writes: [],
    async writeLocation(content, dir) {
      page.writes.push({ content: content, dir: dir })
      return 10
    },
  }
  return Object.assign(page, overrides || {})
}

function makeFakeSite(t, overrides) {
  const page1 = makePage({
    id: 'item-1',
    title: 'First Page',
    slug: 'first-page',
    description: 'The first page',
  })
  const page2 = makePage({
    id: 'item-2',
    title: 'Second Page',
    slug: 'second-page',
    parent: 'item-1',
    description: 'The second page',
  })
  const contents = {
    'item-1': '<p>first page needle content</p>',
    'item-2': '<p>second page text only</p>',
  }
  const calls = {
    gitCommits: [],
    updateAlternateFormats: 0,
    writePageAlternateFormats: 0,
    saveCalls: [],
  }
  const site = {
    siteDirectory: '/tmp/demo',
    calls: calls,
    pages: [page1, page2],
    manifest: {
      items: [page1, page2],
      orderTree(items) {
        return items.slice()
      },
      metadata: {
        site: { name: 'demo', updated: 1700000000 },
      },
      async save(reorder) {
        calls.saveCalls.push(typeof reorder === 'boolean' ? reorder : true)
      },
    },
    loadNode(id) {
      for (let i = 0; i < site.pages.length; i++) {
        if (site.pages[i].id === id) {
          return site.pages[i]
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
    contents: contents,
  }
  return Object.assign(site, overrides || {})
}

function mockSite(t, site) {
  t.mock.method(CMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
  t.mock.method(CMS, 'getActiveUserName', () => 'tester')
  t.mock.method(CMS, 'loadSite', async () => site)
}

describe('siteSearch route handler — auth and validation', () => {
  test('a missing token, site name, or invalid token answers 403', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const resNoToken = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'x' }, { 'x-haxcms-site-token': '' }),
      resNoToken,
    )
    assert.equal(resNoToken.statusCode, 403)
    assert.equal(resNoToken.body.data.message, 'Authentication required')
    const resNoName = stubRes()
    await siteSearch(makeReq({ search: 'x' }), resNoName)
    assert.equal(resNoName.statusCode, 403)
    t.mock.method(CMS, 'validateRequestToken', () => false)
    const resBadToken = stubRes()
    await siteSearch(makeReq({ site: { name: 'demo' }, search: 'x' }), resBadToken)
    assert.equal(resBadToken.statusCode, 403)
  })

  test('a missing or oversized search term answers 400', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const resMissing = stubRes()
    await siteSearch(makeReq({ site: { name: 'demo' } }), resMissing)
    assert.equal(resMissing.statusCode, 400)
    assert.equal(resMissing.body.data.message, 'Search query is required')
    const resLong = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'a'.repeat(257) }),
      resLong,
    )
    assert.equal(resLong.statusCode, 400)
    assert.ok(resLong.body.data.message.indexOf('max 256') !== -1)
  })

  test('replace validation answers 400 for every guard', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const cases = [
      {
        body: { site: { name: 'demo' }, operation: 'replace', search: 'x', replace: 'y', replaceConfirm: true },
        message: 'Search text must be more than 1 character for replacement operations',
      },
      {
        body: { site: { name: 'demo' }, operation: 'replace', search: 'needle', replace: 'q' },
        message: 'Replacement text must be empty or more than 1 character',
      },
      {
        body: { site: { name: 'demo' }, operation: 'replace', search: 'needle', replace: 'new' },
        message: 'Replacement requires confirmation',
      },
      {
        body: { site: { name: 'demo' }, operation: 'replace', search: 'needle', replace: '', replaceConfirm: true },
        message: 'Removing matched text requires a second confirmation',
      },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await siteSearch(makeReq(cases[i].body), res)
      assert.equal(res.statusCode, 400, 'case ' + i)
      assert.equal(res.body.data.message, cases[i].message, 'case ' + i)
    }
  })

  test('invalid selectors answer 400 with the parse reason', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const cases = [
      {
        body: { site: { name: 'demo' }, search: 'a > b', searchSelector: true },
        message: 'Only simple selectors are supported (tag, tag[attr], tag[attr="value"], [attr])',
      },
      {
        body: { site: { name: 'demo' }, search: 'a:hover', searchMode: 'selector' },
        message: 'Only simple selectors are supported (tag, tag[attr], tag[attr="value"], [attr])',
      },
      {
        body: { site: { name: 'demo' }, search: '[unclosed', searchSelector: true },
        message: 'Invalid selector syntax',
      },
      {
        body: { site: { name: 'demo' }, search: 'video-player,,img', searchSelector: true },
        message: 'Selector groups cannot be empty',
      },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await siteSearch(makeReq(cases[i].body), res)
      assert.equal(res.statusCode, 400, 'case ' + i)
      assert.equal(res.body.data.message, cases[i].message, 'case ' + i)
    }
  })
})

describe('siteSearch route handler — text search', () => {
  test('searches the default fields and reports matches with snippets', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(makeReq({ site: { name: 'demo' }, search: 'needle' }), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.operation, 'search')
    assert.equal(res.sent.data.query, 'needle')
    assert.equal(res.sent.data.mode, 'text')
    assert.equal(res.sent.data.caseSensitive, false)
    assert.equal(res.sent.data.limit, 25)
    assert.deepEqual(res.sent.data.fields, [
      'title',
      'slug',
      'description',
      'tags',
      'content',
    ])
    assert.equal(res.sent.data.total, 1)
    const match = res.sent.data.matches[0]
    assert.equal(match.id, 'item-1')
    assert.equal(match.title, 'First Page')
    assert.equal(match.slug, 'first-page')
    assert.equal(match.parent, null)
    assert.equal(match.tags, '')
    assert.equal(match.matches.length, 1)
    assert.equal(match.matches[0].field, 'content')
    assert.equal(match.matches[0].type, 'text')
    assert.ok(match.matches[0].snippet.indexOf('needle') !== -1)
  })

  test('searches title and description fields case-insensitively by default', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'FIRST', searchField: 'title,description' }),
      res,
    )
    assert.deepEqual(res.sent.data.fields, ['title', 'description'])
    assert.equal(res.sent.data.total, 1)
    const fields = res.sent.data.matches[0].matches.map((entry) => entry.field).sort()
    assert.deepEqual(fields, ['description', 'title'])
  })

  test('case-sensitive searches only match exact casing', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'First', searchField: 'title', searchCaseSensitive: true }),
      res,
    )
    assert.equal(res.sent.data.caseSensitive, true)
    assert.equal(res.sent.data.total, 1)
    const resLower = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'first', searchField: 'title', searchCaseSensitive: true }),
      resLower,
    )
    assert.equal(resLower.sent.data.total, 0)
  })

  test('field selection honors arrays, all, and falls back for junk values', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const resArray = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'needle', searchField: ['title', 'content'] }),
      resArray,
    )
    assert.deepEqual(resArray.sent.data.fields, ['title', 'content'])
    const resAll = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'needle', searchField: 'all' }),
      resAll,
    )
    assert.equal(resAll.sent.data.fields.length, 5)
    const resJunk = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'needle', searchField: 'bogus, ,,also-bogus' }),
      resJunk,
    )
    assert.equal(resJunk.sent.data.fields.length, 5)
  })

  test('search limits clamp and stop the match loop', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const resOne = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'page', searchField: 'title', searchLimit: '1' }),
      resOne,
    )
    assert.equal(resOne.sent.data.limit, 1)
    assert.equal(resOne.sent.data.total, 1)
    const resZero = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'page', searchField: 'title', searchLimit: '0' }),
      resZero,
    )
    // a limit of 0 is treated as uncapped, so every match returns
    assert.equal(resZero.sent.data.limit, 0)
    assert.equal(resZero.sent.data.total, 2)
    const resJunk = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'page', searchField: 'title', searchLimit: 'bogus' }),
      resJunk,
    )
    assert.equal(resJunk.sent.data.limit, 25)
    const resHuge = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'page', searchField: 'title', searchLimit: '9999' }),
      resHuge,
    )
    assert.equal(resHuge.sent.data.limit, 200)
  })

  test('a site without a usable manifest answers the empty search response', async (t) => {
    const site = makeFakeSite(t)
    site.manifest = { items: [] }
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(makeReq({ site: { name: 'demo' }, search: 'needle' }), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.deepEqual(res.sent.data.matches, [])
  })

  test('pages that fail to load are skipped during content search', async (t) => {
    const site = makeFakeSite(t)
    site.loadNode = () => null
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(makeReq({ site: { name: 'demo' }, search: 'needle' }), res)
    assert.equal(res.sent.data.total, 0)
  })
})

describe('siteSearch route handler — selector search', () => {
  test('matches selectors against page content with counts and snippets', async (t) => {
    const site = makeFakeSite(t)
    site.contents['item-1'] =
      '<p>intro text</p><video-player source="one.mp4"></video-player><video-player source="two.mp4"></video-player>'
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'video-player', searchMode: 'selector' }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.data.mode, 'selector')
    assert.deepEqual(res.sent.data.fields, ['content'])
    assert.equal(res.sent.data.total, 1)
    const match = res.sent.data.matches[0]
    assert.equal(match.matches.length, 1)
    assert.equal(match.matches[0].type, 'selector')
    assert.equal(match.matches[0].selector, 'video-player')
    assert.equal(match.matches[0].count, 2)
    assert.ok(match.matches[0].snippets.length > 0)
    assert.ok(match.matches[0].snippets[0].indexOf('video-player') !== -1)
  })

  test('attribute selectors match and misses report no matches', async (t) => {
    const site = makeFakeSite(t)
    site.contents['item-1'] = '<img src="a.png" alt="hello"><img src="b.png">'
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'img[alt]', searchSelector: 'true' }),
      res,
    )
    assert.equal(res.sent.data.total, 1)
    assert.equal(res.sent.data.matches[0].matches[0].selector, 'img[alt]')
    assert.equal(res.sent.data.matches[0].matches[0].count, 1)
    const resMiss = stubRes()
    await siteSearch(
      makeReq({ site: { name: 'demo' }, search: 'video-player', searchSelector: 'true' }),
      resMiss,
    )
    assert.equal(resMiss.sent.data.total, 0)
  })
})

describe('siteSearch route handler — replace operation', () => {
  test('a confirmed replace rewrites pages, saves, and commits', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({
        site: { name: 'demo' },
        operation: 'replace',
        search: 'needle',
        replace: 'gem',
        replaceConfirm: true,
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.operation, 'replace')
    assert.equal(res.sent.data.query, 'needle')
    assert.equal(res.sent.data.replace, 'gem')
    assert.equal(res.sent.data.total, 1)
    assert.equal(res.sent.data.updatedItems, 1)
    assert.equal(res.sent.data.totalReplacements, 1)
    assert.equal(res.sent.data.items.length, 1)
    assert.equal(res.sent.data.items[0].id, 'item-1')
    assert.equal(res.sent.data.items[0].replacements, 1)
    // the page content was written sanitized with the replacement
    assert.equal(site.pages[0].writes.length, 1)
    assert.ok(site.pages[0].writes[0].content.indexOf('first page gem content') !== -1)
    assert.equal(site.pages[0].metadata.updated, Math.floor(Date.now() / 1000))
    assert.equal(site.calls.writePageAlternateFormats, 1)
    assert.deepEqual(site.calls.saveCalls, [true])
    assert.equal(site.calls.updateAlternateFormats, 1)
    assert.deepEqual(site.calls.gitCommits, ['Bulk replace "needle" -> "gem" across 1 page'])
  })

  test('a search term that matches nothing answers 400', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({
        site: { name: 'demo' },
        operation: 'replace',
        search: 'missing-term',
        replace: 'new',
        replaceConfirm: true,
      }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Search term not found in site content')
  })

  test('pages whose write fails are skipped and a total failure answers 500', async (t) => {
    const site = makeFakeSite(t)
    site.pages[0].writeLocation = async () => false
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({
        site: { name: 'demo' },
        operation: 'replace',
        search: 'needle',
        replace: 'gem',
        replaceConfirm: true,
      }),
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'No pages could be updated')
  })

  test('a failed alternate-format write never blocks the replacement', async (t) => {
    const site = makeFakeSite(t)
    site.writePageAlternateFormats = async () => {
      throw new Error('alt formats writer exploded')
    }
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({
        site: { name: 'demo' },
        operation: 'replace',
        search: 'needle',
        replace: 'gem',
        replaceConfirm: true,
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.updatedItems, 1)
  })

  test('an empty replacement with destroy confirmation removes the text', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({
        site: { name: 'demo' },
        operation: 'replace',
        search: 'needle',
        replace: '',
        replaceConfirm: true,
        replaceDestroyConfirm: true,
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.replace, '')
    assert.ok(
      site.pages[0].writes[0].content.indexOf('first page  content') !== -1,
      'matched text removed from the written content',
    )
    assert.deepEqual(site.calls.gitCommits, [
      'Bulk replace "needle" -> "[removed]" across 1 page',
    ])
  })

  test('case-sensitive replacement honors casing', async (t) => {
    const site = makeFakeSite(t)
    site.contents['item-1'] = '<p>Needle and needle together</p>'
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({
        site: { name: 'demo' },
        operation: 'replace',
        search: 'Needle',
        replace: 'Gem',
        replaceConfirm: true,
        searchCaseSensitive: true,
      }),
      res,
    )
    assert.equal(res.sent.data.caseSensitive, true)
    assert.equal(res.sent.data.total, 1)
    assert.ok(site.pages[0].writes[0].content.indexOf('Gem and needle together') !== -1)
  })

  test('non-string page content is treated as empty text', async (t) => {
    const site = makeFakeSite(t)
    site.getPageContent = async () => null
    mockSite(t, site)
    const res = stubRes()
    await siteSearch(
      makeReq({
        site: { name: 'demo' },
        operation: 'replace',
        search: 'needle',
        replace: 'gem',
        replaceConfirm: true,
      }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Search term not found in site content')
  })
})
