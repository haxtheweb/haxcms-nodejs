'use strict'

// Direct handler unit tests for src/siteRoutes/v1/revisions.js:
//   listItemRevisions, itemRevisionDetail, restoreItemRevision
//
// The handlers shell out to real git, so each test builds a real git
// repository in a temp directory (git init + commits with inline author
// config), commits the page html/json variants across revisions, and runs
// the handlers against a fake site fixture pointing at that repository.
// Site resolution runs through the real resolveSiteForRequest with
// HAXCMS.loadSite mocked per test (save-settings-routes pattern).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const {
  listItemRevisions,
  itemRevisionDetail,
  restoreItemRevision,
} = require('../../src/siteRoutes/v1/revisions.js')

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test Author', '-c', 'user.email=author@example.com'].concat(args),
    { cwd: cwd, encoding: 'utf8' },
  ).trim()
}

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
    send(value) {
      this.sent = value
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
    originalUrl: '/_sites/demo/x/api/v1/items/first-page/revisions',
  }
  return Object.assign(req, overrides || {})
}

// real git repo with a page evolving across three revisions
async function makeGitSite(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revisions-route-'))
  const siteDirectory = path.join(tmpRoot, 'demo')
  fs.ensureDirSync(path.join(siteDirectory, 'pages', 'item-1'))
  git(siteDirectory, 'init', '--quiet')
  fs.writeFileSync(path.join(siteDirectory, 'README.md'), 'site repo\n')
  git(siteDirectory, 'add', '.')
  git(siteDirectory, 'commit', '--quiet', '-m', 'site initialized')

  const htmlPath = path.join(siteDirectory, 'pages', 'item-1', 'index.html')
  const jsonPath = path.join(siteDirectory, 'pages', 'item-1', 'index.json')
  // revision 2: the page appears
  fs.writeFileSync(htmlPath, '<p>first revision content</p>\n')
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      id: 'item-1',
      title: 'First title',
      description: 'First description',
      slug: 'first-page',
      metadata: { published: true, image: 'files/one.png' },
    }) + '\n',
  )
  git(siteDirectory, 'add', '.')
  git(siteDirectory, 'commit', '--quiet', '-m', 'page created')
  const createdHash = git(siteDirectory, 'rev-parse', 'HEAD')
  // revision 3: the page changes
  fs.writeFileSync(htmlPath, '<p>second revision content</p>\n')
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      id: 'item-1',
      title: 'Second title',
      description: 'Second description',
      slug: 'first-page',
      metadata: { published: false, image: 'files/two.png', images: ['files/two.png'] },
    }) + '\n',
  )
  git(siteDirectory, 'add', '.')
  git(siteDirectory, 'commit', '--quiet', '-m', 'page updated')
  const updatedHash = git(siteDirectory, 'rev-parse', 'HEAD')

  const calls = {
    gitCommits: [],
    writePageAlternateFormats: [],
    saveCalls: [],
  }
  const page = {
    id: 'item-1',
    title: 'Current title',
    slug: 'first-page',
    parent: null,
    location: 'pages/item-1/index.html',
    description: '',
    metadata: {},
    writes: [],
    async writeLocation(content, dir) {
      page.writes.push({ content: content, dir: dir })
      fs.writeFileSync(path.join(siteDirectory, 'pages', 'item-1', 'index.html'), content)
      return content.length
    },
  }
  const site = {
    siteDirectory: siteDirectory,
    name: 'demo',
    calls: calls,
    page: page,
    hashes: { created: createdHash, updated: updatedHash },
    manifest: {
      items: [page],
      metadata: { site: { name: 'demo', updated: 1700000000 } },
      async save(reorder) {
        calls.saveCalls.push(typeof reorder === 'boolean' ? reorder : true)
      },
    },
    loadNode(id) {
      return id === 'item-1' ? page : null
    },
    getPageAlternateLocation(location, extension) {
      return String(location).replace(/\.html?$/i, '.' + extension)
    },
    async writePageAlternateFormats(targetPage, content) {
      calls.writePageAlternateFormats.push({ page: targetPage, content: content })
    },
    async gitCommit(message) {
      calls.gitCommits.push(message)
    },
  }
  t.after(() => {
    fs.removeSync(tmpRoot)
  })
  return site
}

