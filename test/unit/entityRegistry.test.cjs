'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const EntityDefinition = require('../../src/lib/EntityDefinition.js')
const Entity = require('../../src/lib/Entity.js')
const EntityStorage = require('../../src/lib/EntityStorage.js')
const NotImplementedStorage = require('../../src/lib/NotImplementedStorage.js')
const EntityReadOnlyException = require('../../src/lib/EntityReadOnlyException.js')
const EntityStorageNotImplementedException = require('../../src/lib/EntityStorageNotImplementedException.js')

const KNOWN_TYPES = ['file', 'item', 'theme', 'skeleton', 'site', 'system']

describe('EntityRegistry — Phase 1 (#3043)', () => {
  test('getDefinitions returns all six types merged', () => {
    const registry = new EntityRegistry()
    const definitions = registry.getDefinitions()
    const types = definitions.map((d) => d.getType())
    for (const expected of KNOWN_TYPES) {
      assert.ok(types.indexOf(expected) !== -1, `Expected type "${expected}" in definitions`)
    }
    assert.equal(definitions.length, 6)
  })

  for (const type of KNOWN_TYPES) {
    test(`getDefinition works for ${type} from any scope`, () => {
      const registry = new EntityRegistry()
      const definition = registry.getDefinition(type)
      assert.ok(definition !== null)
      assert.equal(definition.getType(), type)
      assert.ok(definition instanceof EntityDefinition)
    })
  }

  test('getDefinition returns null for unknown type', () => {
    const registry = new EntityRegistry()
    assert.equal(registry.getDefinition('nonexistent'), null)
  })

  test('getStorage(file) matches getDefinition(file).getStorage() — both NotImplementedStorage', () => {
    const registry = new EntityRegistry()
    const shorthand = registry.getStorage('file')
    const chained = registry.getDefinition('file').getStorage()
    assert.ok(shorthand instanceof NotImplementedStorage)
    assert.ok(chained instanceof NotImplementedStorage)
    assert.equal(shorthand.getType(), 'file')
    assert.equal(chained.getType(), 'file')
  })

  for (const type of KNOWN_TYPES) {
    test(`getStorage(${type}).load throws EntityStorageNotImplementedException`, () => {
      const registry = new EntityRegistry()
      const storage = registry.getStorage(type)
      assert.ok(storage instanceof NotImplementedStorage)
      assert.throws(
        () => storage.load('any-key'),
        (err) => err instanceof EntityStorageNotImplementedException,
      )
    })

    test(`getStorage(${type}).list throws EntityStorageNotImplementedException`, () => {
      const registry = new EntityRegistry()
      const storage = registry.getStorage(type)
      assert.throws(
        () => storage.list(),
        (err) => err instanceof EntityStorageNotImplementedException,
      )
    })
  }

  test('save on non-datastore entity (theme) throws EntityReadOnlyException', () => {
    const registry = new EntityRegistry()
    const definition = registry.getDefinition('theme')
    const entity = new Entity(definition, { element: 'clean-one' })
    assert.throws(
      () => entity.save(),
      (err) => err instanceof EntityReadOnlyException,
    )
  })

  test('delete on non-datastore entity (site) throws EntityReadOnlyException', () => {
    const registry = new EntityRegistry()
    const definition = registry.getDefinition('site')
    const entity = new Entity(definition, {
      id: 'site-uuid',
      metadata: { site: { name: 'mysite' } },
    })
    assert.throws(
      () => entity.delete(),
      (err) => err instanceof EntityReadOnlyException,
    )
  })

  test('save on datastore entity (file) delegates to NotImplementedStorage', () => {
    const registry = new EntityRegistry()
    const definition = registry.getDefinition('file')
    const entity = new Entity(definition, {
      uuid: 'a1b2c3d4',
      path: 'files/x.jpg',
      name: 'x.jpg',
      mimetype: 'image/jpeg',
    })
    assert.equal(definition.isReadOnly(), false)
    assert.throws(
      () => entity.save(),
      (err) => err instanceof EntityStorageNotImplementedException,
    )
  })

  const READ_ONLY_STATES = [
    ['file', false, true],
    ['item', true, false],
    ['theme', true, false],
    ['skeleton', true, false],
    ['site', true, false],
    ['system', true, false],
  ]

  for (const [type, expectedReadOnly, expectedImplemented] of READ_ONLY_STATES) {
    test(`isReadOnly/isImplemented correct for ${type}`, () => {
      const registry = new EntityRegistry()
      const definition = registry.getDefinition(type)
      assert.equal(definition.isReadOnly(), expectedReadOnly)
      assert.equal(definition.isImplemented(), expectedImplemented)
    })
  }

  test('scope=site filter returns file and item', () => {
    const registry = new EntityRegistry()
    const definitions = registry.getDefinitions('site')
    const types = definitions.map((d) => d.getType()).sort()
    assert.deepEqual(types, ['file', 'item'])
  })

  test('scope=system filter returns theme, skeleton, site, system', () => {
    const registry = new EntityRegistry()
    const definitions = registry.getDefinitions('system')
    const types = definitions.map((d) => d.getType()).sort()
    assert.deepEqual(types, ['site', 'skeleton', 'system', 'theme'])
  })

  test('registerStorage returns real adapter for file type', () => {
    const registry = new EntityRegistry()
    const dummy = new DummyStorage('file')
    registry.registerStorage('file', dummy)
    assert.equal(registry.getStorage('file'), dummy)
    // Unregistered types still return NotImplementedStorage.
    assert.ok(registry.getStorage('theme') instanceof NotImplementedStorage)
  })
})

// Minimal dummy EntityStorage for the adapter-registration test.
class DummyStorage extends EntityStorage {
  constructor(type) {
    super()
    this.type = String(type)
  }
  load() {
    return null
  }
  list() {
    return []
  }
  save() {
    return true
  }
  delete() {
    return true
  }
}
