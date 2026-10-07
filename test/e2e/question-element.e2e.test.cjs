'use strict'

// E2E test: question element answer attributes survive an editor save and
// reload (haxtheweb/issues#3113).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal
// -> create HAXSITEAUTOMATEDTESTING -> enter the site editor -> edit mode ->
// importContent with a multiple-choice whose light-DOM <input> answers mix
// the legacy bare `correct` attribute (existing production content) and the
// canonical `data-correct` form -> Save -> intercept PATCH
// /x/api/v1/content/:idOrSlug -> assert 200 -> disk cross-check (stored HTML
// keeps the correct answer flag; before the fix sanitizeHTMLForStorage
// stripped `correct` and every save erased the answers) -> reload the page
// and verify the rendered multiple-choice still reads the right answer as
// correct -> teardown.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict. Reuses the proven edit-content selector flows verbatim;
// no new selectors are introduced, so no selector discovery pass is needed.
// The browser-side elements come from the server's bundled (published) build,
// so only the legacy read path is hard-asserted in the rendered element; the
// `data-correct` form is logged as a diagnostic.

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
  deepFindRecursive,
  WALK_HAX_BODY_FN,
  haxBodyEditModeActive,
  markerInHaxBody,
  clickEditorButtonById,
  findCreateSiteResponse,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
} = require('./helpers')

// The create API normalises the site name to lowercase, so all API +
// filesystem assertions use the lowercased form to match real behaviour.
const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'
const TEST_MARKER = 'E2E question answer roundtrip'

// --- shared state (populated in before / cleaned in after) -----------------

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

// --- the flow --------------------------------------------------------------

