'use strict'

// Discovery script for the revisions UI surface (dotfile, ignored by node --test).
// Boots the E2E harness, logs in via the two-step UI, creates
// HAXSITEAUTOMATEDTESTING, edits + saves a page TWICE (so two git commits
// exist), opens the revisions dialog, and dumps:
//   - the revisions dialog DOM (haxcms-page-revisions-dialog shadow structure,
//     table rows, data-action/data-hash buttons)
//   - the revisions list API response (GET /x/api/v1/items/:idOrSlug/revisions)
//   - the revision detail API response (GET .../revisions/:revisionId)
//   - the restore API response (POST .../revisions/:revisionId/restore)
//
// Run: node test/e2e/helpers/.discovery-revisions.cjs  (from repo root)

const path = require('path')
const fs = require('fs-extra')
const axios = require('axios')

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
  loginSetInput,
  loginClickButton,
  deepFindRecursive,
  WALK_HAX_BODY_FN,
  haxBodyEditModeActive,
  markerInHaxBody,
  clickEditorButtonById,
  safeCompareBaseline,
  findCreateSiteResponse,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  loginViaUI,
  createSiteViaUI,
} = require('./index.cjs')

const SITES_DIR = '_sites'
const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

// --- request body capture ---------------------------------------------------
function createRequestWatcher(page) {
  const requests = []
  function onRequest(request) {
    const url = request.url()
    if (
      url.indexOf('/x/api/v1/items') !== -1 ||
      url.indexOf('/x/api/v1/content') !== -1
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
  function getRequestsFor(sub) {
    return requests.filter((r) => r.url.indexOf(sub) !== -1)
  }
  function detach() {
    page.off('request', onRequest)
  }
  return { getRequestsFor, detach, getAll: () => requests.slice() }
}

// Save the current page via the editor (#editbutton toggles to Save in edit mode).
// Returns the saveNode API response record captured by the collector.
async function saveCurrentPage(page, collector, t) {
  const saveResult = await clickEditorButtonById(page, '#editbutton')
  logJSON('SAVE CLICK', saveResult)
  let saveResp = null
  try {
    saveResp = await collector.awaitCollectorFor('/x/api/v1/content/', 30000)
  } catch (e) {
    console.log('saveNode response NOT captured: ' + (e && e.message ? e.message : e))
  }
  if (saveResp) {
    logJSON('SAVE NODE RESPONSE', {
      url: saveResp.url,
      status: saveResp.status,
      bodyFirst300: saveResp.bodyText.substring(0, 300),
    })
  }
  return saveResp
}

// Enter edit mode, inject content via importContent, save. Creates a git commit.
async function editAndSave(page, collector, markerText) {
  // wait for #editbutton to be enabled
  await waitFor(
    async () =>
      page.evaluate(() => {
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

  const bodyReady = await waitFor(async () => haxBodyEditModeActive(page), 30000)
  logJSON('BODY READY', bodyReady)

  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  if (!bodyHandle) throw new Error('hax-body not found for edit+save')
  const testContent =
    '<page-break published="published"></page-break><p>' + markerText + '</p>'
  // wait for initial content to settle
  await waitFor(
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
  await bodyHandle.evaluate((el, html) => {
    if (typeof el.importContent === 'function') {
      el.importContent(html)
    } else {
      el.innerHTML = html
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, testContent)
  await new Promise((r) => setTimeout(r, 1000))
  // fallback: direct append if importContent didn't render
  let appeared = await waitFor(async () => markerInHaxBody(page, markerText), 8000)
  if (!appeared) {
    await bodyHandle.evaluate((el, marker) => {
      var pb = globalThis.document.createElement('page-break')
      pb.setAttribute('published', 'published')
      el.appendChild(pb)
      var p = globalThis.document.createElement('p')
      p.textContent = marker
      el.appendChild(p)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, markerText)
    await new Promise((r) => setTimeout(r, 500))
    appeared = await waitFor(async () => markerInHaxBody(page, markerText), 5000)
  }
  logJSON('CONTENT APPEARED', appeared)

  const saveResp = await saveCurrentPage(page, collector)
  // wait for save to settle + edit mode to disengage
  await new Promise((r) => setTimeout(r, 3000))
  return saveResp
}

// Dump the revisions dialog DOM structure.
async function dumpRevisionsDialog(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('simple-modal')
    let dialog = null
    if (modal) dialog = modal.querySelector('haxcms-page-revisions-dialog')
    if (!dialog) dialog = document.querySelector('haxcms-page-revisions-dialog')
    if (!dialog) return { dialogFound: false }
    const info = {
      dialogFound: true,
      dialogHasShadow: !!dialog.shadowRoot,
      nodeId: dialog.nodeId || '',
      nodeTitle: dialog.nodeTitle || '',
      revisionsCount: Array.isArray(dialog.revisions) ? dialog.revisions.length : -1,
      loading: !!dialog.loading,
      restoring: !!dialog.restoring,
      selectedHash: dialog.selectedHash || '',
      previewMode: dialog.previewMode || '',
    }
    if (dialog.shadowRoot) {
      // table rows + action buttons
      const rows = dialog.shadowRoot.querySelectorAll('tbody tr')
      info.rowCount = rows.length
      info.firstRowButtons = []
      if (rows.length > 0) {
        const btns = rows[0].querySelectorAll('simple-icon-button-lite')
        for (let i = 0; i < btns.length; i++) {
          info.firstRowButtons.push({
            icon: btns[i].getAttribute('icon') || '',
            dataAction: btns[i].getAttribute('data-action') || '',
            dataHash: (btns[i].getAttribute('data-hash') || '').substring(0, 12),
            disabled: btns[i].hasAttribute('disabled'),
            label: btns[i].getAttribute('label') || '',
          })
        }
      }
      // all hashes + which is current (first row)
      info.allHashes = []
      for (let i = 0; i < rows.length; i++) {
        const restoreBtn = rows[i].querySelector('[data-action="restore"]')
        if (restoreBtn) {
          info.allHashes.push({
            index: i,
            hash: (restoreBtn.getAttribute('data-hash') || '').substring(0, 12),
            disabled: restoreBtn.hasAttribute('disabled'),
          })
        }
      }
      // preview area
      const pre = dialog.shadowRoot.querySelector('pre')
      info.previewPreText = pre ? (pre.textContent || '').substring(0, 200) : ''
      info.previewRenderedFound = !!dialog.shadowRoot.querySelector('.preview-rendered')
    }
    return info
  })
}

// Authenticated axios helper for site API (per-site scoped).
function siteApiUrl(runtime, suffix) {
  return (
    runtime.baseUrl +
    '/' +
    SITES_DIR +
    '/' +
    EXPECTED_SITE_NAME +
    '/x/api/v1/' +
    suffix
  )
}

// Generate the X-HAXCMS-Site-Token for authenticated-site routes.
// The token is HMAC(userName + ':' + siteName) computed server-side via the
// HAXCMS singleton (same privateKey+salt the server validates against).
function getSiteToken(runtime) {
  const { HAXCMS } = require('../../../src/lib/HAXCMS.js')
  const userName = HAXCMS.getActiveUserName()
  const siteName = EXPECTED_SITE_NAME
  return HAXCMS.getRequestToken(userName + ':' + siteName)
}

async function siteApiGet(runtime, suffix, params) {
  const headers = {
    Authorization: 'Bearer ' + runtime.jwt,
  }
  // revisions + content mutation routes require the site token
  if (suffix.indexOf('revisions') !== -1) {
    headers['X-HAXCMS-Site-Token'] = getSiteToken(runtime)
  }
  return axios({
    method: 'GET',
    url: siteApiUrl(runtime, suffix),
    headers: headers,
    params: params,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
}

async function siteApiPost(runtime, suffix, body) {
  const headers = {
    Authorization: 'Bearer ' + runtime.jwt,
    'Content-Type': 'application/json',
  }
  if (suffix.indexOf('revisions') !== -1) {
    headers['X-HAXCMS-Site-Token'] = getSiteToken(runtime)
  }
  return axios({
    method: 'POST',
    url: siteApiUrl(runtime, suffix),
    headers: headers,
    data: body,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
}

// --- main -------------------------------------------------------------------
async function main() {
  section('DISCOVERY-REVISIONS: booting E2E runtime')
  const runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  patchHaxcmsRootForHarness(runtime)

  let browser = null
  let page = null
  let collector = null
  let reqWatch = null
  const evidence = {}

  try {
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)
    reqWatch = createRequestWatcher(page)

    section('login')
    await loginViaUI(page, collector, runtime.baseUrl)
    logJSON('LOGIN OK', { jwtLen: runtime.jwt ? runtime.jwt.length : 0 })

    section('create site')
    const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    logJSON('CREATE SITE', { status: createResp ? createResp.status : null })
    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    console.log('relocated:', relocated)

    section('navigate into site editor')
    const editorUrl = runtime.baseUrl + '/_sites/' + EXPECTED_SITE_NAME + '/'
    console.log('editorUrl:', editorUrl)
    try {
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      console.log('networkidle2 timed out, retrying domcontentloaded')
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
    await new Promise((r) => setTimeout(r, 4000))

    section('edit + save #1 (version 1)')
    const marker1 = 'E2E revisions discovery content version 1'
    const save1 = await editAndSave(page, collector, marker1)
    evidence.save1 = save1
      ? { status: save1.status, url: save1.url }
      : null

    section('edit + save #2 (version 2)')
    const marker2 = 'E2E revisions discovery content version 2 DIFFERENT'
    const save2 = await editAndSave(page, collector, marker2)
    evidence.save2 = save2
      ? { status: save2.status, url: save2.url }
      : null

    // Extract the active item id/slug/location from the saveNode API response
    // (the frontend store is not accessible via globalThis.HAXCMS in the browser).
    let activeItemInfo = null
    if (save2 && save2.bodyText) {
      try {
        const save2Body = JSON.parse(save2.bodyText)
        if (save2Body && save2Body.data) {
          activeItemInfo = {
            id: save2Body.data.id,
            slug: save2Body.data.slug,
            title: save2Body.data.title,
            location: save2Body.data.location,
          }
        }
      } catch (e) {
        activeItemInfo = null
      }
    }
    logJSON('ACTIVE ITEM (from saveNode response)', activeItemInfo)
    evidence.activeItem = activeItemInfo

    section('API: GET revisions list (axios)')
    if (activeItemInfo && activeItemInfo.id) {
      const lookupValue = activeItemInfo.slug || activeItemInfo.id
      const listResp = await siteApiGet(
        runtime,
        'items/' + encodeURIComponent(lookupValue) + '/revisions',
      )
      logJSON('REVISIONS LIST API', {
        status: listResp.status,
        bodyFirst600: String(listResp.data || '').substring(0, 600),
      })
      let listBody = null
      try {
        listBody = JSON.parse(String(listResp.data || ''))
      } catch (e) {
        listBody = null
      }
      evidence.revisionsList = listBody
        ? {
            status: listBody.status,
            count: listBody.data && listBody.data.count,
            total: listBody.data && listBody.data.total,
            firstRevision: listBody.data && listBody.data.revisions && listBody.data.revisions[0],
            secondRevision: listBody.data && listBody.data.revisions && listBody.data.revisions[1],
          }
        : null

      // Pick the SECOND revision (older) for detail + restore.
      const revisions =
        listBody && listBody.data && Array.isArray(listBody.data.revisions)
          ? listBody.data.revisions
          : []
      if (revisions.length >= 2) {
        const olderRevision = revisions[1]
        const olderHash = olderRevision ? olderRevision.hash : ''
        section('API: GET revision detail (axios) for older hash: ' + olderHash.substring(0, 12))
        const detailResp = await siteApiGet(
          runtime,
          'items/' + encodeURIComponent(lookupValue) + '/revisions/' + encodeURIComponent(olderHash),
        )
        logJSON('REVISION DETAIL API', {
          status: detailResp.status,
          bodyFirst600: String(detailResp.data || '').substring(0, 600),
        })
        let detailBody = null
        try {
          detailBody = JSON.parse(String(detailResp.data || ''))
        } catch (e) {
          detailBody = null
        }
        evidence.revisionDetail = detailBody
          ? {
              status: detailBody.status,
              hasContent: !!(detailBody.data && typeof detailBody.data.content === 'string'),
              contentLength: detailBody.data && detailBody.data.content ? detailBody.data.content.length : 0,
              contentFirst200: detailBody.data && detailBody.data.content ? detailBody.data.content.substring(0, 200) : '',
              revisionHash: detailBody.data && detailBody.data.revision ? detailBody.data.revision.hash : '',
              links: detailBody.data && detailBody.data.links ? detailBody.data.links : null,
            }
          : null
        evidence.olderRevisionHash = olderHash
      }

      // Now open the revisions DIALOG via the UI and dump it.
      section('UI: open revisions dialog via haxcms-open-page-revisions event')
      await page.evaluate((nodeId, nodeTitle) => {
        globalThis.dispatchEvent(
          new CustomEvent('haxcms-open-page-revisions', {
            bubbles: true,
            composed: true,
            cancelable: true,
            detail: {
              nodeId: String(nodeId),
              nodeTitle: String(nodeTitle),
              source: 'discovery-revisions',
            },
          }),
        )
      }, activeItemInfo.id, activeItemInfo.title || '')
      // wait for the dialog to appear + load revisions
      await new Promise((r) => setTimeout(r, 3000))
      const dialogReady = await waitFor(
        async () =>
          page.evaluate(() => {
            const modal = document.querySelector('simple-modal')
            let dialog = null
            if (modal) dialog = modal.querySelector('haxcms-page-revisions-dialog')
            if (!dialog) dialog = document.querySelector('haxcms-page-revisions-dialog')
            return !!(dialog && dialog.shadowRoot && Array.isArray(dialog.revisions) && dialog.revisions.length > 0)
          }),
        20000,
      )
      logJSON('DIALOG READY', !!dialogReady)
      const dialogDump = await dumpRevisionsDialog(page)
      logJSON('REVISIONS DIALOG DOM', dialogDump)
      evidence.revisionsDialog = dialogDump

      // Wait for the revisions list API response to be captured by collector.
      let revListResp = null
      try {
        revListResp = await collector.awaitCollectorFor('/revisions', 15000)
      } catch (e) {
        console.log('revisions list response NOT captured: ' + (e && e.message ? e.message : e))
      }
      if (revListResp) {
        logJSON('REVISIONS LIST (collector)', {
          url: revListResp.url,
          status: revListResp.status,
          bodyFirst400: revListResp.bodyText.substring(0, 400),
        })
      }

      // Test restore via API (direct axios POST) to confirm the shape.
      if (evidence.olderRevisionHash) {
        section('API: POST restore (axios) for older hash')
        const restoreResp = await siteApiPost(
          runtime,
          'items/' + encodeURIComponent(lookupValue) + '/revisions/' + encodeURIComponent(evidence.olderRevisionHash) + '/restore',
          {},
        )
        logJSON('RESTORE API', {
          status: restoreResp.status,
          bodyFirst600: String(restoreResp.data || '').substring(0, 600),
        })
        let restoreBody = null
        try {
          restoreBody = JSON.parse(String(restoreResp.data || ''))
        } catch (e) {
          restoreBody = null
        }
        evidence.restoreResponse = restoreBody
          ? {
              status: restoreBody.status,
              restoredFromHash: restoreBody.data && restoreBody.data.restoredFromHash ? restoreBody.data.restoredFromHash.substring(0, 12) : '',
              links: restoreBody.data && restoreBody.data.links ? restoreBody.data.links : null,
            }
          : null

        // Verify the content reverted: read the page file from disk.
        section('DISK: verify content reverted after restore')
        const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
        let pageLocation = ''
        if (listBody && listBody.data && listBody.data.nodeSlug) {
          // try to find the item in site.json to get its location
        }
        // Read site.json to find the page location.
        const siteJsonPath = path.join(siteDir, 'site.json')
        if (fs.pathExistsSync(siteJsonPath)) {
          const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
          const items = siteJson.items || []
          let foundItem = null
          for (let i = 0; i < items.length; i++) {
            if (String(items[i].id) === String(activeItemInfo.id)) {
              foundItem = items[i]
              break
            }
          }
          if (foundItem && foundItem.location) {
            pageLocation = foundItem.location
            const pageFilePath = path.join(siteDir, pageLocation)
            if (fs.pathExistsSync(pageFilePath)) {
              const fileContent = fs.readFileSync(pageFilePath, 'utf8')
              evidence.pageFileAfterRestore = {
                location: pageLocation,
                contentFirst300: fileContent.substring(0, 300),
                hasMarker1: fileContent.indexOf(marker1) !== -1,
                hasMarker2: fileContent.indexOf(marker2) !== -1,
              }
              logJSON('PAGE FILE AFTER RESTORE', evidence.pageFileAfterRestore)
            }
          }
        }

        // Check git log count (should be 3+ commits: save1, save2, restore).
        section('GIT: check commit count after restore')
        try {
          const { execFile } = require('child_process')
          const { promisify } = require('util')
          const execFileAsync = promisify(execFile)
          const logRaw = await execFileAsync('git', ['--no-pager', 'log', '--pretty=format:%H %s'], {
            cwd: siteDir,
            maxBuffer: 1024 * 1024 * 20,
          })
          const logLines = String(logRaw.stdout || '').split('\n').filter((l) => l.trim())
          evidence.gitLogCount = logLines.length
          evidence.gitLogFirst5 = logLines.slice(0, 5)
          logJSON('GIT LOG', { count: logLines.length, first5: logLines.slice(0, 5) })
        } catch (e) {
          console.log('git log failed: ' + (e && e.message ? e.message : e))
        }
      }

      // Close the dialog.
      await page.evaluate(() => {
        globalThis.dispatchEvent(new CustomEvent('simple-modal-hide', { bubbles: true, composed: true }))
      })
      await new Promise((r) => setTimeout(r, 1000))
    }

    section('DISCOVERY-REVISIONS: SUMMARY')
    console.log('Evidence keys: ' + Object.keys(evidence).join(', '))
    logJSON('EVIDENCE', evidence)
  } catch (err) {
    console.error('DISCOVERY-REVISIONS FAILED:', err && err.stack ? err.stack : err)
    try {
      const dump = await page.evaluate(() => document.body.innerHTML.substring(0, 1500))
      console.error('PAGE BODY SNIPPET:', dump)
    } catch (e) {
      // ignore
    }
  } finally {
    try {
      if (reqWatch) reqWatch.detach()
    } catch (e) {
      // ignore
    }
    try {
      if (collector) collector.detach()
    } catch (e) {
      // ignore
    }
    try {
      if (browser) await browser.close()
    } catch (e) {
      // ignore
    }
    try {
      await teardownE2ERuntime(runtime)
    } catch (e) {
      // ignore
    }
    console.log('\nTeardown complete.')
  }
}

main().catch((err) => {
  console.error('DISCOVERY-REVISIONS TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
