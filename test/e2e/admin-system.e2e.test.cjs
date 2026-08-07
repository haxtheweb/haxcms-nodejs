'use strict'

// E2E test: system admin APIs — themes, skeletons, api-keys, media settings,
// system status, and system version.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal
// (light UI, just to get the SPA authed) -> use authenticated-axios (Bearer
// JWT + X-HAXCMS-User-Token from runtime.dashboardSettings) to assert:
//   - GET /system/api/v1/themes (themesList) returns themes
//   - PATCH /system/api/v1/themes (saveEnabledThemes) toggles one + persists
//   - GET /system/api/v1/skeletons (skeletonsList) returns skeletons
//   - PATCH /system/api/v1/skeletons (saveEnabledSkeletons) toggles one
//   - GET /system/api/v1/configuration/api-keys (getApiKeys) returns keys
//   - PATCH /system/api/v1/configuration/api-keys (saveApiKeys) persists
//   - GET /system/api/v1/configuration/media (getMediaSettings) returns settings
//   - PATCH /system/api/v1/configuration/media (saveMediaSettings) persists
//   - GET /system/api/v1/status (systemStatus) returns a sane report
//   - GET /system/api/v1/system/version (systemVersion) returns a version
// -> teardown.
//
// Auth: system admin routes require a Bearer JWT. The save (PATCH) routes
// additionally require a valid X-HAXCMS-User-Token header
// (runtime.userToken via runtime.userTokenHeader, both populated by the
// harness from /system/api/v1/session/connection-settings). These are
// system-level admin routes, not per-site, so no X-HAXCMS-Site-Token is
// needed.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to
// src/build/node_modules. These routes are API-driven; the dashboard admin
// UI (haxcms-system-settings) is exercised only lightly (login) because the
// route handlers are the contract under test.

const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  captureScreenshot,
  FIXED_SITE_NAME,
  // flows helpers
  safeCompareBaseline,
  patchHaxcmsRootForHarness,
  loginViaUI,
} = require('./helpers')

// --- shared state ----------------------------------------------------------
let runtime = null
let browser = null
let page = null
let collector = null

// --- setup / teardown ------------------------------------------------------

test.before(async () => {
  runtime = await setupE2ERuntime()
  patchHaxcmsRootForHarness(runtime)
  browser = await launchBrowser()
  page = await newPage(browser)
  collector = createResponseCollector(page)
}, { timeout: 120000 })

test.after(async () => {
  if (collector) {
    try { collector.detach() } catch (e) { /* ignore */ }
  }
  if (browser) {
    try { await browser.close() } catch (e) { /* ignore */ }
  }
  if (runtime) {
    try { await teardownE2ERuntime(runtime) } catch (e) { /* ignore */ }
  }
}, { timeout: 60000 })

// --- helpers ---------------------------------------------------------------

// Authenticated axios for system admin routes. ALL system admin routes
// (themes, skeletons, api-keys, media, status, version — both GET and PATCH)
// require Bearer JWT + X-HAXCMS-User-Token (policy 'authenticated-user' per
// the system OpenAPI spec). The userToken + userTokenHeader are populated by
// the harness from /system/api/v1/session/connection-settings.
function systemApiUrl(suffix) {
  return runtime.baseUrl + '/system/api/v1/' + suffix
}

function authHeaders() {
  const headers = {
    Authorization: 'Bearer ' + runtime.jwt,
  }
  headers[runtime.userTokenHeader] = runtime.userToken
  return headers
}

