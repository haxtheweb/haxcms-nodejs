'use strict'

// Unit tests for convertElmslnToSite: fetches a remote site.json, converts its
// items to JSONOutlineSchemaItem objects, fetches each item's content (with a
// `<p>get source from...>` fallback on failure), and builds a `files`
// downloads map from each item's metadata.files entries.
//
// safeFetch is mocked by mutating the shared module export BEFORE the
// converter is required, since the converter destructures { safeFetch } at
// require time (same pattern as convert-haxcms-to-site.test.cjs).
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

const SITE_JSON = {
  id: 'site-1',
  title: 'My Site',
  metadata: { site: { name: 'mysite' } },
  items: [
    {
      id: 'item-1',
      title: 'Page 1',
      location: '/mysite/pages/page1/index.html',
      parent: '',
      order: 0,
      indent: 0,
      slug: 'page1',
      metadata: { files: [{ url: 'files/img.png' }] },
    },
    {
      id: 'item-2',
      title: 'Page 2',
      location: '/mysite/pages/page2/index.html',
      parent: '',
      order: 1,
      indent: 0,
      slug: 'page2',
      metadata: {},
    },
  ],
}

async function mockSafeFetch(url) {
  fetchedUrls.push(url)
  if (url.indexOf('/site.json') !== -1) {
    if (url.indexOf('fails.example.com') !== -1) {
      return mockResp({ ok: false, status: 404 })
    }
    return mockResp({ json: SITE_JSON })
  }
  if (url.indexOf('page1/index.html') !== -1) {
    return mockResp({ text: '<p>Page1 content</p>' })
  }
  // page2 content fetch fails -> fallback link expected
  return mockResp({ ok: false, status: 404 })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertElmslnToSite } = require('../../src/systemRoutes/v1/routes/imports/convertElmslnToSite.js')

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

test.beforeEach(() => {
  fetchedUrls.length = 0
})

test('missing repoUrl returns 400 before any fetch', async () => {
  const res = stubRes()
  await convertElmslnToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('trailing-slash repoUrl is normalized before fetching site.json', async () => {
  const res = stubRes()
  await convertElmslnToSite(jsonReq({ repoUrl: 'https://example.com/mysite/' }), res)
  assert.equal(res.body.status, 200)
  assert.ok(
    fetchedUrls.indexOf('https://example.com/mysite/site.json') !== -1,
    'trailing slash normalized to single-slash site.json fetch',
  )
})

test('site.json fetch failure returns 400 with a descriptive error', async () => {
  const res = stubRes()
  await convertElmslnToSite(jsonReq({ repoUrl: 'https://fails.example.com/mysite' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Unable to fetch site\.json from/)
  assert.deepEqual(res.body.data.items, [])
  assert.equal(res.body.data.filename, null)
  assert.deepEqual(res.body.data.files, {})
})

test('successful site.json fetch builds items array from JSONOutlineSchemaItem with per-item content', async () => {
  const res = stubRes()
  await convertElmslnToSite(jsonReq({ repoUrl: 'https://example.com/mysite' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'mysite')

  const items = res.body.data.items
  assert.equal(items.length, 2)

  // item-1: content fetch succeeds -> populates item.contents
  assert.equal(items[0].id, 'item-1')
  assert.equal(items[0].title, 'Page 1')
  assert.equal(items[0].contents, '<p>Page1 content</p>')

  // item-2: content fetch fails -> falls back to a "get source from" link
  assert.equal(items[1].id, 'item-2')
  assert.match(items[1].contents, /^<p>get source from <a href="/)
  assert.match(items[1].contents, /page2\/index\.html/)
})

test('metadata.files entries populate the returned downloads map with correct URLs', async () => {
  const res = stubRes()
  await convertElmslnToSite(jsonReq({ repoUrl: 'https://example.com/mysite' }), res)
  assert.deepEqual(res.body.data.files, {
    'files/img.png': 'https://example.com/mysite/files/img.png',
  })
})
