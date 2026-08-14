'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')

const JSONOutlineSchema = require('../../src/lib/JSONOutlineSchema.js')
const JSONOutlineSchemaItem = require('../../src/lib/JSONOutlineSchemaItem.js')

// Build a JSONOutlineSchemaItem from a partial object so each test starts from
// known, hand-authored data instead of whatever the constructor randomizes.
function mkItem(fields) {
  return Object.assign(new JSONOutlineSchemaItem(), fields)
}

// Worked-example outline used across ordering tests:
//   r1 (root, order 0)
//     c1 (child of r1, order 0)
//     c2 (child of r1, order 1)
//   r2 (root, order 1)
// Correct pre-order tree traversal: r1, c1, c2, r2.
function inOrderTree() {
  return [
    mkItem({ id: 'r1', order: 0, parent: '', indent: 0, title: 'Root 1', slug: 'root-1' }),
    mkItem({ id: 'c1', order: 0, parent: 'r1', indent: 1, title: 'Child 1', slug: 'child-1' }),
    mkItem({ id: 'c2', order: 1, parent: 'r1', indent: 1, title: 'Child 2', slug: 'child-2' }),
    mkItem({ id: 'r2', order: 1, parent: '', indent: 0, title: 'Root 2', slug: 'root-2' }),
  ]
}

test('JSONOutlineSchemaItem constructor sets every required field with the correct type and default value', () => {
  const item = new JSONOutlineSchemaItem()
  assert.ok(typeof item.id === 'string', 'id is a string')
  assert.ok(item.id.indexOf('item-') === 0, 'id is prefixed with item-')
  assert.strictEqual(item.indent, 0)
  assert.strictEqual(typeof item.indent, 'number')
  assert.strictEqual(item.location, '')
  assert.strictEqual(typeof item.location, 'string')
  assert.strictEqual(item.slug, '')
  assert.strictEqual(typeof item.slug, 'string')
  assert.strictEqual(item.order, 0)
  assert.strictEqual(typeof item.order, 'number')
  assert.strictEqual(item.parent, '')
  assert.strictEqual(typeof item.parent, 'string')
  assert.strictEqual(item.title, 'New item')
  assert.strictEqual(typeof item.title, 'string')
  assert.strictEqual(item.description, '')
  assert.strictEqual(typeof item.description, 'string')
  assert.ok(item.metadata && typeof item.metadata === 'object')
  assert.strictEqual(Object.keys(item.metadata).length, 0)
})

test('JSONOutlineSchemaItem constructor generates a unique id per instance', () => {
  const a = new JSONOutlineSchemaItem()
  const b = new JSONOutlineSchemaItem()
  assert.notStrictEqual(a.id, b.id)
})

test('JSONOutlineSchema constructor establishes the documented defaults', () => {
  const schema = new JSONOutlineSchema()
  assert.strictEqual(schema.file, null)
  assert.ok(typeof schema.id === 'string' && schema.id.length > 0)
  assert.strictEqual(schema.title, 'New site')
  assert.strictEqual(schema.author, '')
  assert.strictEqual(schema.description, '')
  assert.strictEqual(schema.license, 'by-sa')
  assert.ok(schema.metadata && typeof schema.metadata === 'object')
  assert.strictEqual(Object.keys(schema.metadata).length, 0)
  assert.ok(Array.isArray(schema.items))
  assert.strictEqual(schema.items.length, 0)
})

test('newItem returns a JSONOutlineSchemaItem with the default fields', () => {
  const schema = new JSONOutlineSchema()
  const item = schema.newItem()
  assert.ok(item instanceof JSONOutlineSchemaItem)
  assert.ok(item.id.indexOf('item-') === 0)
  assert.strictEqual(item.title, 'New item')
  assert.strictEqual(item.indent, 0)
  assert.strictEqual(item.order, 0)
  assert.strictEqual(item.parent, '')
})

test('validateItem copies only schema-known keys and returns a JSONOutlineSchemaItem', () => {
  const schema = new JSONOutlineSchema()
  const validated = schema.validateItem({
    id: 'abc',
    title: 'T',
    slug: 'sl',
    order: 5,
    parent: 'p',
    location: 'loc',
    indent: 2,
    description: 'd',
    metadata: { a: 1 },
    bogus: 'should not survive',
  })
  assert.ok(validated instanceof JSONOutlineSchemaItem)
  assert.strictEqual(validated.id, 'abc')
  assert.strictEqual(validated.title, 'T')
  assert.strictEqual(validated.slug, 'sl')
  assert.strictEqual(validated.order, 5)
  assert.strictEqual(validated.parent, 'p')
  assert.strictEqual(validated.location, 'loc')
  assert.strictEqual(validated.indent, 2)
  assert.strictEqual(validated.description, 'd')
  assert.deepStrictEqual(validated.metadata, { a: 1 })
  assert.strictEqual(validated.hasOwnProperty('bogus'), false)
})

test('addItem returns the new item count and stores a validated JSONOutlineSchemaItem', () => {
  const schema = new JSONOutlineSchema()
  const count1 = schema.addItem({ id: 'i1', title: 'First', order: 0, parent: '', slug: 'first', location: 'pages/i1/index.html', indent: 0, description: '', metadata: {} })
  assert.strictEqual(count1, 1)
  const count2 = schema.addItem({ id: 'i2', title: 'Second', order: 1, parent: '', slug: 'second', location: 'pages/i2/index.html', indent: 0, description: '', metadata: {} })
  assert.strictEqual(count2, 2)
  assert.strictEqual(schema.items.length, 2)
  assert.ok(schema.items[0] instanceof JSONOutlineSchemaItem)
  assert.strictEqual(schema.items[0].id, 'i1')
  assert.strictEqual(schema.items[1].id, 'i2')
})

