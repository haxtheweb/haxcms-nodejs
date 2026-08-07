'use strict'

// Discovery script v2 for the site settings modal sub-panels.
// Opens #manifestbtn, then clicks each dashboard-action button inside
// haxcms-site-settings-dashboard (Appearance, Details, SEO, Editor, Blocks)
// and dumps the resulting sub-panel's form fields + save buttons.
//
// Run: node test/e2e/helpers/.discovery-settings-panels.cjs  (from repo root)

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  selectors,
  FIXED_SITE_NAME,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  waitFor,
  loginViaUI,
  createSiteViaUI,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  clickEditorButtonById,
} = require('./index.cjs')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

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
  function detach() {
    page.off('request', onRequest)
  }
  return { detach, getAll: () => requests.slice() }
}

// Get the haxcms-site-settings-dashboard element handle (in simple-modal light DOM)
async function getSettingsDashboard(page) {
  const handle = await page.evaluateHandle(() => {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      if (modals[i].opened !== true) continue
      var dash = modals[i].querySelector('haxcms-site-settings-dashboard')
      if (dash) return dash
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

// Click a dashboard-action button by text within haxcms-site-settings-dashboard shadowRoot
async function clickDashboardButton(dashboardHandle, buttonText) {
  return dashboardHandle.evaluate((el, text) => {
    if (!el || !el.shadowRoot) return { error: 'no shadowRoot' }
    var btns = el.shadowRoot.querySelectorAll('button.dashboard-action')
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent ? btns[i].textContent.trim() : ''
      if (t.toLowerCase().indexOf(text.toLowerCase()) !== -1) {
        btns[i].click()
        return { clicked: true, text: t, classes: btns[i].className }
      }
    }
    return { error: 'button not found', available: Array.from(btns).map(function (b) { return b.textContent.trim() }) }
  }, buttonText)
}

// Recursively dump form fields (inputs, textareas, selects, buttons, simple-fields)
// within a host element and its shadow descendants, up to `maxDepth` levels.
async function dumpFieldsInHost(page, hostSelector, maxDepth) {
  return page.evaluate((sel, depth) => {
    function findHosts(root, d) {
      var hosts = []
      if (!root || d < 0) return hosts
      if (root.querySelector) {
        var found = root.querySelector(sel)
        if (found) hosts.push(found)
      }
      var all = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          var inner = findHosts(all[i].shadowRoot, d - 1)
          for (var j = 0; j < inner.length; j++) hosts.push(inner[j])
        }
      }
      return hosts
    }
    var hosts = findHosts(document, 3)
    if (hosts.length === 0) return { hostsFound: 0 }
    var fields = []
    function collectFields(root, d) {
      if (!root || d < 0) return
      // collect standard form elements + simple-fields + switches + selects
      var sels = 'input, textarea, select, button, [contenteditable], simple-fields-field, simple-field, editable-table-display, switch, paper-switch, mwc-switch, a11y-collapse, simple-tag, simple-tags, .hax-modal-btn, .button'
      var inputs = root.querySelectorAll ? root.querySelectorAll(sels) : []
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
          type: el.getAttribute ? el.getAttribute('type') || '' : '',
          name: el.getAttribute ? el.getAttribute('name') || '' : '',
          label: el.getAttribute ? el.getAttribute('label') || '' : '',
          placeholder: el.getAttribute ? el.getAttribute('placeholder') || '' : '',
          value: '',
          text: el.textContent ? el.textContent.trim().substring(0, 60) : '',
          checked: el.hasAttribute ? el.hasAttribute('checked') : false,
        }
        if (el.value !== undefined && el.value !== null && String(el.value) !== '') {
          info.value = String(el.value).substring(0, 60)
        }
        fields.push(info)
      }
      var all = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) {
          collectFields(all[j].shadowRoot, d - 1)
        }
      }
    }
    for (var h = 0; h < hosts.length; h++) {
      collectFields(hosts[h], depth || 3)
    }
    return { hostsFound: hosts.length, fields: fields }
  }, hostSelector, maxDepth || 3)
}

