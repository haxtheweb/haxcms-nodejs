'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { importHtmlToItems } = require('../../src/siteRoutes/v1/importUtils.js')

// Default options mirror the common call-site shape: site-level import,
// no type hint, no parent. titleValue defaults to 'import' in the module.
const SITE_OPTS = { method: 'site', titleValue: 'import', type: '', parentId: null }

test('single h1 with body content produces exactly one item', async () => {
  const items = await importHtmlToItems('<h1>Title</h1><p>Body</p>', SITE_OPTS)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Title')
  assert.equal(items[0].order, 0)
  assert.equal(items[0].parent, null)
  assert.equal(items[0].contents, '<p>Body</p>')
})

test('two h1 headings split into two separate items preserving order', async () => {
  const items = await importHtmlToItems(
    '<h1>First</h1><p>1</p><h1>Second</h1><p>2</p>',
    SITE_OPTS,
  )
  assert.equal(items.length, 2)
  assert.equal(items[0].title, 'First')
  assert.equal(items[1].title, 'Second')
  assert.equal(items[0].order, 0)
  assert.equal(items[1].order, 1)
  assert.equal(items[0].contents, '<p>1</p>')
  assert.equal(items[1].contents, '<p>2</p>')
  // both root-level items share the supplied parentId
  assert.equal(items[0].parent, null)
  assert.equal(items[1].parent, null)
})

test('h1 followed by h2 creates a parent/child relationship via item.parent', async () => {
  const items = await importHtmlToItems(
    '<h1>Parent</h1><p>intro</p><h2>Child</h2><p>child body</p>',
    SITE_OPTS,
  )
  assert.equal(items.length, 2)
  assert.equal(items[0].title, 'Parent')
  assert.equal(items[1].title, 'Child')
  // the root item gets the supplied parentId (null here)
  assert.equal(items[0].parent, null)
  // the child's parent points at the generated id of the root item
  assert.equal(items[1].parent, items[0].id)
  // child is indented one level deeper
  assert.equal(items[1].indent, 1)
  // child slug is nested under the parent slug
  assert.equal(items[1].slug, 'parent/child')
  // root contents is the content before the first h2
  assert.equal(items[0].contents, '<p>intro</p>')
  // child contents is the content after the h2
  assert.equal(items[1].contents, '<p>child body</p>')
})

test('empty HTML string produces a single fallback item with the titleValue', async () => {
  const items = await importHtmlToItems('', SITE_OPTS)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'import')
  assert.equal(items[0].contents, '')
  assert.equal(items[0].parent, null)
})

test('whitespace-only HTML produces a single item', async () => {
  const items = await importHtmlToItems('   ', SITE_OPTS)
  assert.equal(items.length, 1)
  // whitespace has no headings so it falls through to single-page mode
  assert.equal(items[0].title, 'import')
  assert.equal(items[0].parent, null)
})

test('parentId is passed through to generated root items', async () => {
  const items = await importHtmlToItems(
    '<h1>Title</h1><p>Body</p>',
    { method: 'site', titleValue: 'import', type: '', parentId: 'parent-xyz' },
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].parent, 'parent-xyz')
})

test('parentId seeds root items while children still link to their generated parent id', async () => {
  const items = await importHtmlToItems(
    '<h1>Parent</h1><p>intro</p><h2>Child</h2><p>cb</p>',
    { method: 'site', titleValue: 'import', type: '', parentId: 'parent-xyz' },
  )
  assert.equal(items.length, 2)
  // root item gets the supplied parentId
  assert.equal(items[0].parent, 'parent-xyz')
  // child links to the root item's generated id, not the supplied parentId
  assert.equal(items[1].parent, items[0].id)
})

test('default method falls back to site when method is omitted', async () => {
  const items = await importHtmlToItems('<h1>Title</h1><p>Body</p>', {
    titleValue: 'import',
    parentId: null,
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Title')
})

test('multiple h2 children under one h1 each link to the same parent id', async () => {
  const items = await importHtmlToItems(
    '<h1>Parent</h1><p>intro</p><h2>Child A</h2><p>a</p><h2>Child B</h2><p>b</p>',
    SITE_OPTS,
  )
  assert.equal(items.length, 3)
  assert.equal(items[0].title, 'Parent')
  assert.equal(items[1].title, 'Child A')
  assert.equal(items[2].title, 'Child B')
  // both children parent back to the single root item
  assert.equal(items[1].parent, items[0].id)
  assert.equal(items[2].parent, items[0].id)
  // children are ordered sequentially within the parent
  assert.equal(items[1].order, 0)
  assert.equal(items[2].order, 1)
})

test('item ids are unique UUIDs prefixed with item-', async () => {
  const items = await importHtmlToItems(
    '<h1>First</h1><p>1</p><h1>Second</h1><p>2</p>',
    SITE_OPTS,
  )
  assert.equal(items.length, 2)
  assert.ok(items[0].id && items[0].id.indexOf('item-') === 0, 'id should be prefixed with item-')
  assert.ok(items[1].id && items[1].id.indexOf('item-') === 0)
  assert.notEqual(items[0].id, items[1].id)
})