test('getItemById returns the matching item or false', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  assert.strictEqual(schema.getItemById('c2').id, 'c2')
  assert.strictEqual(schema.getItemById('missing'), false)
})

test('getItemKeyById returns the array key (as a string) or false', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  // for-in enumerates keys as strings, so the key for c2 at index 2 is '2'
  assert.strictEqual(schema.getItemKeyById('c2'), '2')
  assert.strictEqual(schema.getItemKeyById('missing'), false)
})

test('getItemByProperty returns the first item whose property matches or false', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  assert.strictEqual(schema.getItemByProperty('slug', 'child-1').id, 'c1')
  assert.strictEqual(schema.getItemByProperty('title', 'Root 2').id, 'r2')
  assert.strictEqual(schema.getItemByProperty('slug', 'nope'), false)
})

test('updateItem overwrites the matching item and returns true; returns false when the id is absent', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  const ok = schema.updateItem({ id: 'r1', title: 'Renamed Root', order: 0, parent: '', slug: 'root-1', location: 'pages/r1/index.html', indent: 0, description: '', metadata: {} })
  assert.strictEqual(ok, true)
  assert.strictEqual(schema.getItemById('r1').title, 'Renamed Root')
  const missing = schema.updateItem({ id: 'nope', title: 'X' })
  assert.strictEqual(missing, false)
})

test('orderTree returns items in pre-order tree traversal when the items array is already in tree order', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  const ordered = schema.orderTree(schema.items)
  assert.deepStrictEqual(
    ordered.map((i) => i.id),
    ['r1', 'c1', 'c2', 'r2']
  )
})

test('orderTree sorts sibling children by their order field', () => {
  const schema = new JSONOutlineSchema()
  schema.items = [
    mkItem({ id: 'r1', order: 0, parent: '', indent: 0, title: 'Root 1' }),
    mkItem({ id: 'c2', order: 1, parent: 'r1', indent: 1, title: 'Child 2' }),
    mkItem({ id: 'c1', order: 0, parent: 'r1', indent: 1, title: 'Child 1' }),
    mkItem({ id: 'r2', order: 1, parent: '', indent: 0, title: 'Root 2' }),
  ]
  const ordered = schema.orderTree(schema.items)
  assert.deepStrictEqual(
    ordered.map((i) => i.id),
    ['r1', 'c1', 'c2', 'r2']
  )
})

test('findBranch returns the node followed by all of its descendants in tree order', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  const branch = schema.findBranch('r1')
  assert.deepStrictEqual(
    branch.map((i) => i.id),
    ['r1', 'c1', 'c2']
  )
})

test('findBranch returns only the node when it has no descendants', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  const branch = schema.findBranch('r2')
  assert.deepStrictEqual(
    branch.map((i) => i.id),
    ['r2']
  )
})

test('load hydrates the schema from a site.json file, escalating items to JSONOutlineSchemaItem objects', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jos-load-'))
  const siteDir = path.join(tmpRoot, 'mysite')
  fs.mkdirpSync(siteDir)
  const siteJson = {
    id: 'site-id-123',
    title: 'My Test Site',
    author: 'Tester',
    description: 'a description',
    license: 'by',
    metadata: { site: { name: 'mysite', settings: { pathauto: true } } },
    items: [
      { id: 'r1', indent: 0, location: 'pages/r1/index.html', slug: 'root-1', order: 0, parent: '', title: 'Root 1', description: 'd1', metadata: { created: 100 } },
      { id: 'c1', indent: 1, location: 'pages/c1/index.html', slug: 'child-1', order: 0, parent: 'r1', title: 'Child 1', description: 'd2', metadata: { created: 200 } },
      { id: 'r2', indent: 0, location: 'pages/r2/index.html', slug: 'root-2', order: 1, parent: '', title: 'Root 2', description: 'd3', metadata: { created: 300 } },
    ],
  }
  const siteFile = path.join(siteDir, 'site.json')
  fs.writeFileSync(siteFile, JSON.stringify(siteJson, null, 2))

  try {
    const schema = new JSONOutlineSchema()
    const result = await schema.load(siteFile)
    assert.strictEqual(result, true)
    assert.strictEqual(schema.file, siteFile)
    assert.strictEqual(schema.id, 'site-id-123')
    assert.strictEqual(schema.title, 'My Test Site')
    assert.strictEqual(schema.author, 'Tester')
    assert.strictEqual(schema.description, 'a description')
    assert.strictEqual(schema.license, 'by')
    assert.strictEqual(schema.metadata.site.name, 'mysite')
    assert.strictEqual(schema.metadata.site.settings.pathauto, true)
    assert.strictEqual(schema.items.length, 3)
    assert.ok(schema.items[0] instanceof JSONOutlineSchemaItem)
    assert.strictEqual(schema.items[0].id, 'r1')
    assert.strictEqual(schema.items[0].title, 'Root 1')
    assert.strictEqual(schema.items[0].metadata.created, 100)
    assert.strictEqual(schema.items[1].parent, 'r1')
    assert.strictEqual(schema.items[1].indent, 1)
    assert.strictEqual(schema.items[2].id, 'r2')
  }
  finally {
    fs.removeSync(tmpRoot)
  }
})

test('removeItem returns false when the id is not present in the outline', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  assert.strictEqual(schema.removeItem('nonexistent'), false)
})

test('removeItem returns the removed item and removes it from the outline', () => {
  const schema = new JSONOutlineSchema()
  schema.items = inOrderTree()
  const removed = schema.removeItem('c1')
  assert.strictEqual(removed.id, 'c1')
  assert.strictEqual(schema.items.length, 3)
  assert.strictEqual(schema.getItemById('c1'), false)
})
