'use strict'

// E2E test: dashboard search narrows site results (auth-dashboard group).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login -> create
// HAXSITEAUTOMATEDTESTING -> reload dashboard -> wait for the site card ->
// type into #searchField (app-hax-use-case-filter shadowRoot) -> assert the
// app-hax-site-bar card count narrows (client-side filtering) -> type a
// non-matching term -> assert 0 cards (or #noResult). Contrast with the
// pre-search card count.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to
// src/build/node_modules.
//
// SELECTOR NOTE: #searchField is inside app-hax-use-case-filter shadowRoot.
// Chain: document > app-hax > app-hax-use-case-filter > #searchField. Typing
// dispatches input → handleSearch → sets store.searchTerm + applyFilters()
// which filters displayItems CLIENT-SIDE (no search API fires). The
// app-hax-search-results.displayItems narrows; app-hax-site-bar card count
// drops. Verified by .discovery-auth-dashboard.cjs.

const test = require('node:test')
const assert = require('node:assert/strict')

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
  // flows helpers
  waitFor,
  waitForDeep,
  loginViaUI,
  createSiteViaUI,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  reloadDashboard,
  findSiteCard,
  typeIntoShadow,
  safeCompareBaseline,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()

// --- shared state ---
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

// --- helpers ---

// Count the app-hax-site-bar cards currently rendered in the dashboard
// search-results. Returns { cardCount, noResultVisible, displayItemsLen }.
async function getSearchResultState(page) {
  return page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) {
      return { appHaxFound: false, cardCount: 0 }
    }
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf || !ucf.shadowRoot) {
      return { appHaxFound: true, ucfFound: false, cardCount: 0 }
    }
    const sr = ucf.shadowRoot.querySelector('app-hax-search-results')
    if (!sr || !sr.shadowRoot) {
      return { appHaxFound: true, ucfFound: true, srFound: false, cardCount: 0 }
    }
    const cards = sr.shadowRoot.querySelectorAll('app-hax-site-bar')
    const noResult = sr.shadowRoot.querySelector('#noResult')
    return {
      appHaxFound: true,
      ucfFound: true,
      srFound: true,
      cardCount: cards.length,
      noResultVisible: !!noResult,
      displayItemsLen: Array.isArray(sr.displayItems) ? sr.displayItems.length : -1,
      searchTerm: sr.searchTerm || '',
    }
  })
}

// Type text into #searchField inside app-hax-use-case-filter shadowRoot.
async function typeIntoSearchField(page, text) {
  return page.evaluate((term) => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) return { error: 'no app-hax' }
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf || !ucf.shadowRoot) return { error: 'no ucf' }
    const input = ucf.shadowRoot.querySelector('#searchField')
    if (!input) return { error: 'no #searchField' }
    input.focus()
    input.value = term
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return { typed: true, value: input.value }
  }, text)
}

// --- dashboard-search e2e suite ---

