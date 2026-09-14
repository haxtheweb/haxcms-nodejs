'use strict'

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')
const sharp = require('sharp')

const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const {
  getDeterministicFileUuid,
} = require('../../src/lib/siteFileUuid.js')

// Helper: create a temp site directory with a files/ subdir.
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
    },
  }
  return { tmpRoot, site, siteDirectory, filesDir }
}

// Helper: create a small test PNG of given dimensions.
async function makeTestPng(filePath, width, height) {
  await sharp({
    create: { width: width, height: height, channels: 3, background: 'red' },
  })
    .png()
    .toFile(filePath)
}

describe('FilesDataStore — Phase 2 (#3043)', () => {
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

  describe('load / auto-build', () => {
    test('load auto-builds empty envelope when files.json is missing', () => {
      const store = new FilesDataStore(site)
      const envelope = store.load()
      assert.ok(envelope)
      assert.equal(envelope.schema, 'HAXCMS-FILE-SCHEMA-V1')
      assert.equal(envelope.site, 'testsite')
      assert.ok(envelope.data)
      assert.ok(Array.isArray(envelope.data.files))
      assert.equal(envelope.data.files.length, 0)
    })

    test('load reads existing files.json from disk', async () => {
      const store1 = new FilesDataStore(site)
      // Write a record and save.
      store1.load()
      store1.upsertRecord({
        uuid: 'abc-123',
        path: 'files/test.txt',
        name: 'test.txt',
        mimetype: 'text/plain',
        size: 10,
      })
      // New instance reads from disk.
      const store2 = new FilesDataStore(site)
      const envelope = store2.load()
      assert.equal(envelope.data.files.length, 1)
      assert.equal(envelope.data.files[0].uuid, 'abc-123')
    })

    test('load is lazy (only reads once per instance)', () => {
      const store = new FilesDataStore(site)
      const env1 = store.load()
      env1.data.files.push({ uuid: 'x', path: 'files/x', name: 'x', mimetype: 'x' })
      const env2 = store.load()
      assert.equal(env2.data.files.length, 1)
    })
  })

  describe('indexes', () => {
    test('buildIndexes creates uuid->record and path->uuid maps', () => {
      const store = new FilesDataStore(site)
      store.load()
      store.upsertRecord({
        uuid: 'uuid-a',
        path: 'files/a.txt',
        name: 'a.txt',
        mimetype: 'text/plain',
        size: 5,
      })
      assert.ok(store.uuidIndex['uuid-a'])
      assert.equal(store.pathIndex['files/a.txt'], 'uuid-a')
    })
  })

  describe('getByUuid / getByPath', () => {
    test('getByUuid returns record for known uuid', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'known-uuid',
        path: 'files/data.csv',
        name: 'data.csv',
        mimetype: 'text/csv',
        size: 42,
      })
      const record = store.getByUuid('known-uuid')
      assert.ok(record)
      assert.equal(record.path, 'files/data.csv')
    })

    test('getByUuid returns null for unknown uuid', () => {
      const store = new FilesDataStore(site)
      store.load()
      assert.equal(store.getByUuid('nonexistent'), null)
    })

    test('getByUuid is case-insensitive', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'ABC-123',
        path: 'files/a.txt',
        name: 'a.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.ok(store.getByUuid('abc-123'))
      assert.ok(store.getByUuid('ABC-123'))
    })

    test('getByPath returns record for known path', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'path-uuid',
        path: 'files/images/logo.png',
        name: 'logo.png',
        mimetype: 'image/png',
        size: 100,
      })
      const record = store.getByPath('files/images/logo.png')
      assert.ok(record)
      assert.equal(record.uuid, 'path-uuid')
    })

    test('getByPath canonicalizes input path', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'canon-uuid',
        path: 'files/report.pdf',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        size: 200,
      })
      // Leading slash should be stripped by canonicalPath.
      const record = store.getByPath('/files/report.pdf')
      assert.ok(record)
      assert.equal(record.uuid, 'canon-uuid')
    })

    test('getByPath returns null for unknown path', () => {
      const store = new FilesDataStore(site)
      store.load()
      assert.equal(store.getByPath('files/nonexistent.jpg'), null)
    })
  })

  describe('resolveUuidByPath', () => {
    test('returns existing uuid for known path', async () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'existing-uuid',
        path: 'files/doc.pdf',
        name: 'doc.pdf',
        mimetype: 'application/pdf',
        size: 50,
      })
      const uuid = await store.resolveUuidByPath('files/doc.pdf')
      assert.equal(uuid, 'existing-uuid')
    })

    test('upserts unknown path with deterministic uuid at first ingest', async () => {
      // Create a real file on disk.
      const filePath = path.join(filesDir, 'note.txt')
      await fs.writeFile(filePath, 'hello world')

      const store = new FilesDataStore(site)
      const uuid = await store.resolveUuidByPath('files/note.txt')
      assert.ok(uuid)
      assert.equal(uuid, getDeterministicFileUuid(site, 'files/note.txt', 11))
      // Record should now be in the index.
      const record = store.getByUuid(uuid)
      assert.ok(record)
      assert.equal(record.path, 'files/note.txt')
    })

    test('returns empty string when file does not exist on disk', async () => {
      const store = new FilesDataStore(site)
      const uuid = await store.resolveUuidByPath('files/ghost.txt')
      assert.equal(uuid, '')
    })
  })

  describe('upsertRecord', () => {
    test('inserts new record', () => {
      const store = new FilesDataStore(site)
      const result = store.upsertRecord({
        uuid: 'new-1',
        path: 'files/new1.txt',
        name: 'new1.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.equal(result, true)
      assert.equal(store.getRecords().length, 1)
    })

    test('updates existing record by uuid', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'upsert-1',
        path: 'files/old.txt',
        name: 'old.txt',
        mimetype: 'text/plain',
        size: 10,
      })
      store.upsertRecord({
        uuid: 'upsert-1',
        path: 'files/new.txt',
        name: 'new.txt',
        mimetype: 'text/plain',
        size: 20,
      })
      const records = store.getRecords()
      assert.equal(records.length, 1)
      assert.equal(records[0].path, 'files/new.txt')
      assert.equal(records[0].size, 20)
    })

    test('returns false for missing uuid', () => {
      const store = new FilesDataStore(site)
      const result = store.upsertRecord({
        path: 'files/nouuid.txt',
        name: 'nouuid.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.equal(result, false)
    })

    test('persists to disk (files.json written)', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'persist-1',
        path: 'files/persist.txt',
        name: 'persist.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.ok(store.exists())
      const jsonPath = store.getFilesJsonPath()
      const raw = fs.readFileSync(jsonPath, 'utf8')
      const parsed = JSON.parse(raw)
      assert.equal(parsed.schema, 'HAXCMS-FILE-SCHEMA-V1')
      assert.equal(parsed.data.files.length, 1)
    })
  })

  describe('removeRecord', () => {
    test('removes record by uuid', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'remove-1',
        path: 'files/remove.txt',
        name: 'remove.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.equal(store.getRecords().length, 1)
      const removed = store.removeRecord('remove-1')
      assert.equal(removed, true)
      assert.equal(store.getRecords().length, 0)
      assert.equal(store.getByUuid('remove-1'), null)
    })

    test('returns false for unknown uuid', () => {
      const store = new FilesDataStore(site)
      store.load()
      const removed = store.removeRecord('nonexistent')
      assert.equal(removed, false)
    })

    test('returns false for empty uuid', () => {
      const store = new FilesDataStore(site)
      store.load()
      const removed = store.removeRecord('')
      assert.equal(removed, false)
    })
  })

  describe('reconcileMissingFromDisk', () => {
    test('drops a file in the dir, verifies it appears', async () => {
      // Create a text file on disk.
      await fs.writeFile(path.join(filesDir, 'reconciled.txt'), 'content')
      const store = new FilesDataStore(site)
      store.load()
      assert.equal(store.getRecords().length, 0)
      const added = await store.reconcileMissingFromDisk()
      assert.equal(added, 1)
      const records = store.getRecords()
      assert.equal(records.length, 1)
      assert.equal(records[0].path, 'files/reconciled.txt')
    })

    test('returns 0 when files dir does not exist', async () => {
      // Remove the files dir.
      await fs.remove(filesDir)
      const store = new FilesDataStore(site)
      const added = await store.reconcileMissingFromDisk()
      assert.equal(added, 0)
    })

    test('skips files already in the index', async () => {
      await fs.writeFile(path.join(filesDir, 'existing.txt'), 'data')
      const store = new FilesDataStore(site)
      // Pre-populate the index with this file.
      store.upsertRecord({
        uuid: getDeterministicFileUuid(site, 'files/existing.txt', 4),
        path: 'files/existing.txt',
        name: 'existing.txt',
        mimetype: 'text/plain',
        size: 4,
      })
      const added = await store.reconcileMissingFromDisk()
      assert.equal(added, 0)
    })

    test('skips haxcms-managed directory', async () => {
      const managedDir = path.join(filesDir, 'haxcms-managed')
      await fs.ensureDir(managedDir)
      await fs.writeFile(path.join(managedDir, 'internal.txt'), 'internal')
      await fs.writeFile(path.join(filesDir, 'visible.txt'), 'visible')
      const store = new FilesDataStore(site)
      const added = await store.reconcileMissingFromDisk()
      assert.equal(added, 1)
      const records = store.getRecords()
      assert.equal(records[0].path, 'files/visible.txt')
    })
  })

  describe('flagOrphans', () => {
    test('delete disk file, verify orphan flagged not removed', async () => {
      // Create a file and reconcile.
      const filePath = path.join(filesDir, 'orphan.txt')
      await fs.writeFile(filePath, 'orphan content')
      const store = new FilesDataStore(site)
      await store.reconcileMissingFromDisk()
      assert.equal(store.getRecords().length, 1)
      // Delete the disk file.
      await fs.remove(filePath)
      // Flag orphans.
      const orphans = store.flagOrphans()
      assert.equal(orphans.length, 1)
      assert.equal(orphans[0].path, 'files/orphan.txt')
      // Record is NOT removed from files.json.
      assert.equal(store.getRecords().length, 1)
    })

    test('returns empty when all disk files present', async () => {
      await fs.writeFile(path.join(filesDir, 'ok.txt'), 'ok')
      const store = new FilesDataStore(site)
      await store.reconcileMissingFromDisk()
      const orphans = store.flagOrphans()
      assert.equal(orphans.length, 0)
    })
  })

  describe('buildFileRecordFromDisk', () => {
    test('field shape matches expected contract', async () => {
      const filePath = path.join(filesDir, 'shape.txt')
      await fs.writeFile(filePath, 'test content')
      const store = new FilesDataStore(site)
      const record = await store.buildFileRecordFromDisk('files/shape.txt')
      assert.ok(record)
      // Required fields.
      assert.ok(record.uuid)
      assert.equal(record.path, 'files/shape.txt')
      assert.equal(record.name, 'shape.txt')
      assert.equal(record.mimetype, 'text/plain')
      assert.equal(record.size, 12)
      assert.ok(typeof record.dateCreated === 'number')
      assert.ok(record.fullUrl)
      assert.equal(record.url, 'files/shape.txt')
      // width/height present (0 for non-image).
      assert.ok(typeof record.width === 'number')
      assert.ok(typeof record.height === 'number')
      assert.equal(record.width, 0)
      assert.equal(record.height, 0)
      // uuid matches deterministic formula.
      assert.equal(record.uuid, getDeterministicFileUuid(site, 'files/shape.txt', 12))
    })

    test('image width/height from sharp', async () => {
      const imgPath = path.join(filesDir, 'photo.png')
      await makeTestPng(imgPath, 4, 7)
      const store = new FilesDataStore(site)
      const record = await store.buildFileRecordFromDisk('files/photo.png')
      assert.ok(record)
      assert.equal(record.mimetype, 'image/png')
      assert.equal(record.width, 4)
      assert.equal(record.height, 7)
    })

    test('returns null when file does not exist', async () => {
      const store = new FilesDataStore(site)
      const record = await store.buildFileRecordFromDisk('files/missing.txt')
      assert.equal(record, null)
    })

    test('fullUrl includes cache-bust query param when dateCreated > 0', async () => {
      const filePath = path.join(filesDir, 'cached.txt')
      await fs.writeFile(filePath, 'x')
      const store = new FilesDataStore(site)
      const record = await store.buildFileRecordFromDisk('files/cached.txt')
      assert.ok(record.fullUrl.indexOf('?t=') !== -1 || record.fullUrl.indexOf('&t=') !== -1)
    })
  })

  describe('atomic save', () => {
    test('no temp files left after save', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'atomic-1',
        path: 'files/atomic.txt',
        name: 'atomic.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      const entries = fs.readdirSync(filesDir)
      const tempFiles = entries.filter((e) => e.indexOf('.tmp-') !== -1)
      assert.equal(tempFiles.length, 0)
    })

    test('files.json is valid JSON after save', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'valid-1',
        path: 'files/valid.txt',
        name: 'valid.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      const jsonPath = store.getFilesJsonPath()
      const raw = fs.readFileSync(jsonPath, 'utf8')
      assert.doesNotThrow(() => JSON.parse(raw))
    })
  })

  describe('exists / getFilesJsonPath / getFilesDirectory', () => {
    test('exists returns false before any save', () => {
      const store = new FilesDataStore(site)
      assert.equal(store.exists(), false)
    })

    test('exists returns true after save', () => {
      const store = new FilesDataStore(site)
      store.upsertRecord({
        uuid: 'e-1',
        path: 'files/e.txt',
        name: 'e.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.equal(store.exists(), true)
    })

    test('getFilesJsonPath resolves to <siteDirectory>/files/files.json', () => {
      const store = new FilesDataStore(site)
      const p = store.getFilesJsonPath()
      assert.ok(p.indexOf('files') !== -1)
      assert.ok(p.indexOf('files.json') !== -1)
    })

    test('getFilesDirectory resolves to <siteDirectory>/files', () => {
      const store = new FilesDataStore(site)
      const p = store.getFilesDirectory()
      assert.ok(p.indexOf('files') !== -1)
    })

    test('buildEmptyEnvelope has correct schema and site name', () => {
      const store = new FilesDataStore(site)
      const env = store.buildEmptyEnvelope()
      assert.equal(env.schema, 'HAXCMS-FILE-SCHEMA-V1')
      assert.equal(env.site, 'testsite')
      assert.equal(env.data.path, 'files')
      assert.ok(Array.isArray(env.data.files))
    })
  })

  describe('static helpers', () => {
    test('canonicalPath normalizes to files/... form', () => {
      assert.equal(FilesDataStore.canonicalPath('banner.jpg'), 'files/banner.jpg')
      assert.equal(FilesDataStore.canonicalPath('files/banner.jpg'), 'files/banner.jpg')
      assert.equal(FilesDataStore.canonicalPath('/banner.jpg'), 'files/banner.jpg')
      assert.equal(FilesDataStore.canonicalPath(''), 'files')
    })

    test('mimetypeFromExtension maps common extensions', () => {
      assert.equal(FilesDataStore.mimetypeFromExtension('photo.jpg'), 'image/jpeg')
      assert.equal(FilesDataStore.mimetypeFromExtension('photo.jpeg'), 'image/jpeg')
      assert.equal(FilesDataStore.mimetypeFromExtension('icon.png'), 'image/png')
      assert.equal(FilesDataStore.mimetypeFromExtension('anim.gif'), 'image/gif')
      assert.equal(FilesDataStore.mimetypeFromExtension('logo.svg'), 'image/svg+xml')
      assert.equal(FilesDataStore.mimetypeFromExtension('doc.pdf'), 'application/pdf')
      assert.equal(FilesDataStore.mimetypeFromExtension('video.mp4'), 'video/mp4')
      assert.equal(FilesDataStore.mimetypeFromExtension('audio.mp3'), 'audio/mpeg')
      assert.equal(FilesDataStore.mimetypeFromExtension('data.csv'), 'text/csv')
      assert.equal(FilesDataStore.mimetypeFromExtension('readme.md'), 'text/markdown')
      assert.equal(FilesDataStore.mimetypeFromExtension('unknown.xyz'), '')
    })
  })
})
