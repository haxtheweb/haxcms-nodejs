'use strict'

// E2E test: site blocks + editor settings — change audience + toggle a block
// via the settings modal (#manifestbtn → Editor/Blocks panels).
//
// Flow: boot isolated runtime → login → create site → navigate to editor →
// click #manifestbtn → click "Editor" dashboard-action button →
// haxcms-editor-settings-dialog-ui opens → change audience select to "novice" →
// click Save → intercept PATCH /x/api/v1/site/editor (saveEditorSettings) →
// assert 200 → re-open settings → click "Blocks" dashboard-action button →
// haxcms-allowed-blocks-ui opens → toggle a block checkbox → click Save →
// intercept PATCH /x/api/v1/site/blocks (saveAllowedBlocks) → assert 200 →
// disk cross-check (site.json metadata.platform.audience + allowedBlocks) →
// visual + a11y.
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
// (The saveAllowedBlocks.js source bug — ensureSiteMetadataContainers called
// but not imported — is now fixed in src/, so the rejection-suppression
// workaround that used to live here is no longer needed.)

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

// Request watcher that captures PATCH requests (including ones where the server
// crashes before sending a response). Used to confirm the UI fired the save
// request even when the server-side handler has a bug that prevents a response.
function createSettingsRequestWatcher(page) {
  const requests = []
  const handler = (request) => {
    const url = request.url()
    if (url.indexOf('/x/api/v1/site') === -1) {
      return
    }
    let method = 'GET'
    try {
      method = request.method()
    } catch (e) {
      method = 'GET'
    }
    let postData = ''
    try {
      postData = request.postData() || ''
    } catch (e) {
      postData = ''
    }
    requests.push({ url: url, method: method, postData: postData })
  }
  page.on('request', handler)
  return {
    waitForPatchRequest: (urlPath, timeoutMs) =>
      new Promise((resolve) => {
        const deadline = Date.now() + (timeoutMs || 15000)
        const poll = () => {
          for (let i = 0; i < requests.length; i++) {
            if (
              requests[i].method.toUpperCase() === 'PATCH' &&
              requests[i].url.indexOf(urlPath) !== -1
            ) {
              return resolve(requests[i])
            }
          }
          if (Date.now() >= deadline) {
            return resolve(null)
          }
          setTimeout(poll, 200)
        }
        poll()
      }),
    detach: () => page.off('request', handler),
    getAll: () => requests.slice(),
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

// Set a select value inside a dialog shadowRoot by CSS selector.
// Uses recursive shadow walk to pierce simple-fields-field shadowRoots.
async function setDialogSelect(dialogHandle, selector, value) {
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
    var select = findInShadowRoot(el.shadowRoot, sel)
    if (!select) {
      return { error: 'select not found: ' + sel }
    }
    select.focus()
    select.value = val
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: select.value }
  }, selector, value)
}

// Read a select value inside a dialog shadowRoot.
// Uses recursive shadow walk to pierce simple-fields-field shadowRoots.
async function readDialogSelect(dialogHandle, selector) {
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
    var select = findInShadowRoot(el.shadowRoot, sel)
    if (!select) {
      return null
    }
    return select.value
  }, selector)
}

// Toggle a checkbox by id inside a dialog shadowRoot. Returns the new checked state.
// Uses recursive shadow walk to find the checkbox even if nested.
async function toggleDialogCheckbox(dialogHandle, checkboxId) {
  return dialogHandle.evaluate((el, cbId) => {
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
    var cb = findInShadowRoot(el.shadowRoot, '#' + cbId)
    if (!cb) {
      return { error: 'checkbox not found: ' + cbId }
    }
    cb.checked = !cb.checked
    cb.dispatchEvent(new Event('input', { bubbles: true }))
    cb.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, checked: cb.checked }
  }, checkboxId)
}

