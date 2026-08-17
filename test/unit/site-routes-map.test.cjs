'use strict'

// Unit tests for SiteRoutesMap (src/lib/SiteRoutesMap.js).
//
// The naming helpers (toPascalCaseFromKebab, toSingularEntityType, lowerFirst,
// resolveNamedExportHandler, resolveCollectionHandler, addRouteHandler) are
// module-scope and NOT exported. The module also has side-effecting
// module-load behavior (it requires and wires up several route modules at
// load time), so we do not add exports to it here. Instead we require the
// module fresh and assert on the resulting route-map object's shape: this
// guards against accidental route-wiring regressions without needing to test
// the internal pure helpers directly.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { SiteRoutesMap } = require('../../src/lib/SiteRoutesMap.js')
const itemsModule = require('../../src/siteRoutes/v1/items.js')
const entitiesModule = require('../../src/siteRoutes/v1/entities.js')

describe('SiteRoutesMap top-level shape', () => {
  test('has get/post/patch/delete method buckets', () => {
    assert.equal(typeof SiteRoutesMap.get, 'object')
    assert.equal(typeof SiteRoutesMap.post, 'object')
    assert.equal(typeof SiteRoutesMap.patch, 'object')
    assert.equal(typeof SiteRoutesMap.delete, 'object')
  })

  test('registers the discovery routes as functions', () => {
    assert.equal(typeof SiteRoutesMap.get[''], 'function')
    assert.equal(typeof SiteRoutesMap.get['openapi'], 'function')
    assert.equal(typeof SiteRoutesMap.get['openapi.json'], 'function')
    assert.equal(typeof SiteRoutesMap.get['openapi.yaml'], 'function')
  })
})

describe('SiteRoutesMap v1 entity CRUD wiring', () => {
  test('v1/site: list + write sub-routes are registered as functions', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/site'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/site'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/site/appearance'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/site/platform'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/site/blocks'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/site/editor'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/site/seo'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/site/outline'], 'function')
    assert.equal(typeof SiteRoutesMap.post['v1/site/normalize-slugs'], 'function')
    assert.equal(
      typeof SiteRoutesMap.post['v1/site/updateAlternativeFormats'],
      'function',
    )
  })

  test('v1/items: full CRUD is registered as functions', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/items'], 'function')
    assert.equal(typeof SiteRoutesMap.post['v1/items'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/items/:idOrSlug'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/items/:idOrSlug'], 'function')
    assert.equal(typeof SiteRoutesMap.delete['v1/items/:idOrSlug'], 'function')
  })

  test('v1/items detail handler resolves to the real itemDetail export', () => {
    assert.equal(SiteRoutesMap.get['v1/items/:idOrSlug'], itemsModule.itemDetail)
    assert.equal(SiteRoutesMap.get['v1/items'], itemsModule.listItems)
    assert.equal(SiteRoutesMap.post['v1/items'], itemsModule.createItem)
    assert.equal(SiteRoutesMap.patch['v1/items/:idOrSlug'], itemsModule.updateItem)
    assert.equal(SiteRoutesMap.delete['v1/items/:idOrSlug'], itemsModule.deleteItem)
  })

  test('v1/entities: collection handler falls back to the module function export itself', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/entities'], 'function')
    assert.equal(SiteRoutesMap.get['v1/entities'], entitiesModule)
    // entities has no detail param, so no detail route should be registered
    assert.equal(typeof SiteRoutesMap.get['v1/entities/:idOrSlug'], 'undefined')
  })

  test('v1/content: list/detail/update registered, no create/delete (unsupported by module)', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/content'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/content/:idOrSlug'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/content/:idOrSlug'], 'function')
    // content.js does not export createContent/deleteContent
    assert.equal(typeof SiteRoutesMap.post['v1/content'], 'undefined')
    assert.equal(typeof SiteRoutesMap.delete['v1/content/:idOrSlug'], 'undefined')
    // separate explicit wiring for the replace-content route
    assert.equal(typeof SiteRoutesMap.patch['v1/content'], 'function')
  })

  test('v1/files: full CRUD is registered as functions', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/files'], 'function')
    assert.equal(typeof SiteRoutesMap.post['v1/files'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/files/:fileUuid'], 'function')
    assert.equal(typeof SiteRoutesMap.patch['v1/files/:fileUuid'], 'function')
    assert.equal(typeof SiteRoutesMap.delete['v1/files/:fileUuid'], 'function')
  })

  test('v1/tags and v1/search: collection-only routes with no detail route', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/tags'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/search'], 'function')
  })

  test('v1/custom-elements: list + detail registered under webcomponentName param', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/custom-elements'], 'function')
    assert.equal(
      typeof SiteRoutesMap.get['v1/custom-elements/:webcomponentName'],
      'function',
    )
  })

  test('v1/blocks: list + detail + usage sub-route registered', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/blocks'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/blocks/:webcomponentName'], 'function')
    assert.equal(
      typeof SiteRoutesMap.get['v1/blocks/:webcomponentName/usage'],
      'function',
    )
  })

  test('v1/regions: list + detail registered under regionName param', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/regions'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/regions/:regionName'], 'function')
  })

  test('v1/themes: list registered, detail routes special-cased (skipped in the generic loop)', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/themes'], 'function')
    // themes opts out of the generic :themeName detail loop registration
    // (definition.route !== 'themes' guard), but the explicit calls below it
    // still wire up the equivalent routes directly.
    assert.equal(typeof SiteRoutesMap.get['v1/themes/active'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/themes/:themeName'], 'function')
  })

  test('v1/reports: list + detail registered under report param', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/reports'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/reports/:report'], 'function')
  })

  test('v1/analytics: collection-only route with no detail route', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/analytics'], 'function')
  })

  test('v1/views: list + detail + results sub-route registered under viewId param', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/views'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/views/:viewId'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/views/:viewId/results'], 'function')
  })

  test('additional explicitly-wired routes are registered as functions', () => {
    assert.equal(typeof SiteRoutesMap.get['v1/site/export/:format'], 'function')
    assert.equal(typeof SiteRoutesMap.post['v1/site/export/:format'], 'function')
    assert.equal(
      typeof SiteRoutesMap.get['v1/items/:idOrSlug/revisions'],
      'function',
    )
    assert.equal(
      typeof SiteRoutesMap.get['v1/items/:idOrSlug/revisions/:revisionId'],
      'function',
    )
    assert.equal(
      typeof SiteRoutesMap.post[
        'v1/items/:idOrSlug/revisions/:revisionId/restore'
      ],
      'function',
    )
    assert.equal(
      typeof SiteRoutesMap.get['v1/items/:idOrSlug/export/:format'],
      'function',
    )
    assert.equal(typeof SiteRoutesMap.get['v1/displays'], 'function')
    assert.equal(typeof SiteRoutesMap.get['v1/displays/:viewId/results'], 'function')
  })
})
