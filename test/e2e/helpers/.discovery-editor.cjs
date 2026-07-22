'use strict'

// Discovery script v2 (dotfile, ignored by node --test glob).
// Boots the E2E harness, logs in via the two-step UI, creates
// HAXSITEAUTOMATEDTESTING, then maps three UI surfaces:
//   B) EXPORT DIALOG  — more-vert menu labels, "Download" item, confirmation
//      modal, POST /system/api/v1/sites/:siteName/download response.
//   A) SITE EDITOR    — haxcms-site-editor-ui chrome (#editbutton save,
//      #outlinebutton, #addpagebutton), haxcms-site-editor > h-a-x#hax >
//      hax-body (recursive shadow search), PATCH /x/api/v1/content/:idOrSlug.
//   C) OUTLINE EDITOR — #outlinebutton opens haxcms-outline-editor-dialog
//      (outline-designer#outline + .hax-modal-btn "Save Outline"),
//      PATCH /x/api/v1/site/outline (saveOutline), plus
//      POST /x/api/v1/items (createNode) + DELETE /x/api/v1/items/:idOrSlug
//      (deleteNode) shapes via haxcms-create-node / haxcms-delete-node events.
//
// Run: node test/e2e/helpers/.discovery-editor.cjs  (from repo root)

const path = require('path')
const fs = require('fs-extra')

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

function patchHaxcmsRootForHarness(runtime) {
  const { HAXCMS } = require('../../../src/lib/HAXCMS.js')
  const root = String(runtime.runtimeRoot)
  HAXCMS.HAXCMS_ROOT = root.charAt(root.length - 1) === '/' ? root : root + '/'
  return HAXCMS
}

function relocateCreatedSite(runtime, siteName) {
  const name = String(siteName).toLowerCase()
  const fromDir = path.join(runtime.runtimeRoot + '_sites', name)
  const toDir = path.join(runtime.runtimeRoot, SITES_DIR, name)
  if (fs.pathExistsSync(fromDir)) {
    fs.moveSync(fromDir, toDir, { overwrite: true })
    return true
  }
  return false
}

async function waitFor(fn, timeoutMs, intervalMs) {
  const interval = intervalMs || 250
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    last = await fn()
    if (last) return last
    await new Promise((r) => setTimeout(r, interval))
  }
  return last
}

async function waitForDeep(page, chain, timeoutMs) {
  return waitFor(async () => deepQuery(page, chain), timeoutMs)
}

async function performLoginEvaluate(page) {
  const loginResult = await page.evaluate(async (username, password) => {
    const modal = document.querySelector('simple-modal')
    if (!modal) return { error: 'no modal' }
    const loginEl = modal.querySelector('app-hax-site-login')
    if (!loginEl || !loginEl.shadowRoot) return { error: 'no login el' }
    const usernameInput = loginEl.shadowRoot.querySelector('#username')
    if (!usernameInput) return { error: 'no username input' }
    usernameInput.value = username
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 100))
    const btns = Array.prototype.slice.call(loginEl.shadowRoot.querySelectorAll('button'))
    const nextBtn = btns.find((b) => b.textContent.indexOf('Next') !== -1)
    if (!nextBtn) return { error: 'no Next button', buttons: btns.map((b) => b.textContent.trim()) }
    nextBtn.click()
    await new Promise((r) => setTimeout(r, 500))
    const passwordInput = loginEl.shadowRoot.querySelector('#password')
    if (!passwordInput) return { error: 'no password input after Next' }
    passwordInput.value = password
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 100))
    const loginBtn = Array.prototype.slice
      .call(loginEl.shadowRoot.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Login') !== -1)
    if (!loginBtn) return { error: 'no Login button' }
    loginBtn.click()
    return { clicked: true }
  }, E2E_USER_NAME, E2E_USER_PASSWORD)
  if (!loginResult || loginResult.clicked !== true) {
    throw new Error('UI login failed: ' + JSON.stringify(loginResult))
  }
}

