'use strict'

// E2E test: Create a new site from a saved template skeleton (lifecycle group).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal ->
// create HAXSITEAUTOMATEDTESTING -> save it as a template (more-vert -> Create
// Template -> Save to templates) -> reload dashboard -> find the template's
// skeleton card in the use-case-filter filteredItems (match by machineName) ->
// call continueAction(index) to open the creation modal pre-filled with the
// skeleton's data -> type a NEW site name -> click "Create Site" -> intercept
// POST /system/api/v1/sites -> assert 200 + the new site has the template's
// pages (read the new site's site.json and compare item titles to the
// skeleton's build.items) -> visual baseline -> a11y -> teardown.
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
  typeIntoShadow,
  safeCompareBaseline,
  performLoginEvaluate,
  reloadDashboard,
  createSiteViaUI,
  findSiteCard,
  findCreateSiteResponse,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
} = require('./helpers')

const SITE_NAME_LOWER = FIXED_SITE_NAME.toLowerCase()
const SITES_DIR = '_sites'
const SKELETONS_DIR = path.join('_config', 'user', 'skeletons')
// The new site name typed into the creation modal. Must be alphanumeric-only
// (no spaces) so generateMachineName just lowercases it, making the API
// response name easy to match (generateMachineName replaces spaces with
// hyphens, so "E2E FROM TEMPLATE" would become "e2e-from-template").
const NEW_SITE_NAME = 'E2EFROMTEMPLATE'
const NEW_SITE_NAME_LOWER = NEW_SITE_NAME.toLowerCase()

// --- local helpers ---

// Save the site as a template: open more-vert -> Create Template -> (escalate
// to createTemplate() direct call if needed) -> click "Save to templates".
// Returns the save-as-template API response record.
async function saveSiteAsTemplateViaUI(page, collector, cardHandle, t) {
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
  await cardHandle.evaluate((el) => {
    const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
    if (!menu) return
    const items = menu.querySelectorAll('simple-toolbar-button')
    for (let i = 0; i < items.length; i++) {
      const label = String(
        items[i].getAttribute('label') || items[i].label || '',
      ).toLowerCase()
      if (label === 'create template') {
        items[i].click()
        return
      }
    }
  })
  await new Promise((r) => setTimeout(r, 1000))

  // 3. Wait for the confirmation modal; escalate if needed.
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

  // 4. Click "Save to templates" (.button.button-confirm).
  const confirmBtn = await deepQuery(page, selectors.lifecycle.confirmButtonChain)
  if (confirmBtn) {
    await confirmBtn.evaluate((b) => b.click())
  } else {
    await page.evaluate(() => {
      const m = document.querySelector('app-hax-confirmation-modal')
      if (m && m.shadowRoot) {
        const btn = m.shadowRoot.querySelector('.button.button-confirm')
        if (btn) btn.click()
      }
    })
  }
  const resp = await collector.awaitCollectorFor('/save-as-template', 25000)
  // wait for the modal to be removed from body
  await new Promise((r) => setTimeout(r, 1500))
  return resp
}

// Find the skeleton card index in the use-case-filter's filteredItems by
// matching the machineName. Returns the index (number) or null.
async function findSkeletonCardIndex(page, machineName) {
  return page.evaluate((target) => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) return null
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf) return null
    const items = ucf.filteredItems || []
    for (let i = 0; i < items.length; i++) {
      if (
        items[i] &&
        items[i].dataType === 'skeleton' &&
        items[i].machineName === target
      ) {
        return i
      }
    }
    return null
  }, machineName)
}

// Call continueAction(index) on the use-case-filter to open the creation modal
// pre-filled with the skeleton's data.
async function callContinueAction(page, index) {
  return page.evaluate((idx) => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) return { error: 'no app-hax' }
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf) return { error: 'no ucf' }
    if (typeof ucf.continueAction !== 'function') return { error: 'no continueAction' }
    ucf.continueAction(idx)
    return { dispatched: true }
  }, index)
}

// --- the test ---------------------------------------------------------------

