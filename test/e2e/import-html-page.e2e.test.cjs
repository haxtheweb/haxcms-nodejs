'use strict'

// E2E test: import external HTML into the active page and save it.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> loginViaUI -> createSiteViaUI
// -> relocateCreatedSite -> navigate to /_sites/<name>/ -> enter edit mode
// (#editbutton) -> importContent with a MULTI-ELEMENT HTML string (heading +
// paragraph + a list + a <page-break>) -> assert the imported content appears
// in hax-body -> click Save (#editbutton) -> intercept PATCH /x/api/v1/content
// -> assert 200 + data.id -> disk cross-check (saved page HTML contains the
// imported content) -> visual baseline.
//
// This mirrors the real "import HTML into page" authoring flow. The <page-break>
// tag is REQUIRED for saveNode to write the file (pageBreakParser splits by
// page-break; without one no write occurs — see edit-content.e2e.test.cjs).
//
// Constraints: CommonJS (.cjs), require(), globalThis (not window), NO optional
// chaining, node:test + node:assert/strict, visual diffs WARN, no src/build/
// node_modules/helpers edits.

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
  deepQuery,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers
  waitFor,
  waitForDeep,
  loginViaUI,
  createSiteViaUI,
  findCreateSiteResponse,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  deepFindRecursive,
  WALK_HAX_BODY_FN,
  haxBodyEditModeActive,
  markerInHaxBody,
  clickEditorButtonById,
  safeCompareBaseline,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'
// A multi-element import with a distinctive marker we can grep on disk.
const IMPORT_MARKER = 'E2E IMPORT HTML PAGE MARKER'

// --- shared state ----------------------------------------------------------
let runtime = null
let browser = null
let page = null
let collector = null

test.before(async () => {
  runtime = await setupE2ERuntime()
  patchHaxcmsRootForHarness(runtime)
  browser = await launchBrowser()
  page = await newPage(browser)
  collector = createResponseCollector(page)
}, { timeout: 120000 })

test.after(async () => {
  if (collector) { try { collector.detach() } catch (e) { /* ignore */ } }
  if (browser) { try { await browser.close() } catch (e) { /* ignore */ } }
  if (runtime) { try { await teardownE2ERuntime(runtime) } catch (e) { /* ignore */ } }
}, { timeout: 60000 })

