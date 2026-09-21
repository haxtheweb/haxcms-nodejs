'use strict'

// Unit tests for createSite's linkImportedPageFiles (#2912, #3043).
//
// createSite writes the imported pages before it ingests build.files, so the
// pages cannot reference the files by uuid as they are written. Once the
// files exist, linkImportedPageFiles points each page at the file entities
// its content references, reading identity from files.json through the
// Entity API — the same source the docx import and page saves use.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const createSite = require('../../src/systemRoutes/v1/routes/createSite.js')
const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const FileStorage = require('../../src/lib/FileStorage.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')

const { linkImportedPageFiles } = createSite

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

describe('createSite linkImportedPageFiles — #2912', () => {
  let tmpRoot
  let site
  let saves
  let stagingDirectory

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
    // build.files must be staged under the bulk-import root, as in production
    stagingDirectory = path.join(HAXCMS.configDirectory, 'tmp', 'imports', 'test-' + path.basename(tmpRoot))
    await fs.ensureDir(stagingDirectory)
    site = new HAXCMSSite()
    site.name = 'testsite'
    site.siteDirectory = path.join(tmpRoot, 'testsite')
    await fs.ensureDir(path.join(site.siteDirectory, 'files'))
    saves = 0
    site.manifest = {
      metadata: { site: { name: 'testsite' } },
      items: [],
      save: async function () {
        saves++
        return true
      },
    }
  })

  afterEach(async () => {
    try {
      await fs.remove(tmpRoot)
      await fs.remove(stagingDirectory)
    } catch (e) {}
  })

  // a page as createSite leaves it: written, with no file references yet
  async function addPage(id, html) {
    const location = `pages/${id}/index.html`
    await fs.outputFile(path.join(site.siteDirectory, location), html)
    const page = { id: id, title: id, location: location, metadata: { files: [] } }
    site.manifest.items.push(page)
    return page
  }

  // ingest a file the way createSite's build.files loop does
  async function ingest(name) {
    const staged = path.join(stagingDirectory, name)
    await fs.writeFile(staged, PNG)
    const result = await new HAXCMSFile().save(
      { name: name, tmp_name: staged, path: staged, 'bulk-import': true },
      site,
    )
    assert.equal(Number(result.status), 200, JSON.stringify(result))
  }

  async function entityUuid(relativePath) {
    const fileStorage = FileStorage.registerOn(new EntityRegistry(site))
    const uuid = await fileStorage.getDataStore().resolveUuidByPath(relativePath)
    const entity = fileStorage.load(uuid)
    assert.ok(entity, 'files.json has an entity for ' + relativePath)
    return entity.getUuid()
  }

  test('links each page to the file entities its content references', async () => {
    await ingest('chart.png')
    await ingest('photo.png')
    const first = await addPage('first', '<p><media-image source="files/chart.png" alt="Chart"></media-image></p>')
    const second = await addPage('second', '<p><img src="files/photo.png" alt="Photo"></p><p><a href="files/chart.png">chart</a></p>')
    const linked = await linkImportedPageFiles(site)
    assert.equal(linked, 2)
    assert.deepEqual(first.metadata.files, [await entityUuid('files/chart.png')])
    assert.deepEqual(second.metadata.files, [await entityUuid('files/photo.png'), await entityUuid('files/chart.png')])
  })

  test('an image shared by pages is one entity referenced by each page', async () => {
    await ingest('shared.png')
    const a = await addPage('a', '<media-image source="files/shared.png" alt=""></media-image>')
    const b = await addPage('b', '<media-image source="files/shared.png" alt=""></media-image>')
    await linkImportedPageFiles(site)
    const uuid = await entityUuid('files/shared.png')
    assert.deepEqual(a.metadata.files, [uuid])
    assert.deepEqual(b.metadata.files, [uuid])
    assert.equal(new FilesDataStore(site).getRecords().length, 1, 'one file entity, not one per page')
  })

  test('a reference repeated on a page is recorded once', async () => {
    await ingest('twice.png')
    const page = await addPage('twice', '<media-image source="files/twice.png"></media-image><img src="files/twice.png">')
    await linkImportedPageFiles(site)
    assert.deepEqual(page.metadata.files, [await entityUuid('files/twice.png')])
  })

  test('saves the manifest once, after linking every page', async () => {
    await ingest('one.png')
    await addPage('p1', '<media-image source="files/one.png"></media-image>')
    await addPage('p2', '<media-image source="files/one.png"></media-image>')
    await addPage('p3', '<p>no files</p>')
    await linkImportedPageFiles(site)
    assert.equal(saves, 1)
  })

  test('leaves pages without file references, and the manifest, alone', async () => {
    const page = await addPage('plain', '<p>Just text</p><img src="https://example.org/remote.png">')
    const linked = await linkImportedPageFiles(site)
    assert.equal(linked, 0)
    assert.deepEqual(page.metadata.files, [])
    assert.equal(saves, 0, 'nothing to save')
  })

  test('ignores references to files that were never ingested', async () => {
    await ingest('real.png')
    const page = await addPage('mixed', '<media-image source="files/real.png"></media-image><media-image source="files/missing.png"></media-image>')
    await linkImportedPageFiles(site)
    assert.deepEqual(page.metadata.files, [await entityUuid('files/real.png')])
  })

  test('links a page that arrived without metadata', async () => {
    await ingest('bare.png')
    const page = await addPage('bare', '<media-image source="files/bare.png"></media-image>')
    delete page.metadata
    await linkImportedPageFiles(site)
    assert.deepEqual(page.metadata, { files: [await entityUuid('files/bare.png')] })
  })
})
