'use strict'

// E2E test: site theme (Appearance) settings — select a different theme + save
// via the settings modal (#manifestbtn → Appearance panel →
// haxcms-appearance-admin-dialog).
//
// Flow: boot isolated runtime → login → create site → navigate to editor →
// click #manifestbtn → click "Appearance" dashboard-action button →
// haxcms-appearance-admin-dialog opens → read current theme radio, select a
// different theme radio (input[name="manifest-metadata-theme-element"]) →
// click Save → intercept PATCH /x/api/v1/site/appearance (saveAppearanceSettings)
// → assert 200 → disk cross-check (site.json metadata.theme.element changed) +
// GET /x/api/v1/themes/active reflects new theme → visual baseline + a11y.
//
// Constraints: CommonJS, globalThis, NO optional chaining, node:test +
// node:assert/strict, visual diffs WARN, no src/build/node_modules edits.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const axios = require('axios')

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  runA11y,
  captureScreenshot,
  selectors,
  FIXED_SITE_NAME,
  waitFor,
  loginViaUI,
  createSiteViaUI,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  clickEditorButtonById,
  safeCompareBaseline,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'

// --- settings-specific local helpers (same as site-manifest-settings) ---

function createSettingsResponseWatcher(page) {
  const records = []
  const handler = (response) => {
    const url = response.url()
    if (url.indexOf('/x/api/v1/site') === -1) {
      return
    }
    let method = 'GET'
    try {
      method = response.request().method()
    } catch (e) {
      method = 'GET'
    }
    const rec = {
      url: url,
      method: method,
      status: response.status(),
      bodyText: '',
      timestamp: Date.now(),
    }
    records.push(rec)
    Promise.race([
      response.text().catch(() => ''),
      new Promise((r) => setTimeout(() => r(''), 3000)),
    ]).then((bodyText) => {
      rec.bodyText = bodyText
    })
  }
  page.on('response', handler)
  return {
    waitForPatch: (urlPath, timeoutMs) =>
      new Promise((resolve) => {
        const deadline = Date.now() + (timeoutMs || 30000)
        const poll = () => {
          for (let i = 0; i < records.length; i++) {
            if (
              records[i].method.toUpperCase() === 'PATCH' &&
              records[i].url.indexOf(urlPath) !== -1
            ) {
              return resolve(records[i])
            }
          }
          if (Date.now() >= deadline) {
            return resolve(null)
          }
          setTimeout(poll, 200)
        }
        poll()
      }),
    detach: () => page.off('response', handler),
    getAll: () => records.slice(),
  }
}

async function getSettingsDashboard(page) {
  const handle = await page.evaluateHandle(() => {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      if (modals[i].opened !== true) {
        continue
      }
      var dash = modals[i].querySelector('haxcms-site-settings-dashboard')
      if (dash) {
        return dash
      }
    }
    return null
  })
  const el = handle.asElement()
  if (!el) {
    await handle.dispose()
    return null
  }
  return el
}

async function clickDashboardButton(dashboardHandle, buttonText) {
  return dashboardHandle.evaluate((el, text) => {
    if (!el || !el.shadowRoot) {
      return { error: 'no shadowRoot' }
    }
    var btns = el.shadowRoot.querySelectorAll('button.dashboard-action')
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent ? btns[i].textContent.trim() : ''
      if (t.toLowerCase().indexOf(text.toLowerCase()) !== -1) {
        btns[i].click()
        return { clicked: true, text: t }
      }
    }
    return { error: 'button not found' }
  }, buttonText)
}

async function getSubPanelDialog(page, dialogTag) {
  const handle = await page.evaluateHandle((tag) => {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      if (modals[i].opened !== true) {
        continue
      }
      var d = modals[i].querySelector(tag)
      if (d && d.shadowRoot) {
        return d
      }
    }
    return null
  }, dialogTag)
  const el = handle.asElement()
  if (!el) {
    await handle.dispose()
    return null
  }
  return el
}