// Dump all custom elements in the opened simple-modal (light children + their
// shadow child tags). Used to see what sub-panel opens after clicking a
// dashboard button.
async function dumpModalContents(page) {
  return page.evaluate(() => {
    var modals = document.querySelectorAll('simple-modal')
    var result = { modalCount: modals.length, modals: [] }
    for (var i = 0; i < modals.length; i++) {
      var m = modals[i]
      var mInfo = { index: i, opened: m.opened === true, lightChildren: [] }
      for (var j = 0; j < m.children.length; j++) {
        var c = m.children[j]
        var cInfo = {
          tag: c.tagName.toLowerCase(),
          id: c.id || '',
          hasShadow: !!c.shadowRoot,
          text: c.textContent ? c.textContent.trim().substring(0, 100) : '',
          shadowChildTags: [],
        }
        if (c.shadowRoot) {
          var sels = 'input, textarea, select, button, [contenteditable], simple-fields-field, simple-field, a11y-collapse, switch, .hax-modal-btn, .button, simple-toolbar-button, h2, h3, editable-table-display, simple-tag, simple-tags, simple-fields'
          var shadowEls = c.shadowRoot.querySelectorAll(sels)
          for (var k = 0; k < shadowEls.length; k++) {
            var se = shadowEls[k]
            var seInfo = {
              tag: se.tagName.toLowerCase(),
              id: se.id || '',
              cls: '',
              text: se.textContent ? se.textContent.trim().substring(0, 60) : '',
              label: se.getAttribute ? se.getAttribute('label') || '' : '',
              type: se.getAttribute ? se.getAttribute('type') || '' : '',
              name: se.getAttribute ? se.getAttribute('name') || '' : '',
            }
            if (se.className && typeof se.className === 'string' && se.className.trim()) {
              seInfo.cls = se.className.trim().split(/\s+/).join('.')
            }
            cInfo.shadowChildTags.push(seInfo)
          }
        }
        mInfo.lightChildren.push(cInfo)
      }
      result.modals.push(mInfo)
    }
    return result
  })
}

