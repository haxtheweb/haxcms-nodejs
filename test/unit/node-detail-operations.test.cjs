'use strict'

// The HAXCMS singleton is constructed when nodeDetailOperations.js is required,
// which reads/writes the on-disk config directory at load time. Force config
// discovery into the system temp directory and select CLI mode so the singleton
// never blocks on default credentials and does not mutate the user's home
// config directory. These must be set before the first require of the module.
process.env.VERCEL_ENV = '1'
process.env.haxcms_middleware = 'node-cli'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyNodeDetailOperation,
  PAGE_DETAIL_OPERATIONS,
  createStatusError,
  isPathautoEnabled,
} = require('../../src/lib/nodeDetailOperations.js')

// Build a minimal in-memory site collaborator that satisfies the contract
// applyNodeDetailOperation expects: a manifest with items + metadata.site.updated,
// a loadNode(id) lookup, and async no-op save / updateAlternateFormats / gitCommit.
// The site object is an input to the function under test, not a sibling module,
// so providing this stand-in does not mock any module under test.
function mkSite(items) {
  const cloned = items.map(function (x) {
    return Object.assign({}, x, { metadata: Object.assign({}, x.metadata) })
  })
  const site = {
    manifest: {
      items: cloned,
      metadata: { site: { updated: 0 } },
    },
    updateAlternateFormats: async function () {},
    gitCommit: async function () {},
  }
  site.manifest.save = async function () {}
  site.loadNode = function (id) {
    return site.manifest.items.find(function (i) { return i.id === id }) || null
  }
  return site
}

function node(id, order, parent, indent, extra) {
  return Object.assign(
    { id: id, title: 'T ' + id, slug: id, order: order, parent: parent, indent: indent, metadata: {} },
    extra || {}
  )
}

test('PAGE_DETAIL_OPERATIONS is a Set of the page-detail operations only', () => {
  assert.ok(PAGE_DETAIL_OPERATIONS instanceof Set)
  assert.deepStrictEqual(
    Array.from(PAGE_DETAIL_OPERATIONS).sort(),
    [
      'setDescription',
      'setHideInMenu',
      'setIcon',
      'setImage',
      'setLocked',
      'setMedia',
      'setPublished',
      'setRelatedItems',
      'setTags',
      'setTitle',
    ]
  )
  // Outline-structure operations are deliberately not page-detail operations.
  assert.strictEqual(PAGE_DETAIL_OPERATIONS.has('moveUp'), false)
  assert.strictEqual(PAGE_DETAIL_OPERATIONS.has('moveDown'), false)
  assert.strictEqual(PAGE_DETAIL_OPERATIONS.has('indent'), false)
  assert.strictEqual(PAGE_DETAIL_OPERATIONS.has('outdent'), false)
})

test('createStatusError builds an Error with the given status and message', () => {
  const err = createStatusError(404, 'Node not found')
  assert.ok(err instanceof Error)
  assert.strictEqual(err.status, 404)
  assert.strictEqual(err.message, 'Node not found')
  assert.strictEqual(err.featureDisabled, undefined)
})

test('createStatusError applies default status and message', () => {
  const err = createStatusError()
  assert.strictEqual(err.status, 500)
  assert.strictEqual(err.message, 'Unable to complete node operation')
})

test('createStatusError sets featureDisabled when requested via options', () => {
  const err = createStatusError(403, 'disabled', { featureDisabled: true })
  assert.strictEqual(err.status, 403)
  assert.strictEqual(err.featureDisabled, true)
})

test('isPathautoEnabled is falsey for null sites, missing settings, and pathauto !== true', () => {
  assert.ok(!isPathautoEnabled(null))
  assert.ok(!isPathautoEnabled({ manifest: { metadata: { site: {} } } }))
  assert.strictEqual(
    isPathautoEnabled({ manifest: { metadata: { site: { settings: { pathauto: false } } } } }),
    false
  )
})

test('isPathautoEnabled is true only when settings.pathauto is strictly true', () => {
  assert.strictEqual(
    isPathautoEnabled({ manifest: { metadata: { site: { settings: { pathauto: true } } } } }),
    true
  )
})

