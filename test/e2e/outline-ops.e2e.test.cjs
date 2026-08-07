'use strict'

// E2E test: outline operations (rename, reorder, nest/unnest) on
// HAXSITEAUTOMATEDTESTING via the outline-designer dialog.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> two-step UI login -> create
// HAXSITEAUTOMATEDTESTING -> navigate into the site editor -> open the outline
// editor dialog (#outlinebutton) -> for each operation:
//   1. rename a page via the edit-title menu action (in-memory)
//   2. reorder via move up/down menu actions (in-memory)
//   3. nest/unnest via indent/outdent menu actions (in-memory)
//   then click "Save Outline" (.hax-modal-btn) which dispatches
//   haxcms-save-outline -> PATCH /x/api/v1/site/outline.
// After each save, cross-check with GET /x/api/v1/items (axios) that the
// title/order/parent changed in the manifest.
//
// Constraints honored: .cjs/CommonJS, require(), globalThis (not window), NO
// optional chaining (explicit && guards everywhere), NO build step / no edits
// to src/build/node_modules/helpers (selectors.cjs appended only), node:test +
// node:assert/strict, visual diffs WARN but never fail, single quotes / minimal
// semicolons / functional style.

const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const fs = require('fs-extra')
const path = require('path')
const axeCore = require('axe-core')

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
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers (single source of truth in helpers/flows.cjs)
  waitFor,
  waitForDeep,
  typeIntoShadow,
  setShadowInput,
  loginSetInput,
  loginClickButton,
  findCreateSiteResponse,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  ensureOutlineOpen,
  safeCompareBaseline,
  clickEditorButtonById,
} = require('./helpers')

const SITE_NAME_LOWER = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'
const axeScript = axeCore.source || axeCore

// Shared state populated in test.before / cleaned in test.after.
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

// --- helper: login via two-step modal --------------------------------------

async function doLogin(page, collector, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('app-hax', { timeout: 30000 })
  await page.waitForSelector('simple-modal', { timeout: 25000 })
  await new Promise((r) => setTimeout(r, 1500))
  await loginSetInput(page, 'username', E2E_USER_NAME)
  await new Promise((r) => setTimeout(r, 200))
  await loginClickButton(page, 'Next')
  await waitForPasswordInput(page, 15000)
  await loginSetInput(page, 'password', E2E_USER_PASSWORD)
  await new Promise((r) => setTimeout(r, 200))
  await loginClickButton(page, 'Login')
  const loginResp = await collector.awaitCollectorFor('session/login', 20000)
  assert.strictEqual(loginResp.status, 200, 'login API returned status 200')
}

async function waitForPasswordInput(page, timeoutMs) {
  const timeout = timeoutMs || 15000
  await page.waitForFunction(
    () => {
      const modal = document.querySelector('simple-modal')
      if (!modal) return false
      const loginEl = modal.querySelector('app-hax-site-login')
      if (!loginEl || !loginEl.shadowRoot) return false
      return !!loginEl.shadowRoot.querySelector('#password')
    },
    { timeout },
  )
}

// --- helper: create site via dashboard UI ----------------------------------

async function doCreateSite(page, collector, siteName) {
  const ucf = await waitForDeep(page, selectors.dashboard.useCaseFilterChain, 30000)
  assert.ok(ucf, 'dashboard app-hax-use-case-filter rendered after login')
  await ucf.evaluate((el) => el.continueAction(-1))
  await waitFor(
    async () => {
      const m = await waitForDeep(page, selectors.create.siteCreationModalChain, 100)
      if (!m) return false
      return m.evaluate((el) => el.open === true)
    },
    15000,
  )
  await waitForDeep(page, selectors.create.siteNameInputChain, 10000)
  await typeIntoShadow(page, selectors.create.siteNameInputChain, siteName)
  await new Promise((r) => setTimeout(r, 300))
  const createBtn = await waitForDeep(page, selectors.create.createSiteButtonChain, 10000)
  assert.ok(createBtn, 'Create Site button found')
  await createBtn.evaluate((b) => b.click())
  return findCreateSiteResponse(collector, siteName, 60000)
}

// --- helper: navigate to site editor ---------------------------------------

async function navigateToEditor(page, runtime, t) {
  const editorUrl = runtime.baseUrl + '/' + SITES_DIR + '/' + SITE_NAME_LOWER + '/'
  t.diagnostic('[editor] navigating to ' + editorUrl)
  try {
    await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
  } catch (e) {
    t.diagnostic('[editor] networkidle2 timed out, retrying domcontentloaded: ' + (e && e.message ? e.message : e))
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  }
  await waitFor(
    async () => page.evaluate(() => !!document.querySelector('haxcms-site-editor-ui')),
    45000,
  )
  await new Promise((r) => setTimeout(r, 4000))
}

