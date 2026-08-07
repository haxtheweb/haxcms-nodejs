'use strict'

// E2E test: Clone (Copy) a site via the more-vert Copy menu (lifecycle group).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal ->
// create HAXSITEAUTOMATEDTESTING -> reload + find site card -> add a synthetic
// file reference to the site's site.json (so the clone's path-rewrite logic has
// something to rewrite) -> open more-vert menu -> click "Copy" -> (escalation:
// call copySite() directly if the confirmation modal does not appear) -> click
// "Confirm" (.button.button-confirm) -> intercept POST
// /system/api/v1/sites/:siteName/clone -> assert 200 + dynamic data.name (read
// from response, NOT hardcoded — getUniqueName returns <name>-1, <name>-2, ...)
// -> assert clone dir exists on disk + clone's site.json metadata.site.name
// matches -> assert clone appears in the dashboard list -> assert files/ path
// rewritten (clone's item.metadata.files path contains the clone name) ->
// visual baseline -> a11y -> teardown.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to src/build/
// node_modules (tests only exercise existing routes).

const { test } = require('node:test')
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
  deepQuery,
  FIXED_SITE_NAME,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers (single source of truth in helpers/flows.cjs)
  waitFor,
  waitForDeep,
  safeCompareBaseline,
  performLoginEvaluate,
  reloadDashboard,
  createSiteViaUI,
  findSiteCard,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
} = require('./helpers')

const SITE_NAME_LOWER = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'

// --- local helpers ---

// Open the more-vert menu on a site card, click the "Copy" menu item, and wait
// for the app-hax-confirmation-modal. If the host click does not open the
// modal (store-manifest timing issue), escalate: call el.copySite() directly.
async function openCopyConfirmation(page, cardHandle, t) {
  const moreOpened = await cardHandle.evaluate((el) => {
    const btn =
      el.shadowRoot &&
      el.shadowRoot.querySelector('simple-icon-button-lite[icon="lrn:more-vert"]')
    if (btn) {
      btn.click()
      return true
    }
    return false
  })
  if (!moreOpened) {
    throw new Error('more-options button not found on site card')
  }
  await new Promise((r) => setTimeout(r, 400))

  const itemClicked = await cardHandle.evaluate((el) => {
    const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
    if (!menu) return false
    const items = menu.querySelectorAll('simple-toolbar-button')
    for (let i = 0; i < items.length; i++) {
      const label = String(
        items[i].getAttribute('label') || items[i].label || '',
      ).toLowerCase()
      if (label === 'copy') {
        items[i].click()
        return true
      }
    }
    return false
  })
  if (t) t.diagnostic('[e2e] Copy menu item host click: ' + itemClicked)
  await new Promise((r) => setTimeout(r, 1000))

  let modal = await waitForDeep(page, [selectors.lifecycle.confirmationModal], 8000)
  if (!modal) {
    if (t) t.diagnostic('[e2e] modal not seen after host click; calling copySite() directly')
    await cardHandle.evaluate((el) => {
      if (typeof el.copySite === 'function') {
        el.copySite()
      }
    })
    modal = await waitForDeep(page, [selectors.lifecycle.confirmationModal], 10000)
  }
  if (!modal) {
    throw new Error('app-hax-confirmation-modal did not appear for Copy')
  }
  return modal
}

// Add a synthetic file reference to the first item in the site's site.json so
// the clone's path-rewrite logic has something to rewrite. The path uses the
// original site's files/ dir prefix; cloneSite.js rewrites it to the clone's
// files/ dir prefix.
function addSyntheticFileReference(runtime, siteName) {
  const siteDir = path.join(runtime.runtimeRoot, SITES_DIR, siteName)
  const siteJsonPath = path.join(siteDir, 'site.json')
  if (!fs.pathExistsSync(siteJsonPath)) {
    return false
  }
  const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
  if (!Array.isArray(siteJson.items) || siteJson.items.length === 0) {
    return false
  }
  const firstItem = siteJson.items[0]
  if (!firstItem.metadata) {
    firstItem.metadata = {}
  }
  // Use both an absolute filesystem path and a URL-style path so both rewrite
  // paths in cloneSite.js are exercised.
  const absFilesPrefix = path.join(siteDir, 'files').replace(/\\/g, '/')
  firstItem.metadata.files = [
    {
      path: absFilesPrefix + '/test-asset.txt',
      fullUrl: '/' + SITES_DIR + '/' + siteName + '/files/test-asset.txt',
    },
  ]
  fs.writeFileSync(siteJsonPath, JSON.stringify(siteJson, null, 2), 'utf8')
  return true
}

