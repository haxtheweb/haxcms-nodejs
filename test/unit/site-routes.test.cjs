'use strict'

// Direct handler tests for src/siteRoutes/v1/site.js:
//   listSite (siteSummary), updateSite/appearance/platform/blocks/editor/
//   seo/outline (delegateToLegacySiteWrite wrappers),
//   updateSiteAlternativeFormats, normalizeSiteSlugs
//
// Site resolution goes through site.js's own local resolveSiteForRequest:
// requests carry an originalUrl of /_sites/<name>/x/api/... so resolution
// hits HAXCMS.loadSite (mocked per test, save-settings-routes.test.cjs
// pattern); requests without a _sites path fall back to
// systemStructureContext(), which is null from the repo cwd. The legacy
// write handlers run for real behind the delegates using the shared fake
// site fixture (manifest save/gitCommit/rebuild/updateAlternateFormats
// spies) from save-settings-routes.test.cjs.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const {
  listSite,
  updateSite,
  updateSiteAppearance,
  updateSitePlatform,
  updateSiteBlocks,
  updateSiteEditor,
  updateSiteSeo,
  updateSiteOutline,
  updateSiteAlternativeFormats,
  normalizeSiteSlugs,
} = require('../../src/siteRoutes/v1/site.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.sent = obj
      return this
    },
  }
}

// request rooted at the multisite path so site.js's local
// resolveSiteForRequest resolves through HAXCMS.loadSite
function makeReq(overrides) {
  const req = {
    headers: { 'x-haxcms-site-token': 'token' },
    query: {},
    params: {},
    body: {},
    originalUrl: '/_sites/demo/x/api/v1/site',
  }
  return Object.assign(req, overrides || {})
}

function makeFakeSite(overrides) {
  const calls = {
    gitCommits: [],
    rebuildManagedFiles: 0,
    updateAlternateFormats: [],
    updateNode: 0,
    writePageAlternateFormats: 0,
  }
  const site = {
    siteDirectory: null,
    calls: calls,
    manifest: {
      title: 'Old title',
      description: 'Old description',
      license: 'old-license',
      items: [{ id: 'item-1', title: 'Page One', slug: 'page-one' }],
      metadata: {
        site: { name: 'demo', settings: {} },
        theme: {},
      },
      saveCalls: [],
      async save(reorganize) {
        this.saveCalls.push(typeof reorganize === 'boolean' ? reorganize : true)
      },
    },
    loadNode(id) {
      for (let i = 0; i < this.manifest.items.length; i++) {
        if (this.manifest.items[i] && this.manifest.items[i].id === id) {
          return this.manifest.items[i]
        }
      }
      return null
    },
    async gitCommit(message) {
      calls.gitCommits.push(message)
    },
    async rebuildManagedFiles() {
      calls.rebuildManagedFiles++
    },
    updateAlternateFormats(format) {
      calls.updateAlternateFormats.push(format)
    },
    async updateNode() {
      calls.updateNode++
    },
    async writePageAlternateFormats() {
      calls.writePageAlternateFormats++
    },
  }
  return Object.assign(site, overrides || {})
}

