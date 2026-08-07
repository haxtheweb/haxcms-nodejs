'use strict'

// E2E test: site navigation — dashboard→editor entry + page nav links
// (auth-dashboard group).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login -> create
// HAXSITEAUTOMATEDTESTING -> reload dashboard -> click the site card's
// a.imageLink (the REAL dashboard→editor entry point, not URL navigation) ->
// assert haxcms-site-editor-ui renders -> use axios (Bearer JWT) to GET
// /_sites/<name>/x/api/v1/items -> assert the response includes navigation
// links (previous/next/parent/children) -> follow a child link (or the self
// link) to confirm the items API returns individual page data.
//
// This is the first test to exercise the real dashboard→editor entry point
// (existing edit-content.e2e.test.cjs navigates by URL). The page-navigation
// assertions use axios with the Bearer JWT from the harness (runtime.jwt) to
// hit the site API directly, confirming the /x/api/v1/items response shape
// includes the prev/next/parent/children links built by buildItemNavigationMap.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to
// src/build/node_modules.
//
// SELECTOR NOTE: the site card click target is a.imageLink inside
// app-hax-site-bar shadowRoot (href="/_sites/<slug>/", aria-label="Open <title>").
// Clicking it navigates to the site editor. Verified by
// .discovery-auth-dashboard.cjs.

const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')

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
  loginViaUI,
  createSiteViaUI,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  reloadDashboard,
  findSiteCard,
  safeCompareBaseline,
} = require('./helpers')

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()
const SITES_SEGMENT = '_sites'

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

// Click the site card's a.imageLink to navigate into the site editor.
// This is the real dashboard→editor entry point. Returns the href navigated to.
async function clickSiteCardToOpenEditor(page, siteName) {
  const target = String(siteName).toLowerCase()
  // Find the card (reuse findSiteCard from flows, but we need the handle to
  // click the image link inside its shadowRoot).
  const cardHandle = await findSiteCard(page, siteName)
  if (!cardHandle) {
    return { error: 'card not found' }
  }
  const href = await cardHandle.evaluate((el) => {
    const link = el.shadowRoot && el.shadowRoot.querySelector('a.imageLink')
    if (!link) {
      return { error: 'no a.imageLink', siteUrl: el.siteUrl || '' }
    }
    // Navigate by clicking the link (a real <a> with href).
    link.click()
    return { href: link.href, clicked: true }
  })
  await cardHandle.dispose()
  return href
}

// Direct axios GET to the site items API with the Bearer JWT.
// The multisite path is /_sites/<name>/x/api/v1/items.
async function getSiteItems(runtime, siteName) {
  const url = runtime.baseUrl + '/' + SITES_SEGMENT + '/' + siteName + '/x/api/v1/items'
  const headers = {
    Authorization: 'Bearer ' + runtime.jwt,
    Accept: 'application/json',
  }
  // The site items list endpoint may require the user-token header for some
  // deployments; include it if the harness detected one.
  if (runtime.userToken && runtime.userTokenHeader) {
    headers[runtime.userTokenHeader] = runtime.userToken
  }
  const response = await axios({
    method: 'GET',
    url: url,
    headers: headers,
    validateStatus: () => true,
    timeout: 15000,
  })
  return {
    status: response.status,
    url: url,
    data: response.data,
  }
}

// Direct axios GET to a single site item by idOrSlug (following a nav link).
async function getSiteItem(runtime, siteName, idOrSlug) {
  const url = runtime.baseUrl + '/' + SITES_SEGMENT + '/' + siteName + '/x/api/v1/items/' + encodeURIComponent(idOrSlug)
  const headers = {
    Authorization: 'Bearer ' + runtime.jwt,
    Accept: 'application/json',
  }
  if (runtime.userToken && runtime.userTokenHeader) {
    headers[runtime.userTokenHeader] = runtime.userToken
  }
  const response = await axios({
    method: 'GET',
    url: url,
    headers: headers,
    validateStatus: () => true,
    timeout: 15000,
  })
  return {
    status: response.status,
    url: url,
    data: response.data,
  }
}

// --- site-navigation e2e suite ---

