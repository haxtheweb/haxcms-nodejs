'use strict'

// Discovery script for the outline-designer detail controls (dotfile, ignored
// by node --test glob). Boots the E2E harness, logs in, creates
// HAXSITEAUTOMATEDTESTING, navigates to the site editor, opens the outline
// editor dialog (#outlinebutton), and dumps the real shadow-DOM structure of:
//   - outline-designer#outline rows (li.item, data-item-id, .label, .label-edit)
//   - the actions-menu-button (icons:more-vert) + the simple-context-menu actions
//   - the move up/down, indent/outdent, edit-title menu items (value attrs)
//   - the "Add page" top-level control button
//   - the "Save Outline" / "Import From File" buttons
//   - the import hierarchy dialog structure (after dispatching
//     haxcms-docx-import-items with test items to simulate an import result)
//
// Run: node test/e2e/helpers/.discovery-outline.cjs  (from repo root)

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  selectors,
  FIXED_SITE_NAME,
  deepQuery,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  waitFor,
  waitForDeep,
  typeIntoShadow,
  loginSetInput,
  loginClickButton,
  findCreateSiteResponse,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  ensureOutlineOpen,
  clickEditorButtonById,
} = require('./index.cjs')

const SITES_DIR = '_sites'

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

// --- login + create site (reuse flows helpers) ------------------------------

async function loginViaUI(page, collector, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('app-hax', { timeout: 30000 })
  await page.waitForSelector('simple-modal', { timeout: 25000 })
  await new Promise((r) => setTimeout(r, 1500))
  await loginSetInput(page, 'username', E2E_USER_NAME)
  await new Promise((r) => setTimeout(r, 200))
  await loginClickButton(page, 'Next')
  await waitForPasswordInputLocal(page, 15000)
  await loginSetInput(page, 'password', E2E_USER_PASSWORD)
  await new Promise((r) => setTimeout(r, 200))
  await loginClickButton(page, 'Login')
  const loginResp = await collector.awaitCollectorFor('session/login', 20000)
  logJSON('LOGIN API', { status: loginResp.status, url: loginResp.url })
}

