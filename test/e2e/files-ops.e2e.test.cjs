'use strict'

// E2E test: files operations (list / filter / rename / delete) via the files
// API, driven directly by axios.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> loginViaUI -> createSiteViaUI
// -> relocateCreatedSite -> fetch site token (site-scoped connection-settings)
// -> UPLOAD two PNGs (POST /x/api/v1/files multipart) -> LIST (GET) asserts
// count + pagination shape -> FILTER (filter.type=image, filter.extension=png)
// asserts the filters narrow the list -> RENAME one file (PATCH operation:
// 'rename', newName) asserts 200 + new path + new uuid -> DELETE the renamed
// file (DELETE /x/api/v1/files/:uuid, using the POST-RENAME uuid) asserts 200 +
// deleted:true -> LIST asserts the file is gone -> disk cross-check (file
// removed from site/files/). Then delete the second file for cleanup.
//
// The files UI (media-manager / hax-tray-upload) is deep in shadow DOM and
// not required for these operations — the files API is the canonical backend.
// We drive it with axios + Bearer JWT + X-HAXCMS-Site-Token (the same headers
// the editor's API client attaches). This validates the full list/filter/
// rename/delete lifecycle end-to-end against the real server.
//
// NOTE on uuids: the files API generates a deterministic uuid from
// sha256(siteName:canonicalPath:size). After a rename, the path changes so the
// uuid CHANGES. DELETE must use the CURRENT (post-rename) uuid, read from the
// rename response's data.file.uuid. Using the pre-rename uuid triggers a 404
// in resolveRequestedFilePath (a server bug where the 404 is an unhandled
// rejection — we avoid it by using the current uuid).
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