function mockSite(t, site) {
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

describe('revisions routes — listItemRevisions', () => {
  test('answers 404 for missing site, item, page, or file', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'first-page' } }), resNoSite)
    assert.equal(resNoSite.statusCode, 404)
    assert.equal(
      resNoSite.body.data.message,
      'Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions',
    )
    const site = await makeGitSite(t)
    mockSite(t, site)
    const resUnknown = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'ghost' } }), resUnknown)
    assert.equal(resUnknown.statusCode, 404)
    assert.equal(resUnknown.body.data.message, 'Item not found for idOrSlug "ghost"')
    // an outline item whose page cannot be loaded answers 404
    site.loadNode = () => null
    const resNoPage = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'first-page' } }), resNoPage)
    assert.equal(resNoPage.statusCode, 404)
    assert.equal(
      resNoPage.body.data.message,
      'Unable to resolve page location for revisions',
    )
  })

  test('a page location outside the site answers 400 and a missing file 404', async (t) => {
    const site = await makeGitSite(t)
    site.page.location = '../escape.html'
    mockSite(t, site)
    const resEscape = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'first-page' } }), resEscape)
    assert.equal(resEscape.statusCode, 400)
    assert.equal(resEscape.body.data.message, 'Invalid node file location')
    site.page.location = 'pages/missing/index.html'
    const resMissing = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'first-page' } }), resMissing)
    assert.equal(resMissing.statusCode, 404)
    assert.equal(resMissing.body.data.message, 'Node file not found')
  })

  test('lists the page revisions with paging and links', async (t) => {
    const site = await makeGitSite(t)
    mockSite(t, site)
    const res = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'first-page' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.nodeId, 'item-1')
    assert.equal(res.body.data.nodeSlug, 'first-page')
    assert.equal(res.body.data.jsonVariantLocation, 'pages/item-1/index.json')
    // the page exists in exactly two commits
    assert.equal(res.body.data.count, 2)
    assert.equal(res.body.data.total, 2)
    assert.equal(res.body.data.page.limit, 25)
    assert.equal(res.body.data.revisions[0].revisionNumber, 1)
    assert.equal(res.body.data.revisions[0].message, 'page updated')
    assert.equal(res.body.data.revisions[0].author, 'Test Author')
    assert.equal(res.body.data.revisions[0].authorEmail, 'author@example.com')
    assert.equal(res.body.data.revisions[0].hash, site.hashes.updated)
    assert.equal(res.body.data.revisions[1].message, 'page created')
    assert.equal(
      res.body.data.links.self,
      '/_sites/demo/x/api/v1/items/first-page/revisions',
    )
    // offset shifts the revision numbers
    const resOffset = stubRes()
    await listItemRevisions(
      makeReq({
        params: { idOrSlug: 'first-page' },
        query: { 'page.limit': '1', 'page.offset': '1' },
      }),
      resOffset,
    )
    assert.equal(resOffset.body.data.count, 1)
    assert.equal(resOffset.body.data.page.offset, 1)
    assert.equal(resOffset.body.data.revisions[0].revisionNumber, 2)
    assert.equal(resOffset.body.data.revisions[0].message, 'page created')
    // junk and out-of-range paging values clamp to their bounds
    const resClamped = stubRes()
    await listItemRevisions(
      makeReq({
        params: { idOrSlug: 'first-page' },
        query: { 'page.limit': 'bogus', 'page.offset': '-5' },
      }),
      resClamped,
    )
    assert.equal(resClamped.body.data.page.limit, 25)
    assert.equal(resClamped.body.data.page.offset, 0)
    const resHuge = stubRes()
    await listItemRevisions(
      makeReq({ params: { idOrSlug: 'first-page' }, query: { 'page.limit': '9999' } }),
      resHuge,
    )
    assert.equal(resHuge.body.data.page.limit, 200)
  })

  test('a site without loadNode answers the page-context 404', async (t) => {
    const site = await makeGitSite(t)
    delete site.loadNode
    mockSite(t, site)
    const res = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'first-page' } }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve item page context for revisions',
    )
  })

  test('a directory that is not a git repository answers 500', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revisions-nogit-'))
    t.after(() => fs.removeSync(tmpRoot))
    const siteDirectory = path.join(tmpRoot, 'demo')
    fs.ensureDirSync(path.join(siteDirectory, 'pages', 'item-1'))
    fs.writeFileSync(
      path.join(siteDirectory, 'pages', 'item-1', 'index.html'),
      '<p>content</p>',
    )
    const page = {
      id: 'item-1',
      title: 'Page',
      slug: 'first-page',
      location: 'pages/item-1/index.html',
      metadata: {},
    }
    const site = {
      siteDirectory: siteDirectory,
      name: 'demo',
      manifest: { items: [page] },
      loadNode: () => page,
    }
    mockSite(t, site)
    const res = stubRes()
    await listItemRevisions(makeReq({ params: { idOrSlug: 'first-page' } }), res)
    assert.equal(res.statusCode, 500)
    assert.ok(typeof res.body.data.message === 'string')
    assert.ok(res.body.data.message.length > 0)
  })
})

