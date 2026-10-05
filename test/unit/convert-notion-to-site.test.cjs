'use strict'

// Unit tests for convertNotionToSite: converts a Notion-exported GitHub
// repository into JSONOutlineSchemaItem objects by walking the repo git tree,
// parsing markdown head matter (# title + `key: value` lines) into lesson pages
// and pageType metadata, rendering body markdown (rewriting file references to
// files/), and staging non-.md tree entries into a `files` downloads map.
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

// Notion pageType switch values, written with explicit unicode escapes so the
// fixture matches the converter's case labels byte-for-byte (the exercise label
// carries a variation selector after the lightning bolt).
const TYPE_READING = '\u{1F4D9} Reading'
const TYPE_DISCUSSION = '\u{1F4AC} Canvas Discussion'
const TYPE_EXERCISE = '\u26A1\uFE0F Exercise'

// Notion-export repo tree: a database .csv establishes the filepathBase,
// extensionless folder entries are ignored, non-.md files with an extension
// are staged as downloads, .md files are converted.
const TREE = [
  { path: 'notiondb.csv' },
  { path: 'notiondb' },
  { path: 'notiondb/image.png' },
  { path: 'notiondb/Welcome.md' },
  { path: 'notiondb/Organelles.md' },
  { path: 'notiondb/Notes.md' },
  { path: 'notiondb/Broken.md' },
]

// Head matter needs a # title, a blank line, at least two `key: value` lines,
// and a trailing blank line for the converter's regexes to pick it up.
const WELCOME_MD = `# Cell Structure Basics

Lesson: 1. Introduction to Cells
id: 1.1
type: ${TYPE_READING}

Cells are the basic building blocks of life. ![cell diagram](image.png)
`

const ORGANELLES_MD = `# Organelles

id: 2.1
type: ${TYPE_DISCUSSION}

Mitochondria produce energy for the cell.
`

const NOTES_MD = `# Study Notes

Lesson: Biology
id: 3
type: ${TYPE_EXERCISE}

Review your notes every day.
`

