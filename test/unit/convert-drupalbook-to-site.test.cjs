'use strict'

// Unit tests for convertDrupalBookToSite: discovers a Drupal JSON:API base
// from a repoUrl (<base>/jsonapi index with node--* collection links), pages
// collections via links.next, builds the book tree through three strategies
// (menu_link_content records, node--book book fields, and an HTML
// book-navigation fallback behind allowHtmlFallback), treats a near-empty
// root as structural (children promoted to top level), buckets unlinked nodes
// under a hidden "additional pages" item, and reports per-import drupal stats.
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

// host drupal.example.com: node--book tree driven by menu_link_content.
// Two menus exist ("main" with 3 links, "other" with 1) so menu selection by
// size is exercised; the "other" menu's node (102) is menu-linked but not in
// the selected tree, so it is excluded from the additional-pages bucket too.
const BOOK_RECORDS = [
  {
    id: 'uuid-100',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 100,
      title: 'Course Book',
      body: { value: '<p>The course book landing page with plenty of words.</p>' },
      path: { alias: '/course-book' },
      status: true,
    },
  },
  {
    id: 'uuid-101',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 101,
      title: 'Unit 1',
      body: { value: '<p>Unit one with a <a href="/local">link</a>.</p>' },
      path: { alias: '/unit-1' },
    },
  },
  {
    id: 'uuid-102',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 102,
      title: 'Unit 2',
      body: { value: '<p>Unit two content body.</p>' },
      path: { alias: '/unit-2' },
    },
  },
  {
    id: 'uuid-103',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 103,
      title: 'Unit 1 Lesson',
      body: { value: '<p>Lesson one content.</p>' },
      path: { alias: '/unit-1-lesson' },
    },
  },
]

// standalone node--page records: one with alias + title, one with an empty
// title (falls back to "Node 201" naming). Page 2 of the collection repeats
// nid 200 so the first-record-wins dedupe branch runs.
const PAGE_RECORDS = [
  {
    id: 'uuid-200',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 200,
      title: 'Standalone Page',
      body: { value: '<p>A standalone page body.</p>' },
      path: { alias: '/standalone' },
    },
  },
  {
    id: 'uuid-201',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 201,
      title: '',
      body: { value: '<p>Second standalone body.</p>' },
    },
  },
]

const PAGE_200_DUP = {
  id: 'uuid-200-dup',
  type: 'node--page',
  attributes: {
    drupal_internal__nid: 200,
    title: 'Duplicate Standalone',
    body: { value: '<p>dup</p>' },
  },
}

// menu link uri forms cover the entity:, internal:, and generic /node/ parsers
const MENU_LINKS = [
  {
    id: 'ml-root',
    type: 'menu_link_content--menu_link_content',
    attributes: { menu_name: 'main', link: { uri: 'entity:node/100' }, weight: -10 },
  },
  {
    id: 'ml-1',
    type: 'menu_link_content--menu_link_content',
    attributes: {
      menu_name: 'main',
      link: { uri: 'entity:node/101' },
      weight: 0,
      parent: 'menu_link_content:ml-root',
    },
  },
  {
    id: 'ml-2',
    type: 'menu_link_content--menu_link_content',
    attributes: {
      menu_name: 'other',
      link: { uri: 'https://drupal.example.com/node/102' },
      weight: 5,
      parent: 'menu_link_content:ml-root',
    },
  },
  {
    id: 'ml-3',
    type: 'menu_link_content--menu_link_content',
    attributes: { menu_name: 'main', link: { uri: 'internal:/node/103' }, weight: 1 },
    // parent relationship expressed via JSON:API relationships instead of the
    // attributes.parent string form
    relationships: { parent: { data: { id: 'ml-1', type: 'menu_link_content--menu_link_content' } } },
  },
]