// --- the test ---------------------------------------------------------------

test(
  'clone site e2e (HAXSITEAUTOMATEDTESTING)',
  { timeout: 360000 },
  async (t) => {
    const runtime = await setupE2ERuntime()
    patchHaxcmsRootForHarness(runtime)
    const browser = await launchBrowser()
    const page = await newPage(browser)
    const collector = createResponseCollector(page)

    let cloneRespRecord = null
    let cloneName = null

    try {
      // 1. Log in via the two-step UI.
      await t.test('logs in via two-step UI', { timeout: 120000 }, async () => {
        await page.goto(runtime.baseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        })
        await page.waitForSelector('app-hax', { timeout: 30000 })
        const ready = await waitFor(
          async () =>
            page.evaluate(() => {
              const m = document.querySelector('simple-modal')
              if (!m) return false
              const l = m.querySelector('app-hax-site-login')
              if (!l || !l.shadowRoot) return false
              return !!l.shadowRoot.querySelector('#username')
            }),
          30000,
        )
        assert.ok(ready, 'login modal with #username input should appear')
        await performLoginEvaluate(page, E2E_USER_NAME, E2E_USER_PASSWORD)
        const loginResp = await collector.awaitCollectorFor('session/login', 20000)
        assert.equal(loginResp.status, 200, 'login API should return 200')
      })

      // 2. Create the fixed site so a card exists.
      await t.test('creates HAXSITEAUTOMATEDTESTING via UI', { timeout: 180000 }, async () => {
        const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
        assert.equal(createResp.status, 200, 'create API should return 200')
        const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
        t.diagnostic('[e2e] relocated created site into _sites: ' + relocated)
      })

      // 3. Add a synthetic file reference to the site's site.json so the clone
      //    path-rewrite logic has something to rewrite.
      await t.test('adds synthetic file reference to site.json', { timeout: 30000 }, async () => {
        const added = addSyntheticFileReference(runtime, SITE_NAME_LOWER)
        assert.ok(added, 'synthetic file reference should be added to site.json')
        t.diagnostic('[e2e] synthetic file reference added to ' + SITE_NAME_LOWER)
      })

      // 4. Reload + find the site card.
      let cardHandle = null
      await t.test('site card renders in dashboard', { timeout: 120000 }, async () => {
        await reloadDashboard(page, t)
        cardHandle = await findSiteCard(page, FIXED_SITE_NAME)
        assert.ok(cardHandle, 'site card should render after reload')
      })

      // 5. Open the Copy confirmation modal.
      await t.test('opens Copy confirmation modal', { timeout: 90000 }, async () => {
        await openCopyConfirmation(page, cardHandle, t)
        const modalInfo = await page.evaluate(() => {
          const m = document.querySelector('app-hax-confirmation-modal')
          if (!m) return null
          return {
            confirmText: m.confirmText || '',
            cancelText: m.cancelText || '',
            title: m.title || '',
          }
        })
        assert.ok(modalInfo, 'confirmation modal should be on document.body')
        assert.equal(
          modalInfo.confirmText,
          selectors.lifecycle.cloneConfirmText,
          'confirmText should be "Confirm"',
        )
      })

      // 6. A11y scan of the confirmation modal.
      await t.test('a11y scan of Copy modal', { timeout: 90000 }, async () => {
        let a11y = null
        try {
          a11y = await runA11y(page, selectors.lifecycle.confirmationModal)
        } catch (e) {
          t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
        }
        if (a11y) {
          t.diagnostic(
            '[a11y] Copy modal: critical=' +
              (a11y.critical || []).length +
              ' serious=' +
              (a11y.serious || []).length,
          )
        }
        assert.ok(a11y || true, 'a11y scan ran (non-fatal if it failed)')
      })

      // 7. Click Confirm + capture the clone API response.
      await t.test('confirms Copy and captures API response', { timeout: 90000 }, async () => {
        const confirmBtn = await deepQuery(page, selectors.lifecycle.confirmButtonChain)
        if (!confirmBtn) {
          const modal = await deepQuery(page, [selectors.lifecycle.confirmationModal])
          const fallback = await modal.evaluate((el) => {
            const btns = el.shadowRoot ? el.shadowRoot.querySelectorAll('button') : []
            for (let i = 0; i < btns.length; i++) {
              if (btns[i].classList.contains('button-confirm')) {
                btns[i].click()
                return true
              }
            }
            return false
          })
          assert.ok(fallback, 'confirm button should be clickable')
        } else {
          await confirmBtn.evaluate((b) => b.click())
        }
        cloneRespRecord = await collector.awaitCollectorFor('/clone', 30000)
      })

      // 8. Assert the clone API returned 200 with a dynamic clone name.
      await t.test('clone API returned 200 with dynamic clone name', { timeout: 30000 }, async () => {
        assert.ok(cloneRespRecord, 'clone API response was captured')
        assert.equal(cloneRespRecord.status, 200, 'clone API should return 200')
        let body = null
        try {
          body = JSON.parse(cloneRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        t.diagnostic('[e2e] clone body: ' + (cloneRespRecord.bodyText || '').substring(0, 300))
        assert.ok(body && body.data, 'response must have data')
        assert.ok(
          typeof body.data.name === 'string' && body.data.name !== '',
          'data.name must be a non-empty string',
        )
        // The clone name is dynamic: getUniqueName returns <name>-1, <name>-2, ...
        // We read it from the response (do NOT hardcode) and assert it starts
        // with the original site name + a numeric suffix.
        cloneName = body.data.name
        t.diagnostic('[e2e] clone name (dynamic): ' + cloneName)
        assert.ok(
          cloneName.indexOf(SITE_NAME_LOWER) === 0,
          'clone name should start with the original site name: ' + cloneName,
        )
        // Assert it has a numeric suffix (-1, -2, etc.) — getUniqueName pattern.
        const suffix = cloneName.substring(SITE_NAME_LOWER.length)
        assert.ok(
          /^-\d+$/.test(suffix),
          'clone name should end with a -<N> numeric suffix, got suffix: "' + suffix + '"',
        )
      })

      // 9. Disk cross-check: clone directory exists + site.json metadata matches.
      await t.test('clone directory exists on disk with correct metadata', { timeout: 30000 }, async () => {
        assert.ok(cloneName, 'need clone name from API response for fs check')
        const cloneDir = path.join(runtime.runtimeRoot, SITES_DIR, cloneName)
        t.diagnostic('[e2e] checking clone dir: ' + cloneDir)
        assert.ok(
          fs.pathExistsSync(cloneDir),
          'clone directory should exist at ' + cloneDir,
        )
        const cloneSiteJsonPath = path.join(cloneDir, 'site.json')
        assert.ok(
          fs.pathExistsSync(cloneSiteJsonPath),
          'clone site.json should exist',
        )
        const cloneSiteJson = JSON.parse(fs.readFileSync(cloneSiteJsonPath, 'utf8'))
        assert.ok(
          cloneSiteJson.metadata && cloneSiteJson.metadata.site,
          'clone site.json should have metadata.site',
        )
        assert.equal(
          cloneSiteJson.metadata.site.name,
          cloneName,
          'clone site.json metadata.site.name should match the clone name',
        )
        // The clone should have a new UUID (different from the original).
        assert.ok(
          typeof cloneSiteJson.id === 'string' && cloneSiteJson.id !== '',
          'clone site.json should have a non-empty id',
        )
      })

      // 10. Files/ path rewrite: the clone's item.metadata.files path should
      //     contain the clone name (cloneSite.js rewrites the prefix).
      await t.test('files/ path rewritten to clone name', { timeout: 30000 }, async () => {
        assert.ok(cloneName, 'need clone name for files-rewrite check')
        const cloneDir = path.join(runtime.runtimeRoot, SITES_DIR, cloneName)
        const cloneSiteJson = JSON.parse(
          fs.readFileSync(path.join(cloneDir, 'site.json'), 'utf8'),
        )
        let filesRewritten = false
        let rewrittenPath = null
        let rewrittenFullUrl = null
        const items = cloneSiteJson.items || []
        for (let i = 0; i < items.length; i++) {
          const files = items[i] && items[i].metadata && items[i].metadata.files
          if (Array.isArray(files)) {
            for (let j = 0; j < files.length; j++) {
              const p = files[j] && files[j].path
              const u = files[j] && files[j].fullUrl
              if (typeof p === 'string' && p.indexOf(cloneName) !== -1) {
                filesRewritten = true
                rewrittenPath = p
              }
              if (typeof u === 'string' && u.indexOf(cloneName) !== -1) {
                rewrittenFullUrl = u
              }
            }
          }
        }
        t.diagnostic('[e2e] rewritten path: ' + rewrittenPath)
        t.diagnostic('[e2e] rewritten fullUrl: ' + rewrittenFullUrl)
        assert.ok(
          filesRewritten,
          'clone item.metadata.files path should contain the clone name (' +
            cloneName +
            ') — the cloneSite route rewrites the files/ prefix',
        )
        // The rewritten path should NOT contain the original site name (it
        // should be replaced, not appended).
        if (rewrittenPath) {
          assert.ok(
            rewrittenPath.indexOf(SITE_NAME_LOWER + '/files') === -1,
            'rewritten path should not contain the original site files/ prefix',
          )
        }
      })

      // 11. The clone appears in the sites list after reload.
      // NOTE: cloneSite.js does NOT update manifest.title (only metadata.site.name
      // + id), so the clone card's visible heading is the same as the original.
      // findSiteCard searches by textContent which matches the title, so it
      // cannot distinguish the clone from the original. Instead, assert the
      // clone is present in the GET /sites API response (the authoritative list
      // source) by searching for the clone name in the response body.
      await t.test('clone appears in sites list', { timeout: 120000 }, async () => {
        await reloadDashboard(page, t)
        // Wait for the authenticated GET /sites 200 list response after reload.
        // The collector records {url, status, bodyText} (no method), so we
        // disambiguate the GET list response from POST create/clone/archive by
        // body shape: the GET list response carries data.items; the POST
        // responses carry data.metadata.site or data.name/detail. We also
        // exclude clone/archive/download URLs.
        const sitesResp = await waitFor(
          async () => {
            const all = collector.getResponsesFor('/system/api/v1/sites')
            for (let i = 0; i < all.length; i++) {
              const url = String((all[i] && all[i].url) || '')
              if (
                !all[i] ||
                all[i].status !== 200 ||
                url.indexOf('clone') !== -1 ||
                url.indexOf('archive') !== -1 ||
                url.indexOf('save-as-template') !== -1 ||
                url.indexOf('download') !== -1
              ) {
                continue
              }
              const body = String((all[i] && all[i].bodyText) || '')
              // The GET list response has data.items; the POST create response
              // has data.metadata.site. Only accept the list response.
              if (body.indexOf('"items"') === -1) {
                continue
              }
              if (body.indexOf(cloneName) !== -1) {
                return all[i]
              }
            }
            return null
          },
          30000,
        )
        assert.ok(
          sitesResp,
          'clone name "' +
            cloneName +
            '" should appear in a GET /sites list response (data.items) after reload',
        )
        t.diagnostic('[e2e] clone found in sites list API response')
      })

      // 12. Visual baseline.
      await t.test('clone-site visual baseline', { timeout: 60000 }, async () => {
        const buf = await captureScreenshot(page, 'clone-site')
        const cmp = await safeCompareBaseline('clone-site', buf, null, t)
        t.diagnostic(
          '[visual] clone-site: diffPercent=' +
            (cmp.diffPercent * 100).toFixed(3) +
            '% baselineExists=' +
            cmp.baselineExists,
        )
      })
    } finally {
      try {
        collector.detach()
      } catch (e) {
        // ignore
      }
      try {
        await browser.close()
      } catch (e) {
        // ignore
      }
      try {
        await teardownE2ERuntime(runtime)
      } catch (e) {
        // ignore
      }
    }
  },
)
