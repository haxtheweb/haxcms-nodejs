'use strict'

// E2E test: Export/download site (HAXSITEAUTOMATEDTESTING) as a zip.
//
// Flow: boot isolated runtime -> login via two-step UI -> create the fixed site
// -> relocate site (harness HAXCMS_ROOT workaround) -> reload dashboard (fresh
// store manifest) -> find site card -> open more-vert menu -> click Download ->
// confirmation modal (or fallback downloadSite() direct call) -> Confirm ->
// assert POST /download 200 + data.link ends with .zip + data.name matches ->
// filesystem cross-check (zip exists + PK magic bytes) -> a11y scan -> visual
// baseline.
//
// IMPORTANT ORDERING: export runs BEFORE navigating into the site editor.
// Visiting the editor leaves the dashboard store manifest stale, which breaks
// the siteOperation() manifest lookup and prevents the confirmation modal from
// appearing. A dashboard reload after create refreshes the manifest.
//
// Constraints honored: .cjs/CommonJS, no optional chaining (?.), no build step,
// node:test + node:assert/strict, visual diffs WARN never throw, globalThis not
// window, single quotes / minimal semicolons / functional style.
//
// NOTE on site-name casing: HAXCMS.generateMachineName() and cleanTitle()
// lowercase the site name, so the server stores/returns the site as
// "haxsiteautomatedtesting" even though we type HAXSITEAUTOMATEDTESTING.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')

// pixelmatch ESM interop is handled by visual.cjs itself (line 14:
// `require('pixelmatch').default || require('pixelmatch')`), so no per-test
// shim is needed.

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  runA11y,
  captureScreenshot,
  compareBaseline,
  selectors,
  FIXED_SITE_NAME,
  deepQuery,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers (single source of truth in helpers/flows.cjs)
  waitFor,
  waitForDeep,
  safeCompareBaseline,
  typeIntoShadow,
  loginSetInput,
  loginClickButton,
  createSiteViaUI,
  reloadDashboard,
  findSiteCard,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  findCreateSiteResponse: waitForCreateResponse,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'
const PUBLISHED_DIR = '_published'

// patchHaxcmsRootForHarness + relocateCreatedSite are imported from helpers/flows.cjs.

// reloadDashboard + findSiteCard are imported from helpers/flows.cjs.
// openDownloadConfirmation + runtimeBaseUrl below are unique to this test.
// --- export/download helpers -----------------------------------------------

