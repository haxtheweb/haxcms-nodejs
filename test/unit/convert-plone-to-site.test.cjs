'use strict'

// Unit tests for convertPloneToSite: normalizes the repoUrl, discovers a Plone
// REST base via /@site (falling back over ++api++ probes), pages /@search with
// fullobjects (falling back to metadata-only results plus per-item hydration),
// transforms page-like types into a nested JSONOutlineSchemaItem tree, stages
// binary Image/File records into a `files` downloads map, and reports import
// stats. Covers discovery / permission / search / empty-import failure paths.
//
// safeFetch is mocked by mutating the shared module export BEFORE the
// converter is required, since the converter destructures { safeFetch } at
// require time (same pattern as convert-elmsln-to-site.test.cjs).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')

const fetchedUrls = []

function mockResp(opts) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    json: async () => opts.json,
    text: async () => (typeof opts.text === 'string' ? opts.text : ''),
  }
}

// fullobjects=1 @search payload: a folder (with a nested Document child), a
// Document with rich text, an Image (binary), a Link, a News Item with
// description-only content, and a blocks-based Document.
const SEARCH_ITEMS = [
  {
    '@id': 'https://plone.example.com/mysite/folder',
    '@type': 'Folder',
    title: 'My Folder',
    is_folderish: true,
    getObjPositionInParent: 1,
    review_state: 'published',
    created: '2024-01-01T00:00:00+00:00',
    modified: '2024-01-02T00:00:00+00:00',
  },
  {
    '@id': 'https://plone.example.com/mysite/folder/page',
    '@type': 'Document',
    title: 'A Page',
    description: 'A page description',
    text: { data: '<p>Hello from Plone with a <a href="/root-relative">link</a></p>' },
    getObjPositionInParent: 3,
    review_state: 'published',
  },
  {
    '@id': 'https://plone.example.com/mysite/logo.png',
    '@type': 'Image',
    title: 'Site Logo',
    image: {
      filename: 'Logo.png',
      download: 'https://plone.example.com/mysite/logo.png/@@download/image',
    },
  },
  {
    '@id': 'https://plone.example.com/mysite/remote-link',
    '@type': 'Link',
    title: 'External Link',
    remoteUrl: 'https://example.com/remote',
    getObjPositionInParent: 5,
  },
  {
    '@id': 'https://plone.example.com/mysite/news-item',
    '@type': 'News Item',
    title: 'Latest News',
    description: 'A news description only',
    getObjPositionInParent: 7,
  },
  {
    '@id': 'https://plone.example.com/mysite/blocks-page',
    '@type': 'Document',
    title: 'Blocks Page',
    blocks: { 'uuid-1': {} },
    blocks_layout: { items: ['uuid-1'] },
  },
]

const HYDRATED_PAGE = {
  '@type': 'Document',
  '@id': 'https://hydrate.example.com/page',
  title: 'Hydrated Page',
  text: { data: '<p>Hydrated body</p>' },
}

async function mockSafeFetch(url) {
  const u = String(url)
  fetchedUrls.push(u)
  // Plone object hydration endpoint (@id of a metadata-only search item)
  if (u.indexOf('hydrate.example.com/page') !== -1) {
    return mockResp({ json: HYDRATED_PAGE })
  }
  // REST base discovery probes
  if (u.indexOf('/@site') !== -1 || u.indexOf('++api++') !== -1) {
    if (u.indexOf('deadplone.example.com') !== -1) {
      return mockResp({ ok: false, status: 404, json: {} })
    }
    // only the /plone candidate is permission-blocked; the bare origin 404s
    // so the reported blocked base is the /plone candidate
    if (u.indexOf('lockedplone.example.com/plone') !== -1) {
      return mockResp({
        ok: false,
        status: 401,
        json: { error: 'plone.restapi: Use REST API permission required' },
      })
    }
    if (u.indexOf('lockedplone.example.com') !== -1) {
      return mockResp({ ok: false, status: 404, json: {} })
    }
    return mockResp({ json: { title: 'My Plone Site' } })
  }
  if (u.indexOf('/@search') !== -1) {
    if (u.indexOf('nosearch.example.com') !== -1) {
      return mockResp({ ok: false, status: 404, json: {} })
    }
    if (u.indexOf('brokensearch.example.com') !== -1) {
      return mockResp({ ok: false, status: 500, json: {} })
    }
    if (u.indexOf('emptyplone.example.com') !== -1) {
      return mockResp({ json: { items: [], items_total: 0 } })
    }
    if (u.indexOf('hydrate.example.com') !== -1) {
      if (u.indexOf('fullobjects=1') !== -1) {
        return mockResp({ ok: false, status: 500, json: {} })
      }
      return mockResp({
        json: { items: [{ '@id': 'https://hydrate.example.com/page', portal_type: 'Document' }], items_total: 1 },
      })
    }
    return mockResp({ json: { items: SEARCH_ITEMS, items_total: SEARCH_ITEMS.length } })
  }
  return mockResp({ ok: false, status: 404, json: {} })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertPloneToSite } = require('../../src/systemRoutes/v1/routes/imports/convertPloneToSite.js')

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

function queryReq(query) {
  return { query: query }
}

test.beforeEach(() => {
  fetchedUrls.length = 0
})

