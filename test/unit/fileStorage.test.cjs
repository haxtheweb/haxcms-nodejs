'use strict'

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const Entity = require('../../src/lib/Entity.js')
const EntityStorage = require('../../src/lib/EntityStorage.js')
const NotImplementedStorage = require('../../src/lib/NotImplementedStorage.js')
const EntityReadOnlyException = require('../../src/lib/EntityReadOnlyException.js')
const EntityStorageNotImplementedException = require('../../src/lib/EntityStorageNotImplementedException.js')
const FileStorage = require('../../src/lib/FileStorage.js')
const FileEntity = require('../../src/lib/FileEntity.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
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
    },
  }
  return { tmpRoot, site, siteDirectory, filesDir }
}

describe('FileStorage — Phase 2 (#3043)', () => {
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

  describe('registerOn', () => {
    test('registerOn wires FileStorage as the file adapter', () => {
      const registry = new EntityRegistry(site)
      // Before: file storage is NotImplementedStorage.
      assert.ok(registry.getStorage('file') instanceof NotImplementedStorage)
      const storage = FileStorage.registerOn(registry)
      // After: file storage is the real FileStorage.
      assert.ok(storage instanceof FileStorage)
      assert.ok(storage instanceof EntityStorage)
      assert.equal(registry.getStorage('file'), storage)
    })

    test('registerOn returns the registered adapter', () => {
      const registry = new EntityRegistry(site)
      const storage = FileStorage.registerOn(registry)
      assert.ok(storage instanceof FileStorage)
      assert.equal(storage.getDataStore() instanceof FilesDataStore, true)
    })

    test('other types remain NotImplementedStorage after file registration', () => {
      const registry = new EntityRegistry(site)
      FileStorage.registerOn(registry)
      assert.ok(registry.getStorage('theme') instanceof NotImplementedStorage)
      assert.ok(registry.getStorage('item') instanceof NotImplementedStorage)
      assert.ok(registry.getStorage('site') instanceof NotImplementedStorage)
    })
  })

  describe('load by uuid', () => {
    test('load returns FileEntity for known uuid', () => {
      const store = new FileStorage(site)
      // Upsert a record directly via datastore.
      store.getDataStore().upsertRecord({
        uuid: 'load-uuid',
        path: 'files/load.txt',
        name: 'load.txt',
        mimetype: 'text/plain',
        size: 10,
      })
      const entity = store.load('load-uuid')
      assert.ok(entity instanceof FileEntity)
      assert.equal(entity.getUuid(), 'load-uuid')
      assert.equal(entity.getPath(), 'files/load.txt')
      assert.equal(entity.getName(), 'load.txt')
      assert.equal(entity.getMimetype(), 'text/plain')
      assert.equal(entity.getSize(), 10)
    })

    test('load returns null for unknown uuid', () => {
      const store = new FileStorage(site)
      const entity = store.load('nonexistent')
      assert.equal(entity, null)
    })

    test('loaded entity has a definition with save capability', () => {
      const store = new FileStorage(site)
      store.getDataStore().upsertRecord({
        uuid: 'def-uuid',
        path: 'files/def.txt',
        name: 'def.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      const entity = store.load('def-uuid')
      const def = entity.getDefinition()
      assert.equal(def.getType(), 'file')
      assert.equal(def.isReadOnly(), false)
    })
  })

  describe('list (reconciles first)', () => {
    test('list reconciles from disk before returning', async () => {
      // Drop a file on disk without touching files.json.
      await fs.writeFile(path.join(filesDir, 'listed.txt'), 'content')
      const store = new FileStorage(site)
      const entities = await store.list()
      assert.equal(entities.length, 1)
      assert.ok(entities[0] instanceof FileEntity)
      assert.equal(entities[0].getName(), 'listed.txt')
    })

    test('list returns empty when no files exist', async () => {
      const store = new FileStorage(site)
      const entities = await store.list()
      assert.equal(entities.length, 0)
    })

    test('list filters by mimetype prefix', async () => {
      await fs.writeFile(path.join(filesDir, 'a.txt'), 'aaa')
      await fs.writeFile(path.join(filesDir, 'b.csv'), 'bbb')
      const store = new FileStorage(site)
      const all = await store.list()
      assert.equal(all.length, 2)
      const textOnly = await store.list({ mimetype: 'text/plain' })
      assert.equal(textOnly.length, 1)
      assert.equal(textOnly[0].getName(), 'a.txt')
      const csvOnly = await store.list({ mimetype: 'text/csv' })
      assert.equal(csvOnly.length, 1)
      assert.equal(csvOnly[0].getName(), 'b.csv')
    })
  })

  describe('save upsert + required-field validation', () => {
    test('save upserts a valid FileEntity', () => {
      const store = new FileStorage(site)
      const def = store.resolveDefinition()
      const entity = new FileEntity(def, {
        uuid: 'save-uuid',
        path: 'files/save.txt',
        name: 'save.txt',
        mimetype: 'text/plain',
        size: 5,
      })
      const result = store.save(entity)
      assert.equal(result, true)
      const loaded = store.load('save-uuid')
      assert.ok(loaded)
      assert.equal(loaded.getSize(), 5)
    })

    test('save returns false when uuid is missing', () => {
      const store = new FileStorage(site)
      const entity = new FileEntity(store.resolveDefinition(), {
        path: 'files/nouuid.txt',
        name: 'nouuid.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.equal(store.save(entity), false)
    })

    test('save returns false when path is missing', () => {
      const store = new FileStorage(site)
      const entity = new FileEntity(store.resolveDefinition(), {
        uuid: 'nopath',
        name: 'nopath.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.equal(store.save(entity), false)
    })

    test('save returns false when name is missing', () => {
      const store = new FileStorage(site)
      const entity = new FileEntity(store.resolveDefinition(), {
        uuid: 'noname',
        path: 'files/noname.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      assert.equal(store.save(entity), false)
    })

    test('save returns false when mimetype is missing', () => {
      const store = new FileStorage(site)
      const entity = new FileEntity(store.resolveDefinition(), {
        uuid: 'nomime',
        path: 'files/nomime.txt',
        name: 'nomime.txt',
        size: 1,
      })
      assert.equal(store.save(entity), false)
    })

    test('save updates existing record (upsert)', () => {
      const store = new FileStorage(site)
      const def = store.resolveDefinition()
      store.save(new FileEntity(def, {
        uuid: 'upsert-s',
        path: 'files/old.txt',
        name: 'old.txt',
        mimetype: 'text/plain',
        size: 10,
      }))
      store.save(new FileEntity(def, {
        uuid: 'upsert-s',
        path: 'files/new.txt',
        name: 'new.txt',
        mimetype: 'text/plain',
        size: 20,
      }))
      const records = store.getDataStore().getRecords()
      assert.equal(records.length, 1)
      assert.equal(records[0].path, 'files/new.txt')
    })
  })

  describe('delete removes record + scrubs uuid from pages', () => {
    test('delete removes the files.json record', () => {
      const store = new FileStorage(site)
      store.getDataStore().upsertRecord({
        uuid: 'del-uuid',
        path: 'files/del.txt',
        name: 'del.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      const removed = store.delete('del-uuid')
      assert.equal(removed, true)
      assert.equal(store.load('del-uuid'), null)
    })

    test('delete scrubs uuid from page.metadata.files (string entries)', () => {
      // Build a fake site with manifest.items where one page has the uuid
      // as a string in metadata.files.
      const targetUuid = 'scrub-uuid'
      const anotherUuid = 'keep-uuid'
      site.manifest.items = [
        {
          id: 'page-1',
          title: 'Page 1',
          metadata: {
            files: [targetUuid, anotherUuid],
          },
        },
        {
          id: 'page-2',
          title: 'Page 2',
          metadata: {
            files: [anotherUuid],
          },
        },
        {
          id: 'page-3',
          title: 'Page 3',
          metadata: {},
        },
      ]
      const store = new FileStorage(site)
      store.getDataStore().upsertRecord({
        uuid: targetUuid,
        path: 'files/scrub.txt',
        name: 'scrub.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      store.delete(targetUuid)
      // page-1 should only have keep-uuid.
      assert.deepEqual(site.manifest.items[0].metadata.files, [anotherUuid])
      // page-2 should be unchanged.
      assert.deepEqual(site.manifest.items[1].metadata.files, [anotherUuid])
      // page-3 should be unchanged (no files array).
      assert.ok(!site.manifest.items[2].metadata.files)
    })

    test('delete scrubs uuid case-insensitively', () => {
      const targetUuid = 'ScRuB-UuId'
      site.manifest.items = [
        {
          id: 'page-1',
          metadata: { files: [targetUuid] },
        },
      ]
      const store = new FileStorage(site)
      store.getDataStore().upsertRecord({
        uuid: targetUuid,
        path: 'files/s.txt',
        name: 's.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      store.delete(targetUuid.toLowerCase())
      assert.deepEqual(site.manifest.items[0].metadata.files, [])
    })

    test('delete leaves legacy object entries untouched', () => {
      // Legacy shape: entries are objects, not uuid strings.
      const legacyEntry = { path: 'files/legacy.txt', name: 'legacy.txt' }
      site.manifest.items = [
        {
          id: 'page-1',
          metadata: { files: [legacyEntry, 'string-uuid'] },
        },
      ]
      const store = new FileStorage(site)
      store.getDataStore().upsertRecord({
        uuid: 'string-uuid',
        path: 'files/string.txt',
        name: 'string.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      store.delete('string-uuid')
      // Legacy object should remain; string uuid should be scrubbed.
      assert.equal(site.manifest.items[0].metadata.files.length, 1)
      assert.equal(site.manifest.items[0].metadata.files[0], legacyEntry)
    })

    test('delete returns false for unknown uuid', () => {
      const store = new FileStorage(site)
      const removed = store.delete('nonexistent')
      assert.equal(removed, false)
    })

    test('delete returns false for empty uuid', () => {
      const store = new FileStorage(site)
      const removed = store.delete('')
      assert.equal(removed, false)
    })

    test('delete saves manifest when pages modified', () => {
      let manifestSaved = false
      site.manifest.items = [
        { id: 'p1', metadata: { files: ['will-scrub'] } },
      ]
      site.manifest.save = function () {
        manifestSaved = true
      }
      const store = new FileStorage(site)
      store.getDataStore().upsertRecord({
        uuid: 'will-scrub',
        path: 'files/w.txt',
        name: 'w.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      store.delete('will-scrub')
      assert.equal(manifestSaved, true)
    })
  })

  describe('read-only guard', () => {
    test('Entity.save() on non-file type still throws EntityReadOnlyException', () => {
      const registry = new EntityRegistry(site)
      // theme is non-datastore => read-only.
      const themeDef = registry.getDefinition('theme')
      const entity = new Entity(themeDef, { element: 'clean-one' })
      assert.throws(
        () => entity.save(),
        (err) => err instanceof EntityReadOnlyException,
      )
    })

    test('file Entity.save() delegates to FileStorage (not NotImplemented)', () => {
      const registry = new EntityRegistry(site)
      FileStorage.registerOn(registry)
      const fileDef = registry.getDefinition('file')
      const entity = new FileEntity(fileDef, {
        uuid: 'delegate-uuid',
        path: 'files/delegate.txt',
        name: 'delegate.txt',
        mimetype: 'text/plain',
        size: 3,
      })
      // Should NOT throw EntityStorageNotImplementedException.
      assert.doesNotThrow(() => entity.save())
      // Record should be persisted.
      const storage = registry.getStorage('file')
      assert.ok(storage instanceof FileStorage)
      const loaded = storage.load('delegate-uuid')
      assert.ok(loaded)
      assert.equal(loaded.getName(), 'delegate.txt')
    })

    test('file Entity.save() without registered adapter throws NotImplemented', () => {
      const registry = new EntityRegistry(site)
      // Do NOT register FileStorage.
      const fileDef = registry.getDefinition('file')
      const entity = new FileEntity(fileDef, {
        uuid: 'no-adapter',
        path: 'files/no.txt',
        name: 'no.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      // file is datastore => not read-only, but no adapter registered.
      assert.throws(
        () => entity.save(),
        (err) => err instanceof EntityStorageNotImplementedException,
      )
    })

    test('file Entity.delete() delegates to FileStorage', () => {
      const registry = new EntityRegistry(site)
      const storage = FileStorage.registerOn(registry)
      const fileDef = registry.getDefinition('file')
      storage.getDataStore().upsertRecord({
        uuid: 'del-entity',
        path: 'files/de.txt',
        name: 'de.txt',
        mimetype: 'text/plain',
        size: 1,
      })
      const entity = storage.load('del-entity')
      assert.ok(entity instanceof FileEntity)
      entity.delete()
      assert.equal(storage.load('del-entity'), null)
    })
  })

  describe('resolveDefinition', () => {
    test('uses injected definition from registry when available', () => {
      const registry = new EntityRegistry(site)
      const storage = FileStorage.registerOn(registry)
      const def = storage.resolveDefinition()
      // Should be the same definition object from the registry.
      assert.equal(def, registry.getDefinition('file'))
    })

    test('builds standalone definition when no injected definition', () => {
      const store = new FileStorage(site, null)
      const def = store.resolveDefinition()
      assert.equal(def.getType(), 'file')
      assert.equal(def.getStorageType(), 'datastore')
      assert.equal(def.isReadOnly(), false)
      // The standalone resolver should return this storage for 'file'.
      const resolved = def.getStorage()
      assert.equal(resolved, store)
    })
  })
})
