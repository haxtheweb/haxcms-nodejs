'use strict'

// Unit tests for createSite's importBuildFile (#3060).
//
// Importers hand createSite remote files as http(s) URLs in build.files. Each
// one is fetched through safeFetch into the bulk-import staging root and then
// takes the same bulk-import HAXCMSFile.save as a staged file, so it becomes a
// file entity in files.json; linkImportedPageFiles then links pages to it.
// The GHSA-q862-gcgq-5m6g protections still hold: other schemes and paths
// outside the staging root are rejected, and private, loopback and metadata
// addresses are never contacted.
//
// The network is stubbed at safeFetch except where the real SSRF guard is
// under test, and HAXCMS.configDirectory points at a temp dir so staging and
// media settings stay isolated.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const http = require('http')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')
const sharp = require('sharp')

const safeFetchMod = require('../../src/lib/safeFetch.js')
const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const createSite = require('../../src/systemRoutes/v1/routes/createSite.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const FileStorage = require('../../src/lib/FileStorage.js')

const { importBuildFile, linkImportedPageFiles } = createSite

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

describe('createSite importBuildFile — #3060', () => {
  const realSafeFetch = safeFetchMod.safeFetch
  const realConfigDirectory = HAXCMS.configDirectory
  let tmpRoot
  let stagingRoot
  let site
  let fetched

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
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
    fetched = []
  })

  afterEach(async () => {
    safeFetchMod.safeFetch = realSafeFetch
    HAXCMS.configDirectory = realConfigDirectory
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  // answer each URL from a map of url -> { status, body } or an Error to
  // throw; anything unmapped answers 404
  function stubNetwork(responses) {
    safeFetchMod.safeFetch = async function (url) {
      fetched.push(url)
      const entry = responses[url]
      if (entry instanceof Error) {
        throw entry
      }
      const status = entry ? entry.status || 200 : 404
      const body = entry && entry.body ? entry.body : Buffer.alloc(0)
      return {
        ok: status >= 200 && status < 300,
        status: status,
        headers: {
          get: function () {
            return null
          },
        },
        arrayBuffer: async function () {
          return body
        },
      }
    }
  }

  // the file entity files.json holds for a path, or null; read-only, so it
  // only finds records the save itself wrote
  function entityAt(relativePath) {
    const fileStorage = FileStorage.registerOn(new EntityRegistry(site))
    const record = fileStorage.getDataStore().getByPath(relativePath)
    return record ? fileStorage.load(record.uuid) : null
  }

  function stagedFiles() {
    return fs.readdirSync(stagingRoot)
  }

  test('an http(s) URL is fetched into staging and saved as a file entity', async () => {
    stubNetwork({ 'https://example.org/img/chart.png': { body: PNG } })
    assert.equal(await importBuildFile(site, 'files/chart.png', 'https://example.org/img/chart.png', 0), true)
    assert.deepEqual(fetched, ['https://example.org/img/chart.png'])
    const entity = entityAt('files/chart.png')
    assert.ok(entity, 'files.json records the downloaded file')
    assert.equal(entity.getPath(), 'files/chart.png')
    assert.equal(entity.isImage(), true)
    assert.ok(fs.existsSync(path.join(site.siteDirectory, 'files', 'chart.png')))
    assert.deepEqual(stagedFiles(), [], 'nothing is left in staging')
  })

  test('a staged file and a URL in the same payload are both saved', async () => {
    stubNetwork({ 'https://example.org/remote.png': { body: PNG } })
    const staged = path.join(stagingRoot, 'local.png')
    await fs.writeFile(staged, PNG)
    assert.equal(await importBuildFile(site, 'files/local.png', staged, 0), true)
    assert.equal(await importBuildFile(site, 'files/remote.png', 'https://example.org/remote.png', 1), true)
    assert.ok(entityAt('files/local.png'), 'the staged file is an entity')
    assert.ok(entityAt('files/remote.png'), 'the downloaded file is an entity')
    assert.deepEqual(stagedFiles(), [])
  })

  test('an upper-case scheme is still treated as a URL', async () => {
    stubNetwork({ 'HTTPS://example.org/upper.png': { body: PNG } })
    assert.equal(await importBuildFile(site, 'files/upper.png', 'HTTPS://example.org/upper.png', 0), true)
    assert.deepEqual(fetched, ['HTTPS://example.org/upper.png'])
    assert.ok(entityAt('files/upper.png'))
  })

  test('a key without the files/ prefix is saved under files/', async () => {
    stubNetwork({ 'https://example.org/bare.png': { body: PNG } })
    assert.equal(await importBuildFile(site, 'bare.png', 'https://example.org/bare.png', 0), true)
    assert.ok(entityAt('files/bare.png'))
  })

  test('a URL without an extension is saved under the name its key gives', async () => {
    // Plone serves images from paths like .../@@images/image
    stubNetwork({ 'https://example.org/site/photo/@@images/image': { body: PNG } })
    assert.equal(await importBuildFile(site, 'files/photo.png', 'https://example.org/site/photo/@@images/image', 0), true)
    const entity = entityAt('files/photo.png')
    assert.ok(entity)
    assert.equal(entity.getPath(), 'files/photo.png')
    assert.equal(entity.getMimetype(), 'image/png')
  })

  test('a URL that cannot be fetched is skipped without failing the site', async () => {
    // missing.png is unmapped, so it answers 404
    stubNetwork({
      'https://example.org/empty.png': { body: Buffer.alloc(0) },
      'https://example.org/down.png': new Error('socket hang up'),
    })
    const sources = ['missing', 'empty', 'down']
    for (let i = 0; i < sources.length; i++) {
      const name = `files/${sources[i]}.png`
      assert.equal(await importBuildFile(site, name, `https://example.org/${sources[i]}.png`, i), true, name)
      assert.equal(entityAt(name), null, name)
    }
    assert.equal(fetched.length, 3)
    assert.deepEqual(stagedFiles(), [])
  })

  test('private, loopback and metadata addresses are refused without being contacted', async () => {
    // the real safeFetch: its SSRF guard must stop these before any connection
    let hits = 0
    const server = http.createServer(function (req, res) {
      hits++
      res.end(PNG)
    })
    await new Promise(function (resolve) {
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    try {
      const targets = [
        `http://127.0.0.1:${port}/secret.png`,
        `http://localhost:${port}/secret.png`,
        'http://169.254.169.254/latest/meta-data/secret.png',
        'http://10.0.0.1/secret.png',
      ]
      for (let i = 0; i < targets.length; i++) {
        const name = `files/secret-${i}.png`
        assert.equal(await importBuildFile(site, name, targets[i], i), true, targets[i])
        assert.equal(entityAt(name), null, targets[i])
      }
      assert.equal(hits, 0, 'the local server was never contacted')
      assert.deepEqual(stagedFiles(), [])
    } finally {
      await new Promise(function (resolve) {
        server.close(resolve)
      })
    }
  })

  test('other schemes and files outside the staging root are still rejected', async () => {
    stubNetwork({})
    const outside = path.join(tmpRoot, 'outside.png')
    await fs.writeFile(outside, PNG)
    const sources = [
      'file:///etc/passwd',
      'gopher://example.org/x.png',
      'ftp://example.org/x.png',
      '/etc/passwd',
      outside,
      'relative/x.png',
      '',
      // the advisory's proof-of-concept payload shape
      { tmp_name: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
    ]
    for (let i = 0; i < sources.length; i++) {
      assert.equal(await importBuildFile(site, 'files/x.png', sources[i], i), false, JSON.stringify(sources[i]))
    }
    assert.equal(fetched.length, 0, 'nothing was fetched')
    assert.equal(entityAt('files/x.png'), null)
  })

  test('an entry with an unsafe name is rejected before anything is fetched', async () => {
    stubNetwork({ 'https://example.org/x.png': { body: PNG } })
    assert.equal(await importBuildFile(site, 'files/../escape.png', 'https://example.org/x.png', 0), false)
    assert.equal(await importBuildFile(site, 'files/shell.php', 'https://example.org/x.png', 1), false)
    assert.equal(fetched.length, 0)
  })

  test('a download whose content does not match its extension is dropped', async () => {
    stubNetwork({ 'https://example.org/fake.png': { body: Buffer.from('<html><body>not an image</body></html>') } })
    assert.equal(await importBuildFile(site, 'files/fake.png', 'https://example.org/fake.png', 0), true)
    assert.equal(entityAt('files/fake.png'), null)
    assert.equal(fs.existsSync(path.join(site.siteDirectory, 'files', 'fake.png')), false)
    assert.deepEqual(stagedFiles(), [], 'the rejected download is removed from staging')
  })

  test('a download over the site upload limit is dropped', async () => {
    // a real PNG of about 2MB: random pixels do not compress
    const big = await sharp(crypto.randomBytes(800 * 800 * 3), { raw: { width: 800, height: 800, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer()
    assert.ok(big.length > 1024 * 1024 && big.length < 3 * 1024 * 1024)
    stubNetwork({ 'https://example.org/big.png': { body: big } })
    const mediaSettings = path.join(HAXCMS.configDirectory, 'settings', 'media.json')
    await fs.outputJson(mediaSettings, { maxUploadSizeMb: 1 })
    assert.equal(await importBuildFile(site, 'files/big.png', 'https://example.org/big.png', 0), true)
    assert.equal(entityAt('files/big.png'), null, 'over the 1MB limit')
    assert.deepEqual(stagedFiles(), [], 'the rejected download is removed from staging')
    // the same file under a higher limit is saved, so the limit is what stopped it
    await fs.outputJson(mediaSettings, { maxUploadSizeMb: 3 })
    assert.equal(await importBuildFile(site, 'files/big.png', 'https://example.org/big.png', 1), true)
    assert.ok(entityAt('files/big.png'), 'under the 3MB limit')
  })

  test('a page that references a downloaded file is linked to its entity', async () => {
    stubNetwork({ 'https://example.org/img/chart.png': { body: PNG } })
    const location = 'pages/intro/index.html'
    await fs.outputFile(path.join(site.siteDirectory, location), '<p><img src="files/chart.png" alt="Chart"></p>')
    const page = { id: 'intro', title: 'Intro', location: location, metadata: { files: [] } }
    site.manifest.items.push(page)
    await importBuildFile(site, 'files/chart.png', 'https://example.org/img/chart.png', 0)
    await linkImportedPageFiles(site)
    assert.deepEqual(page.metadata.files, [entityAt('files/chart.png').getUuid()])
  })
})