// host bookfields.example.com: no menu links published; the tree comes from the
// node--book book fields (pid/weight plus the legacy book_parent attrs), and
// the root is structural (empty body) so children become top-level items.
const BOOKFIELDS_BOOK_RECORDS = [
  {
    id: 'uuid-300',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 300,
      title: 'Handbook',
      body: { value: '' },
      book: { pid: 0, weight: -10 },
      path: { alias: '/handbook' },
    },
  },
  {
    id: 'uuid-301',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 301,
      title: 'Chapter One',
      body: { value: '<p>Chapter one body text here.</p>' },
      book: { pid: 300, weight: 0 },
      path: { alias: '/chapter-one' },
    },
  },
  {
    id: 'uuid-302',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 302,
      title: 'Chapter Two',
      body: { value: '<p>Chapter two body text here.</p>' },
      book: { pid: 300, weight: 1 },
      path: { alias: '/chapter-two' },
    },
  },
  {
    id: 'uuid-303',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 303,
      title: 'Chapter Three',
      body: { value: '<p>Chapter three body text.</p>' },
      book_parent: 300,
      book_weight: 2,
      // duplicate alias segment forces the uniquified slug branch
      path: { alias: '/chapter-one' },
    },
  },
]

// host htmlnav.example.com: book records carry no tree fields at all; the tree
// is recovered from the rendered /node/N book-navigation HTML.
const HTMLNAV_BOOK_RECORDS = [
  {
    id: 'uuid-400',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 400,
      title: 'Nav Book',
      body: { value: '<p>Nav book.</p>' },
      path: { alias: '/nav-book' },
    },
  },
  {
    id: 'uuid-401',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 401,
      title: 'Nav Unit 1',
      body: { value: '<p>Nav unit one body.</p>' },
      path: { alias: '/nav-unit-1' },
    },
  },
  {
    id: 'uuid-402',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 402,
      title: 'Nav Unit 2',
      body: { value: '<p>Nav unit two body.</p>' },
      path: { alias: '/nav-unit-2' },
    },
  },
]

const NODE_400_HTML =
  '<html><body>' +
  '<nav class="book-navigation" id="book-navigation-400">' +
  '<div class="book-pager__item book-pager__item--previous"><a href="#">Prev</a></div>' +
  '<ul class="menu"><li><a href="/node/401">Nav Unit 1</a></li></ul>' +
  '</nav></body></html>'

const NODE_401_HTML =
  '<html><body>' +
  '<nav class="book-navigation" id="book-navigation-400">' +
  '<div class="book-pager__item book-pager__item--center"><a href="/node/400">Up</a></div>' +
  '<ul class="menu"><li><a href="/node/402">Nav Unit 2</a></li></ul>' +
  '</nav></body></html>'

// 402's up link points at its direct parent (401), not the book root
const NODE_402_HTML =
  '<html><body>' +
  '<nav class="book-navigation" id="book-navigation-400">' +
  '<div class="book-pager__item book-pager__item--center"><a href="/node/401">Up</a></div>' +
  '</nav></body></html>'

// host notree.example.com: book records with no tree fields and no navigation
// markup, so only allowHtmlFallback can produce (a flat) output.
const NOTREE_BOOK_RECORDS = [
  {
    id: 'uuid-600',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 600,
      title: 'No Tree Book',
      body: { value: '<p>Body content that is long enough.</p>' },
    },
  },
]

const NOBOOK_PAGE_RECORD = {
  id: 'uuid-500',
  type: 'node--page',
  attributes: {
    drupal_internal__nid: 500,
    title: 'Only A Page',
    body: { value: '<p>Just a page.</p>' },
  },
}

// node--book-only JSON:API index for hosts that publish no menu links
function bookOnlyLinks(host) {
  return { 'node--book': { href: `https://${host}/jsonapi/node/node--book` } }
}

// full JSON:API index for the menu-link happy host
const DRUPAL_LINKS = {
  'node--book': { href: 'https://drupal.example.com/jsonapi/node/node--book' },
  'node--page': { href: 'https://drupal.example.com/jsonapi/node/node--page' },
  'menu_link_content--menu_link_content': {
    href: 'https://drupal.example.com/jsonapi/menu_link_content/menu_link_content--menu_link_content',
  },
}