test('site-navigation e2e: dashboard→editor + page nav links', { timeout: 240000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  await t.test('login + create site', async () => {
    await loginViaUI(page, collector, runtime.baseUrl)
    const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    assert.equal(createResp.status, 200, 'create site API should return 200')
    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    t.diagnostic('[e2e] relocated created site: ' + relocated)
  })

  await t.test('reload dashboard + find site card', async () => {
    await reloadDashboard(page, t)
    const card = await findSiteCard(page, FIXED_SITE_NAME)
    assert.ok(card, 'site card should render after reload')
    if (card) {
      await card.dispose()
    }
  })

  await t.test('click site card opens the editor (haxcms-site-editor-ui)', async () => {
    // Click the a.imageLink inside the site card — the real entry point.
    const result = await clickSiteCardToOpenEditor(page, FIXED_SITE_NAME)
    t.diagnostic('[e2e] site card click result: ' + JSON.stringify(result))
    assert.ok(result && result.clicked, 'site card a.imageLink clicked: ' + JSON.stringify(result))
    assert.ok(
      result.href && result.href.indexOf('/' + SITES_SEGMENT + '/' + EXPECTED_SITE_NAME) !== -1,
      'image link href should point to /_sites/' + EXPECTED_SITE_NAME + '/, got ' + (result.href || ''),
    )

    // Wait for navigation + the editor chrome to render.
    await page.waitForSelector('haxcms-site-editor-ui', { timeout: 45000 })
    // Give the editor a moment to settle (wire up content, theme, etc).
    await new Promise((r) => setTimeout(r, 4000))

    const editorReady = await page.evaluate(() => {
      const ui = document.querySelector('haxcms-site-editor-ui')
      if (!ui || !ui.shadowRoot) {
        return { found: false }
      }
      const editBtn = ui.shadowRoot.querySelector('#editbutton')
      return {
        found: true,
        editButtonFound: !!editBtn,
        editButtonLabel: editBtn ? (editBtn.getAttribute('label') || editBtn.label || '') : '',
      }
    })
    t.diagnostic('[e2e] editor ready: ' + JSON.stringify(editorReady))
    assert.ok(editorReady.found, 'haxcms-site-editor-ui should render after card click')
    assert.ok(editorReady.editButtonFound, 'editor #editbutton should be present')
  })

  await t.test('api: GET /_sites/<name>/x/api/v1/items returns 200 + nav links', async () => {
    const result = await getSiteItems(runtime, EXPECTED_SITE_NAME)
    t.diagnostic('[e2e] items API status=' + result.status + ' url=' + result.url)
    assert.equal(result.status, 200, 'site items API should return 200')

    const body = result.data
    assert.ok(body, 'items API response body should be present')
    // The list response shape: { status, count, total, page, items, links }
    assert.ok(
      body && (body.items || (body.data && body.data.items)),
      'items API response should contain an items array',
    )
    const items = body.items || (body.data && body.data.items) || []
    assert.ok(
      items.length >= 1,
      'a newly created site should have at least 1 item (the home page), got ' + items.length,
    )

    // The first item should have navigation links (prev/next/parent/children)
    // built by buildItemNavigationMap. For a single-page site, prev/next/parent
    // may be null but children should be a URL string.
    const firstItem = items[0]
    assert.ok(firstItem, 'first item should be present')
    assert.ok(
      firstItem.id || firstItem.slug,
      'first item should have an id or slug',
    )

    // Check the links object (navigation links are attached per-item).
    const links = firstItem.links || {}
    t.diagnostic('[e2e] first item links: ' + JSON.stringify(links))
    // The children link is always present (buildItemNavigationMap always sets it).
    assert.ok(
      links.children && typeof links.children === 'string',
      'first item should have a links.children URL string, got ' + JSON.stringify(links.children),
    )
    // The self link should also be present.
    assert.ok(
      links.self && typeof links.self === 'string',
      'first item should have a links.self URL string',
    )
  })

  await t.test('api: follow a child link (filter.parent) returns items', async () => {
    // First, get the items list to find a parent id.
    const listResult = await getSiteItems(runtime, EXPECTED_SITE_NAME)
    assert.equal(listResult.status, 200, 'items list API should return 200')
    const items = listResult.data.items || (listResult.data.data && listResult.data.data.items) || []
    assert.ok(items.length >= 1, 'items list should have at least 1 item')
    const firstItem = items[0]
    const itemId = firstItem.id || firstItem.slug
    assert.ok(itemId, 'first item should have an id or slug for the children query')

    // Follow the children link: /x/api/v1/items?filter.parent=<id>
    // This confirms the navigation link is usable.
    const childrenUrl = firstItem.links && firstItem.links.children
    assert.ok(childrenUrl, 'children link should be present on the first item')

    // The children link is a FULL path starting with /_sites/<name>/x/api/...
    // (the API base path is resolved from the request path which includes the
    // multisite segment). So we only need to prepend the baseUrl (host), NOT
    // the multisite prefix again.
    let fullChildrenUrl = childrenUrl
    if (childrenUrl.indexOf('http') !== 0) {
      fullChildrenUrl = runtime.baseUrl + childrenUrl
    }
    t.diagnostic('[e2e] following children link: ' + fullChildrenUrl)

    const headers = {
      Authorization: 'Bearer ' + runtime.jwt,
      Accept: 'application/json',
    }
    if (runtime.userToken && runtime.userTokenHeader) {
      headers[runtime.userTokenHeader] = runtime.userToken
    }
    const childrenResp = await axios({
      method: 'GET',
      url: fullChildrenUrl,
      headers: headers,
      validateStatus: () => true,
      timeout: 15000,
    })
    assert.equal(
      childrenResp.status,
      200,
      'following the children link should return 200, got ' + childrenResp.status,
    )
    const childrenBody = childrenResp.data
    const childItems = childrenBody.items || (childrenBody.data && childrenBody.data.items) || []
    // A freshly-created single-page site has no children, so this may be an
    // empty array — but the API should still return 200 with a valid shape.
    assert.ok(
      Array.isArray(childItems),
      'children link response should contain an items array (possibly empty for a new site)',
    )
    t.diagnostic('[e2e] children query returned ' + childItems.length + ' child items')
  })

  await t.test('api: GET single item by id returns 200 + detail', async () => {
    // Get the items list to find an id, then fetch that item by id.
    const listResult = await getSiteItems(runtime, EXPECTED_SITE_NAME)
    const items = listResult.data.items || (listResult.data.data && listResult.data.data.items) || []
    assert.ok(items.length >= 1, 'items list should have at least 1 item')
    const firstItem = items[0]
    const itemId = firstItem.id || firstItem.slug
    assert.ok(itemId, 'first item should have an id or slug')

    const detailResult = await getSiteItem(runtime, EXPECTED_SITE_NAME, itemId)
    t.diagnostic('[e2e] item detail API status=' + detailResult.status + ' url=' + detailResult.url)
    assert.equal(
      detailResult.status,
      200,
      'single item API should return 200 for id=' + itemId,
    )
    const detailBody = detailResult.data
    // The detail response shape: { status, data: { id, slug, title, links, ... } }
    const detailData = detailBody.data || detailBody
    assert.ok(
      detailData && (detailData.id || detailData.slug),
      'item detail response should contain the item id/slug',
    )
    // The detail response should also have navigation links.
    const detailLinks = detailData.links || {}
    assert.ok(
      detailLinks.children && typeof detailLinks.children === 'string',
      'item detail should have a links.children URL string',
    )
  })

  await t.test('visual: site editor opened via card click', async () => {
    const buf = await captureScreenshot(page, 'site-navigation-editor')
    const cmp = await safeCompareBaseline('site-navigation-editor', buf, null, t)
    assert.ok(cmp, 'compareBaseline should return a result object')
  })

  await t.test('a11y: site editor chrome', async () => {
    let a11y = null
    try {
      a11y = await runA11y(page, 'haxcms-site-editor-ui')
    } catch (e) {
      t.diagnostic('[a11y] runA11y threw (non-fatal): ' + (e && e.message ? e.message : e))
    }
    if (a11y) {
      const critical = a11y.critical || []
      const serious = a11y.serious || []
      t.diagnostic(
        '[a11y] site-editor-ui: critical=' + critical.length + ' serious=' + serious.length,
      )
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