test('missing repoUrl returns 400 before any fetch', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('an unparseable repoUrl returns 400 with a descriptive error', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({ repoUrl: 'not a valid url' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'invalid `repoUrl` param; expected a valid http(s) URL')
})

test('failed REST discovery returns 400 with the install guidance error', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({ repoUrl: 'https://deadplone.example.com/site' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Unable to discover Plone REST endpoints from `repoUrl`. Expected endpoints like `/@site` and `/@search`. ' +
      'Install/enable the `plone.restapi` add-on and expose REST access before importing.',
  )
})

test('a permission-blocked REST API surfaces the plone.restapi permission error', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({ repoUrl: 'https://lockedplone.example.com/plone' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Plone REST API detected at https://lockedplone.example.com/plone but access is denied (401). ' +
      'Enable `plone.restapi: Use REST API` permission for authenticated/anonymous access and retry.',
  )
})

test('a missing @search endpoint returns 400 with the endpoint-not-found error', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({ repoUrl: 'https://nosearch.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Plone REST search endpoint `/@search` was not found. Enable/install `plone.restapi` and retry.',
  )
})

test('a generic @search failure returns 400 with the status code in the error', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({ repoUrl: 'https://brokensearch.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Plone search failed at https:\/\/brokensearch\.example\.com\/@search \(500\)/)
})

test('a reachable site with no page-like content returns 400', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({ repoUrl: 'https://emptyplone.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Plone REST API is reachable but import produced no page-like content items',
  )
})

test('a schemeless repoUrl is normalized and imports via the query param path', async () => {
  const res = stubRes()
  await convertPloneToSite(queryReq({ repoUrl: 'plone.example.com/mysite' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'my-plone-site')
})

test('search results convert into a nested item tree with binary file staging', async () => {
  const res = stubRes()
  await convertPloneToSite(queryReq({ repoUrl: 'https://plone.example.com/mysite' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'my-plone-site')
  assert.deepEqual(res.body.data.files, {
    'files/logo.png': 'https://plone.example.com/mysite/logo.png/@@download/image',
  })

  const items = res.body.data.items
  assert.equal(items.length, 5, 'binary image is staged as a file, not an item')

  // folder becomes the top-level parent
  const folder = items[0]
  assert.equal(folder.title, 'My Folder')
  assert.equal(folder.slug, 'folder')
  assert.equal(folder.order, 0)
  assert.equal(folder.indent, 0)
  assert.equal(folder.parent, null)
  assert.equal(folder.contents, '<p></p>')
  assert.equal(folder.metadata.sourceType, 'plone')
  assert.equal(folder.metadata.source, 'https://plone.example.com/mysite/folder')
  assert.equal(folder.metadata.plone.type, 'Folder')
  assert.equal(folder.metadata.plone.reviewState, 'published')

  // the nested document nests under the folder with absolutized root URLs
  const page = items[1]
  assert.equal(page.title, 'A Page')
  assert.equal(page.slug, 'folder/page')
  assert.equal(page.order, 0)
  assert.equal(page.indent, 1)
  assert.equal(page.parent, folder.id)
  assert.equal(page.description, 'A page description')
  assert.equal(
    page.contents,
    '<p>Hello from Plone with a <a href="https://plone.example.com/root-relative">link</a></p>',
  )
  assert.equal(page.metadata.plone.type, 'Document')

  // link items render their remoteUrl as an anchor
  const link = items[2]
  assert.equal(link.title, 'External Link')
  assert.equal(
    link.contents,
    '<p><a href="https://example.com/remote" target="_blank" rel="noopener noreferrer">https://example.com/remote</a></p>',
  )

  // description-only items fall back to a description paragraph
  const news = items[3]
  assert.equal(news.title, 'Latest News')
  assert.equal(news.contents, '<p>A news description only</p>')

  // blocks-based items get the blocks notice
  const blocks = items[4]
  assert.equal(blocks.title, 'Blocks Page')
  assert.ok(blocks.contents.indexOf('blocks-to-HTML transform') !== -1)

  // import stats reflect the search + binary accounting
  assert.deepEqual(res.body.data.plone, {
    base: 'https://plone.example.com/mysite',
    importedItems: 5,
    discoveredItems: 6,
    binaryFiles: 1,
    usedFullObjects: true,
    truncated: false,
  })
})

test('a failing fullobjects search falls back to metadata items hydrated per object', async () => {
  const res = stubRes()
  await convertPloneToSite(jsonReq({ repoUrl: 'https://hydrate.example.com' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 1)
  assert.equal(res.body.data.items[0].title, 'Hydrated Page')
  assert.equal(res.body.data.items[0].contents, '<p>Hydrated body</p>')
  assert.equal(res.body.data.plone.usedFullObjects, false, 'fullobjects fallback engaged')
  assert.equal(res.body.data.plone.importedItems, 1)
})

test('maxItems truncates the import and reports it in the plone stats', async () => {
  const res = stubRes()
  await convertPloneToSite(
    jsonReq({ repoUrl: 'https://plone.example.com/mysite', maxItems: '1' }),
    res,
  )
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 1)
  assert.equal(res.body.data.plone.importedItems, 1)
  assert.equal(res.body.data.plone.discoveredItems, 6)
  assert.equal(res.body.data.plone.truncated, true)
})
