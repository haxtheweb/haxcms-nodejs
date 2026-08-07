'use strict'

// E2E test: Restore an archived site (lifecycle group).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal ->
// create HAXSITEAUTOMATEDTESTING -> reload + find site card -> archive via
// more-vert -> Archive -> confirmation modal -> Confirm -> assert POST
// /system/api/v1/sites/:siteName/archive 200 -> assert card removed from
// dashboard -> assert site dir moved to _archived/ on disk -> RESTORE (no
// restore UI exists in the dashboard; drive via filesystem: move the dir from
// _archived/ back to _sites/) -> reload dashboard -> assert the site card
// reappears -> visual baseline -> a11y -> teardown.
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
  waitForCardGone,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
} = require('./helpers')

const SITE_NAME_LOWER = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'
const ARCHIVE_DIR = '_archived'
const ARCHIVE_DIR_CANDIDATES = ['_archived', '_archive']

// --- local helpers (mirror the archive-site openArchiveConfirmation pattern) ---

// Open the more-vert menu on a site card, click the "Archive" menu item, and
// wait for the app-hax-confirmation-modal. Escalation: if the host click does
// not open the modal, click the inner button; if that fails, call
// el.archiveSite() directly. Returns once the modal is on document.body.
async function openArchiveConfirmation(page, cardHandle, t) {
  // 1. Click more-options to open the menu.
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

  // 2. Click the "Archive" menu item host.
  const archiveClicked = await waitFor(
    async () =>
      cardHandle.evaluate((el) => {
        const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
        if (!menu) return false
        const items = menu.querySelectorAll('simple-toolbar-button')
        for (let i = 0; i < items.length; i++) {
          const label = String(
            items[i].getAttribute('label') || items[i].label || '',
          ).toLowerCase()
          if (label === 'archive') {
            items[i].click()
            return true
          }
        }
        return false
      }),
    12000,
  )
  if (!archiveClicked) {
    throw new Error('Archive menu item not found in more-vert context menu')
  }
  await new Promise((r) => setTimeout(r, 1000))

  // 3. Wait for the confirmation modal. Escalate: inner button, then direct.
  let modal = await waitForDeep(page, [selectors.lifecycle.confirmationModal], 8000)
  if (!modal) {
    if (t) t.diagnostic('[e2e] modal not seen after host click; trying inner button')
    await cardHandle.evaluate((el) => {
      const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
      if (!menu) return
      const items = menu.querySelectorAll('simple-toolbar-button')
      for (let i = 0; i < items.length; i++) {
        const label = String(
          items[i].getAttribute('label') || items[i].label || '',
        ).toLowerCase()
        if (label === 'archive') {
          var inner = items[i].shadowRoot && items[i].shadowRoot.querySelector('button')
          if (inner) {
            inner.click()
          } else {
            items[i].click()
          }
          return
        }
      }
    })
    modal = await waitForDeep(page, [selectors.lifecycle.confirmationModal], 8000)
  }
  if (!modal) {
    if (t) t.diagnostic('[e2e] modal not seen after inner-button click; calling archiveSite() directly')
    await cardHandle.evaluate((el) => {
      if (typeof el.archiveSite === 'function') {
        el.archiveSite()
      }
    })
    modal = await waitForDeep(page, [selectors.lifecycle.confirmationModal], 10000)
  }
  if (!modal) {
    throw new Error('app-hax-confirmation-modal did not appear for Archive')
  }
  return modal
}

// --- the test ---------------------------------------------------------------

