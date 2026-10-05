'use strict'

// Unit tests for the outline-mutation and pathauto-cascade paths in
// src/lib/nodeDetailOperations.js that node-detail-operations.test.cjs does
// not reach: indent/outdent/setParent, the slug cascade across children, the
// setSlug / setOverridePathauto operations, the delete-branch metadata
// operations, and the page-break platform gate.
//
// The HAXCMS singleton is constructed when nodeDetailOperations.js is first
// required, which reads/writes the on-disk config directory at load time.
// Force config discovery into the system temp directory and select CLI mode
// (same header as node-detail-operations.test.cjs) so the singleton never
// blocks on default credentials and does not mutate the user's home config.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

process.env.VERCEL_ENV = '1'
process.env.haxcms_middleware = 'node-cli'

const test = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const JSONOutlineSchema = require('../../src/lib/JSONOutlineSchema.js')
const { applyNodeDetailOperation } = require('../../src/lib/nodeDetailOperations.js')

// Build a site collaborator with a REAL JSONOutlineSchema manifest so the
// slug cascades exercise the real getUniqueSlugName / getItemById / orderTree
// machinery. save / updateAlternateFormats / gitCommit are async no-ops.
function mkSite(items, overrides) {
  const site = new HAXCMSSite()
  site.manifest = new JSONOutlineSchema()
  site.manifest.items = items.map(function (x) {
    return Object.assign({}, x, { metadata: Object.assign({}, x.metadata) })
  })
  site.manifest.metadata = {
    site: {
      updated: 0,
      settings: Object.assign(
        { pathauto: true },
        overrides && overrides.settings ? overrides.settings : {},
      ),
    },
  }
  site.manifest.save = async function () {}
  site.updateAlternateFormats = async function () {}
  site.gitCommit = async function () {}
  site.getPageContent = async function () {
    if (overrides && overrides.getPageContentThrows) {
      throw new Error('content read failed')
    }
    return overrides && overrides.getPageContent !== undefined
      ? overrides.getPageContent
      : '<p>page body</p>'
  }
  site.loadNode = function (id) {
    return (
      site.manifest.items.find(function (i) { return i.id === id }) || null
    )
  }
  return site
}

function node(id, order, parent, indent, extra) {
  return Object.assign(
    {
      id: id,
      title: 'T ' + id,
      slug: id,
      order: order,
      parent: parent,
      indent: indent,
      metadata: {},
    },
    extra || {},
  )
}

test('indent moves a page under its previous sibling and cascades slugs', async () => {
  const site = mkSite([
    node('a', 0, '', 0),
    node('b', 1, '', 0),
    node('c', 0, 'a', 1),
  ])
  const result = await applyNodeDetailOperation(site, 'b', { operation: 'indent' })
  const b = result.item
  assert.equal(b.parent, 'a')
  assert.equal(b.indent, 1)
  // the page itself already counts as a child of the new parent when the
  // last child order is computed, so the order continues past it
  assert.equal(b.order, 2)
  // pathauto regenerates the slug from the parent chain + title
  assert.equal(b.slug, 'a/t-b')
})

test('indent with no previous sibling keeps the page at the root level', async () => {
  const site = mkSite([node('a', 0, '', 0), node('z', 2, '', 0)])
  const result = await applyNodeDetailOperation(site, 'a', { operation: 'indent' })
  assert.equal(result.item.parent, '')
  // pathauto still regenerates a root page slug from its title
  assert.equal(result.item.slug, 't-a')
})

test('outdent lifts a child back under the grandparent with order shifting', async () => {
  const site = mkSite([
    node('root1', 0, '', 0),
    node('root2', 1, '', 0),
    node('child', 0, 'root1', 1),
  ])
  const result = await applyNodeDetailOperation(site, 'child', { operation: 'outdent' })
  const child = result.item
  assert.equal(child.parent, '')
  assert.equal(child.indent, 0)
  assert.equal(child.order, 1)
  // the root sibling at order >= 1 shifted down to make room
  const root2 = site.manifest.items.find(function (i) { return i.id === 'root2' })
  assert.equal(root2.order, 2)
})