// Recursively query all elements matching a selector, piercing nested shadow roots.
function queryAllInShadowRoot(root, sel) {
  var results = []
  if (!root) return results
  var direct = root.querySelectorAll(sel)
  for (var i = 0; i < direct.length; i++) {
    results.push(direct[i])
  }
  var all = root.querySelectorAll('*')
  for (var j = 0; j < all.length; j++) {
    if (all[j].shadowRoot) {
      var inner = queryAllInShadowRoot(all[j].shadowRoot, sel)
      for (var k = 0; k < inner.length; k++) {
        results.push(inner[k])
      }
    }
  }
  return results
}

// Read the currently checked radio value for a named radio group in the dialog shadowRoot.
async function readDialogRadio(dialogHandle, name) {
  return dialogHandle.evaluate((el, n) => {
    if (!el || !el.shadowRoot) {
      return null
    }
    var radios = queryAllInShadowRoot(el.shadowRoot, 'input[type="radio"][name="' + n + '"]')
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) {
        return radios[i].value
      }
    }
    return null
    function queryAllInShadowRoot(root, sel) {
      var results = []
      if (!root) return results
      var direct = root.querySelectorAll(sel)
      for (var i = 0; i < direct.length; i++) results.push(direct[i])
      var all = root.querySelectorAll('*')
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) {
          var inner = queryAllInShadowRoot(all[j].shadowRoot, sel)
          for (var k = 0; k < inner.length; k++) results.push(inner[k])
        }
      }
      return results
    }
  }, name)
}

// Select a radio button by name + value in the dialog shadowRoot.
async function setDialogRadio(dialogHandle, name, value) {
  return dialogHandle.evaluate((el, n, v) => {
    if (!el || !el.shadowRoot) {
      return { error: 'no shadowRoot' }
    }
    function findInShadowRoot(root, sel) {
      if (!root) return null
      var f = root.querySelector(sel)
      if (f) return f
      var a = root.querySelectorAll('*')
      for (var i = 0; i < a.length; i++) {
        if (a[i].shadowRoot) {
          var inner = findInShadowRoot(a[i].shadowRoot, sel)
          if (inner) return inner
        }
      }
      return null
    }
    var radio = findInShadowRoot(el.shadowRoot, 'input[type="radio"][name="' + n + '"][value="' + v + '"]')
    if (!radio) {
      return { error: 'radio not found: ' + n + '=' + v }
    }
    radio.checked = true
    radio.dispatchEvent(new Event('input', { bubbles: true }))
    radio.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: radio.value }
  }, name, value)
}

// List all available radio values for a named group (for discovery / choosing a different theme).
async function listDialogRadioValues(dialogHandle, name) {
  return dialogHandle.evaluate((el, n) => {
    if (!el || !el.shadowRoot) {
      return []
    }
    function queryAllInShadowRoot(root, sel) {
      var results = []
      if (!root) return results
      var direct = root.querySelectorAll(sel)
      for (var i = 0; i < direct.length; i++) results.push(direct[i])
      var all = root.querySelectorAll('*')
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) {
          var inner = queryAllInShadowRoot(all[j].shadowRoot, sel)
          for (var k = 0; k < inner.length; k++) results.push(inner[k])
        }
      }
      return results
    }
    var radios = queryAllInShadowRoot(el.shadowRoot, 'input[type="radio"][name="' + n + '"]')
    var vals = []
    for (var i = 0; i < radios.length; i++) {
      vals.push(radios[i].value)
    }
    return vals
  }, name)
}

async function clickDialogSave(dialogHandle) {
  return dialogHandle.evaluate((el) => {
    if (!el || !el.shadowRoot) {
      return { error: 'no shadowRoot' }
    }
    var btns = el.shadowRoot.querySelectorAll('button.action')
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent ? btns[i].textContent.trim() : ''
      if (t === 'Save') {
        btns[i].click()
        return { clicked: true }
      }
    }
    return { error: 'Save button not found' }
  })
}

// --- shared state ---
let runtime = null
let browser = null
let page = null
let collector = null
let settingsWatcher = null

