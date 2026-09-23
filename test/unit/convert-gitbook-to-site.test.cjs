'use strict'

// Unit tests for convertGitbookToSite: converts a Gitbook repo's SUMMARY.md
// (nested <ul>/<li> rendered from markdown-it) into a JSON Outline Schema
// items array, fetching per-page markdown content and mapping non-.md tree
// entries into a `files` downloads map.
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
const fetchedOpts = []

function mockResp(opts) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    json: async () => opts.json,
    text: async () => (typeof opts.text === 'string' ? opts.text : ''),
  }
}

// SUMMARY.md with a nested list: Chapter 2 has a child Section 2.1.
const SUMMARY_MD =
  '# Summary\n\n* [Chapter 1](chapter1.md)\n* [Chapter 2](chapter2.md)\n    * [Section 2.1](section21.md)\n'

// Page markdown that references an image by absolute path (leading slash),
// the way gitbook markdown renders ![](/assets/image.png). chapter1 is used
// for the leading-slash rewrite test; its contents assertion in the
// structure test is updated to the rewritten <img src="files/assets/...">.
const CHAPTER1_MD_WITH_IMG =
  '# Chapter 1\n\n![image](/assets/image.png)\n'

// GitHub tree response: markdown files are ignored for `files`, non-.md files
// with a `.` in the path are staged as downloads, bare folder entries (no
// extension) are ignored.
const TREE = [
  { path: 'chapter1.md' },
  { path: 'chapter2.md' },
  { path: 'section21.md' },
  { path: 'assets/image.png' },
  { path: 'assets' },
]

async function mockSafeFetch(url, opts) {
  fetchedUrls.push(url)
  fetchedOpts.push(opts || {})
  if (url.indexOf('/git/trees/') !== -1) {
    return mockResp({ json: { tree: TREE } })
  }
  if (url.indexOf('api.github.com/repos/') !== -1) {
    return mockResp({ json: { default_branch: 'main' } })
  }
  if (url.indexOf('SUMMARY.md') !== -1) {
    return mockResp({ text: SUMMARY_MD })
  }
  if (url.indexOf('chapter1.md') !== -1) {
    return mockResp({ text: CHAPTER1_MD_WITH_IMG })
  }
  if (url.indexOf('chapter2.md') !== -1) {
    return mockResp({ text: 'Chapter 2 content' })
  }
  if (url.indexOf('section21.md') !== -1) {
    return mockResp({ text: 'Section 2.1 content' })
  }
  return mockResp({ ok: false, status: 404 })
}

const safeFetchMod = require('../../src/lib/safeFetch.js')
safeFetchMod.safeFetch = mockSafeFetch

const { convertGitbookToSite } = require('../../src/systemRoutes/v1/routes/imports/convertGitbookToSite.js')

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
  fetchedOpts.length = 0
})

test('GitHub API fetches include a User-Agent header (parity with PHP importer)', async () => {
  const res = stubRes()
  await convertGitbookToSite(jsonReq({ repoUrl: 'https://github.com/owner/repo' }), res)
  assert.equal(res.body.status, 200)
  // the meta fetch and the tree fetch both hit api.github.com and must
  // carry a User-Agent header or GitHub 403s and the importer silently
  // returns zero files.
  const apiCalls = fetchedUrls
    .map((u, i) => ({ url: u, opts: fetchedOpts[i] }))
    .filter((c) => c.url.indexOf('api.github.com/repos/') !== -1 && c.url.indexOf('/git/trees/') === -1)
  const treeCalls = fetchedUrls
    .map((u, i) => ({ url: u, opts: fetchedOpts[i] }))
    .filter((c) => c.url.indexOf('/git/trees/') !== -1)
  assert.ok(apiCalls.length >= 1, 'meta API call made')
  assert.ok(treeCalls.length === 1, 'tree API call made')
  for (const c of apiCalls.concat(treeCalls)) {
    assert.ok(c.opts && c.opts.headers, 'fetch had a headers object')
    assert.equal(c.opts.headers['User-Agent'], 'HAXcms-Import/1.0')
    assert.equal(c.opts.headers['Accept'], 'application/vnd.github.v3+json')
  }
})

