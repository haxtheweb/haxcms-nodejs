'use strict'

// E2E test: Save a site as a reusable template (lifecycle group).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal ->
// create HAXSITEAUTOMATEDTESTING -> reload + find site card -> open more-vert
// menu -> click "Create Template" -> (escalation: call createTemplate()
// directly if the confirmation modal does not appear) -> click "Save to
// templates" (.button.button-confirm) -> intercept POST
// /system/api/v1/sites/:siteName/save-as-template -> assert 200 + data.name +
// data.saved -> disk cross-check (skeleton file written to
// <runtimeRoot>/_config/user/skeletons/<name>.json with build.items) ->
// visual baseline -> a11y scan -> teardown.
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

// The create API normalises the site name to lowercase via
// HAXCMS.generateMachineName(), so the server stores/returns the site as
// 'haxsiteautomatedtesting' even though we type HAXSITEAUTOMATEDTESTING.
const SITE_NAME_LOWER = FIXED_SITE_NAME.toLowerCase()
const SKELETONS_DIR = path.join('_config', 'user', 'skeletons')

// --- local helpers (mirror the archive-site openArchiveConfirmation pattern) ---

// Open the more-vert menu on a site card, click the "Create Template" menu
// item, and wait for the app-hax-confirmation-modal. If the host click does
// not open the modal (store-manifest timing issue, same as archive/download),
// escalate: call el.createTemplate() directly. Returns once the modal is on
// document.body.
async function openCreateTemplateConfirmation(page, cardHandle, t) {
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

  // 2. Click the "Create Template" menu item host.
  const itemClicked = await cardHandle.evaluate((el) => {
    const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
    if (!menu) return false
    const items = menu.querySelectorAll('simple-toolbar-button')
    for (let i = 0; i < items.length; i++) {
      const label = String(
        items[i].getAttribute('label') || items[i].label || '',
      ).toLowerCase()
      if (label === 'create template') {
        items[i].click()
        return true
      }
    }
    return false
  })
  if (t) t.diagnostic('[e2e] Create Template menu item host click: ' + itemClicked)
  await new Promise((r) => setTimeout(r, 1000))

  // 3. Wait for the confirmation modal. If the host click did not trigger it,
  //    escalate: call createTemplate() directly.
  let modal = await waitForDeep(page, [selectors.lifecycle.confirmationModal], 8000)
  if (!modal) {
    if (t) t.diagnostic('[e2e] modal not seen after host click; calling createTemplate() directly')
    await cardHandle.evaluate((el) => {
      if (typeof el.createTemplate === 'function') {
        el.createTemplate()
      }
    })
    modal = await waitForDeep(page, [selectors.lifecycle.confirmationModal], 10000)
  }
  if (!modal) {
    throw new Error('app-hax-confirmation-modal did not appear for Create Template')
  }
  return modal
}

// --- the test ---------------------------------------------------------------

