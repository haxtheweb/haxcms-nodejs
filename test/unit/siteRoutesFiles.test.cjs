'use strict'

// Unit tests for the v1/files route Phase 2 wiring (#3043).
//
// Mirrors the PHP files.php / filesMutation.php / fileOperation.php tests:
//   - upsertFileRecordInDataStore preserves uuid for in-place transforms,
//     assigns a new uuid for new-path ops, and scrubs the old path on rename.
//   - convert-jpg writes to the source's directory (files/<basename>.jpg),
//     not files/imgops/ (fix #5).
//   - files.json is upserted after every file operation (fix #6) so the
//     uuid's metadata (size) stays current.
//
// Tests the exported helpers directly (upsertFileRecordInDataStore,
// performFileOperation) against a real temp site so the on-disk behavior
// is verified without needing a running server.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')
const sharp = require('sharp')

const {
  upsertFileRecordInDataStore,
  performFileOperation,
} = require('../../src/siteRoutes/v1/files.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const FileStorage = require('../../src/lib/FileStorage.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const {
  getDeterministicFileUuid,
} = require('../../src/lib/siteFileUuid.js')

// Helper: create a temp site directory with a files/ subdir and a manifest.
async function makeTempSite(siteName) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
  const siteDirectory = path.join(tmpRoot, siteName || 'testsite')
  const filesDir = path.join(siteDirectory, 'files')
  await fs.ensureDir(filesDir)
  const site = {
    siteDirectory: siteDirectory,
    name: siteName || 'testsite',
    manifest: {
      metadata: {
        site: { name: siteName || 'testsite' },
      },
      items: [],
      save: async function () { return true },
    },
    gitCommit: async function () { return true },
  }
  return { tmpRoot, site, siteDirectory, filesDir }
}

// Helper: create a small test PNG.
async function makeTestPng(filePath, width, height) {
  await sharp({
    create: { width: width, height: height, channels: 3, background: 'red' },
  })
    .png()
    .toFile(filePath)
}

