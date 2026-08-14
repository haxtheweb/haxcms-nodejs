'use strict'

// Unit test for convertHaxcmsToSite's file-staging behavior.
//
// Background: createSite's build.files validator rejects URL values by design
// (isValidBulkImportStagedPath forbids URI schemes). So the converter must
// download each referenced file into the bulk-import staging root and return
// {relativePath: localStagedPath} instead of {relativePath: remoteURL}.
//
// This test mocks safeFetch (by mutating the shared module export before the
// converter is required) and points HAXCMS.configDirectory at an isolated temp
// dir, then asserts:
//   - data.files values are absolute local paths under tmp/imports (not URLs)
//   - the staged files actually exist on disk with the fetched bytes
//   - a file whose fetch fails is skipped (not staged) without failing import
//   - every URL handed to safeFetch uses a single slash after the scheme
//     (regression for the `https://btopro.com//files/...` double-slash bug)
//     for both a root domain and a subpath.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

// Isolated temp config tree so getBulkImportStagingRoot() writes here and
// nowhere near the real HAXCMS config.
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'haxconv-'))
const CONFIG_DIR = path.join(TMP_BASE, 'config')

// Load the real shared modules, then swap safeFetch for a mock and point
// HAXCMS.configDirectory at the temp dir BEFORE requiring the converter. The
// converter binds safeFetch via destructuring at require time, so the mutation
// must happen first.
const safeFetchMod = require('../../src/lib/safeFetch.js')
const HAXCMSMod = require('../../src/lib/HAXCMS.js')

const fetchedUrls = []

function mockResp(opts) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    json: async () => opts.json,
    text: async () => (typeof opts.text === 'string' ? opts.text : ''),
    arrayBuffer: async () => (opts.buf || Buffer.alloc(0)),
  }
}

async function mockSafeFetch(url) {
  fetchedUrls.push(url)
  if (url.indexOf('/site.json') === url.length - '/site.json'.length) {
    return mockResp({ json: SITE_JSON, text: JSON.stringify(SITE_JSON) })
  }
  if (url.indexOf('/pages/item-1/index.html') === url.length - '/pages/item-1/index.html'.length) {
    return mockResp({ text: '<p>hello</p>' })
  }
  if (url.length - '.png'.length >= 0 && url.indexOf('.png') === url.length - '.png'.length) {
    return mockResp({ buf: Buffer.from('PNGFAKE') })
  }
  if (url.length - '.jpg'.length >= 0 && url.indexOf('.jpg') === url.length - '.jpg'.length) {
    return mockResp({ buf: Buffer.from('JPGFAKE') })
  }
  // theme/custom siteFiles + the .gif file -> 404 (skipped)
  return mockResp({ ok: false, status: 404 })
}

safeFetchMod.safeFetch = mockSafeFetch
HAXCMSMod.HAXCMS.configDirectory = CONFIG_DIR

const { convertHaxcmsToSite } = require('../../src/systemRoutes/v1/routes/imports/convertHaxcmsToSite.js')

const SITE_JSON = {
  metadata: { site: { name: 'importtest' } },
  items: [
    {
      id: 'item-1',
      location: 'pages/item-1/index.html',
      metadata: {
        files: [
          { url: 'files/image.png' },
          { url: 'files/sub/nested.jpg' },
          { url: 'files/missing.gif' },
        ],
      },
    },
  ],
}

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

function stubReq(repoUrl) {
  return {
    body: { repoUrl: repoUrl },
    params: {},
    headers: {},
    query: {},
  }
}

// Assert every URL handed to safeFetch has no `//` after the scheme — i.e. no
// `https://host//path` double-slash regression.
function assertNoDoubleSlash(urls) {
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i]
    const schemeEnd = u.indexOf('://')
    assert.ok(schemeEnd > -1, 'fetched URL has a scheme: ' + u)
    const afterScheme = u.slice(schemeEnd + 3)
    assert.ok(
      afterScheme.indexOf('//') === -1,
      'no double-slash after scheme in fetched URL: ' + u,
    )
  }
}

test.after(async () => {
  fs.removeSync(TMP_BASE)
})

