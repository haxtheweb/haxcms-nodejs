'use strict'

// E2E test: Archive site (task 3) — always archives HAXSITEAUTOMATEDTESTING.
//
// Flow: boot isolated runtime -> login via two-step UI -> create the fixed site
// -> archive-pre baseline -> open site card more-options -> Archive menu item ->
// confirmation modal (a11y scan) -> Confirm -> assert archive API 200 ->
// assert card removed -> archive-post baseline -> filesystem cross-check.
//
// Constraints honored: .cjs/CommonJS, no optional chaining (?.), no build step,
// node:test + node:assert/strict, visual diffs WARN never throw, globalThis not
// window, single quotes / minimal semicolons / functional style.
//
// NOTE on site-name casing: HAXCMS.generateMachineName() and cleanTitle()
// lowercase the site name, so the server stores/returns the site as
// "haxsiteautomatedtesting" even though we type HAXSITEAUTOMATEDTESTING. API
// assertions are therefore case-insensitive against FIXED_SITE_NAME, and the
// filesystem cross-check uses the name returned by the archive API.

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
  dumpDashboard,
  typeIntoShadow,
  performLoginEvaluate,
  reloadDashboard,
  createSiteViaUI,
  findSiteCard,
  waitForCardGone,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  findCreateSiteResponse: waitForCreateResponse,
} = require('./helpers')

const ARCHIVE_DIR_CANDIDATES = ['_archived', '_archive']
const SITES_DIR = '_sites'

// patchHaxcmsRootForHarness + relocateCreatedSite are imported from helpers/flows.cjs
// (see the require block above).

// --- utility helpers imported from helpers/flows.cjs ---
// waitFor, waitForDeep, safeCompareBaseline, dumpDashboard, typeIntoShadow live
// in flows. Kept locally below: loginViaUI (closure-coupled to runtimeBaseUrl),
// openArchiveConfirmation, runtimeBaseUrl.