async function loginViaUI(page, collector, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('app-hax', { timeout: 30000 })
  const ready = await waitFor(
    async () =>
      page.evaluate(() => {
        const m = document.querySelector('simple-modal')
        if (!m) return false
        const l = m.querySelector('app-hax-site-login')
        if (!l || !l.shadowRoot) return false
        return !!l.shadowRoot.querySelector('#username')
      }),
    30000,
  )
  if (!ready) throw new Error('login modal with #username did not appear')
  await performLoginEvaluate(page)
  const loginResp = await collector.awaitCollectorFor('session/login', 20000)
  logJSON('LOGIN API', { status: loginResp.status, url: loginResp.url })
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
  const nameInput = await deepQuery(page, selectors.create.siteNameInputChain)
  await nameInput.evaluate((input, value) => {
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, siteName)
  const createBtn = await deepQuery(page, selectors.create.createSiteButtonChain)
  await createBtn.evaluate((b) => b.click())
  const resp = await waitFor(async () => {
    const all = collector.getResponsesFor('/system/api/v1/sites')
    for (let i = 0; i < all.length; i++) {
      let parsed = null
      try {
        parsed = JSON.parse(all[i].bodyText)
      } catch (e) {
        continue
      }
      const metaSite =
        parsed && parsed.data && parsed.data.metadata && parsed.data.metadata.site
          ? parsed.data.metadata.site
          : null
      if (
        parsed &&
        parsed.status === 200 &&
        metaSite &&
        typeof metaSite.name === 'string' &&
        metaSite.name.toLowerCase() === siteName.toLowerCase()
      ) {
        return all[i]
      }
    }
    return null
  }, 60000)
  logJSON('CREATE SITE API', { status: resp.status, url: resp.url })
}

async function findSiteCard(page, siteName) {
  const target = String(siteName).toLowerCase()
  return waitFor(
    async () => {
      const handle = await page.evaluateHandle((t) => {
        const appHax = document.querySelector('app-hax')
        if (!appHax || !appHax.shadowRoot) return null
        const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
        if (!ucf || !ucf.shadowRoot) return null
        const sr = ucf.shadowRoot.querySelector('app-hax-search-results')
        if (!sr || !sr.shadowRoot) return null
        const cards = sr.shadowRoot.querySelectorAll('app-hax-site-bar')
        for (let i = 0; i < cards.length; i++) {
          if ((cards[i].textContent || '').toLowerCase().indexOf(t) !== -1) return cards[i]
        }
        return null
      }, target)
      const el = handle.asElement()
      if (!el) {
        await handle.dispose()
        return null
      }
      return el
    },
    75000,
  )
}

async function reloadDashboard(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('app-hax', { timeout: 30000 })
  await new Promise((r) => setTimeout(r, 2000))
  const needsLogin = await page.evaluate(() => {
    const m = document.querySelector('simple-modal')
    if (!m) return false
    const l = m.querySelector('app-hax-site-login')
    return !!(l && l.shadowRoot && l.shadowRoot.querySelector('#username'))
  })
  if (needsLogin) {
    console.log('  (re-login after reload)')
    await performLoginEvaluate(page)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// --- PHASE A: editor -------------------------------------------------------

async function dumpEditorChrome(page) {
  return page.evaluate(() => {
    const ui = document.querySelector('haxcms-site-editor-ui')
    function buttonsInShadow(host) {
      if (!host || !host.shadowRoot) return null
      const out = {}
      const ids = [
        '#editbutton',
        '#cancelbutton',
        '#outlinebutton',
        '#addpagebutton',
        '#manifestbtn',
        '#content-edit',
        '#content-map',
        '#content-add',
        '#exportbtn',
        '#undo',
        '#redo',
      ]
      ids.forEach((id) => {
        const el = host.shadowRoot.querySelector(id)
        if (el) {
          out[id] = {
            tag: el.tagName.toLowerCase(),
            label: el.getAttribute('label') || el.label || '',
            icon: el.getAttribute('icon') || '',
            hidden: el.hasAttribute('hidden'),
            disabled: el.hasAttribute('disabled'),
          }
        }
      })
      return out
    }
    // recursive search for haxcms-site-editor (it renders inside the theme)
    function walk(root) {
      if (!root) return null
      const found = root.querySelector('haxcms-site-editor')
      if (found) return found
      const all = root.querySelectorAll('*')
      for (let i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          const inner = walk(all[i].shadowRoot)
          if (inner) return inner
        }
      }
      return null
    }
    const editor = walk(document)
    let haxBodyInfo = null
    if (editor) {
      const hax = editor.querySelector('#hax')
      let bodyEl = null
      if (hax && hax.shadowRoot) {
        bodyEl = hax.shadowRoot.querySelector('hax-body') || hax.shadowRoot.querySelector('[contenteditable]')
      }
      haxBodyInfo = {
        editorFound: true,
        editorHasShadow: !!editor.shadowRoot,
        editorParentTag: editor.parentElement ? editor.parentElement.tagName.toLowerCase() : '',
        haxFound: !!hax,
        haxHasShadow: !!(hax && hax.shadowRoot),
        bodyTag: bodyEl ? bodyEl.tagName.toLowerCase() : '',
        bodyId: bodyEl ? (bodyEl.id || '') : '',
        bodyContentEditable: bodyEl ? bodyEl.hasAttribute('contenteditable') : false,
        bodyChildCount: bodyEl ? bodyEl.children.length : 0,
        hasImportContent: bodyEl ? typeof bodyEl.importContent === 'function' : false,
      }
    } else {
      haxBodyInfo = { editorFound: false }
    }
    return {
      uiFound: !!ui,
      uiHasShadow: !!(ui && ui.shadowRoot),
      uiEditMode: ui ? ui.hasAttribute('edit-mode') : null,
      uiPageAllowed: ui ? ui.hasAttribute('page-allowed') : null,
      buttons: buttonsInShadow(ui),
      haxBody: haxBodyInfo,
    }
  })
}

function clickEditorButtonById(page, id) {
  return page.evaluate((btnId) => {
    const ui = document.querySelector('haxcms-site-editor-ui')
    if (!ui || !ui.shadowRoot) return { error: 'no ui' }
    const btn = ui.shadowRoot.querySelector(btnId)
    if (!btn) return { error: 'no ' + btnId }
    var inner = btn.shadowRoot && btn.shadowRoot.querySelector('button')
    if (inner) inner.click()
    else btn.click()
    return { clicked: true }
  }, id)
}

async function typeIntoHaxBody(page, html) {
  return page.evaluate((htmlFragment) => {
    function walk(root) {
      if (!root) return null
      const found = root.querySelector('haxcms-site-editor')
      if (found) return found
      const all = root.querySelectorAll('*')
      for (let i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          const inner = walk(all[i].shadowRoot)
          if (inner) return inner
        }
      }
      return null
    }
    const editor = walk(document)
    if (!editor) return { error: 'no editor' }
    const hax = editor.querySelector('#hax')
    if (!hax || !hax.shadowRoot) return { error: 'no hax' }
    let body = hax.shadowRoot.querySelector('hax-body') || hax.shadowRoot.querySelector('[contenteditable]')
    if (!body) return { error: 'no hax-body' }
    if (typeof body.importContent === 'function') {
      body.importContent(htmlFragment)
    } else {
      body.innerHTML = htmlFragment
    }
    body.dispatchEvent(new Event('input', { bubbles: true }))
    return {
      ok: true,
      bodyTag: body.tagName.toLowerCase(),
      childCount: body.children.length,
      hasImportContent: typeof body.importContent === 'function',
    }
  }, html)
}

// --- PHASE B: export --------------------------------------------------------

async function openMoreVertAndDumpMenu(page, cardHandle) {
  const opened = await cardHandle.evaluate((el) => {
    const btn =
      el.shadowRoot && el.shadowRoot.querySelector('simple-icon-button-lite[icon="lrn:more-vert"]')
    if (btn) {
      btn.click()
      return true
    }
    return false
  })
  if (!opened) return { opened: false }
  await new Promise((r) => setTimeout(r, 500))
  const dump = await cardHandle.evaluate((el) => {
    const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
    if (!menu) return { menuFound: false }
    const items = menu.querySelectorAll('simple-toolbar-button')
    const labels = []
    for (let i = 0; i < items.length; i++) {
      labels.push({
        label: String(items[i].getAttribute('label') || items[i].label || ''),
        icon: String(items[i].getAttribute('icon') || ''),
      })
    }
    return { menuFound: true, labels }
  })
  return { opened: true, dump }
}

async function clickMenuItemByLabel(page, cardHandle, labelText) {
  return cardHandle.evaluate((el, label) => {
    const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
    if (!menu) return { error: 'no menu' }
    const items = menu.querySelectorAll('simple-toolbar-button')
    for (let i = 0; i < items.length; i++) {
      const l = String(items[i].getAttribute('label') || items[i].label || '').toLowerCase()
      if (l === label.toLowerCase()) {
        items[i].click()
        return { clicked: true, label: l }
      }
    }
    return { error: 'label not found' }
  }, labelText)
}

// --- PHASE C: outline editor -----------------------------------------------

async function dumpOutlineDialog(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('simple-modal')
    let dialog = null
    if (modal) dialog = modal.querySelector('haxcms-outline-editor-dialog')
    if (!dialog) dialog = document.querySelector('haxcms-outline-editor-dialog')
    if (!dialog) return { dialogFound: false }
    const info = {
      dialogFound: true,
      dialogHasShadow: !!dialog.shadowRoot,
      inSimpleModal: !!(modal && modal.contains(dialog)),
    }
    if (dialog.shadowRoot) {
      const outline = dialog.shadowRoot.querySelector('#outline')
      info.outlineFound = !!outline
      info.outlineTag = outline ? outline.tagName.toLowerCase() : ''
      info.outlineHasShadow = !!(outline && outline.shadowRoot)
      const btns = dialog.shadowRoot.querySelectorAll('.hax-modal-btn')
      info.saveButtons = []
      for (let i = 0; i < btns.length; i++) {
        info.saveButtons.push({
          text: (btns[i].textContent || '').trim(),
          classes: btns[i].className,
        })
      }
      // deep search outline-designer shadow for an "Add page" button
      if (outline && outline.shadowRoot) {
        function findAddBtn(root) {
          if (!root) return null
          const cand = root.querySelectorAll('simple-toolbar-button, simple-toolbar-menu, [data-event]')
          for (let i = 0; i < cand.length; i++) {
            const label = String(cand[i].getAttribute('label') || cand[i].label || '')
            if (label.toLowerCase().indexOf('add') !== -1) return cand[i]
          }
          const all = root.querySelectorAll('*')
          for (let i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) {
              const inner = findAddBtn(all[i].shadowRoot)
              if (inner) return inner
            }
          }
          return null
        }
        const addBtn = findAddBtn(outline.shadowRoot)
        info.outlineAddButton = addBtn
          ? {
              tag: addBtn.tagName.toLowerCase(),
              id: addBtn.id || '',
              label: addBtn.getAttribute('label') || '',
              dataEvent: addBtn.getAttribute('data-event') || '',
            }
          : null
      }
    }
    return info
  })
}

