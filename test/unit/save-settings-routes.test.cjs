'use strict'

// Parameterized unit-test harness for the nine save/settings route handlers:
//
// site routes (src/siteRoutes/v1/routes/):
//   saveManifest, saveSeoSettings, saveNode, savePlatformSettings,
//   saveAllowedBlocks
// system routes (src/systemRoutes/v1/routes/):
//   saveEnabledBlocks, saveEnabledThemes, saveLocalizationSettings,
//   saveMediaSettings
//
// Each handler is exercised for: valid payload, missing/invalid fields, and a
// simulated filesystem-write failure. HAXCMS auth hooks and site loading are
// mocked per test with t.mock.method (same pattern as
// save-node-page-break.test.cjs). System-route handlers run against a temp
// HAXCMS.configDirectory so their real settings writes hit scratch disk.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const { describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const saveManifest = require('../../src/siteRoutes/v1/routes/saveManifest.js')
const saveSeoSettings = require('../../src/siteRoutes/v1/routes/saveSeoSettings.js')
const saveNode = require('../../src/siteRoutes/v1/routes/saveNode.js')
const savePlatformSettings = require('../../src/siteRoutes/v1/routes/savePlatformSettings.js')
const saveAllowedBlocks = require('../../src/siteRoutes/v1/routes/saveAllowedBlocks.js')
const saveEnabledBlocks = require('../../src/systemRoutes/v1/routes/saveEnabledBlocks.js')
const saveEnabledThemes = require('../../src/systemRoutes/v1/routes/saveEnabledThemes.js')
const saveLocalizationSettings = require('../../src/systemRoutes/v1/routes/saveLocalizationSettings.js')
const saveMediaSettings = require('../../src/systemRoutes/v1/routes/saveMediaSettings.js')
const FileContentScanner = require('../../src/lib/FileContentScanner.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.body = obj
      return this
    },
  }
}

function siteReq(body, headers) {
  return {
    headers: Object.assign(
      { 'x-haxcms-site-token': 'token' },
      headers || {},
    ),
    body: body,
  }
}

function userReq(body, headers) {
  return {
    headers: Object.assign(
      { 'x-haxcms-user-token': 'token' },
      headers || {},
    ),
    body: body,
  }
}

