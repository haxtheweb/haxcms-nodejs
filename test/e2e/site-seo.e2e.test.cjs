'use strict'

// E2E test: site SEO settings — edit description + author via the settings
// modal (#manifestbtn → SEO panel → haxcms-seo-admin-dialog).
//
// Flow: boot isolated runtime → login → create site → navigate to editor →
// click #manifestbtn → click "SEO" dashboard-action button →
// haxcms-seo-admin-dialog opens → set a new description in
// input[name="manifest-description"] + a new author name → click Save →
// intercept PATCH /x/api/v1/site/seo (saveSeoSettings) → assert 200 →
// disk cross-check (site.json description + author updated) → visual + a11y.
//
// Constraints: CommonJS, globalThis, NO optional chaining, node:test +
// node:assert/strict, visual diffs WARN, no src/build/node_modules edits.

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

// --- settings-specific local helpers ---

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
  'site SEO settings — edit description + author + save',
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

    // 4. Get dashboard + click "SEO".
    const dashboard = await getSettingsDashboard(page)
    assert.ok(dashboard, 'haxcms-site-settings-dashboard rendered')
    const clickSeo = await clickDashboardButton(
      dashboard,
      selectors.siteSettings.dashboardButtons.seo,
    )
    assert.ok(clickSeo && clickSeo.clicked, 'SEO dashboard button clicked')
    await new Promise((r) => setTimeout(r, 3000))

    // 5. Get the SEO sub-panel dialog.
    const dialog = await getSubPanelDialog(
      page,
      selectors.siteSettings.seoDialog,
    )
    assert.ok(dialog, 'haxcms-seo-admin-dialog rendered')
    if (dashboard) {
      await dashboard.dispose()
    }

    // 6. Read current description + set a new one.
    const currentDesc = await readDialogField(
      dialog,
      selectors.siteSettings.seoDescriptionInput,
    )
    t.diagnostic('[e2e] current SEO description: ' + currentDesc)
    const newDesc = 'E2E automated SEO description ' + Date.now()
    const descResult = await setDialogField(
      dialog,
      selectors.siteSettings.seoDescriptionInput,
      newDesc,
    )
    assert.ok(descResult && descResult.ok, 'description field set: ' + JSON.stringify(descResult))

    // 7. Set a new author name (exercises the author section of the SEO panel).
    const newAuthorName = 'E2E Test Author'
    const authorResult = await setDialogField(
      dialog,
      selectors.siteSettings.seoAuthorNameInput,
      newAuthorName,
    )
    t.diagnostic('[e2e] author name set: ' + JSON.stringify(authorResult))

    // 8. Visual baseline: SEO panel before save.
    const seoBuf = await captureScreenshot(page, 'site-seo-panel')
    const seoDiff = await safeCompareBaseline('site-seo-panel', seoBuf, null, t)
    t.diagnostic(
      '[visual] site-seo-panel: diffPercent=' +
        (seoDiff.diffPercent * 100).toFixed(3) +
        '% baselineExists=' + seoDiff.baselineExists,
    )

    // 9. Click Save + intercept PATCH /x/api/v1/site/seo.
    const saveResult = await clickDialogSave(dialog)
    assert.ok(saveResult && saveResult.clicked, 'Save button clicked: ' + JSON.stringify(saveResult))

    const patchResp = await settingsWatcher.waitForPatch('/x/api/v1/site/seo', 30000)
    assert.ok(patchResp, 'PATCH /x/api/v1/site/seo response captured')
    t.diagnostic('[e2e] saveSeo response: ' + patchResp.method + ' ' + patchResp.url + ' ' + patchResp.status)
    assert.equal(
      patchResp.status,
      200,
      'saveSeoSettings (PATCH /x/api/v1/site/seo) should return 200, got ' +
        patchResp.status + ' body: ' + String(patchResp.bodyText || '').slice(0, 200),
    )

    // 10. Disk cross-check: read site.json + verify description + author updated.
    const siteJsonPath = path.join(
      runtime.runtimeRoot,
      SITES_DIR,
      EXPECTED_SITE_NAME,
      'site.json',
    )
    assert.ok(fs.pathExistsSync(siteJsonPath), 'site.json exists on disk')
    const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
    t.diagnostic('[e2e] site.json description: ' + siteJson.description)
    assert.equal(
      siteJson.description,
      newDesc,
      'site.json description should match the new value set via the SEO panel',
    )
    // Verify author name if it was set successfully.
    if (authorResult && authorResult.ok) {
      const savedAuthorName =
        siteJson.metadata &&
        siteJson.metadata.author &&
        siteJson.metadata.author.name
          ? siteJson.metadata.author.name
          : null
      t.diagnostic('[e2e] site.json author.name: ' + savedAuthorName)
      assert.equal(
        savedAuthorName,
        newAuthorName,
        'site.json metadata.author.name should match the new author name',
      )
    }

    // 11. A11y: axe scoped to the SEO dialog host.
    let a11y = null
    try {
      a11y = await runA11y(page, selectors.siteSettings.seoDialog)
    } catch (e) {
      t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
    }
    if (a11y) {
      const critical = a11y.critical || []
      const serious = a11y.serious || []
      t.diagnostic(
        '[a11y] ' + selectors.siteSettings.seoDialog + ': critical=' +
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