test('applyNodeDetailOperation throws a 404 status error when the site context is missing', async () => {
  await assert.rejects(
    applyNodeDetailOperation(null, 'x', {}),
    function (err) { return err.status === 404 && err.message === 'Unable to resolve site context' }
  )
  await assert.rejects(
    applyNodeDetailOperation({ manifest: { items: 'not-an-array' } }, 'x', {}),
    function (err) { return err.status === 404 }
  )
})

test('applyNodeDetailOperation throws a 400 status error when the node id is blank', async () => {
  const site = mkSite([])
  await assert.rejects(
    applyNodeDetailOperation(site, '', { operation: 'setTitle', title: 'X' }),
    function (err) { return err.status === 400 && err.message === 'Missing node id' }
  )
  await assert.rejects(
    applyNodeDetailOperation(site, '   ', { operation: 'setTitle', title: 'X' }),
    function (err) { return err.status === 400 }
  )
})

test('applyNodeDetailOperation throws a 403 featureDisabled error when outline operations are disabled', async () => {
  const site = mkSite([node('n1', 0, '', 0)])
  site.manifest.metadata.platform = { outlineDesigner: false }
  await assert.rejects(
    applyNodeDetailOperation(site, 'n1', { operation: 'setTitle', title: 'X' }),
    function (err) {
      return err.status === 403 && err.featureDisabled === true &&
        err.message === 'Outline operations are disabled for this site'
    }
  )
})

test('applyNodeDetailOperation throws a 404 status error when the node id cannot be loaded', async () => {
  const site = mkSite([node('n1', 0, '', 0)])
  await assert.rejects(
    applyNodeDetailOperation(site, 'missing', { operation: 'setTitle', title: 'X' }),
    function (err) { return err.status === 404 && err.message === 'Node not found' }
  )
})

test('applyNodeDetailOperation setTitle updates the title, leaves the slug, and persists', async () => {
  const site = mkSite([node('n1', 0, '', 0, { title: 'Old Title', slug: 'old-title' })])
  let savedReorder = 'not called'
  let altUpdated = false
  let committed = null
  site.manifest.save = async function (reorder) { savedReorder = reorder }
  site.updateAlternateFormats = async function () { altUpdated = true }
  site.gitCommit = async function (msg) { committed = msg }

  const result = await applyNodeDetailOperation(site, 'n1', { operation: 'setTitle', title: 'New Title' })

  assert.strictEqual(result.operation, 'setTitle')
  assert.strictEqual(result.item.title, 'New Title')
  assert.strictEqual(result.item.slug, 'old-title')
  assert.strictEqual(savedReorder, false)
  assert.strictEqual(altUpdated, true)
  assert.strictEqual(committed, 'Node operation: setTitle on New Title (n1)')
  assert.ok(site.manifest.metadata.site.updated > 0)
})

test('applyNodeDetailOperation setDescription strips HTML tags and clears the description for an empty string', async () => {
  const site1 = mkSite([node('n1', 0, '', 0, { description: 'old' })])
  const r1 = await applyNodeDetailOperation(site1, 'n1', { operation: 'setDescription', description: 'A <b>great</b> page' })
  assert.strictEqual(r1.item.description, 'A great page')

  const site2 = mkSite([node('n1', 0, '', 0, { description: 'old' })])
  const r2 = await applyNodeDetailOperation(site2, 'n1', { operation: 'setDescription', description: '' })
  assert.strictEqual(r2.item.description, '')
})

test('applyNodeDetailOperation setPublished toggles the boolean and is a no-op when the key is absent', async () => {
  const site1 = mkSite([node('n1', 0, '', 0)])
  const r1 = await applyNodeDetailOperation(site1, 'n1', { operation: 'setPublished', published: true })
  assert.strictEqual(r1.item.metadata.published, true)

  const site2 = mkSite([node('n1', 0, '', 0, { metadata: { published: true } })])
  const r2 = await applyNodeDetailOperation(site2, 'n1', { operation: 'setPublished', published: false })
  assert.strictEqual(r2.item.metadata.published, false)

  const site3 = mkSite([node('n1', 0, '', 0, { metadata: { published: true } })])
  const r3 = await applyNodeDetailOperation(site3, 'n1', { operation: 'setPublished' })
  assert.strictEqual(r3.item.metadata.published, true)
})

