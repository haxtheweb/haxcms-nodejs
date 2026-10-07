'use strict'

// Unit tests for convertDrupalToSite: discovers a Drupal JSON:API base from a
// repoUrl (<base>/jsonapi index), reads pages from node--page (+ node--book
// when present), builds the files map from file--file (skipping temporary /
// extension-blocked / private-stream records), resolves media embeds
// (<drupal-media> placeholders and field_media refs) into HAX elements
// (media-image, video-player, media-playlist + audio-player, document links),
// rewrites body file URLs to files/... references, and builds the outline
// through four strategies: a menu-items endpoint (jsonapi_menu_items flat and
// jsonapi_frontend_menu nested payloads), menu_link_content forests,
// node--book book fields, and a flat created-ordered fallback.
//
// safeFetch is mocked by mutating the shared module export BEFORE the
// converter is required, since the converter destructures { safeFetch } at
// require time (same pattern as the old convert-drupalbook-to-site suite).
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining
// (explicit && guards), node:test + node:assert/strict.

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

// ---- host drupal.example.com: grovecenter-style, no menu-items module ----
// Full features: paged node--page collection, file--file with skip reasons,
// four media bundles, main+footer+account menus (account is denylisted from
// probing), and a body-null page whose content arrives via field_media.

const PAGE_RECORDS = [
  {
    id: 'page-8-uuid',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 8,
      title: 'Home',
      body: {
        value:
          '<p>Welcome text.</p>' +
          '<p><img src="/sites/default/files/2024-06/photo.jpg" alt="photo"></p>' +
          '<p><drupal-media data-entity-uuid="media-audio-1" data-view-mode="default"></drupal-media></p>' +
          '<p><a href="/about-us">About</a></p>',
      },
      path: { alias: '/home' },
      status: true,
      created: '2024-06-01T10:00:00+00:00',
    },
  },
  {
    id: 'page-10-uuid',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 10,
      title: 'Student Development',
      body: null,
      path: { alias: '/undergrads/student-development' },
      status: true,
      created: '2024-06-02T10:00:00+00:00',
    },
    relationships: {
      field_media: { data: { type: 'media--image', id: 'media-image-1' } },
    },
  },
  {
    id: 'page-12-uuid',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 12,
      title: 'Community',
      body: { value: '<p>Community page text.</p>' },
      path: { alias: '/community' },
      created: '2024-06-03T10:00:00+00:00',
    },
  },
  {
    id: 'page-14-uuid',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 14,
      title: 'Orphan Page',
      body: { value: '<p>Not in any menu.</p>' },
      created: '2024-06-04T10:00:00+00:00',
    },
  },
  {
    id: 'page-16-uuid',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 16,
      title: 'Footer Only',
      body: { value: '<p>Footer linked content.</p>' },
      created: '2024-06-05T10:00:00+00:00',
    },
  },
]

const PAGE_10_DUP = {
  id: 'page-10-dup-uuid',
  type: 'node--page',
  attributes: {
    drupal_internal__nid: 10,
    title: 'Duplicate Student Development',
    body: { value: '<p>dup</p>' },
  },
}

const FILE_RECORDS = [
  {
    id: 'file-photo',
    type: 'file--file',
    attributes: {
      drupal_internal__fid: 1,
      filename: 'photo.jpg',
      uri: {
        value: 'public://2024-06/photo.jpg',
        url: '/sites/default/files/2024-06/photo.jpg',
      },
      filemime: 'image/jpeg',
      filesize: 16499,
      status: true,
    },
  },
  {
    id: 'file-temp',
    type: 'file--file',
    attributes: {
      drupal_internal__fid: 2,
      filename: 'temp.jpg',
      uri: { value: 'public://2024-06/temp.jpg', url: '/sites/default/files/2024-06/temp.jpg' },
      filemime: 'image/jpeg',
      status: false,
    },
  },
  {
    id: 'file-exe',
    type: 'file--file',
    attributes: {
      drupal_internal__fid: 3,
      filename: 'virus.exe',
      uri: { value: 'public://2024-06/virus.exe', url: '/sites/default/files/2024-06/virus.exe' },
      filemime: 'application/octet-stream',
      status: true,
    },
  },
  {
    id: 'file-private',
    type: 'file--file',
    attributes: {
      drupal_internal__fid: 4,
      filename: 'secret.pdf',
      uri: { value: 'private://docs/secret.pdf' },
      filemime: 'application/pdf',
      status: true,
    },
  },
  {
    id: 'file-doc',
    type: 'file--file',
    attributes: {
      drupal_internal__fid: 5,
      filename: 'report.pdf',
      uri: {
        value: 'public://2024-06/report.pdf',
        url: '/sites/default/files/2024-06/report.pdf',
      },
      filemime: 'application/pdf',
      status: true,
    },
  },
  {
    id: 'file-audio',
    type: 'file--file',
    attributes: {
      drupal_internal__fid: 6,
      filename: 'track.mp3',
      uri: {
        value: 'public://2024-06/track.mp3',
        url: '/sites/default/files/2024-06/track.mp3',
      },
      filemime: 'audio/mpeg',
      status: true,
    },
  },
]

