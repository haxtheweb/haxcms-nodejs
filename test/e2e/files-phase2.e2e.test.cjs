'use strict'

// E2E test: Phase 2 file entity wiring (#3043) — upload, list (orphans),
// page save (metadata.files uuid strings), file op (files.json upsert),
// delete (uuid scrubbed from pages).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> loginViaUI ->
// createSiteViaUI -> relocateCreatedSite -> fetch site token -> UPLOAD a PNG
// (POST /x/api/v1/files, response path is API path 'files/<name>') -> LIST
// (GET /x/api/v1/files, orphans array present) -> save a page that references
// the file (POST /x/api/v1/content) -> verify site.json metadata.files is
// uuid strings -> file operation (PATCH duplicate) -> verify files.json
// upserted -> DELETE the file -> verify uuid scrubbed from page.metadata.files
// -> teardown.
//
// Reuses the same e2e helpers and setup pattern as files-ops.e2e.test.cjs
// (browser login + site creation, then direct axios API calls for file
// operations).
//
// Constraints: CommonJS (.cjs), require(), globalThis (not window), NO optional
// chaining, node:test + node:assert/strict, no src/build/node_modules/helpers.

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
  selectors,
  FIXED_SITE_NAME,
  deepQuery,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers
  waitFor,
  loginViaUI,
  createSiteViaUI,
  findCreateSiteResponse,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'

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

// --- files API helpers -----------------------------------------------------
function filesUrl(rt, siteName, suffix) {
  const base = rt.baseUrl + '/' + SITES_DIR + '/' + siteName + '/x/api/v1/files'
  return suffix ? base + '/' + suffix : base
}

function authHeaders(rt, siteToken, extra) {
  const h = {
    Authorization: 'Bearer ' + rt.jwt,
    'X-HAXCMS-Site-Token': siteToken,
    accept: 'application/json',
  }
  if (extra) {
    const keys = Object.keys(extra)
    for (let i = 0; i < keys.length; i++) {
      h[keys[i]] = extra[keys[i]]
    }
  }
  return h
}

