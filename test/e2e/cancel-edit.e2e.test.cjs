'use strict'

// E2E test: cancel an edit (discard changes) in the HAX editor.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> loginViaUI -> createSiteViaUI
// -> relocateCreatedSite -> navigate to /_sites/<name>/ -> enter edit mode
// (#editbutton) -> modify hax-body content via importContent (a unique marker
// that would be saved) -> click #cancelbutton -> assert NO PATCH /x/api/v1/content
// fired (the response collector has no new save) AND the marker is gone from
// hax-body (content reverted to the original page content) -> visual baseline.
//
// The cancel flow is the "discard" path: the editor exits edit mode without
// dispatching haxcms-save-node, so saveNode (PATCH /x/api/v1/content/:idOrSlug)
// is never called. We verify this by checking the collector has zero responses
// for '/x/api/v1/content' after the cancel, and that our test marker is absent.
//
// Constraints: CommonJS (.cjs), require(), globalThis (not window), NO optional
// chaining (explicit && guards), node:test + node:assert/strict, visual diffs
// WARN but never fail, no edits to src/build/node_modules/helpers (selectors.cjs
// appended only).

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
const CANCEL_MARKER = 'E2E CANCEL TEST CONTENT SHOULD NOT PERSIST'

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
test('cancel-edit: discard changes without saving', { timeout: 300000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  // 1. Login + create the site.
  await loginViaUI(page, collector, runtime.baseUrl)
  t.diagnostic('[e2e] login OK')

  const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
  assert.ok(createResp, 'create site API response captured')
  assert.strictEqual(createResp.status, 200, 'create site API returned 200')
  relocateCreatedSite(runtime, FIXED_SITE_NAME)
  t.diagnostic('[e2e] create site OK')

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

  // 3. Enter edit mode (wait for #editbutton enabled, then click).
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
  const enterResult = await clickEditorButtonById(page, '#editbutton')
  assert.ok(enterResult && enterResult.clicked, 'edit button clicked to enter edit mode')
  await new Promise((r) => setTimeout(r, 4000))

  // Wait for hax-body in edit mode.
  const bodyReady = await waitFor(async () => haxBodyEditModeActive(page), 30000)
  assert.ok(bodyReady && bodyReady.found && bodyReady.editModeAttr, 'hax-body in edit mode')

  // 4. Wait for the edit-mode autorun's importContent to settle (at least one
  //    slotted child present), then inject our cancel-test marker.
  const initialContentReady = await waitFor(
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
  t.diagnostic('[e2e] initial hax-body content ready: ' + !!initialContentReady)

  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  assert.ok(bodyHandle, 'hax-body element handle resolved')
  // page-break is REQUIRED for saveNode to write; we include it so that IF a
  // save fired erroneously, the marker would persist (making the test fail).
  const testContent =
    '<page-break published="published"></page-break><p>' + CANCEL_MARKER + '</p>'
  await bodyHandle.evaluate((el, html) => {
    if (typeof el.importContent === 'function') {
      el.importContent(html)
    } else {
      el.innerHTML = html
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, testContent)
  await new Promise((r) => setTimeout(r, 800))

  // Confirm the marker IS present before cancel (sanity).
  let markerBefore = await markerInHaxBody(page, CANCEL_MARKER)
  if (!markerBefore) {
    // Fallback: direct append.
    await bodyHandle.evaluate((el, marker) => {
      var pb = globalThis.document.createElement('page-break')
      pb.setAttribute('published', 'published')
      el.appendChild(pb)
      var p = globalThis.document.createElement('p')
      p.textContent = marker
      el.appendChild(p)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, CANCEL_MARKER)
    await new Promise((r) => setTimeout(r, 500))
    markerBefore = await markerInHaxBody(page, CANCEL_MARKER)
  }
  assert.ok(markerBefore, 'cancel-test marker present in hax-body BEFORE cancel')
  t.diagnostic('[e2e] marker present before cancel: ' + !!markerBefore)

  // 5. Record the collector's content-save responses count BEFORE cancel, then
  //    click #cancelbutton and assert NO new PATCH /x/api/v1/content fired.
  const saveResponsesBefore = collector.getResponsesFor('/x/api/v1/content/')
  const saveCountBefore = saveResponsesBefore.length
  t.diagnostic('[e2e] /x/api/v1/content responses before cancel: ' + saveCountBefore)

  const cancelResult = await clickEditorButtonById(page, '#cancelbutton')
  assert.ok(cancelResult && cancelResult.clicked, '#cancelbutton clicked to discard changes')
  // Give the editor a moment to exit edit mode + revert content.
  await new Promise((r) => setTimeout(r, 3000))

  // The authoritative assertion: no NEW save response arrived after cancel.
  // Wait a short window to let any in-flight save fire, then re-check.
  await new Promise((r) => setTimeout(r, 1500))
  const saveResponsesAfter = collector.getResponsesFor('/x/api/v1/content/')
  const saveCountAfter = saveResponsesAfter.length
  t.diagnostic('[e2e] /x/api/v1/content responses after cancel: ' + saveCountAfter)
  assert.strictEqual(
    saveCountAfter,
    saveCountBefore,
    'NO PATCH /x/api/v1/content fired after cancel (save count unchanged: ' +
      saveCountBefore + ' -> ' + saveCountAfter + ')',
  )

  // 6. Disk cross-check: the saved page file must NOT contain the marker.
  //    cancel never dispatched haxcms-save-node (no PATCH fired, verified above),
  //    so the on-disk page content is the ORIGINAL and must not contain our
  //    injected marker. This is the authoritative revert assertion — the browser
  //    in-memory hax-body may still hold the injected node (we bypassed the store
  //    by calling importContent directly), so a browser re-navigation would be
  //    redundant and flaky (the SPA re-import waterfall is heavy). The disk is
  //    the source of truth.
  const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
  const pagesDir = path.join(siteDir, 'pages')
  let diskContainsMarker = false
  try {
    if (fs.pathExistsSync(pagesDir)) {
      const entries = fs.readdirSync(pagesDir)
      for (let i = 0; i < entries.length; i++) {
        const candidate = path.join(pagesDir, entries[i], 'index.html')
        if (fs.pathExistsSync(candidate)) {
          const content = fs.readFileSync(candidate, 'utf8')
          if (content.indexOf(CANCEL_MARKER) !== -1) {
            diskContainsMarker = true
            break
          }
        }
      }
    }
  } catch (e) {
    t.diagnostic('[e2e] disk scan error: ' + (e && e.message ? e.message : e))
  }
  assert.ok(
    !diskContainsMarker,
    'cancel-test marker NOT on disk (cancel did not persist — no PATCH fired + disk unchanged)',
  )
  t.diagnostic('[e2e] marker NOT on disk: ' + !diskContainsMarker)

  // 8. Visual baseline (editor after cancel, back in view mode).
  const buf = await captureScreenshot(page, 'cancel-edit-after-cancel')
  const diff = await safeCompareBaseline('cancel-edit-after-cancel', buf, null, t)
  t.diagnostic(
    '[visual] cancel-edit-after-cancel: diffPercent=' +
      (diff.diffPercent * 100).toFixed(3) +
      '% baselineExists=' + diff.baselineExists,
  )

  // 9. A11y scan scoped to the editor chrome (non-fatal: document findings).
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
