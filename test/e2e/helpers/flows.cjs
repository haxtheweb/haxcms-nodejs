'use strict'

// Consolidated E2E flow helpers — the single source of truth for the
// high-level UI flows that every e2e test file used to inline per-file.
//
// Why this exists: the 7 original test files each duplicated ~150 lines of
// login / create-site / dashboard / hax-body / HAXCMS_ROOT-workaround helpers.
// New test files (the top-50-operations expansion) import from here instead of
// re-inlining, and the existing 7 files were refactored to import from here too
// so there is one copy to maintain.
//
// Conventions (match the original files exactly): CommonJS, globalThis (not
// window), NO optional chaining (explicit && guards everywhere), single quotes,
// minimal semicolons, functional style. visual.cjs already handles the
// pixelmatch v7 ESM interop on its own line 14
// (`require('pixelmatch').default || require('pixelmatch')`), so the per-test
// pixelmatch shim blocks that used to live in each file are no longer needed.
//
// SELECTOR NOTE: <app-hax-site-login> is a LIGHT-DOM (slotted) child of
// <simple-modal>, NOT inside simple-modal's shadowRoot. deepQuery (which pierces
// shadow roots at every step) cannot reach a light-DOM child, so the login
// helpers below query document.querySelector('simple-modal') then the slotted
// app-hax-site-login directly, and operate on app-hax-site-login's OWN
// shadowRoot for inputs/buttons. This matches the verified discovery pass.

const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')

const {
  selectors,
  FIXED_SITE_NAME,
  deepQuery,
  deepQueryAll,
} = require('./selectors.cjs')
const {
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
} = require('./harness.cjs')
const { compareBaseline } = require('./visual.cjs')

const SITES_DIR = '_sites'

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

function findCookie(cookies, name) {
  if (!Array.isArray(cookies)) {
    return null
  }
  for (let i = 0; i < cookies.length; i++) {
    if (cookies[i] && cookies[i].name === name) {
      return cookies[i]
    }
  }
  return null
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(String(value || ''))
  } catch (e) {
    return null
  }
}

function summariseViolations(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '(none)'
  }
  return list
    .map((v) => {
      const id = (v && v.id) || 'unknown'
      const desc = (v && v.description) || ''
      return id + ': ' + desc
    })
    .join(' | ')
}

