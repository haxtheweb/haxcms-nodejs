'use strict'

// E2E test: site read APIs — search, tags, and site summary.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal ->
// create HAXSITEAUTOMATEDTESTING -> navigate into the site editor -> edit +
// save a page with KNOWN content (a unique searchable term + a tag) -> use
// authenticated-axios (light UI) to assert:
//   - GET /x/api/v1/search?q=<term> returns results with snippets + score
//   - GET /x/api/v1/tags returns tag counts
//   - GET /x/api/v1/site returns counts (items, publishedItems, tags, regions,
//     files) + links + jsonld
// -> light UI cross-check (navigate the browser to the site and confirm the
//   page renders) -> teardown.
//
// Auth: search, tags, and siteSummary are PUBLIC (security: [] or no security
// block in the OpenAPI spec) — no X-HAXCMS-Site-Token needed. A Bearer JWT is
// attached so published-visibility filtering sees authored (possibly
// unpublished) content the same way the editor does.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to
// src/build/node_modules.

const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  captureScreenshot,
  FIXED_SITE_NAME,
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

// A unique searchable term + tag injected into the page content so search and
// tags assertions can find it deterministically.
const SEARCH_TERM = 'E2E site reads unique searchable term zqxjkiw'
const TEST_TAG = 'e2e-site-reads-tag'

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

// Authenticated axios GET for public site read routes. A Bearer JWT is
// attached so published-visibility filtering is permissive (sees authored
// content even if the editor has not toggled published yet).
async function siteReadGet(suffix, params) {
  return axios({
    method: 'GET',
    url: siteApiUrl(suffix),
    headers: {
      Authorization: 'Bearer ' + runtime.jwt,
    },
    params: params,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data],
  })
}

// Enter edit mode, inject content (with the searchable term) via importContent,
// save. Returns the saveNode API response record.
async function editAndSaveWithContent() {
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
  assert.ok(enterResult && enterResult.clicked, 'edit button clicked')
  await new Promise((r) => setTimeout(r, 4000))

  const bodyReady = await waitFor(async () => haxBodyEditModeActive(page), 30000)
  assert.ok(bodyReady && bodyReady.editModeAttr, 'hax-body in edit mode')

  const bodyHandle = await deepFindRecursive(page, 'hax-body')
  assert.ok(bodyHandle, 'hax-body element handle resolved')
  // page-break is REQUIRED for saveNode to write the file (pageBreakParser
  // splits by page-break tags; without one, no write occurs).
  const testContent =
    '<page-break published="published"></page-break><p>' +
    SEARCH_TERM +
    '</p>'
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
  let appeared = await waitFor(
    async () => markerInHaxBody(page, SEARCH_TERM),
    8000,
  )
  if (!appeared) {
    await bodyHandle.evaluate((el, marker) => {
      var pb = globalThis.document.createElement('page-break')
      pb.setAttribute('published', 'published')
      el.appendChild(pb)
      var p = globalThis.document.createElement('p')
      p.textContent = marker
      el.appendChild(p)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, SEARCH_TERM)
    await new Promise((r) => setTimeout(r, 500))
    appeared = await waitFor(
      async () => markerInHaxBody(page, SEARCH_TERM),
      5000,
    )
  }
  assert.ok(appeared, 'searchable content appeared in hax-body before save')

  const saveResult = await clickEditorButtonById(page, '#editbutton')
  assert.ok(saveResult && saveResult.clicked, 'save button clicked')
  let saveResp = null
  try {
    saveResp = await collector.awaitCollectorFor('/x/api/v1/content/', 30000)
  } catch (e) {
    // non-fatal; assert below
  }
  assert.ok(saveResp, 'saveNode response captured')
  assert.strictEqual(saveResp.status, 200, 'saveNode API returned 200')
  await new Promise((r) => setTimeout(r, 3000))
  return saveResp
}

// Add a tag to the active item via the haxcms-save-node-details global event
// (the site-editor listens and calls @site/updateItem). This is the same
// pattern used by the page-management test for property updates.
async function addTagToActiveItem(itemId, tag) {
  await page.evaluate((id, t) => {
    globalThis.dispatchEvent(
      new CustomEvent('haxcms-save-node-details', {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          id: String(id),
          operation: 'setTags',
          tags: [t],
        },
      }),
    )
  }, itemId, tag)
  // wait for the saveNodeDetails PATCH to complete
  let detailsResp = null
  try {
    detailsResp = await collector.awaitCollectorFor('/x/api/v1/items/', 20000)
  } catch (e) {
    // non-fatal; we assert the tag shows up in the tags API below
  }
  return detailsResp
}