const MEDIA_IMAGE_RECORDS = [
  {
    id: 'media-image-1',
    type: 'media--image',
    attributes: { drupal_internal__mid: 1, name: 'photo.jpg' },
    relationships: {
      field_media_image: {
        data: {
          type: 'file--file',
          id: 'file-photo',
          meta: { alt: 'cartoon cat', title: '', width: 220, height: 220 },
        },
      },
    },
  },
]

const MEDIA_AUDIO_RECORDS = [
  {
    id: 'media-audio-1',
    type: 'media--audio',
    attributes: { drupal_internal__mid: 2, name: 'track.mp3' },
    relationships: {
      field_media_audio: {
        data: { type: 'file--file', id: 'file-audio', meta: { title: 'Track one' } },
      },
    },
  },
]

const MEDIA_REMOTE_VIDEO_RECORDS = [
  {
    id: 'media-video-1',
    type: 'media--remote_video',
    attributes: {
      drupal_internal__mid: 3,
      name: 'Intro video',
      field_media_oembed_video: 'https://www.youtube.com/watch?v=abc123',
    },
  },
]

const MEDIA_DOCUMENT_RECORDS = [
  {
    id: 'media-doc-1',
    type: 'media--document',
    attributes: { drupal_internal__mid: 4, name: 'report.pdf' },
    relationships: {
      field_media_document: {
        data: { type: 'file--file', id: 'file-doc', meta: {} },
      },
    },
  },
]

// main menu: Home -> (Student Development, Community); footer: Community
// (duplicate of main) + Footer Only; account menu is denylisted from probes.
const MENU_LINK_RECORDS = [
  {
    id: 'ml-home',
    type: 'menu_link_content--menu_link_content',
    attributes: { menu_name: 'main', link: { uri: 'entity:node/8' }, weight: -10 },
  },
  {
    id: 'ml-student',
    type: 'menu_link_content--menu_link_content',
    attributes: {
      menu_name: 'main',
      link: { uri: 'internal:/node/10' },
      weight: 0,
      parent: 'menu_link_content:ml-home',
    },
  },
  {
    id: 'ml-community',
    type: 'menu_link_content--menu_link_content',
    attributes: { menu_name: 'main', link: { uri: 'https://drupal.example.com/node/12' }, weight: 1 },
    relationships: { parent: { data: { id: 'ml-home', type: 'menu_link_content--menu_link_content' } } },
  },
  {
    id: 'ml-footer-community',
    type: 'menu_link_content--menu_link_content',
    attributes: { menu_name: 'footer', link: { uri: 'entity:node/12' }, weight: 0 },
  },
  {
    id: 'ml-footer-only',
    type: 'menu_link_content--menu_link_content',
    attributes: { menu_name: 'footer', link: { uri: 'entity:node/16' }, weight: 5 },
  },
  {
    id: 'ml-account',
    type: 'menu_link_content--menu_link_content',
    attributes: { menu_name: 'account', link: { uri: 'entity:node/8' }, weight: 0 },
  },
]

const MENU_ENTITY_RECORDS = [
  { id: 'menu-uuid-main', type: 'menu--menu', attributes: { drupal_internal__id: 'main', label: 'Main navigation' } },
  { id: 'menu-uuid-footer', type: 'menu--menu', attributes: { drupal_internal__id: 'footer', label: 'Footer' } },
  { id: 'menu-uuid-account', type: 'menu--menu', attributes: { drupal_internal__id: 'account', label: 'User account menu' } },
]