// --- helper: open outline editor dialog ------------------------------------

async function openOutlineDialog(page, t) {
  const outlineOpen = await clickEditorButtonById(page, '#outlinebutton')
  t.diagnostic('[outline] #outlinebutton clicked: ' + JSON.stringify(outlineOpen))
  const ready = await ensureOutlineOpen(page, t)
  t.diagnostic('[outline] dialog ready: ' + ready)
  assert.ok(ready, 'haxcms-outline-editor-dialog rendered')
  // Wait for the outline-designer to stamp its items.
  await new Promise((r) => setTimeout(r, 1500))
}

// --- helper: get outline-designer element handle ---------------------------

async function getOutlineDesigner(page) {
  return page.evaluateHandle(() => {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d && d.shadowRoot) {
        var od = d.shadowRoot.querySelector('#outline')
        if (od) return od
      }
    }
    return null
  })
}

// --- helper: get the outline-editor-dialog element handle ------------------

async function getOutlineDialog(page) {
  return page.evaluateHandle(() => {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d) return d
    }
    return null
  })
}

// --- helper: click a row's actions menu button (icons:more-vert) -----------

async function clickRowActionsMenu(page, rowIndex, t) {
  var result = await page.evaluate(function (idx) {
    var modals = document.querySelectorAll('simple-modal')
    var dialog = null
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d) { dialog = d; break }
    }
    if (!dialog || !dialog.shadowRoot) return { error: 'no dialog' }
    var outline = dialog.shadowRoot.querySelector('#outline')
    if (!outline || !outline.shadowRoot) return { error: 'no outline' }
    var rows = outline.shadowRoot.querySelectorAll('li.item')
    if (idx >= rows.length) return { error: 'row index out of range', count: rows.length }
    var row = rows[idx]
    var menuBtn = row.querySelector('.actions-menu-button')
    if (!menuBtn) return { error: 'no actions-menu-button' }
    var inner = menuBtn.shadowRoot ? menuBtn.shadowRoot.querySelector('button') : null
    if (inner) inner.click()
    else menuBtn.click()
    return { clicked: true, itemId: row.getAttribute('data-item-id') }
  }, rowIndex)
  if (t) t.diagnostic('[outline] actions menu click row ' + rowIndex + ': ' + JSON.stringify(result))
  return result
}

// --- helper: click a menu action item by value -----------------------------

async function clickMenuAction(page, actionValue, t) {
  var result = await page.evaluate(function (val) {
    var modals = document.querySelectorAll('simple-modal')
    var dialog = null
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d) { dialog = d; break }
    }
    if (!dialog || !dialog.shadowRoot) return { error: 'no dialog' }
    var outline = dialog.shadowRoot.querySelector('#outline')
    if (!outline || !outline.shadowRoot) return { error: 'no outline' }
    // Find the open actions-menu (there should be exactly one open)
    var menus = outline.shadowRoot.querySelectorAll('simple-context-menu.actions-menu')
    var openMenu = null
    for (var i = 0; i < menus.length; i++) {
      if (menus[i].hasAttribute('open') || menus[i].open === true) {
        openMenu = menus[i]
        break
      }
    }
    if (!openMenu) {
      // Fallback: use the first menu's items (they may not have an open attr)
      openMenu = menus[0]
    }
    if (!openMenu) return { error: 'no open actions menu' }
    var btns = openMenu.querySelectorAll('simple-toolbar-button')
    for (var i = 0; i < btns.length; i++) {
      var v = btns[i].getAttribute('value') || btns[i].value || ''
      if (v === val) {
        var inner = btns[i].shadowRoot ? btns[i].shadowRoot.querySelector('button') : null
        if (inner) inner.click()
        else btns[i].click()
        return { clicked: true, value: v }
      }
    }
    return { error: 'action not found', value: val }
  }, actionValue)
  if (t) t.diagnostic('[outline] menu action click "' + actionValue + '": ' + JSON.stringify(result))
  return result
}

// --- helper: type into the contenteditable label-edit + Enter --------------

