'use strict'

// Discovery script for the site settings modal (dotfile, ignored by node --test glob).
// Boots the E2E harness, logs in via the two-step UI, creates
// HAXSITEAUTOMATEDTESTING, navigates into the site editor, clicks #manifestbtn
// (Site Settings), and dumps the full shadow-DOM structure of the settings
// modal + every sub-panel (manifest/details, appearance/theme, SEO, blocks,
// editor). Prints a structured report so selectors.cjs can be refined.
//
// Run: node test/e2e/helpers/.discovery-settings.cjs  (from repo root)

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
  // flows helpers
  waitFor,
  waitForDeep,
  loginViaUI,
  createSiteViaUI,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  clickEditorButtonById,
} = require('./index.cjs')

const SITES_DIR = '_sites'
const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

// --- request body capture ---------------------------------------------------
function createRequestWatcher(page) {
  const requests = []
  function onRequest(request) {
    const url = request.url()
    if (
      url.indexOf('/x/api/v1/site') !== -1 ||
      url.indexOf('/x/api/v1/themes') !== -1
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

// Recursively dump the shadow-DOM tree under a root element. Returns a nested
// object describing tag names, ids, classes, attributes, and text content.
function dumpShadowTree(root, maxDepth) {
  if (!root || maxDepth < 0) {
    return null
  }
  function describeEl(el) {
    if (!el || !el.tagName) {
      return null
    }
    var tag = el.tagName.toLowerCase()
    var id = el.id ? '#' + el.id : ''
    var cls = ''
    if (el.className && typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\s+/).join('.')
    }
    var attrs = {}
    if (el.hasAttribute && el.hasAttribute('label')) {
      attrs.label = el.getAttribute('label')
    }
    if (el.hasAttribute && el.hasAttribute('icon')) {
      attrs.icon = el.getAttribute('icon')
    }
    if (el.hasAttribute && el.hasAttribute('slot')) {
      attrs.slot = el.getAttribute('slot')
    }
    if (el.hasAttribute && el.hasAttribute('name')) {
      attrs.name = el.getAttribute('name')
    }
    if (el.hasAttribute && el.hasAttribute('type')) {
      attrs.type = el.getAttribute('type')
    }
    if (el.hasAttribute && el.hasAttribute('data-event')) {
      attrs.dataEvent = el.getAttribute('data-event')
    }
    if (el.hasAttribute && el.hasAttribute('disabled')) {
      attrs.disabled = true
    }
    if (el.hasAttribute && el.hasAttribute('hidden')) {
      attrs.hidden = true
    }
    if (el.hasAttribute && el.hasAttribute('checked')) {
      attrs.checked = true
    }
    var text = ''
    if (el.textContent && el.textContent.trim()) {
      text = el.textContent.trim().substring(0, 60)
    }
    var info = { tag: tag + id + cls, attrs: attrs }
    if (text) {
      info.text = text
    }
    return info
  }
  function walk(el, depth) {
    if (!el || depth < 0) {
      return null
    }
    var desc = describeEl(el)
    if (!desc) {
      return null
    }
    // children in light DOM
    var children = []
    if (el.children && el.children.length > 0 && depth > 0) {
      for (var i = 0; i < Math.min(el.children.length, 50); i++) {
        var childInfo = walk(el.children[i], depth - 1)
        if (childInfo) {
          children.push(childInfo)
        }
      }
    }
    if (children.length > 0) {
      desc.children = children
    }
    // shadow DOM children
    if (el.shadowRoot && depth > 0) {
      var shadowChildren = []
      var shadowEls = el.shadowRoot.children
      for (var j = 0; j < Math.min(shadowEls.length, 50); j++) {
        var sChildInfo = walk(shadowEls[j], depth - 1)
        if (sChildInfo) {
          shadowChildren.push(sChildInfo)
        }
      }
      if (shadowChildren.length > 0) {
        desc.shadowChildren = shadowChildren
      }
    }
    return desc
  }
  return walk(root, maxDepth)
}

// Dump all custom elements in the document (top-level + in simple-modals),
// with their shadow root children summarized.
async function dumpAllCustomElements(page) {
  return page.evaluate(() => {
    function describeEl(el) {
      if (!el || !el.tagName) return null
      var tag = el.tagName.toLowerCase()
      // only custom elements (contain a dash)
      if (tag.indexOf('-') === -1) return null
      var id = el.id ? '#' + el.id : ''
      var info = {
        tag: tag + id,
        hasShadow: !!el.shadowRoot,
        inModal: false,
      }
      if (el.shadowRoot) {
        var childTags = []
        el.shadowRoot.querySelectorAll('*').forEach(function (c) {
          var ct = c.tagName.toLowerCase()
          if (ct.indexOf('-') !== -1 || c.id || c.tagName === 'INPUT' || c.tagName === 'BUTTON' || c.tagName === 'TEXTAREA' || c.tagName === 'SELECT') {
            var cid = c.id ? '#' + c.id : ''
            var ctag = ct + cid
            if (c.className && typeof c.className === 'string' && c.className.trim()) {
              ctag += '.' + c.className.trim().split(/\s+/).join('.')
            }
            var labelText = ''
            if (c.getAttribute && c.getAttribute('label')) {
              labelText = c.getAttribute('label')
            }
            if (c.textContent && c.textContent.trim()) {
              labelText = (labelText ? labelText + ' | ' : '') + c.textContent.trim().substring(0, 40)
            }
            if (labelText) {
              ctag += ' [\"' + labelText + '\"]'
            }
            childTags.push(ctag)
          }
        })
        info.shadowChildTags = childTags.slice(0, 80)
      }
      return info
    }
    // check all simple-modals + document.body
    var results = []
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      var modalInfo = {
        modalIndex: i,
        opened: modals[i].opened === true,
        modalTag: 'simple-modal',
        lightChildren: [],
      }
      var lightEls = modals[i].children
      for (var j = 0; j < lightEls.length; j++) {
        var lt = lightEls[j].tagName.toLowerCase()
        if (lt.indexOf('-') !== -1 || lt === 'div' || lt === 'section') {
          var lInfo = describeEl(lightEls[j])
          if (lInfo) {
            lInfo.inModal = true
            modalInfo.lightChildren.push(lInfo)
          }
        }
      }
      results.push(modalInfo)
    }
    // also check for any dialog-like custom elements directly on document.body
    var bodyEls = document.body.children
    var bodyCustom = []
    for (var k = 0; k < bodyEls.length; k++) {
      var bt = bodyEls[k].tagName.toLowerCase()
      if (bt.indexOf('-') !== -1 && bt !== 'simple-modal' && bt !== 'app-hax') {
        var bInfo = describeEl(bodyEls[k])
        if (bInfo) {
          bodyCustom.push(bInfo)
        }
      }
    }
    return { modals: results, bodyCustom: bodyCustom }
  })
}

// Dump inputs/buttons/textareas/selects within a host element's shadow DOM
// (recursively, up to 2 levels of shadow nesting).
async function dumpFormFields(page, hostSelector) {
  return page.evaluate((sel) => {
    function findHosts(root, depth) {
      var hosts = []
      if (!root || depth < 0) return hosts
      // query by selector in this root
      if (root.querySelector) {
        var found = root.querySelector(sel)
        if (found) hosts.push(found)
      }
      // recurse into shadow roots
      var all = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          var inner = findHosts(all[i].shadowRoot, depth - 1)
          for (var j = 0; j < inner.length; j++) {
            hosts.push(inner[j])
          }
        }
      }
      return hosts
    }
    var hosts = findHosts(document, 3)
    if (hosts.length === 0) return { hostsFound: 0 }
    var fields = []
    function collectFields(root, depth) {
      if (!root || depth < 0) return
      var inputs = root.querySelectorAll ? root.querySelectorAll('input, textarea, select, button, [contenteditable], simple-fields-field, editable-table-display') : []
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i]
        var tag = el.tagName.toLowerCase()
        var id = el.id ? '#' + el.id : ''
        var cls = ''
        if (el.className && typeof el.className === 'string' && el.className.trim()) {
          cls = '.' + el.className.trim().split(/\s+/).join('.')
        }
        var info = {
          tag: tag + id + cls,
          type: el.getAttribute ? el.getAttribute('type') : '',
          name: el.getAttribute ? el.getAttribute('name') : '',
          label: el.getAttribute ? el.getAttribute('label') : '',
          placeholder: el.getAttribute ? el.getAttribute('placeholder') : '',
          value: el.value !== undefined ? String(el.value).substring(0, 60) : '',
          text: el.textContent ? el.textContent.trim().substring(0, 50) : '',
        }
        fields.push(info)
      }
      // recurse into shadow roots of children
      var all = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) {
          collectFields(all[j].shadowRoot, depth - 1)
        }
      }
    }
    for (var h = 0; h < hosts.length; h++) {
      collectFields(hosts[h], 2)
    }
    return { hostsFound: hosts.length, fields: fields }
  }, hostSelector)
}