// site-scoped auth: token header validates against user:demo
function mockSiteAuth(t, site) {
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// ---------------------------------------------------------------------------
// listSite (siteSummary)
// ---------------------------------------------------------------------------
describe('site routes — listSite', () => {
  function makeSummarySite(t, overrides) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-routes-'))
    t.after(() => fs.removeSync(tmpRoot))
    const siteDirectory = path.join(tmpRoot, 'demo')
    // files tree: a.txt + nested/b.png count; .gitkeep + symlink skipped
    fs.ensureDirSync(path.join(siteDirectory, 'files', 'nested'))
    fs.writeFileSync(path.join(siteDirectory, 'files', 'a.txt'), 'a')
    fs.writeFileSync(path.join(siteDirectory, 'files', 'nested', 'b.png'), 'b')
    fs.writeFileSync(path.join(siteDirectory, 'files', '.gitkeep'), '')
    fs.symlinkSync(
      path.join(siteDirectory, 'files', 'a.txt'),
      path.join(siteDirectory, 'files', 'z-link.txt'),
    )
    const site = {
      siteDirectory: siteDirectory,
      name: 'demo',
      manifest: {
        id: 'site-uuid-1',
        title: 'Demo Site',
        description: 'A demo site',
        items: [
          {
            id: 'item-1',
            title: 'First',
            slug: 'first',
            metadata: { published: true, tags: ['alpha', 'beta'], region: 'main' },
          },
          {
            id: 'item-2',
            title: 'Second',
            slug: 'second',
            parent: 'item-1',
            metadata: { published: false, tags: 'alpha, gamma' },
          },
          {
            id: 'item-3',
            title: 'Third',
            slug: 'third',
            metadata: {},
          },
        ],
        metadata: {
          site: {
            name: 'demo',
            updated: 1700000000,
            settings: { lang: 'es' },
          },
          theme: { element: 'my-theme' },
        },
      },
    }
    return Object.assign(site, overrides || {})
  }

  test('answers the full site summary with counts, links, and jsonld', async (t) => {
    const site = makeSummarySite(t)
    mockSiteAuth(t, site)
    const res = stubRes()
    await listSite(makeReq(), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.id, 'site-uuid-1')
    assert.equal(res.body.data.name, 'demo')
    assert.equal(res.body.data.title, 'Demo Site')
    assert.equal(res.body.data.description, 'A demo site')
    assert.equal(res.body.data.language, 'es')
    assert.equal(res.body.data.theme, 'my-theme')
    assert.equal(res.body.data.basePath, '/demo/')
    assert.equal(res.body.data.updated, '2023-11-14T22:13:20.000Z')
    assert.deepEqual(res.body.data.counts, {
      items: 3,
      publishedItems: 2,
      tags: 3,
      regions: 1,
      files: 2,
    })
    const links = res.body.data.links
    assert.equal(links.self, '/_sites/demo/x/api/v1/site')
    assert.equal(links.items, '/_sites/demo/x/api/v1/items')
    assert.equal(links.siteJson, '/demo/site.json')
    assert.equal(links.rss, '/demo/rss.xml')
    assert.equal(links.exports.pdf, '/_sites/demo/x/api/v1/site/export/pdf')
    const jsonld = res.body.data.jsonld
    assert.equal(jsonld['@type'], 'Dataset')
    assert.equal(jsonld.name, 'Demo Site API summary')
    assert.equal(jsonld.inLanguage, 'es')
    assert.equal(jsonld.distribution.length, 3)
    assert.equal(jsonld.variableMeasured[0].name, 'items')
    assert.equal(jsonld.variableMeasured[0].value, 3)
  })

  test('falls back to site.name, site.language, and empty counts', async (t) => {
    const site = makeSummarySite(t, {
      name: 'fallback-name',
      language: 'da',
      manifest: {
        title: undefined,
        description: undefined,
        items: { a: { id: 'item-1', title: 'One', slug: 'one', metadata: {} } },
        metadata: { site: {} },
      },
    })
    mockSiteAuth(t, site)
    const res = stubRes()
    await listSite(makeReq(), res)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.name, 'fallback-name')
    assert.equal(res.body.data.title, '')
    assert.equal(res.body.data.language, 'da')
    assert.equal(res.body.data.updated, null)
    // object-shaped items array is normalized to a single item
    assert.equal(res.body.data.counts.items, 1)
    assert.equal(res.body.data.counts.publishedItems, 1)
    assert.equal(res.body.data.counts.files, 2)
  })

  test('an unresolvable site answers 404', async (t) => {
    // no _sites path in the URL -> systemStructureContext() -> null
    const res = stubRes()
    await listSite(makeReq({ originalUrl: '/x/api/v1/site' }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/site',
    )
  })
})