async function mockSafeFetch(url) {
  const u = String(url)
  fetchedUrls.push(u)
  // JSON:API index discovery (host-specific link sets)
  if (u.endsWith('/jsonapi')) {
    if (u.indexOf('dead.example.com') !== -1) {
      return mockResp({ ok: false, status: 404, json: {} })
    }
    if (u.indexOf('nolinks.example.com') !== -1) {
      return mockResp({ json: { links: { self: { href: 'https://nolinks.example.com/jsonapi' } } } })
    }
    if (u.indexOf('nobook.example.com') !== -1) {
      return mockResp({
        json: { links: { 'node--page': { href: 'https://nobook.example.com/jsonapi/node/node--page' } } },
      })
    }
    if (u.indexOf('bookfields.example.com') !== -1) {
      return mockResp({ json: { links: bookOnlyLinks('bookfields.example.com') } })
    }
    if (u.indexOf('htmlnav.example.com') !== -1) {
      return mockResp({ json: { links: bookOnlyLinks('htmlnav.example.com') } })
    }
    if (u.indexOf('notree.example.com') !== -1) {
      return mockResp({ json: { links: bookOnlyLinks('notree.example.com') } })
    }
    return mockResp({ json: { jsonapi: {}, data: [], links: DRUPAL_LINKS } })
  }
  // paged node--page collection on the happy host (page 2 repeats nid 200)
  if (u.indexOf('drupal.example.com/jsonapi/node/node--page') !== -1) {
    if (u.indexOf('page2=1') !== -1) {
      return mockResp({ json: { data: [PAGE_200_DUP], links: {} } })
    }
    return mockResp({
      json: {
        data: PAGE_RECORDS,
        links: { next: { href: 'https://drupal.example.com/jsonapi/node/node--page?page2=1' } },
      },
    })
  }
  if (u.indexOf('nobook.example.com/jsonapi/node/node--page') !== -1) {
    return mockResp({ json: { data: [NOBOOK_PAGE_RECORD], links: {} } })
  }
  // menu link collection
  if (u.indexOf('menu_link_content/menu_link_content--menu_link_content') !== -1) {
    return mockResp({ json: { data: MENU_LINKS, links: {} } })
  }
  // rendered book-navigation HTML pages for the html fallback strategy
  // (matched before the host book-collection matcher below, since the
  // /node/N page URLs also contain the host name)
  if (u.indexOf('htmlnav.example.com/node/400') !== -1) {
    return mockResp({ text: NODE_400_HTML })
  }
  if (u.indexOf('htmlnav.example.com/node/401') !== -1) {
    return mockResp({ text: NODE_401_HTML })
  }
  if (u.indexOf('htmlnav.example.com/node/402') !== -1) {
    return mockResp({ text: NODE_402_HTML })
  }
  // node--book collections per host
  if (u.indexOf('bookfields.example.com') !== -1) {
    return mockResp({ json: { data: BOOKFIELDS_BOOK_RECORDS, links: {} } })
  }
  if (u.indexOf('htmlnav.example.com') !== -1) {
    return mockResp({ json: { data: HTMLNAV_BOOK_RECORDS, links: {} } })
  }
  if (u.indexOf('notree.example.com') !== -1) {
    return mockResp({ json: { data: NOTREE_BOOK_RECORDS, links: {} } })
  }
  if (u.indexOf('node--book') !== -1) {
    return mockResp({ json: { data: BOOK_RECORDS, links: {} } })
  }
  return mockResp({ ok: false, status: 404, json: {} })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertDrupalBookToSite } = require('../../src/systemRoutes/v1/routes/imports/convertDrupalBookToSite.js')

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
  await convertDrupalBookToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('failed JSON:API discovery returns 400 with the expected-endpoint error', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(jsonReq({ repoUrl: 'https://dead.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Unable to discover Drupal JSON:API from `repoUrl`; expected `<base>/jsonapi`',
  )
})

test('a discovery index without node collections returns 400', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(jsonReq({ repoUrl: 'https://nolinks.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Drupal JSON:API discovered but no public `node--*` collections were exposed',
  )
})

test('an empty node--book collection returns 400', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(jsonReq({ repoUrl: 'https://nobook.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Drupal JSON:API is available but `node--book` has no accessible records',
  )
})

test('a book with no derivable tree returns 400 with the fallback guidance', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(jsonReq({ repoUrl: 'https://notree.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Unable to derive a Drupal book tree from public endpoints. ' +
      'Enable menu link JSON exposure (for example `menu_link_content`) or rerun with `allowHtmlFallback=true`.',
  )
})

test('menu links build the outline tree with menu selection and additional pages', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(queryReq({ repoUrl: 'https://drupal.example.com' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'course-book')
  assert.deepEqual(res.body.data.files, {})

  const items = res.body.data.items
  assert.equal(items.length, 6, 'root + 2 outline nodes + lesson + additional pages + 2 standalone')

  // the root has real content, so it becomes the outline's first item
  const root = items[0]
  assert.equal(root.title, 'Course Book')
  assert.equal(root.slug, 'course-book')
  assert.equal(root.order, 0)
  assert.equal(root.indent, 0)
  assert.equal(root.parent, null)
  assert.equal(root.contents, '<p>The course book landing page with plenty of words.</p>')
  assert.equal(root.metadata.sourceType, 'drupal-node')
  assert.equal(root.metadata.source, 'https://drupal.example.com/node/100')
  assert.equal(root.metadata.published, true)
  assert.equal(root.metadata.drupal.nid, 100)
  assert.equal(root.metadata.drupal.uuid, 'uuid-100')
  assert.equal(root.metadata.drupal.type, 'node--book')
  assert.equal(root.metadata.drupal.rootNid, 100)
  assert.equal(root.metadata.drupal.inOutline, true)
  assert.equal(root.metadata.drupal.isBookRoot, true)

  // unit 1 nests under the root with its root-relative link absolutized
  const unit1 = items[1]
  assert.equal(unit1.title, 'Unit 1')
  assert.equal(unit1.slug, 'course-book/unit-1')
  assert.equal(unit1.order, 0)
  assert.equal(unit1.indent, 1)
  assert.equal(unit1.parent, root.id)
  assert.equal(
    unit1.contents,
    '<p>Unit one with a <a href="https://drupal.example.com/local">link</a>.</p>',
  )

  // the lesson nests two levels deep under unit 1
  const lesson = items[2]
  assert.equal(lesson.title, 'Unit 1 Lesson')
  assert.equal(lesson.slug, 'course-book/unit-1/unit-1-lesson')
  assert.equal(lesson.indent, 2)
  assert.equal(lesson.parent, unit1.id)

  // unit 2's menu lives in the smaller "other" menu and never made the tree
  assert.equal(items.filter((item) => item.slug === 'course-book/unit-2').length, 0)

  // unlinked nodes land under a hidden additional-pages group
  const additional = items[3]
  assert.equal(additional.title, 'additional pages')
  assert.equal(additional.slug, 'additional-pages')
  assert.equal(additional.indent, 0)
  assert.equal(additional.contents, '<p></p>')
  assert.equal(additional.metadata.hideInMenu, true)
  assert.equal(additional.metadata.sourceType, 'drupal-additional-pages')

  // additional pages sort by title: "Node 201" (empty-title fallback) first
  assert.equal(items[4].title, 'Node 201')
  assert.equal(items[4].slug, 'additional-pages/node-201')
  assert.equal(items[4].order, 0)
  assert.equal(items[4].indent, 1)
  assert.equal(items[4].parent, additional.id)
  assert.equal(items[4].metadata.drupal.inOutline, false)
  assert.equal(items[5].title, 'Standalone Page')
  assert.equal(items[5].slug, 'additional-pages/standalone')
  assert.equal(items[5].order, 1)

  // import stats: 6 total nodes, 4 book nodes, 3 in the outline (102 excluded),
  // 2 additional; the paged node--page collection followed links.next
  assert.deepEqual(res.body.data.drupal, {
    base: 'https://drupal.example.com',
    rootNid: 100,
    rootStructural: false,
    treeSource: 'menu-link-content',
    totalNodes: 6,
    bookNodes: 4,
    outlineNodes: 3,
    additionalNodes: 2,
    htmlFallbackUsed: false,
  })
  const pageFetches = fetchedUrls.filter((u) => u.indexOf('node--page') !== -1)
  assert.equal(pageFetches.length, 2, 'node--page collection paged through links.next')
})

test('book fields build the tree when menu links are not published', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(jsonReq({ repoUrl: 'https://bookfields.example.com' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)

  const items = res.body.data.items
  assert.equal(items.length, 3, 'structural root promotes its chapters to top level')

  assert.equal(items[0].title, 'Chapter One')
  assert.equal(items[0].slug, 'chapter-one')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].indent, 0)
  assert.equal(items[0].parent, null)
  assert.equal(items[0].contents, '<p>Chapter one body text here.</p>')

  assert.equal(items[1].title, 'Chapter Two')
  assert.equal(items[1].slug, 'chapter-two')
  assert.equal(items[1].order, 1)

  // legacy book_parent/book_weight attrs participate, and the duplicate
  // /chapter-one alias segment gets uniquified with the nid
  assert.equal(items[2].title, 'Chapter Three')
  assert.equal(items[2].slug, 'chapter-one-303')
  assert.equal(items[2].order, 2)

  assert.equal(res.body.data.filename, 'handbook')
  assert.deepEqual(res.body.data.drupal, {
    base: 'https://bookfields.example.com',
    rootNid: 300,
    rootStructural: true,
    treeSource: 'book-fields',
    totalNodes: 4,
    bookNodes: 4,
    outlineNodes: 4,
    additionalNodes: 0,
    htmlFallbackUsed: false,
  })
})

test('allowHtmlFallback rebuilds the tree from book-navigation markup', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(
    jsonReq({ repoUrl: 'https://htmlnav.example.com', allowHtmlFallback: true }),
    res,
  )
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)

  const items = res.body.data.items
  assert.equal(items.length, 2, 'structural root promotes nav children to top level')
  assert.equal(items[0].title, 'Nav Unit 1')
  assert.equal(items[0].slug, 'nav-unit-1')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].indent, 0)
  assert.equal(items[0].parent, null)
  assert.equal(items[1].title, 'Nav Unit 2')
  assert.equal(items[1].slug, 'nav-unit-1/nav-unit-2')
  assert.equal(items[1].indent, 1)
  assert.equal(items[1].parent, items[0].id)

  assert.equal(res.body.data.filename, 'nav-book')
  assert.deepEqual(res.body.data.drupal, {
    base: 'https://htmlnav.example.com',
    rootNid: 400,
    rootStructural: true,
    treeSource: 'html-navigation',
    totalNodes: 3,
    bookNodes: 3,
    outlineNodes: 3,
    additionalNodes: 0,
    htmlFallbackUsed: true,
  })
})

test('allowHtmlFallback without navigation markup falls back to a flat root item', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(
    jsonReq({ repoUrl: 'https://notree.example.com', allowHtmlFallback: true }),
    res,
  )
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  const items = res.body.data.items
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'No Tree Book')
  assert.equal(items[0].slug, 'no-tree-book')
  assert.equal(res.body.data.drupal.treeSource, 'html-navigation')
  assert.equal(res.body.data.drupal.htmlFallbackUsed, true)
})

test('parentId threads through to outline root items', async () => {
  const res = stubRes()
  await convertDrupalBookToSite(
    jsonReq({ repoUrl: 'https://drupal.example.com', parentId: 'node-77' }),
    res,
  )
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items[0].parent, 'node-77')
  // outline children still point at their generated parent item
  assert.equal(res.body.data.items[1].parent, res.body.data.items[0].id)
})