test('root domain: files staged locally, fetch URLs single-slash, failed file skipped', async () => {
  fetchedUrls.length = 0
  const res = stubRes()
  await convertHaxcmsToSite(stubReq('https://btopro.com'), res)

  // success path calls res.json (not res.status), so statusCode stays null
  assert.equal(res.statusCode, null)
  assert.ok(res.body && res.body.data, 'response has a data payload')
  assert.equal(res.body.status, 200)

  const files = res.body.data.files
  const importsRoot = path.join(CONFIG_DIR, 'tmp', 'imports')

  // image.png staged as a local path (not a URL) and exists on disk
  assert.ok(files['files/image.png'], 'files/image.png was staged')
  const stagedPng = files['files/image.png']
  assert.equal(stagedPng.indexOf('http'), -1, 'staged value is not a URL')
  assert.ok(
    stagedPng.indexOf(importsRoot) === 0,
    'staged path is under tmp/imports: ' + stagedPng,
  )
  assert.ok(fs.existsSync(stagedPng), 'staged png exists on disk')
  assert.equal(fs.readFileSync(stagedPng, 'utf8'), 'PNGFAKE')

  // nested jpg staged too (Node flattens the stored name later in
  // HAXCMSFile.save, but the converter just stages by relPath key)
  assert.ok(files['files/sub/nested.jpg'], 'files/sub/nested.jpg was staged')
  const stagedJpg = files['files/sub/nested.jpg']
  assert.ok(fs.existsSync(stagedJpg), 'staged jpg exists on disk')
  assert.equal(fs.readFileSync(stagedJpg, 'utf8'), 'JPGFAKE')

  // the .gif fetch returned 404 -> skipped, not present in files
  assert.ok(
    typeof files['files/missing.gif'] === 'undefined',
    'files/missing.gif was skipped (fetch failed)',
  )

  // siteFiles (theme/custom) all 404'd -> empty
  assert.deepEqual(res.body.data.siteFiles, {})

  // no double-slash in any fetched URL; specific single-slash URLs present
  assertNoDoubleSlash(fetchedUrls)
  assert.ok(fetchedUrls.indexOf('https://btopro.com/site.json') !== -1, 'site.json fetched with single slash')
  assert.ok(
    fetchedUrls.indexOf('https://btopro.com/files/image.png') !== -1,
    'image.png fetched with single slash',
  )
  assert.ok(
    fetchedUrls.indexOf('https://btopro.com/files/sub/nested.jpg') !== -1,
    'nested.jpg fetched with single slash',
  )
})

test('subpath domain: files staged, fetch URLs single-slash', async () => {
  fetchedUrls.length = 0
  const res = stubRes()
  await convertHaxcmsToSite(stubReq('https://example.com/mysite'), res)

  assert.equal(res.statusCode, null)
  assert.ok(res.body && res.body.data, 'response has a data payload')
  assert.equal(res.body.status, 200)

  const files = res.body.data.files
  assert.ok(files['files/image.png'], 'image.png staged for subpath domain')
  assert.ok(fs.existsSync(files['files/image.png']), 'staged png exists')

  assertNoDoubleSlash(fetchedUrls)
  assert.ok(
    fetchedUrls.indexOf('https://example.com/mysite/site.json') !== -1,
    'subpath site.json fetched with single slash',
  )
  assert.ok(
    fetchedUrls.indexOf('https://example.com/mysite/files/image.png') !== -1,
    'subpath image.png fetched with single slash',
  )
})

test('trailing-slash repoUrl still resolves to single-slash fetch URLs', async () => {
  fetchedUrls.length = 0
  const res = stubRes()
  await convertHaxcmsToSite(stubReq('https://btopro.com/'), res)

  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assertNoDoubleSlash(fetchedUrls)
  assert.ok(fetchedUrls.indexOf('https://btopro.com/site.json') !== -1)
})

test('missing repoUrl returns 400 before any fetch', async () => {
  fetchedUrls.length = 0
  const res = stubRes()
  await convertHaxcmsToSite({ body: {}, params: {}, headers: {}, query: {} }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
  assert.equal(fetchedUrls.length, 0, 'no fetch attempted without a repoUrl')
})