describe('revisions routes — itemRevisionDetail', () => {
  test('answers 404/400 for the shared gates and an invalid hash', async (t) => {
    const site = await makeGitSite(t)
    mockSite(t, site)
    const resUnknown = stubRes()
    await itemRevisionDetail(
      makeReq({ params: { idOrSlug: 'ghost', revisionId: 'x' } }),
      resUnknown,
    )
    assert.equal(resUnknown.statusCode, 404)
    // an outline item whose page cannot be loaded answers 404
    site.loadNode = () => null
    const resNoPage = stubRes()
    await itemRevisionDetail(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: 'x' } }),
      resNoPage,
    )
    assert.equal(resNoPage.statusCode, 404)
    assert.equal(
      resNoPage.body.data.message,
      'Unable to resolve page location for revision detail',
    )
    site.loadNode = (id) => (id === 'item-1' ? site.page : null)
    site.page.location = 'pages/missing/index.html'
    const resMissing = stubRes()
    await itemRevisionDetail(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: 'x' } }),
      resMissing,
    )
    assert.equal(resMissing.statusCode, 404)
    assert.equal(resMissing.body.data.message, 'Node file not found')
    site.page.location = 'pages/item-1/index.html'
    const resBadHash = stubRes()
    await itemRevisionDetail(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: 'not-a-hash' } }),
      resBadHash,
    )
    assert.equal(resBadHash.statusCode, 400)
    assert.equal(resBadHash.body.data.message, 'Invalid revision hash')
  })

  test('answers the revision metadata, content, and item metadata', async (t) => {
    const site = await makeGitSite(t)
    mockSite(t, site)
    const res = stubRes()
    await itemRevisionDetail(
      makeReq({
        params: { idOrSlug: 'first-page', revisionId: site.hashes.created },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    const data = res.body.data
    assert.equal(data.nodeId, 'item-1')
    assert.equal(data.revision.hash, site.hashes.created)
    assert.equal(data.revision.message, 'page created')
    assert.ok(data.content.indexOf('first revision content') !== -1)
    assert.equal(data.jsonVariantLocation, 'pages/item-1/index.json')
    assert.equal(data.hasItemMetadata, true)
    assert.equal(data.itemMetadata.title, 'First title')
    assert.equal(data.itemMetadata.description, 'First description')
    assert.equal(data.itemMetadata.metadata.image, 'files/one.png')
    assert.equal(
      data.links.restore,
      '/_sites/demo/x/api/v1/items/first-page/revisions/' +
        site.hashes.created +
        '/restore',
    )
  })

  test('a site without loadNode answers the page-context 404', async (t) => {
    const site = await makeGitSite(t)
    delete site.loadNode
    mockSite(t, site)
    const res = stubRes()
    await itemRevisionDetail(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: site.hashes.created } }),
      res,
    )
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve item page context for revision detail',
    )
    site.page.location = '../escape.html'
    site.loadNode = () => site.page
    const resEscape = stubRes()
    await itemRevisionDetail(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: site.hashes.created } }),
      resEscape,
    )
    assert.equal(resEscape.statusCode, 400)
    assert.equal(resEscape.body.data.message, 'Invalid node file location')
  })
})