test(
  'question element answers survive editor save + reload (#3113)',
  { timeout: 300000 },
  async (t) => {
    assert.ok(page, 'page initialised in before hook')
    assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

    // 2. Navigate to the dashboard and log in via the two-step modal.
    await page.goto(runtime.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForSelector('app-hax', { timeout: 25000 })
    await page.waitForSelector('simple-modal', { timeout: 25000 })
    // give the login element a moment to stamp its shadow DOM
    await new Promise((r) => setTimeout(r, 1500))

    // step 1: username -> Next
    await loginSetInput(page, 'username', E2E_USER_NAME)
    await new Promise((r) => setTimeout(r, 200))
    await loginClickButton(page, 'Next')
    // step 2: #password appears after Next -> set it -> Login
    await loginSetInput(page, 'password', E2E_USER_PASSWORD)
    await new Promise((r) => setTimeout(r, 200))
    await loginClickButton(page, 'Login')

    const loginResp = await collector.awaitCollectorFor('session/login', 20000)
    assert.strictEqual(loginResp.status, 200, 'login API returned status 200')

    // 3. Wait for the dashboard + create HAXSITEAUTOMATEDTESTING.
    const ucf = await waitForDeep(
      page,
      selectors.dashboard.useCaseFilterChain,
      30000,
    )
    assert.ok(ucf, 'dashboard app-hax-use-case-filter rendered after login')

    await ucf.evaluate((el) => {
      el.continueAction(-1)
    })
    const modalOpen = await waitFor(async () => {
      const m = await deepQuery(page, selectors.create.siteCreationModalChain)
      if (!m) return false
      return m.evaluate((el) => el.open === true)
    }, 15000)
    assert.ok(modalOpen, 'create-site modal opened via continueAction(-1)')

    await waitForDeep(page, selectors.create.siteNameInputChain, 10000)
    await typeIntoShadow(page, selectors.create.siteNameInputChain, FIXED_SITE_NAME)
    await new Promise((r) => setTimeout(r, 300))

    const createBtn = await deepQuery(page, selectors.create.createSiteButtonChain)
    assert.ok(createBtn, 'Create Site button found')
    await createBtn.evaluate((b) => b.click())

    const found = await findCreateSiteResponse(collector, EXPECTED_SITE_NAME, 60000)
    assert.ok(found, 'create site API response captured for ' + EXPECTED_SITE_NAME)
    assert.strictEqual(found.status, 200, 'create site API returned status 200')

    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    t.diagnostic('[e2e] relocated created site into _sites: ' + relocated)

    // 4. Navigate into the site editor.
    const editorUrl = runtime.baseUrl + '/_sites/' + EXPECTED_SITE_NAME + '/'
    t.diagnostic('[e2e] navigating to editor: ' + editorUrl)
    try {
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      t.diagnostic('[e2e] networkidle2 timed out, retrying domcontentloaded: ' + (e && e.message ? e.message : e))
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
    await new Promise((r) => setTimeout(r, 4000))

    // 5. Enter edit mode: wait for #editbutton to be enabled, then click it.
    const editBtnReady = await waitFor(
      async () =>
        page.evaluate(() => {
          const ui = document.querySelector('haxcms-site-editor-ui')
          if (!ui || !ui.shadowRoot) return false
          const b = ui.shadowRoot.querySelector('#editbutton')
          return !!(b && !b.hasAttribute('disabled') && !b.hasAttribute('hidden'))
        }),
      30000,
    )
    assert.ok(editBtnReady, '#editbutton is enabled and visible')
    const enterResult = await clickEditorButtonById(page, '#editbutton')
    assert.ok(
      enterResult && enterResult.clicked,
      'edit button clicked to enter edit mode: ' + JSON.stringify(enterResult),
    )
    await new Promise((r) => setTimeout(r, 4000))

    const bodyReady = await waitFor(async () => haxBodyEditModeActive(page), 30000)
    assert.ok(
      bodyReady && bodyReady.found && bodyReady.editModeAttr,
      'hax-body found in edit mode (edit-mode attribute present)',
    )

    // 6. Locate hax-body, wait for the edit-mode autorun's importContent to
    //    settle, then set our question content. The <page-break> tag is
    //    REQUIRED for the save to write the file (pageBreakParser splits by
    //    page-break tags; without one, no write occurs).
    const bodyHandle = await deepFindRecursive(page, 'hax-body')
    assert.ok(bodyHandle, 'hax-body element handle resolved via recursive walk')
    // #3113: light-DOM answers in BOTH forms — the legacy bare `correct`
    // attribute (every piece of existing production content) plus the
    // canonical `data-correct` serialization.
    const questionContent =
      '<page-break published="published"></page-break>' +
      '<p>' + TEST_MARKER + '</p>' +
      '<multiple-choice question="Which way is up?" quiz-name="e2e-correct-attr">' +
      '<input type="checkbox" value="North" correct>' +
      '<input type="checkbox" value="East" data-correct="true">' +
      '<input type="checkbox" value="South">' +
      '</multiple-choice>'

    const initialContentReady = await waitFor(
      async () =>
        page.evaluate((walkSrc) => {
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

    const typeInfo = await bodyHandle.evaluate((el, html) => {
      if (typeof el.importContent === 'function') {
        el.importContent(html)
      } else {
        el.innerHTML = html
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return {
        usedImportContent: typeof el.importContent === 'function',
        childCount: el.children.length,
      }
    }, questionContent)
    t.diagnostic('[e2e] importContent called: ' + JSON.stringify(typeInfo))

    let contentAppeared = await waitFor(
      async () => markerInHaxBody(page, TEST_MARKER),
      8000,
    )
    t.diagnostic('[e2e] question content appeared via importContent: ' + !!contentAppeared)

    // Fallback: parse the full markup through a <template> and append the
    // nodes directly (page-break must still come first).
    if (!contentAppeared) {
      t.diagnostic('[e2e] importContent did not render; falling back to direct template append')
      await bodyHandle.evaluate((el, html) => {
        var tpl = globalThis.document.createElement('template')
        tpl.innerHTML = html
        while (tpl.content.firstChild) {
          el.appendChild(tpl.content.firstChild)
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }, questionContent)
      await new Promise((r) => setTimeout(r, 500))
      contentAppeared = await waitFor(
        async () => markerInHaxBody(page, TEST_MARKER),
        5000,
      )
      t.diagnostic('[e2e] question content appeared via direct append: ' + !!contentAppeared)
    }
    assert.ok(contentAppeared, 'question content appeared in hax-body before save')

    // 7. Click Save (#editbutton now reads 'Save') + intercept saveNode.
    const saveResult = await clickEditorButtonById(page, '#editbutton')
    assert.ok(
      saveResult && saveResult.clicked,
      'save button (#editbutton) clicked: ' + JSON.stringify(saveResult),
    )
    let saveResp = null
    try {
      saveResp = await collector.awaitCollectorFor('/x/api/v1/content/', 30000)
    } catch (e) {
      t.diagnostic('[e2e] saveNode response not captured: ' + (e && e.message ? e.message : e))
    }
    assert.ok(saveResp, 'saveNode (PATCH /x/api/v1/content/) response captured')
    assert.strictEqual(saveResp.status, 200, 'saveNode API returned status 200')
    let saveBody = null
    try {
      saveBody = JSON.parse(saveResp.bodyText)
    } catch (e) {
      saveBody = null
    }
    t.diagnostic('[e2e] saveNode url=' + saveResp.url)
    assert.ok(saveBody && saveBody.data, 'saveNode response has data')
    assert.ok(
      saveBody.data && typeof saveBody.data.id === 'string',
      'saveNode response data has id (string)',
    )

    // 8. Disk cross-check: the stored page HTML must keep the question and
    //    its correct answer flag. This is the #3113 regression — before the
    //    sanitizer fix, every save stripped `correct` and the stored file had
    //    no correct answer left.
    const pageId = saveBody.data.id
    const pageLocation =
      saveBody.data.location && typeof saveBody.data.location === 'string'
        ? saveBody.data.location
        : 'pages/' + pageId + '/index.html'
    const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
    const pageFilePath = path.join(siteDir, pageLocation)
    t.diagnostic('[e2e] checking page file: ' + pageFilePath)
    let fileContent = null
    if (fs.pathExistsSync(pageFilePath)) {
      fileContent = fs.readFileSync(pageFilePath, 'utf8')
    } else {
      const pagesDir = path.join(siteDir, 'pages')
      t.diagnostic('[e2e] page file not at expected path; listing pages dir: ' + pagesDir)
      try {
        const entries = fs.readdirSync(pagesDir)
        for (let i = 0; i < entries.length; i++) {
          const candidate = path.join(pagesDir, entries[i], 'index.html')
          if (fs.pathExistsSync(candidate)) {
            fileContent = fs.readFileSync(candidate, 'utf8')
            t.diagnostic('[e2e] found page file at: ' + candidate)
            break
          }
        }
      } catch (e2) {
        t.diagnostic('[e2e] cannot list pages dir: ' + e2.message)
      }
    }
    assert.ok(fileContent, 'saved page HTML file was read from disk')
    const mcIndex = fileContent.indexOf('multiple-choice')
    t.diagnostic(
      '[e2e] stored question markup: ' +
        (mcIndex !== -1
          ? fileContent.substring(Math.max(0, mcIndex - 40), mcIndex + 320)
          : 'multiple-choice NOT FOUND'),
    )
    assert.ok(
      mcIndex !== -1,
      'saved page keeps the multiple-choice element',
    )
    assert.ok(
      fileContent.indexOf('value="North"') !== -1,
      'saved page keeps the answer labels (value="North")',
    )
    // Accept either serialization of the correct flag: legacy
    // `value="North" correct="correct"` or the dual-write form
    // `value="North" data-correct="true" ... correct="correct"`.
    const northCorrect =
      fileContent.indexOf('value="North" correct') !== -1 ||
      fileContent.indexOf('value="North" data-correct') !== -1
    assert.ok(
      northCorrect,
      'saved page preserves the correct answer flag for value="North" (#3113)',
    )
    // Build-dependent diagnostic: how the data-correct answer serialized.
    const eastForm =
      fileContent.indexOf('value="East" data-correct') !== -1
        ? 'data-correct'
        : fileContent.indexOf('value="East" correct') !== -1
          ? 'legacy correct'
          : 'not marked correct'
    t.diagnostic('[e2e] East (data-correct authored) answer serialized as: ' + eastForm)

    // 9. Reload the page and verify the rendered multiple-choice still reads
    //    the right answer as correct after the save roundtrip.
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
    // allow the theme to render the page content + the element to upgrade
    await new Promise((r) => setTimeout(r, 4000))
    const questionEl = await waitFor(async () => {
      const handle = await deepFindRecursive(page, 'multiple-choice')
      return handle
    }, 30000)
    assert.ok(questionEl, 'multiple-choice rendered after reload')
    const answersInfo = await waitFor(async () => {
      const info = await questionEl.evaluate((el) => {
        if (!el.answers || el.answers.length < 3) return null
        const north = el.answers.filter((a) => a && a.label === 'North')[0]
        const east = el.answers.filter((a) => a && a.label === 'East')[0]
        const south = el.answers.filter((a) => a && a.label === 'South')[0]
        return {
          count: el.answers.length,
          northCorrect: north ? !!north.correct : null,
          eastCorrect: east ? !!east.correct : null,
          southCorrect: south ? !!south.correct : null,
        }
      })
      return info
    }, 30000)
    t.diagnostic('[e2e] answers after reload: ' + JSON.stringify(answersInfo))
    assert.ok(
      answersInfo && answersInfo.count === 3,
      'multiple-choice loaded all 3 answers after reload',
    )
    assert.strictEqual(
      answersInfo.northCorrect,
      true,
      'legacy correct answer "North" still reads as correct after save + reload (#3113)',
    )
    t.diagnostic('[e2e] roundtrip complete: answers survived save + reload')
  },
)
