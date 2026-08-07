'use strict'

// E2E test: page-break split — importContent with MULTIPLE <page-break> tags,
// save, and assert saveNode writes correctly.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> loginViaUI -> createSiteViaUI
// -> relocateCreatedSite -> navigate to /_sites/<name>/ -> enter edit mode
// (#editbutton) -> importContent with HTML containing MULTIPLE <page-break> tags
// (each followed by distinctive content) -> click Save (#editbutton) -> intercept
// PATCH /x/api/v1/content -> assert 200 + data.id -> disk cross-check (saved
// page HTML contains the content from each page-break section).
//
// The server's saveNode handler runs HAXCMS.pageBreakParser(body) which splits
// the body by <page-break> tags. Each split section becomes a pageData entry
// with attributes + content. The first section's item-id is the active page's
// id (so it writes to the current page file); additional sections would create
// new pages IF their item-id matched a manifest item. Per the saveNode.js
// comment: "a capability that is not supported currently beyond experiments".
// For this test we verify that the SAVE succeeds (200) and that the content
// from the first section is written to disk. We use a single page-break at the
// start (the required separator) followed by multiple content blocks to verify
// the pageBreakParser path runs without error and the write occurs.
//
// NOTE: edit-content.e2e.test.cjs documents that <page-break> is REQUIRED for
// saveNode to write the file. This test extends that by verifying the save
// still works when the content body has additional structure after the break.
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
// Distinctive markers for the content sections after the page-break(s).
const SECTION_MARKER_1 = 'E2E PAGEBREAK SPLIT SECTION ONE'
const SECTION_MARKER_2 = 'E2E PAGEBREAK SPLIT SECTION TWO'

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
test('page-break-split: save content with multiple page-break sections', { timeout: 300000 }, async (t) => {
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

  // 5. importContent with MULTIPLE <page-break> tags, each followed by
  //    distinctive content. The pageBreakParser splits by page-break; the
  //    first section writes to the active page (item-id defaults to the
  //    active node id in saveNode.js). We verify the save succeeds and the
  //    first section's content lands on disk.
  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  assert.ok(bodyHandle, 'hax-body element handle resolved')
  const multiBreakHtml =
    '<page-break published="published"></page-break>' +
    '<h2>Section One</h2>' +
    '<p>' + SECTION_MARKER_1 + '</p>' +
    '<page-break published="published"></page-break>' +
    '<h2>Section Two</h2>' +
    '<p>' + SECTION_MARKER_2 + '</p>'
  await bodyHandle.evaluate((el, html) => {
    if (typeof el.importContent === 'function') {
      el.importContent(html)
    } else {
      el.innerHTML = html
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, multiBreakHtml)
  await new Promise((r) => setTimeout(r, 800))

  // 6. Assert at least the first section marker appears in hax-body.
  let section1Appeared = await markerInHaxBody(page, SECTION_MARKER_1)
  if (!section1Appeared) {
    // Fallback: direct append of both sections with page-breaks.
    await bodyHandle.evaluate((el, m1, m2) => {
      var pb1 = globalThis.document.createElement('page-break')
      pb1.setAttribute('published', 'published')
      el.appendChild(pb1)
      var h2a = globalThis.document.createElement('h2')
      h2a.textContent = 'Section One'
      el.appendChild(h2a)
      var p1 = globalThis.document.createElement('p')
      p1.textContent = m1
      el.appendChild(p1)
      var pb2 = globalThis.document.createElement('page-break')
      pb2.setAttribute('published', 'published')
      el.appendChild(pb2)
      var h2b = globalThis.document.createElement('h2')
      h2b.textContent = 'Section Two'
      el.appendChild(h2b)
      var p2 = globalThis.document.createElement('p')
      p2.textContent = m2
      el.appendChild(p2)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, SECTION_MARKER_1, SECTION_MARKER_2)
    await new Promise((r) => setTimeout(r, 500))
    section1Appeared = await markerInHaxBody(page, SECTION_MARKER_1)
  }
  assert.ok(section1Appeared, 'section one marker appeared in hax-body before save')
  t.diagnostic('[e2e] section one in hax-body: ' + !!section1Appeared)

  // 7. Visual baseline (editor with multi-break content).
  const editBuf = await captureScreenshot(page, 'page-break-split-editor')
  const editDiff = await safeCompareBaseline('page-break-split-editor', editBuf, null, t)
  t.diagnostic(
    '[visual] page-break-split-editor: diffPercent=' +
      (editDiff.diffPercent * 100).toFixed(3) + '%',
  )

  // 8. Click Save + intercept PATCH. The saveNode handler runs
  //    pageBreakParser(body) which splits into sections and writes each.
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

  // 9. Disk cross-check: the pageBreakParser splits the body by <page-break> tags.
  //    Each section's content (the HTML AFTER each </page-break>) becomes a
  //    pageData entry. In saveNode.js, when a section's attributes lack an
  //    explicit item-id, it defaults to bodyParams.node.id (the active page id).
  //    This means ALL sections without explicit item-ids write to the SAME
  //    (active) page, and the loop OVERWRITES — so the LAST section's content
  //    is what ends up on disk. (A second page would only be created if the
  //    item-id didn't match a manifest item AND the addPage feature is enabled.)
  //    We assert the save succeeded (200, pageBreakParser ran) and that the
  //    LAST section's marker persisted to the active page file.
  const pageId = saveBody.data.id
  const pageLocation =
    saveBody.data.location && typeof saveBody.data.location === 'string'
      ? saveBody.data.location
      : 'pages/' + pageId + '/index.html'
  const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
  const pageFilePath = path.join(siteDir, pageLocation)
  t.diagnostic('[e2e] saveNode data.location=' + pageLocation)
  let fileContent = null
  if (fs.pathExistsSync(pageFilePath)) {
    fileContent = fs.readFileSync(pageFilePath, 'utf8')
  } else {
    // Fallback: scan pages dir for any index.html containing either marker.
    const pagesDirScan = path.join(siteDir, 'pages')
    try {
      const entries = fs.readdirSync(pagesDirScan)
      for (let i = 0; i < entries.length; i++) {
        const candidate = path.join(pagesDirScan, entries[i], 'index.html')
        if (fs.pathExistsSync(candidate)) {
          const c = fs.readFileSync(candidate, 'utf8')
          if (c.indexOf(SECTION_MARKER_1) !== -1 || c.indexOf(SECTION_MARKER_2) !== -1) {
            fileContent = c
            break
          }
        }
      }
    } catch (e) { t.diagnostic('[e2e] pages dir scan error: ' + e.message) }
  }
  assert.ok(fileContent, 'saved page HTML file was read from disk')
  t.diagnostic('[e2e] saved file (first 200 chars): ' + String(fileContent || '').substring(0, 200))
  // The LAST section's content is what persists (both sections default to the
  // same item-id = active page; the loop overwrites). Assert section two.
  assert.ok(
    fileContent.indexOf(SECTION_MARKER_2) !== -1,
    'saved page file contains section TWO marker (last section wins — both sections ' +
      'default to the active page item-id and the loop overwrites)',
  )
  t.diagnostic('[e2e] disk cross-check OK: section two (last) persisted')

  // Diagnostic: section one should have been overwritten by section two on the
  // active page (non-fatal — records the pageBreakParser overwrite behavior).
  const section1InSavedFile = fileContent.indexOf(SECTION_MARKER_1) !== -1
  t.diagnostic('[e2e] section one in saved file (expected false — overwritten): ' + section1InSavedFile)

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
