'use strict'

// E2E test: add a block to the HAX editor and save it.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> loginViaUI -> createSiteViaUI
// -> relocateCreatedSite -> navigate to /_sites/<name>/ -> enter edit mode
// (#editbutton) -> insert a block into hax-body via importContent (a custom
// element tag that HAX can author, e.g. <full-width-image> or a simple <h2>)
// -> assert the tag appears in hax-body -> click Save (#editbutton) -> intercept
// PATCH /x/api/v1/content/:idOrSlug -> assert 200 + data.id -> disk cross-check
// (saved page HTML contains the new tag) -> visual baseline.
//
// The HAX super-daemon / block-browser UI is deep in shadow DOM and flaky to
// drive via clicks. Per the orchestrator's guidance, we use the verified
// importContent path (same as edit-content.e2e.test.cjs) to insert a block,
// then save via the #editbutton click which dispatches haxcms-save-node. This
// exercises the same saveNode -> pageBreakParser -> writeLocation pipeline a
// real block insertion would trigger. The <page-break> tag is REQUIRED for
// saveNode to write the file (pageBreakParser splits by page-break; without one
// no write occurs).
//
// Constraints: CommonJS (.cjs), require(), globalThis (not window), NO optional
// chaining, node:test + node:assert/strict, visual diffs WARN, no src/build/
// node_modules/helpers edits (selectors.cjs appended only).

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
// A block marker that is both a valid HAX-authorable tag and easy to grep on
// disk. We use a heading + a distinctive text marker inside a <p> so the
// pageBreakParser content section contains it.
const BLOCK_MARKER = 'E2E ADDBLOCK MARKER HEADING'

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
test('add-block: insert a block into hax-body and save', { timeout: 300000 }, async (t) => {
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

  // 5. Insert a block (heading + paragraph) via importContent. The page-break
  //    is REQUIRED for saveNode to write the file.
  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  assert.ok(bodyHandle, 'hax-body element handle resolved')
  const blockHtml =
    '<page-break published="published"></page-break>' +
    '<h2>' + BLOCK_MARKER + '</h2>' +
    '<p>Added by the add-block E2E test.</p>'
  await bodyHandle.evaluate((el, html) => {
    if (typeof el.importContent === 'function') {
      el.importContent(html)
    } else {
      el.innerHTML = html
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, blockHtml)
  await new Promise((r) => setTimeout(r, 800))

  // 6. Assert the block marker appears in hax-body before save.
  let blockAppeared = await markerInHaxBody(page, BLOCK_MARKER)
  if (!blockAppeared) {
    // Fallback: direct append of the heading + p after a page-break.
    await bodyHandle.evaluate((el, marker) => {
      var pb = globalThis.document.createElement('page-break')
      pb.setAttribute('published', 'published')
      el.appendChild(pb)
      var h2 = globalThis.document.createElement('h2')
      h2.textContent = marker
      el.appendChild(h2)
      var p = globalThis.document.createElement('p')
      p.textContent = 'Added by the add-block E2E test.'
      el.appendChild(p)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, BLOCK_MARKER)
    await new Promise((r) => setTimeout(r, 500))
    blockAppeared = await markerInHaxBody(page, BLOCK_MARKER)
  }
  assert.ok(blockAppeared, 'block marker appeared in hax-body before save')
  t.diagnostic('[e2e] block marker in hax-body: ' + !!blockAppeared)

  // 7. Visual baseline (editor in edit mode with the new block).
  const editBuf = await captureScreenshot(page, 'add-block-editor')
  const editDiff = await safeCompareBaseline('add-block-editor', editBuf, null, t)
  t.diagnostic(
    '[visual] add-block-editor: diffPercent=' +
      (editDiff.diffPercent * 100).toFixed(3) + '%',
  )

  // 8. Click Save (#editbutton now reads 'Save') + intercept PATCH.
  const saveResult = await clickEditorButtonById(page, '#editbutton')
  assert.ok(saveResult && saveResult.clicked, 'save button clicked: ' + JSON.stringify(saveResult))
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

  // 9. Disk cross-check: the saved page HTML file contains the block marker.
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
    // Fallback: scan pages dir for any index.html containing the marker.
    const pagesDir = path.join(siteDir, 'pages')
    try {
      const entries = fs.readdirSync(pagesDir)
      for (let i = 0; i < entries.length; i++) {
        const candidate = path.join(pagesDir, entries[i], 'index.html')
        if (fs.pathExistsSync(candidate)) {
          const c = fs.readFileSync(candidate, 'utf8')
          if (c.indexOf(BLOCK_MARKER) !== -1) {
            fileContent = c
            break
          }
        }
      }
    } catch (e) { t.diagnostic('[e2e] pages dir scan error: ' + e.message) }
  }
  assert.ok(fileContent, 'saved page HTML file was read from disk')
  assert.ok(
    fileContent.indexOf(BLOCK_MARKER) !== -1,
    'saved page file contains the block marker "' + BLOCK_MARKER + '"',
  )
  t.diagnostic('[e2e] disk cross-check OK: block persisted to ' + pageFilePath)

  // 10. A11y scan (non-fatal: document findings).
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