// --- main -------------------------------------------------------------------
async function main() {
  section('DISCOVERY-SETTINGS: booting E2E runtime')
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
    const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    logJSON('CREATE SITE', { status: createResp.status, url: createResp.url })
    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    console.log('relocated:', relocated)

    section('navigate into site editor')
    const editorUrl = runtime.baseUrl + '/_sites/' + EXPECTED_SITE_NAME + '/'
    console.log('editorUrl:', editorUrl)
    try {
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      console.log('networkidle2 timed out, retrying domcontentloaded')
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
    await new Promise((r) => setTimeout(r, 4000))

    section('wait for #manifestbtn enabled')
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
    logJSON('manifestbtn ready', !!manifestReady)

    // Dump the editor chrome buttons before clicking
    const chromeBefore = await page.evaluate(() => {
      var ui = document.querySelector('haxcms-site-editor-ui')
      if (!ui || !ui.shadowRoot) return null
      var btns = {}
      var ids = ['#editbutton', '#cancelbutton', '#outlinebutton', '#addpagebutton', '#manifestbtn', '#exportbtn']
      ids.forEach(function (id) {
        var el = ui.shadowRoot.querySelector(id)
        if (el) {
          btns[id] = {
            tag: el.tagName.toLowerCase(),
            label: el.getAttribute('label') || el.label || '',
            icon: el.getAttribute('icon') || '',
            disabled: el.hasAttribute('disabled'),
            hidden: el.hasAttribute('hidden'),
          }
        }
      })
      return btns
    })
    logJSON('EDITOR CHROME (before manifest click)', chromeBefore)
    evidence.editorChromeBefore = chromeBefore

    section('click #manifestbtn to open settings modal')
    const clickResult = await clickEditorButtonById(page, '#manifestbtn')
    logJSON('MANIFEST CLICK', clickResult)
    await new Promise((r) => setTimeout(r, 3000))

    section('dump all custom elements + modals after manifest click')
    const allEls = await dumpAllCustomElements(page)
    logJSON('ALL CUSTOM ELEMENTS + MODALS', allEls)
    evidence.allElementsAfterClick = allEls

    // Try to find the settings dialog host. It could be in a simple-modal
    // (light DOM) or directly on document.body.
    section('search for settings dialog host')
    const dialogSearch = await page.evaluate(() => {
      // Check simple-modals for known dialog tags
      var knownDialogs = [
        'haxcms-site-editor-ui',
        'haxcms-manifest-editor',
        'haxcms-manifest-editor-dialog',
        'site-manifest',
        'hax-manifest',
        'haxcms-site-settings',
        'haxcms-site-settings-dialog',
        'haxcms-outline-editor-dialog',
        'app-hax-site-settings',
        'editable-table-display',
      ]
      var found = {}
      // check simple-modal light children
      var modals = document.querySelectorAll('simple-modal')
      for (var i = 0; i < modals.length; i++) {
        for (var k = 0; k < knownDialogs.length; k++) {
          var el = modals[i].querySelector(knownDialogs[k])
          if (el) {
            found[knownDialogs[k]] = {
              where: 'simple-modal[' + i + '] light DOM',
              hasShadow: !!el.shadowRoot,
              opened: modals[i].opened === true,
            }
          }
        }
      }
      // check document body
      for (var k2 = 0; k2 < knownDialogs.length; k2++) {
        var el2 = document.body.querySelector(knownDialogs[k2])
        if (el2 && !found[knownDialogs[k2]]) {
          found[knownDialogs[k2]] = {
            where: 'document.body',
            hasShadow: !!el2.shadowRoot,
          }
        }
      }
      // also list ALL custom elements in simple-modal light DOM
      var modalChildren = []
      for (var m = 0; m < modals.length; m++) {
        var children = modals[m].children
        for (var c = 0; c < children.length; c++) {
          var tag = children[c].tagName.toLowerCase()
          if (tag.indexOf('-') !== -1) {
            modalChildren.push({
              modalIndex: m,
              tag: tag,
              id: children[c].id || '',
              hasShadow: !!children[c].shadowRoot,
            })
          }
        }
      }
      return { found: found, modalChildren: modalChildren }
    })
    logJSON('DIALOG SEARCH', dialogSearch)
    evidence.dialogSearch = dialogSearch

    // If we found the dialog, dump its full shadow tree
    section('dump settings dialog shadow tree')
    var dialogTag = null
    if (dialogSearch && dialogSearch.found) {
      var keys = Object.keys(dialogSearch.found)
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki] !== 'haxcms-site-editor-ui' && keys[ki] !== 'haxcms-outline-editor-dialog') {
          dialogTag = keys[ki]
          break
        }
      }
    }
    if (dialogTag) {
      console.log('Found dialog host:', dialogTag)
      var treeDump = await page.evaluate((tag) => {
        var modals = document.querySelectorAll('simple-modal')
        var el = null
        for (var i = 0; i < modals.length; i++) {
          el = modals[i].querySelector(tag)
          if (el) break
        }
        if (!el) el = document.body.querySelector(tag)
        if (!el || !el.shadowRoot) return { found: false }
        // dump top-level shadow children tags
        var children = []
        for (var j = 0; j < el.shadowRoot.children.length; j++) {
          var child = el.shadowRoot.children[j]
          var info = {
            tag: child.tagName.toLowerCase(),
            id: child.id || '',
            cls: '',
            text: child.textContent ? child.textContent.trim().substring(0, 80) : '',
          }
          if (child.className && typeof child.className === 'string' && child.className.trim()) {
            info.cls = child.className.trim().split(/\s+/).join('.')
          }
          children.push(info)
        }
        return { found: true, tag: tag, shadowChildren: children }
      }, dialogTag)
      logJSON('DIALOG SHADOW TOP-LEVEL', treeDump)
      evidence.dialogShadowTopLevel = treeDump
    } else {
      console.log('No settings dialog host found among known tags.')
      // Dump everything visible as a fallback
      var fullDump = await page.evaluate(() => {
        var modals = document.querySelectorAll('simple-modal')
        var info = { modalCount: modals.length, modals: [] }
        for (var i = 0; i < modals.length; i++) {
          var m = modals[i]
          var mInfo = {
            index: i,
            opened: m.opened === true,
            lightChildren: [],
          }
          for (var j = 0; j < m.children.length; j++) {
            var c = m.children[j]
            mInfo.lightChildren.push({
              tag: c.tagName.toLowerCase(),
              id: c.id || '',
              hasShadow: !!c.shadowRoot,
              text: c.textContent ? c.textContent.trim().substring(0, 100) : '',
            })
          }
          info.modals.push(mInfo)
        }
        return info
      })
      logJSON('FALLBACK FULL MODAL DUMP', fullDump)
      evidence.fallbackModalDump = fullDump
    }

    // Dump form fields in any modal/dialog found
    section('dump form fields in settings dialog')
    if (dialogTag) {
      var formFields = await dumpFormFields(page, dialogTag)
      logJSON('FORM FIELDS in ' + dialogTag, formFields)
      evidence.formFields = formFields
    }

    // Look for tab/panel navigation elements (tabs, buttons with panel names)
    section('search for tabs/panels in settings dialog')
    var tabSearch = await page.evaluate((tag) => {
      var modals = document.querySelectorAll('simple-modal')
      var el = null
      for (var i = 0; i < modals.length; i++) {
        el = modals[i].querySelector(tag)
        if (el) break
      }
      if (!el) el = document.body.querySelector(tag)
      if (!el || !el.shadowRoot) return { found: false }

      // Look for tab-like elements: a11y-collapse, tab elements, buttons with
      // settings-related labels, simple-fields-field, etc.
      var tabCandidates = []
      function searchShadow(root, depth, path) {
        if (!root || depth < 0) return
        var els = root.querySelectorAll ? root.querySelectorAll('a11y-collapse, tab, [role=tab], simple-tab, simple-tabs, button, simple-toolbar-button, .tab, .panel, h2, h3, .hax-modal-btn, .button') : []
        for (var i = 0; i < els.length; i++) {
          var e = els[i]
          var info = {
            tag: e.tagName.toLowerCase(),
            id: e.id || '',
            cls: '',
            text: e.textContent ? e.textContent.trim().substring(0, 60) : '',
            label: e.getAttribute ? e.getAttribute('label') : '',
            icon: e.getAttribute ? e.getAttribute('icon') : '',
            path: path,
          }
          if (e.className && typeof e.className === 'string' && e.className.trim()) {
            info.cls = e.className.trim().split(/\s+/).join('.')
          }
          tabCandidates.push(info)
        }
        // recurse
        var all = root.querySelectorAll ? root.querySelectorAll('*') : []
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) {
            searchShadow(all[j].shadowRoot, depth - 1, path + ' > ' + all[j].tagName.toLowerCase())
          }
        }
      }
      searchShadow(el.shadowRoot, 3, tag)
      return { found: true, tabCandidates: tabCandidates.slice(0, 100) }
    }, dialogTag || 'simple-modal')
    logJSON('TAB/PANEL CANDIDATES', tabSearch)
    evidence.tabCandidates = tabSearch

    // Try clicking through any tab/panel buttons we found and dump fields each time
    if (dialogTag && tabSearch && tabSearch.tabCandidates) {
      var tabLabels = ['Appearance', 'SEO', 'Blocks', 'Editor', 'Details', 'Manifest', 'Theme', 'Settings']
      for (var ti = 0; ti < tabLabels.length; ti++) {
        var label = tabLabels[ti]
        section('try clicking tab/panel: ' + label)
        var clickTab = await page.evaluate((tag, labelText) => {
          var modals = document.querySelectorAll('simple-modal')
          var el = null
          for (var i = 0; i < modals.length; i++) {
            el = modals[i].querySelector(tag)
            if (el) break
          }
          if (!el) el = document.body.querySelector(tag)
          if (!el || !el.shadowRoot) return { error: 'no dialog' }

          function findAndClick(root, depth) {
            if (!root || depth < 0) return false
            // try a11y-collapse heading buttons
            var collapses = root.querySelectorAll ? root.querySelectorAll('a11y-collapse') : []
            for (var i = 0; i < collapses.length; i++) {
              var heading = collapses[i].getAttribute('heading') || collapses[i].heading || ''
              if (String(heading).toLowerCase().indexOf(labelText.toLowerCase()) !== -1) {
                // click the heading button
                var btn = collapses[i].shadowRoot ? collapses[i].shadowRoot.querySelector('#heading') : null
                if (btn) {
                  btn.click()
                  return { clicked: 'a11y-collapse', heading: heading }
                }
                collapses[i].click()
                return { clicked: 'a11y-collapse-direct', heading: heading }
              }
            }
            // try buttons with matching text
            var btns = root.querySelectorAll ? root.querySelectorAll('button, simple-toolbar-button, .hax-modal-btn, .button, [role=tab], tab') : []
            for (var j = 0; j < btns.length; j++) {
              var t = btns[j].textContent ? btns[j].textContent.trim() : ''
              var l = btns[j].getAttribute ? (btns[j].getAttribute('label') || '') : ''
              if (t.toLowerCase().indexOf(labelText.toLowerCase()) !== -1 || l.toLowerCase().indexOf(labelText.toLowerCase()) !== -1) {
                var inner = btns[j].shadowRoot ? btns[j].shadowRoot.querySelector('button') : null
                if (inner) inner.click()
                else btns[j].click()
                return { clicked: 'button', text: t, label: l, tag: btns[j].tagName.toLowerCase() }
              }
            }
            // recurse into shadow roots
            var all = root.querySelectorAll ? root.querySelectorAll('*') : []
            for (var k = 0; k < all.length; k++) {
              if (all[k].shadowRoot) {
                var r = findAndClick(all[k].shadowRoot, depth - 1)
                if (r) return r
              }
            }
            return false
          }
          return findAndClick(el.shadowRoot, 3)
        }, dialogTag, label)
        logJSON('TAB CLICK ' + label, clickTab)
        if (clickTab && clickTab.clicked) {
          await new Promise((r) => setTimeout(r, 1500))
          var panelFields = await dumpFormFields(page, dialogTag)
          logJSON('FIELDS after ' + label, panelFields)
          evidence['panel_' + label] = panelFields
        }
      }
    }

    // Check for a Save/Submit button in the dialog
    section('search for save/submit buttons')
    var saveSearch = await page.evaluate((tag) => {
      var modals = document.querySelectorAll('simple-modal')
      var el = null
      for (var i = 0; i < modals.length; i++) {
        el = modals[i].querySelector(tag)
        if (el) break
      }
      if (!el) el = document.body.querySelector(tag)
      if (!el || !el.shadowRoot) return { found: false }
      var saveBtns = []
      function searchShadow(root, depth) {
        if (!root || depth < 0) return
        var els = root.querySelectorAll ? root.querySelectorAll('button, .button, .hax-modal-btn, simple-toolbar-button') : []
        for (var i = 0; i < els.length; i++) {
          var t = els[i].textContent ? els[i].textContent.trim() : ''
          var l = els[i].getAttribute ? (els[i].getAttribute('label') || '') : ''
          if (t.toLowerCase().indexOf('save') !== -1 || t.toLowerCase().indexOf('submit') !== -1 || t.toLowerCase().indexOf('update') !== -1 ||
              l.toLowerCase().indexOf('save') !== -1 || l.toLowerCase().indexOf('submit') !== -1 || l.toLowerCase().indexOf('update') !== -1) {
            saveBtns.push({
              tag: els[i].tagName.toLowerCase(),
              id: els[i].id || '',
              cls: els[i].className || '',
              text: t.substring(0, 40),
              label: l,
            })
          }
        }
        var all = root.querySelectorAll ? root.querySelectorAll('*') : []
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) {
            searchShadow(all[j].shadowRoot, depth - 1)
          }
        }
      }
      searchShadow(el.shadowRoot, 3)
      return { found: true, saveButtons: saveBtns }
    }, dialogTag || 'simple-modal')
    logJSON('SAVE BUTTONS', saveSearch)
    evidence.saveButtons = saveSearch

    // Capture any API requests that happened during discovery
    section('captured API requests')
    var allReqs = reqWatch.getAll()
    allReqs.forEach(function (r, i) {
      console.log('[' + i + '] ' + r.method + ' ' + r.url)
      if (r.postData) {
        console.log('  postData (first 300): ' + r.postData.substring(0, 300))
      }
    })
    evidence.apiRequests = allReqs.map(function (r) {
      return { url: r.url, method: r.method, postData: r.postData.substring(0, 500) }
    })

    section('DISCOVERY-SETTINGS: SUMMARY')
    console.log('Evidence keys: ' + Object.keys(evidence).join(', '))
  } catch (err) {
    console.error('DISCOVERY-SETTINGS FAILED:', err && err.stack ? err.stack : err)
    try {
      var dump = await page.evaluate(() => document.body.innerHTML.substring(0, 1500))
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
  console.error('DISCOVERY-SETTINGS TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