async function main() {
  section('DISCOVERY-SETTINGS-PANELS: booting E2E runtime')
  const runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  patchHaxcmsRootForHarness(runtime)

  let browser = null
  let page = null
  let collector = null
  let reqWatch = null

  try {
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)
    reqWatch = createRequestWatcher(page)

    section('login')
    await loginViaUI(page, collector, runtime.baseUrl)

    section('create site')
    await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    relocateCreatedSite(runtime, FIXED_SITE_NAME)

    section('navigate into site editor')
    const editorUrl = runtime.baseUrl + '/_sites/' + EXPECTED_SITE_NAME + '/'
    try {
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
    await new Promise((r) => setTimeout(r, 4000))

    section('wait for #manifestbtn enabled + click it')
    await waitFor(
      async () =>
        page.evaluate(() => {
          var ui = document.querySelector('haxcms-site-editor-ui')
          if (!ui || !ui.shadowRoot) return false
          var b = ui.shadowRoot.querySelector('#manifestbtn')
          return !!(b && !b.hasAttribute('disabled') && !b.hasAttribute('hidden'))
        }),
      30000,
    )
    await clickEditorButtonById(page, '#manifestbtn')
    await new Promise((r) => setTimeout(r, 3000))

    section('get haxcms-site-settings-dashboard handle')
    var dashboard = await getSettingsDashboard(page)
    if (!dashboard) {
      console.log('ERROR: haxcms-site-settings-dashboard not found in opened simple-modal')
      return
    }
    console.log('dashboard found')

    // Dump the dashboard shadow buttons
    var dashBtns = await dashboard.evaluate((el) => {
      var btns = el.shadowRoot.querySelectorAll('button.dashboard-action')
      return Array.from(btns).map(function (b) {
        return {
          text: b.textContent.trim(),
          classes: b.className,
          icon: b.querySelector('simple-icon-lite') ? b.querySelector('simple-icon-lite').getAttribute('icon') : '',
        }
      })
    })
    logJSON('DASHBOARD BUTTONS', dashBtns)

    // Now click each settings-related button and dump the resulting sub-panel
    var panelButtons = ['Appearance', 'Details', 'SEO', 'Editor', 'Blocks']
    for (var pi = 0; pi < panelButtons.length; pi++) {
      var btnText = panelButtons[pi]
      section('click dashboard button: ' + btnText)
      var clickResult = await clickDashboardButton(dashboard, btnText)
      logJSON('CLICK ' + btnText, clickResult)
      await new Promise((r) => setTimeout(r, 3000))

      // Dump the modal contents after clicking
      var modalContents = await dumpModalContents(page)
      logJSON('MODAL CONTENTS after ' + btnText, modalContents)

      // Also look for form fields in the new sub-panel
      // The sub-panel might be a new custom element in the simple-modal,
      // or it might replace the dashboard contents.
      var formFields = await page.evaluate(() => {
        var modals = document.querySelectorAll('simple-modal')
        var result = { modalCount: modals.length, panels: [] }
        for (var i = 0; i < modals.length; i++) {
          if (modals[i].opened !== true) continue
          var mInfo = { index: i, lightChildren: [] }
          for (var j = 0; j < modals[i].children.length; j++) {
            var c = modals[i].children[j]
            var cInfo = {
              tag: c.tagName.toLowerCase(),
              id: c.id || '',
              hasShadow: !!c.shadowRoot,
              fields: [],
            }
            if (c.shadowRoot) {
              function collectFields(root, depth) {
                if (!root || depth < 0) return
                var sels = 'input, textarea, select, button, [contenteditable], simple-fields-field, simple-field, a11y-collapse, switch, .hax-modal-btn, .button, simple-toolbar-button, editable-table-display, simple-tag, simple-tags, h2, h3, simple-fields, label'
                var els = root.querySelectorAll(sels)
                for (var k = 0; k < els.length; k++) {
                  var el = els[k]
                  var info = {
                    tag: el.tagName.toLowerCase(),
                    id: el.id || '',
                    cls: '',
                    type: el.getAttribute ? el.getAttribute('type') || '' : '',
                    name: el.getAttribute ? el.getAttribute('name') || '' : '',
                    label: el.getAttribute ? el.getAttribute('label') || '' : '',
                    text: el.textContent ? el.textContent.trim().substring(0, 80) : '',
                    value: '',
                  }
                  if (el.className && typeof el.className === 'string' && el.className.trim()) {
                    info.cls = el.className.trim().split(/\s+/).join('.')
                  }
                  if (el.value !== undefined && el.value !== null && String(el.value) !== '') {
                    info.value = String(el.value).substring(0, 80)
                  }
                  cInfo.fields.push(info)
                }
                var all = root.querySelectorAll ? root.querySelectorAll('*') : []
                for (var m = 0; m < all.length; m++) {
                  if (all[m].shadowRoot) {
                    collectFields(all[m].shadowRoot, depth - 1)
                  }
                }
              }
              collectFields(c.shadowRoot, 4)
            }
            mInfo.lightChildren.push(cInfo)
          }
          result.panels.push(mInfo)
        }
        return result
      })
      logJSON('FORM FIELDS after ' + btnText, formFields)

      // Go back to the dashboard: close the sub-panel by clicking Close or
      // re-opening the settings modal via #manifestbtn
      section('go back to dashboard after ' + btnText)
      // Try clicking a back/close button in the sub-panel
      var backResult = await page.evaluate(() => {
        var modals = document.querySelectorAll('simple-modal')
        for (var i = 0; i < modals.length; i++) {
          if (modals[i].opened !== true) continue
          // look for a back button or close button
          var btns = modals[i].querySelectorAll('button')
          for (var j = 0; j < btns.length; j++) {
            var t = btns[j].textContent ? btns[j].textContent.trim().toLowerCase() : ''
            if (t === 'back' || t === 'cancel' || t === 'close' || t.indexOf('back') !== -1) {
              btns[j].click()
              return { clicked: true, text: t }
            }
          }
          // check shadow roots of light children for back buttons
          for (var k = 0; k < modals[i].children.length; k++) {
            var child = modals[i].children[k]
            if (child && child.shadowRoot) {
              var sBtns = child.shadowRoot.querySelectorAll('button, .button, .hax-modal-btn')
              for (var l = 0; l < sBtns.length; l++) {
                var st = sBtns[l].textContent ? sBtns[l].textContent.trim().toLowerCase() : ''
                if (st === 'back' || st === 'cancel' || st === 'close' || st.indexOf('back') !== -1) {
                  sBtns[l].click()
                  return { clicked: true, text: st, from: 'shadow' }
                }
              }
            }
          }
        }
        return { clicked: false }
      })
      logJSON('BACK from ' + btnText, backResult)
      await new Promise((r) => setTimeout(r, 2000))

      // Re-open the settings modal if it was closed
      var dashboardStillThere = await getSettingsDashboard(page)
      if (!dashboardStillThere) {
        console.log('dashboard gone after back; re-opening via #manifestbtn')
        await clickEditorButtonById(page, '#manifestbtn')
        await new Promise((r) => setTimeout(r, 3000))
        dashboard = await getSettingsDashboard(page)
        if (!dashboard) {
          console.log('ERROR: could not re-open settings dashboard')
          break
        }
      } else {
        dashboard = dashboardStillThere
      }
    }

    section('captured API requests')
    var allReqs = reqWatch.getAll()
    allReqs.forEach(function (r, i) {
      console.log('[' + i + '] ' + r.method + ' ' + r.url)
      if (r.postData) {
        console.log('  postData (first 500): ' + r.postData.substring(0, 500))
      }
    })
  } catch (err) {
    console.error('DISCOVERY-SETTINGS-PANELS FAILED:', err && err.stack ? err.stack : err)
    try {
      var dump = await page.evaluate(() => document.body.innerHTML.substring(0, 1500))
      console.error('PAGE BODY SNIPPET:', dump)
    } catch (e) {}
  } finally {
    try { if (reqWatch) reqWatch.detach() } catch (e) {}
    try { if (collector) collector.detach() } catch (e) {}
    try { if (browser) await browser.close() } catch (e) {}
    try { await teardownE2ERuntime(runtime) } catch (e) {}
    console.log('\nTeardown complete.')
  }
}

main().catch((err) => {
  console.error('DISCOVERY-SETTINGS-PANELS TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
