'use strict'

// E2E test: insert an image into a page — upload via the files API (axios),
// insert an <img> reference into hax-body, save, assert the files/ reference
// persists on disk.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> loginViaUI -> createSiteViaUI
// -> relocateCreatedSite -> navigate to /_sites/<name>/ -> fetch site token
// (site-scoped connection-settings) -> POST /x/api/v1/files (multipart upload of
// a sharp-generated PNG) -> assert 200 + data.file.path -> enter edit mode
// (#editbutton) -> importContent with an <img src="files/<name>"> + page-break
// -> assert the img appears in hax-body -> click Save (#editbutton) -> intercept
// PATCH /x/api/v1/content -> assert 200 -> disk cross-check (image file exists
// at site/files/<name> AND saved page HTML contains the files/ reference).
//
// The media-manager UI (hax-tray-upload / input#fileInput) is deep in shadow
// DOM and flaky to drive via puppeteer file-setter. Per the orchestrator's
// guidance, we drive the files API directly via axios (POST /x/api/v1/files
// with a multipart form, Bearer JWT + X-HAXCMS-Site-Token), then insert the
// returned file path as an <img src="..."> into hax-body via importContent and
// save. This exercises the same upload + persist pipeline the media-manager UI
// uses, and asserts the image renders in the body + the files/ reference
// survives the save.
//
// Constraints: CommonJS (.cjs), require(), globalThis (not window), NO optional
// chaining, node:test + node:assert/strict, visual diffs WARN, no src/build/
// node_modules/helpers edits.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const axios = require('axios')
const sharp = require('sharp')
const FormData = require('form-data')
const vm = require('node:vm')

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
const IMG_MARKER = 'E2E INSERT IMAGE TEST'

// --- site-token fetch (site-scoped connection-settings) --------------------
function parseConnectionSettingsScript(scriptSource) {
  const sandbox = { window: {} }
  vm.runInNewContext(String(scriptSource || ''), sandbox, { timeout: 1000 })
  return sandbox.window && sandbox.window.appSettings ? sandbox.window.appSettings : null
}