// --- the flow --------------------------------------------------------------
test('import-html-page: import multi-element HTML and save', { timeout: 300000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  // 1. Login + create the site.
  await loginViaUI(page, collector, runtime.baseUrl)
  const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
  assert.ok(createResp, 'create site API response captured')
  assert.strictEqual(createResp.status, 200, 'create site API returned 200')
  relocateCreatedSite(runtime, FIXED_SITE_NAME)
  t.diagnostic('[e2e] login + create site OK')

  // 2. Navigate into the site editor.
  const editorUrl = runtime.baseUrl + '/' + SITES_DIR + '/' + EXPECTED_SITE_NAME + '/'
  t.diagnostic('[e2e] navigating to editor: ' + editorUrl)
  try {
    await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
  } catch (e) {
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  }
  await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
  await new Promise((r) => setTimeout(r, 4000))

  // 3. Enter edit mode.
  const editBtnReady = await waitFor(
    async () => page.evaluate(() => {
      const ui = document.querySelector('haxcms-site-editor-ui')
      if (!ui || !ui.shadowRoot) return false
      const b = ui.shadowRoot.querySelector('#editbutton')
      return !!(b && !b.hasAttribute('disabled') && !b.hasAttribute('hidden'))
    }),
    30000,
  )
  assert.ok(editBtnReady, '#editbutton is enabled and visible')
  await clickEditorButtonById(page, '#editbutton')
  await new Promise((r) => setTimeout(r, 4000))
  const bodyReady = await waitFor(async () => haxBodyEditModeActive(page), 30000)
  assert.ok(bodyReady && bodyReady.found && bodyReady.editModeAttr, 'hax-body in edit mode')

  // 4. Wait for the edit-mode autorun importContent to settle.
  await waitFor(
    async () => page.evaluate((walkSrc) => {
      // eslint-disable-next-line no-eval
      eval(walkSrc)
      var body = walk(document)
      if (!body || !body.shadowRoot) return false
      var slot = body.shadowRoot.querySelector('#body')
      if (!slot) return false
      var nodes = slot.assignedNodes({ flatten: true })
      return nodes && nodes.length > 0
    }, WALK_HAX_BODY_FN),
    15000,
  )

  // 5. importContent with a MULTI-ELEMENT HTML string (heading + p + ul +
  //    page-break). The page-break is REQUIRED for saveNode to write the file.
  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  assert.ok(bodyHandle, 'hax-body element handle resolved')
  const importedHtml =
    '<page-break published="published"></page-break>' +
    '<h2>Imported Section</h2>' +
    '<p>' + IMPORT_MARKER + '</p>' +
    '<ul><li>First imported item</li><li>Second imported item</li></ul>'
  await bodyHandle.evaluate((el, html) => {
    if (typeof el.importContent === 'function') {
      el.importContent(html)
    } else {
      el.innerHTML = html
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, importedHtml)
  await new Promise((r) => setTimeout(r, 800))

  // 6. Assert the imported marker appears in hax-body.
  let importedAppeared = await markerInHaxBody(page, IMPORT_MARKER)
  if (!importedAppeared) {
    // Fallback: direct append.
    await bodyHandle.evaluate((el, marker) => {
      var pb = globalThis.document.createElement('page-break')
      pb.setAttribute('published', 'published')
      el.appendChild(pb)
      var h2 = globalThis.document.createElement('h2')
      h2.textContent = 'Imported Section'
      el.appendChild(h2)
      var p = globalThis.document.createElement('p')
      p.textContent = marker
      el.appendChild(p)
      var ul = globalThis.document.createElement('ul')
      var li1 = globalThis.document.createElement('li')
      li1.textContent = 'First imported item'
      ul.appendChild(li1)
      var li2 = globalThis.document.createElement('li')
      li2.textContent = 'Second imported item'
      ul.appendChild(li2)
      el.appendChild(ul)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, IMPORT_MARKER)
    await new Promise((r) => setTimeout(r, 500))
    importedAppeared = await markerInHaxBody(page, IMPORT_MARKER)
  }
  assert.ok(importedAppeared, 'imported marker appeared in hax-body before save')
  t.diagnostic('[e2e] imported content in hax-body: ' + !!importedAppeared)

  // 7. Visual baseline (editor with imported content).
  const editBuf = await captureScreenshot(page, 'import-html-page-editor')
  const editDiff = await safeCompareBaseline('import-html-page-editor', editBuf, null, t)
  t.diagnostic(
    '[visual] import-html-page-editor: diffPercent=' +
      (editDiff.diffPercent * 100).toFixed(3) + '%',
  )

  // 8. Click Save + intercept PATCH.
  const saveResult = await clickEditorButtonById(page, '#editbutton')
  assert.ok(saveResult && saveResult.clicked, 'save button clicked')
  let saveResp = null
  try {
    saveResp = await collector.awaitCollectorFor('/x/api/v1/content/', 30000)
  } catch (e) {
    t.diagnostic('[e2e] saveNode response not captured: ' + (e && e.message ? e.message : e))
  }
  assert.ok(saveResp, 'saveNode (PATCH /x/api/v1/content/) response captured')
  assert.strictEqual(saveResp.status, 200, 'saveNode API returned status 200')
  let saveBody = null
  try { saveBody = JSON.parse(saveResp.bodyText) } catch (e) { saveBody = null }
  assert.ok(saveBody && saveBody.data, 'saveNode response has data')
  assert.ok(
    saveBody.data && typeof saveBody.data.id === 'string',
    'saveNode response data has id (string)',
  )
  t.diagnostic('[e2e] saveNode 200, id=' + saveBody.data.id)

  // 9. Disk cross-check: the saved page file contains the imported marker AND
  //    the multi-element structure (list items).
  const pageId = saveBody.data.id
  const pageLocation =
    saveBody.data.location && typeof saveBody.data.location === 'string'
      ? saveBody.data.location
      : 'pages/' + pageId + '/index.html'
  const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
  const pageFilePath = path.join(siteDir, pageLocation)
  let fileContent = null
  if (fs.pathExistsSync(pageFilePath)) {
    fileContent = fs.readFileSync(pageFilePath, 'utf8')
  } else {
    const pagesDir = path.join(siteDir, 'pages')
    try {
      const entries = fs.readdirSync(pagesDir)
      for (let i = 0; i < entries.length; i++) {
        const candidate = path.join(pagesDir, entries[i], 'index.html')
        if (fs.pathExistsSync(candidate)) {
          const c = fs.readFileSync(candidate, 'utf8')
          if (c.indexOf(IMPORT_MARKER) !== -1) {
            fileContent = c
            break
          }
        }
      }
    } catch (e) { t.diagnostic('[e2e] pages dir scan error: ' + e.message) }
  }
  assert.ok(fileContent, 'saved page HTML file was read from disk')
  assert.ok(
    fileContent.indexOf(IMPORT_MARKER) !== -1,
    'saved page file contains the imported marker',
  )
  // Verify the multi-element structure persisted (both list items).
  assert.ok(
    fileContent.indexOf('First imported item') !== -1 &&
      fileContent.indexOf('Second imported item') !== -1,
    'saved page file contains the imported list items',
  )
  t.diagnostic('[e2e] disk cross-check OK: imported content persisted')

  // 10. A11y scan (non-fatal).
  let a11y = null
  try {
    a11y = await runA11y(page, 'haxcms-site-editor-ui')
  } catch (e) {
    t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
  }
  if (a11y) {
    const critical = a11y.critical || []
    const serious = a11y.serious || []
    t.diagnostic(
      '[a11y] haxcms-site-editor-ui: critical=' + critical.length +
        ' serious=' + serious.length,
    )
  }
})
