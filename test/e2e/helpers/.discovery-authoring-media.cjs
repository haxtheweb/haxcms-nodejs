'use strict'

// Discovery script v3 (dotfile, ignored by node --test glob).
// Boots the E2E harness, logs in, creates HAXSITEAUTOMATEDTESTING, enters the
// site editor edit mode, and maps the UNVERIFIED authoring-media surfaces:
//   A) SUPER-DAEMON / HAX-TRAY — the block-insertion UI (#addpagebutton,
//      hax-tray, super-daemon, hax-app). Dumps tag names, shadow children,
//      button labels, and any file-input / media-manager surfaces.
//   B) MEDIA-MANAGER — file input + upload trigger inside the HAX tray /
//      super-daemon. Looks for input[type=file], simple-fields-upload,
//      hax-tray-upload, media-manager elements.
//   C) FILES API — direct axios calls (GET list, POST upload, PATCH rename,
//      DELETE) against /x/api/v1/files with Bearer JWT + X-HAXCMS-Site-Token,
//      to lock the request/response shapes for the files-ops test.
//
// Run: node test/e2e/helpers/.discovery-authoring-media.cjs  (from repo root)

const path = require('path')
const fs = require('fs-extra')
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
  waitForDeep,
  typeIntoShadow,
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
} = require('./index.cjs')

const SITES_DIR = '_sites'
const SITE_NAME_LOWER = FIXED_SITE_NAME.toLowerCase()

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

// --- dump the editor chrome buttons + look for super-daemon / hax-tray -----
async function dumpEditorChrome(page) {
  return page.evaluate(() => {
    const ui = document.querySelector('haxcms-site-editor-ui')
    function buttonsInShadow(host) {
      if (!host || !host.shadowRoot) return null
      const out = {}
      const ids = [
        '#editbutton', '#cancelbutton', '#outlinebutton', '#addpagebutton',
        '#manifestbtn', '#content-edit', '#content-map', '#content-add',
        '#exportbtn', '#undo', '#redo', '#sourcebutton', '#traybutton',
        '#addcontentbutton', '#haxTrayButton', '#superdaemonbutton',
      ]
      ids.forEach((id) => {
        const el = host.shadowRoot.querySelector(id)
        if (el) {
          out[id] = {
            tag: el.tagName.toLowerCase(),
            label: el.getAttribute('label') || el.label || '',
            icon: el.getAttribute('icon') || '',
            hidden: el.hasAttribute('hidden'),
            disabled: el.hasAttribute('disabled'),
          }
        }
      })
      const allBtns = host.shadowRoot.querySelectorAll(
        'simple-toolbar-button, haxcms-button-add, simple-icon-button-lite, button',
      )
      const list = []
      for (let i = 0; i < allBtns.length; i++) {
        const b = allBtns[i]
        list.push({
          tag: b.tagName.toLowerCase(),
          id: b.id || '',
          label: b.getAttribute('label') || b.label || '',
          icon: b.getAttribute('icon') || '',
          disabled: b.hasAttribute('disabled'),
          hidden: b.hasAttribute('hidden'),
          text: (b.textContent || '').trim().substring(0, 30),
        })
      }
      return { known: out, all: list }
    }
    return {
      uiFound: !!ui,
      uiHasShadow: !!(ui && ui.shadowRoot),
      uiEditMode: ui ? ui.hasAttribute('edit-mode') : null,
      buttons: buttonsInShadow(ui),
    }
  })
}

// --- recursive search for super-daemon / hax-tray / media-manager ----------
async function dumpAuthoringSurfaces(page) {
  return page.evaluate(() => {
    function findTags(root, tags) {
      const result = {}
      for (let t = 0; t < tags.length; t++) {
        const tag = tags[t]
        const found = []
        function walk(r) {
          if (!r) return
          let match = r.querySelector(tag)
          if (match) found.push(match)
          const all = r.querySelectorAll('*')
          for (let i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) walk(all[i].shadowRoot)
          }
        }
        walk(root)
        result[tag] = found.map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          hasShadow: !!el.shadowRoot,
          classes: typeof el.className === 'string' ? el.className : '',
          shadowChildTags: el.shadowRoot
            ? Array.prototype.slice
                .call(el.shadowRoot.querySelectorAll('*'))
                .map((c) => c.tagName.toLowerCase())
                .filter((v, i, a) => a.indexOf(v) === i)
                .slice(0, 25)
            : [],
        }))
      }
      return result
    }
    return findTags(document, [
      'super-daemon',
      'hax-tray',
      'hax-app',
      'media-manager',
      'simple-fields-upload',
      'hax-tray-upload',
      'hax-upload-field',
      'input[type="file"]',
      'file-input',
    ])
  })
}