async function filesList(rt, siteName, siteToken) {
  const resp = await axios({
    method: 'GET',
    url: filesUrl(rt, siteName),
    headers: authHeaders(rt, siteToken),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let body = null
  try { body = JSON.parse(resp.data) } catch (e) { body = null }
  return { status: resp.status, body: body }
}

async function filesUpload(rt, siteName, siteToken, fileName, fileBuffer, mimeType) {
  const form = new FormData()
  form.append('file-upload', fileBuffer, { filename: fileName, contentType: mimeType || 'image/png' })
  const resp = await axios({
    method: 'POST',
    url: filesUrl(rt, siteName),
    headers: authHeaders(rt, siteToken, form.getHeaders()),
    data: form,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  })
  let body = null
  try { body = JSON.parse(resp.data) } catch (e) { body = null }
  return { status: resp.status, body: body }
}

async function fileOperation(rt, siteName, siteToken, fileUuid, operation) {
  const resp = await axios({
    method: 'PATCH',
    url: filesUrl(rt, siteName, fileUuid),
    headers: authHeaders(rt, siteToken, { 'content-type': 'application/json' }),
    data: JSON.stringify({ operation: operation }),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let body = null
  try { body = JSON.parse(resp.data) } catch (e) { body = null }
  return { status: resp.status, body: body }
}

async function filesDelete(rt, siteName, siteToken, fileUuid) {
  const resp = await axios({
    method: 'DELETE',
    url: filesUrl(rt, siteName, fileUuid),
    headers: authHeaders(rt, siteToken, { 'content-type': 'application/json' }),
    data: JSON.stringify({}),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let body = null
  try { body = JSON.parse(resp.data) } catch (e) { body = null }
  return { status: resp.status, body: body }
}

// --- save node (page content) via PATCH /x/api/v1/content/:idOrSlug -----------
// The content route's PATCH handler (updateContent) delegates to saveNodeRoute,
// which writes the page HTML and rebuilds metadata.files as uuid strings.
async function saveNode(rt, siteName, siteToken, nodeId, body) {
  const resp = await axios({
    method: 'PATCH',
    url: rt.baseUrl + '/' + SITES_DIR + '/' + siteName + '/x/api/v1/content/' + encodeURIComponent(nodeId),
    headers: authHeaders(rt, siteToken, { 'content-type': 'application/json' }),
    data: JSON.stringify({
      site: { name: siteName },
      node: {
        id: nodeId,
        body: body,
      },
    }),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let respBody = null
  try { respBody = JSON.parse(resp.data) } catch (e) { respBody = null }
  return { status: resp.status, body: respBody }
}

// --- disk helpers ----------------------------------------------------------
function readSiteJson(rt, siteName) {
  const siteDir = path.join(rt.runtimeRoot, SITES_DIR, siteName)
  const siteJsonPath = path.join(siteDir, 'site.json')
  if (!fs.pathExistsSync(siteJsonPath)) return null
  return JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
}

function readFilesJson(rt, siteName) {
  const siteDir = path.join(rt.runtimeRoot, SITES_DIR, siteName)
  const filesJsonPath = path.join(siteDir, 'files', 'files.json')
  if (!fs.pathExistsSync(filesJsonPath)) return null
  return JSON.parse(fs.readFileSync(filesJsonPath, 'utf8'))
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
test('files-phase2: upload, list (orphans), page save (uuid strings), file op (upsert), delete (scrub)', { timeout: 300000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  // 1. Login + create the site.
  await loginViaUI(page, collector, runtime.baseUrl)
  const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
  assert.ok(createResp, 'create site API response captured')
  assert.strictEqual(createResp.status, 200, 'create site API returned 200')
  relocateCreatedSite(runtime, FIXED_SITE_NAME)
  t.diagnostic('[e2e] login + create site OK')

  // 2. Fetch the site token.
  const siteToken = await fetchSiteToken(runtime, EXPECTED_SITE_NAME)
  assert.ok(siteToken, 'site token fetched via site-scoped connection-settings')

  // 3. UPLOAD a PNG — verify response path is API path 'files/<name>' (fix #2).
  const png = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 128, b: 255 } },
  }).png().toBuffer()
  const uploadResp = await filesUpload(runtime, EXPECTED_SITE_NAME, siteToken, 'phase2-test.png', png, 'image/png')
  assert.strictEqual(uploadResp.status, 200, 'upload returned 200')
  assert.ok(uploadResp.body && uploadResp.body.data && uploadResp.body.data.file, 'upload has data.file')
  const uploadedFile = uploadResp.body.data.file
  // fix #2: path must be the API path 'files/<name>', not an absolute server path.
  assert.strictEqual(uploadedFile.path, 'files/phase2-test.png', 'upload response path is API path files/<name>')
  assert.strictEqual(uploadedFile.url, 'files/phase2-test.png', 'upload response url is API path files/<name>')
  assert.ok(uploadedFile.uuid, 'upload response includes a uuid')
  t.diagnostic('[e2e] upload OK: path=' + uploadedFile.path + ' uuid=' + uploadedFile.uuid)

  // 4. LIST — verify orphans array is present (non-destructive).
  const listResp = await filesList(runtime, EXPECTED_SITE_NAME, siteToken)
  assert.strictEqual(listResp.status, 200, 'list returned 200')
  const listData = listResp.body && listResp.body.data ? listResp.body.data : null
  assert.ok(listData, 'list response has data')
  assert.ok(Array.isArray(listData.files), 'list has files array')
  // The uploaded file should appear in the list.
  const found = listData.files.find(function (f) { return f && f.uuid === uploadedFile.uuid })
  assert.ok(found, 'uploaded file appears in the list')
  // orphans array must be present (non-destructive).
  assert.ok(Array.isArray(listData.orphans), 'list has orphans array (Phase 2)')
  t.diagnostic('[e2e] list OK: count=' + listData.files.length + ' orphans=' + listData.orphans.length)

  // 5. Save a page that references the uploaded file — verify metadata.files
  //    becomes uuid strings in site.json (KEY acceptance criterion).
  const siteJson = readSiteJson(runtime, EXPECTED_SITE_NAME)
  assert.ok(siteJson, 'site.json exists')
  assert.ok(siteJson.items && siteJson.items.length > 0, 'site has at least one page')
  const nodeId = siteJson.items[0].id
  // The HAX editor wraps page content in a leading <page-break> tag;
  // pageBreakParser splits on this, so the body must include it for the
  // saveNode code path to execute (and call rebuildPageFilesUuids).
  const pageHtml = '<page-break item-id="' + nodeId + '"></page-break><p>Phase 2 test page.</p><img src="files/phase2-test.png" alt="test">'
  const saveResp = await saveNode(runtime, EXPECTED_SITE_NAME, siteToken, nodeId, pageHtml)
  assert.strictEqual(saveResp.status, 200, 'saveNode returned 200')
  t.diagnostic('[e2e] page saved with file reference')

  // Read site.json back and verify metadata.files is uuid strings.
  const updatedSiteJson = readSiteJson(runtime, EXPECTED_SITE_NAME)
  const savedPage = updatedSiteJson.items.find(function (i) { return i.id === nodeId })
  assert.ok(savedPage, 'saved page exists in site.json')
  assert.ok(savedPage.metadata, 'page has metadata')
  assert.ok(Array.isArray(savedPage.metadata.files), 'page.metadata.files is an array')
  assert.ok(savedPage.metadata.files.length > 0, 'page.metadata.files has at least one uuid')
  // Every entry must be a string (uuid), never an object.
  for (let i = 0; i < savedPage.metadata.files.length; i++) {
    assert.strictEqual(
      typeof savedPage.metadata.files[i],
      'string',
      'metadata.files[' + i + '] is a uuid string, not an object',
    )
  }
  // The uploaded file's uuid should be in the set.
  assert.ok(
    savedPage.metadata.files.indexOf(uploadedFile.uuid) !== -1,
    'uploaded file uuid is in metadata.files',
  )
  t.diagnostic('[e2e] metadata.files is uuid strings: ' + JSON.stringify(savedPage.metadata.files))

  // 6. File operation (duplicate) — verify files.json is upserted (fix #6).
  const dupResp = await fileOperation(runtime, EXPECTED_SITE_NAME, siteToken, uploadedFile.uuid, 'duplicate')
  assert.strictEqual(dupResp.status, 200, 'duplicate returned 200')
  assert.ok(dupResp.body && dupResp.body.data, 'duplicate has data')
  const dupPath = dupResp.body.data.path
  assert.ok(dupPath, 'duplicate returned a new path')
  t.diagnostic('[e2e] duplicate OK: ' + dupPath)

  // Verify the duplicate is in files.json (upserted after the op).
  const filesJson = readFilesJson(runtime, EXPECTED_SITE_NAME)
  assert.ok(filesJson, 'files.json exists after file op')
  const dupRecord = filesJson.data.files.find(function (f) { return f && f.path === dupPath })
  assert.ok(dupRecord, 'duplicate record is in files.json (upserted)')
  assert.ok(dupRecord.uuid, 'duplicate record has a uuid')
  t.diagnostic('[e2e] files.json upsert verified: dup uuid=' + dupRecord.uuid)

  // 7. DELETE the uploaded file — verify uuid scrubbed from pages.
  const deleteResp = await filesDelete(runtime, EXPECTED_SITE_NAME, siteToken, uploadedFile.uuid)
  assert.strictEqual(deleteResp.status, 200, 'delete returned 200')
  t.diagnostic('[e2e] delete OK')

  // Verify the uuid was scrubbed from page.metadata.files.
  const postDeleteSiteJson = readSiteJson(runtime, EXPECTED_SITE_NAME)
  const postDeletePage = postDeleteSiteJson.items.find(function (i) { return i.id === nodeId })
  assert.ok(postDeletePage, 'page still exists after delete')
  if (postDeletePage.metadata && Array.isArray(postDeletePage.metadata.files)) {
    assert.strictEqual(
      postDeletePage.metadata.files.indexOf(uploadedFile.uuid),
      -1,
      'deleted file uuid scrubbed from page.metadata.files',
    )
  }
  t.diagnostic('[e2e] uuid scrubbed from pages: ' + JSON.stringify(postDeletePage.metadata.files))

  // Verify the record was removed from files.json.
  const postDeleteFilesJson = readFilesJson(runtime, EXPECTED_SITE_NAME)
  if (postDeleteFilesJson) {
    const record = postDeleteFilesJson.data.files.find(function (f) {
      return f && f.uuid === uploadedFile.uuid
    })
    assert.strictEqual(record, undefined, 'deleted file record removed from files.json')
  }

  // 8. Cleanup: delete the duplicate file.
  if (dupRecord && dupRecord.uuid) {
    const cleanupResp = await filesDelete(runtime, EXPECTED_SITE_NAME, siteToken, dupRecord.uuid)
    assert.strictEqual(cleanupResp.status, 200, 'cleanup delete returned 200')
    t.diagnostic('[e2e] cleanup: deleted duplicate')
  }
})
