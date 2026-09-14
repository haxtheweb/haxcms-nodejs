'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const EntityDefinition = require('../../src/lib/EntityDefinition.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const NotImplementedStorage = require('../../src/lib/NotImplementedStorage.js')

describe('EntityDefinition — Phase 1 (#3043)', () => {
  test('standalone file definition mirrors entry fields', () => {
    const entry = {
      type: 'file',
      scope: 'site',
      description: "A file asset in a site's files directory",
      primaryKey: 'uuid',
      uniqueKeys: ['uuid'],
      requiredFields: ['uuid', 'path', 'name', 'mimetype'],
      storage: {
        type: 'datastore',
        enabled: true,
        scope: 'site',
        location: '{siteDirectory}/files/files.json',
        storeSchema: 'HAXCMS-FILE-SCHEMA-V1',
        collectionKey: 'files',
        indexKey: 'uuid',
      },
      supportedOperations: ['load', 'save', 'list', 'delete', 'reconcile'],
      endpoints: ['/x/api/v1/files', '/x/api/v1/files/{fileUuid}'],
      filterableFields: ['mimetype', 'name', 'path'],
      sortableFields: ['path', 'name', 'size', 'dateCreated'],
      selectableFields: [
        'uuid', 'path', 'fullUrl', 'url', 'mimetype', 'name',
        'size', 'dateCreated', 'width', 'height',
      ],
      formats: ['json', 'md', 'yaml', 'xml'],
      auth: 'authenticated-site',
      enabled: true,
    }
    const def = new EntityDefinition(entry)

    assert.equal(def.getType(), 'file')
    assert.equal(def.getScope(), 'site')
    assert.equal(def.getDescription(), "A file asset in a site's files directory")
    assert.equal(def.getPrimaryKey(), 'uuid')
    assert.deepEqual(def.getUniqueKeys(), ['uuid'])
    assert.deepEqual(def.getRequiredFields(), ['uuid', 'path', 'name', 'mimetype'])
    assert.equal(def.getStorageType(), 'datastore')
    const storage = def.getStorageBlock()
    assert.equal(storage.type, 'datastore')
    assert.equal(storage.enabled, true)
    assert.equal(storage.location, '{siteDirectory}/files/files.json')
    assert.equal(storage.storeSchema, 'HAXCMS-FILE-SCHEMA-V1')
    assert.equal(storage.collectionKey, 'files')
    assert.equal(storage.indexKey, 'uuid')
    assert.deepEqual(
      def.getSupportedOperations(),
      ['load', 'save', 'list', 'delete', 'reconcile'],
    )
    assert.deepEqual(
      def.getEndpoints(),
      ['/x/api/v1/files', '/x/api/v1/files/{fileUuid}'],
    )
    assert.deepEqual(def.getFilterableFields(), ['mimetype', 'name', 'path'])
    assert.deepEqual(def.getSortableFields(), ['path', 'name', 'size', 'dateCreated'])
    assert.ok(def.getSelectableFields().indexOf('uuid') !== -1)
    assert.deepEqual(def.getFormats(), ['json', 'md', 'yaml', 'xml'])
    assert.equal(def.getAuth(), 'authenticated-site')
    assert.equal(def.isEnabled(), true)
    // file is datastore => writable + implemented.
    assert.equal(def.isReadOnly(), false)
    assert.equal(def.isImplemented(), true)
  })

  test('standalone getStorage returns NotImplementedStorage without resolver', () => {
    const def = new EntityDefinition({ type: 'theme' })
    const storage = def.getStorage()
    assert.ok(storage instanceof NotImplementedStorage)
    assert.equal(storage.getType(), 'theme')
  })

  test('registry file definition mirrors yaml', () => {
    const registry = new EntityRegistry()
    const def = registry.getDefinition('file')
    assert.equal(def.getType(), 'file')
    assert.equal(def.getScope(), 'site')
    assert.equal(def.getPrimaryKey(), 'uuid')
    assert.deepEqual(def.getUniqueKeys(), ['uuid'])
    assert.deepEqual(def.getRequiredFields(), ['uuid', 'path', 'name', 'mimetype'])
    assert.equal(def.getStorageType(), 'datastore')
    assert.equal(def.isImplemented(), true)
    assert.equal(def.isReadOnly(), false)
    assert.ok(def.getEndpoints().indexOf('/x/api/v1/files') !== -1)
    assert.ok(def.getFilterableFields().indexOf('mimetype') !== -1)
    assert.ok(def.getSortableFields().indexOf('size') !== -1)
  })

  test('registry site definition mirrors yaml', () => {
    const registry = new EntityRegistry()
    const def = registry.getDefinition('site')
    assert.equal(def.getType(), 'site')
    assert.equal(def.getScope(), 'system')
    assert.equal(def.getPrimaryKey(), 'metadata.site.name')
    assert.deepEqual(def.getUniqueKeys(), ['id', 'metadata.site.name'])
    assert.deepEqual(
      def.getRequiredFields(),
      ['id', 'metadata.site.name', 'items'],
    )
    assert.equal(def.getStorageType(), 'jos')
    // site is jos (non-datastore) => read-only + not implemented this plan.
    assert.equal(def.isReadOnly(), true)
    assert.equal(def.isImplemented(), false)
    assert.deepEqual(def.getEndpoints(), ['/system/api/v1/sites'])
    // site declares no filterable/sortable fields in entities.yaml.
    assert.deepEqual(def.getFilterableFields(), [])
    assert.deepEqual(def.getSortableFields(), [])
    assert.ok(def.getSelectableFields().indexOf('id') !== -1)
  })

  test('registry getStorage returns NotImplementedStorage for all unregistered types', () => {
    const registry = new EntityRegistry()
    const types = ['file', 'item', 'theme', 'skeleton', 'site', 'system']
    for (const type of types) {
      const storage = registry.getDefinition(type).getStorage()
      assert.ok(
        storage instanceof NotImplementedStorage,
        type + ' storage should be NotImplementedStorage',
      )
      assert.equal(storage.getType(), type)
    }
  })

  test('toDescriptorArray mirrors entry with backward-compat name', () => {
    const registry = new EntityRegistry()
    const def = registry.getDefinition('item')
    const descriptor = def.toDescriptorArray()
    // Extended EntityDescriptor shape.
    assert.equal(descriptor.type, 'item')
    assert.equal(descriptor.name, 'item') // backward-compat alias
    assert.equal(descriptor.scope, 'site')
    assert.equal(descriptor.primaryKey, 'id')
    assert.deepEqual(descriptor.uniqueKeys, ['id', 'slug'])
    assert.deepEqual(descriptor.requiredFields, ['id', 'title', 'slug', 'location'])
    assert.equal(descriptor.storage.type, 'jos.items')
    assert.equal(descriptor.storage.enabled, false)
    assert.ok(descriptor.endpoints.indexOf('/x/api/v1/items') !== -1)
    assert.ok(descriptor.supportedOperations.indexOf('load') !== -1)
    assert.equal(descriptor.enabled, true)
  })

  test('toDescriptorArray for file includes storage block with enabled=true', () => {
    const registry = new EntityRegistry()
    const def = registry.getDefinition('file')
    const descriptor = def.toDescriptorArray()
    assert.equal(descriptor.type, 'file')
    assert.equal(descriptor.storage.type, 'datastore')
    assert.equal(descriptor.storage.enabled, true)
    assert.equal(descriptor.storage.indexKey, 'uuid')
    assert.equal(descriptor.storage.storeSchema, 'HAXCMS-FILE-SCHEMA-V1')
    assert.ok(descriptor.supportedOperations.indexOf('save') !== -1)
    assert.ok(descriptor.endpoints.indexOf('/x/api/v1/files') !== -1)
    assert.equal(descriptor.enabled, true)
  })
})