test('SUMMARY.md is fetched from the resolved default branch, not hardcoded master', async () => {
  const res = stubRes()
  await convertGitbookToSite(jsonReq({ repoUrl: 'https://github.com/owner/repo' }), res)
  assert.equal(res.body.status, 200)
  // mock returns default_branch: 'main', so the SUMMARY.md fetch URL must
  // be .../main/SUMMARY.md, not .../master/SUMMARY.md (the old hardcoded
  // form that 404s on main-default repos).
  const summaryFetch = fetchedUrls.filter((u) => u.indexOf('SUMMARY.md') !== -1)
  assert.equal(summaryFetch.length, 1)
  assert.ok(summaryFetch[0].indexOf('/main/SUMMARY.md') !== -1, 'SUMMARY.md fetched from the resolved branch')
  assert.equal(summaryFetch[0].indexOf('/master/SUMMARY.md'), -1, 'master is not hardcoded')
})


test('missing repoUrl returns 400 before any fetch', async () => {
  const res = stubRes()
  await convertGitbookToSite(jsonReq({}), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})

test('converts a nested SUMMARY.md into items with correct title/parent/indent/order/slug/location', async () => {
  const res = stubRes()
  await convertGitbookToSite(jsonReq({ repoUrl: 'https://github.com/owner/repo' }), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  const items = res.body.data.items
  assert.equal(items.length, 3)

  const chapter1 = items[0]
  const chapter2 = items[1]
  const section21 = items[2]

  assert.equal(chapter1.title, 'Chapter 1')
  assert.equal(chapter1.parent, '')
  assert.equal(chapter1.indent, 0)
  assert.equal(chapter1.slug, 'chapter1.md')
  assert.equal(chapter1.location, 'content/chapter1.md')
  // chapter1 markdown references /assets/image.png (leading slash); the rewrite
  // must catch the leading-slash form and point it at files/assets/image.png so
  // the on-disk file location matches the page reference. Check the src="..." form
  // specifically because files/assets/image.png contains /assets/image.png as a
  // substring (so a naive indexOf('/assets/image.png') would false-positive).
  assert.equal(
    chapter1.contents.trim(),
    '<h1>Chapter 1</h1>\n<p><img src="files/assets/image.png" alt="image"></p>',
  )
  assert.ok(chapter1.contents.indexOf('src="/assets/image.png"') === -1, 'leading-slash src="/assets/image.png" reference is rewritten')
  assert.ok(chapter1.contents.indexOf('src="files/assets/image.png"') !== -1, 'rewritten to src="files/assets/image.png"')

  assert.equal(chapter2.title, 'Chapter 2')
  assert.equal(chapter2.parent, '')
  assert.equal(chapter2.indent, 0)
  assert.equal(chapter2.slug, 'chapter2.md')
  assert.equal(chapter2.location, 'content/chapter2.md')

  // nested child maps its `parent` to the chapter2 item's generated id
  assert.equal(section21.title, 'Section 2.1')
  assert.equal(section21.parent, chapter2.id)
  assert.equal(section21.indent, 1)
  assert.equal(section21.slug, 'section21.md')
  assert.equal(section21.location, 'content/section21.md')
  assert.equal(section21.contents.trim(), '<p>Section 2.1 content</p>')

  assert.equal(res.body.data.filename, 'owner')
})

test('non-.md tree entries populate the files downloads map with raw.githubusercontent.com URLs', async () => {
  const res = stubRes()
  await convertGitbookToSite(jsonReq({ repoUrl: 'https://github.com/owner/repo' }), res)
  const files = res.body.data.files
  assert.equal(
    files['files/assets/image.png'],
    'https://raw.githubusercontent.com/owner/repo/main/assets/image.png',
  )
  // markdown files and extensionless folder entries are not staged as downloads
  assert.equal(typeof files['files/chapter1.md'], 'undefined')
  assert.equal(typeof files['files/assets'], 'undefined')
})

test('the fileMap value is the repo-relative path (no first-slash corruption when filepathBase is empty)', async () => {
  // Internal contract: the importer builds a fileMap mapping the files/<path>
  // download key to the repo-relative path as it appears in page content, so the
  // content rewrite can match. Previously filepathBase was always '' and the
  // .replace(`${filepathBase}/`, '') became .replace('/', '') which stripped
  // the FIRST slash, corrupting "assets/image.png" -> "assetsimage.png" so the
  // rewrite never matched. Pin the fix: the fileMap value must be the verbatim
  // repo-relative path (no first-slash stripping) when filepathBase is empty.
  // Re-exercise the converter and inspect the internal fileMap by checking the
  // rewritten chapter1 content (which only resolves if fileMap is correct).
  const res = stubRes()
  await convertGitbookToSite(jsonReq({ repoUrl: 'https://github.com/owner/repo' }), res)
  assert.equal(res.body.status, 200)
  const chapter1 = res.body.data.items[0]
  // chapter1 references /assets/image.png; if fileMap were corrupted to
  // assetsimage.png the rewrite would NOT match and the content would still
  // have src="/assets/image.png". The fixed fileMap (assets/image.png) + the
  // single-regex rewrite produces src="files/assets/image.png".
  assert.ok(chapter1.contents.indexOf('src="files/assets/image.png"') !== -1, 'fileMap value is the verbatim repo-relative path so the rewrite matches')
  assert.ok(chapter1.contents.indexOf('src="/assets/image.png"') === -1, 'no unrewritten leading-slash reference remains')
  // and the corrupted "assetsimage.png" form must never appear anywhere
  assert.equal(chapter1.contents.indexOf('assetsimage.png'), -1, 'no first-slash-corrupted fileMap value leaked into content')
})

test('github.com URLs are rewritten to raw.githubusercontent.com and /blob/ is stripped when fetching SUMMARY.md and pages', async () => {
  const res = stubRes()
  await convertGitbookToSite(jsonReq({ repoUrl: 'https://github.com/owner/repo' }), res)
  assert.equal(res.body.status, 200)

  // the SUMMARY.md fetch URL was rewritten off github.com to raw.githubusercontent.com
  const summaryFetch = fetchedUrls.filter((u) => u.indexOf('SUMMARY.md') !== -1)
  assert.equal(summaryFetch.length, 1)
  assert.ok(summaryFetch[0].indexOf('raw.githubusercontent.com') !== -1, 'SUMMARY.md fetched from raw.githubusercontent.com')
  assert.equal(summaryFetch[0].indexOf('/blob/'), -1, 'no /blob/ segment remains in the fetch URL')

  // per-page fetches replace SUMMARY.md with the page's href against the same rewritten base
  const chapterFetch = fetchedUrls.filter((u) => u.indexOf('chapter1.md') !== -1)
  assert.equal(chapterFetch.length, 1)
  assert.ok(chapterFetch[0].indexOf('raw.githubusercontent.com') !== -1)
})

test('a repoUrl already containing /blob/ has that segment stripped before fetching', async () => {
  const res = stubRes()
  await convertGitbookToSite(
    jsonReq({ repoUrl: 'https://github.com/owner/repo/blob/main/SUMMARY.md' }),
    res,
  )
  assert.equal(res.body.status, 200)
  const summaryFetch = fetchedUrls.filter((u) => u.indexOf('SUMMARY.md') !== -1)
  assert.equal(summaryFetch.length, 1)
  assert.equal(summaryFetch[0].indexOf('/blob/'), -1)
  assert.ok(summaryFetch[0].indexOf('raw.githubusercontent.com') !== -1)
})

test('a fetch error (e.g. invalid repoUrl) returns 400 with a descriptive error', async () => {
  const res = stubRes()
  await convertGitbookToSite(jsonReq({ repoUrl: 'not-a-valid-url' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.error, /Error converting Gitbook/)
  assert.deepEqual(res.body.data.items, [])
  assert.deepEqual(res.body.data.files, {})
})
