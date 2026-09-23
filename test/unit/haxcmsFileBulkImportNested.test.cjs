'use strict'

// Unit tests for HAXCMSFile.save() bulk-import nested-directory preservation
// (Workstream B of the post-#40/#41/#633 parity follow-up, haxtheweb/issues#3064).
//
// PHP HAXCMSFile save() preserves the directory tree encoded in a bulk-import
// upload name (e.g. 'files/assets/x.png' -> files/assets/x.png on disk), while
// the Node implementation used to flatten slashes to dashes (files/assets-x.png),
// so Gitbook/Notion sub-folder image keys imported correctly on PHP but landed
// in a flattened, broken-reference state on Node. These tests pin the parity
// fix: nested keys round-trip to a nested on-disk path + files.json entity,
// flat keys still land flat (no regression), and SEC-18 traversal/null-byte/
// absolute-dirname injection is rejected at the save() layer (a second line of
// defense behind normalizeBulkImportName's own gate).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const safeFetchMod = require('../../src/lib/safeFetch.js')
const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const createSite = require('../../src/systemRoutes/v1/routes/createSite.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const FileStorage = require('../../src/lib/FileStorage.js')

const { importBuildFile, linkImportedPageFiles } = createSite

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

describe('HAXCMSFile.save bulk-import nested directory preservation — #3064 Workstream B', () => {
  const realSafeFetch = safeFetchMod.safeFetch
  const realConfigDirectory = HAXCMS.configDirectory
  let tmpRoot
  let stagingRoot
  let site

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-nested-'))
    HAXCMS.configDirectory = path.join(tmpRoot, 'config')
    stagingRoot = path.join(HAXCMS.configDirectory, 'tmp', 'imports')
    await fs.ensureDir(stagingRoot)
    site = new HAXCMSSite()
    site.name = 'testsite'
    site.siteDirectory = path.join(tmpRoot, 'testsite')
    await fs.ensureDir(path.join(site.siteDirectory, 'files'))
    site.manifest = {
      metadata: { site: { name: 'testsite' } },
      items: [],
      save: async function () {
        return true
      },
    }
  })

  afterEach(async () => {
    safeFetchMod.safeFetch = realSafeFetch
    HAXCMS.configDirectory = realConfigDirectory
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  function stubNetwork(responses) {
    safeFetchMod.safeFetch = async function (url) {
      const entry = responses[url]
      const status = entry ? entry.status || 200 : 404
      const body = entry && entry.body ? entry.body : Buffer.alloc(0)
      return {
        ok: status >= 200 && status < 300,
        status: status,
        headers: { get: function () { return null } },
        arrayBuffer: async function () { return body },
      }
    }
  }

  function entityAt(relativePath) {
    const fileStorage = FileStorage.registerOn(new EntityRegistry(site))
    const record = fileStorage.getDataStore().getByPath(relativePath)
    return record ? fileStorage.load(record.uuid) : null
  }

  async function stageLocalPng(name) {
    const staged = path.join(stagingRoot, 'haxbi-' + name)
    await fs.writeFile(staged, PNG)
    return staged
  }

  test('a nested key (files/assets/x.png) is saved at files/assets/x.png, not flattened', async () => {
    stubNetwork({ 'https://example.org/img/x.png': { body: PNG } })
    assert.equal(
      await importBuildFile(site, 'files/assets/x.png', 'https://example.org/img/x.png', 0),
      true,
    )
    const entity = entityAt('files/assets/x.png')
    assert.ok(entity, 'files.json records the nested-path file')
    assert.equal(entity.getPath(), 'files/assets/x.png')
    assert.ok(
      fs.existsSync(path.join(site.siteDirectory, 'files', 'assets', 'x.png')),
      'file physically lives at files/assets/x.png',
    )
    // the flattened legacy path must NOT also exist
    assert.equal(
      fs.existsSync(path.join(site.siteDirectory, 'files', 'assets-x.png')),
      false,
      'legacy flattened name files/assets-x.png is not produced',
    )
  })

  test('a multi-level nested key (files/assets/sub/deep.png) preserves the full tree', async () => {
    stubNetwork({ 'https://example.org/img/deep.png': { body: PNG } })
    assert.equal(
      await importBuildFile(site, 'files/assets/sub/deep.png', 'https://example.org/img/deep.png', 0),
      true,
    )
    const entity = entityAt('files/assets/sub/deep.png')
    assert.ok(entity, 'files.json records the multi-level nested-path file')
    assert.equal(entity.getPath(), 'files/assets/sub/deep.png')
    assert.ok(
      fs.existsSync(path.join(site.siteDirectory, 'files', 'assets', 'sub', 'deep.png')),
      'file physically lives at files/assets/sub/deep.png',
    )
  })

  test('a flat key (files/flat.png) still lands flat — no regression', async () => {
    stubNetwork({ 'https://example.org/img/flat.png': { body: PNG } })
    assert.equal(
      await importBuildFile(site, 'files/flat.png', 'https://example.org/img/flat.png', 0),
      true,
    )
    const entity = entityAt('files/flat.png')
    assert.ok(entity, 'files.json records the flat file')
    assert.equal(entity.getPath(), 'files/flat.png')
    assert.ok(fs.existsSync(path.join(site.siteDirectory, 'files', 'flat.png')))
  })

  test('a bare key without the files/ prefix still lands under files/', async () => {
    stubNetwork({ 'https://example.org/img/bare.png': { body: PNG } })
    assert.equal(
      await importBuildFile(site, 'bare.png', 'https://example.org/img/bare.png', 0),
      true,
    )
    const entity = entityAt('files/bare.png')
    assert.ok(entity)
    assert.equal(entity.getPath(), 'files/bare.png')
  })

  test('a staged (non-URL) nested key is also preserved on disk', async () => {
    const staged = await stageLocalPng('nested-staged.png')
    assert.equal(
      await importBuildFile(site, 'files/assets/staged.png', staged, 0),
      true,
    )
    const entity = entityAt('files/assets/staged.png')
    assert.ok(entity, 'files.json records the staged nested-path file')
    assert.equal(entity.getPath(), 'files/assets/staged.png')
    assert.ok(
      fs.existsSync(path.join(site.siteDirectory, 'files', 'assets', 'staged.png')),
      'staged file physically lives at files/assets/staged.png',
    )
  })

  test('a page that references a nested imported file is linked to its entity', async () => {
    stubNetwork({ 'https://example.org/img/chart.png': { body: PNG } })
    const location = 'pages/intro/index.html'
    await fs.outputFile(
      path.join(site.siteDirectory, location),
      '<p><img src="files/assets/chart.png" alt="Chart"></p>',
    )
    const page = { id: 'intro', title: 'Intro', location: location, metadata: { files: [] } }
    site.manifest.items.push(page)
    await importBuildFile(site, 'files/assets/chart.png', 'https://example.org/img/chart.png', 0)
    await linkImportedPageFiles(site)
    const entity = entityAt('files/assets/chart.png')
    assert.ok(entity, 'nested file entity exists before linking')
    assert.deepEqual(page.metadata.files, [entity.getUuid()])
  })

  // --- SEC-18: save() rejects traversal / null-byte / absolute dirnames even
  // when called directly (second line of defense behind normalizeBulkImportName) ---

  test('save() rejects a bulk-import name with a traversal dirname', async () => {
    const staged = await stageLocalPng('escape.png')
    const result = await new HAXCMSFile().save(
      { name: 'files/../escape.png', tmp_name: staged, path: staged, 'bulk-import': true },
      site,
    )
    assert.equal(result.status, 500)
    assert.equal(result.data.message, 'Invalid bulk import path')
    assert.equal(
      fs.existsSync(path.join(site.siteDirectory, 'files', 'escape.png')),
      false,
      'no file escaped to files/escape.png',
    )
    assert.equal(
      fs.existsSync(path.join(site.siteDirectory, 'escape.png')),
      false,
      'no file escaped to the site root',
    )
  })

  test('save() rejects a bulk-import name with an absolute dirname', async () => {
    const staged = await stageLocalPng('abs.png')
    const result = await new HAXCMSFile().save(
      { name: '/etc/x.png', tmp_name: staged, path: staged, 'bulk-import': true },
      site,
    )
    assert.equal(result.status, 500)
    assert.equal(result.data.message, 'Invalid bulk import path')
  })

  test('save() rejects a bulk-import name with a null byte in the dirname', async () => {
    const staged = await stageLocalPng('null.png')
    const result = await new HAXCMSFile().save(
      { name: 'assets/foo\0bar/x.png', tmp_name: staged, path: staged, 'bulk-import': true },
      site,
    )
    assert.equal(result.status, 500)
    assert.equal(result.data.message, 'Invalid bulk import path')
  })
})