// Poll page.cookies() until a cookie named `name` appears (or timeout).
async function awaitCookie(page, name, timeoutMs) {
  const timeout = timeoutMs || 10000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const cookies = await page.cookies()
    for (let i = 0; i < cookies.length; i++) {
      if (cookies[i] && cookies[i].name === name) {
        return cookies[i]
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

// Poll collected responses for one matching urlSubstring with the expected
// status. Needed because the SPA fires a pre-login GET /sites (401) that would
// otherwise satisfy a plain awaitCollectorFor; we specifically want the
// authenticated 200.
async function awaitResponseStatus(collector, urlSubstring, status, timeoutMs) {
  const timeout = timeoutMs || 30000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const matches = collector.getResponsesFor(urlSubstring)
    for (let i = 0; i < matches.length; i++) {
      if (matches[i] && matches[i].status === status) {
        return matches[i]
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

// ---------------------------------------------------------------------------
// polling + shadow-DOM utilities
// ---------------------------------------------------------------------------

// Poll an async predicate until it returns a truthy value or timeout.
async function waitFor(fn, timeoutMs, intervalMs) {
  const interval = intervalMs || 250
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    last = await fn()
    if (last) {
      return last
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return last
}

// Poll a deepQuery chain until the element exists.
async function waitForDeep(page, chain, timeoutMs) {
  return waitFor(async () => deepQuery(page, chain), timeoutMs)
}

// Set a shadow-DOM input reached by a full chain (Lit two-way binding needs the
// input event, not just .value). Focuses first, sets .value, dispatches
// input+change. Proven reliable for Lit-bound inputs in this app.
async function typeIntoShadow(page, chain, text) {
  const el = await deepQuery(page, chain)
  if (!el) {
    throw new Error('input not found: ' + chain.join('>'))
  }
  await el.evaluate((input, value) => {
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, text)
}

// Alias kept for tests that referred to it as setShadowInput (same behaviour).
async function setShadowInput(page, chain, text) {
  return typeIntoShadow(page, chain, text)
}

// Click the first button whose visible text contains `buttonText`, searching
// the shadowRoot of the host reached by `hostChain`.
async function clickShadowButton(page, hostChain, buttonText) {
  const host = await deepQuery(page, hostChain)
  if (!host) {
    throw new Error('host not found: ' + hostChain.join('>'))
  }
  const clicked = await host.evaluate((el, text) => {
    const btns = el.shadowRoot ? el.shadowRoot.querySelectorAll('button') : []
    for (let i = 0; i < btns.length; i++) {
      if (
        btns[i].textContent.trim().toLowerCase().indexOf(text.toLowerCase()) !== -1
      ) {
        btns[i].click()
        return true
      }
    }
    return false
  }, buttonText)
  if (!clicked) {
    throw new Error('button text not found: ' + buttonText)
  }
}

// ---------------------------------------------------------------------------
// recursive shadow-DOM walk (haxcms-site-editor lives at variable depth)
// ---------------------------------------------------------------------------

// haxcms-site-editor renders inside the active theme at a VARIABLE shadow-DOM
// depth, so deepQuery (fixed chain) cannot reach hax-body. This recursively
// walks all shadow roots to find an element by selector.
async function deepFindRecursive(page, selector) {
  const handle = await page.evaluateHandle((sel) => {
    function walk(root) {
      if (!root) {
        return null
      }
      var found = root.querySelector(sel)
      if (found) {
        return found
      }
      var els = root.querySelectorAll('*')
      for (var i = 0; i < els.length; i++) {
        if (els[i].shadowRoot) {
          var r = walk(els[i].shadowRoot)
          if (r) {
            return r
          }
        }
      }
      return null
    }
    return walk(document)
  }, selector)
  const el = handle.asElement()
  if (!el) {
    await handle.dispose()
    return null
  }
  return el
}

// Shared recursive walk source string for hax-body (inlined into evaluate
// calls that need to find hax-body from within the page context).
const WALK_HAX_BODY_FN = `
function walk(root) {
  if (!root) return null
  var found = root.querySelector('hax-body')
  if (found) return found
  var els = root.querySelectorAll('*')
  for (var i = 0; i < els.length; i++) {
    if (els[i].shadowRoot) {
      var r = walk(els[i].shadowRoot)
      if (r) return r
    }
  }
  return null
}
`

// Check if hax-body is in edit mode (edit-mode attribute present). The reliable
// readiness signal — hax-body itself does NOT always get contenteditable;
// _editModeChanged applies contenteditable to the slotted CHILDREN.
async function haxBodyEditModeActive(page) {
  return page.evaluate((walkSrc) => {
    // eslint-disable-next-line no-eval
    eval(walkSrc)
    var body = walk(document)
    if (!body) {
      return { found: false }
    }
    return {
      found: true,
      editModeAttr: body.hasAttribute('edit-mode'),
      childCount: body.children ? body.children.length : -1,
    }
  }, WALK_HAX_BODY_FN)
}

// Check if a marker string appears in hax-body's slotted content.
async function markerInHaxBody(page, marker) {
  return page.evaluate((walkSrc, m) => {
    // eslint-disable-next-line no-eval
    eval(walkSrc)
    var body = walk(document)
    if (!body || !body.shadowRoot) {
      return false
    }
    var slot = body.shadowRoot.querySelector('#body')
    if (!slot) {
      return false
    }
    var nodes = slot.assignedNodes({ flatten: true })
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] && nodes[i].textContent && nodes[i].textContent.indexOf(m) !== -1) {
        return true
      }
    }
    return false
  }, WALK_HAX_BODY_FN, marker)
}

// Click a button inside the haxcms-site-editor-ui shadowRoot by id. The
// simple-toolbar-button hosts wrap an inner <button>; click the inner button
// if present, else click the host. Returns { clicked: true } or { error: ... }.
async function clickEditorButtonById(page, id) {
  return page.evaluate((btnId) => {
    const ui = document.querySelector('haxcms-site-editor-ui')
    if (!ui || !ui.shadowRoot) {
      return { error: 'no ui' }
    }
    const btn = ui.shadowRoot.querySelector(btnId)
    if (!btn) {
      return { error: 'no ' + btnId }
    }
    var inner = btn.shadowRoot && btn.shadowRoot.querySelector('button')
    if (inner) {
      inner.click()
    } else {
      btn.click()
    }
    return { clicked: true }
  }, id)
}

// ---------------------------------------------------------------------------
// login helpers (light-DOM aware)
// ---------------------------------------------------------------------------

// Resolve the app-hax-site-login element: document > simple-modal (light) >
// app-hax-site-login (light slotted child). Returns an element handle or null.
async function getLoginElement(page) {
  const handle = await page.evaluateHandle(() => {
    const modal = document.querySelector('simple-modal')
    if (!modal) {
      return null
    }
    return modal.querySelector('app-hax-site-login')
  })
  const el = handle.asElement()
  if (!el) {
    await handle.dispose()
    return null
  }
  return el
}

// Wait for the login modal to render: simple-modal present, opened, and its
// slotted app-hax-site-login child has a shadowRoot. Returns the login handle.
async function waitForLoginModal(page, timeoutMs) {
  const timeout = timeoutMs || 30000
  await page.waitForFunction(
    () => {
      const modal = document.querySelector('simple-modal')
      if (!modal || modal.opened !== true) {
        return false
      }
      const loginEl = modal.querySelector('app-hax-site-login')
      return !!(loginEl && loginEl.shadowRoot)
    },
    { timeout },
  )
  return getLoginElement(page)
}

// Wait for the password input to appear inside app-hax-site-login shadowRoot
// (only present after clicking "Next").
async function waitForPasswordInput(page, timeoutMs) {
  const timeout = timeoutMs || 15000
  await page.waitForFunction(
    () => {
      const modal = document.querySelector('simple-modal')
      if (!modal) {
        return false
      }
      const loginEl = modal.querySelector('app-hax-site-login')
      if (!loginEl || !loginEl.shadowRoot) {
        return false
      }
      return !!loginEl.shadowRoot.querySelector('#password')
    },
    { timeout },
  )
}

// Reload-robust variant of waitForLoginModal. A failed login may trigger a
// full page reload which destroys the execution context mid-poll. Retry in
// short windows until the deadline. Returns the login handle or null.
async function waitForLoginModalRetry(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000)
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      break
    }
    try {
      const el = await waitForLoginModal(page, Math.min(5000, remaining))
      if (el) {
        return el
      }
    } catch (e) {
      // Context likely destroyed by an in-flight reload; back off and retry.
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  return null
}

// Wait for a login input (#username / #password) to exist in the login
// element's shadowRoot, then set its value and dispatch input/change.
async function loginSetInput(page, inputId, text) {
  await page.waitForFunction(
    (id) => {
      const modal = document.querySelector('simple-modal')
      const login = modal && modal.querySelector('app-hax-site-login')
      return !!(login && login.shadowRoot && login.shadowRoot.querySelector('#' + id))
    },
    { timeout: 15000 },
    inputId,
  )
  const set = await page.evaluate((id, val) => {
    const modal = document.querySelector('simple-modal')
    const login = modal && modal.querySelector('app-hax-site-login')
    const input = login && login.shadowRoot && login.shadowRoot.querySelector('#' + id)
    if (!input) {
      return false
    }
    input.value = val
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, inputId, text)
  if (!set) {
    throw new Error('login input not found: #' + inputId)
  }
}

// Click the first button whose visible text contains `text`, searching the
// login element's shadowRoot. Waits for the button to appear first.
async function loginClickButton(page, text) {
  await page.waitForFunction(
    (t) => {
      const modal = document.querySelector('simple-modal')
      const login = modal && modal.querySelector('app-hax-site-login')
      if (!login || !login.shadowRoot) {
        return false
      }
      const btns = login.shadowRoot.querySelectorAll('button')
      for (let i = 0; i < btns.length; i++) {
        if (btns[i].textContent.trim().toLowerCase().indexOf(t.toLowerCase()) !== -1) {
          return true
        }
      }
      return false
    },
    { timeout: 10000 },
    text,
  )
  const clicked = await page.evaluate((t) => {
    const modal = document.querySelector('simple-modal')
    const login = modal && modal.querySelector('app-hax-site-login')
    if (!login || !login.shadowRoot) {
      return false
    }
    const btns = login.shadowRoot.querySelectorAll('button')
    for (let i = 0; i < btns.length; i++) {
      if (btns[i].textContent.trim().toLowerCase().indexOf(t.toLowerCase()) !== -1) {
        btns[i].click()
        return true
      }
    }
    return false
  }, text)
  if (!clicked) {
    throw new Error('login button not found: ' + text)
  }
}

// Drive the two-step login form inside a single page.evaluate (proven by the
// discovery pass). Assumes the login modal + #username are already rendered.
async function performLoginEvaluate(page, username, password) {
  const uname = username || E2E_USER_NAME
  const pw = password || E2E_USER_PASSWORD
  const loginResult = await page.evaluate(async (u, p) => {
    const modal = document.querySelector('simple-modal')
    if (!modal) {
      return { error: 'no modal' }
    }
    const loginEl = modal.querySelector('app-hax-site-login')
    if (!loginEl || !loginEl.shadowRoot) {
      return { error: 'no login el' }
    }
    const usernameInput = loginEl.shadowRoot.querySelector('#username')
    if (!usernameInput) {
      return { error: 'no username input' }
    }
    usernameInput.value = u
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 100))

    const btns = Array.prototype.slice.call(loginEl.shadowRoot.querySelectorAll('button'))
    const nextBtn = btns.find((b) => b.textContent.indexOf('Next') !== -1)
    if (!nextBtn) {
      return { error: 'no Next button', buttons: btns.map((b) => b.textContent.trim()) }
    }
    nextBtn.click()
    await new Promise((r) => setTimeout(r, 500))

    const passwordInput = loginEl.shadowRoot.querySelector('#password')
    if (!passwordInput) {
      return { error: 'no password input after Next' }
    }
    passwordInput.value = p
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 100))

    const loginBtn = Array.prototype.slice
      .call(loginEl.shadowRoot.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Login') !== -1)
    if (!loginBtn) {
      return { error: 'no Login button' }
    }
    loginBtn.click()
    return { clicked: true }
  }, uname, pw)

  if (!loginResult || loginResult.clicked !== true) {
    throw new Error('UI login form could not be completed: ' + JSON.stringify(loginResult))
  }
}

// Full two-step UI login: navigate to baseUrl, wait for the modal, perform the
// login, then assert the session/login API returned 200 with a jwt. Returns
// the login API response record captured by the collector.
async function loginViaUI(page, collector, baseUrl) {
  await page.goto(baseUrl, {
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

  await performLoginEvaluate(page, E2E_USER_NAME, E2E_USER_PASSWORD)

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

// Two-step UI login using the per-input helpers (waits for each field). Used
// when a test needs to drive the form field-by-field rather than in one
// evaluate (e.g. to assert intermediate UI state between steps).
async function loginViaUIStepwise(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('app-hax', { timeout: 30000 })
  await page.waitForSelector('simple-modal', { timeout: 25000 })
  await new Promise((r) => setTimeout(r, 1500))
  await loginSetInput(page, 'username', E2E_USER_NAME)
  await new Promise((r) => setTimeout(r, 200))
  await loginClickButton(page, 'Next')
  await waitForPasswordInput(page, 15000)
  await loginSetInput(page, 'password', E2E_USER_PASSWORD)
  await new Promise((r) => setTimeout(r, 200))
  await loginClickButton(page, 'Login')
}

// ---------------------------------------------------------------------------
// create-site helpers
// ---------------------------------------------------------------------------

// Find the POST /system/api/v1/sites (create) response among ALL /sites
// responses. The dashboard fires GET /sites on load (data.items), so we
// disambiguate by body shape: the create response carries
// data.metadata.site.name; the list response carries data.items. Polls until
// found or timeout. Returns the matching record or null.
async function findCreateSiteResponse(coll, expectedName, timeoutMs) {
  const target = String(expectedName).toLowerCase()
  return waitFor(async () => {
    const all = coll.getResponsesFor('/system/api/v1/sites')
    for (let i = 0; i < all.length; i++) {
      let parsed = null
      try {
        parsed = JSON.parse(all[i].bodyText)
      } catch (e) {
        continue
      }
      const metaSite =
        parsed && parsed.data && parsed.data.metadata && parsed.data.metadata.site
          ? parsed.data.metadata.site
          : null
      if (
        parsed &&
        parsed.status === 200 &&
        metaSite &&
        typeof metaSite.name === 'string' &&
        metaSite.name.toLowerCase() === target
      ) {
        return all[i]
      }
    }
    return null
  }, timeoutMs)
}

// Open the create-site modal via continueAction(-1) (blank-site path), type the
// site name, click Create Site, and return the create API response record.
async function createSiteViaUI(page, collector, siteName) {
  const useCaseFilter = await waitForDeep(
    page,
    selectors.dashboard.useCaseFilterChain,
    30000,
  )
  if (!useCaseFilter) {
    throw new Error('dashboard app-hax-use-case-filter not found')
  }
  // Trigger the blank-site create modal programmatically (per source).
  await useCaseFilter.evaluate((el) => {
    el.continueAction(-1)
  })

  // Wait for the modal's open flag + the siteName input to be present.
  await waitFor(
    async () => {
      const m = await deepQuery(page, selectors.create.siteCreationModalChain)
      if (!m) {
        return false
      }
      return m.evaluate((el) => el.open === true)
    },
    15000,
  )
  await waitForDeep(page, selectors.create.siteNameInputChain, 10000)

  // continueAction(-1) pre-fills siteName with "Blank Site" — overwrite it.
  await typeIntoShadow(page, selectors.create.siteNameInputChain, siteName)

  // Sanity-check the Lit binding accepted the value.
  const nameInput = await deepQuery(page, selectors.create.siteNameInputChain)
  const typedValue = await nameInput.evaluate((i) => i.value)
  if (String(typedValue).toLowerCase() !== String(siteName).toLowerCase()) {
    throw new Error(
      'siteName input did not accept value; got="' + typedValue + '" expected="' + siteName + '"',
    )
  }

  const createBtn = await deepQuery(page, selectors.create.createSiteButtonChain)
  if (!createBtn) {
    throw new Error('Create Site button not found')
  }
  await createBtn.evaluate((b) => b.click())

  return findCreateSiteResponse(collector, siteName, 60000)
}

// ---------------------------------------------------------------------------
// dashboard reload + site-card finders
// ---------------------------------------------------------------------------

// Reload the dashboard. The JWT is persisted to localStorage by the store, so a
// reload normally auto-logs-in and re-fetches the sites list fresh from the
// filesystem. If auto-login does not happen (no persisted JWT), fall back to the
// two-step UI login via performLoginEvaluate.
async function reloadDashboard(page, t) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('app-hax', { timeout: 30000 })
  // Give the SPA a moment to either auto-login or surface the login modal.
  await new Promise((r) => setTimeout(r, 2000))
  const needsLogin = await page.evaluate(() => {
    const m = document.querySelector('simple-modal')
    if (!m) {
      return false
    }
    const l = m.querySelector('app-hax-site-login')
    return !!(l && l.shadowRoot && l.shadowRoot.querySelector('#username'))
  })
  if (needsLogin) {
    if (t) {
      t.diagnostic('login modal present after reload; performing UI re-login')
    }
    await performLoginEvaluate(page, E2E_USER_NAME, E2E_USER_PASSWORD)
  }
}

// Traverse the dashboard shadow DOM directly (document > app-hax >
// app-hax-use-case-filter > app-hax-search-results > app-hax-site-bar) and
// return the first card whose text includes the site name. Uses
// page.evaluateHandle returning the element itself (deepQueryAll's
// evaluateHandle+getProperties path was unreliable for this chain). Polls
// generously since the SPA is slow to re-render.
async function findSiteCard(page, siteName) {
  const target = String(siteName).toLowerCase()
  return waitFor(
    async () => {
      const handle = await page.evaluateHandle((t) => {
        const appHax = document.querySelector('app-hax')
        if (!appHax || !appHax.shadowRoot) {
          return null
        }
        const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
        if (!ucf || !ucf.shadowRoot) {
          return null
        }
        const sr = ucf.shadowRoot.querySelector('app-hax-search-results')
        if (!sr || !sr.shadowRoot) {
          return null
        }
        const cards = sr.shadowRoot.querySelectorAll('app-hax-site-bar')
        for (let i = 0; i < cards.length; i++) {
          if ((cards[i].textContent || '').toLowerCase().indexOf(t) !== -1) {
            return cards[i]
          }
        }
        return null
      }, target)
      const el = handle.asElement()
      if (!el) {
        await handle.dispose()
        return null
      }
      return el
    },
    75000,
  )
}

// Wait until no site card mentions the site name (archive removed it from list).
async function waitForCardGone(page, siteName) {
  const target = String(siteName).toLowerCase()
  const result = await waitFor(
    async () =>
      page.evaluate((t) => {
        const appHax = document.querySelector('app-hax')
        if (!appHax || !appHax.shadowRoot) {
          return true
        }
        const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
        if (!ucf || !ucf.shadowRoot) {
          return true
        }
        const sr = ucf.shadowRoot.querySelector('app-hax-search-results')
        if (!sr || !sr.shadowRoot) {
          return true
        }
        const cards = sr.shadowRoot.querySelectorAll('app-hax-site-bar')
        for (let i = 0; i < cards.length; i++) {
          if ((cards[i].textContent || '').toLowerCase().indexOf(t) !== -1) {
            return false
          }
        }
        return true
      }, target),
    30000,
  )
  return result === true
}

// Poll for app-hax-site-bar cards in the dashboard site list.
async function waitForSiteCards(page, timeoutMs) {
  const chain = selectors.dashboard.siteListChain.concat(['app-hax-site-bar'])
  const deadline = Date.now() + (timeoutMs || 20000)
  while (Date.now() < deadline) {
    const cards = await deepQueryAll(page, chain)
    if (cards && cards.length > 0) {
      return cards
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return []
}

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

// Dump the dashboard site-list DOM for diagnostics when a card can't be found.
async function dumpDashboard(page) {
  return page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    const ucf =
      appHax && appHax.shadowRoot
        ? appHax.shadowRoot.querySelector('app-hax-use-case-filter')
        : null
    const sr =
      ucf && ucf.shadowRoot
        ? ucf.shadowRoot.querySelector('app-hax-search-results')
        : null
    const cards =
      sr && sr.shadowRoot
        ? sr.shadowRoot.querySelectorAll('app-hax-site-bar')
        : []
    const cardTexts = []
    for (let i = 0; i < cards.length; i++) {
      cardTexts.push((cards[i].textContent || '').trim().substring(0, 80))
    }
    return {
      appHax: !!appHax,
      ucf: !!ucf,
      sr: !!sr,
      srSearchItems: sr ? (sr.searchItems ? sr.searchItems.length : 'no-prop') : null,
      srDisplayItems: sr ? (sr.displayItems ? sr.displayItems.length : 'no-prop') : null,
      cardCount: cards.length,
      cardTexts: cardTexts,
      noResult: sr && sr.shadowRoot ? !!sr.shadowRoot.querySelector('#noResult') : false,
    }
  })
}

// Dump the dashboard site-list structure for diagnostics when cards don't
// appear. Reports app-hax-search-results displayItems/searchItems/searchTerm/
// totalItems and #results <li> + app-hax-site-bar counts.
async function dumpSiteListDiagnostics(page) {
  const info = await page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    const ucf = appHax && appHax.shadowRoot && appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    const ret = ucf && ucf.shadowRoot && ucf.shadowRoot.querySelector('#returnToSection')
    const sr = ret && ret.querySelector('app-hax-search-results')
    if (!sr) {
      return { searchResultsFound: false }
    }
    const resultsUl = sr.shadowRoot ? sr.shadowRoot.querySelector('#results') : null
    const liCount = resultsUl ? resultsUl.querySelectorAll('li').length : -1
    const barCount = sr.shadowRoot ? sr.shadowRoot.querySelectorAll('app-hax-site-bar').length : -1
    const headings = []
    if (sr.shadowRoot) {
      sr.shadowRoot.querySelectorAll('app-hax-site-bar').forEach((bar) => {
        const slot = bar.shadowRoot ? bar.shadowRoot.querySelector('slot[name="heading"]') : null
        let txt = ''
        if (slot) {
          slot.assignedNodes().forEach((n) => {
            txt += n.textContent || ''
          })
        }
        headings.push((txt || '').trim())
      })
    }
    return {
      searchResultsFound: true,
      displayItemsLen: Array.isArray(sr.displayItems) ? sr.displayItems.length : -1,
      searchItemsLen: Array.isArray(sr.searchItems) ? sr.searchItems.length : -1,
      searchTerm: sr.searchTerm || '',
      totalItems: sr.totalItems,
      resultsLiCount: liCount,
      siteBarCount: barCount,
      headings: headings,
    }
  })
  // eslint-disable-next-line no-console
  console.warn('[diag] site-list: ' + JSON.stringify(info))
  return info
}

// ---------------------------------------------------------------------------
// HAXCMS_ROOT harness workaround
// ---------------------------------------------------------------------------

// The E2E harness sets process.env.HAXCMS_ROOT. HAXCMS.js captures a
// module-level const HAXCMS_ROOT at load time, and some code paths (createSite)
// use STRING concatenation (HAXCMS_ROOT + sitesDirectory) while others
// (listSites/loadSite) use path.join / the instance property. Patching the
// instance property guarantees the trailing slash for the path.join paths. Harmless
// no-op when the harness already set the slash. Returns the HAXCMS singleton.
function patchHaxcmsRootForHarness(runtime) {
  const { HAXCMS } = require('../../../src/lib/HAXCMS.js')
  const root = String(runtime.runtimeRoot)
  HAXCMS.HAXCMS_ROOT = root.charAt(root.length - 1) === '/' ? root : root + '/'
  return HAXCMS
}

// Relocate the just-created site from the module-const write path
// (runtimeRoot + "_sites" = "runtimeRoot_sites") into the path.join path
// (runtimeRoot/_sites) so the patched load/archive/download routes find it.
// Harmless no-op if the site is already at the correct path.
function relocateCreatedSite(runtime, siteName) {
  const name = String(siteName).toLowerCase()
  const fromDir = path.join(runtime.runtimeRoot + '_sites', name)
  const toDir = path.join(runtime.runtimeRoot, SITES_DIR, name)
  if (fs.pathExistsSync(fromDir)) {
    fs.moveSync(fromDir, toDir, { overwrite: true })
    return true
  }
  return false
}

// Alias kept for tests that referred to it as relocateCreatedSiteIfStale.
function relocateCreatedSiteIfStale(runtime, siteName) {
  return relocateCreatedSite(runtime, siteName)
}

// ---------------------------------------------------------------------------
// visual
// ---------------------------------------------------------------------------

// Safe visual comparison wrapper: a throw from compareBaseline becomes a WARN
// diagnostic and never fails the test (per the visual-diffs-warn-only rule).
// visual.cjs handles the pixelmatch ESM interop itself, but we wrap anyway so a
// throw never fails the test.
async function safeCompareBaseline(name, buf, opts, t) {
  try {
    return await compareBaseline(name, buf, opts)
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    if (t) {
      t.diagnostic(
        'visual compareBaseline for "' + name + '" threw (non-fatal): ' + msg,
      )
    }
    return {
      diffPixels: -1,
      totalPixels: -1,
      diffPercent: -1,
      baselineExists: false,
      baselineUpdated: false,
      error: msg,
    }
  }
}

// ---------------------------------------------------------------------------
// status-only response watcher (for 4xx bodies the collector hangs on)
// ---------------------------------------------------------------------------

// The shared ResponseCollector awaits response.text() before recording a
// response, which hangs indefinitely for some 4xx responses in puppeteer — so
// 401/403 rejections never get pushed to the collector's records. This watcher
// records url + status synchronously when the response event fires (status()
// is sync and always available), then best-effort reads the body with a 3s
// timeout race so a hung response.text() never blocks the record. Used
// alongside the collector: the collector remains the source for 200s; this
// watcher is the source for error responses.
function createStatusWatcher(page) {
  const records = []
  const handler = (response) => {
    const rec = {
      url: response.url(),
      status: response.status(),
      bodyText: '',
      timestamp: Date.now(),
    }
    records.push(rec)
    // Best-effort body read; status is already recorded above so a hang or
    // rejection here only affects bodyText (defaults to '').
    Promise.race([
      response.text().catch(() => ''),
      new Promise((r) => setTimeout(() => r(''), 3000)),
    ]).then((bodyText) => {
      rec.bodyText = bodyText
    })
  }
  page.on('response', handler)
  return {
    getAll: () => records.slice(),
    getFor: (urlSubstring) =>
      records.filter((r) => r.url.indexOf(urlSubstring) !== -1),
    waitFor: (urlSubstring, timeoutMs) =>
      new Promise((resolve) => {
        const deadline = Date.now() + (timeoutMs || 20000)
        const poll = () => {
          const matches = records.filter(
            (r) => r.url.indexOf(urlSubstring) !== -1,
          )
          if (matches.length > 0) {
            return resolve(matches[matches.length - 1])
          }
          if (Date.now() >= deadline) {
            return resolve(null)
          }
          setTimeout(poll, 200)
        }
        poll()
      }),
    detach: () => page.off('response', handler),
  }
}

// ---------------------------------------------------------------------------
// outline-editor dialog helper (light-DOM, same pattern as login)
// ---------------------------------------------------------------------------

// Ensure the outline editor dialog is open (re-click #outlinebutton if not).
// The outline modal can auto-dismiss during slow operations. Returns true when
// the dialog is present (with a stamped shadowRoot).
async function ensureOutlineOpen(page, t) {
  const present = await page.evaluate(() => {
    var modals = document.querySelectorAll('simple-modal')
    for (var i = 0; i < modals.length; i++) {
      var d = modals[i].querySelector('haxcms-outline-editor-dialog')
      if (d && d.shadowRoot) {
        return true
      }
    }
    var d2 = document.querySelector('haxcms-outline-editor-dialog')
    return !!(d2 && d2.shadowRoot)
  })
  if (present) {
    return true
  }
  if (t) {
    t.diagnostic('[outline] dialog not present; re-clicking #outlinebutton to reopen')
  }
  await page.evaluate(() => {
    var ui = document.querySelector('haxcms-site-editor-ui')
    if (!ui || !ui.shadowRoot) {
      return false
    }
    var btn = ui.shadowRoot.querySelector('#outlinebutton')
    if (!btn) {
      return false
    }
    var inner = btn.shadowRoot && btn.shadowRoot.querySelector('button')
    if (inner) {
      inner.click()
    } else {
      btn.click()
    }
    return true
  })
  const ready = await waitFor(
    async () =>
      page.evaluate(() => {
        var modals = document.querySelectorAll('simple-modal')
        for (var i = 0; i < modals.length; i++) {
          var d = modals[i].querySelector('haxcms-outline-editor-dialog')
          if (d && d.shadowRoot) {
            return true
          }
        }
        var d2 = document.querySelector('haxcms-outline-editor-dialog')
        return !!(d2 && d2.shadowRoot)
      }),
    20000,
  )
  return !!ready
}

module.exports = {
  // small utils
  findCookie,
  parseJsonSafely,
  summariseViolations,
  awaitCookie,
  awaitResponseStatus,
  // polling + shadow utilities
  waitFor,
  waitForDeep,
  typeIntoShadow,
  setShadowInput,
  clickShadowButton,
  deepFindRecursive,
  WALK_HAX_BODY_FN,
  haxBodyEditModeActive,
  markerInHaxBody,
  clickEditorButtonById,
  // login
  getLoginElement,
  waitForLoginModal,
  waitForLoginModalRetry,
  waitForPasswordInput,
  loginSetInput,
  loginClickButton,
  performLoginEvaluate,
  loginViaUI,
  loginViaUIStepwise,
  // create-site
  findCreateSiteResponse,
  createSiteViaUI,
  // dashboard
  reloadDashboard,
  findSiteCard,
  waitForCardGone,
  waitForSiteCards,
  // diagnostics
  dumpDashboard,
  dumpSiteListDiagnostics,
  // HAXCMS_ROOT workaround
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  relocateCreatedSiteIfStale,
  // visual
  safeCompareBaseline,
  // response watcher
  createStatusWatcher,
  // outline
  ensureOutlineOpen,
  // constants re-exported for convenience
  SITES_DIR,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  FIXED_SITE_NAME,
}