test('setParent re-homes a page under a new parent and regenerates the slug', async () => {
  const site = mkSite([
    node('a', 0, '', 0),
    node('b', 1, '', 0),
    node('c', 0, '', 0),
  ])
  const result = await applyNodeDetailOperation(site, 'c', {
    operation: 'setParent',
    parent: 'a',
    order: 3,
  })
  const c = result.item
  assert.equal(c.parent, 'a')
  assert.equal(c.indent, 1)
  assert.equal(c.order, 3)
  assert.equal(c.slug, 'a/t-c')
})

test('setParent with a blank parent returns the page to the root', async () => {
  const site = mkSite([
    node('a', 0, '', 0),
    node('c', 0, 'a', 1),
  ])
  const result = await applyNodeDetailOperation(site, 'c', {
    operation: 'setParent',
    parent: '',
    order: 0,
  })
  const c = result.item
  assert.equal(c.parent, null)
  assert.equal(c.indent, 0)
  // pathauto regenerates from the title even for a root page
  assert.equal(c.slug, 't-c')
})

test('setTitle cascades regenerated slugs to descendants until an override', async () => {
  const site = mkSite([
    node('a', 0, '', 0),
    node('child', 0, 'a', 1),
    node('grandchild', 0, 'child', 2, {
      metadata: { overridePathauto: true },
    }),
  ])
  const result = await applyNodeDetailOperation(site, 'a', {
    operation: 'setTitle',
    title: 'Renamed Parent',
  })
  const a = result.item
  assert.equal(a.title, 'Renamed Parent')
  assert.equal(a.slug, 'renamed-parent')
  const child = site.manifest.items.find(function (i) { return i.id === 'child' })
  // the cascade regenerates the child slug from the child title
  assert.equal(child.slug, 'renamed-parent/t-child')
  const grandchild = site.manifest.items.find(function (i) { return i.id === 'grandchild' })
  // the overridePathauto child keeps its slug through the cascade
  assert.equal(grandchild.slug, 'grandchild')
})

test('setTitle keeps the slug when pathauto is disabled for the site', async () => {
  const site = mkSite([node('a', 0, '', 0)], {
    settings: { pathauto: false },
  })
  const result = await applyNodeDetailOperation(site, 'a', {
    operation: 'setTitle',
    title: 'New Title',
  })
  assert.equal(result.item.title, 'New Title')
  assert.equal(result.item.slug, 'a')
})

test('setSlug protects the reserved x prefix and marks the override', async () => {
  const site = mkSite([node('a', 0, '', 0)])
  const xSlug = await applyNodeDetailOperation(site, 'a', {
    operation: 'setSlug',
    slug: 'x',
  })
  assert.equal(xSlug.item.slug, 'x-x')
  assert.equal(xSlug.item.metadata.overridePathauto, true)
  const prefixed = await applyNodeDetailOperation(site, 'a', {
    operation: 'setSlug',
    slug: 'x/nested',
  })
  assert.equal(prefixed.item.slug, 'x-x/nested')
  const plain = await applyNodeDetailOperation(site, 'a', {
    operation: 'setSlug',
    slug: 'plain-slug',
  })
  assert.equal(plain.item.slug, 'plain-slug')
})

test('setOverridePathauto stores the boolean on the page metadata', async () => {
  const site = mkSite([node('a', 0, '', 0)])
  const result = await applyNodeDetailOperation(site, 'a', {
    operation: 'setOverridePathauto',
    overridePathauto: true,
  })
  assert.equal(result.item.metadata.overridePathauto, true)
})