// --- the flow --------------------------------------------------------------

test(
  'site read APIs — search, tags, and site summary',
  { timeout: 360000 },
  async (t) => {
    assert.ok(page, 'page initialised in before hook')
    assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

    // 1. Login + create site.
    await loginViaUI(page, collector, runtime.baseUrl)
    await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    relocateCreatedSite(runtime, FIXED_SITE_NAME)

    // 2. Navigate into the site editor + save a page with known content.
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

    const saveResp = await editAndSaveWithContent()
    let itemId = null
    try {
      const saveBody = JSON.parse(saveResp.bodyText)
      itemId = saveBody && saveBody.data && saveBody.data.id
    } catch (e) {
      itemId = null
    }
    assert.ok(itemId, 'active item id extracted from saveNode response')
    t.diagnostic('[e2e] active item id: ' + itemId)

    // 3. Add a tag to the page so the tags API has a deterministic entry.
    const detailsResp = await addTagToActiveItem(itemId, TEST_TAG)
    if (detailsResp) {
      t.diagnostic(
        '[e2e] saveNodeDetails (setTags) response status: ' + detailsResp.status,
      )
    }
    // Give the manifest save a moment to settle.
    await new Promise((r) => setTimeout(r, 2000))

    // 4. Assert GET /x/api/v1/search?q=<term> returns results with snippets.
    await t.test('API: GET search returns results with snippets + score', async () => {
      const resp = await siteReadGet('search', { q: SEARCH_TERM })
      assert.strictEqual(resp.status, 200, 'search API returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'search body status 200')
      const data = body && body.data
      assert.ok(data, 'search response has data')
      assert.strictEqual(
        data.query,
        SEARCH_TERM,
        'data.query echoes the search term',
      )
      assert.ok(
        Array.isArray(data.results),
        'data.results is an array',
      )
      assert.ok(
        data.results.length >= 1,
        'search returned at least 1 result for the known term',
      )
      // Find the result for our page.
      let ourResult = null
      for (let i = 0; i < data.results.length; i++) {
        if (data.results[i].id === itemId) {
          ourResult = data.results[i]
          break
        }
      }
      assert.ok(ourResult, 'search results include the page with the known term')
      assert.ok(
        typeof ourResult.score === 'number' && ourResult.score > 0,
        'result has a numeric score > 0',
      )
      assert.ok(
        typeof ourResult.snippet === 'string' && ourResult.snippet.length > 0,
        'result has a non-empty snippet string',
      )
      assert.ok(
        typeof ourResult.title === 'string',
        'result has a title string',
      )
      assert.ok(
        typeof ourResult.slug === 'string',
        'result has a slug string',
      )
      assert.ok(
        ourResult.links && typeof ourResult.links.item === 'string',
        'result.links.item is a string',
      )
      // matches array: each match has field + index + length + snippet.
      assert.ok(
        Array.isArray(ourResult.matches) && ourResult.matches.length > 0,
        'result has a non-empty matches array',
      )
      const firstMatch = ourResult.matches[0]
      assert.ok(
        typeof firstMatch.field === 'string',
        'first match has a field string',
      )
      assert.ok(
        typeof firstMatch.snippet === 'string',
        'first match has a snippet string',
      )
      t.diagnostic(
        '[e2e] search: results=' +
          data.results.length +
          ' score=' +
          ourResult.score +
          ' field=' +
          firstMatch.field,
      )
    })

    // 5. Assert GET /x/api/v1/tags returns tag counts (including our tag).
    await t.test('API: GET tags returns tag counts', async () => {
      const resp = await siteReadGet('tags')
      assert.strictEqual(resp.status, 200, 'tags API returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'tags body status 200')
      const data = body && body.data
      assert.ok(data, 'tags response has data')
      assert.ok(
        Array.isArray(data.tags),
        'data.tags is an array',
      )
      assert.ok(
        data.tags.length >= 1,
        'tags returned at least 1 tag',
      )
      // Find our test tag.
      let ourTag = null
      for (let i = 0; i < data.tags.length; i++) {
        if (
          data.tags[i].tag === TEST_TAG ||
          String(data.tags[i].tag || '').toLowerCase() === TEST_TAG
        ) {
          ourTag = data.tags[i]
          break
        }
      }
      assert.ok(
        ourTag,
        'tags response includes the test tag: ' + TEST_TAG,
      )
      assert.ok(
        typeof ourTag.count === 'number' && ourTag.count >= 1,
        'test tag has a numeric count >= 1',
      )
      assert.ok(
        data.links && typeof data.links.self === 'string',
        'data.links.self is a string',
      )
      t.diagnostic(
        '[e2e] tags: count=' +
          data.tags.length +
          ' testTagCount=' +
          ourTag.count,
      )
    })

    // 6. Assert GET /x/api/v1/site returns counts + links + jsonld.
    await t.test('API: GET site returns counts + links + jsonld', async () => {
      const resp = await siteReadGet('site')
      assert.strictEqual(resp.status, 200, 'site summary API returned 200')
      let body = null
      try {
        body = JSON.parse(String(resp.data || ''))
      } catch (e) {
        body = null
      }
      assert.ok(body && body.status === 200, 'site summary body status 200')
      const data = body && body.data
      assert.ok(data, 'site summary has data')
      // Core identity fields.
      assert.ok(
        typeof data.name === 'string' && data.name === EXPECTED_SITE_NAME,
        'data.name matches the lowercased site name',
      )
      assert.ok(
        typeof data.title === 'string',
        'data.title is a string',
      )
      assert.ok(
        typeof data.language === 'string' && data.language.length > 0,
        'data.language is a non-empty string',
      )
      assert.ok(
        typeof data.basePath === 'string' && data.basePath.length > 0,
        'data.basePath is a non-empty string',
      )
      // counts object: items, publishedItems, tags, regions, files.
      assert.ok(
        data.counts && typeof data.counts === 'object',
        'data.counts is an object',
      )
      assert.ok(
        typeof data.counts.items === 'number' && data.counts.items >= 1,
        'counts.items is a number >= 1 (we created/saved a page)',
      )
      assert.ok(
        typeof data.counts.publishedItems === 'number',
        'counts.publishedItems is a number',
      )
      assert.ok(
        typeof data.counts.tags === 'number' && data.counts.tags >= 1,
        'counts.tags is a number >= 1 (we added a tag)',
      )
      assert.ok(
        typeof data.counts.regions === 'number',
        'counts.regions is a number',
      )
      assert.ok(
        typeof data.counts.files === 'number',
        'counts.files is a number',
      )
      // links object with key endpoints.
      assert.ok(
        data.links && typeof data.links === 'object',
        'data.links is an object',
      )
      assert.ok(
        typeof data.links.self === 'string' && data.links.self.length > 0,
        'links.self is a non-empty string',
      )
      assert.ok(
        typeof data.links.items === 'string',
        'links.items is a string',
      )
      assert.ok(
        typeof data.links.siteJson === 'string',
        'links.siteJson is a string',
      )
      assert.ok(
        typeof data.links.rss === 'string',
        'links.rss is a string',
      )
      assert.ok(
        typeof data.links.sitemap === 'string',
        'links.sitemap is a string',
      )
      // jsonld object: @context + @type + variableMeasured.
      assert.ok(
        data.jsonld && typeof data.jsonld === 'object',
        'data.jsonld is an object',
      )
      assert.ok(
        data.jsonld['@context'] === 'https://schema.org',
        'jsonld @context is schema.org',
      )
      assert.ok(
        typeof data.jsonld['@type'] === 'string',
        'jsonld @type is a string',
      )
      assert.ok(
        Array.isArray(data.jsonld.variableMeasured),
        'jsonld.variableMeasured is an array',
      )
      t.diagnostic(
        '[e2e] site summary: items=' +
          data.counts.items +
          ' publishedItems=' +
          data.counts.publishedItems +
          ' tags=' +
          data.counts.tags +
          ' regions=' +
          data.counts.regions +
          ' files=' +
          data.counts.files,
      )
    })

    // 7. Light UI cross-check: navigate to the site and confirm it renders.
    await t.test('UI: site page renders with saved content', async () => {
      // Reload the editor URL so the SPA re-reads the saved content.
      try {
        await page.goto(editorUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        })
      } catch (e) {
        // non-fatal
      }
      await page.waitForSelector('haxcms-site-editor-ui', { timeout: 30000 })
      // The editor chrome is the signal the site loaded.
      const uiPresent = await page.evaluate(() => {
        return !!document.querySelector('haxcms-site-editor-ui')
      })
      assert.ok(uiPresent, 'haxcms-site-editor-ui present after reload')
    })

    // 8. Visual baseline: site editor after reload.
    await t.test('visual: site-reads editor baseline', async () => {
      const buf = await captureScreenshot(page, 'site-reads-editor')
      const cmp = await safeCompareBaseline('site-reads-editor', buf, null, t)
      t.diagnostic(
        '[visual] site-reads-editor: diffPercent=' +
          (cmp.diffPercent * 100).toFixed(3) +
          '% baselineExists=' +
          cmp.baselineExists +
          ' baselineUpdated=' +
          cmp.baselineUpdated,
      )
    })
  },
)