// --- dump hax-body slot content (to see what blocks are present) -----------
async function dumpHaxBodyContent(page) {
  return page.evaluate((walkSrc) => {
    // eslint-disable-next-line no-eval
    eval(walkSrc)
    var body = walk(document)
    if (!body || !body.shadowRoot) return { found: false }
    var slot = body.shadowRoot.querySelector('#body')
    if (!slot) return { found: true, slotFound: false }
    var nodes = slot.assignedNodes({ flatten: true })
    return {
      found: true,
      slotFound: true,
      childCount: body.children.length,
      slotNodeCount: nodes.length,
      childTags: Array.prototype.slice
        .call(body.children)
        .map((c) => c.tagName.toLowerCase()),
      slotNodeTags: nodes
        .map((n) => (n && n.tagName ? n.tagName.toLowerCase() : '#text'))
        .slice(0, 20),
    }
  }, WALK_HAX_BODY_FN)
}

// --- files API helpers (axios + Bearer JWT + X-HAXCMS-Site-Token) ----------
function parseConnectionSettingsScript(scriptSource) {
  const sandbox = { window: {} }
  vm.runInNewContext(String(scriptSource || ''), sandbox, { timeout: 1000 })
  return sandbox.window && sandbox.window.appSettings ? sandbox.window.appSettings : null
}