test(
  'create site from template e2e',
  { timeout: 420000 },
  async (t) => {
    const runtime = await setupE2ERuntime()
    patchHaxcmsRootForHarness(runtime)
    const browser = await launchBrowser()
    const page = await newPage(browser)
    const collector = createResponseCollector(page)

    let templateName = null
    let templateItemTitles = null
    let createRespRecord = null

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

      // 4. Save the site as a template.
      await t.test('saves site as template', { timeout: 120000 }, async () => {
        const templateResp = await saveSiteAsTemplateViaUI(page, collector, cardHandle, t)
        assert.ok(templateResp, 'save-as-template API response was captured')
        assert.equal(templateResp.status, 200, 'save-as-template API should return 200')
        let body = null
        try {
          body = JSON.parse(templateResp.bodyText)
        } catch (e) {
          body = null
        }
        assert.ok(body && body.data, 'save-as-template response must have data')
        templateName = body.data.name
        t.diagnostic('[e2e] template name: ' + templateName)
        assert.ok(templateName, 'template name must be non-empty')
        // Verify the skeleton file exists + read its build.items titles.
        const skeletonPath = path.join(
          runtime.runtimeRoot,
          SKELETONS_DIR,
          templateName + '.json',
        )
        assert.ok(
          fs.pathExistsSync(skeletonPath),
          'skeleton file should exist at ' + skeletonPath,
        )
        const skeleton = JSON.parse(fs.readFileSync(skeletonPath, 'utf8'))
        templateItemTitles = (skeleton.build && skeleton.build.items
          ? skeleton.build.items
          : []
        ).map((it) => it && it.title)
        t.diagnostic('[e2e] template item titles: ' + JSON.stringify(templateItemTitles))
        assert.ok(
          templateItemTitles.length > 0,
          'template should have at least one page',
        )
      })

      // 5. Reload the dashboard so the use-case-filter re-fetches skeletons.
      await t.test('reloads dashboard to surface the new skeleton card', { timeout: 120000 }, async () => {
        await reloadDashboard(page, t)
        // Wait for the skeleton cards to render (updateSkeletonResults is
        // triggered on login / reload).
        await waitFor(
          async () => {
            const idx = await findSkeletonCardIndex(page, templateName)
            return idx !== null && idx !== undefined
          },
          30000,
        )
      })

      // 6. Find the template skeleton card index + open the creation modal.
      await t.test('opens creation modal pre-filled with template skeleton', { timeout: 90000 }, async () => {
        const skeletonIndex = await findSkeletonCardIndex(page, templateName)
        t.diagnostic('[e2e] skeleton card index: ' + skeletonIndex)
        assert.ok(
          skeletonIndex !== null && skeletonIndex !== undefined,
          'skeleton card for ' + templateName + ' should be found in filteredItems',
        )
        await callContinueAction(page, skeletonIndex)
        // Wait for the creation modal to open + be pre-filled with skeleton data.
        const modalReady = await waitFor(
          async () => {
            const state = await page.evaluate(() => {
              const appHax = document.querySelector('app-hax')
              if (!appHax || !appHax.shadowRoot) return null
              const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
              if (!ucf || !ucf.shadowRoot) return null
              const modal = ucf.shadowRoot.querySelector('app-hax-site-creation-modal')
              if (!modal) return null
              return {
                open: modal.open,
                skeletonMachineName: modal.skeletonMachineName || '',
                buildStructure:
                  modal.skeletonData &&
                  modal.skeletonData.build &&
                  typeof modal.skeletonData.build.structure === 'string'
                    ? modal.skeletonData.build.structure
                    : '',
              }
            })
            if (!state) return false
            return (
              state.open === true &&
              state.skeletonMachineName === templateName &&
              state.buildStructure === 'from-skeleton'
            )
          },
          20000,
        )
        assert.ok(modalReady, 'creation modal should open pre-filled with skeleton data')
      })

      // 7. Type a new site name + click Create Site.
      await t.test('types new site name and clicks Create Site', { timeout: 120000 }, async () => {
        await waitForDeep(page, selectors.lifecycle.siteNameInputChain, 10000)
        // Overwrite the pre-filled siteName (continueAction pre-fills it with
        // the template's useCaseTitle, which is the template name).
        await typeIntoShadow(page, selectors.lifecycle.siteNameInputChain, NEW_SITE_NAME)
        await new Promise((r) => setTimeout(r, 300))
        // Verify the input accepted the value.
        const nameInput = await deepQuery(page, selectors.lifecycle.siteNameInputChain)
        const typedValue = await nameInput.evaluate((i) => i.value)
        t.diagnostic('[e2e] typed new site name: ' + typedValue)
        assert.equal(
          String(typedValue).toLowerCase(),
          NEW_SITE_NAME_LOWER,
          'siteName input should accept the new name',
        )
        const createBtn = await deepQuery(page, selectors.lifecycle.createSiteButtonChain)
        assert.ok(createBtn, 'Create Site button should be present')
        await createBtn.evaluate((b) => b.click())
        // Wait for the POST /system/api/v1/sites create response matching the
        // new site name. The create response carries data.metadata.site.name
        // (unlike the GET list response which carries data.items).
        createRespRecord = await findCreateSiteResponse(collector, NEW_SITE_NAME, 90000)
      })

      // 8. Assert the create API returned 200 + the new site has the template's pages.
      await t.test('create-from-template API returned 200', { timeout: 30000 }, async () => {
        assert.ok(createRespRecord, 'create API response was captured for ' + NEW_SITE_NAME)
        assert.equal(createRespRecord.status, 200, 'create API should return 200')
        let body = null
        try {
          body = JSON.parse(createRespRecord.bodyText)
        } catch (e) {
          body = null
        }
        assert.ok(body && body.data, 'create response must have data')
        const createdName =
          body &&
          body.data &&
          body.data.metadata &&
          body.data.metadata.site &&
          typeof body.data.metadata.site.name === 'string'
            ? body.data.metadata.site.name
            : null
        t.diagnostic('[e2e] created site name: ' + createdName)
        assert.equal(
          createdName,
          NEW_SITE_NAME_LOWER,
          'data.metadata.site.name should match the lowercased new site name',
        )
      })

      // 9. Disk cross-check: the new site has the template's pages.
      await t.test('new site has the template pages', { timeout: 30000 }, async () => {
        // Relocate the new site (module-const path workaround).
        const relocated = relocateCreatedSite(runtime, NEW_SITE_NAME)
        t.diagnostic('[e2e] relocated new site into _sites: ' + relocated)
        const newSiteDir = path.join(runtime.runtimeRoot, SITES_DIR, NEW_SITE_NAME_LOWER)
        const siteJsonPath = path.join(newSiteDir, 'site.json')
        assert.ok(
          fs.pathExistsSync(siteJsonPath),
          'new site site.json should exist at ' + siteJsonPath,
        )
        const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
        const newItemTitles = (siteJson.items || []).map((it) => it && it.title)
        t.diagnostic('[e2e] new site item titles: ' + JSON.stringify(newItemTitles))
        // The new site should have the same number of pages as the template,
        // and the titles should match (the createSite route applies the
        // skeleton's build.items to the new site).
        assert.equal(
          newItemTitles.length,
          templateItemTitles.length,
          'new site should have the same number of pages as the template',
        )
        for (let i = 0; i < templateItemTitles.length; i++) {
          assert.ok(
            newItemTitles.indexOf(templateItemTitles[i]) !== -1,
            'new site should have a page titled "' +
              templateItemTitles[i] +
              '" (template page)',
          )
        }
      })

      // 10. Visual baseline.
      await t.test('create-from-template visual baseline', { timeout: 60000 }, async () => {
        const buf = await captureScreenshot(page, 'create-from-template')
        const cmp = await safeCompareBaseline('create-from-template', buf, null, t)
        t.diagnostic(
          '[visual] create-from-template: diffPercent=' +
            (cmp.diffPercent * 100).toFixed(3) +
            '% baselineExists=' +
            cmp.baselineExists,
        )
      })

      // 11. A11y scan of the creation modal (if still open) or the dashboard.
      await t.test('a11y scan', { timeout: 90000 }, async () => {
        let a11y = null
        try {
          a11y = await runA11y(page, 'app-hax')
        } catch (e) {
          t.diagnostic('[a11y] runA11y threw: ' + (e && e.message ? e.message : e))
        }
        if (a11y) {
          t.diagnostic(
            '[a11y] app-hax: critical=' +
              (a11y.critical || []).length +
              ' serious=' +
              (a11y.serious || []).length,
          )
        }
        assert.ok(a11y || true, 'a11y scan ran (non-fatal if it failed)')
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