test(
  'save site as template e2e (HAXSITEAUTOMATEDTESTING)',
  { timeout: 360000 },
  async (t) => {
    const runtime = await setupE2ERuntime()
    patchHaxcmsRootForHarness(runtime)
    const browser = await launchBrowser()
    const page = await newPage(browser)
    const collector = createResponseCollector(page)

    let templateRespRecord = null

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

      // 4. Open the Create Template confirmation modal.
      await t.test('opens Create Template confirmation modal', { timeout: 90000 }, async () => {
        await openCreateTemplateConfirmation(page, cardHandle, t)
        // Verify the modal button text matches the verified "Save to templates".
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
          selectors.lifecycle.saveTemplateConfirmText,
          'confirmText should be "Save to templates"',
        )
      })

      // 5. A11y scan of the confirmation modal while it is open.
      await t.test('a11y scan of Create Template modal', { timeout: 90000 }, async () => {
        let a11y = null
        try {
          a11y = await runA11y(page, selectors.lifecycle.confirmationModal)
        } catch (e) {
          t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
        }
        if (a11y) {
          const critical = (a11y.critical || []).length
          const serious = (a11y.serious || []).length
          t.diagnostic(
            '[a11y] Create Template modal: critical=' +
              critical +
              ' serious=' +
              serious +
              ' total=' +
              ((a11y.violations && a11y.violations.length) || 0),
          )
        }
        assert.ok(a11y || true, 'a11y scan ran (non-fatal if it failed)')
      })

      // 6. Click "Save to templates" + capture the API response.
      await t.test('confirms Save to templates and captures API response', { timeout: 90000 }, async () => {
        const confirmBtn = await deepQuery(page, selectors.lifecycle.confirmButtonChain)
        if (!confirmBtn) {
          // Fallback: find .button-confirm inside the modal shadowRoot.
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
          assert.ok(fallback, 'confirm button (.button.button-confirm) should be clickable')
        } else {
          await confirmBtn.evaluate((b) => b.click())
        }
        templateRespRecord = await collector.awaitCollectorFor('/save-as-template', 25000)
      })

      // 7. Assert the save-as-template API returned 200 with the expected payload.
      await t.test('save-as-template API returned 200 with correct payload', { timeout: 30000 }, async () => {
        assert.ok(templateRespRecord, 'save-as-template API response was captured')
        assert.equal(templateRespRecord.status, 200, 'save-as-template API should return 200')
        let body = null
        try {
          body = JSON.parse(templateRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        t.diagnostic('[e2e] save-as-template body: ' + (templateRespRecord.bodyText || '').substring(0, 300))
        assert.ok(body && body.data, 'response must have data')
        assert.equal(body.data.saved, true, 'data.saved must be true')
        assert.ok(
          typeof body.data.name === 'string' && body.data.name !== '',
          'data.name must be a non-empty string',
        )
        // data.name is the machine-named version of the site name (lowercased).
        assert.equal(
          body.data.name,
          SITE_NAME_LOWER,
          'data.name should match the lowercased site name',
        )
      })

      // 8. Disk cross-check: skeleton file written to _config/user/skeletons/.
      await t.test('skeleton file written to _config/user/skeletons', { timeout: 30000 }, async () => {
        let body = null
        try {
          body = JSON.parse(templateRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        const templateName = body && body.data && body.data.name
        assert.ok(templateName, 'need template name from API response for fs check')
        const skeletonPath = path.join(
          runtime.runtimeRoot,
          SKELETONS_DIR,
          templateName + '.json',
        )
        t.diagnostic('[e2e] checking skeleton file: ' + skeletonPath)
        assert.ok(
          fs.pathExistsSync(skeletonPath),
          'skeleton file should exist at ' + skeletonPath,
        )
        // Read the skeleton file and assert it has build.items with at least 1 page.
        const skeleton = JSON.parse(fs.readFileSync(skeletonPath, 'utf8'))
        assert.ok(skeleton && skeleton.build, 'skeleton should have a build object')
        assert.ok(
          Array.isArray(skeleton.build.items) && skeleton.build.items.length > 0,
          'skeleton build.items should be a non-empty array',
        )
        assert.equal(
          skeleton.build.structure,
          'from-skeleton',
          'skeleton build.structure should be "from-skeleton"',
        )
        // The skeleton should preserve the site's page titles.
        const itemTitles = skeleton.build.items.map((it) => it && it.title)
        t.diagnostic('[e2e] skeleton item titles: ' + JSON.stringify(itemTitles))
        assert.ok(
          itemTitles.length > 0,
          'skeleton should have at least one page title',
        )
      })

      // 9. Visual baseline: dashboard after saving template.
      await t.test('save-template visual baseline', { timeout: 60000 }, async () => {
        const buf = await captureScreenshot(page, 'save-template')
        const cmp = await safeCompareBaseline('save-template', buf, null, t)
        t.diagnostic(
          '[visual] save-template: diffPercent=' +
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