async function fetchSiteToken(runtime, siteName) {
  const referer = '/' + SITES_DIR + '/' + siteName + '/'
  const resp = await axios({
    method: 'GET',
    url: runtime.baseUrl + '/system/api/v1/session/connection-settings',
    headers: { accept: 'application/javascript', referer: runtime.baseUrl + referer },
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  if (resp.status !== 200) return null
  const settings = parseConnectionSettingsScript(resp.data)
  return settings && typeof settings.siteToken === 'string' ? settings.siteToken : null
}

function filesData(respBody) {
  return respBody && respBody.data ? respBody.data : null
}

async function filesList(runtime, siteName, siteToken, query) {
  const url = runtime.baseUrl + '/' + SITES_DIR + '/' + siteName + '/x/api/v1/files'
  const resp = await axios({
    method: 'GET',
    url: url,
    headers: {
      Authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': siteToken,
      accept: 'application/json',
    },
    params: query || {},
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let body = null
  try { body = JSON.parse(resp.data) } catch (e) { body = null }
  return { status: resp.status, body: body, raw: String(resp.data || '').substring(0, 500) }
}

async function filesUpload(runtime, siteName, siteToken, fileName, fileBuffer, mimeType) {
  const url = runtime.baseUrl + '/' + SITES_DIR + '/' + siteName + '/x/api/v1/files'
  const form = new FormData()
  form.append('file-upload', fileBuffer, { filename: fileName, contentType: mimeType || 'image/png' })
  const resp = await axios({
    method: 'POST',
    url: url,
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
  let parsed = null
  try { parsed = JSON.parse(resp.data) } catch (e) { parsed = null }
  return { status: resp.status, body: parsed, raw: String(resp.data || '').substring(0, 600) }
}

async function filesDelete(runtime, siteName, siteToken, fileUuid) {
  const url =
    runtime.baseUrl + '/' + SITES_DIR + '/' + siteName + '/x/api/v1/files/' + fileUuid
  const resp = await axios({
    method: 'DELETE',
    url: url,
    headers: {
      Authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': siteToken,
      accept: 'application/json',
    },
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let parsed = null
  try { parsed = JSON.parse(resp.data) } catch (e) { parsed = null }
  return { status: resp.status, body: parsed, raw: String(resp.data || '').substring(0, 400) }
}

async function filesRename(runtime, siteName, siteToken, fileUuid, newName) {
  const url =
    runtime.baseUrl + '/' + SITES_DIR + '/' + siteName + '/x/api/v1/files/' + fileUuid
  const resp = await axios({
    method: 'PATCH',
    url: url,
    headers: {
      Authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': siteToken,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    data: JSON.stringify({ operation: 'rename', newName: newName }),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d],
  })
  let parsed = null
  try { parsed = JSON.parse(resp.data) } catch (e) { parsed = null }
  return { status: resp.status, body: parsed, raw: String(resp.data || '').substring(0, 400) }
}

// --- main -------------------------------------------------------------------
async function main() {
  section('DISCOVERY-AUTHORING-MEDIA: booting E2E runtime')
  const runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  patchHaxcmsRootForHarness(runtime)

  let browser = null
  let page = null
  let collector = null
  const evidence = {}

  try {
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)

    section('login')
    await loginViaUI(page, collector, runtime.baseUrl)
    logJSON('LOGIN', { ok: true })

    section('create site')
    const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    logJSON('CREATE SITE', { status: createResp ? createResp.status : null })
    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    console.log('relocated:', relocated)

    section('navigate into site editor')
    const editorUrl = runtime.baseUrl + '/' + SITES_DIR + '/' + SITE_NAME_LOWER + '/'
    console.log('editorUrl:', editorUrl)
    try {
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      console.log('networkidle2 timed out, retrying domcontentloaded')
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await waitFor(async () => page.evaluate(() => !!document.querySelector('haxcms-site-editor-ui')), 45000)
    await new Promise((r) => setTimeout(r, 4000))

    section('dump editor chrome (before edit)')
    const chromeBefore = await dumpEditorChrome(page)
    logJSON('EDITOR CHROME (before edit)', chromeBefore)
    evidence.chromeBefore = chromeBefore

    section('enter edit mode')
    await waitFor(
      async () => page.evaluate(() => {
        const ui = document.querySelector('haxcms-site-editor-ui')
        if (!ui || !ui.shadowRoot) return false
        const b = ui.shadowRoot.querySelector('#editbutton')
        return !!(b && !b.hasAttribute('disabled') && !b.hasAttribute('hidden'))
      }),
      30000,
    )
    const enterResult = await clickEditorButtonById(page, '#editbutton')
    logJSON('ENTER EDIT MODE', enterResult)
    await new Promise((r) => setTimeout(r, 4000))

    section('dump editor chrome (after edit)')
    const chromeAfter = await dumpEditorChrome(page)
    logJSON('EDITOR CHROME (after edit)', chromeAfter)
    evidence.chromeAfter = chromeAfter

    section('dump authoring surfaces (super-daemon / hax-tray / media-manager)')
    const surfaces = await dumpAuthoringSurfaces(page)
    logJSON('AUTHORING SURFACES', surfaces)
    evidence.surfaces = surfaces

    section('dump hax-body content (after edit)')
    const bodyContent = await dumpHaxBodyContent(page)
    logJSON('HAX-BODY CONTENT', bodyContent)
    evidence.bodyContent = bodyContent

    // Close any opened dialog/modal by dispatching hide event.
    await page.evaluate(() => {
      globalThis.dispatchEvent(new CustomEvent('simple-modal-hide', { bubbles: true, composed: true }))
    })
    await new Promise((r) => setTimeout(r, 1000))

    section('exit edit mode (cancel) so we can test files API on a clean state')
    await clickEditorButtonById(page, '#cancelbutton')
    await new Promise((r) => setTimeout(r, 2000))

    // ---------- PHASE C: files API via direct axios ----------
    section('PHASE C: files API (direct axios)')
    const siteToken = await fetchSiteToken(runtime, SITE_NAME_LOWER)
    logJSON('SITE TOKEN', { hasToken: !!siteToken, len: siteToken ? siteToken.length : 0 })
    evidence.siteToken = !!siteToken
    if (!siteToken) {
      console.log('WARNING: could not fetch siteToken; files API phase will be limited')
    } else {
      // 1. LIST files (empty initially)
      const listEmpty = await filesList(runtime, SITE_NAME_LOWER, siteToken, {})
      logJSON('FILES LIST (empty)', { status: listEmpty.status, raw: listEmpty.raw })
      evidence.filesListEmpty = { status: listEmpty.status, data: filesData(listEmpty.body) }

      // 2. UPLOAD a real PNG generated by sharp (so MIME + sharp validity pass)
      const pngBuffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()
      const uploadResult = await filesUpload(
        runtime, SITE_NAME_LOWER, siteToken,
        'discovery-test.png', pngBuffer, 'image/png',
      )
      logJSON('FILES UPLOAD', { status: uploadResult.status, raw: uploadResult.raw })
      evidence.filesUpload = { status: uploadResult.status, body: uploadResult.body }

      // 3. LIST files again — should now contain the uploaded file
      const listAfter = await filesList(runtime, SITE_NAME_LOWER, siteToken, {})
      const afterData = filesData(listAfter.body)
      logJSON('FILES LIST (after upload)', {
        status: listAfter.status,
        count: afterData && Array.isArray(afterData.files) ? afterData.files.length : -1,
        total: afterData ? afterData.total : null,
        page: afterData ? afterData.page : null,
        files: afterData && Array.isArray(afterData.files)
          ? afterData.files.map((f) => ({ path: f.path, uuid: f.uuid, name: f.name, mimetype: f.mimetype }))
          : null,
      })
      evidence.filesListAfter = { status: listAfter.status, data: afterData }

      // 4. FILTER by extension=png
      const listFilterExt = await filesList(runtime, SITE_NAME_LOWER, siteToken, { 'filter.extension': 'png' })
      const extData = filesData(listFilterExt.body)
      logJSON('FILES LIST (filter.extension=png)', {
        status: listFilterExt.status,
        count: extData && Array.isArray(extData.files) ? extData.files.length : -1,
      })
      evidence.filesFilterExt = { status: listFilterExt.status, data: extData }

      // 5. FILTER by type=image
      const listFilterType = await filesList(runtime, SITE_NAME_LOWER, siteToken, { 'filter.type': 'image' })
      const typeData = filesData(listFilterType.body)
      logJSON('FILES LIST (filter.type=image)', {
        status: listFilterType.status,
        count: typeData && Array.isArray(typeData.files) ? typeData.files.length : -1,
      })
      evidence.filesFilterType = { status: listFilterType.status, data: typeData }

      // 6. RENAME the uploaded file
      let uploadedUuid = null
      if (afterData && Array.isArray(afterData.files) && afterData.files.length > 0) {
        const png = afterData.files.find((f) => String(f.name || '').indexOf('.png') !== -1)
        if (png) uploadedUuid = png.uuid
      }
      if (uploadedUuid) {
        const renameResult = await filesRename(runtime, SITE_NAME_LOWER, siteToken, uploadedUuid, 'discovery-renamed')
        logJSON('FILES RENAME', { status: renameResult.status, raw: renameResult.raw })
        evidence.filesRename = { status: renameResult.status, body: renameResult.body }

        // 7. DELETE the file
        const deleteResult = await filesDelete(runtime, SITE_NAME_LOWER, siteToken, uploadedUuid)
        logJSON('FILES DELETE', { status: deleteResult.status, raw: deleteResult.raw })
        evidence.filesDelete = { status: deleteResult.status, body: deleteResult.body }

        // 8. LIST after delete — should be empty again
        const listAfterDelete = await filesList(runtime, SITE_NAME_LOWER, siteToken, {})
        const delData = filesData(listAfterDelete.body)
        logJSON('FILES LIST (after delete)', {
          status: listAfterDelete.status,
          count: delData && Array.isArray(delData.files) ? delData.files.length : -1,
        })
        evidence.filesListAfterDelete = { status: listAfterDelete.status, data: delData }
      } else {
        console.log('WARNING: no uploaded png uuid found; skipping rename/delete')
      }

      // 9. pagination: upload 2 files then page.limit=1
      const pngBuffer2 = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer()
      await filesUpload(runtime, SITE_NAME_LOWER, siteToken, 'disc-a.png', pngBuffer2, 'image/png')
      await filesUpload(runtime, SITE_NAME_LOWER, siteToken, 'disc-b.png', pngBuffer2, 'image/png')
      const listPaged = await filesList(runtime, SITE_NAME_LOWER, siteToken, { 'page.limit': '1' })
      const pagedData = filesData(listPaged.body)
      logJSON('FILES LIST (page.limit=1)', {
        status: listPaged.status,
        count: pagedData && Array.isArray(pagedData.files) ? pagedData.files.length : -1,
        total: pagedData ? pagedData.total : null,
        page: pagedData ? pagedData.page : null,
      })
      evidence.filesPaged = { status: listPaged.status, data: pagedData }
      // cleanup all remaining files
      const listFinal = await filesList(runtime, SITE_NAME_LOWER, siteToken, {})
      const finalData = filesData(listFinal.body)
      if (finalData && Array.isArray(finalData.files)) {
        for (let i = 0; i < finalData.files.length; i++) {
          const f = finalData.files[i]
          if (f && f.uuid) {
            await filesDelete(runtime, SITE_NAME_LOWER, siteToken, f.uuid)
          }
        }
      }
    }

    section('DISCOVERY-AUTHORING-MEDIA: SUMMARY')
    console.log('Evidence keys: ' + Object.keys(evidence).join(', '))
  } catch (err) {
    console.error('DISCOVERY-AUTHORING-MEDIA FAILED:', err && err.stack ? err.stack : err)
    try {
      const dump = await page.evaluate(() => document.body.innerHTML.substring(0, 1500))
      console.error('PAGE BODY SNIPPET:', dump)
    } catch (e) { /* ignore */ }
  } finally {
    try { if (collector) collector.detach() } catch (e) { /* ignore */ }
    try { if (browser) await browser.close() } catch (e) { /* ignore */ }
    try { await teardownE2ERuntime(runtime) } catch (e) { /* ignore */ }
    console.log('\nTeardown complete.')
  }
}

main().catch((err) => {
  console.error('DISCOVERY-AUTHORING-MEDIA TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