describe('siteRoutesFiles — #3043', () => {
  let tmpRoot
  let site
  let filesDir

  beforeEach(async () => {
    const ctx = await makeTempSite('testsite')
    tmpRoot = ctx.tmpRoot
    site = ctx.site
    filesDir = ctx.filesDir
  })

  afterEach(async () => {
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  describe('upsertFileRecordInDataStore', () => {
    test('preserves uuid for in-place transform (same path)', async () => {
      // Create a file and index it.
      await fs.writeFile(path.join(filesDir, 'photo.png'), 'png')
      const dataStore = new FilesDataStore(site)
      const original = await dataStore.buildFileRecordFromDisk('files/photo.png')
      dataStore.upsertRecord(original)

      // Simulate an in-place transform: file content changes, path stays same.
      await fs.writeFile(path.join(filesDir, 'photo.png'), 'new-content-larger')
      await upsertFileRecordInDataStore(site, 'files/photo.png')

      // Read back from a FRESH datastore instance (the upsert helper creates
      // its own internal instance, so the test's instance has a stale cache).
      const freshStore = new FilesDataStore(site)
      const updated = freshStore.getByUuid(original.uuid)
      assert.ok(updated)
      assert.equal(updated.uuid, original.uuid)
      assert.equal(updated.size, 'new-content-larger'.length)
    })

    test('assigns new uuid for new-path op (no old path)', async () => {
      // Create a file on disk but DON'T index it yet.
      await fs.writeFile(path.join(filesDir, 'new.jpg'), 'jpg-content')
      await upsertFileRecordInDataStore(site, 'files/new.jpg')

      const dataStore = new FilesDataStore(site)
      const record = dataStore.getByPath('files/new.jpg')
      assert.ok(record)
      // uuid should be the deterministic uuid from path+size.
      assert.equal(record.uuid, getDeterministicFileUuid(site, 'files/new.jpg', 'jpg-content'.length))
    })

    test('carries uuid to new path on rename and scrubs old path', async () => {
      // Create and index the original file.
      await fs.writeFile(path.join(filesDir, 'old-name.jpg'), 'jpg')
      const dataStore = new FilesDataStore(site)
      const original = await dataStore.buildFileRecordFromDisk('files/old-name.jpg')
      dataStore.upsertRecord(original)

      // Simulate rename: move the file, then upsert with new path + old path.
      await fs.move(
        path.join(filesDir, 'old-name.jpg'),
        path.join(filesDir, 'new-name.jpg'),
      )
      await upsertFileRecordInDataStore(site, 'files/new-name.jpg', 'files/old-name.jpg')

      // Read back from a FRESH datastore instance (stale cache otherwise).
      const freshStore = new FilesDataStore(site)
      // uuid should be carried over to the new path.
      const newRecord = freshStore.getByUuid(original.uuid)
      assert.ok(newRecord)
      assert.equal(newRecord.path, 'files/new-name.jpg')
      // Old path should no longer have a record (scrubbed).
      const oldRecord = freshStore.getByPath('files/old-name.jpg')
      assert.equal(oldRecord, null)
    })
  })

  describe('performFileOperation — convert-jpg writes to source dir (fix #5)', () => {
    test('convert-jpg writes files/<basename>.jpg not files/imgops/', async () => {
      // Create a PNG source file.
      const sourcePath = path.join(filesDir, 'banner.png')
      await makeTestPng(sourcePath, 50, 50)

      // Run convert-jpg operation.
      const result = await performFileOperation(
        site,
        'files/banner.png',
        { operation: 'convert-jpg' },
        90,
      )

      // The output should be files/banner.jpg in the SAME directory.
      assert.equal(result.data.operation, 'convert-jpg')
      assert.equal(result.data.file.path, 'files/banner.jpg')
      // Verify the file exists in the source directory, not imgops.
      assert.ok(fs.pathExistsSync(path.join(filesDir, 'banner.jpg')))
      // Verify NO imgops directory was created.
      assert.ok(!fs.pathExistsSync(path.join(filesDir, 'imgops')))
    })
  })

  describe('performFileOperation — files.json upsert after op (fix #6)', () => {
    test('compress upserts files.json with updated size', async () => {
      // Create a large PNG.
      const sourcePath = path.join(filesDir, 'big.png')
      await makeTestPng(sourcePath, 200, 200)
      const originalSize = fs.statSync(sourcePath).size

      // Index the file first.
      const dataStore = new FilesDataStore(site)
      const original = await dataStore.buildFileRecordFromDisk('files/big.png')
      dataStore.upsertRecord(original)
      const originalUuid = original.uuid

      // Run compress operation.
      await performFileOperation(
        site,
        'files/big.png',
        { operation: 'compress', level: 'heavy' },
        90,
      )

      // Read back from a FRESH datastore instance (the upsert helper inside
      // performFileOperation creates its own internal instance).
      const freshStore = new FilesDataStore(site)
      const updated = freshStore.getByUuid(originalUuid)
      assert.ok(updated, 'record should still exist in files.json')
      const newSize = fs.statSync(sourcePath).size
      assert.equal(updated.size, newSize)
      // uuid preserved (in-place transform).
      assert.equal(updated.uuid, originalUuid)
    })

    test('duplicate upserts files.json with new path record', async () => {
      // Create a source file.
      await fs.writeFile(path.join(filesDir, 'orig.txt'), 'content')

      // Run duplicate operation.
      const result = await performFileOperation(
        site,
        'files/orig.txt',
        { operation: 'duplicate' },
        90,
      )

      // The duplicate should be in files.json.
      const dataStore = new FilesDataStore(site)
      const dupRecord = dataStore.getByPath(result.data.path)
      assert.ok(dupRecord, 'duplicate record should be in files.json')
      assert.equal(dupRecord.path, result.data.path)
    })
  })

  describe('FilesDataStore O(1) uuid lookup (detail handler basis)', () => {
    test('getByUuid is O(1) from the files.json uuid index', async () => {
      await fs.writeFile(path.join(filesDir, 'a.txt'), 'a')
      await fs.writeFile(path.join(filesDir, 'b.txt'), 'b')
      await fs.writeFile(path.join(filesDir, 'c.txt'), 'c')
      const dataStore = new FilesDataStore(site)
      await dataStore.reconcileMissingFromDisk()

      // All three should be found by uuid.
      const records = dataStore.getRecords()
      assert.equal(records.length, 3)
      for (let i = 0; i < records.length; i++) {
        const uuid = records[i].uuid
        const found = dataStore.getByUuid(uuid)
        assert.ok(found)
        assert.equal(found.uuid, uuid)
      }
      // Unknown uuid returns null.
      assert.equal(dataStore.getByUuid('nonexistent-uuid'), null)
    })
  })

  describe('FileStorage.delete scrubs uuid from pages (delete handler basis)', () => {
    test('delete removes record and scrubs uuid from page.metadata.files', async () => {
      // Create a file and index it.
      await fs.writeFile(path.join(filesDir, 'target.jpg'), 'jpg')
      const dataStore = new FilesDataStore(site)
      const record = await dataStore.buildFileRecordFromDisk('files/target.jpg')
      dataStore.upsertRecord(record)

      // Add a page that references the file's uuid.
      site.manifest.items.push({
        id: 'page-1',
        metadata: { files: [record.uuid, 'other-uuid'] },
      })

      // Delete via FileStorage (as the deleteFile route handler does).
      const registry = new EntityRegistry(site)
      const storage = FileStorage.registerOn(registry)
      storage.delete(record.uuid)

      // Read back from a FRESH datastore instance (FileStorage.delete uses
      // its own internal FilesDataStore, so the test's instance is stale).
      const freshStore = new FilesDataStore(site)
      // Record removed from files.json.
      assert.equal(freshStore.getByUuid(record.uuid), null)
      // uuid scrubbed from page.metadata.files.
      assert.deepEqual(site.manifest.items[0].metadata.files, ['other-uuid'])
    })
  })
})