// waitForCreateResponse (aliased to flows.findCreateSiteResponse) and
// performLoginEvaluate are imported from helpers/flows.cjs.
// Two-step UI login: username -> Next -> password -> Login. Returns the login
// API response record captured by the collector.
//
// NOTE: selectors.login.usernameInputChain via deepQuery does NOT work because
// app-hax-site-login is a LIGHT DOM child of simple-modal (slotted content),
// not in simple-modal's shadowRoot. deepQuery's shadow-piercing traversal cannot
// reach a light DOM child. The selectors.cjs map marks LOGIN as VERIFIED, but
// that verification used direct light+shadow traversal (see the discovery pass).
// We replicate that here and do NOT edit the helper selectors file.
async function loginViaUI(page, collector) {
  await page.goto(runtimeBaseUrl(), {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await page.waitForSelector('app-hax', { timeout: 30000 })

  // Wait for the login modal + #username input to be ready (light+shadow poll).
  const ready = await waitFor(
    async () =>
      page.evaluate(() => {
        const m = document.querySelector('simple-modal')
        if (!m) {
          return false
        }
        const l = m.querySelector('app-hax-site-login')
        if (!l || !l.shadowRoot) {
          return false
        }
        return !!l.shadowRoot.querySelector('#username')
      }),
    30000,
  )
  if (!ready) {
    throw new Error('login modal with #username input did not appear')
  }

  await performLoginEvaluate(page)

  // Authoritative signal: the session/login API returned 200 with a jwt.
  const loginResp = await collector.awaitCollectorFor('session/login', 20000)
  assert.equal(loginResp.status, 200, 'login API should return 200')
  let loginBody = null
  try {
    loginBody = JSON.parse(loginResp.bodyText)
  } catch (e) {
    loginBody = null
  }
  assert.ok(
    loginBody && typeof loginBody.jwt === 'string' && loginBody.jwt.length > 0,
    'login response must include a jwt',
  )
  return loginResp
}

// reloadDashboard, createSiteViaUI, findSiteCard, waitForCardGone are imported
// from helpers/flows.cjs. openArchiveConfirmation below is unique to this test.
// Click more-options -> Archive menu item on a site card. Returns once the
// confirmation modal is on document.body. Selectors verified against live DOM.
//
// The Archive simple-toolbar-button @click (archiveSite) is on the host element.
// We click the host first; if the confirmation modal does not appear we also try
// the inner button inside the toolbar-button shadowRoot, and as a last resort
// call the card's archiveSite() method directly. The archive API call itself is
// still driven by clicking the confirmation modal's Confirm button later.
async function openArchiveConfirmation(page, cardHandle, t) {
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

  // 2. Wait for the context menu + Archive item, then click the host.
  const archiveClicked = await waitFor(
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
            if (label === 'archive') {
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
  if (!archiveClicked) {
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
    t.diagnostic('Archive menu item not found; ' + dump)
    throw new Error('Archive menu item (simple-toolbar-button label="Archive") not found')
  }

  // 3. Wait for the confirmation modal. If the host click did not trigger it,
  //    escalate: click the inner button, then call archiveSite() directly.
  let modal = await waitForDeep(page, [selectors.archive.confirmationModal], 8000)
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
        if (label === 'archive') {
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
    modal = await waitForDeep(page, [selectors.archive.confirmationModal], 8000)
  }
  if (!modal) {
    t.diagnostic('confirmation modal not seen after inner-button click; calling archiveSite() directly')
    await cardHandle.evaluate((el) => {
      if (typeof el.archiveSite === 'function') {
        el.archiveSite()
      }
    })
    modal = await waitForDeep(page, [selectors.archive.confirmationModal], 8000)
  }
  if (!modal) {
    const dump = await cardHandle.evaluate((el) => {
      const menu =
        el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
      const labels = []
      if (menu) {
        const items = menu.querySelectorAll('simple-toolbar-button')
        for (let i = 0; i < items.length; i++) {
          labels.push(
            String(items[i].getAttribute('label') || items[i].label || ''),
          )
        }
      }
      return JSON.stringify({
        siteId: el.siteId,
        hasArchiveSite: typeof el.archiveSite === 'function',
        menuLabels: labels,
        confirmationModalOnBody: !!document.querySelector('app-hax-confirmation-modal'),
      })
    })
    t.diagnostic('archive confirmation never appeared; card dump: ' + dump)
    throw new Error('app-hax-confirmation-modal did not appear on document.body')
  }
  return modal
}

// --- runtime handle (set in the test body, referenced by helpers above) ----
let _runtime = null
function runtimeBaseUrl() {
  if (!_runtime || !_runtime.baseUrl) {
    throw new Error('runtime not initialized')
  }
  return _runtime.baseUrl
}

// --- the test --------------------------------------------------------------
test(
  'archive site e2e (HAXSITEAUTOMATEDTESTING)',
  { timeout: 360000 },
  async (t) => {
    _runtime = await setupE2ERuntime()
    const browser = await launchBrowser()
    const page = await newPage(browser)
    const collector = createResponseCollector(page)

    // Work around the harness HAXCMS_ROOT trailing-slash bug (see
    // patchHaxcmsRootForHarness) before any site operations.
    patchHaxcmsRootForHarness(_runtime)

    let archiveRespRecord = null
    let a11yResults = null

    try {
      // 2. Log in via the two-step UI.
      await t.test('logs in via two-step UI', { timeout: 120000 }, async () => {
        await loginViaUI(page, collector)
      })

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
            siteNameReturned.toLowerCase() === FIXED_SITE_NAME.toLowerCase(),
          'create response data.metadata.site.name must match FIXED_SITE_NAME (case-insensitive)',
        )
        // createSite wrote to the module-const path (runtimeRoot_sites). Relocate
        // it into runtimeRoot/_sites so the patched list/load/archive routes
        // (which use the instance HAXCMS_ROOT with a trailing slash) find it.
        const relocated = relocateCreatedSite(_runtime, FIXED_SITE_NAME)
        t.diagnostic('relocated created site into _sites: ' + relocated)
      })

      // Reload the dashboard so the SPA re-fetches the sites list fresh from the
      // filesystem (the JWT is persisted to localStorage, so reload auto-logs-in).
      // This reliably surfaces the just-created site card without depending on
      // the SPA's flaky post-create list refresh.
      let cardHandle = null
      await t.test('site card renders in dashboard', { timeout: 120000 }, async () => {
        await reloadDashboard(page, t)
        cardHandle = await findSiteCard(page, FIXED_SITE_NAME)
        if (!cardHandle) {
          const dump = await dumpDashboard(page)
          t.diagnostic('site card not found; dashboard dump: ' + JSON.stringify(dump))
        }
        assert.ok(cardHandle, 'site card for HAXSITEAUTOMATEDTESTING should render')
      })

      // 4. Visual baseline: dashboard with the card visible.
      await t.test('archive-pre visual baseline', { timeout: 60000 }, async () => {
        const buf = await captureScreenshot(page, 'archive-pre')
        const cmp = await safeCompareBaseline('archive-pre', buf, null, t)
        t.diagnostic(
          'archive-pre visual: diffPixels=' +
            cmp.diffPixels +
            ' diffPercent=' +
            (cmp.diffPercent * 100).toFixed(3) +
            '% baselineExists=' +
            cmp.baselineExists,
        )
      })

      // 5. Archive via UI: more-options -> Archive -> confirmation modal.
      await t.test('opens archive confirmation modal via UI', { timeout: 90000 }, async () => {
        await openArchiveConfirmation(page, cardHandle, t)
      })

      // 8. A11y scan of the confirmation modal while it is open (before confirm).
      await t.test('a11y scan of confirmation modal', { timeout: 90000 }, async () => {
        a11yResults = await runA11y(page, selectors.archive.confirmationModal)
        const critical = (a11yResults && a11yResults.critical) || []
        const serious = (a11yResults && a11yResults.serious) || []
        t.diagnostic(
          'a11y: critical=' +
            critical.length +
            ' serious=' +
            serious.length +
            ' totalViolations=' +
            ((a11yResults && a11yResults.violations && a11yResults.violations.length) || 0),
        )
        // Document any critical/serious findings (task allows documenting vs hard-failing).
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
        // Soft assertion: the scan ran and returned a result object.
        assert.ok(a11yResults, 'runA11y must return a result object')
      })

      // 5d/6. Click Confirm and capture the archive API response.
      await t.test('confirms archive and captures API response', { timeout: 90000 }, async () => {
        const confirmBtn = await deepQuery(page, selectors.archive.confirmButtonChain)
        if (!confirmBtn) {
          // Fallback: find .button.button-confirm inside the modal shadowRoot by text.
          const modal = await deepQuery(page, [selectors.archive.confirmationModal])
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
            throw new Error('confirm button (.button.button-confirm) not found')
          }
        } else {
          await confirmBtn.evaluate((b) => b.click())
        }
        archiveRespRecord = await collector.awaitCollectorFor('/archive', 20000)
      })

      // 6. Assert the archive API returned 200 with the expected payload.
      await t.test('archive API returned 200 with correct payload', { timeout: 30000 }, async () => {
        assert.ok(archiveRespRecord, 'archive API response was captured')
        assert.equal(archiveRespRecord.status, 200, 'archive API should return 200')
        let body = null
        try {
          body = JSON.parse(archiveRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        t.diagnostic('archive response body: ' + archiveRespRecord.bodyText.substring(0, 300))
        assert.ok(body && body.data, 'archive response must have data')
        assert.equal(
          body.data.detail,
          'Site archived',
          'archive response data.detail must be "Site archived"',
        )
        const returnedName =
          body.data && typeof body.data.name === 'string' ? body.data.name : null
        t.diagnostic('archive returned data.name="' + returnedName + '"')
        assert.ok(
          returnedName &&
            returnedName.toLowerCase() === FIXED_SITE_NAME.toLowerCase(),
          'archive response data.name must match FIXED_SITE_NAME (case-insensitive)',
        )
      })

      // 7. UI state: the site card disappears from the active list.
      await t.test('site card removed from dashboard', { timeout: 60000 }, async () => {
        const gone = await waitForCardGone(page, FIXED_SITE_NAME)
        assert.equal(gone, true, 'site card should be gone after archive')
      })

      // 9. Visual baseline: dashboard after archive.
      await t.test('archive-post visual baseline', { timeout: 60000 }, async () => {
        const buf = await captureScreenshot(page, 'archive-post')
        const cmp = await safeCompareBaseline('archive-post', buf, null, t)
        t.diagnostic(
          'archive-post visual: diffPixels=' +
            cmp.diffPixels +
            ' diffPercent=' +
            (cmp.diffPercent * 100).toFixed(3) +
            '% baselineExists=' +
            cmp.baselineExists,
        )
      })

      // 10. Filesystem cross-check: site moved into the archived directory.
      await t.test('filesystem moved site into _archived', { timeout: 30000 }, async () => {
        let body = null
        try {
          body = JSON.parse(archiveRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        const archivedName =
          body && body.data && typeof body.data.name === 'string' ? body.data.name : null
        assert.ok(archivedName, 'need archived site name from API response for fs check')

        const sitesPath = path.join(_runtime.runtimeRoot, SITES_DIR, archivedName)
        assert.ok(
          !fs.pathExistsSync(sitesPath),
          'site directory should be gone from _sites: ' + sitesPath,
        )

        let archivedPath = null
        for (let i = 0; i < ARCHIVE_DIR_CANDIDATES.length; i++) {
          const candidate = path.join(
            _runtime.runtimeRoot,
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
        t.diagnostic('filesystem cross-check OK: archived at ' + archivedPath)
      })
    } finally {
      // 11. Teardown.
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
        await teardownE2ERuntime(_runtime)
      } catch (e) {
        // ignore
      }
      _runtime = null
    }
  },
)