test('setMedia and setImage write and clear the metadata image', async () => {
  const viaMedia = mkSite([node('a', 0, '', 0)])
  const mediaResult = await applyNodeDetailOperation(viaMedia, 'a', {
    operation: 'setMedia',
    media: 'https://example.com/pic.png',
  })
  assert.equal(mediaResult.item.metadata.image, 'https://example.com/pic.png')
  const viaImage = mkSite([node('a', 0, '', 0)])
  const imageResult = await applyNodeDetailOperation(viaImage, 'a', {
    operation: 'setImage',
    image: 'https://example.com/other.png',
  })
  assert.equal(imageResult.item.metadata.image, 'https://example.com/other.png')
  const cleared = await applyNodeDetailOperation(viaImage, 'a', {
    operation: 'setMedia',
    media: '',
  })
  assert.equal(cleared.item.metadata.hasOwnProperty('image'), false)
})

test('setIcon and setRelatedItems clear their metadata on empty values', async () => {
  const site = mkSite([
    node('a', 0, '', 0, { metadata: { icon: 'icons:star', relatedItems: 'r1,r2' } }),
  ])
  const iconCleared = await applyNodeDetailOperation(site, 'a', {
    operation: 'setIcon',
    icon: '',
  })
  assert.equal(iconCleared.item.metadata.hasOwnProperty('icon'), false)
  const relatedCleared = await applyNodeDetailOperation(site, 'a', {
    operation: 'setRelatedItems',
    relatedItems: null,
  })
  assert.equal(relatedCleared.item.metadata.hasOwnProperty('relatedItems'), false)
})

test('moveUp and moveDown are no-ops without a matching sibling order', async () => {
  const site = mkSite([
    node('a', 0, '', 0),
    node('b', 2, '', 0),
    node('c', 5, '', 0),
  ])
  // b at order 2 has no sibling at order 1 -> stays
  const up = await applyNodeDetailOperation(site, 'b', { operation: 'moveUp' })
  assert.equal(up.item.order, 2)
  // b at order 2 has no sibling at order 3 -> stays
  const down = await applyNodeDetailOperation(site, 'b', { operation: 'moveDown' })
  assert.equal(down.item.order, 2)
})

test('moveDown swaps with the sibling holding the next order value', async () => {
  const site = mkSite([
    node('a', 0, '', 0),
    node('b', 1, '', 0),
    node('c', 5, '', 0),
  ])
  const result = await applyNodeDetailOperation(site, 'a', { operation: 'moveDown' })
  assert.equal(result.item.order, 1)
  const b = site.manifest.items.find(function (i) { return i.id === 'b' })
  assert.equal(b.order, 0)
  const c = site.manifest.items.find(function (i) { return i.id === 'c' })
  assert.equal(c.order, 5)
})

test('page detail operations are gated on the pageBreak platform feature', async () => {
  const site = mkSite([node('a', 0, '', 0)])
  site.manifest.metadata.platform = { outlineDesigner: true, pageBreak: false }
  await assert.rejects(
    applyNodeDetailOperation(site, 'a', { operation: 'setTitle', title: 'X' }),
    function (err) {
      return (
        err.status === 403 &&
        err.featureDisabled === true &&
        err.message === 'Page details editing is disabled for this site'
      )
    },
  )
})

test('a non-string operation echoes through without mutating the page', async () => {
  const site = mkSite([node('a', 0, '', 0)])
  const result = await applyNodeDetailOperation(site, 'a', { operation: 42 })
  assert.equal(result.operation, null)
  assert.equal(result.item.title, 'T a')
})

test('a page content read failure degrades to an empty scan', async () => {
  const site = mkSite([node('a', 0, '', 0)], { getPageContentThrows: true })
  const result = await applyNodeDetailOperation(site, 'a', {
    operation: 'setDescription',
    description: 'after failure',
  })
  assert.equal(result.item.description, 'after failure')
})

test('a site without getPageContent skips the content scan', async () => {
  const site = mkSite([node('a', 0, '', 0)])
  delete site.getPageContent
  const result = await applyNodeDetailOperation(site, 'a', {
    operation: 'setTags',
    tags: ['x'],
  })
  assert.equal(result.item.metadata.tags, 'x')
})