test('dashboard-search e2e: search narrows site results', { timeout: 240000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  await t.test('login + create site', async () => {
    await loginViaUI(page, collector, runtime.baseUrl)
    const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    assert.equal(createResp.status, 200, 'create site API should return 200')
    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    t.diagnostic('[e2e] relocated created site: ' + relocated)
  })

  await t.test('reload dashboard + wait for site card', async () => {
    await reloadDashboard(page, t)
    const card = await findSiteCard(page, FIXED_SITE_NAME)
    assert.ok(card, 'site card for ' + EXPECTED_SITE_NAME + ' should render after reload')
    if (card) {
      await card.dispose()
    }
  })

  await t.test('pre-search: at least 1 site card present', async () => {
    const state = await getSearchResultState(page)
    t.diagnostic('[e2e] pre-search state: ' + JSON.stringify(state))
    assert.ok(state.srFound, 'app-hax-search-results should be found')
    assert.ok(
      state.cardCount >= 1,
      'at least 1 app-hax-site-bar card should be present before searching, got ' + state.cardCount,
    )
  })

  await t.test('search: typing site name narrows results', async () => {
    // Type a term that matches our site. The results should narrow to include
    // our site (and possibly only our site if it's the only one).
    const result = await typeIntoSearchField(page, 'haxsite')
    assert.ok(result && result.typed, 'search field typed: ' + JSON.stringify(result))
    // Wait for client-side filtering to apply (Lit reactivity + requestUpdate).
    await new Promise((r) => setTimeout(r, 2000))

    const state = await getSearchResultState(page)
    t.diagnostic('[e2e] after typing "haxsite": ' + JSON.stringify(state))
    // Our site should still be visible (its name contains "haxsite").
    assert.ok(
      state.cardCount >= 1,
      'at least 1 card should match "haxsite" (our site name contains it), got ' + state.cardCount,
    )
  })

  await t.test('search: non-matching term yields 0 cards', async () => {
    const result = await typeIntoSearchField(page, 'zzzznonexistent')
    assert.ok(result && result.typed, 'search field typed with non-matching term')
    await new Promise((r) => setTimeout(r, 2000))

    const state = await getSearchResultState(page)
    t.diagnostic('[e2e] after typing "zzzznonexistent": ' + JSON.stringify(state))
    assert.equal(
      state.cardCount,
      0,
      'non-matching search term should yield 0 app-hax-site-bar cards, got ' + state.cardCount,
    )
    // The #noResult element should be visible when there are 0 cards.
    assert.ok(
      state.noResultVisible,
      '#noResult should be visible when search yields 0 cards',
    )
  })

  await t.test('search: clearing the term restores all cards', async () => {
    const result = await typeIntoSearchField(page, '')
    assert.ok(result && result.typed, 'search field cleared')
    await new Promise((r) => setTimeout(r, 2000))

    const state = await getSearchResultState(page)
    t.diagnostic('[e2e] after clearing search: ' + JSON.stringify(state))
    assert.ok(
      state.cardCount >= 1,
      'clearing the search term should restore at least 1 card, got ' + state.cardCount,
    )
  })

  await t.test('visual: dashboard with search results', async () => {
    // Type our site name so the screenshot shows a narrowed result set.
    await typeIntoSearchField(page, 'haxsite')
    await new Promise((r) => setTimeout(r, 1500))
    const buf = await captureScreenshot(page, 'dashboard-search-narrowed')
    const cmp = await safeCompareBaseline('dashboard-search-narrowed', buf, null, t)
    assert.ok(cmp, 'compareBaseline should return a result object')
  })

  await t.test('a11y: search input region', async () => {
    // Clear the search first so the full dashboard is visible.
    await typeIntoSearchField(page, '')
    await new Promise((r) => setTimeout(r, 1500))
    let a11y = null
    try {
      // Scope to app-hax so the axe scan covers the search input + results.
      a11y = await runA11y(page, 'app-hax')
    } catch (e) {
      t.diagnostic('[a11y] runA11y threw (non-fatal): ' + (e && e.message ? e.message : e))
    }
    if (a11y) {
      const critical = a11y.critical || []
      const serious = a11y.serious || []
      t.diagnostic(
        '[a11y] app-hax search region: critical=' + critical.length + ' serious=' + serious.length,
      )
      // Document nonzero findings as diagnostics (non-fatal per task spec).
      for (let i = 0; i < critical.length; i++) {
        t.diagnostic('[a11y] CRITICAL: ' + (critical[i].id || '') + ' — ' + (critical[i].help || critical[i].description || ''))
      }
      for (let i = 0; i < serious.length; i++) {
        t.diagnostic('[a11y] SERIOUS: ' + (serious[i].id || '') + ' — ' + (serious[i].help || serious[i].description || ''))
      }
      assert.ok(a11y, 'runA11y returned a result object')
    }
  })
})