async function waitForPasswordInputLocal(page, timeoutMs) {
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

async function createSiteViaUI(page, collector, siteName) {
  const ucf = await waitForDeep(page, selectors.dashboard.useCaseFilterChain, 30000)
  await ucf.evaluate((el) => el.continueAction(-1))
  await waitFor(
    async () => {
      const m = await deepQuery(page, selectors.create.siteCreationModalChain)
      if (!m) return false
      return m.evaluate((el) => el.open === true)
    },
    15000,
  )
  await waitForDeep(page, selectors.create.siteNameInputChain, 10000)
  await typeIntoShadow(page, selectors.create.siteNameInputChain, siteName)
  await new Promise((r) => setTimeout(r, 300))
  const createBtn = await deepQuery(page, selectors.create.createSiteButtonChain)
  await createBtn.evaluate((b) => b.click())
  return findCreateSiteResponse(collector, siteName, 60000)
}

// --- outline-designer dump --------------------------------------------------

async function dumpOutlineDesigner(page) {
  return page.evaluate(() => {
    // Find the outline-editor-dialog (light-DOM child of simple-modal)
    var modals = document.querySelectorAll('simple-modal')
    var dialog = null
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d) { dialog = d; break }
    }
    if (!dialog) dialog = document.querySelector('haxcms-outline-editor-dialog')
    if (!dialog || !dialog.shadowRoot) return { dialogFound: false }

    var info = {
      dialogFound: true,
      dialogHasShadow: !!dialog.shadowRoot,
    }

    // Dump the dialog shadowRoot buttons
    var btns = dialog.shadowRoot.querySelectorAll('.hax-modal-btn')
    info.dialogButtons = []
    for (var i = 0; i < btns.length; i++) {
      info.dialogButtons.push({
        text: (btns[i].textContent || '').trim(),
        classes: btns[i].className,
      })
    }

    // Find outline-designer#outline
    var outline = dialog.shadowRoot.querySelector('#outline')
    if (!outline || !outline.shadowRoot) {
      info.outlineFound = !!outline
      info.outlineHasShadow = !!(outline && outline.shadowRoot)
      return info
    }

    info.outlineFound = true
    info.outlineTag = outline.tagName.toLowerCase()
    info.outlineHasShadow = !!outline.shadowRoot
    info.outlineItemsCount = Array.isArray(outline.items) ? outline.items.length : -1

    // Dump the top-level controls (.controls)
    var controls = outline.shadowRoot.querySelector('.controls')
    if (controls) {
      info.controlsFound = true
      var controlBtns = controls.querySelectorAll('simple-toolbar-button.control')
      info.controlButtons = []
      for (var i = 0; i < controlBtns.length; i++) {
        info.controlButtons.push({
          icon: controlBtns[i].getAttribute('icon') || '',
          label: controlBtns[i].getAttribute('label') || controlBtns[i].label || '',
          disabled: controlBtns[i].hasAttribute('disabled'),
        })
      }
    }

    // Dump the first few li.item rows
    var items = outline.shadowRoot.querySelectorAll('li.item')
    info.rowCount = items.length
    info.firstRows = []
    for (var i = 0; i < Math.min(items.length, 3); i++) {
      var row = items[i]
      var rowInfo = {
        dataItemId: row.getAttribute('data-item-id'),
        className: row.className,
        role: row.getAttribute('role'),
        ariaLabel: row.getAttribute('aria-label'),
      }

      // leading operations
      var leading = row.querySelector('.item-leading-operations')
      if (leading) {
        rowInfo.leadingOps = {
          dragHandle: !!leading.querySelector('[data-drag-handle-id]'),
          dragHandleIcon: leading.querySelector('[data-drag-handle-id]')
            ? leading.querySelector('[data-drag-handle-id]').getAttribute('icon')
            : '',
          actionsMenuButton: !!leading.querySelector('.actions-menu-button'),
          actionsMenuButtonIcon: leading.querySelector('.actions-menu-button')
            ? leading.querySelector('.actions-menu-button').getAttribute('icon')
            : '',
          collapseBtn: !!leading.querySelector('.collapse-btn'),
        }
      }

      // label + label-edit
      var label = row.querySelector('.label.shown')
      var labelEdit = row.querySelector('.label-edit')
      rowInfo.label = label ? { text: label.textContent.trim(), classes: label.className } : null
      rowInfo.labelEdit = labelEdit
        ? { classes: labelEdit.className, contentEditable: labelEdit.getAttribute('contenteditable') }
        : null

      // actions menu (simple-context-menu)
      var menu = row.querySelector('simple-context-menu.actions-menu')
      if (menu) {
        rowInfo.actionsMenuFound = true
        var menuBtns = menu.querySelectorAll('simple-toolbar-button')
        rowInfo.menuItems = []
        for (var j = 0; j < menuBtns.length; j++) {
          rowInfo.menuItems.push({
            value: menuBtns[j].getAttribute('value') || menuBtns[j].value || '',
            label: menuBtns[j].getAttribute('label') || menuBtns[j].label || '',
            icon: menuBtns[j].getAttribute('icon') || '',
            showTextLabel: menuBtns[j].hasAttribute('show-text-label'),
          })
        }
      }

      info.firstRows.push(rowInfo)
    }

    return info
  })
}

// --- dump import hierarchy dialog -------------------------------------------

async function dumpImportHierarchyDialog(page) {
  return page.evaluate(() => {
    // Look for any simple-modal containing an outline-designer that is NOT
    // the main outline editor dialog. The import hierarchy modal reuses
    // outline-designer inside a different dialog.
    var modals = document.querySelectorAll('simple-modal')
    var info = { modalCount: modals.length, importDialogs: [] }
    for (var i = 0; i < modals.length; i++) {
      var m = modals[i]
      var children = Array.prototype.slice.call(m.children).map(function (c) {
        return c.tagName.toLowerCase()
      })
      // The import hierarchy dialog may contain an outline-designer directly
      // or a custom dialog element. Look for outline-designer instances.
      var outlineDesigners = m.querySelectorAll('outline-designer')
      var outlineEditorDialogs = m.querySelectorAll('haxcms-outline-editor-dialog')
      if (outlineDesigners.length > 0 && outlineEditorDialogs.length === 0) {
        // This is likely the import hierarchy modal
        var od = outlineDesigners[0]
        info.importDialogs.push({
          modalIndex: i,
          childTags: children,
          modalOpened: m.opened === true,
          outlineDesignerFound: true,
          outlineDesignerHasShadow: !!(od && od.shadowRoot),
          outlineDesignerItems: Array.isArray(od.items) ? od.items.length : -1,
        })
      }
    }
    // Also check the document body for any dialog-like elements
    var allOutlineDesigners = document.querySelectorAll('outline-designer')
    info.totalOutlineDesigners = allOutlineDesigners.length
    return info
  })
}