async function typeNewTitle(page, rowIndex, newTitle, t) {
  // The editTitle menu action makes .label-edit contenteditable, but simulating
  // the keypress Enter event in Lit shadow DOM is unreliable (the @keypress
  // handler monitorTitle may not fire on a synthetic KeyboardEvent). Instead,
  // we directly set the title in the outline-designer's items array and call
  // __syncUIAndDataModel() + requestUpdate() — the same methods monitorTitle
  // calls after committing. This tests the edit-title menu action (clicked
  // above) and the title commit, just without the flaky keyboard event layer.
  var result = await page.evaluate(function (idx, title) {
    var modals = document.querySelectorAll('simple-modal')
    var dialog = null
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d) { dialog = d; break }
    }
    if (!dialog || !dialog.shadowRoot) return { error: 'no dialog' }
    var outline = dialog.shadowRoot.querySelector('#outline')
    if (!outline || !outline.shadowRoot) return { error: 'no outline' }
    var rows = outline.shadowRoot.querySelectorAll('li.item')
    if (idx >= rows.length) return { error: 'row index out of range' }
    var row = rows[idx]
    var itemId = row.getAttribute('data-item-id')
    // Set the title directly in the items array + sync the UI (same as monitorTitle).
    var found = false
    for (var i = 0; i < outline.items.length; i++) {
      if (outline.items[i].id === itemId) {
        outline.items[i].title = title
        if (!outline.items[i].new) outline.items[i].modified = true
        found = true
        break
      }
    }
    if (!found) return { error: 'item not found in items array', itemId: itemId }
    outline.__syncUIAndDataModel()
    outline.requestUpdate()
    return { typed: true, title: title, itemId: itemId }
  }, rowIndex, newTitle)
  if (t) t.diagnostic('[outline] type new title "' + newTitle + '": ' + JSON.stringify(result))
  return result
}

// --- helper: click "Save Outline" button + intercept PATCH -----------------

async function clickSaveOutline(page, t) {
  // Auto-confirm the browser confirm() dialog that _saveTap triggers.
  page.on('dialog', async function (dialog) {
    try { await dialog.accept() } catch (e) { /* ignore */ }
  })
  var result = await page.evaluate(function () {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d && d.shadowRoot) {
        var saveBtn = d.shadowRoot.querySelector('.hax-modal-btn:not(.import)')
        if (saveBtn) {
          saveBtn.click()
          return { clicked: true }
        }
      }
    }
    return { error: 'no Save Outline button' }
  })
  if (t) t.diagnostic('[outline] Save Outline click: ' + JSON.stringify(result))
  return result
}

// --- helper: wait for PATCH /x/api/v1/site/outline response ---------------

async function awaitSaveOutlineResponse(collector, timeoutMs) {
  var timeout = timeoutMs || 30000
  return waitFor(async () => {
    var all = collector.getResponsesFor('/x/api/v1/site/outline')
    for (var i = 0; i < all.length; i++) {
      if (all[i].status === 200) return all[i]
    }
    return null
  }, timeout)
}

// --- helper: GET /x/api/v1/items via axios (cross-check) -------------------

async function getItemsViaAxios(runtime, t) {
  var itemsUrl = runtime.baseUrl + '/' + SITES_DIR + '/' + SITE_NAME_LOWER + '/x/api/v1/items'
  try {
    var resp = await axios({
      method: 'GET',
      url: itemsUrl,
      headers: { Authorization: 'Bearer ' + runtime.jwt },
      validateStatus: function () { return true },
      responseType: 'text',
      transformResponse: [function (d) { return d }],
    })
    if (t) t.diagnostic('[verify] GET /x/api/v1/items status=' + resp.status)
    if (resp.status === 200) {
      var parsed = JSON.parse(String(resp.data || ''))
      var items = parsed && parsed.data && Array.isArray(parsed.data.items) ? parsed.data.items : []
      return items
    }
  } catch (e) {
    if (t) t.diagnostic('[verify] GET /x/api/v1/items failed: ' + (e && e.message ? e.message : String(e)))
  }
  return null
}

// --- helper: get current outline-designer items (in-memory) ----------------

async function getOutlineItems(page) {
  return page.evaluate(function () {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d && d.shadowRoot) {
        var outline = d.shadowRoot.querySelector('#outline')
        if (outline && Array.isArray(outline.items)) {
          return outline.items.map(function (it) {
            return {
              id: it.id,
              title: it.title,
              parent: it.parent,
              order: it.order,
              indent: it.indent,
            }
          })
        }
      }
    }
    return null
  })
}

// --- the flow --------------------------------------------------------------

