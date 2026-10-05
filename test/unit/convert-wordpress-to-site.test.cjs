'use strict'

// Unit tests for convertWordpressToSite: discovers the WP REST base from a
// repoUrl (/wp-json/ namespaces, trimming deep paths and wp-* stop segments),
// walks pages into a parent/child JSONOutlineSchemaItem tree ordered by
// menu-items + menu_order, filters trashed pages, strips gutenberg comments
// (and optionally shortcodes), prefers raw content in raw mode, falls back to
// front-end HTML extraction when asked, and reports per-collection stats.
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

function headersFor(totalPages) {
  return {
    get(name) {
      if (name === 'x-wp-totalpages') {
        return String(totalPages)
      }
      return null
    },
  }
}

function mockResp(opts) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    headers: opts.headers || { get: () => null },
    json: async () => opts.json,
    text: async () => (typeof opts.text === 'string' ? opts.text : ''),
  }
}

// pages: home (id 1) with child about (id 2), a trashed page (id 3, filtered),
// and a gutenberg-comment + shortcode page (id 4) that the menu orders first.
const WP_PAGES = [
  {
    id: 1,
    slug: 'home',
    title: { rendered: 'Home' },
    content: { rendered: '<p>Welcome to our site</p>' },
    parent: 0,
    menu_order: 1,
    link: 'https://wp.example.com/site/',
    status: 'publish',
    date: '2024-01-01T10:00:00',
    modified: '2024-01-02T10:00:00',
  },
  {
    id: 2,
    slug: 'about',
    title: { rendered: 'About' },
    content: { rendered: '<p>About us page</p>', raw: '<p>About raw</p>' },
    parent: 1,
    menu_order: 2,
    link: 'https://wp.example.com/site/about/',
    status: 'publish',
  },
  {
    id: 3,
    slug: 'trashed',
    title: { rendered: 'Trashed' },
    content: { rendered: '<p>Trash</p>' },
    parent: 0,
    menu_order: 3,
    status: 'trash',
  },
  {
    id: 4,
    slug: 'gutenberg',
    title: { rendered: 'Gutenberg Page' },
    content: {
      rendered:
        '<!-- wp:paragraph --><p>Gutenberg stripped content</p><!-- /wp:paragraph -->[audio src="x.mp3"]',
    },
    parent: 0,
    menu_order: 3,
    link: 'https://wp.example.com/site/gutenberg/',
    status: 'publish',
  },
]

// menu-items place gutenberg (object_id 4) before home (object_id 1)
const MENU_ITEMS = [
  { id: 11, menu_order: 0, object: 'page', object_id: '4', type: 'post_type' },
  { id: 12, menu_order: 1, object: 'page', object_id: '1', type: 'post_type' },
]

const POST = {
  id: 7,
  slug: 'hello-world',
  title: { rendered: 'Hello World' },
  link: 'https://wp.example.com/site/hello-world/',
  status: 'publish',
  date: '2024-01-01T10:00:00',
}

// raw-content-only page for the allowRawFallback behavior
const RAW_ONLY_PAGES = [
  {
    id: 1,
    slug: 'page',
    title: { rendered: 'Raw Page' },
    content: { raw: '<p>Only raw content</p>' },
    parent: 0,
    menu_order: 1,
    status: 'publish',
  },
]

// front-end HTML for the fallbackToPageHtml flow (content + script to strip)
const FRONTEND_HTML =
  '<html><body><main><article class="entry-content">' +
  '<p>Front end extracted content</p><script>evil()</script><style>.x{}</style>' +
  '</article></main></body></html>'

