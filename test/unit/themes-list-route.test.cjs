'use strict'

// Direct handler unit tests for src/systemRoutes/v1/routes/themesList.js.
// Discovery runs the real discoverThemes/applyDetectedThemeDefaults/
// readEnabledThemeMap from lib/themeSettings.js against HAXCMS.getThemes
// mocked per test (path-less registry themes are always detected) and a
// temp HAXCMS.configDirectory holding settings/enabledThemes.json, so the
// enabled-map read/defaults-write flow hits scratch disk. The enabled/
// disabled/includeDisabled filter branches and the discovery-failure 500
// are exercised through resolveEnabledFilter.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const themesList = require('../../src/systemRoutes/v1/routes/themesList.js')

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
  }
}

function makeReq(query, body) {
  return {
    headers: {},
    query: query || {},
    body: body || {},
  }
}

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'themeslist-config-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

// registry of themes: theme-a (plain), theme-b (disabled), theme-c (hidden),
// terrible-thing (terrible), theme-d (has a screenshot)
function mockThemes(t) {
  t.mock.method(HAXCMS, 'getThemes', () => ({
    'theme-a': { element: 'theme-a', name: 'Theme A' },
    'theme-b': { element: 'theme-b', name: 'Theme B' },
    'theme-c': { element: 'theme-c', name: 'Theme C', hidden: true },
    'terrible-thing': { element: 'terrible-thing', name: 'Terrible' },
    'theme-d': {
      element: 'theme-d',
      name: 'Theme D',
      screenshot: 'files/theme-d-shot.jpg',
    },
  }))
}

describe('themesList route', () => {
  test('lists enabled themes with defaults written to the enabled map', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockThemes(t)
    const res = stubRes()
    await themesList(makeReq(), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    const items = res.body.data
    // hidden and terrible themes never appear; discovery sorts by machine name
    assert.deepEqual(
      items.map((item) => item.machineName),
      ['theme-a', 'theme-b', 'theme-d'],
    )
    assert.equal(items[0].enabled, true)
    assert.equal(items[0].hidden, false)
    assert.equal(items[0].screenshot, '')
    assert.equal(items[2].screenshot, 'files/theme-d-shot.jpg')
    // the defaults pass wrote every detected theme into the enabled map
    const stored = JSON.parse(
      fs.readFileSync(path.join(configDir, 'settings', 'enabledThemes.json'), 'utf8'),
    )
    assert.deepEqual(stored.enabledThemes, {
      'theme-a': true,
      'theme-b': true,
      'theme-c': true,
      'terrible-thing': true,
      'theme-d': true,
    })
  })

  test('a stored disabled theme filters out by default', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockThemes(t)
    fs.ensureDirSync(path.join(configDir, 'settings'))
    fs.writeFileSync(
      path.join(configDir, 'settings', 'enabledThemes.json'),
      JSON.stringify({ enabledThemes: { 'theme-b': false } }),
    )
    const res = stubRes()
    await themesList(makeReq(), res)
    assert.equal(res.body.status, 200)
    assert.deepEqual(
      res.body.data.map((item) => item.machineName),
      ['theme-a', 'theme-d'],
    )
    // the disabled theme is still reported through the enabled=false filter
    const resDisabled = stubRes()
    await themesList(makeReq({ enabled: 'false' }), resDisabled)
    assert.deepEqual(
      resDisabled.body.data.map((item) => item.machineName),
      ['theme-b'],
    )
    assert.equal(resDisabled.body.data[0].enabled, false)
    assert.equal(resDisabled.body.data[0].hidden, true)
    // enabled=true keeps the same default view
    const resEnabled = stubRes()
    await themesList(makeReq({ enabled: 'true' }), resEnabled)
    assert.deepEqual(
      resEnabled.body.data.map((item) => item.machineName),
      ['theme-a', 'theme-d'],
    )
    // includeDisabled shows everything stored, hidden registry themes aside
    const resAll = stubRes()
    await themesList(makeReq({ includeDisabled: 'true' }), resAll)
    assert.deepEqual(
      resAll.body.data.map((item) => item.machineName),
      ['theme-a', 'theme-b', 'theme-d'],
    )
  })

  test('body enabled/includeDisabled flags mirror the query flags', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockThemes(t)
    fs.ensureDirSync(path.join(configDir, 'settings'))
    fs.writeFileSync(
      path.join(configDir, 'settings', 'enabledThemes.json'),
      JSON.stringify({ enabledThemes: { 'theme-b': false } }),
    )
    const resDisabledBody = stubRes()
    await themesList(makeReq({}, { enabled: false }), resDisabledBody)
    assert.deepEqual(
      resDisabledBody.body.data.map((item) => item.machineName),
      ['theme-b'],
    )
    const resAllBody = stubRes()
    await themesList(makeReq({}, { includeDisabled: 'yes' }), resAllBody)
    assert.deepEqual(
      resAllBody.body.data.map((item) => item.machineName),
      ['theme-a', 'theme-b', 'theme-d'],
    )
    // junk flag values normalize to the enabled-only default
    const resJunk = stubRes()
    await themesList(makeReq({ enabled: 'bogus' }), resJunk)
    assert.deepEqual(
      resJunk.body.data.map((item) => item.machineName),
      ['theme-a', 'theme-d'],
    )
  })

  test('a discovery failure answers the 500 Unable to load theme settings', async (t) => {
    useTempConfigDirectory(t)
    t.mock.method(HAXCMS, 'getThemes', () => {
      throw new Error('registry exploded')
    })
    const res = stubRes()
    await themesList(makeReq(), res)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'Unable to load theme settings')
  })

  test('a corrupt enabled-themes file falls back to defaults', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockThemes(t)
    fs.ensureDirSync(path.join(configDir, 'settings'))
    fs.writeFileSync(
      path.join(configDir, 'settings', 'enabledThemes.json'),
      'not json at all',
    )
    const res = stubRes()
    await themesList(makeReq(), res)
    assert.equal(res.body.status, 200)
    assert.deepEqual(
      res.body.data.map((item) => item.machineName),
      ['theme-a', 'theme-b', 'theme-d'],
    )
  })
})