describe('revisions routes — restoreItemRevision', () => {
  test('restores the prior content, metadata, and commits', async (t) => {
    const site = await makeGitSite(t)
    mockSite(t, site)
    const res = stubRes()
    await restoreItemRevision(
      makeReq({
        params: { idOrSlug: 'first-page', revisionId: site.hashes.created },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    const data = res.body.data
    assert.equal(data.nodeId, 'item-1')
    assert.equal(data.restoredFromHash, site.hashes.created)
    assert.equal(data.nodeTitle, 'First title')
    assert.equal(data.hasItemMetadata, true)
    assert.equal(data.itemMetadataRestored, true)
    // the restored html was written to disk and the alternate formats rebuilt
    assert.equal(site.page.writes.length, 1)
    assert.ok(site.page.writes[0].content.indexOf('first revision content') !== -1)
    const onDisk = fs.readFileSync(
      path.join(site.siteDirectory, 'pages', 'item-1', 'index.html'),
      'utf8',
    )
    assert.ok(onDisk.indexOf('first revision content') !== -1)
    assert.equal(site.calls.writePageAlternateFormats.length, 1)
    // metadata restored onto the page
    assert.equal(site.page.title, 'First title')
    assert.equal(site.page.description, 'First description')
    assert.equal(site.page.metadata.published, true)
    assert.equal(site.page.metadata.image, 'files/one.png')
    assert.equal(site.page.metadata.updated, Math.floor(Date.now() / 1000))
    assert.deepEqual(site.calls.saveCalls, [true])
    assert.deepEqual(site.calls.gitCommits, [
      'Page revision restored: First title (item-1) from ' +
        site.hashes.created.substring(0, 12),
    ])
  })

  test('a write failure answers 500 Failed writing restored revision', async (t) => {
    const site = await makeGitSite(t)
    site.page.writeLocation = async () => false
    mockSite(t, site)
    const res = stubRes()
    await restoreItemRevision(
      makeReq({
        params: { idOrSlug: 'first-page', revisionId: site.hashes.created },
      }),
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'Failed writing restored revision')
  })

  test('a page without metadata bootstraps it during restore', async (t) => {
    const site = await makeGitSite(t)
    site.page.metadata = null
    mockSite(t, site)
    const res = stubRes()
    await restoreItemRevision(
      makeReq({
        params: { idOrSlug: 'first-page', revisionId: site.hashes.created },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(typeof site.page.metadata, 'object')
    assert.equal(site.page.metadata.updated, Math.floor(Date.now() / 1000))
  })

  test('shared gates: missing loadNode, invalid location, and missing file', async (t) => {
    const site = await makeGitSite(t)
    delete site.loadNode
    mockSite(t, site)
    const resNoLoadNode = stubRes()
    await restoreItemRevision(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: site.hashes.created } }),
      resNoLoadNode,
    )
    assert.equal(resNoLoadNode.statusCode, 404)
    assert.equal(
      resNoLoadNode.body.data.message,
      'Unable to resolve item page context for revision restore',
    )
    site.loadNode = () => site.page
    site.page.location = '../escape.html'
    const resEscape = stubRes()
    await restoreItemRevision(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: site.hashes.created } }),
      resEscape,
    )
    assert.equal(resEscape.statusCode, 400)
    assert.equal(resEscape.body.data.message, 'Invalid node file location')
    site.page.location = 'pages/missing/index.html'
    const resMissing = stubRes()
    await restoreItemRevision(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: site.hashes.created } }),
      resMissing,
    )
    assert.equal(resMissing.statusCode, 404)
    assert.equal(resMissing.body.data.message, 'Node file not found')
    assert.deepEqual(site.calls.gitCommits, [])
  })

  test('an invalid revision hash answers 400 and a missing site 404', async (t) => {
    const site = await makeGitSite(t)
    mockSite(t, site)
    const resBadHash = stubRes()
    await restoreItemRevision(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: 'zzz' } }),
      resBadHash,
    )
    assert.equal(resBadHash.statusCode, 400)
    assert.equal(resBadHash.body.data.message, 'Invalid revision hash')
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const resNoSite = stubRes()
    await restoreItemRevision(
      makeReq({ params: { idOrSlug: 'first-page', revisionId: 'abc' } }),
      resNoSite,
    )
    assert.equal(resNoSite.statusCode, 404)
  })
})