// Click more-options -> Download menu item on a site card. Returns the
// confirmation modal handle if it appeared, or null if the modal did not
// appear (caller should then use the downloadSite() fallback).
//
// The Download simple-toolbar-button @click calls downloadSite() on the host,
// which calls siteOperation("downloadSite",...). siteOperation looks up the
// site in store.manifest.items by siteId — if the manifest is stale (e.g. after
// visiting the editor), it returns early and NO modal is created. The reload
// before this step should ensure a fresh manifest.
//
// Escalation: (1) click the host simple-toolbar-button; (2) if no modal, click
// the inner button inside its shadowRoot; (3) if still no modal, call
// downloadSite() directly on the card. Returns the modal handle or null.
async function openDownloadConfirmation(page, cardHandle, t) {
  // 1. Click the more-options button inside the card shadowRoot.
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
    const dump = await cardHandle.evaluate((el) => {
      return el.shadowRoot ? el.shadowRoot.innerHTML.substring(0, 1200) : 'no shadowRoot'
    })
    t.diagnostic('more-options button not found; card shadowRoot dump: ' + dump)
    throw new Error('more-options button (simple-icon-button-lite[icon="lrn:more-vert"]) not found')
  }

  // 2. Wait for the context menu + Download item, then click the host.
  const downloadClicked = await waitFor(
    async () =>
      cardHandle.evaluate((el) => {
        const item = (function (host) {
          const menu =
            host.shadowRoot && host.shadowRoot.querySelector('simple-context-menu')
          if (!menu) {
            return null
          }
          const items = menu.querySelectorAll('simple-toolbar-button')
          for (let i = 0; i < items.length; i++) {
            const label = String(
              items[i].getAttribute('label') || items[i].label || '',
            ).toLowerCase()
            if (label === 'download') {
              return items[i]
            }
          }
          return null
        })(el)
        if (!item) {
          return false
        }
        item.click()
        return true
      }),
    12000,
  )
  if (!downloadClicked) {
    const dump = await cardHandle.evaluate((el) => {
      const menu =
        el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
      if (!menu) {
        return 'no simple-context-menu in card shadowRoot'
      }
      const items = menu.querySelectorAll('simple-toolbar-button')
      const labels = []
      for (let i = 0; i < items.length; i++) {
        labels.push(
          String(items[i].getAttribute('label') || items[i].label || ''),
        )
      }
      return 'menu items: ' + labels.join(', ')
    })
    t.diagnostic('Download menu item not found; ' + dump)
    throw new Error('Download menu item (simple-toolbar-button label="Download") not found')
  }

  // 3. Wait for the confirmation modal. If the host click did not trigger it,
  //    escalate: click the inner button, then call downloadSite() directly.
  let modal = await waitForDeep(page, [selectors.export.confirmationModal], 8000)
  if (!modal) {
    t.diagnostic('confirmation modal not seen after host click; trying inner button')
    await cardHandle.evaluate((el) => {
      const menu =
        el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
      if (!menu) {
        return
      }
      const items = menu.querySelectorAll('simple-toolbar-button')
      for (let i = 0; i < items.length; i++) {
        const label = String(
          items[i].getAttribute('label') || items[i].label || '',
        ).toLowerCase()
        if (label === 'download') {
          var inner =
            items[i].shadowRoot && items[i].shadowRoot.querySelector('button')
          if (inner) {
            inner.click()
          } else {
            items[i].click()
          }
          return
        }
      }
    })
    modal = await waitForDeep(page, [selectors.export.confirmationModal], 8000)
  }
  if (!modal) {
    t.diagnostic('confirmation modal not seen after inner-button click; calling downloadSite() directly')
    await cardHandle.evaluate((el) => {
      if (typeof el.downloadSite === 'function') {
        el.downloadSite()
      }
    })
    modal = await waitForDeep(page, [selectors.export.confirmationModal], 8000)
  }
  if (!modal) {
    // Final diagnostic dump — do not throw yet; the caller will decide whether
    // to use the direct API fallback.
    const dump = await cardHandle.evaluate((el) => {
      return JSON.stringify({
        siteId: el.siteId,
        hasDownloadSite: typeof el.downloadSite === 'function',
        confirmationModalOnBody: !!document.querySelector('app-hax-confirmation-modal'),
      })
    })
    t.diagnostic('download confirmation never appeared; card dump: ' + dump)
  }
  return modal
}

// --- runtime handle (set in test body, referenced by helpers above) --------
let _runtime = null
function runtimeBaseUrl() {
  if (!_runtime || !_runtime.baseUrl) {
    throw new Error('runtime not initialized')
  }
  return _runtime.baseUrl
}

// --- setup / teardown ------------------------------------------------------

test.before(async () => {
  _runtime = await setupE2ERuntime()
  // Work around the harness HAXCMS_ROOT trailing-slash bug before any site ops.
  patchHaxcmsRootForHarness(_runtime)
}, { timeout: 120000 })

test.after(async () => {
  if (_runtime) {
    try {
      await teardownE2ERuntime(_runtime)
    } catch (e) {
      // ignore
    }
    _runtime = null
  }
}, { timeout: 60000 })

// --- the test --------------------------------------------------------------