const DRUPAL_LINKS = {
  'node--page': { href: 'https://drupal.example.com/jsonapi/node/page' },
  'file--file': { href: 'https://drupal.example.com/jsonapi/file/file' },
  'media--image': { href: 'https://drupal.example.com/jsonapi/media/image' },
  'media--audio': { href: 'https://drupal.example.com/jsonapi/media/audio' },
  'media--remote_video': { href: 'https://drupal.example.com/jsonapi/media/remote_video' },
  'media--document': { href: 'https://drupal.example.com/jsonapi/media/document' },
  'menu_link_content--menu_link_content': {
    href: 'https://drupal.example.com/jsonapi/menu_link_content/menu_link_content',
  },
  'menu--menu': { href: 'https://drupal.example.com/jsonapi/menu/menu' },
}

// ---- host menuitems.example.com: jsonapi_menu_items installed (flat) ----

const MI_PAGE_RECORDS = [
  {
    id: 'mi-page-400',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 400,
      title: 'Landing',
      body: { value: '<p>Landing body text.</p>' },
      path: { alias: '/landing' },
      created: '2024-01-01T00:00:00+00:00',
    },
  },
  {
    id: 'mi-page-401',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 401,
      title: 'Sub One',
      body: { value: '<p>Sub one body.</p>' },
      path: { alias: '/sub-one' },
      created: '2024-01-02T00:00:00+00:00',
    },
  },
  {
    id: 'mi-page-402',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 402,
      title: 'Sub Two',
      body: { value: '<p>Sub two body.</p>' },
      path: { alias: '/sub-two' },
      created: '2024-01-03T00:00:00+00:00',
    },
  },
  {
    id: 'mi-page-403',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 403,
      title: 'News Item',
      body: { value: '<p>A news article body.</p>' },
      path: { alias: '/news-item' },
      created: '2024-01-04T00:00:00+00:00',
    },
  },
]

// jsonapi_menu_items payload: flat collection keyed by plugin id, parent
// plugin-id refs, entity.node.canonical route parameters (one as a string),
// and a views link whose nid-linked child promotes to the nearest ancestor.
const MENU_ITEMS_PAYLOAD = {
  jsonapi: { version: '1.1' },
  data: [
    {
      type: 'menu_link_content--menu_link_content',
      id: 'menu_link_content:link-a',
      attributes: {
        enabled: true,
        expanded: false,
        menu_name: 'main',
        parent: '',
        route: { name: 'entity.node.canonical', parameters: { node: 400 } },
        title: 'Landing',
        url: '/landing',
        weight: 0,
      },
    },
    {
      type: 'menu_link_content--menu_link_content',
      id: 'menu_link_content:link-b',
      attributes: {
        menu_name: 'main',
        parent: 'menu_link_content:link-a',
        route: { name: 'entity.node.canonical', parameters: { node: '401' } },
        title: 'Sub One',
        url: '/sub-one',
        weight: 0,
      },
    },
    {
      type: 'menu_link_content--menu_link_content',
      id: 'menu_link_content:link-c',
      attributes: {
        menu_name: 'main',
        parent: 'menu_link_content:link-a',
        route: { name: 'entity.node.canonical', parameters: { node: 402 } },
        title: 'Sub Two',
        url: '/sub-two',
        weight: 1,
      },
    },
    {
      type: 'menu_link_content--menu_link_content',
      id: 'views_view:view.news_page',
      attributes: {
        menu_name: 'main',
        parent: '',
        route: { name: 'view.news.page', parameters: {} },
        title: 'News',
        url: '/news',
        weight: 10,
      },
    },
    {
      type: 'menu_link_content--menu_link_content',
      id: 'menu_link_content:link-d',
      attributes: {
        menu_name: 'main',
        parent: 'views_view:view.news_page',
        route: { name: 'entity.node.canonical', parameters: { node: 403 } },
        title: 'News Item',
        url: '/news-item',
        weight: 0,
      },
    },
  ],
}

// ---- host frontendmenu.example.com: jsonapi_frontend_menu (nested) ----

const FM_PAGE_RECORDS = [
  {
    id: 'fm-page-400',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 400,
      title: 'Landing',
      body: { value: '<p>Landing body.</p>' },
      path: { alias: '/landing' },
      created: '2024-02-01T00:00:00+00:00',
    },
  },
  {
    id: 'fm-page-401',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 401,
      title: 'Sub One',
      body: { value: '<p>Sub one body.</p>' },
      path: { alias: '/sub-one' },
      created: '2024-02-02T00:00:00+00:00',
    },
  },
]

// nested-children payload; nids resolve through the alias map fallback since
// these links carry no route parameters
const FRONTEND_MENU_PAYLOAD = [
  {
    title: 'Landing',
    url: '/landing',
    weight: 0,
    children: [
      { title: 'Sub One', url: '/sub-one', weight: 0, children: [] },
    ],
  },
  { title: 'External', url: 'https://elsewhere.example.org/', weight: 5 },
]