// site-scoped auth: site token header validates against user:siteName
function mockSiteAuth(t, site, siteName) {
  const expected = 'tester:' + (siteName || 'demo')
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === expected)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// site-scoped auth that also accepts the form-1 form token
function mockSiteAuthWithForm(t, site) {
  t.mock.method(
    HAXCMS,
    'validateRequestToken',
    (token, value) => value === 'tester:demo' || value === 'form-1',
  )
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// system-scoped auth: user token header validates against user only
function mockUserAuth(t) {
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester')
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
}

// point HAXCMS.configDirectory at a scratch dir (restored after the test)
function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-settings-route-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

function makeFakeSite(overrides) {
  const calls = {
    gitCommits: [],
    rebuildManagedFiles: 0,
    updateAlternateFormats: 0,
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
    async gitCommit(message) {
      calls.gitCommits.push(message)
    },
    async rebuildManagedFiles() {
      calls.rebuildManagedFiles++
    },
    updateAlternateFormats() {
      calls.updateAlternateFormats++
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

function makeFakePage(overrides) {
  const page = {
    id: 'item-1',
    title: 'Page One',
    slug: 'page-one',
    parent: 'item-0',
    description: '',
    metadata: {},
    writeCalls: [],
    async writeLocation(content, dir) {
      page.writeCalls.push({ content, dir })
      return 12
    },
  }
  return Object.assign(page, overrides || {})
}

// ---------------------------------------------------------------------------
// saveManifest
// ---------------------------------------------------------------------------
describe('saveManifest', () => {
  function mockManifestExtras(t, site) {
    t.mock.method(HAXCMS, 'getHAXCMSVersion', async () => 'v1.2.3')
    t.mock.method(HAXCMS, 'getThemes', async () => ({
      'my-theme': { element: 'my-theme', name: 'My Theme' },
    }))
    site.siteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'savemanifest-'))
    t.after(() => fs.removeSync(site.siteDirectory))
  }

  test('missing site name answers 403 without touching the site', async (t) => {
    mockSiteAuth(t, makeFakeSite())
    const res = stubRes()
    await saveManifest(siteReq({}), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
  })

  test('missing site token answers 403', async (t) => {
    mockSiteAuth(t, makeFakeSite())
    const res = stubRes()
    await saveManifest(
      siteReq({ site: { name: 'demo' } }, { 'x-haxcms-site-token': '' }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
  })

  test('a payload without a valid form token answers 403', async (t) => {
    const site = makeFakeSite()
    mockManifestExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveManifest(
      siteReq({
        site: { name: 'demo' },
        haxcms_form_id: 'form-1',
        haxcms_form_token: 'bad-token',
      }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
    assert.equal(site.calls.gitCommits.length, 0)
  })

  test('manifest editing disabled for the site answers 403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { siteManifest: false } }
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveManifest(siteReq({ site: { name: 'demo' }, title: 'Nope' }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Manifest editing is disabled for this site')
  })

  test('scoped details payload saves title/sw/homePageId without a form token', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.site.homePageId = 'item-999'
    mockManifestExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveManifest(
      siteReq({
        site: { name: 'demo' },
        homePageId: 'item-999',
        manifest: {
          site: { 'manifest-title': 'Scoped Title' },
          seo: { 'manifest-metadata-site-settings-sw': true },
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(site.manifest.title, 'Scoped Title')
    assert.equal(site.manifest.metadata.site.settings.sw, true)
    // invalid homePageId (item-999 is not in the outline) is removed
    assert.equal('homePageId' in site.manifest.metadata.site, false)
    assert.equal(site.manifest.metadata.site.version, 'v1.2.3')
    assert.deepEqual(site.manifest.saveCalls, [false])
    assert.equal(site.calls.gitCommits.length, 2)
    assert.equal(site.calls.rebuildManagedFiles, 1)
    assert.equal(site.calls.updateAlternateFormats, 1)
  })

  test('full form payload writes every manifest section and the CNAME file', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { addPage: false } }
    mockManifestExtras(t, site)
    mockSiteAuthWithForm(t, site)
    const res = stubRes()
    await saveManifest(
      siteReq({
        site: { name: 'demo' },
        haxcms_form_id: 'form-1',
        haxcms_form_token: 'token',
        manifest: {
          site: {
            'manifest-title': 'My <b>Site</b>',
            'manifest-description': 'A description',
            'manifest-metadata-site-domain': 'example.com',
            'manifest-metadata-site-logo': 'files/logo.png',
            'manifest-metadata-site-tags': 'tag1,tag2',
            'manifest-domain': 'cdn.example.com',
            'manifest-metadata-site-homePageId': 'item-1',
          },
          theme: {
            'manifest-metadata-theme-element': 'my-theme',
            'manifest-metadata-theme-variables-image': 'files/hero.png',
            'manifest-metadata-theme-variables-imageAlt': 'Hero',
            'manifest-metadata-theme-variables-imageLink': 'https://example.com',
            'manifest-metadata-theme-variables-cssVariable': 'blue',
            'manifest-metadata-theme-variables-palette': 'my-palette',
            'manifest-metadata-theme-variables-icon': 'icons:account',
            'manifest-metadata-theme-regions-header': ['r-1', 'r-2'],
          },
          author: {
            'manifest-license': 'CC-BY',
            'manifest-metadata-author-image': 'files/author.png',
            'manifest-metadata-author-name': 'Author Name',
            'manifest-metadata-author-email': 'a@example.com',
            'manifest-metadata-author-phone': '555-1234',
            'manifest-metadata-author-location': 'PA',
            'manifest-metadata-author-website': 'https://one.example.com',
            'manifest-metadata-author-website2': 'https://two.example.com',
            'manifest-metadata-author-socialLink': 'https://social.example.com/one',
            'manifest-metadata-author-socialLink2': 'https://social.example.com/two',
          },
          seo: {
            'manifest-metadata-site-settings-private': true,
            'manifest-metadata-site-settings-canonical': false,
            'manifest-metadata-site-settings-lang': 'en-US',
            'manifest-metadata-site-settings-pathauto': true,
            'manifest-metadata-site-settings-publishPagesOn': true,
            'manifest-metadata-site-settings-sw': false,
            'manifest-metadata-site-settings-forceUpgrade': true,
            'manifest-metadata-site-settings-gaID': 'UA-1',
          },
        },
      }),
      res,
    )

    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    const manifest = site.manifest
    // title/description have html stripped
    assert.equal(manifest.title, 'My Site')
    assert.equal(manifest.description, 'A description')
    assert.equal(manifest.metadata.site.domain, 'cdn.example.com')
    assert.equal(manifest.metadata.site.logo, 'files/logo.png')
    assert.equal(manifest.metadata.site.tags, 'tag1,tag2')
    assert.equal(manifest.metadata.site.homePageId, 'item-1')
    assert.equal(manifest.metadata.site.version, 'v1.2.3')
    // CNAME written because the domain changed
    assert.equal(
      fs.readFileSync(path.join(site.siteDirectory, 'CNAME'), 'utf8'),
      'cdn.example.com',
    )
    // theme matched from HAXCMS.getThemes()
    assert.equal(manifest.metadata.theme.element, 'my-theme')
    assert.equal(manifest.metadata.theme.variables.cssVariable, '--simple-colors-default-theme-blue-7')
    assert.equal(manifest.metadata.theme.variables.palette, 'my-palette')
    assert.equal(manifest.metadata.theme.variables.image, 'files/hero.png')
    assert.equal(manifest.metadata.theme.variables.imageAlt, 'Hero')
    assert.equal(manifest.metadata.theme.variables.imageLink, 'https://example.com')
    assert.equal(manifest.metadata.theme.variables.icon, 'icons:account')
    assert.deepEqual(manifest.metadata.theme.regions.header, ['r-1', 'r-2'])
    // author + license
    assert.equal(manifest.license, 'CC-BY')
    assert.equal(manifest.metadata.author.name, 'Author Name')
    assert.equal(manifest.metadata.author.email, 'a@example.com')
    assert.equal(manifest.metadata.author.image, 'files/author.png')
    assert.equal(manifest.metadata.author.phone, '555-1234')
    assert.equal(manifest.metadata.author.location, 'PA')
    assert.equal(manifest.metadata.author.website, 'https://one.example.com')
    assert.equal(manifest.metadata.author.website2, 'https://two.example.com')
    assert.equal(manifest.metadata.author.socialLink, 'https://social.example.com/one')
    assert.equal(manifest.metadata.author.socialLink2, 'https://social.example.com/two')
    // seo settings
    assert.equal(manifest.metadata.site.settings.private, true)
    assert.equal(manifest.metadata.site.settings.canonical, false)
    assert.equal(manifest.metadata.site.settings.lang, 'en-US')
    assert.equal(manifest.metadata.site.settings.pathauto, true)
    assert.equal(manifest.metadata.site.settings.publishPagesOn, true)
    assert.equal(manifest.metadata.site.settings.sw, false)
    assert.equal(manifest.metadata.site.settings.forceUpgrade, true)
    assert.equal(manifest.metadata.site.settings.gaID, 'UA-1')
    // platform settings are preserved, not overwritten by the form
    assert.deepEqual(manifest.metadata.platform, { features: { addPage: false } })
    assert.deepEqual(manifest.saveCalls, [false])
    assert.equal(site.calls.gitCommits.length, 2)
  })

  test('an empty palette value clears a previously stored palette', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.theme = {
      element: 'my-theme',
      variables: { palette: 'old-palette' },
    }
    mockManifestExtras(t, site)
    mockSiteAuthWithForm(t, site)
    const res = stubRes()
    await saveManifest(
      siteReq({
        site: { name: 'demo' },
        haxcms_form_id: 'form-1',
        haxcms_form_token: 'token',
        manifest: {
          site: { 'manifest-title': 'P', 'manifest-description': 'D' },
          theme: { 'manifest-metadata-theme-variables-palette': '' },
          author: {},
          seo: {},
        },
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal('palette' in site.manifest.metadata.theme.variables, false)
  })

  test('a non-matching non-empty palette value is ignored', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.theme = {
      element: 'my-theme',
      variables: { palette: 'old-palette' },
    }
    mockManifestExtras(t, site)
    mockSiteAuthWithForm(t, site)
    const res = stubRes()
    await saveManifest(
      siteReq({
        site: { name: 'demo' },
        haxcms_form_id: 'form-1',
        haxcms_form_token: 'token',
        manifest: {
          site: { 'manifest-title': 'P', 'manifest-description': 'D' },
          theme: { 'manifest-metadata-theme-variables-palette': 'has spaces' },
          author: {},
          seo: {},
        },
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(site.manifest.metadata.theme.variables.palette, 'old-palette')
  })

  test('a manifest.save failure rejects the handler (no catch in route)', async (t) => {
    const site = makeFakeSite()
    mockManifestExtras(t, site)
    mockSiteAuth(t, site)
    site.manifest.save = async () => {
      throw new Error('EACCES: disk on fire')
    }
    const res = stubRes()
    await assert.rejects(
      saveManifest(
        siteReq({
          site: { name: 'demo' },
          title: 'Nope',
          manifest: { site: { 'manifest-title': 'Nope' } },
        }),
        res,
      ),
      /disk on fire/,
    )
  })
})

// ---------------------------------------------------------------------------
// saveSeoSettings
// ---------------------------------------------------------------------------
describe('saveSeoSettings', () => {
  test('missing auth answers 403', async (t) => {
    mockSiteAuth(t, makeFakeSite())
    const res = stubRes()
    await saveSeoSettings(
      siteReq({ site: { name: 'demo' } }, { 'x-haxcms-site-token': '' }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
  })

  test('unresolvable site answers 400 Invalid request', async (t) => {
    mockSiteAuth(t, null, 'ghost')
    const res = stubRes()
    await saveSeoSettings(siteReq({ site: { name: 'ghost' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
  })

  test('seo editing disabled for the site answers 403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { seoManifest: false } }
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveSeoSettings(siteReq({ site: { name: 'demo' }, seo: {} }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'SEO settings are disabled for this site')
  })

  test('a valid author+seo payload writes every field and saves', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveSeoSettings(
      siteReq({
        site: { name: 'demo' },
        author: {
          license: 'CC-BY-SA',
          image: 'files/author.png',
          name: 'Author Name',
          email: 'a@example.com',
          phone: '555-1234',
          location: 'PA',
          website: 'https://one.example.com',
          website2: 'https://two.example.com',
          socialLink: 'https://social.example.com/one',
          socialLink2: 'https://social.example.com/two',
        },
        seo: {
          description: 'Seo description',
          logo: 'files/logo.png',
          domain: 'example.com',
          lang: 'en-US',
          gaID: 'UA-1',
          private: 'true',
          canonical: 'false',
          pathauto: true,
          publishPagesOn: 'no',
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    const manifest = site.manifest
    assert.equal(manifest.license, 'CC-BY-SA')
    assert.equal(manifest.description, 'Seo description')
    assert.equal(manifest.metadata.author.name, 'Author Name')
    assert.equal(manifest.metadata.author.email, 'a@example.com')
    assert.equal(manifest.metadata.author.image, 'files/author.png')
    assert.equal(manifest.metadata.author.phone, '555-1234')
    assert.equal(manifest.metadata.author.location, 'PA')
    assert.equal(manifest.metadata.author.website, 'https://one.example.com')
    assert.equal(manifest.metadata.author.website2, 'https://two.example.com')
    assert.equal(manifest.metadata.author.socialLink, 'https://social.example.com/one')
    assert.equal(manifest.metadata.author.socialLink2, 'https://social.example.com/two')
    assert.equal(manifest.metadata.site.logo, 'files/logo.png')
    assert.equal(manifest.metadata.site.domain, 'example.com')
    assert.equal(manifest.metadata.site.settings.lang, 'en-US')
    assert.equal(manifest.metadata.site.settings.gaID, 'UA-1')
    assert.equal(manifest.metadata.site.settings.private, true)
    assert.equal(manifest.metadata.site.settings.canonical, false)
    assert.equal(manifest.metadata.site.settings.pathauto, true)
    assert.equal(manifest.metadata.site.settings.publishPagesOn, false)
    assert.deepEqual(manifest.saveCalls, [false])
    assert.equal(site.calls.rebuildManagedFiles, 1)
    assert.equal(site.calls.gitCommits.length, 2)
  })

  test('legacy manifest.* keys still write fields', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveSeoSettings(
      siteReq({
        site: { name: 'demo' },
        manifest: {
          author: { 'manifest.license': 'MIT' },
          seo: {
            'manifest.description': 'Legacy description',
            'manifest.metadata.site.logo': 'files/legacy.png',
          },
        },
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(site.manifest.license, 'MIT')
    assert.equal(site.manifest.description, 'Legacy description')
    assert.equal(site.manifest.metadata.site.logo, 'files/legacy.png')
  })

  test('a manifest.save failure rejects the handler (no catch in route)', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    site.manifest.save = async () => {
      throw new Error('EACCES: read-only filesystem')
    }
    const res = stubRes()
    await assert.rejects(
      saveSeoSettings(siteReq({ site: { name: 'demo' }, seo: { lang: 'en' } }), res),
      /read-only filesystem/,
    )
  })
})

// ---------------------------------------------------------------------------
// saveNode
// ---------------------------------------------------------------------------
describe('saveNode', () => {
  function mockNodeExtras(t, site) {
    t.mock.method(FileContentScanner, 'rebuildPageFilesUuids', async () => {})
    t.mock.method(HAXCMS, 'recurseCopy', async () => {})
    site.siteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'savenode-'))
    t.after(() => fs.removeSync(site.siteDirectory))
  }

  test('missing auth answers 403', async (t) => {
    mockSiteAuth(t, makeFakeSite())
    const res = stubRes()
    await saveNode(
      siteReq({ site: { name: 'demo' } }, { 'x-haxcms-site-token': '' }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
  })

  test('style guide id delegates to site.handleStyleGuideSave', async (t) => {
    const site = makeFakeSite()
    let styleGuidePayload = null
    site.handleStyleGuideSave = async (bodyParams) => {
      styleGuidePayload = bodyParams
      return { saved: true }
    }
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    const req = siteReq({
      site: { name: 'demo' },
      node: { id: 'x/theme/style-guide', body: '<p>guide</p>' },
    })
    await saveNode(req, res)
    assert.equal(res.body.saved, true)
    assert.equal(styleGuidePayload, req.body)
  })

  test('unknown node id answers 500 Server error', async (t) => {
    const site = makeFakeSite()
    site.loadNode = () => null
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(
      siteReq({ site: { name: 'demo' }, node: { id: 'ghost', body: '<page-break></page-break><p>x</p>' } }),
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'Server error')
  })

  test('node without a body answers 500 failed to write', async (t) => {
    const site = makeFakeSite()
    site.loadNode = () => makeFakePage()
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(siteReq({ site: { name: 'demo' }, node: { id: 'item-1' } }), res)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'failed to write')
  })

  test('a full page-break save updates page attributes, metadata, and schema media', async (t) => {
    const page = makeFakePage()
    const site = makeFakeSite()
    site.loadNode = (id) => (id === 'item-1' ? page : null)
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(
      siteReq({
        site: { name: 'demo' },
        node: {
          id: 'item-1',
          body:
            '<page-break title="New &amp; Shiny" slug="my-page" parent="" published locked hide-in-menu ' +
            'description="A page" tags="t1" icon="icons:home" accent-color="blue" related-items="r-1" ' +
            'image="files/img.png" link-url="https://x.example.com" link-target="_blank" ' +
            'page-type="two-col" order="2" depth="1" override-pathauto="true"></page-break>' +
            '<p>Hello world</p>',
          schema: [
            { tag: 'img', properties: { src: 'img.png' } },
            { tag: 'media-image', properties: { source: 'hero.png' } },
            { tag: 'video-player', properties: { source: 'video.mp4' } },
          ],
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data, page)
    assert.equal(page.writeCalls.length, 1)
    assert.ok(page.writeCalls[0].content.indexOf('Hello world') !== -1)
    assert.equal(page.title, 'New & Shiny')
    assert.equal(page.slug, 'my-page')
    assert.equal(page.parent, null)
    assert.equal(page.description, 'A page')
    assert.equal(page.indent, 1)
    assert.equal(page.order, 2)
    assert.equal(page.metadata.published, true)
    assert.equal(page.metadata.locked, true)
    assert.equal(page.metadata.hideInMenu, true)
    assert.equal(page.metadata.overridePathauto, true)
    assert.equal(page.metadata.pageType, 'two-col')
    assert.equal(page.metadata.relatedItems, 'r-1')
    assert.equal(page.metadata.image, 'files/img.png')
    assert.equal(page.metadata.tags, 't1')
    assert.equal(page.metadata.accentColor, 'blue')
    assert.equal(page.metadata.icon, 'icons:home')
    assert.equal(page.metadata.linkUrl, 'https://x.example.com')
    assert.equal(page.metadata.linkTarget, '_blank')
    assert.equal(page.metadata.readtime, 1)
    assert.deepEqual(page.metadata.images, ['img.png', 'hero.png'])
    assert.deepEqual(page.metadata.videos, ['video.mp4'])
    assert.equal(site.calls.updateNode, 1)
    assert.equal(site.calls.writePageAlternateFormats, 1)
    assert.deepEqual(site.manifest.saveCalls, [true])
    assert.equal(site.calls.gitCommits.length, 1)
  })

  test('a slug of exactly x is forced to x-x', async (t) => {
    const page = makeFakePage()
    const site = makeFakeSite()
    site.loadNode = () => page
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(
      siteReq({
        site: { name: 'demo' },
        node: { id: 'item-1', body: '<page-break title="A" slug="x"></page-break><p>x</p>' },
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(page.slug, 'x-x')
  })

  test('a slug starting with x/ is forced to x-x/', async (t) => {
    const page = makeFakePage()
    const site = makeFakeSite()
    site.loadNode = () => page
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(
      siteReq({
        site: { name: 'demo' },
        node: { id: 'item-1', body: '<page-break title="B" slug="x/child"></page-break><p>y</p>' },
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(page.slug, 'x-x/child')
  })

  test('writeLocation returning false answers 500 failed to write', async (t) => {
    const site = makeFakeSite()
    site.loadNode = () =>
      makeFakePage({
        writeLocation: async () => false,
      })
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(
      siteReq({
        site: { name: 'demo' },
        node: { id: 'item-1', body: '<page-break title="A"></page-break><p>x</p>' },
      }),
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'failed to write')
  })

  test('an unknown item-id in the page-break creates the page first', async (t) => {
    const created = makeFakePage({
      id: 'item-2',
      title: 'Fresh page',
      slug: 'fresh-page',
      metadata: {},
    })
    const site = makeFakeSite()
    let addedItem = null
    // the request targets an existing page (item-1) but the page-break
    // attributes carry a new item-id (item-2): only the post-create
    // loadNode(item-2) finds the created page
    let createdAdded = false
    site.loadNode = (id) => {
      if (id === 'item-1') {
        return makeFakePage()
      }
      return createdAdded ? created : null
    }
    site.itemFromParams = (nodeParams) => ({
      id: nodeParams.node.id,
      title: nodeParams.node.title,
      location: nodeParams.node.location,
    })
    site.manifest.addItem = (item) => {
      addedItem = item
      createdAdded = true
    }
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(
      siteReq({
        site: { name: 'demo' },
        node: {
          id: 'item-1',
          body: '<page-break title="Fresh page" item-id="item-2" path="fresh"></page-break><p>new</p>',
        },
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data, created)
    assert.equal(addedItem.id, 'item-2')
    assert.deepEqual(site.manifest.saveCalls, [true, true])
    assert.equal(site.calls.gitCommits.length, 2)
  })

  test('adding pages disabled for the site stops the create branch', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { addPage: false } }
    site.loadNode = (id) => (id === 'item-1' ? makeFakePage() : null)
    mockNodeExtras(t, site)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveNode(
      siteReq({
        site: { name: 'demo' },
        node: {
          id: 'item-1',
          body: '<page-break title="New" item-id="item-9"></page-break><p>x</p>',
        },
      }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Adding pages is disabled for this site')
  })
})

// ---------------------------------------------------------------------------
// savePlatformSettings
// ---------------------------------------------------------------------------
describe('savePlatformSettings', () => {
  test('missing auth answers 403', async (t) => {
    mockSiteAuth(t, makeFakeSite())
    const res = stubRes()
    await savePlatformSettings(
      siteReq({ site: { name: 'demo' } }, { 'x-haxcms-site-token': '' }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
  })

  test('platform settings disabled for the site answers 403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { siteManifest: false } }
    mockSiteAuth(t, site)
    const res = stubRes()
    await savePlatformSettings(
      siteReq({ site: { name: 'demo' }, platform: { features: {} } }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Platform settings are disabled for this site')
  })

  test('missing platform object answers 400', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await savePlatformSettings(siteReq({ site: { name: 'demo' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
  })

  test('platform without any feature source answers 400', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await savePlatformSettings(
      siteReq({ site: { name: 'demo' }, platform: { audience: 'expert' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
  })

  test('non-boolean feature value answers 400', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await savePlatformSettings(
      siteReq({ site: { name: 'demo' }, platform: { features: { addPage: 'yes' } } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
    assert.equal(site.manifest.saveCalls.length, 0)
  })

  test('unknown feature key answers 400', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await savePlatformSettings(
      siteReq({ site: { name: 'demo' }, platform: { features: { bogusFeature: true } } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
  })

  test('a valid payload writes only supported feature keys and saves', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await savePlatformSettings(
      siteReq({
        site: { name: 'demo' },
        platform: {
          features: { addPage: true, saveAndEdit: false },
          cmsFeatures: { insights: true },
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.deepEqual(site.manifest.metadata.platform.features, {
      addPage: true,
      saveAndEdit: false,
      insights: true,
    })
    // audience + allowedBlocks managed elsewhere, platform object stays intact
    assert.equal('audience' in site.manifest.metadata.platform, false)
    assert.deepEqual(site.manifest.saveCalls, [false])
    assert.deepEqual(site.calls.gitCommits, ['Platform settings updated'])
  })

  test('legacy feature keys expand to their modern equivalents', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await savePlatformSettings(
      siteReq({
        site: { name: 'demo' },
        platform: {
          features: { manifest: true, onlineSearch: false, delete: false },
        },
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.deepEqual(site.manifest.metadata.platform.features, {
      siteManifest: true,
      themeManifest: true,
      authorManifest: true,
      seoManifest: true,
      onlineMedia: false,
      deletePage: false,
    })
  })

  test('a manifest.save failure rejects the handler (no catch in route)', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    site.manifest.save = async () => {
      throw new Error('EACCES: cannot save')
    }
    const res = stubRes()
    await assert.rejects(
      savePlatformSettings(
        siteReq({ site: { name: 'demo' }, platform: { features: { addPage: true } } }),
        res,
      ),
      /cannot save/,
    )
  })
})

// ---------------------------------------------------------------------------
// saveAllowedBlocks
// ---------------------------------------------------------------------------
describe('saveAllowedBlocks', () => {
  test('missing auth answers 403', async (t) => {
    mockSiteAuth(t, makeFakeSite())
    const res = stubRes()
    await saveAllowedBlocks(
      siteReq({ site: { name: 'demo' } }, { 'x-haxcms-site-token': '' }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
  })

  test('allowed blocks editing disabled for the site answers 403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { siteManifest: false } }
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAllowedBlocks(
      siteReq({ site: { name: 'demo' }, platform: { allowedBlocks: ['p'] } }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Allowed blocks settings are disabled for this site')
  })

  test('missing platform object answers 400', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAllowedBlocks(siteReq({ site: { name: 'demo' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
  })

  test('non-array, non-null allowedBlocks answers 400', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAllowedBlocks(
      siteReq({ site: { name: 'demo' }, platform: { allowedBlocks: 'p,div' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
  })

  test('invalid tag entries answer 400', async (t) => {
    const site = makeFakeSite()
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({}))
    mockSiteAuth(t, site)
    const cases = [[42], [''], ['not-a-wc-tag']]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await saveAllowedBlocks(
        siteReq({ site: { name: 'demo' }, platform: { allowedBlocks: cases[i] } }),
        res,
      )
      assert.equal(res.statusCode, 400, 'case ' + JSON.stringify(cases[i]))
      assert.equal(res.body.data.message, 'Invalid request')
    }
    assert.equal(site.manifest.saveCalls.length, 0)
  })

  test('valid blocks are deduped, sorted, and persisted', async (t) => {
    const site = makeFakeSite()
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({
      'my-widget': { module: 'my-widget.js' },
      'video-player': { module: 'video-player.js' },
    }))
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAllowedBlocks(
      siteReq({
        site: { name: 'demo' },
        platform: { allowedBlocks: ['p', 'p', 'my-widget', 'video-player', 'div'] },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.deepEqual(site.manifest.metadata.platform.allowedBlocks, [
      'div',
      'my-widget',
      'p',
      'video-player',
    ])
    assert.deepEqual(site.manifest.saveCalls, [false])
    assert.deepEqual(site.calls.gitCommits, ['Allowed blocks updated'])
  })

  test('null allowedBlocks clears the restriction', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = {
      audience: 'expert',
      features: {},
      allowedBlocks: ['p'],
    }
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAllowedBlocks(
      siteReq({ site: { name: 'demo' }, platform: { allowedBlocks: null } }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(site.manifest.metadata.platform.allowedBlocks, null)
    assert.equal(site.manifest.metadata.platform.audience, 'expert')
  })

  test('a manifest.save failure rejects the handler (no catch in route)', async (t) => {
    const site = makeFakeSite()
    t.mock.method(HAXCMS, 'getWCRegistryJson', () => ({}))
    mockSiteAuth(t, site)
    site.manifest.save = async () => {
      throw new Error('EACCES: nope')
    }
    const res = stubRes()
    await assert.rejects(
      saveAllowedBlocks(
        siteReq({ site: { name: 'demo' }, platform: { allowedBlocks: ['p'] } }),
        res,
      ),
      /nope/,
    )
  })
})

// ---------------------------------------------------------------------------
// saveEnabledBlocks (system route, config-scoped)
// ---------------------------------------------------------------------------
describe('saveEnabledBlocks', () => {
  test('missing user token answers 403 invalid request token', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledBlocks({ headers: {}, body: { enabledBlocks: ['p'] } }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('an invalid user token answers 403', async (t) => {
    t.mock.method(HAXCMS, 'validateRequestToken', () => false)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    const res = stubRes()
    await saveEnabledBlocks(userReq({ enabledBlocks: ['p'] }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('missing payload answers 400 Missing enabledBlocks payload', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledBlocks({ headers: { 'x-haxcms-user-token': 'token' } }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Missing enabledBlocks payload')
  })

  test('invalid entries answer 400 Invalid enabledBlocks payload', async (t) => {
    mockUserAuth(t)
    const cases = [
      { enabledBlocks: 'p' },
      { enabledBlocks: [42] },
      { enabledBlocks: [''] },
      { enabledBlocks: ['has space'] },
      { enabledBlocks: ['9starts-with-digit'] },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await saveEnabledBlocks(userReq(cases[i]), res)
      assert.equal(res.statusCode, 400, 'case ' + JSON.stringify(cases[i]))
      assert.equal(res.body.data.message, 'Invalid enabledBlocks payload')
    }
  })

  test('a valid payload normalizes and writes settings/enabledBlocks.json', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledBlocks(userReq({ enabledBlocks: ['video-player', 'P', 'p'] }), res)
    assert.equal(res.statusCode, null)
    assert.deepEqual(res.body.data.enabledBlocks, ['p', 'video-player'])
    const filePath = path.join(HAXCMS.configDirectory, 'settings', 'enabledBlocks.json')
    assert.equal(fs.existsSync(filePath), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), ['p', 'video-player'])
  })

  test('a bare array body is accepted as the payload itself', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledBlocks(userReq(['my-widget']), res)
    assert.equal(res.statusCode, null)
    assert.deepEqual(res.body.data.enabledBlocks, ['my-widget'])
  })

  test('a blocked settings path rejects the handler (no catch in route)', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    // a FILE where the settings directory should be breaks fs.ensureDir
    fs.writeFileSync(path.join(tmpDir, 'settings'), 'not a dir')
    mockUserAuth(t)
    const res = stubRes()
    await assert.rejects(
      saveEnabledBlocks(userReq({ enabledBlocks: ['p'] }), res),
    )
  })
})

// ---------------------------------------------------------------------------
// saveEnabledThemes (system route, config-scoped)
// ---------------------------------------------------------------------------
describe('saveEnabledThemes', () => {
  function mockThemes(t) {
    t.mock.method(HAXCMS, 'getThemes', () => ({
      'theme-one': { name: 'Theme One', element: 'theme-one' },
      'theme-two': { name: 'Theme Two', element: 'theme-two' },
    }))
  }

  test('missing user token answers 403 invalid request token', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledThemes({ headers: {}, body: { enabledThemes: ['theme-one'] } }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('missing payload answers 400 Missing enabledThemes payload', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledThemes({ headers: { 'x-haxcms-user-token': 'token' } }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Missing enabledThemes payload')
  })

  test('an unusable payload answers 400 Invalid enabledThemes payload', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledThemes(userReq({ enabledThemes: 'nope' }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid enabledThemes payload')
  })

  test('an array payload persists enabled themes and disables the rest', async (t) => {
    useTempConfigDirectory(t)
    mockThemes(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledThemes(userReq({ enabledThemes: ['Theme One'] }), res)
    assert.equal(res.statusCode, null)
    assert.deepEqual(res.body.data.enabledThemes, ['theme-one'])
    assert.deepEqual(res.body.data.settings, { 'theme-one': true, 'theme-two': false })
    const filePath = path.join(HAXCMS.configDirectory, 'settings', 'enabledThemes.json')
    assert.equal(fs.existsSync(filePath), true)
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    assert.deepEqual(stored.enabledThemes, { 'theme-one': true, 'theme-two': false })
  })

  test('an object-map payload keeps only truthy themes enabled', async (t) => {
    useTempConfigDirectory(t)
    mockThemes(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledThemes(
      userReq({ enabledThemes: { 'Theme One': true, 'Theme Two': false } }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.deepEqual(res.body.data.enabledThemes, ['theme-one'])
  })

  test('hidden and terrible themes are force-enabled regardless of payload', async (t) => {
    useTempConfigDirectory(t)
    t.mock.method(HAXCMS, 'getThemes', () => ({
      'secret-theme': { name: 'Secret', hidden: true },
      'terrible-thing': { name: 'Terrible', terrible: true },
    }))
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledThemes(userReq({ enabledThemes: [] }), res)
    assert.equal(res.body.status, 200)
    assert.deepEqual(res.body.data.enabledThemes, ['secret-theme', 'terrible-thing'])
  })

  test('a blocked settings path answers 500 Unable to save enabled theme settings', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    fs.writeFileSync(path.join(tmpDir, 'settings'), 'not a dir')
    mockThemes(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveEnabledThemes(userReq({ enabledThemes: ['Theme One'] }), res)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'Unable to save enabled theme settings')
  })
})

// ---------------------------------------------------------------------------
// saveLocalizationSettings (system route, config-scoped)
// ---------------------------------------------------------------------------
describe('saveLocalizationSettings', () => {
  test('missing user token answers 403 invalid request token', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveLocalizationSettings({ headers: {}, body: { defaultLanguage: 'en' } }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('missing payload answers 400 Missing localization settings payload', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveLocalizationSettings({ headers: { 'x-haxcms-user-token': 'token' } }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Missing localization settings payload')
  })

  test('a payload with no supported key answers 400 Missing localization settings payload', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveLocalizationSettings(userReq({ unrelated: true }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Missing localization settings payload')
  })

  test('an invalid defaultLanguage answers 400 Invalid defaultLanguage value', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveLocalizationSettings(userReq({ defaultLanguage: 'english' }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid defaultLanguage value')
  })

  test('a valid defaultLanguage is normalized and persisted', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveLocalizationSettings(userReq({ defaultLanguage: 'FR-fr' }), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.data.defaultLanguage, 'fr-FR')
    const filePath = path.join(HAXCMS.configDirectory, 'config.json')
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    assert.equal(stored.localization.defaultLanguage, 'fr-FR')
  })

  test('a wrapped localizationSettings payload is unwrapped before saving', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveLocalizationSettings(
      userReq({ localizationSettings: { defaultLanguage: 'de' } }),
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.defaultLanguage, 'de')
  })

  test('a blocked config.json path answers 500 Unable to save localization settings', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    // a DIRECTORY where config.json should be breaks fs.writeFile
    fs.ensureDirSync(path.join(tmpDir, 'config.json'))
    mockUserAuth(t)
    const res = stubRes()
    await saveLocalizationSettings(userReq({ defaultLanguage: 'en' }), res)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'Unable to save localization settings')
  })
})

// ---------------------------------------------------------------------------
// saveMediaSettings (system route, config-scoped)
// ---------------------------------------------------------------------------
describe('saveMediaSettings', () => {
  test('missing user token answers 403 invalid request token', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveMediaSettings({ headers: {}, body: { jpegQuality: 75 } }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('missing payload answers 400 Missing media settings payload', async (t) => {
    mockUserAuth(t)
    const res = stubRes()
    await saveMediaSettings({ headers: { 'x-haxcms-user-token': 'token' } }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Missing media settings payload')
  })

  test('invalid field values answer 400 with the field named in the message', async (t) => {
    mockUserAuth(t)
    const cases = [
      { jpegQuality: 'high' },
      { maxUploadSizeMb: 'big' },
      { acceptedFormats: 42 },
    ]
    const expected = [
      'Invalid jpegQuality value',
      'Invalid maxUploadSizeMb value',
      'Invalid acceptedFormats value',
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await saveMediaSettings(userReq(cases[i]), res)
      assert.equal(res.statusCode, 400, 'case ' + JSON.stringify(cases[i]))
      assert.equal(res.body.data.message, expected[i])
    }
  })

  test('a valid payload clamps, normalizes, and persists settings/media.json', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    const res = stubRes()
    await saveMediaSettings(
      userReq({
        mediaSettings: {
          jpegQuality: 200,
          maxUploadSizeMb: 512,
          acceptedFormats: 'JPG, jpeg , .webp',
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.deepEqual(res.body.data, {
      jpegQuality: 100,
      maxUploadSizeMb: 512,
      acceptedFormats: 'jpg,jpeg,webp',
    })
    const filePath = path.join(HAXCMS.configDirectory, 'settings', 'media.json')
    assert.equal(fs.existsSync(filePath), true)
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    assert.equal(stored.jpegQuality, 100)
    assert.equal(stored.maxUploadSizeMb, 512)
    assert.equal(stored.acceptedFormats, 'jpg,jpeg,webp')
  })

  test('a blocked media.json path answers 500 Unable to save media settings', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    fs.writeFileSync(path.join(tmpDir, 'settings'), 'not a dir')
    mockUserAuth(t)
    const res = stubRes()
    await saveMediaSettings(userReq({ jpegQuality: 75 }), res)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'Unable to save media settings')
  })
})