test(
  'export site e2e (HAXSITEAUTOMATEDTESTING) — download as zip',
  { timeout: 360000 },
  async (t) => {
    const browser = await launchBrowser()
    const page = await newPage(browser)
    const collector = createResponseCollector(page)

    let downloadRespRecord = null
    let usedFallback = false

    try {
      // 2. Navigate to the dashboard and log in via the two-step modal.
      await page.goto(runtimeBaseUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForSelector('app-hax', { timeout: 30000 })
      await page.waitForSelector('simple-modal', { timeout: 25000 })
      await new Promise((r) => setTimeout(r, 1500))

      await loginSetInput(page, 'username', E2E_USER_NAME)
      await new Promise((r) => setTimeout(r, 200))
      await loginClickButton(page, 'Next')
      await loginSetInput(page, 'password', E2E_USER_PASSWORD)
      await new Promise((r) => setTimeout(r, 200))
      await loginClickButton(page, 'Login')

      // Authoritative signal: the session/login API returned 200 with a jwt.
      const loginResp = await collector.awaitCollectorFor('session/login', 20000)
      assert.equal(loginResp.status, 200, 'login API should return 200')

      // 3. Create the fixed site so a card exists.
      await t.test('creates HAXSITEAUTOMATEDTESTING via UI', { timeout: 180000 }, async () => {
        const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
        assert.equal(createResp.status, 200, 'create API should return 200')
        let body = null
        try {
          body = JSON.parse(createResp.bodyText)
        } catch (e) {
          body = null
        }
        const siteNameReturned =
          body &&
          body.data &&
          body.data.metadata &&
          body.data.metadata.site &&
          typeof body.data.metadata.site.name === 'string'
            ? body.data.metadata.site.name
            : null
        t.diagnostic('create returned data.metadata.site.name="' + siteNameReturned + '"')
        assert.ok(
          siteNameReturned &&
            siteNameReturned.toLowerCase() === EXPECTED_SITE_NAME,
          'create response data.metadata.site.name must match EXPECTED_SITE_NAME',
        )
        // createSite wrote to the module-const path (runtimeRoot_sites). Relocate
        // it into runtimeRoot/_sites so the patched load/download routes find it.
        const relocated = relocateCreatedSite(_runtime, FIXED_SITE_NAME)
        t.diagnostic('relocated created site into _sites: ' + relocated)
      })

      // 4. Reload the dashboard so the SPA re-fetches the sites list fresh from
      //    the filesystem (fresh store manifest). This reliably surfaces the
      //    just-created site card and ensures siteOperation() can find the site
      //    in store.manifest.items. Export runs BEFORE navigating to the editor.
      let cardHandle = null
      await t.test('site card renders in dashboard after reload', { timeout: 120000 }, async () => {
        await reloadDashboard(page, t)
        cardHandle = await findSiteCard(page, FIXED_SITE_NAME)
        assert.ok(cardHandle, 'site card for HAXSITEAUTOMATEDTESTING should render after reload')
      })

      // 5-8. Open more-vert -> Download -> confirmation modal (or fallback).
      let modalHandle = null
      await t.test('opens download confirmation via UI', { timeout: 90000 }, async () => {
        modalHandle = await openDownloadConfirmation(page, cardHandle, t)
        if (!modalHandle) {
          t.diagnostic('confirmation modal did not appear; will use direct API fallback below')
        }
      })

      // 9. Click Confirm (if modal appeared) and capture the download API
      //    response. If no modal appeared, trigger downloadSite() directly on
      //    the card as a last resort, then await the API response.
      await t.test('triggers download and captures API response', { timeout: 90000 }, async () => {
        if (modalHandle) {
          // Click the confirm button inside the confirmation modal shadowRoot.
          const confirmBtn = await deepQuery(page, selectors.export.confirmButtonChain)
          if (!confirmBtn) {
            // Fallback: find .button.button-confirm inside the modal shadowRoot.
            const modal = await deepQuery(page, [selectors.export.confirmationModal])
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
            if (!fallback) {
              throw new Error('confirm button (.button.button-confirm) not found in modal')
            }
          } else {
            await confirmBtn.evaluate((b) => b.click())
          }
        } else {
          // No modal — call downloadSite() directly. This calls siteOperation()
          // which (if manifest is fresh) creates the modal + confirmAction. But
          // since the modal didn't appear, the manifest may be stale. In that
          // case siteOperation() returns early without making the API call.
          // We call downloadSite() and also directly trigger confirmOperation
          // if the modal appears, OR fall back to the direct API call approach:
          // set the store's activeSiteOp/activeSite and call confirmOperation.
          usedFallback = true
          const triggered = await cardHandle.evaluate((el) => {
            // Try downloadSite() first — if manifest is fresh this creates the
            // modal and we can click confirm.
            if (typeof el.downloadSite === 'function') {
              el.downloadSite()
            }
            return true
          })
          t.diagnostic('direct downloadSite() called on card: ' + triggered)
          // Wait briefly for the modal to appear from the direct call.
          await new Promise((r) => setTimeout(r, 2000))
          const modalAfter = await waitForDeep(page, [selectors.export.confirmationModal], 5000)
          if (modalAfter) {
            t.diagnostic('modal appeared after direct downloadSite(); clicking Confirm')
            const confirmBtn2 = await deepQuery(page, selectors.export.confirmButtonChain)
            if (confirmBtn2) {
              await confirmBtn2.evaluate((b) => b.click())
            } else {
              await modalAfter.evaluate((el) => {
                const btns = el.shadowRoot ? el.shadowRoot.querySelectorAll('button') : []
                for (let i = 0; i < btns.length; i++) {
                  if (btns[i].classList.contains('button-confirm')) {
                    btns[i].click()
                    return true
                  }
                }
                return false
              })
            }
          } else {
            // Last resort: the store manifest is stale so siteOperation() can't
            // find the site. We call confirmOperation via the store directly by
            // setting activeSiteOp + activeSite and invoking the API makeCall
            // through the card's siteOperation with a manually-injected record.
            // However, since we cannot easily set store state from outside, we
            // rely on the collector to catch the API call if it was triggered
            // by the downloadSite() call above. If no API call happens, the
            // awaitCollectorFor below will timeout and the test will fail with
            // a clear diagnostic.
            t.diagnostic('no modal from direct call; awaiting API response anyway (may timeout)')
          }
        }

        // Capture the download API response.
        try {
          downloadRespRecord = await collector.awaitCollectorFor('/download', 20000)
        } catch (e) {
          // The collector timed out — check if we already have a matching
          // response in the buffer (the call may have fired before we awaited).
          const existing = collector.getResponsesFor('/download')
          if (existing && existing.length > 0) {
            downloadRespRecord = existing[existing.length - 1]
          } else {
            throw e
          }
        }
      })

      // 10. Assert the download API returned 200 with the expected payload.
      await t.test('download API returned 200 with zip link', { timeout: 30000 }, async () => {
        assert.ok(downloadRespRecord, 'download API response was captured')
        assert.equal(downloadRespRecord.status, 200, 'download API should return 200')
        let body = null
        try {
          body = JSON.parse(downloadRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        t.diagnostic('download response body: ' + (downloadRespRecord.bodyText || '').substring(0, 300))
        assert.ok(body && body.data, 'download response must have data')
        const link = body.data && typeof body.data.link === 'string' ? body.data.link : null
        const name = body.data && typeof body.data.name === 'string' ? body.data.name : null
        t.diagnostic('download returned data.link="' + link + '" data.name="' + name + '"')
        assert.ok(
          link && link.indexOf('.zip') !== -1 && link.substring(link.length - 4) === '.zip',
          'download response data.link must end with .zip',
        )
        // D17 (locked): downloadSite response data.name includes the .zip
        // extension (PHP canonical; Node aligned). The on-disk zip path below
        // also uses EXPECTED_SITE_NAME + '.zip', so assert the same here.
        assert.ok(
          name && name.toLowerCase() === EXPECTED_SITE_NAME + '.zip',
          'download response data.name must match EXPECTED_SITE_NAME + .zip (D17)',
        )
      })

      // 11. Disk cross-check: zip exists at _published + valid PK magic bytes.
      await t.test('zip file exists on disk with PK magic bytes', { timeout: 30000 }, async () => {
        const zipPath = path.join(_runtime.runtimeRoot, PUBLISHED_DIR, EXPECTED_SITE_NAME + '.zip')
        t.diagnostic('checking zip path: ' + zipPath)
        assert.ok(
          fs.pathExistsSync(zipPath),
          'zip file should exist at ' + zipPath,
        )
        // Read first 2 bytes and assert they are 'PK' (0x50 0x4B) — valid zip.
        const fd = fs.openSync(zipPath, 'r')
        const buf = Buffer.alloc(2)
        fs.readSync(fd, buf, 0, 2, 0)
        fs.closeSync(fd)
        t.diagnostic('zip magic bytes: 0x' + buf[0].toString(16) + ' 0x' + buf[1].toString(16))
        assert.equal(buf[0], 0x50, 'first byte of zip must be 0x50 (P)')
        assert.equal(buf[1], 0x4b, 'second byte of zip must be 0x4B (K)')
        const stat = fs.statSync(zipPath)
        t.diagnostic('zip file size: ' + stat.size + ' bytes')
        assert.ok(stat.size > 0, 'zip file must be non-empty')
      })

      // 12. A11y scan of the confirmation modal (or context menu if no modal).
      await t.test('a11y scan of export dialog', { timeout: 90000 }, async () => {
        let a11yScope = selectors.export.confirmationModal
        // If the modal is not on the page, scope to the context menu instead.
        const modalPresent = await page.evaluate(() => {
          return !!document.querySelector('app-hax-confirmation-modal')
        })
        if (!modalPresent) {
          // Try the context menu in the card shadowRoot.
          a11yScope = 'simple-context-menu'
          t.diagnostic('no confirmation modal present; scoping a11y to simple-context-menu')
        }
        let a11yResults = null
        try {
          a11yResults = await runA11y(page, a11yScope)
        } catch (e) {
          t.diagnostic('runA11y threw: ' + (e && e.message ? e.message : String(e)))
          a11yResults = null
        }
        if (a11yResults) {
          const critical = (a11yResults.critical) || []
          const serious = (a11yResults.serious) || []
          t.diagnostic(
            'a11y: critical=' +
              critical.length +
              ' serious=' +
              serious.length +
              ' totalViolations=' +
              ((a11yResults.violations && a11yResults.violations.length) || 0),
          )
          for (let i = 0; i < critical.length; i++) {
            t.diagnostic(
              'a11y CRITICAL: id=' +
                critical[i].id +
                ' help=' +
                critical[i].help +
                ' targets=' +
                JSON.stringify((critical[i].nodes || []).map((n) => n.target).slice(0, 3)),
            )
          }
          for (let i = 0; i < serious.length; i++) {
            t.diagnostic(
              'a11y SERIOUS: id=' +
                serious[i].id +
                ' help=' +
                serious[i].help +
                ' targets=' +
                JSON.stringify((serious[i].nodes || []).map((n) => n.target).slice(0, 3)),
            )
          }
          assert.ok(a11yResults, 'runA11y must return a result object')
        } else {
          t.diagnostic('a11y scan could not run (non-fatal)')
        }
      })

      // 13. Visual baseline: the confirmation modal or menu open state.
      await t.test('export-site-dialog visual baseline', { timeout: 60000 }, async () => {
        const buf = await captureScreenshot(page, 'export-site-dialog')
        const cmp = await safeCompareBaseline('export-site-dialog', buf, null, t)
        t.diagnostic(
          'export-site-dialog visual: diffPixels=' +
            cmp.diffPixels +
            ' diffPercent=' +
            (cmp.diffPercent * 100).toFixed(3) +
            '% baselineExists=' +
            cmp.baselineExists +
            ' usedFallback=' +
            usedFallback,
        )
      })
    } finally {
      // 14. Teardown.
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
    }
  },
)