// ---- host bookfields.example.com: node--book only, book-field forest ----

const BOOKFIELDS_BOOK_RECORDS = [
  {
    id: 'uuid-300',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 300,
      title: 'Handbook',
      body: null,
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
    id: 'uuid-310',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 310,
      title: 'Second Book',
      body: { value: '<p>Second book intro text.</p>' },
      book: { pid: 0, weight: 0 },
      path: { alias: '/second-book' },
    },
  },
  {
    id: 'uuid-311',
    type: 'node--book',
    attributes: {
      drupal_internal__nid: 311,
      title: 'Second Book Child',
      body: { value: '<p>Child page body text.</p>' },
      book: { pid: 310, weight: 0 },
      path: { alias: '/second-book-child' },
    },
  },
]

// ---- host flat.example.com: no menu structure at all ----

const FLAT_PAGE_RECORDS = [
  {
    id: 'flat-50',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 50,
      title: 'Zebra',
      body: { value: '<p>Zebra body.</p>' },
      created: '2024-01-02T00:00:00+00:00',
    },
  },
  {
    id: 'flat-51',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 51,
      title: 'Alpha',
      body: { value: '<p>Alpha body.</p>' },
      created: '2024-01-01T00:00:00+00:00',
    },
  },
  {
    id: 'flat-52',
    type: 'node--page',
    attributes: {
      drupal_internal__nid: 52,
      title: 'Middle',
      body: { value: '<p>Middle body.</p>' },
      created: '2024-01-03T00:00:00+00:00',
    },
  },
]

// menu--menu entities for the probe host (drupal_internal__id is the machine
// name; the JSON:API id is a uuid)
const PROBE_MENU_ENTITY_RECORDS = [
  { id: 'probe-menu-main', type: 'menu--menu', attributes: { drupal_internal__id: 'main', label: 'Main navigation' } },
  { id: 'probe-menu-footer', type: 'menu--menu', attributes: { drupal_internal__id: 'footer', label: 'Footer' } },
]