async function mockSafeFetch(url) {
  fetchedUrls.push(url)
  if (url.indexOf('/repos/owner/broken') !== -1) {
    throw new Error('network down')
  }
  if (url.indexOf('/git/trees/') !== -1) {
    if (url.indexOf('/repos/owner/empty-repo/') !== -1) {
      return mockResp({ ok: false, status: 404, json: {} })
    }
    return mockResp({ json: { tree: TREE } })
  }
  if (url.indexOf('api.github.com/repos/') !== -1) {
    return mockResp({ json: { default_branch: 'main' } })
  }
  if (url.indexOf('Welcome.md') !== -1) {
    return mockResp({ text: WELCOME_MD })
  }
  if (url.indexOf('Organelles.md') !== -1) {
    return mockResp({ text: ORGANELLES_MD })
  }
  if (url.indexOf('Notes.md') !== -1) {
    return mockResp({ text: NOTES_MD })
  }
  return mockResp({ ok: false, status: 404 })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertNotionToSite } = require('../../src/systemRoutes/v1/routes/imports/convertNotionToSite.js')

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
  await convertNotionToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('a non-JSON string body falls back to an empty body and 400', async () => {
  const res = stubRes()
  await convertNotionToSite(jsonReq('not-json{'), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
})

test('an empty git tree still resolves the default branch and returns 200 with zero items', async () => {
  const res = stubRes()
  await convertNotionToSite(jsonReq({ repoUrl: 'https://github.com/owner/empty-repo' }), res)
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.deepEqual(res.body.data.items, [])
  assert.equal(res.body.data.filename, 'empty-repo')
  assert.deepEqual(res.body.data.files, {})
  // branch resolution happened before the (failing) tree fetch
  assert.ok(
    fetchedUrls.indexOf('https://api.github.com/repos/owner/empty-repo') !== -1,
    'repo metadata fetched to resolve the default branch',
  )
  assert.ok(
    fetchedUrls
      .map((u) => String(u))
      .filter((u) => u.indexOf('/git/trees/main') !== -1).length === 1,
    'tree fetched against the resolved main branch',
  )
})

test('a thrown fetch returns 400 with a descriptive error', async () => {
  const res = stubRes()
  await convertNotionToSite(jsonReq({ repoUrl: 'https://github.com/owner/broken' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Error converting Notion: network down/)
  assert.deepEqual(res.body.data.items, [])
  assert.deepEqual(res.body.data.files, {})
  assert.equal(res.body.data.filename, null)
})

test('a failing markdown fetch still produces an item with no title or content', async () => {
  const res = stubRes()
  await convertNotionToSite(jsonReq({ repoUrl: 'https://github.com/owner/notion-repo' }), res)
  assert.equal(res.body.status, 200)
  const broken = res.body.data.items.filter((item) => item.slug === 'broken')[0]
  assert.ok(broken, 'item produced for the .md entry even though content 404s')
  assert.equal(broken.title, null)
  assert.equal(broken.contents, '')
  assert.equal(broken.parent, '')
})

test('head matter creates lesson pages with nested content pages', async () => {
  const res = stubRes()
  await convertNotionToSite(jsonReq({ repoUrl: 'https://github.com/owner/notion-repo' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.filename, 'notion-repo')
  assert.equal(res.body.data.items.length, 6, 'two lessons + four content pages')

  const bySlug = {}
  res.body.data.items.forEach((item) => {
    bySlug[item.slug] = item
  })

  // lesson with a numbered "1. Introduction to Cells" lesson value
  const lessonOne = bySlug['introduction-to-cells']
  assert.equal(lessonOne.title, 'Introduction to Cells')
  assert.equal(lessonOne.location, 'content/introduction-to-cells.html')
  assert.equal(lessonOne.order, 1)
  assert.equal(lessonOne.indent, 0)
  assert.equal(lessonOne.parent, '')
  assert.equal(lessonOne.metadata.pageType, 'lesson')
  assert.equal(lessonOne.contents, '')

  // the welcome page nests under its lesson and maps the reading type
  const welcome = bySlug['welcome']
  assert.equal(welcome.title, 'Cell Structure Basics')
  assert.equal(welcome.parent, lessonOne.id)
  assert.equal(welcome.indent, 1)
  assert.equal(welcome.metadata.pageType, 'reading')
  assert.equal(
    welcome.contents.trim(),
    '<p>Cells are the basic building blocks of life. <img src="files/image.png" alt="cell diagram"></p>',
  )

  // a page with head matter but no lesson stays at the root
  const organelles = bySlug['organelles']
  assert.equal(organelles.title, 'Organelles')
  assert.equal(organelles.parent, '')
  assert.equal(organelles.metadata.pageType, 'discuss')
  assert.equal(organelles.contents.trim(), '<p>Mitochondria produce energy for the cell.</p>')

  // a lesson value without a period gets order 0
  const biology = bySlug['biology']
  assert.equal(biology.title, 'Biology')
  assert.equal(biology.order, 0)
  assert.equal(biology.metadata.pageType, 'lesson')

  const notes = bySlug['notes']
  assert.equal(notes.title, 'Study Notes')
  assert.equal(notes.parent, biology.id)
  assert.equal(notes.metadata.pageType, 'activity')
  assert.equal(notes.contents.trim(), '<p>Review your notes every day.</p>')
})

test('non-.md tree entries become raw file downloads keyed under files/', async () => {
  const res = stubRes()
  await convertNotionToSite(jsonReq({ repoUrl: 'https://github.com/owner/notion-repo' }), res)
  assert.deepEqual(res.body.data.files, {
    'files/image.png': 'https://raw.githubusercontent.com/owner/notion-repo/main/notiondb/image.png',
  })
})
