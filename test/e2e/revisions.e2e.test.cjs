'use strict'

// E2E test: page revisions — git-backed history, diff, and restore.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal ->
// create HAXSITEAUTOMATEDTESTING -> navigate into the site editor -> edit +
// save a page TWICE (so two git commits exist, each with a distinct content
// marker) -> open the revisions dialog via the global event -> assert the
// dialog renders revision rows with the right structure -> assert GET
// /x/api/v1/items/:idOrSlug/revisions returns git log rows (hash, author,
// timestamp, message) -> assert GET .../revisions/:revisionId returns the
// older content (diff between the two versions) -> restore the older
// revision via POST .../revisions/:revisionId/restore -> assert the content
// reverts on disk (marker1 present, marker2 gone) + a new git commit is made
// -> a11y scan of the revisions dialog -> teardown.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to
// src/build/node_modules. Revisions routes require Bearer JWT +
// X-HAXCMS-Site-Token; the site token is computed server-side via the HAXCMS
// singleton (same privateKey+salt the server validates against).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const axios = require('axios')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

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
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers
  waitFor,
  deepFindRecursive,
  WALK_HAX_BODY_FN,
  haxBodyEditModeActive,
  markerInHaxBody,
  clickEditorButtonById,
  safeCompareBaseline,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  loginViaUI,
  createSiteViaUI,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'

// --- shared state ----------------------------------------------------------
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

// --- helpers ---------------------------------------------------------------

// Generate the X-HAXCMS-Site-Token for authenticated-site routes.
// The token is HMAC(userName + ':' + siteName) computed server-side via the
// HAXCMS singleton (same privateKey+salt the server validates against).
function getSiteToken() {
  const { HAXCMS } = require('../../src/lib/HAXCMS.js')
  const userName = HAXCMS.getActiveUserName()
  return HAXCMS.getRequestToken(userName + ':' + EXPECTED_SITE_NAME)
}