// ---------------------------------------------------------------------------
// delegateToLegacySiteWrite wrappers
// ---------------------------------------------------------------------------
describe('site routes — legacy write delegates', () => {
  const wrappers = [
    { fn: updateSite, label: '/x/api/v1/site' },
    { fn: updateSiteAppearance, label: '/x/api/v1/site/appearance' },
    { fn: updateSitePlatform, label: '/x/api/v1/site/platform' },
    { fn: updateSiteBlocks, label: '/x/api/v1/site/blocks' },
    { fn: updateSiteEditor, label: '/x/api/v1/site/editor' },
    { fn: updateSiteSeo, label: '/x/api/v1/site/seo' },
    { fn: updateSiteOutline, label: '/x/api/v1/site/outline' },
  ]

  test('every wrapper answers 404 without a resolvable site', async (t) => {
    for (let i = 0; i < wrappers.length; i++) {
      const res = stubRes()
      await wrappers[i].fn(
        makeReq({ originalUrl: '/x/api/v1/site', body: { site: { name: 'demo' } } }),
        res,
        () => {},
      )
      assert.equal(res.statusCode, 404, wrappers[i].label)
      assert.equal(
        res.body.data.message,
        'Unable to resolve site context for ' + wrappers[i].label,
        wrappers[i].label,
      )
    }
  })

  test('every wrapper requires the site token header', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    for (let i = 0; i < wrappers.length; i++) {
      const res = stubRes()
      await wrappers[i].fn(
        makeReq({ headers: {}, body: { site: { name: 'demo' }, items: [] } }),
        res,
        () => {},
      )
      assert.equal(res.statusCode, 403, wrappers[i].label)
      assert.equal(
        res.body.data.message,
        'X-HAXCMS-Site-Token header is required for this endpoint',
        wrappers[i].label,
      )
    }
  })

  test('a site without a name answers 400', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site = {}
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSite(makeReq({ body: { site: {} } }), res, () => {})
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site name for /x/api/v1/site',
    )
  })

  test('the delegate injects the resolved site name into the body', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    let seenBody = null
    // outline validation reads body.items, so the injected body flows through
    const res = stubRes()
    await updateSiteOutline(makeReq({ body: {} }), res, () => {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Outline payload requires an items array')
    assert.ok(seenBody === null)
  })

  test('updateSite delegates to saveManifest and saves the title', async (t) => {
    const site = makeFakeSite()
    site.siteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-delegate-'))
    t.after(() => fs.removeSync(site.siteDirectory))
    t.mock.method(HAXCMS, 'getHAXCMSVersion', async () => 'v1.2.3')
    t.mock.method(HAXCMS, 'getThemes', () => ({
      'my-theme': { element: 'my-theme', name: 'My Theme' },
    }))
    mockSiteAuth(t, site)
    const res = stubRes()
    // scoped details payload shape (no form token needed), as proven by
    // save-settings-routes.test.cjs
    await updateSite(
      makeReq({
        body: {
          site: { name: 'demo' },
          homePageId: 'item-999',
          manifest: {
            site: { 'manifest-title': 'Scoped Title' },
            seo: { 'manifest-metadata-site-settings-sw': true },
          },
        },
      }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(site.manifest.title, 'Scoped Title')
    assert.equal(site.manifest.metadata.site.settings.sw, true)
    assert.deepEqual(site.manifest.saveCalls, [false])
  })

  test('updateSiteAppearance delegates to saveAppearanceSettings', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteAppearance(
      makeReq({ body: { site: { name: 'demo' }, manifest: { theme: {} } } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.saved, true)
    assert.deepEqual(site.manifest.saveCalls, [false])
    assert.deepEqual(site.calls.gitCommits, [
      'Appearance settings updated',
      'Managed files updated',
    ])
    assert.equal(site.calls.rebuildManagedFiles, 1)
    assert.equal(site.calls.updateAlternateFormats.length, 1)
  })

  test('updateSitePlatform delegates to savePlatformSettings', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSitePlatform(
      makeReq({ body: { site: { name: 'demo' }, platform: { features: { addPage: true } } } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.deepEqual(site.manifest.metadata.platform.features, { addPage: true })
    assert.deepEqual(site.calls.gitCommits, ['Platform settings updated'])
  })

  test('updateSiteBlocks delegates to saveAllowedBlocks', async (t) => {
    const site = makeFakeSite()
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({
      'my-widget': { module: 'my-widget.js' },
    }))
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteBlocks(
      makeReq({ body: { site: { name: 'demo' }, platform: { allowedBlocks: ['my-widget', 'p'] } } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.deepEqual(site.manifest.metadata.platform.allowedBlocks, ['my-widget', 'p'])
  })

  test('updateSiteEditor delegates to saveEditorSettings', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteEditor(
      makeReq({ body: { site: { name: 'demo' }, platform: { audience: 'novice' } } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.metadata.platform.audience, 'novice')
    assert.deepEqual(site.calls.gitCommits, ['Editor settings updated'])
  })

  test('updateSiteSeo delegates to saveSeoSettings', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteSeo(
      makeReq({ body: { site: { name: 'demo' }, seo: { lang: 'en-US' } } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(site.manifest.metadata.site.settings.lang, 'en-US')
    assert.deepEqual(site.manifest.saveCalls, [false])
  })

  test('updateSiteOutline delegates to saveOutline', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteOutline(
      makeReq({ body: { site: { name: 'demo' }, items: [] } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.deepEqual(res.body.data.items, site.manifest.items)
    // idMap is a null-prototype object, so compare its keys
    assert.deepEqual(Object.keys(res.body.data.idMap), [])
    assert.deepEqual(site.calls.gitCommits, [
      'Managed files updated',
      'Outline updated in bulk',
    ])
  })
})

// ---------------------------------------------------------------------------
// updateSiteAlternativeFormats
// ---------------------------------------------------------------------------
describe('site routes — updateSiteAlternativeFormats', () => {
  test('answers 404 without a resolvable site', async (t) => {
    const res = stubRes()
    await updateSiteAlternativeFormats(makeReq({ originalUrl: '/x/api/v1/site' }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/site/updateAlternativeFormats',
    )
  })

  test('a site without a name answers 400', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site = {}
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteAlternativeFormats(makeReq(), res)
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site name for /x/api/v1/site/updateAlternativeFormats',
    )
  })

  test('a missing or invalid token answers 403', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteAlternativeFormats(makeReq({ headers: {} }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(
      res.body.data.message,
      'X-HAXCMS-Site-Token header is required for this endpoint',
    )
    t.mock.method(HAXCMS, 'validateRequestToken', () => false)
    const res2 = stubRes()
    await updateSiteAlternativeFormats(makeReq(), res2)
    assert.equal(res2.statusCode, 403)
  })

  test('an unknown format answers 400', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteAlternativeFormats(makeReq({ body: { format: 'bogus' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Invalid format requested for alternative formats update',
    )
    assert.deepEqual(site.calls.updateAlternateFormats, [])
  })

  test('a named format updates only that format', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteAlternativeFormats(makeReq({ body: { format: 'rss' } }), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.updated, true)
    assert.equal(res.body.data.site.name, 'demo')
    assert.equal(res.body.data.format, 'rss')
    assert.deepEqual(site.calls.updateAlternateFormats, ['rss'])
  })

  test('an absent or empty format updates every format', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteAlternativeFormats(makeReq(), res)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.format, null)
    assert.deepEqual(site.calls.updateAlternateFormats, [null])
    const res2 = stubRes()
    await updateSiteAlternativeFormats(makeReq({ body: { format: '  ' } }), res2)
    assert.equal(res2.body.status, 200)
    assert.equal(res2.body.data.format, null)
    assert.deepEqual(site.calls.updateAlternateFormats, [null, null])
  })

  test('an update failure answers 500', async (t) => {
    const site = makeFakeSite()
    site.updateAlternateFormats = () => {
      throw new Error('rss writer exploded')
    }
    mockSiteAuth(t, site)
    const res = stubRes()
    await updateSiteAlternativeFormats(makeReq({ body: { format: 'rss' } }), res)
    assert.equal(res.statusCode, 500)
    assert.equal(
      res.body.data.message,
      'Unable to update alternative formats for this site',
    )
  })
})

// ---------------------------------------------------------------------------
// normalizeSiteSlugs
// ---------------------------------------------------------------------------
describe('site routes — normalizeSiteSlugs', () => {
  function makeSlugSite(t, items, settings) {
    const site = makeFakeSite()
    site.manifest.items = items
    site.manifest.metadata.site.settings = settings || {}
    site.getUniqueSlugName = (cleanTitle) => cleanTitle
    return site
  }

  test('answers 404 without a resolvable site', async (t) => {
    const res = stubRes()
    await normalizeSiteSlugs(makeReq({ originalUrl: '/x/api/v1/site' }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/site/normalize-slugs',
    )
  })

  test('a site without a name or token answers 400/403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site = {}
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq(), res)
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site name for /x/api/v1/site/normalize-slugs',
    )
    const site2 = makeFakeSite()
    mockSiteAuth(t, site2)
    const res2 = stubRes()
    await normalizeSiteSlugs(makeReq({ headers: {} }), res2)
    assert.equal(res2.statusCode, 403)
  })

  test('outline operations disabled for the site answer 403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { outlineDesigner: false } }
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq(), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Outline operations are disabled for this site')
  })

  test('a preview reports changes without touching the manifest', async (t) => {
    const site = makeSlugSite(t, [
      { id: 'item-1', title: 'My Page!', slug: 'old-slug', parent: null, metadata: {} },
    ])
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq({ body: { preview: true } }), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.changed, true)
    assert.equal(res.body.data.preview, true)
    assert.equal(res.body.data.changes.length, 1)
    assert.equal(res.body.data.changes[0].id, 'item-1')
    assert.equal(res.body.data.changes[0].oldSlug, 'old-slug')
    assert.equal(res.body.data.changes[0].newSlug, HAXCMS.cleanTitle('My Page!'))
    // preview restores the original items and never saves or commits
    assert.equal(site.manifest.items[0].slug, 'old-slug')
    assert.deepEqual(site.manifest.saveCalls, [])
    assert.deepEqual(site.calls.gitCommits, [])
  })

  test('query preview flags are honored alongside body flags', async (t) => {
    const site = makeSlugSite(t, [
      { id: 'item-1', title: 'Stable Title', slug: 'stable-title', parent: null, metadata: {} },
    ])
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq({ query: { preview: 'true' } }), res)
    assert.equal(res.body.data.preview, true)
    // a body preview of 1 is also accepted
    const res2 = stubRes()
    await normalizeSiteSlugs(makeReq({ body: { preview: 1 } }), res2)
    assert.equal(res2.body.data.preview, true)
    assert.deepEqual(site.manifest.saveCalls, [])
  })

  test('a non-preview run saves, rebuilds formats, and commits', async (t) => {
    const site = makeSlugSite(t, [
      { id: 'item-1', title: 'My Page!', slug: 'old-slug', parent: null, metadata: {} },
    ])
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq(), res)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.preview, false)
    assert.equal(site.manifest.items[0].slug, HAXCMS.cleanTitle('My Page!'))
    assert.deepEqual(site.manifest.saveCalls, [false])
    assert.deepEqual(site.calls.updateAlternateFormats, [undefined])
    assert.deepEqual(site.calls.gitCommits, ['Bulk slug normalization: 1 changed, 0 skipped'])
    assert.equal(site.manifest.metadata.site.updated, Math.floor(Date.now() / 1000))
  })

  test('pathauto overrides are skipped with a reason', async (t) => {
    const site = makeSlugSite(
      t,
      [
        {
          id: 'item-1',
          title: 'Pinned Page',
          slug: 'pinned-slug',
          parent: null,
          metadata: { overridePathauto: true },
        },
      ],
      { pathauto: true },
    )
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq(), res)
    assert.equal(res.body.data.changed, false)
    assert.deepEqual(res.body.data.changes, [])
    assert.equal(res.body.data.skipped.length, 1)
    assert.equal(res.body.data.skipped[0].id, 'item-1')
    assert.equal(res.body.data.skipped[0].reason, 'overridePathauto')
    assert.equal(site.manifest.items[0].slug, 'pinned-slug')
    assert.deepEqual(site.calls.gitCommits, ['Bulk slug normalization: 0 changed, 1 skipped'])
  })

  test('children wait for their parents and normalize after them', async (t) => {
    const site = makeSlugSite(t, [
      { id: 'item-2', title: 'Child Page', slug: 'child-old', parent: 'item-1', metadata: {} },
      { id: 'item-1', title: 'Parent Page', slug: 'parent-old', parent: null, metadata: {} },
    ])
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq(), res)
    assert.equal(res.body.data.changes.length, 2)
    // the parent normalizes in the first batch, the child in the second
    assert.equal(res.body.data.changes[0].id, 'item-1')
    assert.equal(res.body.data.changes[1].id, 'item-2')
    assert.equal(site.manifest.items[1].slug, HAXCMS.cleanTitle('Parent Page'))
    assert.equal(site.manifest.items[0].slug, HAXCMS.cleanTitle('Child Page'))
  })

  test('items without pathauto still normalize their slugs', async (t) => {
    const site = makeSlugSite(
      t,
      [{ id: 'item-1', title: 'Free Form', slug: 'custom-slug', parent: null, metadata: {} }],
      {},
    )
    mockSiteAuth(t, site)
    const res = stubRes()
    await normalizeSiteSlugs(makeReq(), res)
    assert.equal(res.body.data.changed, true)
    assert.equal(res.body.data.changes[0].oldSlug, 'custom-slug')
    assert.equal(site.manifest.items[0].slug, HAXCMS.cleanTitle('Free Form'))
  })
})