async function mockSafeFetch(url) {
  const u = String(url)
  fetchedUrls.push(u)
  // WP REST discovery root
  if (u.endsWith('/wp-json/')) {
    if (u.indexOf('nowp.example.com') !== -1) {
      return mockResp({ json: { namespaces: ['oembed/1.0'] } })
    }
    return mockResp({ json: { name: 'My WP Site', namespaces: ['wp/v2'] } })
  }
  if (u.indexOf('/wp-json/wp/v2/pages') !== -1) {
    if (u.indexOf('privatewp.example.com') !== -1) {
      return mockResp({ ok: false, status: 401, json: { code: 'rest_unauthorized' } })
    }
    if (u.indexOf('emptypages.example.com') !== -1) {
      return mockResp({ json: [], headers: headersFor(1) })
    }
    if (u.indexOf('rawonly.example.com') !== -1) {
      return mockResp({ json: RAW_ONLY_PAGES, headers: headersFor(1) })
    }
    return mockResp({ json: WP_PAGES, headers: headersFor(1) })
  }
  if (u.indexOf('/wp-json/wp/v2/menus') !== -1) {
    return mockResp({ json: [], headers: headersFor(1) })
  }
  if (u.indexOf('/wp-json/wp/v2/menu-items') !== -1) {
    return mockResp({ json: MENU_ITEMS, headers: headersFor(1) })
  }
  // posts collection spans 2 pages (x-wp-totalpages: 2) to exercise paging
  if (u.indexOf('/wp-json/wp/v2/posts') !== -1) {
    if (u.indexOf('&page=2') !== -1) {
      return mockResp({ json: [], headers: headersFor(2) })
    }
    return mockResp({ json: [POST], headers: headersFor(2) })
  }
  // page.link front-end fetches for fallbackToPageHtml
  if (u.indexOf('wp.example.com') !== -1) {
    return mockResp({ text: FRONTEND_HTML })
  }
  return mockResp({ ok: false, status: 404, json: {} })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertWordpressToSite } = require('../../src/systemRoutes/v1/routes/imports/convertWordpressToSite.js')

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
  await convertWordpressToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('a non-JSON string body falls back to an empty body and 400', async () => {
  const res = stubRes()
  await convertWordpressToSite(jsonReq('not-json{'), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
})

test('an unknown adapter returns 400 before any fetch', async () => {
  const res = stubRes()
  await convertWordpressToSite(jsonReq({ repoUrl: 'https://wp.example.com/site', adapter: 'bogus' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'unknown adapter `bogus`; valid adapters: pages')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted for an unknown adapter')
})

test('failed API discovery returns 422 with a descriptive error', async () => {
  const res = stubRes()
  await convertWordpressToSite(jsonReq({ repoUrl: 'https://nowp.example.com/site' }), res)
  assert.equal(res.statusCode, 422)
  assert.equal(
    res.body.data.error,
    'Unable to discover WordPress API from `repoUrl`; expected `/wp-json/wp/v2/*`',
  )
})

test('an inaccessible pages endpoint returns 422', async () => {
  const res = stubRes()
  await convertWordpressToSite(jsonReq({ repoUrl: 'https://privatewp.example.com/site' }), res)
  assert.equal(res.statusCode, 422)
  assert.equal(
    res.body.data.error,
    'WordPress pages endpoint is not publicly accessible (authentication required or blocked)',
  )
})

test('a site with no pages returns 422', async () => {
  const res = stubRes()
  await convertWordpressToSite(jsonReq({ repoUrl: 'https://emptypages.example.com/site' }), res)
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.data.error, 'WordPress import produced no pages to import')
})

test('pages build a menu-ordered tree with trashed pages filtered and tokens stripped', async () => {
  const res = stubRes()
  await convertWordpressToSite(jsonReq({ repoUrl: 'https://wp.example.com/site' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'my-wp-site')
  assert.deepEqual(res.body.data.files, {})

  const items = res.body.data.items
  assert.equal(items.length, 3, 'trashed page filtered out')

  // menu-items order gutenberg before home
  assert.equal(items[0].title, 'Gutenberg Page')
  assert.equal(items[0].slug, 'gutenberg')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].indent, 0)
  assert.equal(items[0].parent, null)
  // gutenberg comments stripped by default; shortcodes kept by default
  assert.equal(items[0].contents, '<p>Gutenberg stripped content</p>[audio src="x.mp3"]')
  assert.equal(items[0].metadata.wordpress.content.source, 'rendered')
  assert.equal(items[0].metadata.wordpress.content.tokenCount, 1)
  assert.equal(items[0].metadata.wordpress.content.shortcodeCount, 1)
  assert.equal(items[0].metadata.wordpress.content.originalTokenCount, 3)
  assert.equal(items[0].metadata.wordpress.content.originalGutenbergCommentCount, 2)

  assert.equal(items[1].title, 'Home')
  assert.equal(items[1].slug, 'home')
  assert.equal(items[1].order, 1)
  assert.equal(items[1].contents, '<p>Welcome to our site</p>')
  assert.equal(items[1].metadata.wordpress.id, 1)
  assert.equal(items[1].metadata.wordpress.menuOrder, 1)
  assert.equal(items[1].metadata.wordpress.status, 'publish')

  // the about page nests under home via the WP parent id
  assert.equal(items[2].title, 'About')
  assert.equal(items[2].slug, 'home/about')
  assert.equal(items[2].order, 0)
  assert.equal(items[2].indent, 1)
  assert.equal(items[2].parent, items[1].id)
  assert.equal(items[2].contents, '<p>About us page</p>')

  // collection stats; posts paged across two requests (page 2 returned empty)
  assert.deepEqual(res.body.data.wordpress.pages, { status: 200, count: 3 })
  assert.deepEqual(res.body.data.wordpress.menus, { status: 200, count: 0 })
  assert.deepEqual(res.body.data.wordpress.menuItems, { status: 200, count: 2 })
  assert.deepEqual(res.body.data.wordpress.posts, { status: 200, count: 1, imported: false })
  assert.equal(res.body.data.wordpress.content.pagesWithTokens, 1)
  assert.equal(res.body.data.wordpress.content.tokenCount, 1)
  // both post pages were actually requested
  const postFetches = fetchedUrls.filter((u) => String(u).indexOf('/wp-json/wp/v2/posts') !== -1)
  assert.equal(postFetches.length, 2, 'posts paged: page 1 then page 2')
})

test('deep wp-json repoUrls are trimmed back to the discovered base', async () => {
  const res = stubRes()
  await convertWordpressToSite(queryReq({ repoUrl: 'https://wp.example.com/wp-json/pages' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 3)
  // collections were fetched against the origin base, not the deep path
  assert.ok(
    fetchedUrls.filter((u) => String(u).indexOf('https://wp.example.com/wp-json/wp/v2/pages?') !== -1)
      .length >= 1,
    'pages collection fetched from the trimmed origin base',
  )
})

test('a JSON string body is parsed and imported', async () => {
  const res = stubRes()
  await convertWordpressToSite(
    jsonReq(JSON.stringify({ repoUrl: 'https://wp.example.com/site' })),
    res,
  )
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items.length, 3)
})

test('contentMode raw prefers raw content when available', async () => {
  const res = stubRes()
  await convertWordpressToSite(
    jsonReq({ repoUrl: 'https://wp.example.com/site', contentMode: 'raw' }),
    res,
  )
  assert.equal(res.body.status, 200)
  const about = res.body.data.items.filter((item) => item.slug === 'home/about')[0]
  assert.equal(about.contents, '<p>About raw</p>')
  assert.equal(about.metadata.wordpress.content.source, 'raw')
  // pages without raw keep their rendered content
  const home = res.body.data.items.filter((item) => item.slug === 'home')[0]
  assert.equal(home.contents, '<p>Welcome to our site</p>')
})

test('the legacy renderMode param also selects raw content', async () => {
  const res = stubRes()
  await convertWordpressToSite(
    jsonReq({ repoUrl: 'https://wp.example.com/site', renderMode: 'raw' }),
    res,
  )
  assert.equal(res.body.status, 200)
  const about = res.body.data.items.filter((item) => item.slug === 'home/about')[0]
  assert.equal(about.contents, '<p>About raw</p>')
})

test('raw-only content is empty without allowRawFallback and used with it', async () => {
  const withoutFallback = stubRes()
  await convertWordpressToSite(jsonReq({ repoUrl: 'https://rawonly.example.com/site' }), withoutFallback)
  assert.equal(withoutFallback.body.status, 200)
  assert.equal(withoutFallback.body.data.items[0].contents, '<p></p>')

  const withFallback = stubRes()
  await convertWordpressToSite(
    jsonReq({ repoUrl: 'https://rawonly.example.com/site', allowRawFallback: true }),
    withFallback,
  )
  assert.equal(withFallback.body.status, 200)
  assert.equal(withFallback.body.data.items[0].contents, '<p>Only raw content</p>')
  assert.equal(withFallback.body.data.items[0].metadata.wordpress.content.source, 'raw')
})

test('fallbackToPageHtml extracts and sanitizes front-end content', async () => {
  const res = stubRes()
  await convertWordpressToSite(
    jsonReq({
      repoUrl: 'https://wp.example.com/site',
      fallbackToPageHtml: true,
      tokenThreshold: '0',
    }),
    res,
  )
  assert.equal(res.body.status, 200)
  // every page with a link fell back to its front-end HTML, sanitized
  res.body.data.items.forEach((item) => {
    assert.equal(item.contents, '<p>Front end extracted content</p>')
    assert.equal(item.metadata.wordpress.content.source, 'front-end-fallback')
    assert.equal(item.metadata.wordpress.content.fallbackUsed, true)
  })
  assert.equal(res.body.data.wordpress.content.pagesUsingFallback, 3)
})

test('stripShortcodes removes shortcode tokens from content', async () => {
  const res = stubRes()
  await convertWordpressToSite(
    jsonReq({ repoUrl: 'https://wp.example.com/site', stripShortcodes: true }),
    res,
  )
  assert.equal(res.body.status, 200)
  const gutenberg = res.body.data.items.filter((item) => item.slug === 'gutenberg')[0]
  assert.equal(gutenberg.contents, '<p>Gutenberg stripped content</p>')
  assert.equal(gutenberg.metadata.wordpress.content.tokenCount, 0)
})