test.before(async () => {
  runtime = await setupE2ERuntime()
  patchHaxcmsRootForHarness(runtime)
  browser = await launchBrowser()
  page = await newPage(browser)
  collector = createResponseCollector(page)
  settingsWatcher = createSettingsResponseWatcher(page)
}, { timeout: 120000 })

test.after(async () => {
  if (settingsWatcher) {
    try { settingsWatcher.detach() } catch (e) { /* ignore */ }
  }
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

// --- the flow ---

test(
  'site theme (Appearance) settings — select different theme + save',
  { timeout: 300000 },
  async (t) => {
    assert.ok(page, 'page initialised in before hook')
    assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

    // 1. Login + create site + relocate.
    await loginViaUI(page, collector, runtime.baseUrl)
    await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    relocateCreatedSite(runtime, FIXED_SITE_NAME)

    // 2. Navigate into the site editor.
    const editorUrl = runtime.baseUrl + '/_sites/' + EXPECTED_SITE_NAME + '/'
    t.diagnostic('[e2e] navigating to editor: ' + editorUrl)
    try {
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
    await new Promise((r) => setTimeout(r, 4000))

    // 3. Wait for #manifestbtn enabled, then click it.
    const manifestReady = await waitFor(
      async () =>
        page.evaluate(() => {
          var ui = document.querySelector('haxcms-site-editor-ui')
          if (!ui || !ui.shadowRoot) return false
          var b = ui.shadowRoot.querySelector('#manifestbtn')
          return !!(b && !b.hasAttribute('disabled') && !b.hasAttribute('hidden'))
        }),
      30000,
    )
    assert.ok(manifestReady, '#manifestbtn is enabled and visible')
    await clickEditorButtonById(page, '#manifestbtn')
    await new Promise((r) => setTimeout(r, 3000))

    // 4. Get dashboard + click "Appearance".
    const dashboard = await getSettingsDashboard(page)
    assert.ok(dashboard, 'haxcms-site-settings-dashboard rendered')
    const clickAppearance = await clickDashboardButton(
      dashboard,
      selectors.siteSettings.dashboardButtons.appearance,
    )
    assert.ok(clickAppearance && clickAppearance.clicked, 'Appearance dashboard button clicked')
    await new Promise((r) => setTimeout(r, 3000))

    // 5. Get the Appearance sub-panel dialog.
    const dialog = await getSubPanelDialog(
      page,
      selectors.siteSettings.appearanceDialog,
    )
    assert.ok(dialog, 'haxcms-appearance-admin-dialog rendered')
    if (dashboard) {
      await dashboard.dispose()
    }

    // 6. Read current theme + list available themes.
    const themeRadioName = 'manifest-metadata-theme-element'
    const currentTheme = await readDialogRadio(dialog, themeRadioName)
    t.diagnostic('[e2e] current theme: ' + currentTheme)
    const allThemes = await listDialogRadioValues(dialog, themeRadioName)
    t.diagnostic('[e2e] available themes: ' + allThemes.join(', '))
    assert.ok(allThemes && allThemes.length > 1, 'multiple themes available in the picker')

    // Pick a different theme (prefer clean-two, fallback to first non-current).
    let newTheme = null
    for (let i = 0; i < allThemes.length; i++) {
      if (allThemes[i] !== currentTheme) {
        newTheme = allThemes[i]
        break
      }
    }
    assert.ok(newTheme, 'found a different theme to select')
    t.diagnostic('[e2e] selecting new theme: ' + newTheme)

    // 7. Select the new theme radio.
    const radioResult = await setDialogRadio(dialog, themeRadioName, newTheme)
    assert.ok(radioResult && radioResult.ok, 'theme radio set: ' + JSON.stringify(radioResult))

    // 8. Visual baseline: Appearance panel before save.
    const appearanceBuf = await captureScreenshot(page, 'site-theme-appearance-panel')
    const appearanceDiff = await safeCompareBaseline('site-theme-appearance-panel', appearanceBuf, null, t)
    t.diagnostic(
      '[visual] site-theme-appearance-panel: diffPercent=' +
        (appearanceDiff.diffPercent * 100).toFixed(3) +
        '% baselineExists=' + appearanceDiff.baselineExists,
    )

    // 9. Click Save + intercept PATCH /x/api/v1/site/appearance.
    const saveResult = await clickDialogSave(dialog)
    assert.ok(saveResult && saveResult.clicked, 'Save button clicked: ' + JSON.stringify(saveResult))

    const patchResp = await settingsWatcher.waitForPatch('/x/api/v1/site/appearance', 30000)
    assert.ok(patchResp, 'PATCH /x/api/v1/site/appearance response captured')
    t.diagnostic('[e2e] saveAppearance response: ' + patchResp.method + ' ' + patchResp.url + ' ' + patchResp.status)
    assert.equal(
      patchResp.status,
      200,
      'saveAppearanceSettings (PATCH /x/api/v1/site/appearance) should return 200, got ' +
        patchResp.status + ' body: ' + String(patchResp.bodyText || '').slice(0, 200),
    )

    // 10. Disk cross-check: read site.json + verify theme element changed.
    const siteJsonPath = path.join(
      runtime.runtimeRoot,
      SITES_DIR,
      EXPECTED_SITE_NAME,
      'site.json',
    )
    assert.ok(fs.pathExistsSync(siteJsonPath), 'site.json exists on disk')
    const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
    const savedThemeElement =
      siteJson.metadata &&
      siteJson.metadata.theme &&
      siteJson.metadata.theme.element
        ? siteJson.metadata.theme.element
        : null
    t.diagnostic('[e2e] site.json theme.element: ' + savedThemeElement)
    assert.equal(
      savedThemeElement,
      newTheme,
      'site.json metadata.theme.element should match the newly selected theme',
    )

    // 11. API cross-check: GET /x/api/v1/themes/active should reflect the new theme.
    const siteApiBase = runtime.baseUrl + '/_sites/' + EXPECTED_SITE_NAME + '/x/api/v1'
    let activeThemeResp = null
    try {
      activeThemeResp = await axios({
        method: 'GET',
        url: siteApiBase + '/themes/active',
        headers: {
          Authorization: 'Bearer ' + runtime.jwt,
          accept: 'application/json',
        },
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
      })
    } catch (e) {
      t.diagnostic('[e2e] GET /themes/active failed: ' + (e && e.message ? e.message : e))
    }
    if (activeThemeResp) {
      t.diagnostic('[e2e] GET /themes/active status: ' + activeThemeResp.status)
      assert.equal(activeThemeResp.status, 200, 'GET /themes/active should return 200')
      let activeThemeBody = null
      try {
        activeThemeBody = JSON.parse(activeThemeResp.data)
      } catch (e) {
        activeThemeBody = null
      }
      if (activeThemeBody && activeThemeBody.data) {
        const activeMachineName = activeThemeBody.data.machineName || activeThemeBody.data.element
        t.diagnostic('[e2e] active theme from API: ' + activeMachineName)
        assert.equal(
          activeMachineName,
          newTheme,
          'GET /themes/active should reflect the newly selected theme',
        )
      }
    }

    // 12. A11y: axe scoped to the appearance dialog host.
    let a11y = null
    try {
      a11y = await runA11y(page, selectors.siteSettings.appearanceDialog)
    } catch (e) {
      t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
    }
    if (a11y) {
      const critical = a11y.critical || []
      const serious = a11y.serious || []
      t.diagnostic(
        '[a11y] ' + selectors.siteSettings.appearanceDialog + ': critical=' +
          critical.length + ' serious=' + serious.length,
      )
      for (let i = 0; i < critical.length; i++) {
        t.diagnostic('[a11y] CRITICAL: ' + critical[i].id + ' — ' + (critical[i].help || ''))
      }
      for (let i = 0; i < serious.length; i++) {
        t.diagnostic('[a11y] SERIOUS: ' + serious[i].id + ' — ' + (serious[i].help || ''))
      }
    } else {
      t.diagnostic('[a11y] could not run scoped axe (non-fatal)')
    }

    if (dialog) {
      await dialog.dispose()
    }
  },
)