// --- request body capture ---------------------------------------------------
function createRequestWatcher(page) {
  const requests = []
  function onRequest(request) {
    const url = request.url()
    if (
      url.indexOf('/x/api/v1/content') !== -1 ||
      url.indexOf('/x/api/v1/items') !== -1 ||
      url.indexOf('/x/api/v1/site/outline') !== -1
    ) {
      let postData = ''
      try {
        postData = request.postData() || ''
      } catch (e) {
        postData = ''
      }
      requests.push({ url, method: request.method(), postData })
    }
  }
  page.on('request', onRequest)
  function getRequestsFor(sub) {
    return requests.filter((r) => r.url.indexOf(sub) !== -1)
  }
  function detach() {
    page.off('request', onRequest)
  }
  return { getRequestsFor, detach, getAll: () => requests.slice() }
}

// --- main -------------------------------------------------------------------
async function main() {
  section('DISCOVERY-EDITOR v2: booting E2E runtime')
  const runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  patchHaxcmsRootForHarness(runtime)

  let browser = null
  let page = null
  let collector = null
  let reqWatch = null
  const evidence = {}

  try {
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)
    reqWatch = createRequestWatcher(page)

    section('login')
    await loginViaUI(page, collector, runtime.baseUrl)

    section('create site')
    await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    console.log('relocated created site into _sites:', relocated)

    section('reload dashboard + find card')
    await reloadDashboard(page, runtime.baseUrl)
    const card = await findSiteCard(page, FIXED_SITE_NAME)
    if (!card) throw new Error('site card not found after reload')
    console.log('site card found')

    const siteUrl = await card.evaluate((el) => {
      const a = el.shadowRoot.querySelector('a.imageLink')
      return { href: a ? a.href : '', siteUrl: el.siteUrl || '', slug: el.slug || '' }
    })
    logJSON('SITE CARD URL INFO', siteUrl)

    // ---------- PHASE B: export (FIRST, while dashboard manifest is fresh) ----------
    section('PHASE B: more-vert menu + Download')
    const menuResult = await openMoreVertAndDumpMenu(page, card)
    logJSON('MORE-VERT MENU', menuResult)
    evidence.moreVertMenu = menuResult

    const downloadClick = await clickMenuItemByLabel(page, card, 'Download')
    logJSON('DOWNLOAD MENU CLICK', downloadClick)
    await new Promise((r) => setTimeout(r, 1500))
    const confirmModalReady = await waitFor(
      async () =>
        page.evaluate(() => {
          const m = document.querySelector('app-hax-confirmation-modal')
          return !!(m && m.shadowRoot && m.shadowRoot.querySelector('.button.button-confirm'))
        }),
      15000,
    )
    logJSON('CONFIRM MODAL READY', !!confirmModalReady)
    if (!confirmModalReady) {
      const diag = await page.evaluate(() => {
        const m = document.querySelector('app-hax-confirmation-modal')
        return {
          modalExists: !!m,
          modalHasShadow: !!(m && m.shadowRoot),
          modalOpen: m ? m.hasAttribute('opened') : null,
          modalTitle: m ? m.title : null,
          modalMessage: m ? m.message : null,
        }
      })
      logJSON('CONFIRM MODAL DIAG', diag)
      evidence.confirmModalDiag = diag
    } else {
      const confirmClick = await page.evaluate(() => {
        const modal = document.querySelector('app-hax-confirmation-modal')
        const btn = modal.shadowRoot.querySelector('.button.button-confirm')
        btn.click()
        return { clicked: true }
      })
      logJSON('CONFIRM CLICK', confirmClick)
      let downloadResp = null
      try {
        downloadResp = await collector.awaitCollectorFor('/download', 25000)
      } catch (e) {
        console.log('download response NOT captured:', e.message)
      }
      if (downloadResp) {
        logJSON('DOWNLOAD SITE RESPONSE', {
          url: downloadResp.url,
          status: downloadResp.status,
          bodyFirst400: downloadResp.bodyText.substring(0, 400),
        })
        evidence.downloadResponse = {
          url: downloadResp.url,
          status: downloadResp.status,
          body: downloadResp.bodyText.substring(0, 800),
        }
      }
    }

    // ---------- PHASE A: editor ----------
    section('PHASE A: navigate into site editor')
    const editorUrl = siteUrl.href || siteUrl.siteUrl
    console.log('navigating to:', editorUrl)
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitFor(async () => page.evaluate(() => !!document.querySelector('haxcms-site-editor-ui')), 45000)
    await new Promise((r) => setTimeout(r, 4000))
    const editorDump1 = await dumpEditorChrome(page)
    logJSON('EDITOR CHROME (before edit)', editorDump1)
    evidence.editorChromeBefore = editorDump1

    await waitFor(
      async () =>
        page.evaluate(() => {
          const ui = document.querySelector('haxcms-site-editor-ui')
          if (!ui || !ui.shadowRoot) return false
          const b = ui.shadowRoot.querySelector('#editbutton')
          return !!(b && !b.hasAttribute('disabled') && !b.hasAttribute('hidden'))
        }),
      30000,
    )

    section('PHASE A: enter edit mode')
    const enterResult = await clickEditorButtonById(page, '#editbutton')
    logJSON('ENTER EDIT MODE', enterResult)
    await new Promise((r) => setTimeout(r, 4000))
    const editorDump2 = await dumpEditorChrome(page)
    logJSON('EDITOR CHROME (after edit)', editorDump2)
    evidence.editorChromeAfter = editorDump2

    section('PHASE A: type into hax-body')
    const typeResult = await typeIntoHaxBody(page, '<p>Automated E2E discovery content for HAXSITEAUTOMATEDTESTING.</p>')
    logJSON('TYPE INTO HAX-BODY', typeResult)
    evidence.typeResult = typeResult
    await new Promise((r) => setTimeout(r, 1500))

    section('PHASE A: click Save (#editbutton)')
    const saveClick = await clickEditorButtonById(page, '#editbutton')
    logJSON('SAVE CLICK', saveClick)

    let saveNodeResp = null
    try {
      saveNodeResp = await collector.awaitCollectorFor('/x/api/v1/content/', 30000)
    } catch (e) {
      console.log('saveNode response NOT captured:', e.message)
    }
    if (saveNodeResp) {
      logJSON('SAVE NODE (saveNode) RESPONSE', {
        url: saveNodeResp.url,
        status: saveNodeResp.status,
        bodyFirst300: saveNodeResp.bodyText.substring(0, 300),
      })
      evidence.saveNodeResponse = {
        url: saveNodeResp.url,
        status: saveNodeResp.status,
        body: saveNodeResp.bodyText.substring(0, 800),
      }
    }
    const saveNodeReqs = reqWatch.getRequestsFor('/x/api/v1/content/')
    if (saveNodeReqs.length > 0) {
      const last = saveNodeReqs[saveNodeReqs.length - 1]
      logJSON('SAVE NODE (saveNode) REQUEST', {
        url: last.url,
        method: last.method,
        postDataFirst800: last.postData.substring(0, 800),
      })
      evidence.saveNodeRequest = {
        url: last.url,
        method: last.method,
        postData: last.postData.substring(0, 1200),
      }
    }

    // exit edit mode (cancel) so outline/addpage buttons are enabled
    section('PHASE A: exit edit mode (cancel)')
    await clickEditorButtonById(page, '#cancelbutton')
    await new Promise((r) => setTimeout(r, 2000))

    // ---------- PHASE C: outline editor ----------
    section('PHASE C: open outline editor (#outlinebutton)')
    const outlineOpen = await clickEditorButtonById(page, '#outlinebutton')
    logJSON('OUTLINE OPEN', outlineOpen)
    await new Promise((r) => setTimeout(r, 3000))
    const outlineDump = await dumpOutlineDialog(page)
    logJSON('OUTLINE DIALOG DOM', outlineDump)
    evidence.outlineDialog = outlineDump

    // Close the outline modal.
    await page.evaluate(() => {
      globalThis.dispatchEvent(new CustomEvent('simple-modal-hide', { bubbles: true, composed: true }))
    })
    await new Promise((r) => setTimeout(r, 1500))

    // ---------- PHASE C: createNode via global haxcms-create-node event ----------
    // The site-editor listens for haxcms-create-node and calls @site/createItem
    // (POST /x/api/v1/items). This captures the createNode API shape reliably.
    section('PHASE C: createNode via haxcms-create-node global event')
    const createNodeDispatch = await page.evaluate(() => {
      const editor = document.querySelector('haxcms-site-editor-ui')
      const evt = new CustomEvent('haxcms-create-node', {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          originalTarget: editor,
          values: {
            node: { title: 'Discovery Test Page', location: '', contents: '<p>Discovery test</p>' },
            order: 999,
            parent: null,
          },
        },
      })
      globalThis.dispatchEvent(evt)
      return { dispatched: true }
    })
    logJSON('CREATE NODE DISPATCH', createNodeDispatch)

    let createNodeResp = null
    try {
      createNodeResp = await collector.awaitCollectorFor('/x/api/v1/items', 25000)
    } catch (e) {
      console.log('createNode response NOT captured:', e.message)
    }
    if (createNodeResp) {
      logJSON('CREATE NODE (createNode) RESPONSE', {
        url: createNodeResp.url,
        status: createNodeResp.status,
        bodyFirst400: createNodeResp.bodyText.substring(0, 400),
      })
      evidence.createNodeResponse = {
        url: createNodeResp.url,
        status: createNodeResp.status,
        body: createNodeResp.bodyText.substring(0, 800),
      }
    }
    const createNodeReqs = reqWatch
      .getRequestsFor('/x/api/v1/items')
      .filter((r) => r.method === 'POST' || r.method === 'post')
    if (createNodeReqs.length > 0) {
      const last = createNodeReqs[createNodeReqs.length - 1]
      logJSON('CREATE NODE (createNode) REQUEST', {
        url: last.url,
        method: last.method,
        postDataFirst800: last.postData.substring(0, 800),
      })
      evidence.createNodeRequest = {
        url: last.url,
        method: last.method,
        postData: last.postData.substring(0, 1000),
      }
    }

    // ---------- PHASE C: deleteNode via global haxcms-delete-node event ----------
    section('PHASE C: deleteNode via haxcms-delete-node global event')
    let createdId = null
    if (evidence.createNodeResponse) {
      try {
        const parsed = JSON.parse(evidence.createNodeResponse.body)
        createdId = parsed && parsed.data && parsed.data.id ? parsed.data.id : null
      } catch (e) {
        createdId = null
      }
    }
    logJSON('DELETE NODE target id', createdId)

    if (createdId) {
      await page.evaluate((id) => {
        globalThis.dispatchEvent(
          new CustomEvent('haxcms-delete-node', {
            bubbles: true,
            composed: true,
            cancelable: true,
            detail: { item: { id: id } },
          }),
        )
      }, createdId)
      let deleteNodeResp = null
      try {
        deleteNodeResp = await collector.awaitCollectorFor('/x/api/v1/items/', 25000)
      } catch (e) {
        console.log('deleteNode response NOT captured:', e.message)
      }
      if (deleteNodeResp) {
        logJSON('DELETE NODE (deleteNode) RESPONSE', {
          url: deleteNodeResp.url,
          status: deleteNodeResp.status,
          bodyFirst400: deleteNodeResp.bodyText.substring(0, 400),
        })
        evidence.deleteNodeResponse = {
          url: deleteNodeResp.url,
          status: deleteNodeResp.status,
          body: deleteNodeResp.bodyText.substring(0, 800),
        }
      }
      const deleteNodeReqs = reqWatch
        .getRequestsFor('/x/api/v1/items/')
        .filter((r) => r.method === 'DELETE' || r.method === 'delete')
      if (deleteNodeReqs.length > 0) {
        const last = deleteNodeReqs[deleteNodeReqs.length - 1]
        logJSON('DELETE NODE (deleteNode) REQUEST', {
          url: last.url,
          method: last.method,
          postDataFirst400: last.postData.substring(0, 400),
        })
        evidence.deleteNodeRequest = {
          url: last.url,
          method: last.method,
          postData: last.postData.substring(0, 800),
        }
      }
    }

    section('DISCOVERY-EDITOR v2: SUMMARY')
    console.log('Evidence keys: ' + Object.keys(evidence).join(', '))
    logJSON('EVIDENCE', evidence)
  } catch (err) {
    console.error('DISCOVERY-EDITOR FAILED:', err && err.stack ? err.stack : err)
    try {
      const dump = await page.evaluate(() => document.body.innerHTML.substring(0, 1500))
      console.error('PAGE BODY SNIPPET:', dump)
    } catch (e) {
      // ignore
    }
  } finally {
    try {
      if (reqWatch) reqWatch.detach()
    } catch (e) {
      // ignore
    }
    try {
      if (collector) collector.detach()
    } catch (e) {
      // ignore
    }
    try {
      if (browser) await browser.close()
    } catch (e) {
      // ignore
    }
    try {
      await teardownE2ERuntime(runtime)
    } catch (e) {
      // ignore
    }
    console.log('\nTeardown complete.')
  }
}

main().catch((err) => {
  console.error('DISCOVERY-EDITOR TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