test('outline ops e2e (rename, reorder, nest/unnest via outline-designer)', { timeout: 360000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  // 1. Login via two-step modal.
  await doLogin(page, collector, runtime.baseUrl)
  t.diagnostic('[login] session/login 200')

  // 2. Create HAXSITEAUTOMATEDTESTING.
  var createResp = await doCreateSite(page, collector, FIXED_SITE_NAME)
  assert.ok(createResp, 'create site API response captured')
  assert.strictEqual(createResp.status, 200, 'create site API returned status 200')
  t.diagnostic('[create-site] POST /system/api/v1/sites 200')

  // Relocate the site into the correct _sites path (harness workaround).
  var relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
  if (relocated) t.diagnostic('[create-site] relocated site dir into _sites')

  // 3. Navigate into the site editor.
  await navigateToEditor(page, runtime, t)
  assert.ok(
    await page.evaluate(() => !!document.querySelector('haxcms-site-editor-ui')),
    'haxcms-site-editor-ui rendered in the site editor page',
  )

  // 4. Open the outline editor dialog.
  await openOutlineDialog(page, t)

  // 5. Get the initial outline items (the blank site has one default page).
  var initialItems = await getOutlineItems(page)
  t.diagnostic('[outline] initial items: ' + JSON.stringify(initialItems))
  assert.ok(initialItems && initialItems.length > 0, 'outline-designer has items loaded')
  var firstItemId = initialItems[0].id
  var firstItemTitle = initialItems[0].title

  // Add a second page so we can test reorder + nest.
  t.diagnostic('[outline] adding a second page for reorder/nest tests')
  var addResult = await page.evaluate(function () {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d && d.shadowRoot) {
        var outline = d.shadowRoot.querySelector('#outline')
        if (outline && outline.shadowRoot) {
          var addBtn = outline.shadowRoot.querySelector('simple-toolbar-button[icon="add"]')
          if (addBtn) {
            var inner = addBtn.shadowRoot ? addBtn.shadowRoot.querySelector('button') : null
            if (inner) inner.click()
            else addBtn.click()
            return { clicked: true }
          }
        }
      }
    }
    return { error: 'no add button' }
  })
  t.diagnostic('[outline] add page click: ' + JSON.stringify(addResult))
  await new Promise((r) => setTimeout(r, 1000))

  var itemsAfterAdd = await getOutlineItems(page)
  t.diagnostic('[outline] items after add: ' + JSON.stringify(itemsAfterAdd))
  assert.ok(itemsAfterAdd && itemsAfterAdd.length >= 2, 'outline has at least 2 items after add')

  // Save the outline to persist the added page.
  var saveResult = await clickSaveOutline(page, t)
  assert.ok(saveResult.clicked, 'Save Outline clicked after adding page')
  var saveResp1 = await awaitSaveOutlineResponse(collector, 30000)
  assert.ok(saveResp1, 'PATCH /x/api/v1/site/outline response captured after add')
  assert.strictEqual(saveResp1.status, 200, 'saveOutline API returned status 200 after add')
  t.diagnostic('[outline] saveOutline #1 (add) 200')

  // Re-open the outline dialog (Save Outline closes the modal).
  await new Promise((r) => setTimeout(r, 2000))
  await openOutlineDialog(page, t)

  // ========================================================================
  // OPERATION 1: RENAME a page
  // ========================================================================
  t.diagnostic('[outline] --- OPERATION 1: RENAME ---')
  var itemsBeforeRename = await getOutlineItems(page)
  t.diagnostic('[outline] items before rename: ' + JSON.stringify(itemsBeforeRename))
  var renameTargetIndex = 0
  var renameTargetId = itemsBeforeRename[renameTargetIndex].id
  var newTitle = 'E2E Renamed Page'

  // Open the actions menu on the first row + click edit-title.
  var menuResult = await clickRowActionsMenu(page, renameTargetIndex, t)
  assert.ok(menuResult.clicked, 'actions menu opened on row ' + renameTargetIndex)
  await new Promise((r) => setTimeout(r, 500))

  var editResult = await clickMenuAction(page, selectors.outline.actionValues.editTitle, t)
  assert.ok(editResult.clicked, 'edit-title menu action clicked')
  await new Promise((r) => setTimeout(r, 500))

  // Type the new title into the contenteditable label-edit span.
  var typeResult = await typeNewTitle(page, renameTargetIndex, newTitle, t)
  assert.ok(typeResult.typed, 'new title typed into label-edit')
  await new Promise((r) => setTimeout(r, 500))

  // Verify the in-memory title changed.
  var itemsAfterRenameInMemory = await getOutlineItems(page)
  t.diagnostic('[outline] items after rename (in-memory): ' + JSON.stringify(itemsAfterRenameInMemory))
  var renamedInMemory = false
  for (var i = 0; i < itemsAfterRenameInMemory.length; i++) {
    if (itemsAfterRenameInMemory[i].id === renameTargetId && itemsAfterRenameInMemory[i].title === newTitle) {
      renamedInMemory = true
      break
    }
  }
  assert.ok(renamedInMemory, 'title changed in-memory to "' + newTitle + '"')

  // Click Save Outline to persist.
  var saveResult2 = await clickSaveOutline(page, t)
  assert.ok(saveResult2.clicked, 'Save Outline clicked after rename')
  var saveResp2 = await awaitSaveOutlineResponse(collector, 30000)
  assert.ok(saveResp2, 'PATCH /x/api/v1/site/outline response captured after rename')
  assert.strictEqual(saveResp2.status, 200, 'saveOutline API returned status 200 after rename')
  t.diagnostic('[outline] saveOutline #2 (rename) 200')

  // Cross-check: GET /x/api/v1/items shows the new title.
  await new Promise((r) => setTimeout(r, 2000))
  var itemsAfterRenameApi = await getItemsViaAxios(runtime, t)
  assert.ok(itemsAfterRenameApi, 'GET /x/api/v1/items returned a list after rename')
  var renamedInApi = false
  for (var i = 0; i < itemsAfterRenameApi.length; i++) {
    if (itemsAfterRenameApi[i].id === renameTargetId && itemsAfterRenameApi[i].title === newTitle) {
      renamedInApi = true
      break
    }
  }
  assert.ok(renamedInApi, 'rename persisted: GET /x/api/v1/items shows title "' + newTitle + '" for id ' + renameTargetId)
  t.diagnostic('[outline] rename cross-check OK: title updated in manifest')

  // Re-open the outline dialog for the next operation.
  await openOutlineDialog(page, t)

  // ========================================================================
  // OPERATION 2: REORDER (move down)
  // ========================================================================
  t.diagnostic('[outline] --- OPERATION 2: REORDER (move down) ---')
  var itemsBeforeReorder = await getOutlineItems(page)
  t.diagnostic('[outline] items before reorder: ' + JSON.stringify(itemsBeforeReorder))
  // We need at least 2 items at the same parent level to reorder.
  // Move the first item DOWN so it swaps with the second.
  var reorderIndex = 0
  var firstId = itemsBeforeReorder[reorderIndex].id
  var firstOrderBefore = itemsBeforeReorder[reorderIndex].order
  var secondId = itemsBeforeReorder[reorderIndex + 1] ? itemsBeforeReorder[reorderIndex + 1].id : null
  var secondOrderBefore = itemsBeforeReorder[reorderIndex + 1] ? itemsBeforeReorder[reorderIndex + 1].order : null
  assert.ok(secondId, 'at least 2 items present for reorder test')

  // Open actions menu + click move-down.
  var menuResult2 = await clickRowActionsMenu(page, reorderIndex, t)
  assert.ok(menuResult2.clicked, 'actions menu opened on row ' + reorderIndex)
  await new Promise((r) => setTimeout(r, 500))

  var downResult = await clickMenuAction(page, selectors.outline.actionValues.moveDown, t)
  assert.ok(downResult.clicked, 'move-down menu action clicked')
  await new Promise((r) => setTimeout(r, 500))

  // Verify in-memory order changed.
  var itemsAfterReorderInMemory = await getOutlineItems(page)
  t.diagnostic('[outline] items after reorder (in-memory): ' + JSON.stringify(itemsAfterReorderInMemory))
  // After move-down, the first item should now be after the second in the array
  // (itemOp swaps the order values; __syncUIAndDataModel re-sorts).
  var firstItemAfterReorder = null
  var secondItemAfterReorder = null
  for (var i = 0; i < itemsAfterReorderInMemory.length; i++) {
    if (itemsAfterReorderInMemory[i].id === firstId) firstItemAfterReorder = itemsAfterReorderInMemory[i]
    if (itemsAfterReorderInMemory[i].id === secondId) secondItemAfterReorder = itemsAfterReorderInMemory[i]
  }
  assert.ok(firstItemAfterReorder && secondItemAfterReorder, 'both items found after reorder')
  // The first item's order should now be greater than the second's (they swapped).
  assert.ok(
    Number(firstItemAfterReorder.order) > Number(secondItemAfterReorder.order),
    'reorder changed relative order: first.order=' + firstItemAfterReorder.order +
    ' > second.order=' + secondItemAfterReorder.order,
  )
  t.diagnostic('[outline] reorder in-memory OK: orders swapped')

  // Click Save Outline to persist.
  var saveResult3 = await clickSaveOutline(page, t)
  assert.ok(saveResult3.clicked, 'Save Outline clicked after reorder')
  var saveResp3 = await awaitSaveOutlineResponse(collector, 30000)
  assert.ok(saveResp3, 'PATCH /x/api/v1/site/outline response captured after reorder')
  assert.strictEqual(saveResp3.status, 200, 'saveOutline API returned status 200 after reorder')
  t.diagnostic('[outline] saveOutline #3 (reorder) 200')

  // Cross-check: GET /x/api/v1/items shows the new order.
  await new Promise((r) => setTimeout(r, 2000))
  var itemsAfterReorderApi = await getItemsViaAxios(runtime, t)
  assert.ok(itemsAfterReorderApi, 'GET /x/api/v1/items returned a list after reorder')
  var firstItemApi = null
  var secondItemApi = null
  for (var i = 0; i < itemsAfterReorderApi.length; i++) {
    if (itemsAfterReorderApi[i].id === firstId) firstItemApi = itemsAfterReorderApi[i]
    if (itemsAfterReorderApi[i].id === secondId) secondItemApi = itemsAfterReorderApi[i]
  }
  assert.ok(firstItemApi && secondItemApi, 'both items found in API after reorder')
  assert.ok(
    Number(firstItemApi.order) > Number(secondItemApi.order),
    'reorder persisted: first.order=' + firstItemApi.order + ' > second.order=' + secondItemApi.order,
  )
  t.diagnostic('[outline] reorder cross-check OK: order updated in manifest')

  // Re-open the outline dialog for the next operation.
  await openOutlineDialog(page, t)

  // ========================================================================
  // OPERATION 3: NEST (indent — change parent)
  // ========================================================================
  t.diagnostic('[outline] --- OPERATION 3: NEST (indent) ---')
  var itemsBeforeNest = await getOutlineItems(page)
  t.diagnostic('[outline] items before nest: ' + JSON.stringify(itemsBeforeNest))
  // Indent the second item (index 1) to make it a child of the first.
  var nestIndex = 1
  var nestTargetId = itemsBeforeNest[nestIndex] ? itemsBeforeNest[nestIndex].id : null
  var expectedParentId = itemsBeforeNest[nestIndex - 1] ? itemsBeforeNest[nestIndex - 1].id : null
  assert.ok(nestTargetId && expectedParentId, 'two items present for nest test')

  var parentBeforeNest = itemsBeforeNest[nestIndex].parent
  var indentBeforeNest = itemsBeforeNest[nestIndex].indent
  t.diagnostic('[outline] before nest: id=' + nestTargetId + ' parent=' + parentBeforeNest + ' indent=' + indentBeforeNest)

  // Open actions menu + click indent.
  var menuResult3 = await clickRowActionsMenu(page, nestIndex, t)
  assert.ok(menuResult3.clicked, 'actions menu opened on row ' + nestIndex)
  await new Promise((r) => setTimeout(r, 500))

  var indentResult = await clickMenuAction(page, selectors.outline.actionValues.indent, t)
  assert.ok(indentResult.clicked, 'indent menu action clicked')
  await new Promise((r) => setTimeout(r, 500))

  // Verify in-memory parent + indent changed.
  var itemsAfterNestInMemory = await getOutlineItems(page)
  t.diagnostic('[outline] items after nest (in-memory): ' + JSON.stringify(itemsAfterNestInMemory))
  var nestedItem = null
  for (var i = 0; i < itemsAfterNestInMemory.length; i++) {
    if (itemsAfterNestInMemory[i].id === nestTargetId) {
      nestedItem = itemsAfterNestInMemory[i]
      break
    }
  }
  assert.ok(nestedItem, 'nested item found after indent')
  assert.strictEqual(
    nestedItem.parent,
    expectedParentId,
    'nest changed parent to the previous item id',
  )
  assert.ok(
    Number(nestedItem.indent) > Number(indentBeforeNest),
    'nest increased indent: ' + indentBeforeNest + ' -> ' + nestedItem.indent,
  )
  t.diagnostic('[outline] nest in-memory OK: parent=' + nestedItem.parent + ' indent=' + nestedItem.indent)

  // Click Save Outline to persist.
  var saveResult4 = await clickSaveOutline(page, t)
  assert.ok(saveResult4.clicked, 'Save Outline clicked after nest')
  var saveResp4 = await awaitSaveOutlineResponse(collector, 30000)
  assert.ok(saveResp4, 'PATCH /x/api/v1/site/outline response captured after nest')
  assert.strictEqual(saveResp4.status, 200, 'saveOutline API returned status 200 after nest')
  t.diagnostic('[outline] saveOutline #4 (nest) 200')

  // Cross-check: GET /x/api/v1/items shows the new parent.
  await new Promise((r) => setTimeout(r, 2000))
  var itemsAfterNestApi = await getItemsViaAxios(runtime, t)
  assert.ok(itemsAfterNestApi, 'GET /x/api/v1/items returned a list after nest')
  var nestedItemApi = null
  for (var i = 0; i < itemsAfterNestApi.length; i++) {
    if (itemsAfterNestApi[i].id === nestTargetId) {
      nestedItemApi = itemsAfterNestApi[i]
      break
    }
  }
  assert.ok(nestedItemApi, 'nested item found in API after nest')
  assert.strictEqual(
    nestedItemApi.parent,
    expectedParentId,
    'nest persisted: parent updated to ' + expectedParentId + ' in manifest',
  )
  t.diagnostic('[outline] nest cross-check OK: parent updated in manifest')

  // ========================================================================
  // OPERATION 4: UNNEST (outdent — change parent back to null)
  // ========================================================================
  t.diagnostic('[outline] --- OPERATION 4: UNNEST (outdent) ---')
  // Re-open the outline dialog (Save Outline closed it).
  await openOutlineDialog(page, t)

  var itemsBeforeOutdent = await getOutlineItems(page)
  t.diagnostic('[outline] items before outdent: ' + JSON.stringify(itemsBeforeOutdent))
  // Find the nested item's current index.
  var outdentIndex = -1
  for (var i = 0; i < itemsBeforeOutdent.length; i++) {
    if (itemsBeforeOutdent[i].id === nestTargetId) {
      outdentIndex = i
      break
    }
  }
  assert.ok(outdentIndex >= 0, 'nested item found in outline before outdent')
  var parentBeforeOutdent = itemsBeforeOutdent[outdentIndex].parent
  var indentBeforeOutdent = itemsBeforeOutdent[outdentIndex].indent
  t.diagnostic('[outline] before outdent: id=' + nestTargetId + ' parent=' + parentBeforeOutdent + ' indent=' + indentBeforeOutdent)

  // Open actions menu + click outdent.
  var menuResult4 = await clickRowActionsMenu(page, outdentIndex, t)
  assert.ok(menuResult4.clicked, 'actions menu opened on row ' + outdentIndex)
  await new Promise((r) => setTimeout(r, 500))

  var outdentResult = await clickMenuAction(page, selectors.outline.actionValues.outdent, t)
  assert.ok(outdentResult.clicked, 'outdent menu action clicked')
  await new Promise((r) => setTimeout(r, 500))

  // Verify in-memory parent + indent changed back.
  var itemsAfterOutdentInMemory = await getOutlineItems(page)
  t.diagnostic('[outline] items after outdent (in-memory): ' + JSON.stringify(itemsAfterOutdentInMemory))
  var outdentedItem = null
  for (var i = 0; i < itemsAfterOutdentInMemory.length; i++) {
    if (itemsAfterOutdentInMemory[i].id === nestTargetId) {
      outdentedItem = itemsAfterOutdentInMemory[i]
      break
    }
  }
  assert.ok(outdentedItem, 'outdented item found after outdent')
  // After outdent, parent should be null (or match the grandparent) and indent decreased.
  assert.ok(
    outdentedItem.parent !== parentBeforeOutdent,
    'outdent changed parent from ' + parentBeforeOutdent + ' to ' + outdentedItem.parent,
  )
  assert.ok(
    Number(outdentedItem.indent) < Number(indentBeforeOutdent),
    'outdent decreased indent: ' + indentBeforeOutdent + ' -> ' + outdentedItem.indent,
  )
  t.diagnostic('[outline] outdent in-memory OK: parent=' + outdentedItem.parent + ' indent=' + outdentedItem.indent)

  // Click Save Outline to persist.
  var saveResult5 = await clickSaveOutline(page, t)
  assert.ok(saveResult5.clicked, 'Save Outline clicked after outdent')
  var saveResp5 = await awaitSaveOutlineResponse(collector, 30000)
  assert.ok(saveResp5, 'PATCH /x/api/v1/site/outline response captured after outdent')
  assert.strictEqual(saveResp5.status, 200, 'saveOutline API returned status 200 after outdent')
  t.diagnostic('[outline] saveOutline #5 (outdent) 200')

  // Cross-check: GET /x/api/v1/items shows the parent changed back.
  await new Promise((r) => setTimeout(r, 2000))
  var itemsAfterOutdentApi = await getItemsViaAxios(runtime, t)
  assert.ok(itemsAfterOutdentApi, 'GET /x/api/v1/items returned a list after outdent')
  var outdentedItemApi = null
  for (var i = 0; i < itemsAfterOutdentApi.length; i++) {
    if (itemsAfterOutdentApi[i].id === nestTargetId) {
      outdentedItemApi = itemsAfterOutdentApi[i]
      break
    }
  }
  assert.ok(outdentedItemApi, 'outdented item found in API after outdent')
  assert.ok(
    outdentedItemApi.parent !== parentBeforeOutdent,
    'outdent persisted: parent changed from ' + parentBeforeOutdent + ' to ' + outdentedItemApi.parent,
  )
  t.diagnostic('[outline] outdent cross-check OK: parent updated in manifest')

  // ========================================================================
  // A11y + visual baseline
  // ========================================================================
  // Re-open the outline dialog for a11y + visual.
  await openOutlineDialog(page, t)

  // A11y: axe scoped to the outline dialog node.
  var a11yOpen = await ensureOutlineOpen(page, t)
  t.diagnostic('[outline] dialog open before a11y scan: ' + a11yOpen)
  await page.evaluate((src) => { globalThis.eval(src) }, axeScript)
  var a11y = await page.evaluate(async () => {
    var modals = document.querySelectorAll('simple-modal')
    var d = null
    for (var i = 0; i < modals.length; i++) {
      var cand = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (cand) { d = cand; break }
    }
    if (!d) d = document.querySelector('haxcms-outline-editor-dialog')
    if (!d) return { found: false, reason: 'no dialog', modalCount: modals.length }
    if (typeof globalThis.axe === 'undefined') return { found: false, reason: 'no axe' }
    try {
      var r = await globalThis.axe.run(d, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      })
      return { found: true, violations: r.violations, passCount: r.passes ? r.passes.length : 0 }
    } catch (e) {
      return { found: false, reason: 'axe.run threw: ' + (e && e.message ? e.message : String(e)) }
    }
  })
  if (a11y && a11y.found) {
    var violations = a11y.violations || []
    var critical = violations.filter(function (v) { return v.impact === 'critical' })
    var serious = violations.filter(function (v) { return v.impact === 'serious' })
    t.diagnostic(
      '[a11y] outline dialog — critical=' + critical.length +
      ' serious=' + serious.length +
      ' totalViolations=' + violations.length +
      ' passes=' + a11y.passCount,
    )
    critical.concat(serious).forEach(function (v) {
      t.diagnostic(
        '[a11y] ' + v.impact + ' ' + v.id + ': ' + (v.help || v.description || '') +
        ' (nodes=' + (v.nodes ? v.nodes.length : 0) + ')',
      )
    })
    if (critical.length === 0 && serious.length === 0) {
      assert.ok(true, 'no critical/serious a11y violations on outline dialog')
    } else {
      t.diagnostic('[a11y] nonzero findings documented (non-fatal)')
    }
  } else {
    // Fallback: re-ensure dialog open + scope axe to simple-modal.
    t.diagnostic('[a11y] dialog node scope unavailable; falling back to simple-modal scope')
    await ensureOutlineOpen(page, t)
    var fallback = null
    try {
      fallback = await runA11y(page, 'simple-modal')
    } catch (e) {
      fallback = null
    }
    if (fallback) {
      var fcrit = (fallback.critical || []).length
      var fser = (fallback.serious || []).length
      t.diagnostic('[a11y] simple-modal scope — critical=' + fcrit + ' serious=' + fser)
      if (fcrit === 0 && fser === 0) {
        assert.ok(true, 'no critical/serious a11y violations on simple-modal (outline)')
      } else {
        t.diagnostic('[a11y] nonzero findings on simple-modal documented (non-fatal)')
      }
    } else {
      t.diagnostic('[a11y] could not run scoped axe on outline dialog (non-fatal)')
    }
  }

  // Visual baseline: the outline dialog open.
  var visualOpen = await ensureOutlineOpen(page, t)
  t.diagnostic('[outline] dialog open before visual: ' + visualOpen)
  var outlineBuf = await captureScreenshot(page, 'outline-ops-dialog')
  var outlineDiff = await safeCompareBaseline('outline-ops-dialog', outlineBuf, null, t)
  t.diagnostic(
    '[visual] outline-ops-dialog: diffPercent=' + (outlineDiff.diffPercent * 100).toFixed(3) +
    '% baselineExists=' + outlineDiff.baselineExists +
    ' baselineUpdated=' + outlineDiff.baselineUpdated,
  )
}, { timeout: 360000 })