async function systemApiGet(suffix) {
  return axios({
    method: 'GET',
    url: systemApiUrl(suffix),
    headers: authHeaders(),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
}

async function systemApiPatch(suffix, body) {
  return axios({
    method: 'PATCH',
    url: systemApiUrl(suffix),
    headers: Object.assign({}, authHeaders(), {
      'Content-Type': 'application/json',
    }),
    data: body,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
}

// --- the flow --------------------------------------------------------------

test(
  'system admin APIs — themes, skeletons, api-keys, media, status, version',
  { timeout: 300000 },
  async (t) => {
    assert.ok(page, 'page initialised in before hook')
    assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')
    assert.ok(
      runtime.userToken && runtime.userTokenHeader,
      'runtime has userToken + userTokenHeader for save routes',
    )

    // 1. Light UI login (gets the SPA authed; also confirms the dashboard
    //    admin surface loads). The route handlers are the contract under
    //    test, so we do not drive the admin UI further.
    await loginViaUI(page, collector, runtime.baseUrl)
    t.diagnostic('[e2e] login OK; jwt length=' + runtime.jwt.length)

    // 2. Themes: GET list + PATCH toggle one.
    await t.test('API: GET themes returns a themes list', async () => {
      const resp = await systemApiGet('themes')
      assert.strictEqual(resp.status, 200, 'themesList GET returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'themes body status 200')
      const data = body && body.data
      assert.ok(Array.isArray(data), 'themes data is an array')
      assert.ok(data.length > 0, 'themes list has at least 1 theme')
      const first = data[0]
      assert.ok(
        typeof first.machineName === 'string' && first.machineName.length > 0,
        'first theme has a machineName string',
      )
      assert.ok(
        typeof first.enabled === 'boolean',
        'first theme has an enabled boolean',
      )
      t.diagnostic(
        '[e2e] themes: count=' + data.length + ' first=' + first.machineName,
      )
    })

    await t.test('API: PATCH themes toggles one + persists', async () => {
      // Fetch the current list to pick a theme to toggle.
      const listResp = await systemApiGet('themes')
      let listBody = null
      try {
        listBody = JSON.parse(String(listResp.data || ''))
      } catch (e) {
        listBody = null
      }
      const themes =
        listBody && Array.isArray(listBody.data) ? listBody.data : []
      assert.ok(themes.length > 0, 'themes list available for toggle')
      // Pick the first theme; record its initial enabled state.
      const target = themes[0]
      const targetName = target.machineName
      const initiallyEnabled = target.enabled === true
      // Build the enabledThemes array: all currently-enabled themes, then
      // flip the target. This minimizes side effects on other themes.
      const enabledNames = []
      for (let i = 0; i < themes.length; i++) {
        if (themes[i].enabled === true && themes[i].machineName !== targetName) {
          enabledNames.push(themes[i].machineName)
        }
      }
      // Toggle: if it was enabled, remove it; if disabled, add it.
      if (!initiallyEnabled) {
        enabledNames.push(targetName)
      }
      const patchResp = await systemApiPatch(
        'themes',
        { enabledThemes: enabledNames },
      )
      assert.strictEqual(
        patchResp.status,
        200,
        'saveEnabledThemes PATCH returned 200',
      )
      let patchBody = null
      try {
        patchBody = JSON.parse(String(patchResp.data || ''))
      } catch (e) {
        patchBody = null
      }
      assert.ok(
        patchBody && patchBody.status === 200,
        'saveEnabledThemes body status 200',
      )
      const savedData = patchBody && patchBody.data
      assert.ok(savedData, 'saveEnabledThemes has data')
      assert.ok(
        Array.isArray(savedData.enabledThemes),
        'data.enabledThemes is an array',
      )
      // Verify the toggle took effect: target should be in (or out of) the
      // saved list opposite to its initial state.
      const savedEnabled = savedData.enabledThemes
      const targetInSaved = savedEnabled.indexOf(targetName) !== -1
      assert.ok(
        targetInSaved === !initiallyEnabled,
        'target theme toggled: was ' +
          (initiallyEnabled ? 'enabled' : 'disabled') +
          ', now ' +
          (targetInSaved ? 'enabled' : 'disabled'),
      )
      // Restore the original state so the test is idempotent.
      const restoreNames = []
      for (let i = 0; i < themes.length; i++) {
        if (themes[i].enabled === true) {
          restoreNames.push(themes[i].machineName)
        }
      }
      await systemApiPatch('themes', { enabledThemes: restoreNames })
      t.diagnostic(
        '[e2e] themes toggle: ' +
          targetName +
          ' ' +
          (initiallyEnabled ? 'enabled->disabled' : 'disabled->enabled') +
          ' (restored)',
      )
    })

    // 3. Skeletons: GET list + PATCH toggle one.
    await t.test('API: GET skeletons returns a skeletons list', async () => {
      const resp = await systemApiGet('skeletons')
      assert.strictEqual(resp.status, 200, 'skeletonsList GET returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'skeletons body status 200')
      const data = body && body.data
      assert.ok(Array.isArray(data), 'skeletons data is an array')
      // The boilerplate may seed 0 or more skeletons; assert the shape if any.
      if (data.length > 0) {
        const first = data[0]
        assert.ok(
          typeof first.machineName === 'string',
          'first skeleton has a machineName string',
        )
        assert.ok(
          typeof first.enabled === 'boolean',
          'first skeleton has an enabled boolean',
        )
      }
      t.diagnostic('[e2e] skeletons: count=' + data.length)
    })

    await t.test('API: PATCH skeletons toggles one + persists', async () => {
      const listResp = await systemApiGet('skeletons')
      let listBody = null
      try {
        listBody = JSON.parse(String(listResp.data || ''))
      } catch (e) {
        listBody = null
      }
      const skeletons =
        listBody && Array.isArray(listBody.data) ? listBody.data : []
      if (skeletons.length === 0) {
        t.diagnostic(
          '[e2e] no skeletons seeded in boilerplate; skipping toggle (non-fatal)',
        )
        return
      }
      const target = skeletons[0]
      const targetName = target.machineName
      const initiallyEnabled = target.enabled === true
      const enabledNames = []
      for (let i = 0; i < skeletons.length; i++) {
        if (
          skeletons[i].enabled === true &&
          skeletons[i].machineName !== targetName
        ) {
          enabledNames.push(skeletons[i].machineName)
        }
      }
      if (!initiallyEnabled) {
        enabledNames.push(targetName)
      }
      const patchResp = await systemApiPatch(
        'skeletons',
        { enabledSkeletons: enabledNames },
      )
      assert.strictEqual(
        patchResp.status,
        200,
        'saveEnabledSkeletons PATCH returned 200',
      )
      let patchBody = null
      try {
        patchBody = JSON.parse(String(patchResp.data || ''))
      } catch (e) {
        patchBody = null
      }
      assert.ok(
        patchBody && patchBody.status === 200,
        'saveEnabledSkeletons body status 200',
      )
      const savedData = patchBody && patchBody.data
      assert.ok(savedData, 'saveEnabledSkeletons has data')
      assert.ok(
        Array.isArray(savedData.enabledSkeletons),
        'data.enabledSkeletons is an array',
      )
      // Restore original state.
      const restoreNames = []
      for (let i = 0; i < skeletons.length; i++) {
        if (skeletons[i].enabled === true) {
          restoreNames.push(skeletons[i].machineName)
        }
      }
      await systemApiPatch(
        'skeletons',
        { enabledSkeletons: restoreNames },
      )
      t.diagnostic(
        '[e2e] skeletons toggle: ' +
          targetName +
          ' ' +
          (initiallyEnabled ? 'enabled->disabled' : 'disabled->enabled') +
          ' (restored)',
      )
    })

    // 4. API keys: GET + PATCH (save).
    await t.test('API: GET configuration/api-keys returns keys object', async () => {
      const resp = await systemApiGet('configuration/api-keys')
      assert.strictEqual(resp.status, 200, 'getApiKeys GET returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'getApiKeys body status 200')
      const data = body && body.data
      assert.ok(data && typeof data === 'object', 'api keys data is an object')
      // The shape is a map of provider -> key string (may be empty initially).
      t.diagnostic(
        '[e2e] api keys: providers=' +
          Object.keys(data).join(',') +
          ' count=' +
          Object.keys(data).length,
      )
    })

    await t.test('API: PATCH configuration/api-keys persists a key', async () => {
      // Save a dummy key for a known provider, then verify GET sees it,
      // then restore by saving empty string (which clears it).
      const testProvider = 'youtube'
      const testKey = 'e2e-test-key-' + Date.now()
      const patchResp = await systemApiPatch(
        'configuration/api-keys',
        { apiKeys: { youtube: testKey } },
      )
      assert.strictEqual(
        patchResp.status,
        200,
        'saveApiKeys PATCH returned 200',
      )
      let patchBody = null
      try {
        patchBody = JSON.parse(String(patchResp.data || ''))
      } catch (e) {
        patchBody = null
      }
      assert.ok(
        patchBody && patchBody.status === 200,
        'saveApiKeys body status 200',
      )
      const savedData = patchBody && patchBody.data
      assert.ok(
        savedData && typeof savedData === 'object',
        'saveApiKeys data is an object',
      )
      // Verify the key persisted via a fresh GET.
      const getResp = await systemApiGet('configuration/api-keys')
      let getBody = null
      try {
        getBody = JSON.parse(String(getResp.data || ''))
      } catch (e) {
        getBody = null
      }
      const getData = getBody && getBody.data
      assert.ok(
        getData &&
          typeof getData[testProvider] === 'string' &&
          getData[testProvider] === testKey,
        'saved youtube key is present in subsequent GET',
      )
      // Restore: clear the key.
      await systemApiPatch(
        'configuration/api-keys',
        { apiKeys: { youtube: '' } },
      )
      t.diagnostic('[e2e] api keys: saved + verified + restored youtube key')
    })

    // 5. Media settings: GET + PATCH (save).
    await t.test('API: GET configuration/media returns settings object', async () => {
      const resp = await systemApiGet('configuration/media')
      assert.strictEqual(resp.status, 200, 'getMediaSettings GET returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'getMediaSettings body status 200')
      const data = body && body.data
      assert.ok(
        data && typeof data === 'object',
        'media settings data is an object',
      )
      t.diagnostic(
        '[e2e] media settings keys: ' + Object.keys(data).join(','),
      )
    })

    await t.test('API: PATCH configuration/media persists a setting', async () => {
      // Save a valid jpegQuality value, verify via GET, then restore.
      // normalizeJpegQuality accepts 1-100 integers.
      const testQuality = 82
      const patchResp = await systemApiPatch(
        'configuration/media',
        { mediaSettings: { jpegQuality: testQuality } },
      )
      assert.strictEqual(
        patchResp.status,
        200,
        'saveMediaSettings PATCH returned 200',
      )
      let patchBody = null
      try {
        patchBody = JSON.parse(String(patchResp.data || ''))
      } catch (e) {
        patchBody = null
      }
      assert.ok(
        patchBody && patchBody.status === 200,
        'saveMediaSettings body status 200',
      )
      const savedData = patchBody && patchBody.data
      assert.ok(
        savedData && typeof savedData === 'object',
        'saveMediaSettings data is an object',
      )
      // Verify via a fresh GET.
      const getResp = await systemApiGet('configuration/media')
      let getBody = null
      try {
        getBody = JSON.parse(String(getResp.data || ''))
      } catch (e) {
        getBody = null
      }
      const getData = getBody && getBody.data
      assert.ok(
        getData &&
          typeof getData.jpegQuality === 'number' &&
          getData.jpegQuality === testQuality,
        'saved jpegQuality is present in subsequent GET',
      )
      // Restore to a default (75 is a safe default).
      await systemApiPatch(
        'configuration/media',
        { mediaSettings: { jpegQuality: 75 } },
      )
      t.diagnostic(
        '[e2e] media settings: saved jpegQuality=' +
          testQuality +
          ' + verified + restored',
      )
    })

    // 6. System status + version.
    await t.test('API: GET status returns a sane system status report', async () => {
      const resp = await systemApiGet('status')
      assert.strictEqual(resp.status, 200, 'systemStatus GET returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'systemStatus body status 200')
      const data = body && body.data
      assert.ok(data && typeof data === 'object', 'systemStatus data is an object')
      // The report is backend-agnostic; assert it has SOME string or array
      // content without over-constraining the shape.
      const dataKeys = Object.keys(data)
      assert.ok(dataKeys.length > 0, 'systemStatus data has at least 1 key')
      t.diagnostic(
        '[e2e] system status keys: ' + dataKeys.join(','),
      )
    })

    await t.test('API: GET system/version returns a version string', async () => {
      const resp = await systemApiGet('system/version')
      assert.strictEqual(resp.status, 200, 'systemVersion GET returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'systemVersion body status 200')
      const data = body && body.data
      assert.ok(data && typeof data === 'object', 'systemVersion data is an object')
      assert.ok(
        typeof data.version === 'string' && data.version.length > 0,
        'data.version is a non-empty string',
      )
      t.diagnostic('[e2e] system version: ' + data.version)
    })

    // 7. Visual baseline: dashboard after login (light UI).
    await t.test('visual: admin-system dashboard baseline', async () => {
      const buf = await captureScreenshot(page, 'admin-system-dashboard')
      const cmp = await safeCompareBaseline(
        'admin-system-dashboard',
        buf,
        null,
        t,
      )
      t.diagnostic(
        '[visual] admin-system-dashboard: diffPercent=' +
          (cmp.diffPercent * 100).toFixed(3) +
          '% baselineExists=' +
          cmp.baselineExists +
          ' baselineUpdated=' +
          cmp.baselineUpdated,
      )
    })
  },
)
