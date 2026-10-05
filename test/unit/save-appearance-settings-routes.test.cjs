'use strict'

// Direct handler unit tests for the saveAppearanceSettings route
// (src/siteRoutes/v1/routes/saveAppearanceSettings.js). normalizeCssVariable
// and sanitizeRegionIds already have direct tests; this file drives the
// handler: site-token auth, allow-list payload validation, theme feature
// gating, theme element resolution against HAXCMS.getThemes, every theme
// variable branch (image/imageAlt/imageLink/cssVariable/palette/icon,
// including clears and rejects), region writes, and the save/commit/
// rebuild managed-files flow, using the shared fake-site spy fixture from
// save-settings-routes.test.cjs.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const saveAppearanceSettings = require('../../src/siteRoutes/v1/routes/saveAppearanceSettings.js')

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

function appearanceReq(themePayload, headers) {
  return {
    headers: Object.assign(
      { 'x-haxcms-site-token': 'token' },
      headers || {},
    ),
    body: {
      site: { name: 'demo' },
      manifest: {
        theme: themePayload === undefined ? {} : themePayload,
      },
    },
  }
}

function makeFakeSite(overrides) {
  const calls = {
    gitCommits: [],
    rebuildManagedFiles: 0,
    updateAlternateFormats: 0,
  }
  const site = {
    siteDirectory: null,
    calls: calls,
    manifest: {
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
  }
  return Object.assign(site, overrides || {})
}

function mockSiteAuth(t, site) {
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

function mockThemes(t) {
  t.mock.method(HAXCMS, 'getThemes', () => ({
    'my-theme': {
      element: 'my-theme',
      name: 'My Theme',
      variables: { hexCode: '#112233' },
      regions: { header: ['r-1'] },
    },
  }))
}

describe('saveAppearanceSettings — auth and payload validation', () => {
  test('missing token, missing site name, or invalid token answers 403', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const resNoToken = stubRes()
    await saveAppearanceSettings(
      appearanceReq({}, { 'x-haxcms-site-token': '' }),
      resNoToken,
    )
    assert.equal(resNoToken.statusCode, 403)
    assert.equal(resNoToken.body.data.message, 'Authentication required')
    const resNoName = stubRes()
    await saveAppearanceSettings(
      {
        headers: { 'x-haxcms-site-token': 'token' },
        body: { site: {}, manifest: { theme: {} } },
      },
      resNoName,
    )
    assert.equal(resNoName.statusCode, 403)
    t.mock.method(HAXCMS, 'validateRequestToken', () => false)
    const resBadToken = stubRes()
    await saveAppearanceSettings(appearanceReq({}), resBadToken)
    assert.equal(resBadToken.statusCode, 403)
  })

  test('disallowed keys at every payload level answer 400', async (t) => {
    const site = makeFakeSite()
    // permissive token validation so the payload validation runs even when
    // site.name itself is the invalid value being tested
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    const cases = [
      {
        body: { site: { name: 'demo' }, manifest: { theme: {} }, extra: true },
        message: 'Invalid request',
      },
      {
        body: { site: { name: 'demo', extra: true }, manifest: { theme: {} } },
        message: 'Invalid request',
      },
      {
        body: { site: { name: 42 }, manifest: { theme: {} } },
        message: 'Invalid request',
      },
      {
        body: { site: { name: 'demo' }, manifest: { theme: {}, extra: true } },
        message: 'Invalid request',
      },
      {
        body: {
          site: { name: 'demo' },
          manifest: { theme: { 'manifest-metadata-bogus': 1 } },
        },
        message: 'Invalid request',
      },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await saveAppearanceSettings(
        { headers: { 'x-haxcms-site-token': 'token' }, body: cases[i].body },
        res,
      )
      assert.equal(res.statusCode, 400, 'case ' + i)
      assert.equal(res.body.data.message, cases[i].message, 'case ' + i)
    }
    assert.deepEqual(site.manifest.saveCalls, [])
  })

  test('theme settings disabled for the site answers 403', async (t) => {
    const site = makeFakeSite()
    site.manifest.metadata.platform = { features: { themeManifest: false } }
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAppearanceSettings(appearanceReq({}), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Theme settings are disabled for this site')
  })

  test('an unloadable site answers 400 Invalid request', async (t) => {
    t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await saveAppearanceSettings(appearanceReq({}), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid request')
  })

  test('metadata containers are bootstrapped when missing', async (t) => {
    const site = makeFakeSite()
    site.manifest = {
      saveCalls: [],
      async save(reorganize) {
        this.saveCalls.push(typeof reorganize === 'boolean' ? reorganize : true)
      },
    }
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAppearanceSettings(appearanceReq({}), res)
    assert.equal(res.sent.status, 200)
    assert.equal(typeof site.manifest.metadata, 'object')
    assert.equal(typeof site.manifest.metadata.site, 'object')
    assert.equal(typeof site.manifest.metadata.theme, 'object')
    assert.equal(typeof site.manifest.metadata.theme.variables, 'object')
    assert.equal(typeof site.manifest.metadata.theme.regions, 'object')
  })
})

describe('saveAppearanceSettings — theme fields', () => {
  test('a full valid payload writes every theme field and variable', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    mockThemes(t)
    const res = stubRes()
    await saveAppearanceSettings(
      appearanceReq({
        'manifest-metadata-theme-element': 'my-theme',
        'manifest-metadata-theme-variables-image': 'files/hero.png',
        'manifest-metadata-theme-variables-imageAlt': 'A hero image',
        'manifest-metadata-theme-variables-imageLink': 'https://example.com/hero',
        'manifest-metadata-theme-variables-cssVariable': '--simple-colors-default-theme-blue-7',
        'manifest-metadata-theme-variables-palette': 'my-palette',
        'manifest-metadata-theme-variables-icon': 'icons:account',
        'manifest-metadata-theme-regions-header': ['r-1', 'r-2', 'r-1'],
        'manifest-metadata-theme-regions-footerPrimary': ['f-1'],
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.deepEqual(res.sent.data, { saved: true, appearance: { theme: true } })
    const theme = site.manifest.metadata.theme
    // the matched theme entry replaces the theme wholesale
    assert.equal(theme.element, 'my-theme')
    assert.equal(theme.name, 'My Theme')
    assert.equal(theme.variables.hexCode, '#112233')
    assert.equal(theme.variables.image, 'files/hero.png')
    assert.equal(theme.variables.imageAlt, 'A hero image')
    assert.equal(theme.variables.imageLink, 'https://example.com/hero')
    // cssVariable normalizes the prefix/suffix and stores the full token
    assert.equal(theme.variables.cssVariable, '--simple-colors-default-theme-blue-7')
    assert.equal(theme.variables.palette, 'my-palette')
    assert.equal(theme.variables.icon, 'icons:account')
    // region ids are sanitized and deduped
    assert.deepEqual(theme.regions.header, ['r-1', 'r-2'])
    assert.deepEqual(theme.regions.footerPrimary, ['f-1'])
    // the save/commit/rebuild flow ran
    assert.deepEqual(site.manifest.saveCalls, [false])
    assert.deepEqual(site.calls.gitCommits, [
      'Appearance settings updated',
      'Managed files updated',
    ])
    assert.equal(site.calls.rebuildManagedFiles, 1)
    assert.equal(site.calls.updateAlternateFormats, 1)
    assert.equal(site.manifest.metadata.site.updated, Math.floor(Date.now() / 1000))
  })

  test('theme element validation rejects unknown and non-string elements', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    mockThemes(t)
    const resUnknown = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-element': 'not-a-theme' }),
      resUnknown,
    )
    assert.equal(resUnknown.statusCode, 400)
    assert.equal(resUnknown.body.data.message, 'Invalid request')
    const resNonString = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-element': 42 }),
      resNonString,
    )
    assert.equal(resNonString.statusCode, 400)
    // a whitespace-only element sanitizes to empty and is rejected
    const resBlank = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-element': '  ' }),
      resBlank,
    )
    assert.equal(resBlank.statusCode, 400)
  })

  test('image, imageAlt, and imageLink accept null or strings only', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const cases = [
      { field: 'manifest-metadata-theme-variables-image', value: 42 },
      { field: 'manifest-metadata-theme-variables-imageAlt', value: [] },
      { field: 'manifest-metadata-theme-variables-imageLink', value: {} },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await saveAppearanceSettings(
        appearanceReq({ [cases[i].field]: cases[i].value }),
        res,
      )
      assert.equal(res.statusCode, 400, 'case ' + cases[i].field)
    }
    // null writes empty sanitized values (not deletes) for these variables
    const res = stubRes()
    site.manifest.metadata.theme.variables = {
      image: 'files/old.png',
      imageAlt: 'old alt',
      imageLink: 'https://old.example.com',
    }
    await saveAppearanceSettings(
      appearanceReq({
        'manifest-metadata-theme-variables-image': null,
        'manifest-metadata-theme-variables-imageAlt': null,
        'manifest-metadata-theme-variables-imageLink': null,
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    const variables = site.manifest.metadata.theme.variables
    // image/imageLink pass through sanitizeURLValue (empty string) while
    // imageAlt stores the filter's null passthrough
    assert.equal(variables.image, '')
    assert.equal(variables.imageAlt, null)
    assert.equal(variables.imageLink, '')
  })

  test('cssVariable clears on empty, rejects invalid, and round-trips valid', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    site.manifest.metadata.theme.variables = {
      cssVariable: '--simple-colors-default-theme-blue-7',
    }
    const resClear = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-cssVariable': '' }),
      resClear,
    )
    assert.equal(resClear.sent.status, 200)
    assert.equal('cssVariable' in site.manifest.metadata.theme.variables, false)
    const resNull = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-cssVariable': null }),
      resNull,
    )
    assert.equal(resNull.sent.status, 200)
    assert.equal('cssVariable' in site.manifest.metadata.theme.variables, false)
    const resInvalid = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-cssVariable': 'has spaces' }),
      resInvalid,
    )
    assert.equal(resInvalid.statusCode, 400)
    assert.equal(resInvalid.body.data.message, 'Invalid request')
    const resValid = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-cssVariable': 'red' }),
      resValid,
    )
    assert.equal(resValid.sent.status, 200)
    assert.equal(
      site.manifest.metadata.theme.variables.cssVariable,
      '--simple-colors-default-theme-red-7',
    )
  })

  test('palette clears on null/empty, rejects invalid and non-strings', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    site.manifest.metadata.theme.variables = { palette: 'old-palette' }
    const resClear = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-palette': '' }),
      resClear,
    )
    assert.equal(resClear.sent.status, 200)
    assert.equal('palette' in site.manifest.metadata.theme.variables, false)
    const resNull = stubRes()
    site.manifest.metadata.theme.variables.palette = 'old-palette'
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-palette': null }),
      resNull,
    )
    assert.equal(resNull.sent.status, 200)
    assert.equal('palette' in site.manifest.metadata.theme.variables, false)
    const resSpaces = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-palette': 'has spaces' }),
      resSpaces,
    )
    assert.equal(resSpaces.statusCode, 400)
    const resNumber = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-palette': 42 }),
      resNumber,
    )
    assert.equal(resNumber.statusCode, 400)
    const resValid = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-palette': 'new-palette' }),
      resValid,
    )
    assert.equal(resValid.sent.status, 200)
    assert.equal(site.manifest.metadata.theme.variables.palette, 'new-palette')
  })

  test('icon stores strings and rejects other types', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const resValid = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-icon': 'icons:home' }),
      resValid,
    )
    assert.equal(resValid.sent.status, 200)
    assert.equal(site.manifest.metadata.theme.variables.icon, 'icons:home')
    const resNumber = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-icon': 7 }),
      resNumber,
    )
    assert.equal(resNumber.statusCode, 400)
    // a null icon stores as the filter's null passthrough
    const resNull = stubRes()
    await saveAppearanceSettings(
      appearanceReq({ 'manifest-metadata-theme-variables-icon': null }),
      resNull,
    )
    assert.equal(resNull.sent.status, 200)
    assert.equal(site.manifest.metadata.theme.variables.icon, null)
  })

  test('regions reject non-arrays, non-strings, and empty ids', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const cases = [
      { field: 'manifest-metadata-theme-regions-header', value: 'r-1' },
      { field: 'manifest-metadata-theme-regions-header', value: [42] },
      { field: 'manifest-metadata-theme-regions-header', value: ['r-1', ''] },
      { field: 'manifest-metadata-theme-regions-footerPrimary', value: ['   '] },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await saveAppearanceSettings(
        appearanceReq({ [cases[i].field]: cases[i].value }),
        res,
      )
      assert.equal(res.statusCode, 400, 'case ' + i)
      assert.equal(res.body.data.message, 'Invalid request', 'case ' + i)
    }
    assert.deepEqual(site.manifest.saveCalls, [])
  })

  test('all seven region slots write through', async (t) => {
    const site = makeFakeSite()
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveAppearanceSettings(
      appearanceReq({
        'manifest-metadata-theme-regions-header': ['h'],
        'manifest-metadata-theme-regions-sidebarFirst': ['s1'],
        'manifest-metadata-theme-regions-sidebarSecond': ['s2'],
        'manifest-metadata-theme-regions-contentTop': ['ct'],
        'manifest-metadata-theme-regions-contentBottom': ['cb'],
        'manifest-metadata-theme-regions-footerPrimary': ['fp'],
        'manifest-metadata-theme-regions-footerSecondary': ['fs'],
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    assert.deepEqual(site.manifest.metadata.theme.regions, {
      header: ['h'],
      sidebarFirst: ['s1'],
      sidebarSecond: ['s2'],
      contentTop: ['ct'],
      contentBottom: ['cb'],
      footerPrimary: ['fp'],
      footerSecondary: ['fs'],
    })
  })
})