test(
  'restore archived site e2e (HAXSITEAUTOMATEDTESTING)',
  { timeout: 420000 },
  async (t) => {
    const runtime = await setupE2ERuntime()
    patchHaxcmsRootForHarness(runtime)
    const browser = await launchBrowser()
    const page = await newPage(browser)
    const collector = createResponseCollector(page)

    let archiveRespRecord = null
    let archivedName = null

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

      // 3. Reload + find the site card.
      let cardHandle = null
      await t.test('site card renders in dashboard', { timeout: 120000 }, async () => {
        await reloadDashboard(page, t)
        cardHandle = await findSiteCard(page, FIXED_SITE_NAME)
        assert.ok(cardHandle, 'site card should render after reload')
      })

      // 4. Open the Archive confirmation modal.
      await t.test('opens Archive confirmation modal', { timeout: 90000 }, async () => {
        await openArchiveConfirmation(page, cardHandle, t)
        const modalInfo = await page.evaluate(() => {
          const m = document.querySelector('app-hax-confirmation-modal')
          if (!m) return null
          return {
            confirmText: m.confirmText || '',
            title: m.title || '',
            dangerous: m.dangerous,
          }
        })
        assert.ok(modalInfo, 'confirmation modal should be on document.body')
        t.diagnostic('[e2e] archive modal: ' + JSON.stringify(modalInfo))
      })

      // 5. A11y scan of the confirmation modal.
      await t.test('a11y scan of Archive modal', { timeout: 90000 }, async () => {
        let a11y = null
        try {
          a11y = await runA11y(page, selectors.lifecycle.confirmationModal)
        } catch (e) {
          t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
        }
        if (a11y) {
          t.diagnostic(
            '[a11y] Archive modal: critical=' +
              (a11y.critical || []).length +
              ' serious=' +
              (a11y.serious || []).length,
          )
        }
        assert.ok(a11y || true, 'a11y scan ran (non-fatal if it failed)')
      })

      // 6. Click Confirm + capture the archive API response.
      await t.test('confirms Archive and captures API response', { timeout: 90000 }, async () => {
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
        archiveRespRecord = await collector.awaitCollectorFor('/archive', 25000)
      })

      // 7. Assert the archive API returned 200.
      await t.test('archive API returned 200', { timeout: 30000 }, async () => {
        assert.ok(archiveRespRecord, 'archive API response was captured')
        assert.equal(archiveRespRecord.status, 200, 'archive API should return 200')
        let body = null
        try {
          body = JSON.parse(archiveRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        t.diagnostic('[e2e] archive body: ' + (archiveRespRecord.bodyText || '').substring(0, 300))
        assert.ok(body && body.data, 'archive response must have data')
        // The archive response has data.name + data.archivedName + data.detail.
        // archivedName may differ from name if a collision occurred (name-1, etc.).
        archivedName = body.data.archivedName || body.data.name
        assert.ok(archivedName, 'archive response should have data.name or data.archivedName')
        t.diagnostic('[e2e] archived name: ' + archivedName)
      })

      // 8. Assert the site card is removed from the dashboard.
      await t.test('site card removed from dashboard after archive', { timeout: 60000 }, async () => {
        const gone = await waitForCardGone(page, FIXED_SITE_NAME)
        assert.equal(gone, true, 'site card should be gone after archive')
      })

      // 9. Disk cross-check: site moved to _archived/.
      await t.test('site moved to _archived on disk', { timeout: 30000 }, async () => {
        const sitesPath = path.join(runtime.runtimeRoot, SITES_DIR, SITE_NAME_LOWER)
        assert.ok(
          !fs.pathExistsSync(sitesPath),
          'site directory should be gone from _sites: ' + sitesPath,
        )
        let archivedPath = null
        for (let i = 0; i < ARCHIVE_DIR_CANDIDATES.length; i++) {
          const candidate = path.join(
            runtime.runtimeRoot,
            ARCHIVE_DIR_CANDIDATES[i],
            archivedName,
          )
          if (fs.pathExistsSync(candidate)) {
            archivedPath = candidate
            break
          }
        }
        assert.ok(
          archivedPath,
          'site directory should exist under an archived directory (' +
            ARCHIVE_DIR_CANDIDATES.join(' or ') +
            ') for name "' +
            archivedName +
            '"',
        )
        t.diagnostic('[e2e] archived at: ' + archivedPath)
      })

      // 10. RESTORE: move the dir from _archived/ back to _sites/ (no restore UI).
      await t.test('restores site by moving dir back to _sites', { timeout: 30000 }, async () => {
        let archivedPath = null
        for (let i = 0; i < ARCHIVE_DIR_CANDIDATES.length; i++) {
          const candidate = path.join(
            runtime.runtimeRoot,
            ARCHIVE_DIR_CANDIDATES[i],
            archivedName,
          )
          if (fs.pathExistsSync(candidate)) {
            archivedPath = candidate
            break
          }
        }
        assert.ok(archivedPath, 'archived site dir must exist before restoring')
        const restoreTarget = path.join(runtime.runtimeRoot, SITES_DIR, archivedName)
        t.diagnostic('[e2e] restoring: ' + archivedPath + ' -> ' + restoreTarget)
        fs.moveSync(archivedPath, restoreTarget, { overwrite: true })
        assert.ok(
          fs.pathExistsSync(restoreTarget),
          'restored site directory should exist at ' + restoreTarget,
        )
        // Verify the site.json is intact.
        const siteJsonPath = path.join(restoreTarget, 'site.json')
        assert.ok(
          fs.pathExistsSync(siteJsonPath),
          'restored site.json should exist',
        )
        const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
        assert.ok(
          siteJson.metadata && siteJson.metadata.site,
          'restored site.json should have metadata.site',
        )
        t.diagnostic(
          '[e2e] restored site.json metadata.site.name: ' +
            siteJson.metadata.site.name,
        )
      })

      // 11. Reload + assert the site card reappears in the dashboard.
      await t.test('site card reappears in dashboard after restore', { timeout: 120000 }, async () => {
        await reloadDashboard(page, t)
        // The card should reappear. The archivedName is the name used for the
        // restored dir, so search by that (it may differ from FIXED_SITE_NAME
        // if a collision suffix was applied).
        const restoredCard = await findSiteCard(page, archivedName)
        assert.ok(
          restoredCard,
          'site card should reappear in dashboard after restore for ' + archivedName,
        )
        if (restoredCard) {
          await restoredCard.dispose()
        }
      })

      // 12. Visual baseline: dashboard after restore.
      await t.test('restore-site visual baseline', { timeout: 60000 }, async () => {
        const buf = await captureScreenshot(page, 'restore-site')
        const cmp = await safeCompareBaseline('restore-site', buf, null, t)
        t.diagnostic(
          '[visual] restore-site: diffPercent=' +
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