async function fetchSiteToken(rt, siteName) {
  const referer = '/' + SITES_DIR + '/' + siteName + '/'
  const resp = await axios({
    method: 'GET',
    url: rt.baseUrl + '/system/api/v1/session/connection-settings',
    headers: { accept: 'application/javascript', referer: rt.baseUrl + referer },
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  if (resp.status !== 200) return null
  const settings = parseConnectionSettingsScript(resp.data)
  return settings && typeof settings.siteToken === 'string' ? settings.siteToken : null
}

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
test('insert-image: upload image + insert <img> reference + save', { timeout: 300000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  // 1. Login + create the site.
  await loginViaUI(page, collector, runtime.baseUrl)
  const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
  assert.ok(createResp, 'create site API response captured')
  assert.strictEqual(createResp.status, 200, 'create site API returned 200')
  relocateCreatedSite(runtime, FIXED_SITE_NAME)
  t.diagnostic('[e2e] login + create site OK')

  // 2. Fetch the site token (site-scoped connection-settings via referer).
  const siteToken = await fetchSiteToken(runtime, EXPECTED_SITE_NAME)
  assert.ok(siteToken, 'site token fetched via site-scoped connection-settings')

  // 3. Upload a real PNG via POST /x/api/v1/files (multipart, Bearer + token).
  //    Use sharp to generate a valid PNG so MIME detection + sharp validity pass.
  const pngBuffer = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 0, g: 128, b: 255 } },
  }).png().toBuffer()
  const uploadFileName = 'e2e-insert-image.png'
  const uploadUrl =
    runtime.baseUrl + '/' + SITES_DIR + '/' + EXPECTED_SITE_NAME + '/x/api/v1/files'
  const form = new FormData()
  form.append('file-upload', pngBuffer, {
    filename: uploadFileName,
    contentType: 'image/png',
  })
  const uploadResp = await axios({
    method: 'POST',
    url: uploadUrl,
    headers: {
      Authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': siteToken,
      accept: 'application/json',
      ...form.getHeaders(),
    },
    data: form,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  })
  let uploadBody = null
  try { uploadBody = JSON.parse(uploadResp.data) } catch (e) { uploadBody = null }
  assert.strictEqual(uploadResp.status, 200, 'POST /x/api/v1/files returned 200')
  assert.ok(
    uploadBody && uploadBody.data && uploadBody.data.file,
    'upload response has data.file',
  )
  const uploadedFilePath = uploadBody.data.file.path // e.g. "files/e2e-insert-image.png"
  const uploadedFileUrl = uploadBody.data.file.url   // e.g. "files/e2e-insert-image.png"
  assert.ok(
    typeof uploadedFilePath === 'string' && uploadedFilePath.indexOf('files/') === 0,
    'uploaded file path starts with files/',
  )
  t.diagnostic('[e2e] upload OK: ' + uploadedFilePath)

  // 4. Assert the image file exists on disk under the site's files/ dir.
  const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
  const imageDiskPath = path.join(siteDir, uploadedFilePath)
  assert.ok(
    fs.pathExistsSync(imageDiskPath),
    'uploaded image file exists on disk at ' + imageDiskPath,
  )

  // 5. Navigate into the site editor + enter edit mode.
  const editorUrl = runtime.baseUrl + '/' + SITES_DIR + '/' + EXPECTED_SITE_NAME + '/'
  t.diagnostic('[e2e] navigating to editor: ' + editorUrl)
  try {
    await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
  } catch (e) {
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  }
  await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
  await new Promise((r) => setTimeout(r, 4000))

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

  // 6. Wait for the edit-mode autorun importContent to settle.
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

  // 7. Insert an <img src="files/<name>"> + a marker <p> + the required
  //    <page-break> into hax-body. The img src uses the relative files/ path
  //    (the editor resolves it against the site base URL at render time).
  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  assert.ok(bodyHandle, 'hax-body element handle resolved')
  const imgHtml =
    '<page-break published="published"></page-break>' +
    '<p>' + IMG_MARKER + '</p>' +
    '<img src="' + uploadedFileUrl + '" alt="E2E inserted image" />'
  await bodyHandle.evaluate((el, html) => {
    if (typeof el.importContent === 'function') {
      el.importContent(html)
    } else {
      el.innerHTML = html
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, imgHtml)
  await new Promise((r) => setTimeout(r, 800))

  // 8. Assert the marker (and thus the importContent) landed in hax-body.
  let markerAppeared = await markerInHaxBody(page, IMG_MARKER)
  if (!markerAppeared) {
    // Fallback: direct append.
    await bodyHandle.evaluate((el, marker, imgUrl) => {
      var pb = globalThis.document.createElement('page-break')
      pb.setAttribute('published', 'published')
      el.appendChild(pb)
      var p = globalThis.document.createElement('p')
      p.textContent = marker
      el.appendChild(p)
      var img = globalThis.document.createElement('img')
      img.setAttribute('src', imgUrl)
      img.setAttribute('alt', 'E2E inserted image')
      el.appendChild(img)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, IMG_MARKER, uploadedFileUrl)
    await new Promise((r) => setTimeout(r, 500))
    markerAppeared = await markerInHaxBody(page, IMG_MARKER)
  }
  assert.ok(markerAppeared, 'image-insert marker appeared in hax-body before save')
  t.diagnostic('[e2e] img + marker in hax-body: ' + !!markerAppeared)

  // 9. Visual baseline (editor with the inserted image).
  const editBuf = await captureScreenshot(page, 'insert-image-editor')
  const editDiff = await safeCompareBaseline('insert-image-editor', editBuf, null, t)
  t.diagnostic(
    '[visual] insert-image-editor: diffPercent=' +
      (editDiff.diffPercent * 100).toFixed(3) + '%',
  )

  // 10. Click Save + intercept PATCH.
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
  t.diagnostic('[e2e] saveNode 200, id=' + (saveBody.data && saveBody.data.id))

  // 11. Disk cross-check: the saved page file contains the files/ reference.
  const pageId = saveBody.data.id
  const pageLocation =
    saveBody.data.location && typeof saveBody.data.location === 'string'
      ? saveBody.data.location
      : 'pages/' + pageId + '/index.html'
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
          if (c.indexOf(IMG_MARKER) !== -1) {
            fileContent = c
            break
          }
        }
      }
    } catch (e) { t.diagnostic('[e2e] pages dir scan error: ' + e.message) }
  }
  assert.ok(fileContent, 'saved page HTML file was read from disk')
  assert.ok(
    fileContent.indexOf(uploadedFileUrl) !== -1,
    'saved page file contains the files/ image reference "' + uploadedFileUrl + '"',
  )
  assert.ok(
    fileContent.indexOf(IMG_MARKER) !== -1,
    'saved page file contains the image-insert marker',
  )
  t.diagnostic('[e2e] disk cross-check OK: image reference persisted')

  // 12. A11y scan (non-fatal).
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