test('applyNodeDetailOperation setLocked and setHideInMenu store booleans on metadata', async () => {
  const site1 = mkSite([node('n1', 0, '', 0)])
  const r1 = await applyNodeDetailOperation(site1, 'n1', { operation: 'setLocked', locked: true })
  assert.strictEqual(r1.item.metadata.locked, true)

  const site2 = mkSite([node('n1', 0, '', 0)])
  const r2 = await applyNodeDetailOperation(site2, 'n1', { operation: 'setHideInMenu', hideInMenu: true })
  assert.strictEqual(r2.item.metadata.hideInMenu, true)
})

test('applyNodeDetailOperation setTags stores a sanitized string and deletes the key for null', async () => {
  const site1 = mkSite([node('n1', 0, '', 0)])
  const r1 = await applyNodeDetailOperation(site1, 'n1', { operation: 'setTags', tags: ['alpha', 'beta'] })
  // sanitizeMetadataValue stringifies the array, so tags is stored as 'alpha,beta'
  assert.strictEqual(r1.item.metadata.tags, 'alpha,beta')

  const site2 = mkSite([node('n1', 0, '', 0, { metadata: { tags: 'x' } })])
  const r2 = await applyNodeDetailOperation(site2, 'n1', { operation: 'setTags', tags: null })
  assert.strictEqual(r2.item.metadata.hasOwnProperty('tags'), false)
})

test('applyNodeDetailOperation setIcon stores a sanitized icon string on metadata', async () => {
  const site = mkSite([node('n1', 0, '', 0)])
  const r = await applyNodeDetailOperation(site, 'n1', { operation: 'setIcon', icon: 'icons:star' })
  assert.strictEqual(r.item.metadata.icon, 'icons:star')
})

test('applyNodeDetailOperation setMedia stores a sanitized image URL on metadata.image', async () => {
  const site = mkSite([node('n1', 0, '', 0)])
  const r = await applyNodeDetailOperation(site, 'n1', { operation: 'setMedia', media: 'https://example.com/y.jpg' })
  assert.strictEqual(r.item.metadata.image, 'https://example.com/y.jpg')
})

test('applyNodeDetailOperation setRelatedItems stores a sanitized string on metadata', async () => {
  const site = mkSite([node('n1', 0, '', 0)])
  const r = await applyNodeDetailOperation(site, 'n1', { operation: 'setRelatedItems', relatedItems: ['r1', 'r2'] })
  assert.strictEqual(r.item.metadata.relatedItems, 'r1,r2')
})

test('applyNodeDetailOperation moveUp swaps the order of adjacent same-parent siblings', async () => {
  const site = mkSite([node('n1', 1, '', 0), node('n2', 0, '', 0)])
  await applyNodeDetailOperation(site, 'n1', { operation: 'moveUp' })
  assert.strictEqual(site.manifest.items.find(function (i) { return i.id === 'n1' }).order, 0)
  assert.strictEqual(site.manifest.items.find(function (i) { return i.id === 'n2' }).order, 1)
})

test('applyNodeDetailOperation moveUp is a no-op when the node is already at order 0', async () => {
  const site = mkSite([node('n1', 0, '', 0), node('n2', 1, '', 0)])
  await applyNodeDetailOperation(site, 'n1', { operation: 'moveUp' })
  assert.strictEqual(site.manifest.items.find(function (i) { return i.id === 'n1' }).order, 0)
  assert.strictEqual(site.manifest.items.find(function (i) { return i.id === 'n2' }).order, 1)
})

test('applyNodeDetailOperation moveDown swaps the order with the next same-parent sibling', async () => {
  const site = mkSite([node('n1', 0, '', 0), node('n2', 1, '', 0)])
  await applyNodeDetailOperation(site, 'n1', { operation: 'moveDown' })
  assert.strictEqual(site.manifest.items.find(function (i) { return i.id === 'n1' }).order, 1)
  assert.strictEqual(site.manifest.items.find(function (i) { return i.id === 'n2' }).order, 0)
})

test('applyNodeDetailOperation echoes an unknown operation without mutating the page', async () => {
  const site = mkSite([node('n1', 0, '', 0, { title: 'Keep Me' })])
  const result = await applyNodeDetailOperation(site, 'n1', { operation: 'bogusOp' })
  assert.strictEqual(result.operation, 'bogusOp')
  assert.strictEqual(result.item.title, 'Keep Me')
})