// Read a checkbox state by id inside a dialog shadowRoot.
// Uses recursive shadow walk to find the checkbox even if nested.
async function readDialogCheckbox(dialogHandle, checkboxId) {
  return dialogHandle.evaluate((el, cbId) => {
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
    var cb = findInShadowRoot(el.shadowRoot, '#' + cbId)
    if (!cb) {
      return null
    }
    return cb.checked
  }, checkboxId)
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
let requestWatcher = null

test.before(async () => {
  runtime = await setupE2ERuntime()
  patchHaxcmsRootForHarness(runtime)
  browser = await launchBrowser()
  page = await newPage(browser)
  collector = createResponseCollector(page)
  settingsWatcher = createSettingsResponseWatcher(page)
  requestWatcher = createSettingsRequestWatcher(page)
}, { timeout: 120000 })

test.after(async () => {
  if (requestWatcher) {
    try { requestWatcher.detach() } catch (e) { /* ignore */ }
  }
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
  'site blocks + editor settings — change audience + toggle block + save',
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

    // ====================================================================
    // PHASE 1: Editor settings (audience select)
    // ====================================================================

    await clickEditorButtonById(page, '#manifestbtn')
    await new Promise((r) => setTimeout(r, 3000))

    let dashboard = await getSettingsDashboard(page)
    assert.ok(dashboard, 'haxcms-site-settings-dashboard rendered (phase 1)')
    const clickEditor = await clickDashboardButton(
      dashboard,
      selectors.siteSettings.dashboardButtons.editor,
    )
    assert.ok(clickEditor && clickEditor.clicked, 'Editor dashboard button clicked')
    await new Promise((r) => setTimeout(r, 3000))

    let editorDialog = await getSubPanelDialog(
      page,
      selectors.siteSettings.editorDialog,
    )
    assert.ok(editorDialog, 'haxcms-editor-settings-dialog-ui rendered')
    if (dashboard) {
      await dashboard.dispose()
    }

    // Read current audience + change it.
    const currentAudience = await readDialogSelect(
      editorDialog,
      selectors.siteSettings.editorAudienceSelect,
    )
    t.diagnostic('[e2e] current audience: ' + currentAudience)
    // Toggle: if expert → novice, if novice → expert
    const newAudience = currentAudience === 'expert' ? 'novice' : 'expert'
    const audienceResult = await setDialogSelect(
      editorDialog,
      selectors.siteSettings.editorAudienceSelect,
      newAudience,
    )
    assert.ok(audienceResult && audienceResult.ok, 'audience select set: ' + JSON.stringify(audienceResult))
    t.diagnostic('[e2e] new audience: ' + newAudience)

    // Visual baseline: Editor panel before save.
    const editorBuf = await captureScreenshot(page, 'site-blocks-editor-settings-editor')
    const editorDiff = await safeCompareBaseline('site-blocks-editor-settings-editor', editorBuf, null, t)
    t.diagnostic(
      '[visual] editor panel: diffPercent=' +
        (editorDiff.diffPercent * 100).toFixed(3) +
        '% baselineExists=' + editorDiff.baselineExists,
    )

    // Click Save + intercept PATCH /x/api/v1/site/editor.
    const editorSaveResult = await clickDialogSave(editorDialog)
    assert.ok(editorSaveResult && editorSaveResult.clicked, 'Editor Save clicked')
    const editorPatchResp = await settingsWatcher.waitForPatch('/x/api/v1/site/editor', 30000)
    assert.ok(editorPatchResp, 'PATCH /x/api/v1/site/editor response captured')
    t.diagnostic('[e2e] saveEditor response: ' + editorPatchResp.method + ' ' + editorPatchResp.url + ' ' + editorPatchResp.status)
    assert.equal(
      editorPatchResp.status,
      200,
      'saveEditorSettings (PATCH /x/api/v1/site/editor) should return 200, got ' +
        editorPatchResp.status + ' body: ' + String(editorPatchResp.bodyText || '').slice(0, 200),
    )

    if (editorDialog) {
      await editorDialog.dispose()
    }

    // Wait for the modal to close after save, then re-open for Blocks phase.
    await new Promise((r) => setTimeout(r, 3000))

    // ====================================================================
    // PHASE 2: Blocks settings (allowed-blocks checkbox toggle)
    // ====================================================================

    // Re-open the settings modal.
    await clickEditorButtonById(page, '#manifestbtn')
    await new Promise((r) => setTimeout(r, 3000))

    dashboard = await getSettingsDashboard(page)
    assert.ok(dashboard, 'haxcms-site-settings-dashboard rendered (phase 2)')
    const clickBlocks = await clickDashboardButton(
      dashboard,
      selectors.siteSettings.dashboardButtons.blocks,
    )
    assert.ok(clickBlocks && clickBlocks.clicked, 'Blocks dashboard button clicked')
    await new Promise((r) => setTimeout(r, 3000))

    let blocksDialog = await getSubPanelDialog(
      page,
      selectors.siteSettings.blocksDialog,
    )
    assert.ok(blocksDialog, 'haxcms-allowed-blocks-ui rendered')
    if (dashboard) {
      await dashboard.dispose()
    }

    // Read the current state of the 'img' block checkbox + toggle it.
    // The checkbox id is 'allowed-block-img' (a basic HTML tag we know exists).
    const imgCheckboxId = selectors.siteSettings.blocksCheckboxPrefix + 'img'
    const imgBefore = await readDialogCheckbox(blocksDialog, imgCheckboxId)
    t.diagnostic('[e2e] allowed-block-img before toggle: ' + imgBefore)
    const toggleResult = await toggleDialogCheckbox(blocksDialog, imgCheckboxId)
    assert.ok(toggleResult && toggleResult.ok, 'img checkbox toggled: ' + JSON.stringify(toggleResult))
    t.diagnostic('[e2e] allowed-block-img after toggle: ' + (toggleResult && toggleResult.checked))

    // Visual baseline: Blocks panel before save.
    const blocksBuf = await captureScreenshot(page, 'site-blocks-editor-settings-blocks')
    const blocksDiff = await safeCompareBaseline('site-blocks-editor-settings-blocks', blocksBuf, null, t)
    t.diagnostic(
      '[visual] blocks panel: diffPercent=' +
        (blocksDiff.diffPercent * 100).toFixed(3) +
        '% baselineExists=' + blocksDiff.baselineExists,
    )

    // Click Save + intercept PATCH /x/api/v1/site/blocks.
    // (saveAllowedBlocks.js previously had a source bug — ensureSiteMetadataContainers
    // was called but not imported, causing a ReferenceError that prevented a 200.
    // That bug is now fixed in src/, so we hard-assert the 200 + the request fires.)
    const blocksSaveResult = await clickDialogSave(blocksDialog)
    assert.ok(blocksSaveResult && blocksSaveResult.clicked, 'Blocks Save clicked')

    // Confirm the PATCH request was fired by the UI (request watcher).
    const blocksPatchReq = await requestWatcher.waitForPatchRequest('/x/api/v1/site/blocks', 15000)
    assert.ok(
      blocksPatchReq,
      'PATCH /x/api/v1/site/blocks REQUEST fired by the UI (Save button click)',
    )
    t.diagnostic('[e2e] saveBlocks REQUEST: ' + blocksPatchReq.method + ' ' + blocksPatchReq.url)

    // Assert the PATCH response is 200 (was non-fatal while the source bug existed).
    const blocksPatchResp = await settingsWatcher.waitForPatch('/x/api/v1/site/blocks', 15000)
    assert.ok(blocksPatchResp, 'PATCH /x/api/v1/site/blocks response captured')
    t.diagnostic('[e2e] saveBlocks response: ' + blocksPatchResp.method + ' ' + blocksPatchResp.url + ' ' + blocksPatchResp.status)
    assert.equal(
      blocksPatchResp.status,
      200,
      'saveAllowedBlocks (PATCH /x/api/v1/site/blocks) should return 200, got ' +
        blocksPatchResp.status + ' body: ' + String(blocksPatchResp.bodyText || '').slice(0, 200),
    )

    // ====================================================================
    // Disk cross-check: read site.json + verify audience + allowedBlocks.
    // ====================================================================

    const siteJsonPath = path.join(
      runtime.runtimeRoot,
      SITES_DIR,
      EXPECTED_SITE_NAME,
      'site.json',
    )
    assert.ok(fs.pathExistsSync(siteJsonPath), 'site.json exists on disk')
    const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
    const platform =
      siteJson.metadata && siteJson.metadata.platform ? siteJson.metadata.platform : null

    // Verify audience.
    const savedAudience = platform ? platform.audience : null
    t.diagnostic('[e2e] site.json platform.audience: ' + savedAudience)
    assert.equal(
      savedAudience,
      newAudience,
      'site.json metadata.platform.audience should match the new audience',
    )

    // Verify allowedBlocks persisted to site.json (hard-assert now that the
    // saveAllowedBlocks source bug is fixed and the PATCH returned 200).
    const savedAllowedBlocks = platform ? platform.allowedBlocks : null
    t.diagnostic('[e2e] site.json platform.allowedBlocks: ' + JSON.stringify(savedAllowedBlocks))
    if (toggleResult && toggleResult.checked === true) {
      assert.ok(
        Array.isArray(savedAllowedBlocks) && savedAllowedBlocks.indexOf('img') !== -1,
        'img should be in allowedBlocks after toggling it ON',
      )
    } else if (toggleResult && toggleResult.checked === false) {
      assert.ok(
        !Array.isArray(savedAllowedBlocks) || savedAllowedBlocks.indexOf('img') === -1,
        'img should NOT be in allowedBlocks after toggling it OFF',
      )
    }

    // ====================================================================
    // A11y: axe scoped to the blocks dialog host.
    // ====================================================================

    let a11y = null
    try {
      a11y = await runA11y(page, selectors.siteSettings.blocksDialog)
    } catch (e) {
      t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
    }
    if (a11y) {
      const critical = a11y.critical || []
      const serious = a11y.serious || []
      t.diagnostic(
        '[a11y] ' + selectors.siteSettings.blocksDialog + ': critical=' +
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

    if (blocksDialog) {
      await blocksDialog.dispose()
    }
  },
)