async function mockSafeFetch(url) {
  const u = String(url)
  fetchedUrls.push(u)

  // JSON:API index discovery (host-specific link sets)
  if (u.endsWith('/jsonapi')) {
    if (u.indexOf('dead.example.com') !== -1) {
      return mockResp({ ok: false, status: 404, json: {} })
    }
    if (u.indexOf('nonodes.example.com') !== -1) {
      return mockResp({
        json: { links: { 'node--news': { href: 'https://nonodes.example.com/jsonapi/node/news' } } },
      })
    }
    if (u.indexOf('norecords.example.com') !== -1) {
      return mockResp({
        json: { links: { 'node--page': { href: 'https://norecords.example.com/jsonapi/node/page' } } },
      })
    }
    if (u.indexOf('menuitems.example.com') !== -1) {
      return mockResp({
        json: {
          links: {
            'node--page': { href: 'https://menuitems.example.com/jsonapi/node/page' },
            'menu--menu': { href: 'https://menuitems.example.com/jsonapi/menu/menu' },
          },
        },
      })
    }
    if (u.indexOf('frontendmenu.example.com') !== -1) {
      return mockResp({
        json: {
          links: {
            'node--page': { href: 'https://frontendmenu.example.com/jsonapi/node/page' },
            'menu--menu': { href: 'https://frontendmenu.example.com/jsonapi/menu/menu' },
          },
        },
      })
    }
    if (u.indexOf('bookfields.example.com') !== -1) {
      return mockResp({
        json: { links: { 'node--book': { href: 'https://bookfields.example.com/jsonapi/node/book' } } },
      })
    }
    if (u.indexOf('flat.example.com') !== -1) {
      return mockResp({
        json: { links: { 'node--page': { href: 'https://flat.example.com/jsonapi/node/page' } } },
      })
    }
    return mockResp({ json: { jsonapi: {}, data: [], links: DRUPAL_LINKS } })
  }

  // menu-items endpoint probes (matched before collection matchers)
  if (u.indexOf('menuitems.example.com/jsonapi/menu_items/main') !== -1) {
    return mockResp({ json: MENU_ITEMS_PAYLOAD })
  }
  if (u.indexOf('frontendmenu.example.com/jsonapi/menu_items/main') !== -1) {
    return mockResp({ ok: false, status: 404, json: {} })
  }
  if (u.indexOf('frontendmenu.example.com/jsonapi/menu/main') !== -1) {
    return mockResp({ json: FRONTEND_MENU_PAYLOAD })
  }

  // menu--menu config collections (must match before the generic probe 404)
  if (u.indexOf('drupal.example.com/jsonapi/menu/menu') !== -1) {
    return mockResp({ json: { data: MENU_ENTITY_RECORDS, links: {} } })
  }
  if (u.indexOf('/jsonapi/menu/menu') !== -1) {
    return mockResp({ json: { data: PROBE_MENU_ENTITY_RECORDS, links: {} } })
  }

  // host drupal.example.com collections
  if (u.indexOf('drupal.example.com/jsonapi/node/page') !== -1) {
    if (u.indexOf('page2=1') !== -1) {
      return mockResp({ json: { data: [PAGE_10_DUP], links: {} } })
    }
    return mockResp({
      json: {
        data: PAGE_RECORDS,
        links: { next: { href: 'https://drupal.example.com/jsonapi/node/page?page2=1' } },
      },
    })
  }
  if (u.indexOf('drupal.example.com/jsonapi/file/file') !== -1) {
    return mockResp({ json: { data: FILE_RECORDS, links: {} } })
  }
  if (u.indexOf('drupal.example.com/jsonapi/media/image') !== -1) {
    return mockResp({ json: { data: MEDIA_IMAGE_RECORDS, links: {} } })
  }
  if (u.indexOf('drupal.example.com/jsonapi/media/audio') !== -1) {
    return mockResp({ json: { data: MEDIA_AUDIO_RECORDS, links: {} } })
  }
  if (u.indexOf('drupal.example.com/jsonapi/media/remote_video') !== -1) {
    return mockResp({ json: { data: MEDIA_REMOTE_VIDEO_RECORDS, links: {} } })
  }
  if (u.indexOf('drupal.example.com/jsonapi/media/document') !== -1) {
    return mockResp({ json: { data: MEDIA_DOCUMENT_RECORDS, links: {} } })
  }
  if (u.indexOf('menu_link_content/menu_link_content') !== -1) {
    return mockResp({ json: { data: MENU_LINK_RECORDS, links: {} } })
  }

  // other host page collections
  if (u.indexOf('menuitems.example.com/jsonapi/node/page') !== -1) {
    return mockResp({ json: { data: MI_PAGE_RECORDS, links: {} } })
  }
  if (u.indexOf('frontendmenu.example.com/jsonapi/node/page') !== -1) {
    return mockResp({ json: { data: FM_PAGE_RECORDS, links: {} } })
  }
  if (u.indexOf('bookfields.example.com/jsonapi/node/book') !== -1) {
    return mockResp({ json: { data: BOOKFIELDS_BOOK_RECORDS, links: {} } })
  }
  if (u.indexOf('flat.example.com/jsonapi/node/page') !== -1) {
    return mockResp({ json: { data: FLAT_PAGE_RECORDS, links: {} } })
  }
  if (u.indexOf('norecords.example.com/jsonapi/node/page') !== -1) {
    return mockResp({ json: { data: [], links: {} } })
  }

  // any other menu-items endpoint probe 404s (module not installed)
  if (/\/jsonapi\/(menu_items|menu|jsonapi_menu)\//.test(u)) {
    return mockResp({ ok: false, status: 404, json: {} })
  }
  return mockResp({ ok: false, status: 404, json: {} })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertDrupalToSite, LIMITS } = require('../../src/systemRoutes/v1/routes/imports/convertDrupalToSite.js')

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
  await convertDrupalToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('failed JSON:API discovery returns 400 with the expected-endpoint error', async () => {
  const res = stubRes()
  await convertDrupalToSite(jsonReq({ repoUrl: 'https://dead.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Unable to discover Drupal JSON:API from `repoUrl`; expected `<base>/jsonapi`',
  )
})

test('a discovery index without page or book collections returns 400 listing what was found', async () => {
  const res = stubRes()
  await convertDrupalToSite(jsonReq({ repoUrl: 'https://nonodes.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Drupal JSON:API discovered but neither `node--page` nor `node--book` collections were exposed (found: node--news)',
  )
})

test('an empty page collection returns 400', async () => {
  const res = stubRes()
  await convertDrupalToSite(jsonReq({ repoUrl: 'https://norecords.example.com' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(
    res.body.data.error,
    'Drupal JSON:API is available but neither `node--page` nor `node--book` has accessible records',
  )
})

test('menu link forest builds the outline with files, media, and additional pages', async () => {
  const res = stubRes()
  await convertDrupalToSite(queryReq({ repoUrl: 'https://drupal.example.com' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'drupal-example-com')

  // files map: allowed extensions keyed by Drupal-relative path -> source URL
  assert.deepEqual(res.body.data.files, {
    '2024-06/photo.jpg': 'https://drupal.example.com/sites/default/files/2024-06/photo.jpg',
    '2024-06/report.pdf': 'https://drupal.example.com/sites/default/files/2024-06/report.pdf',
    '2024-06/track.mp3': 'https://drupal.example.com/sites/default/files/2024-06/track.mp3',
  })

  const items = res.body.data.items
  assert.equal(items.length, 6, 'home + 2 children + footer-only + additional pages + orphan')

  // the main-menu top link becomes the outline's first item
  const home = items[0]
  assert.equal(home.title, 'Home')
  assert.equal(home.slug, 'home')
  assert.equal(home.order, 0)
  assert.equal(home.indent, 0)
  assert.equal(home.parent, null)
  assert.equal(home.metadata.sourceType, 'drupal-node')
  assert.equal(home.metadata.source, 'https://drupal.example.com/node/8')
  assert.equal(home.metadata.published, true)
  assert.equal(home.metadata.drupal.nid, 8)
  assert.equal(home.metadata.drupal.uuid, 'page-8-uuid')
  assert.equal(home.metadata.drupal.type, 'node--page')
  assert.equal(home.metadata.drupal.inOutline, true)

  // body file URL rewritten to the files/ reference, media embed resolved to
  // media-playlist + audio-player, and the unlinked href absolutized
  assert.ok(home.contents.indexOf('src="files/2024-06/photo.jpg"') !== -1, 'img src rewritten to files/')
  assert.ok(
    home.contents.indexOf(
      '<media-playlist><audio-player source="files/2024-06/track.mp3" media-title="Track one"></audio-player></media-playlist>',
    ) !== -1,
    'audio media embed resolves to media-playlist + audio-player',
  )
  assert.ok(
    home.contents.indexOf('href="https://drupal.example.com/about-us"') !== -1,
    'unlinked href absolutized',
  )
  assert.equal(home.contents.indexOf('sites/default/files'), -1, 'no raw Drupal file URLs remain')

  // body-null page renders its field_media image as content
  const student = items[1]
  assert.equal(student.title, 'Student Development')
  assert.equal(student.slug, 'home/student-development')
  assert.equal(student.order, 0)
  assert.equal(student.indent, 1)
  assert.equal(student.parent, home.id)
  assert.equal(
    student.contents,
    '<media-image source="files/2024-06/photo.jpg" alt="cartoon cat"></media-image>',
  )

  const community = items[2]
  assert.equal(community.title, 'Community')
  assert.equal(community.slug, 'home/community')
  assert.equal(community.order, 1)
  assert.equal(community.indent, 1)
  assert.equal(community.parent, home.id)
  assert.equal(community.contents, '<p>Community page text.</p>')

  // footer-only link appends as a top-level item after the forest
  const footerOnly = items[3]
  assert.equal(footerOnly.title, 'Footer Only')
  assert.equal(footerOnly.slug, 'footer-only')
  assert.equal(footerOnly.order, 1)
  assert.equal(footerOnly.indent, 0)
  assert.equal(footerOnly.parent, null)

  // unlinked pages land under a hidden additional-pages group
  const additional = items[4]
  assert.equal(additional.title, 'additional pages')
  assert.equal(additional.slug, 'additional-pages')
  assert.equal(additional.indent, 0)
  assert.equal(additional.contents, '<p></p>')
  assert.equal(additional.metadata.hideInMenu, true)
  assert.equal(additional.metadata.sourceType, 'drupal-additional-pages')

  const orphan = items[5]
  assert.equal(orphan.title, 'Orphan Page')
  assert.equal(orphan.slug, 'additional-pages/orphan-page')
  assert.equal(orphan.order, 0)
  assert.equal(orphan.indent, 1)
  assert.equal(orphan.parent, additional.id)
  assert.equal(orphan.metadata.drupal.inOutline, false)

  // import stats: probes fell through to menu_link_content; file skip
  // reasons counted; all four media bundles resolved
  assert.deepEqual(res.body.data.drupal, {
    base: 'https://drupal.example.com',
    pagesTotal: 5,
    booksTotal: 0,
    outlineSource: 'menu-link-content',
    outlineNodes: 4,
    additionalNodes: 1,
    filesTotal: 6,
    filesImported: 3,
    filesSkipped: { temporary: 1, extension: 1, 'no-url': 1 },
    mediaTotal: 4,
    mediaResolved: 4,
    mediaUnresolved: 0,
    truncated: false,
  })

  // the paged node--page collection followed links.next (dedupe first-wins
  // kept the original nid 10 title)
  const pageFetches = fetchedUrls.filter((u) => u.indexOf('drupal.example.com/jsonapi/node/page') !== -1)
  assert.equal(pageFetches.length, 2, 'node--page collection paged through links.next')
  assert.ok(
    items.every((item) => item.title !== 'Duplicate Student Development'),
    'duplicate nid kept the first record',
  )

  // menu-items probes all 404ed for main + footer (account is denylisted);
  // the menu--menu collection URL also matches the /jsonapi/menu/ pattern so
  // it is excluded from the probe count
  const probeFetches = fetchedUrls.filter(
    (u) => /\/jsonapi\/(menu_items|menu|jsonapi_menu)\//.test(u) && u.indexOf('/jsonapi/menu/menu') === -1,
  )
  assert.equal(probeFetches.length, 6, 'six probe attempts (main + footer across 3 endpoint patterns)')
  assert.ok(
    !probeFetches.some((u) => u.endsWith('/account')),
    'the account system menu is never probed',
  )
})

test('jsonapi_menu_items payload drives the outline with parent plugin ids and route parameters', async () => {
  const res = stubRes()
  await convertDrupalToSite(jsonReq({ repoUrl: 'https://menuitems.example.com' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'menuitems-example-com')
  assert.deepEqual(res.body.data.files, {})

  const items = res.body.data.items
  assert.equal(items.length, 4, 'all four pages placed by the menu-items payload')

  const landing = items[0]
  assert.equal(landing.title, 'Landing')
  assert.equal(landing.slug, 'landing')
  assert.equal(landing.order, 0)
  assert.equal(landing.indent, 0)
  assert.equal(landing.parent, null)

  // children nest via parent plugin-id refs; string node params normalize
  const subOne = items[1]
  assert.equal(subOne.title, 'Sub One')
  assert.equal(subOne.slug, 'landing/sub-one')
  assert.equal(subOne.order, 0)
  assert.equal(subOne.indent, 1)
  assert.equal(subOne.parent, landing.id)

  const subTwo = items[2]
  assert.equal(subTwo.title, 'Sub Two')
  assert.equal(subTwo.slug, 'landing/sub-two')
  assert.equal(subTwo.order, 1)
  assert.equal(subTwo.indent, 1)
  assert.equal(subTwo.parent, landing.id)

  // the news item's parent is a views link (no nid) so it promotes to the
  // nearest resolvable ancestor: top level, after the landing tree
  const newsItem = items[3]
  assert.equal(newsItem.title, 'News Item')
  assert.equal(newsItem.slug, 'news-item')
  assert.equal(newsItem.order, 1)
  assert.equal(newsItem.indent, 0)
  assert.equal(newsItem.parent, null)

  assert.deepEqual(res.body.data.drupal, {
    base: 'https://menuitems.example.com',
    pagesTotal: 4,
    booksTotal: 0,
    outlineSource: 'menu-items',
    outlineNodes: 4,
    additionalNodes: 0,
    filesTotal: 0,
    filesImported: 0,
    filesSkipped: {},
    mediaTotal: 0,
    mediaResolved: 0,
    mediaUnresolved: 0,
    truncated: false,
  })

  // the main probe won immediately; the footer menu was never probed
  assert.ok(
    fetchedUrls.some((u) => u.indexOf('menuitems.example.com/jsonapi/menu_items/main') !== -1),
    'menu_items/main probed',
  )
  assert.ok(
    !fetchedUrls.some((u) => u.indexOf('menu_items/footer') !== -1),
    'later menus are not probed once main resolves',
  )
})

test('nested-children menu payload drives the outline after the first probe 404s', async () => {
  const res = stubRes()
  await convertDrupalToSite(jsonReq({ repoUrl: 'https://frontendmenu.example.com' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)

  const items = res.body.data.items
  assert.equal(items.length, 2, 'external link skipped, nested child placed')

  const landing = items[0]
  assert.equal(landing.title, 'Landing')
  assert.equal(landing.slug, 'landing')
  assert.equal(landing.indent, 0)
  assert.equal(landing.parent, null)

  const subOne = items[1]
  assert.equal(subOne.title, 'Sub One')
  assert.equal(subOne.slug, 'landing/sub-one')
  assert.equal(subOne.indent, 1)
  assert.equal(subOne.parent, landing.id)

  assert.equal(res.body.data.drupal.outlineSource, 'menu-items')

  // endpoint pattern preference: menu_items 404ed before /jsonapi/menu hit
  const menuItemsProbe = fetchedUrls.findIndex(
    (u) => u.indexOf('frontendmenu.example.com/jsonapi/menu_items/main') !== -1,
  )
  const menuProbe = fetchedUrls.findIndex(
    (u) => u.indexOf('frontendmenu.example.com/jsonapi/menu/main') !== -1,
  )
  assert.ok(menuItemsProbe !== -1 && menuProbe !== -1 && menuItemsProbe < menuProbe)
})

test('book fields build a forest of two books with structural root demotion', async () => {
  const res = stubRes()
  await convertDrupalToSite(jsonReq({ repoUrl: 'https://bookfields.example.com' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'bookfields-example-com')

  const items = res.body.data.items
  // the empty Handbook root demotes its chapters; Second Book keeps its intro
  assert.equal(items.length, 4)

  assert.equal(items[0].title, 'Chapter One')
  assert.equal(items[0].slug, 'chapter-one')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].indent, 0)
  assert.equal(items[0].parent, null)
  assert.equal(items[0].contents, '<p>Chapter one body text here.</p>')

  assert.equal(items[1].title, 'Chapter Two')
  assert.equal(items[1].slug, 'chapter-two')
  assert.equal(items[1].order, 1)
  assert.equal(items[1].indent, 0)

  assert.equal(items[2].title, 'Second Book')
  assert.equal(items[2].slug, 'second-book')
  assert.equal(items[2].order, 2)
  assert.equal(items[2].indent, 0)
  assert.equal(items[2].contents, '<p>Second book intro text.</p>')

  assert.equal(items[3].title, 'Second Book Child')
  assert.equal(items[3].slug, 'second-book/second-book-child')
  assert.equal(items[3].order, 0)
  assert.equal(items[3].indent, 1)
  assert.equal(items[3].parent, items[2].id)

  assert.deepEqual(res.body.data.drupal, {
    base: 'https://bookfields.example.com',
    pagesTotal: 0,
    booksTotal: 5,
    outlineSource: 'book-fields',
    outlineNodes: 4,
    additionalNodes: 0,
    filesTotal: 0,
    filesImported: 0,
    filesSkipped: {},
    mediaTotal: 0,
    mediaResolved: 0,
    mediaUnresolved: 0,
    truncated: false,
  })
})

test('no menu structure at all falls back to a created-ordered flat outline', async () => {
  const res = stubRes()
  await convertDrupalToSite(jsonReq({ repoUrl: 'https://flat.example.com' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)

  const items = res.body.data.items
  assert.equal(items.length, 3)
  // created order wins over title order (Alpha is oldest, not alphabetically first alone)
  assert.equal(items[0].title, 'Alpha')
  assert.equal(items[0].slug, 'alpha')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].indent, 0)
  assert.equal(items[0].parent, null)
  assert.equal(items[1].title, 'Zebra')
  assert.equal(items[1].order, 1)
  assert.equal(items[2].title, 'Middle')
  assert.equal(items[2].order, 2)

  assert.equal(res.body.data.drupal.outlineSource, 'flat')
  assert.equal(res.body.data.drupal.additionalNodes, 0)
})

test('parentId threads through to outline root items', async () => {
  const res = stubRes()
  await convertDrupalToSite(
    jsonReq({ repoUrl: 'https://drupal.example.com', parentId: 'node-77' }),
    res,
  )
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.items[0].parent, 'node-77')
  assert.equal(res.body.data.items[3].parent, 'node-77', 'appended footer-only item also threads parentId')
  // outline children still point at their generated parent item
  assert.equal(res.body.data.items[1].parent, res.body.data.items[0].id)
})

test('the files cap marks the import truncated', async () => {
  const originalMaxFiles = LIMITS.maxFiles
  LIMITS.maxFiles = 1
  try {
    const res = stubRes()
    await convertDrupalToSite(jsonReq({ repoUrl: 'https://drupal.example.com' }), res)
    assert.equal(res.body.status, 200)
    assert.equal(Object.keys(res.body.data.files).length, 1)
    assert.equal(res.body.data.drupal.truncated, true)
  } finally {
    LIMITS.maxFiles = originalMaxFiles
  }
})