// --- request body capture ---------------------------------------------------
function createRequestWatcher(page) {
  var requests = []
  function onRequest(request) {
    var url = request.url()
    if (
      url.indexOf('/x/api/v1/content') !== -1 ||
      url.indexOf('/x/api/v1/items') !== -1 ||
      url.indexOf('/x/api/v1/site/outline') !== -1 ||
      url.indexOf('/x/api/v1/site/normalize-slugs') !== -1
    ) {
      var postData = ''
      try { postData = request.postData() || '' } catch (e) { postData = '' }
      requests.push({ url: url, method: request.method(), postData: postData })
    }
  }
  page.on('request', onRequest)
  function getRequestsFor(sub) {
    return requests.filter(function (r) { return r.url.indexOf(sub) !== -1 })
  }
  function detach() { page.off('request', onRequest) }
  return { getRequestsFor: getRequestsFor, detach: detach, getAll: function () { return requests.slice() } }
}

// --- main -------------------------------------------------------------------

async function main() {
  section('DISCOVERY-OUTLINE: booting E2E runtime')
  var runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  patchHaxcmsRootForHarness(runtime)

  var browser = null
  var page = null
  var collector = null
  var reqWatch = null
  var evidence = {}

  try {
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)
    reqWatch = createRequestWatcher(page)

    section('login')
    await loginViaUI(page, collector, runtime.baseUrl)

    section('create site')
    var createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    logJSON('CREATE SITE API', { status: createResp.status, url: createResp.url })
    var relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    console.log('relocated created site into _sites:', relocated)

    section('navigate into site editor')
    var editorUrl = runtime.baseUrl + '/' + SITES_DIR + '/' + FIXED_SITE_NAME.toLowerCase() + '/'
    console.log('navigating to:', editorUrl)
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitFor(async () => page.evaluate(function () { return !!document.querySelector('haxcms-site-editor-ui') }), 45000)
    await new Promise((r) => setTimeout(r, 4000))

    section('open outline editor (#outlinebutton)')
    var outlineOpen = await clickEditorButtonById(page, '#outlinebutton')
    logJSON('OUTLINE OPEN CLICK', outlineOpen)
    await new Promise((r) => setTimeout(r, 3000))

    var outlineReady = await ensureOutlineOpen(page, null)
    logJSON('OUTLINE DIALOG READY', outlineReady)

    section('dump outline-designer structure')
    var outlineDump = await dumpOutlineDesigner(page)
    logJSON('OUTLINE DESIGNER DUMP', outlineDump)
    evidence.outlineDesigner = outlineDump

    // Add a page via the outline-designer "Add page" button to have more rows
    section('add a page via outline-designer Add page button')
    var addResult = await page.evaluate(function () {
      var modals = document.querySelectorAll('simple-modal')
      var dialog = null
      for (var i = 0; i < modals.length; i++) {
        var d = modals[i].querySelector('haxcms-outline-editor-dialog')
        if (d) { dialog = d; break }
      }
      if (!dialog) dialog = document.querySelector('haxcms-outline-editor-dialog')
      if (!dialog || !dialog.shadowRoot) return { error: 'no dialog' }
      var outline = dialog.shadowRoot.querySelector('#outline')
      if (!outline || !outline.shadowRoot) return { error: 'no outline' }
      var addBtn = outline.shadowRoot.querySelector('simple-toolbar-button[icon="add"]')
      if (!addBtn) return { error: 'no add button' }
      var inner = addBtn.shadowRoot ? addBtn.shadowRoot.querySelector('button') : null
      if (inner) inner.click()
      else addBtn.click()
      return { clicked: true }
    })
    logJSON('ADD PAGE CLICK', addResult)
    await new Promise((r) => setTimeout(r, 1500))

    // Dump again after adding a page
    section('dump outline-designer after Add page')
    var outlineDump2 = await dumpOutlineDesigner(page)
    logJSON('OUTLINE DESIGNER DUMP (after add)', outlineDump2)
    evidence.outlineDesignerAfterAdd = outlineDump2

    // Test the actions menu: click the more-vert button on the first row
    section('click actions-menu-button on first row')
    var menuOpenResult = await page.evaluate(function () {
      var modals = document.querySelectorAll('simple-modal')
      var dialog = null
      for (var i = 0; i < modals.length; i++) {
        var d = modals[i].querySelector('haxcms-outline-editor-dialog')
        if (d) { dialog = d; break }
      }
      if (!dialog) dialog = document.querySelector('haxcms-outline-editor-dialog')
      if (!dialog || !dialog.shadowRoot) return { error: 'no dialog' }
      var outline = dialog.shadowRoot.querySelector('#outline')
      if (!outline || !outline.shadowRoot) return { error: 'no outline' }
      var firstRow = outline.shadowRoot.querySelector('li.item')
      if (!firstRow) return { error: 'no first row' }
      var menuBtn = firstRow.querySelector('.actions-menu-button')
      if (!menuBtn) return { error: 'no actions-menu-button' }
      var inner = menuBtn.shadowRoot ? menuBtn.shadowRoot.querySelector('button') : null
      if (inner) inner.click()
      else menuBtn.click()
      return { clicked: true, rowItemId: firstRow.getAttribute('data-item-id') }
    })
    logJSON('ACTIONS MENU OPEN', menuOpenResult)
    await new Promise((r) => setTimeout(r, 1000))

    // Dump the actions menu items after opening
    section('dump actions menu items (opened)')
    var menuDump = await page.evaluate(function () {
      var modals = document.querySelectorAll('simple-modal')
      var dialog = null
      for (var i = 0; i < modals.length; i++) {
        var d = modals[i].querySelector('haxcms-outline-editor-dialog')
        if (d) { dialog = d; break }
      }
      if (!dialog) dialog = document.querySelector('haxcms-outline-editor-dialog')
      if (!dialog || !dialog.shadowRoot) return { error: 'no dialog' }
      var outline = dialog.shadowRoot.querySelector('#outline')
      if (!outline || !outline.shadowRoot) return { error: 'no outline' }
      var firstRow = outline.shadowRoot.querySelector('li.item')
      if (!firstRow) return { error: 'no first row' }
      var menu = firstRow.querySelector('simple-context-menu.actions-menu')
      if (!menu) return { error: 'no actions menu' }
      var isOpen = menu.hasAttribute('open') || menu.open === true
      var items = menu.querySelectorAll('simple-toolbar-button')
      var itemInfo = []
      for (var i = 0; i < items.length; i++) {
        itemInfo.push({
          value: items[i].getAttribute('value') || items[i].value || '',
          label: items[i].getAttribute('label') || items[i].label || '',
          icon: items[i].getAttribute('icon') || '',
          showTextLabel: items[i].hasAttribute('show-text-label'),
          disabled: items[i].hasAttribute('disabled'),
        })
      }
      return { menuOpen: isOpen, itemCount: items.length, items: itemInfo }
    })
    logJSON('ACTIONS MENU ITEMS', menuDump)
    evidence.actionsMenuItems = menuDump

    // Close the outline modal before testing import
    section('close outline modal')
    await page.evaluate(function () {
      globalThis.dispatchEvent(new CustomEvent('simple-modal-hide', { bubbles: true, composed: true }))
    })
    await new Promise((r) => setTimeout(r, 1500))

    // Test the import flow: dispatch haxcms-docx-import-items with test items
    section('simulate import result via haxcms-docx-import-items')
    var importDispatch = await page.evaluate(function () {
      var testItems = [
        {
          id: 'import-test-1',
          title: 'Imported Page One',
          indent: 0,
          parent: null,
          order: 0,
          location: 'pages/import-test-1/index.html',
          slug: 'imported-page-one',
          contents: '<p>Imported content one</p>',
          metadata: { created: 1700000000, updated: 1700000000 },
        },
        {
          id: 'import-test-2',
          title: 'Imported Page Two',
          indent: 1,
          parent: 'import-test-1',
          order: 0,
          location: 'pages/import-test-2/index.html',
          slug: 'imported-page-two',
          contents: '<p>Imported content two</p>',
          metadata: { created: 1700000000, updated: 1700000000 },
        },
      ]
      globalThis.dispatchEvent(
        new CustomEvent('haxcms-docx-import-items', {
          bubbles: true,
          composed: true,
          cancelable: true,
          detail: { items: testItems, parentId: null },
        }),
      )
      return { dispatched: true, itemCount: testItems.length }
    })
    logJSON('IMPORT DISPATCH', importDispatch)
    await new Promise((r) => setTimeout(r, 2000))

    // Dump the import hierarchy dialog
    section('dump import hierarchy dialog')
    var importDump = await dumpImportHierarchyDialog(page)
    logJSON('IMPORT HIERARCHY DIALOG', importDump)
    evidence.importHierarchyDialog = importDump

    // Look for Save/Cancel buttons in the import hierarchy modal
    section('dump import hierarchy modal buttons')
    var importButtons = await page.evaluate(function () {
      var modals = document.querySelectorAll('simple-modal')
      var result = { modals: [] }
      for (var i = 0; i < modals.length; i++) {
        var m = modals[i]
        var mInfo = {
          index: i,
          opened: m.opened === true,
          childTags: Array.prototype.slice.call(m.children).map(function (c) { return c.tagName.toLowerCase() }),
          buttons: [],
        }
        // Look for buttons in the modal's children (light DOM) and their shadow roots
        var allBtns = m.querySelectorAll('button')
        for (var j = 0; j < allBtns.length; j++) {
          mInfo.buttons.push({
            text: (allBtns[j].textContent || '').trim().substring(0, 40),
            classes: allBtns[j].className,
          })
        }
        // Also look for .hax-modal-btn in shadow roots of children
        var allEls = m.querySelectorAll('*')
        for (var k = 0; k < allEls.length; k++) {
          if (allEls[k].shadowRoot) {
            var shadowBtns = allEls[k].shadowRoot.querySelectorAll('button, .hax-modal-btn, simple-toolbar-button')
            for (var l = 0; l < shadowBtns.length; l++) {
              var sb = shadowBtns[l]
              mInfo.buttons.push({
                text: (sb.textContent || '').trim().substring(0, 40),
                classes: sb.className,
                tag: sb.tagName.toLowerCase(),
                label: sb.getAttribute('label') || sb.label || '',
                inShadowOf: allEls[k].tagName.toLowerCase(),
              })
            }
          }
        }
        result.modals.push(mInfo)
      }
      return result
    })
    logJSON('IMPORT HIERARCHY MODAL BUTTONS', importButtons)
    evidence.importModalButtons = importButtons

    section('DISCOVERY-OUTLINE: SUMMARY')
    console.log('Evidence keys: ' + Object.keys(evidence).join(', '))
  } catch (err) {
    console.error('DISCOVERY-OUTLINE FAILED:', err && err.stack ? err.stack : err)
    try {
      var dump = await page.evaluate(function () { return document.body.innerHTML.substring(0, 1500) })
      console.error('PAGE BODY SNIPPET:', dump)
    } catch (e) { /* ignore */ }
  } finally {
    try { if (reqWatch) reqWatch.detach() } catch (e) { /* ignore */ }
    try { if (collector) collector.detach() } catch (e) { /* ignore */ }
    try { if (browser) await browser.close() } catch (e) { /* ignore */ }
    try { await teardownE2ERuntime(runtime) } catch (e) { /* ignore */ }
    console.log('\nTeardown complete.')
  }
}

main().catch(function (err) {
  console.error('DISCOVERY-OUTLINE TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
