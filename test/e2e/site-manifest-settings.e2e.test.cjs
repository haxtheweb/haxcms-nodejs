'use strict'

// E2E test: site manifest (Details) settings — edit title + save via the
// settings modal (#manifestbtn → Details panel → haxcms-site-details-dialog).
//
// Flow: boot isolated runtime (JWT auth ENABLED) → login via two-step modal →
// create HAXSITEAUTOMATEDTESTING → navigate into the site editor → wait for
// #manifestbtn enabled → click it to open the settings dashboard → click the
// "Details" dashboard-action button → haxcms-site-details-dialog opens → read
// the current title, set a new title in input[name="manifest-title"] → click
// Save (button.action text="Save") → intercept PATCH /x/api/v1/site
// (saveManifest scoped details payload) → assert 200 → disk cross-check
// (site.json title updated) → visual baseline + a11y scan.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to src/build/
// node_modules/helpers (selectors.cjs only appended, never modified existing).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')

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
  // flows helpers
  waitFor,
  loginViaUI,
  createSiteViaUI,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  clickEditorButtonById,
  safeCompareBaseline,
  summariseViolations,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'

// --- settings-specific local helpers ---

// Response watcher that captures the HTTP method (via response.request().method())
// so we can distinguish PATCH settings saves from GET site-summary reads that
// share the /x/api/v1/site URL prefix.
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

// Get the haxcms-site-settings-dashboard element handle (light-DOM child of
// the opened simple-modal). Returns an element handle or null.
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

// Click a dashboard-action button by text within the dashboard shadowRoot.
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

// Get a sub-panel dialog element handle (light-DOM child of simple-modal).
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

// Set an input/select value inside a dialog shadowRoot by CSS selector.
// Uses recursive shadow walk to pierce simple-fields-field shadowRoots.
async function setDialogField(dialogHandle, selector, value) {
  return dialogHandle.evaluate((el, sel, val) => {
    if (!el || !el.shadowRoot) {
      return { error: 'no shadowRoot' }
    }
    function findInShadowRoot(root, s) {
      if (!root) return null
      var f = root.querySelector(s)
      if (f) return f
      var a = root.querySelectorAll('*')
      for (var i = 0; i < a.length; i++) {
        if (a[i].shadowRoot) {
          var inner = findInShadowRoot(a[i].shadowRoot, s)
          if (inner) return inner
        }
      }
      return null
    }
    var input = findInShadowRoot(el.shadowRoot, sel)
    if (!input) {
      return { error: 'field not found: ' + sel }
    }
    input.focus()
    input.value = val
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: input.value }
  }, selector, value)
}

// Read an input/select value inside a dialog shadowRoot by CSS selector.
// Uses recursive shadow walk to pierce simple-fields-field shadowRoots.
async function readDialogField(dialogHandle, selector) {
  return dialogHandle.evaluate((el, sel) => {
    if (!el || !el.shadowRoot) {
      return null
    }
    function findInShadowRoot(root, s) {
      if (!root) return null
      var f = root.querySelector(s)
      if (f) return f
      var a = root.querySelectorAll('*')
      for (var i = 0; i < a.length; i++) {
        if (a[i].shadowRoot) {
          var inner = findInShadowRoot(a[i].shadowRoot, s)
          if (inner) return inner
        }
      }
      return null
    }
    var input = findInShadowRoot(el.shadowRoot, sel)
    if (!input) {
      return null
    }
    return input.value
  }, selector)
}

// Click the Save button (button.action with text "Save") in the dialog shadowRoot.
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

// --- setup / teardown ---

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
  'site manifest (Details) settings — edit title + save',
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

    // 3. Wait for #manifestbtn enabled, then click it to open settings.
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

    // 4. Get the settings dashboard + click "Details".
    const dashboard = await getSettingsDashboard(page)
    assert.ok(dashboard, 'haxcms-site-settings-dashboard rendered in simple-modal')
    const clickDetails = await clickDashboardButton(
      dashboard,
      selectors.siteSettings.dashboardButtons.details,
    )
    assert.ok(clickDetails && clickDetails.clicked, 'Details dashboard button clicked')
    await new Promise((r) => setTimeout(r, 3000))

    // 5. Get the Details sub-panel dialog.
    const dialog = await getSubPanelDialog(
      page,
      selectors.siteSettings.detailsDialog,
    )
    assert.ok(dialog, 'haxcms-site-details-dialog rendered after clicking Details')
    if (dashboard) {
      await dashboard.dispose()
    }

    // 6. Read the current title + set a new one.
    const currentTitle = await readDialogField(
      dialog,
      selectors.siteSettings.detailsTitleInput,
    )
    t.diagnostic('[e2e] current manifest title: ' + currentTitle)
    const newTitle = 'E2E Automated Title ' + Date.now()
    const setResult = await setDialogField(
      dialog,
      selectors.siteSettings.detailsTitleInput,
      newTitle,
    )
    assert.ok(setResult && setResult.ok, 'title field set: ' + JSON.stringify(setResult))
    t.diagnostic('[e2e] new title set: ' + newTitle)

    // 7. Visual baseline: Details panel before save.
    const detailsBuf = await captureScreenshot(page, 'site-manifest-settings-details')
    const detailsDiff = await safeCompareBaseline('site-manifest-settings-details', detailsBuf, null, t)
    t.diagnostic(
      '[visual] site-manifest-settings-details: diffPercent=' +
        (detailsDiff.diffPercent * 100).toFixed(3) +
        '% baselineExists=' + detailsDiff.baselineExists,
    )

    // 8. Click Save + intercept PATCH /x/api/v1/site.
    const saveResult = await clickDialogSave(dialog)
    assert.ok(saveResult && saveResult.clicked, 'Save button clicked: ' + JSON.stringify(saveResult))

    // Wait for the PATCH response. The scoped details payload goes to
    // /x/api/v1/site (saveManifest). We filter by method=PATCH to distinguish
    // from any GET /x/api/v1/site (siteSummary) reads.
    const patchResp = await settingsWatcher.waitForPatch('/x/api/v1/site', 30000)
    assert.ok(patchResp, 'PATCH /x/api/v1/site response captured')
    t.diagnostic('[e2e] saveManifest response: ' + patchResp.method + ' ' + patchResp.url + ' ' + patchResp.status)
    assert.equal(
      patchResp.status,
      200,
      'saveManifest (PATCH /x/api/v1/site) should return 200, got ' +
        patchResp.status + ' body: ' + String(patchResp.bodyText || '').slice(0, 200),
    )

    // 9. Disk cross-check: read site.json + verify title updated.
    const siteJsonPath = path.join(
      runtime.runtimeRoot,
      SITES_DIR,
      EXPECTED_SITE_NAME,
      'site.json',
    )
    t.diagnostic('[e2e] reading site.json: ' + siteJsonPath)
    assert.ok(fs.pathExistsSync(siteJsonPath), 'site.json exists on disk')
    const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
    t.diagnostic('[e2e] site.json title: ' + siteJson.title)
    assert.equal(
      siteJson.title,
      newTitle,
      'site.json title should match the new title set via the Details panel',
    )

    // 10. A11y: axe scoped to the dialog host (light-DOM child of simple-modal).
    let a11y = null
    try {
      a11y = await runA11y(page, selectors.siteSettings.detailsDialog)
    } catch (e) {
      t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
    }
    if (a11y) {
      const critical = a11y.critical || []
      const serious = a11y.serious || []
      t.diagnostic(
        '[a11y] ' + selectors.siteSettings.detailsDialog + ': critical=' +
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