function siteApiUrl(suffix) {
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

async function siteApiGet(suffix, params) {
  return axios({
    method: 'GET',
    url: siteApiUrl(suffix),
    headers: {
      Authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': getSiteToken(),
    },
    params: params,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
}

async function siteApiPost(suffix, body) {
  return axios({
    method: 'POST',
    url: siteApiUrl(suffix),
    headers: {
      Authorization: 'Bearer ' + runtime.jwt,
      'X-HAXCMS-Site-Token': getSiteToken(),
      'Content-Type': 'application/json',
    },
    data: body,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
}

// Enter edit mode, inject content via importContent, save. Creates a git commit.
// Returns the saveNode API response record.
async function editAndSave(markerText) {
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
  assert.ok(enterResult && enterResult.clicked, 'edit button clicked to enter edit mode')
  await new Promise((r) => setTimeout(r, 4000))

  const bodyReady = await waitFor(async () => haxBodyEditModeActive(page), 30000)
  assert.ok(bodyReady && bodyReady.editModeAttr, 'hax-body in edit mode')

  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  assert.ok(bodyHandle, 'hax-body element handle resolved')
  const testContent =
    '<page-break published="published"></page-break><p>' + markerText + '</p>'
  // wait for initial content to settle (edit-mode autorun importContent)
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
  assert.ok(appeared, 'test content appeared in hax-body before save: ' + markerText)

  // click Save (#editbutton toggles to Save in edit mode)
  const saveResult = await clickEditorButtonById(page, '#editbutton')
  assert.ok(saveResult && saveResult.clicked, 'save button clicked')
  let saveResp = null
  try {
    saveResp = await collector.awaitCollectorFor('/x/api/v1/content/', 30000)
  } catch (e) {
    // non-fatal; we assert below
  }
  assert.ok(saveResp, 'saveNode (PATCH /x/api/v1/content/) response captured')
  assert.strictEqual(saveResp.status, 200, 'saveNode API returned status 200')
  // wait for save to settle + edit mode to disengage
  await new Promise((r) => setTimeout(r, 3000))
  return saveResp
}

// Extract the active item id/slug/location from a saveNode response body.
function extractItemFromSaveResp(saveResp) {
  if (!saveResp || !saveResp.bodyText) {
    return null
  }
  try {
    const body = JSON.parse(saveResp.bodyText)
    if (body && body.data) {
      return {
        id: body.data.id,
        slug: body.data.slug,
        title: body.data.title,
        location: body.data.location,
      }
    }
  } catch (e) {
    // fall through
  }
  return null
}

// Read the git log for the site directory (list of "hash message" lines).
async function gitLogForSite() {
  const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
  const result = await execFileAsync(
    'git',
    ['--no-pager', 'log', '--pretty=format:%H %s'],
    { cwd: siteDir, maxBuffer: 1024 * 1024 * 20 },
  )
  return String(result.stdout || '')
    .split('\n')
    .filter((l) => l.trim())
}

// --- the flow --------------------------------------------------------------

test(
  'page revisions — git history, diff, and restore',
  { timeout: 420000 },
  async (t) => {
    assert.ok(page, 'page initialised in before hook')
    assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

    // 1. Login + create site.
    await loginViaUI(page, collector, runtime.baseUrl)
    await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    relocateCreatedSite(runtime, FIXED_SITE_NAME)

    // 2. Navigate into the site editor.
    const editorUrl = runtime.baseUrl + '/_sites/' + EXPECTED_SITE_NAME + '/'
    t.diagnostic('[e2e] navigating to editor: ' + editorUrl)
    try {
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      t.diagnostic('[e2e] networkidle2 timed out, retrying domcontentloaded')
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
    await new Promise((r) => setTimeout(r, 4000))

    // 3. Edit + save TWICE with distinct markers so two git commits exist.
    const marker1 = 'E2E revisions test content version ONE unique'
    const marker2 = 'E2E revisions test content version TWO different'
    const save1 = await editAndSave(marker1)
    const save2 = await editAndSave(marker2)
    const item = extractItemFromSaveResp(save2)
    assert.ok(item && item.id, 'active item extracted from saveNode response')
    t.diagnostic('[e2e] active item: ' + JSON.stringify(item))
    const lookupValue = item.slug || item.id

    // 4. Assert GET /x/api/v1/items/:idOrSlug/revisions returns git log rows.
    await t.test('API: GET revisions list returns git log rows', async () => {
      const resp = await siteApiGet(
        'items/' + encodeURIComponent(lookupValue) + '/revisions',
      )
      assert.strictEqual(resp.status, 200, 'revisions list API returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'revisions list body status 200')
      const data = body && body.data
      assert.ok(data, 'revisions list has data')
      assert.ok(
        typeof data.nodeId === 'string' && data.nodeId === item.id,
        'data.nodeId matches the active item id',
      )
      assert.ok(
        typeof data.nodeSlug === 'string' && data.nodeSlug === item.slug,
        'data.nodeSlug matches the active item slug',
      )
      assert.ok(
        Array.isArray(data.revisions) && data.revisions.length >= 2,
        'data.revisions has at least 2 rows (save1 + save2)',
      )
      // Each row must have hash, author, timestamp, message.
      for (let i = 0; i < data.revisions.length; i++) {
        const row = data.revisions[i]
        assert.ok(
          typeof row.hash === 'string' && row.hash.length >= 7,
          'revision ' + i + ' has a hash string',
        )
        assert.ok(
          typeof row.author === 'string' && row.author.length > 0,
          'revision ' + i + ' has an author string',
        )
        assert.ok(
          typeof row.timestamp === 'number' && row.timestamp > 0,
          'revision ' + i + ' has a numeric timestamp',
        )
        assert.ok(
          typeof row.message === 'string' && row.message.length > 0,
          'revision ' + i + ' has a message string',
        )
      }
      assert.ok(
        typeof data.total === 'number' && data.total >= 2,
        'data.total is a number >= 2',
      )
      assert.ok(
        data.links && typeof data.links.self === 'string',
        'data.links.self is a string',
      )
      t.diagnostic(
        '[e2e] revisions list: count=' +
          data.count +
          ' total=' +
          data.total +
          ' first=' +
          (data.revisions[0] && data.revisions[0].shortHash),
      )
    })

    // 5. Open the revisions dialog via the UI and assert it renders rows.
    await t.test('UI: revisions dialog renders revision rows', async () => {
      await page.evaluate((nodeId, nodeTitle) => {
        globalThis.dispatchEvent(
          new CustomEvent('haxcms-open-page-revisions', {
            bubbles: true,
            composed: true,
            cancelable: true,
            detail: {
              nodeId: String(nodeId),
              nodeTitle: String(nodeTitle),
              source: 'e2e-revisions-test',
            },
          }),
        )
      }, item.id, item.title || '')
      // wait for the dialog to appear + load revisions
      await new Promise((r) => setTimeout(r, 3000))
      const dialogReady = await waitFor(
        async () =>
          page.evaluate(() => {
            const modal = document.querySelector('simple-modal')
            let dialog = null
            if (modal) {
              dialog = modal.querySelector('haxcms-page-revisions-dialog')
            }
            if (!dialog) {
              dialog = document.querySelector('haxcms-page-revisions-dialog')
            }
            return !!(
              dialog &&
              dialog.shadowRoot &&
              Array.isArray(dialog.revisions) &&
              dialog.revisions.length > 0
            )
          }),
        20000,
      )
      assert.ok(dialogReady, 'revisions dialog rendered with revisions loaded')
      const info = await page.evaluate(() => {
        const modal = document.querySelector('simple-modal')
        let dialog = null
        if (modal) {
          dialog = modal.querySelector('haxcms-page-revisions-dialog')
        }
        if (!dialog) {
          dialog = document.querySelector('haxcms-page-revisions-dialog')
        }
        if (!dialog || !dialog.shadowRoot) {
          return null
        }
        const rows = dialog.shadowRoot.querySelectorAll('tbody tr')
        const restoreBtns = dialog.shadowRoot.querySelectorAll(
          'simple-icon-button-lite[data-action="restore"]',
        )
        return {
          nodeId: dialog.nodeId,
          revisionsCount: Array.isArray(dialog.revisions)
            ? dialog.revisions.length
            : -1,
          rowCount: rows.length,
          restoreButtonCount: restoreBtns.length,
          firstRowRestoreDisabled:
            restoreBtns.length > 0
              ? restoreBtns[0].hasAttribute('disabled')
              : null,
        }
      })
      assert.ok(info, 'revisions dialog DOM dumped')
      assert.strictEqual(
        info.nodeId,
        item.id,
        'dialog nodeId matches the active item id',
      )
      assert.ok(
        info.revisionsCount >= 2,
        'dialog has at least 2 revisions loaded',
      )
      assert.strictEqual(
        info.rowCount,
        info.revisionsCount,
        'table row count matches revisions count',
      )
      assert.ok(
        info.restoreButtonCount >= 2,
        'at least 2 restore buttons rendered',
      )
      // The first row (current revision) restore button must be disabled.
      assert.ok(
        info.firstRowRestoreDisabled === true,
        'first row restore button is disabled (current revision)',
      )
      t.diagnostic(
        '[e2e] dialog: revisions=' +
          info.revisionsCount +
          ' rows=' +
          info.rowCount +
          ' restoreBtns=' +
          info.restoreButtonCount,
      )
    })

    // 6. Assert GET .../revisions/:revisionId returns the OLDER content (diff).
    await t.test('API: GET revision detail returns older content (diff)', async () => {
      // Fetch the list again to get the ordered hashes.
      const listResp = await siteApiGet(
        'items/' + encodeURIComponent(lookupValue) + '/revisions',
      )
      let listBody = null
      try {
        listBody = JSON.parse(String(listResp.data || ''))
      } catch (e) {
        listBody = null
      }
      const revisions =
        listBody && listBody.data && Array.isArray(listBody.data.revisions)
          ? listBody.data.revisions
          : []
      assert.ok(revisions.length >= 2, 'at least 2 revisions available for diff')
      // revisions[0] = most recent (save2), revisions[1] = older (save1).
      const olderRevision = revisions[1]
      const olderHash = olderRevision.hash
      const detailResp = await siteApiGet(
        'items/' +
          encodeURIComponent(lookupValue) +
          '/revisions/' +
          encodeURIComponent(olderHash),
      )
      assert.strictEqual(
        detailResp.status,
        200,
        'revision detail API returned 200',
      )
      let detailBody = null
      try {
        detailBody = JSON.parse(String(detailResp.data || ''))
      } catch (e) {
        detailBody = null
      }
      assert.ok(
        detailBody && detailBody.status === 200,
        'revision detail body status 200',
      )
      const detail = detailBody && detailBody.data
      assert.ok(detail, 'revision detail has data')
      assert.ok(
        detail.revision && typeof detail.revision.hash === 'string',
        'detail.revision.hash is present',
      )
      assert.ok(
        typeof detail.content === 'string' && detail.content.length > 0,
        'detail.content is a non-empty string',
      )
      // The diff: older revision content has marker1, NOT marker2.
      assert.ok(
        detail.content.indexOf(marker1) !== -1,
        'older revision content contains marker1 (version ONE)',
      )
      assert.ok(
        detail.content.indexOf(marker2) === -1,
        'older revision content does NOT contain marker2 (version TWO)',
      )
      assert.ok(
        detail.links && typeof detail.links.restore === 'string',
        'detail.links.restore is a string',
      )
      t.diagnostic(
        '[e2e] revision detail: hash=' +
          (detail.revision.shortHash || '') +
          ' contentLen=' +
          detail.content.length,
      )
    })

    // 7. Restore the older revision + assert content reverts + new git commit.
    await t.test('API: POST restore reverts content + creates new git commit', async () => {
      // Count git commits before restore.
      const logBefore = await gitLogForSite()
      const commitCountBefore = logBefore.length
      t.diagnostic(
        '[e2e] git commits before restore: ' + commitCountBefore,
      )

      // Fetch the list to get the older hash.
      const listResp = await siteApiGet(
        'items/' + encodeURIComponent(lookupValue) + '/revisions',
      )
      let listBody = null
      try {
        listBody = JSON.parse(String(listResp.data || ''))
      } catch (e) {
        listBody = null
      }
      const revisions =
        listBody && listBody.data && Array.isArray(listBody.data.revisions)
          ? listBody.data.revisions
          : []
      const olderHash = revisions[1].hash

      const restoreResp = await siteApiPost(
        'items/' +
          encodeURIComponent(lookupValue) +
          '/revisions/' +
          encodeURIComponent(olderHash) +
          '/restore',
        {},
      )
      assert.strictEqual(
        restoreResp.status,
        200,
        'restore API returned 200',
      )
      let restoreBody = null
      try {
        restoreBody = JSON.parse(String(restoreResp.data || ''))
      } catch (e) {
        restoreBody = null
      }
      assert.ok(
        restoreBody && restoreBody.status === 200,
        'restore body status 200',
      )
      const rData = restoreBody && restoreBody.data
      assert.ok(rData, 'restore response has data')
      assert.ok(
        typeof rData.restoredFromHash === 'string' &&
          rData.restoredFromHash.length > 0,
        'data.restoredFromHash is a non-empty string',
      )
      assert.ok(
        rData.links && typeof rData.links.self === 'string',
        'data.links.self is a string',
      )

      // Verify the content reverted on disk: read the page file.
      const siteDir = path.join(
        runtime.runtimeRoot,
        SITES_DIR,
        EXPECTED_SITE_NAME,
      )
      const pageFilePath = path.join(siteDir, item.location)
      assert.ok(
        fs.pathExistsSync(pageFilePath),
        'page HTML file exists on disk after restore',
      )
      const fileContent = fs.readFileSync(pageFilePath, 'utf8')
      assert.ok(
        fileContent.indexOf(marker1) !== -1,
        'page file contains marker1 (version ONE) after restore',
      )
      assert.ok(
        fileContent.indexOf(marker2) === -1,
        'page file does NOT contain marker2 (version TWO) after restore',
      )
      t.diagnostic(
        '[e2e] disk cross-check OK: content reverted to version ONE',
      )

      // Assert a new git commit was made (commit count increased by 1).
      const logAfter = await gitLogForSite()
      const commitCountAfter = logAfter.length
      assert.ok(
        commitCountAfter > commitCountBefore,
        'git commit count increased after restore (' +
          commitCountBefore +
          ' -> ' +
          commitCountAfter +
          ')',
      )
      // The newest commit message should mention "revision restored".
      const newestMessage = logAfter[0]
      assert.ok(
        newestMessage.indexOf('revision restored') !== -1 ||
          newestMessage.indexOf('Page revision restored') !== -1,
        'newest git commit message mentions revision restore: ' +
          newestMessage,
      )
      t.diagnostic(
        '[e2e] git commit created: ' + newestMessage.substring(0, 80),
      )
    })

    // 8. Visual baseline: revisions dialog.
    await t.test('visual: revisions dialog baseline', async () => {
      const buf = await captureScreenshot(page, 'revisions-dialog')
      const cmp = await safeCompareBaseline('revisions-dialog', buf, null, t)
      t.diagnostic(
        '[visual] revisions-dialog: diffPercent=' +
          (cmp.diffPercent * 100).toFixed(3) +
          '% baselineExists=' +
          cmp.baselineExists +
          ' baselineUpdated=' +
          cmp.baselineUpdated,
      )
    })

    // 9. A11y: axe scoped to the revisions dialog.
    await t.test('a11y: revisions dialog scan', async () => {
      let a11y = null
      try {
        a11y = await runA11y(page, 'haxcms-page-revisions-dialog')
      } catch (e) {
        t.diagnostic(
          '[a11y] runA11y threw: ' + (e && e.message ? e.message : e),
        )
      }
      if (a11y) {
        const critical = a11y.critical || []
        const serious = a11y.serious || []
        t.diagnostic(
          '[a11y] revisions dialog: critical=' +
            critical.length +
            ' serious=' +
            serious.length +
            ' totalViolations=' +
            ((a11y.violations && a11y.violations.length) || 0),
        )
        for (let i = 0; i < critical.length; i++) {
          t.diagnostic(
            '[a11y] CRITICAL: id=' +
              critical[i].id +
              ' help=' +
              (critical[i].help || critical[i].description || ''),
          )
        }
        for (let i = 0; i < serious.length; i++) {
          t.diagnostic(
            '[a11y] SERIOUS: id=' +
              serious[i].id +
              ' help=' +
              (serious[i].help || serious[i].description || ''),
          )
        }
        // Soft assertion: the scan ran and returned a result object.
        assert.ok(a11y, 'runA11y returned a result object for revisions dialog')
      } else {
        t.diagnostic(
          '[a11y] could not run scoped axe on revisions dialog (non-fatal)',
        )
      }
    })
  },
)