async function filesList(rt, siteName, siteToken, query) {
  const resp = await axios({
    method: 'GET',
    url: filesUrl(rt, siteName),
    headers: authHeaders(rt, siteToken),
    params: query || {},
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

async function filesRename(rt, siteName, siteToken, fileUuid, newName) {
  const resp = await axios({
    method: 'PATCH',
    url: filesUrl(rt, siteName, fileUuid),
    headers: authHeaders(rt, siteToken, { 'content-type': 'application/json' }),
    data: JSON.stringify({ operation: 'rename', newName: newName }),
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
    headers: authHeaders(rt, siteToken),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let body = null
  try { body = JSON.parse(resp.data) } catch (e) { body = null }
  return { status: resp.status, body: body }
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
test('files-ops: list / filter / rename / delete via files API', { timeout: 300000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  // 1. Login + create the site (loginViaUI establishes the JWT the editor
  //    would use; we reuse runtime.jwt for the direct axios calls).
  await loginViaUI(page, collector, runtime.baseUrl)
  const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
  assert.ok(createResp, 'create site API response captured')
  assert.strictEqual(createResp.status, 200, 'create site API returned 200')
  relocateCreatedSite(runtime, FIXED_SITE_NAME)
  t.diagnostic('[e2e] login + create site OK')

  // 2. Fetch the site token (site-scoped connection-settings via referer).
  const siteToken = await fetchSiteToken(runtime, EXPECTED_SITE_NAME)
  assert.ok(siteToken, 'site token fetched via site-scoped connection-settings')

  // 3. LIST files (empty initially).
  const listEmpty = await filesList(runtime, EXPECTED_SITE_NAME, siteToken, {})
  assert.strictEqual(listEmpty.status, 200, 'GET /x/api/v1/files returned 200 (empty)')
  const emptyData = listEmpty.body && listEmpty.body.data ? listEmpty.body.data : null
  assert.ok(emptyData, 'list response has data')
  assert.ok(
    Array.isArray(emptyData.files) && emptyData.files.length === 0,
    'empty site has 0 files',
  )
  assert.ok(
    emptyData.page && typeof emptyData.page.limit === 'number',
    'list response has page.limit',
  )
  assert.strictEqual(emptyData.total, 0, 'empty site total is 0')
  t.diagnostic('[e2e] list empty OK: count=' + emptyData.count + ' total=' + emptyData.total)

  // 4. UPLOAD two PNGs (so we can test pagination + filters + rename + delete).
  const pngA = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer()
  const pngB = await sharp({
    create: { width: 30, height: 30, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).png().toBuffer()
  const upA = await filesUpload(runtime, EXPECTED_SITE_NAME, siteToken, 'e2e-files-a.png', pngA, 'image/png')
  const upB = await filesUpload(runtime, EXPECTED_SITE_NAME, siteToken, 'e2e-files-b.png', pngB, 'image/png')
  assert.strictEqual(upA.status, 200, 'upload A returned 200')
  assert.strictEqual(upB.status, 200, 'upload B returned 200')
  assert.ok(upA.body && upA.body.data && upA.body.data.file, 'upload A has data.file')
  assert.ok(upB.body && upB.body.data && upB.body.data.file, 'upload B has data.file')
  const fileAPath = upA.body.data.file.path
  const fileBPath = upB.body.data.file.path
  t.diagnostic('[e2e] uploads OK: ' + fileAPath + ', ' + fileBPath)

  // 5. LIST files (should now contain both, total=2).
  const listTwo = await filesList(runtime, EXPECTED_SITE_NAME, siteToken, {})
  assert.strictEqual(listTwo.status, 200, 'GET /x/api/v1/files returned 200 (two)')
  const twoData = listTwo.body && listTwo.body.data ? listTwo.body.data : null
  assert.ok(twoData && Array.isArray(twoData.files), 'list response has data.files')
  assert.strictEqual(twoData.files.length, 2, 'list shows 2 files after uploads')
  assert.strictEqual(twoData.total, 2, 'list total is 2')
  // Find the uuids for A and B (deterministic from siteName:path:size).
  const fileA = twoData.files.find((f) => f.path === fileAPath)
  const fileB = twoData.files.find((f) => f.path === fileBPath)
  assert.ok(fileA && fileA.uuid, 'file A in list with uuid')
  assert.ok(fileB && fileB.uuid, 'file B in list with uuid')
  const uuidA = fileA.uuid
  const uuidB = fileB.uuid
  t.diagnostic('[e2e] list two OK: uuidA=' + uuidA + ' uuidB=' + uuidB)

  // 6. FILTER by extension=png — both are png so count=2.
  const listExtPng = await filesList(runtime, EXPECTED_SITE_NAME, siteToken, { 'filter.extension': 'png' })
  assert.strictEqual(listExtPng.status, 200, 'GET /x/api/v1/files?filter.extension=png returned 200')
  const extData = listExtPng.body && listExtPng.body.data ? listExtPng.body.data : null
  assert.ok(extData && Array.isArray(extData.files), 'filter.extension response has data.files')
  assert.strictEqual(extData.files.length, 2, 'filter.extension=png shows 2 files')
  t.diagnostic('[e2e] filter.extension=png OK: count=' + extData.files.length)

  // 7. FILTER by type=image — both are image/png so count=2.
  const listTypeImage = await filesList(runtime, EXPECTED_SITE_NAME, siteToken, { 'filter.type': 'image' })
  assert.strictEqual(listTypeImage.status, 200, 'GET /x/api/v1/files?filter.type=image returned 200')
  const typeData = listTypeImage.body && listTypeImage.body.data ? listTypeImage.body.data : null
  assert.ok(typeData && Array.isArray(typeData.files), 'filter.type response has data.files')
  assert.strictEqual(typeData.files.length, 2, 'filter.type=image shows 2 files')
  t.diagnostic('[e2e] filter.type=image OK: count=' + typeData.files.length)

  // 8. FILTER by a non-matching extension (jpg) — count=0.
  const listExtJpg = await filesList(runtime, EXPECTED_SITE_NAME, siteToken, { 'filter.extension': 'jpg' })
  const jpgData = listExtJpg.body && listExtJpg.body.data ? listExtJpg.body.data : null
  assert.ok(jpgData && Array.isArray(jpgData.files), 'filter.extension=jpg response has data.files')
  assert.strictEqual(jpgData.files.length, 0, 'filter.extension=jpg shows 0 files (no jpgs)')
  t.diagnostic('[e2e] filter.extension=jpg OK: count=' + jpgData.files.length)

  // 9. PAGINATION: page.limit=1 — returns 1 file, total=2.
  const listPaged = await filesList(runtime, EXPECTED_SITE_NAME, siteToken, { 'page.limit': '1' })
  assert.strictEqual(listPaged.status, 200, 'GET /x/api/v1/files?page.limit=1 returned 200')
  const pagedData = listPaged.body && listPaged.body.data ? listPaged.body.data : null
  assert.ok(pagedData, 'paged response has data')
  assert.strictEqual(pagedData.files.length, 1, 'page.limit=1 returns 1 file')
  assert.strictEqual(pagedData.total, 2, 'paged total is still 2')
  assert.ok(pagedData.page && pagedData.page.limit === 1, 'page.limit echoed as 1')
  t.diagnostic('[e2e] pagination OK: count=' + pagedData.files.length + ' total=' + pagedData.total)

  // 10. RENAME file A (PATCH operation:'rename', newName). The extension must
  //     stay the same (the server rejects extension changes). The response
  //     returns the NEW uuid (deterministic from the new path).
  const renameResp = await filesRename(runtime, EXPECTED_SITE_NAME, siteToken, uuidA, 'e2e-files-renamed')
  assert.strictEqual(renameResp.status, 200, 'PATCH rename returned 200')
  const renameData = renameResp.body && renameResp.body.data ? renameResp.body.data : null
  assert.ok(renameData, 'rename response has data')
  assert.strictEqual(renameData.operation, 'rename', 'rename data.operation === "rename"')
  assert.ok(renameData.file, 'rename response has data.file')
  const renamedPath = renameData.file.path
  const renamedUuid = renameData.file.uuid
  assert.ok(
    renamedPath.indexOf('e2e-files-renamed') !== -1 && renamedPath.indexOf('.png') !== -1,
    'renamed path includes the new base name + original extension',
  )
  t.diagnostic('[e2e] rename OK: ' + fileAPath + ' -> ' + renamedPath + ' (uuid ' + uuidA + ' -> ' + renamedUuid + ')')

  // 11. Disk cross-check: the renamed file exists at its new path, the old
  //     path is gone.
  const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
  const renamedDiskPath = path.join(siteDir, renamedPath)
  const oldDiskPath = path.join(siteDir, fileAPath)
  assert.ok(fs.pathExistsSync(renamedDiskPath), 'renamed file exists on disk at new path')
  assert.ok(!fs.pathExistsSync(oldDiskPath), 'old file path gone from disk after rename')

  // 12. DELETE the renamed file using the POST-RENAME uuid (current uuid).
  //     Using the pre-rename uuid would 404 (path no longer resolves).
  const deleteResp = await filesDelete(runtime, EXPECTED_SITE_NAME, siteToken, renamedUuid)
  assert.strictEqual(deleteResp.status, 200, 'DELETE returned 200')
  const deleteData = deleteResp.body && deleteResp.body.data ? deleteResp.body.data : null
  assert.ok(deleteData, 'delete response has data')
  assert.strictEqual(deleteData.operation, 'delete', 'delete data.operation === "delete"')
  assert.strictEqual(deleteData.deleted, true, 'delete data.deleted === true')
  t.diagnostic('[e2e] delete OK: ' + renamedPath + ' deleted')

  // 12b. Regression check for the resolveRequestedFilePath 404 bug: deleting
  //      by the STALE (pre-rename) uuid must return a clean 404, not a 500 or
  //      crash. Before the fix, resolveRequestedFilePath was called outside the
  //      try/catch in deleteFile, so its createStatusError(404) bubbled up as an
  //      unhandled 500. After the fix, deleteFile wraps the call and returns 404.
  const staleDeleteResp = await filesDelete(runtime, EXPECTED_SITE_NAME, siteToken, uuidA)
  assert.strictEqual(
    staleDeleteResp.status,
    404,
    'DELETE by stale (pre-rename) uuid should return 404, got ' +
      staleDeleteResp.status + ' (regression: was 500 before resolveRequestedFilePath was wrapped in try/catch)',
  )
  t.diagnostic('[e2e] stale-uuid delete returns 404 (regression fixed): status=' + staleDeleteResp.status)

  // 13. LIST after delete — should be 1 file (file B).
  const listAfterDelete = await filesList(runtime, EXPECTED_SITE_NAME, siteToken, {})
  assert.strictEqual(listAfterDelete.status, 200, 'GET after delete returned 200')
  const afterDeleteData = listAfterDelete.body && listAfterDelete.body.data ? listAfterDelete.body.data : null
  assert.ok(afterDeleteData && Array.isArray(afterDeleteData.files), 'list after delete has data.files')
  assert.strictEqual(afterDeleteData.files.length, 1, 'list shows 1 file after delete')
  assert.strictEqual(afterDeleteData.total, 1, 'total is 1 after delete')
  // The remaining file should be file B.
  assert.ok(
    afterDeleteData.files.some((f) => f.path === fileBPath),
    'remaining file is file B (the non-renamed, non-deleted one)',
  )
  t.diagnostic('[e2e] list after delete OK: count=' + afterDeleteData.files.length)

  // 14. Disk cross-check: the renamed file is gone from disk.
  assert.ok(!fs.pathExistsSync(renamedDiskPath), 'deleted file gone from disk')

  // 15. Cleanup: delete file B so the site files dir is empty for any later run.
  const cleanupB = await filesDelete(runtime, EXPECTED_SITE_NAME, siteToken, uuidB)
  assert.strictEqual(cleanupB.status, 200, 'cleanup delete B returned 200')
  t.diagnostic('[e2e] cleanup: deleted file B')
})
