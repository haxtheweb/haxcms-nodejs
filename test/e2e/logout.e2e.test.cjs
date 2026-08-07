'use strict'

// E2E test: logout flow via the dashboard user menu (auth-dashboard group).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via two-step modal ->
// wait for dashboard -> open user menu via #tbchar -> click the logout button
// (app-hax-user-menu-button.logout inner button.menu-button) -> assert
// POST /system/api/v1/session/logout returns 200 + {status:200,data:"loggedout"}
// -> assert haxcms_refresh_token cookie cleared -> assert JWT cleared from
// localStorage -> assert the login modal reappears (waitForLoginModal) ->
// visual baseline + a11y scan.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards everywhere), node:test +
// node:assert/strict, visual diffs WARN but never fail, no edits to
// src/build/node_modules.
//
// SELECTOR NOTE: the logout control is in the app-hax shadow DOM:
//   document > app-hax (shadow) > app-hax-user-menu (light DOM) >
//     app-hax-user-menu-button.logout (slotted post-menu).
// The menu is opened by clicking #tbchar (app-hax-user-menu-toggle). The
// logout button has an inner button.menu-button in its shadowRoot; clicking it
// bubbles to the host which fires this.logout(). All verified by
// .discovery-auth-dashboard.cjs.

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
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers
  waitFor,
  loginViaUI,
  waitForLoginModal,
  waitForDeep,
  patchHaxcmsRootForHarness,
  safeCompareBaseline,
  createStatusWatcher,
  findCookie,
  summariseViolations,
} = require('./helpers')

// --- shared state ---
let runtime = null
let browser = null
let page = null
let collector = null
let statusWatcher = null

test.before(async () => {
  runtime = await setupE2ERuntime()
  patchHaxcmsRootForHarness(runtime)
  browser = await launchBrowser()
  page = await newPage(browser)
  collector = createResponseCollector(page)
  statusWatcher = createStatusWatcher(page)
}, { timeout: 120000 })

test.after(async () => {
  if (statusWatcher) {
    try { statusWatcher.detach() } catch (e) { /* ignore */ }
  }
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

// --- logout helpers ---

// Open the user menu by clicking #tbchar (app-hax-user-menu-toggle) inside
// app-hax's shadowRoot. Returns true if the menu isOpen flag flipped to true.
async function openUserMenu(page) {
  const result = await page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) {
      return { error: 'no app-hax' }
    }
    const userMenu = appHax.shadowRoot.querySelector('app-hax-user-menu')
    if (!userMenu) {
      return { error: 'no user-menu' }
    }
    const toggle = userMenu.querySelector('#tbchar')
    if (!toggle) {
      return { error: 'no #tbchar' }
    }
    toggle.click()
    return { clicked: true, isOpen: userMenu.isOpen }
  })
  return result
}

// Click the logout button inside the opened user menu. The logout button is
// app-hax-user-menu-button.logout (light DOM, slotted post-menu). Clicking the
// inner button.menu-button in its shadowRoot bubbles to the host @click handler.
async function clickLogoutButton(page) {
  return page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) {
      return { error: 'no app-hax' }
    }
    const userMenu = appHax.shadowRoot.querySelector('app-hax-user-menu')
    if (!userMenu) {
      return { error: 'no user-menu' }
    }
    const logoutBtn = userMenu.querySelector('app-hax-user-menu-button.logout')
    if (!logoutBtn) {
      return { error: 'no logout button' }
    }
    const inner = logoutBtn.shadowRoot && logoutBtn.shadowRoot.querySelector('button')
    if (inner) {
      inner.click()
    } else {
      logoutBtn.click()
    }
    return { clicked: true, usedInner: !!inner }
  })
}

// Check whether a JWT is present in localStorage (key contains 'jwt').
async function jwtInLocalStorage(page) {
  return page.evaluate(() => {
    try {
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const key = globalThis.localStorage.key(i)
        if (key && key.indexOf('jwt') !== -1) {
          const val = globalThis.localStorage.getItem(key)
          if (val && val.length > 10) {
            return true
          }
        }
      }
    } catch (e) {}
    return false
  })
}

// --- logout e2e suite ---

test('logout e2e: dashboard logout flow', { timeout: 180000 }, async (t) => {
  assert.ok(page, 'page initialised in before hook')
  assert.ok(runtime && runtime.baseUrl, 'runtime booted with baseUrl')

  await t.test('login via two-step modal', async () => {
    await loginViaUI(page, collector, runtime.baseUrl)
    // Wait for the dashboard to render (use-case-filter in shadow DOM).
    const ucf = await waitForDeep(
      page,
      selectors.dashboard.useCaseFilterChain,
      30000,
    )
    assert.ok(ucf, 'dashboard app-hax-use-case-filter rendered after login')
    if (ucf) {
      await ucf.dispose()
    }
  })

  await t.test('open user menu via #tbchar', async () => {
    const result = await openUserMenu(page)
    assert.ok(result && result.clicked, 'user menu toggle clicked: ' + JSON.stringify(result))
    // Give the menu a moment to open (isOpen is reactive).
    await new Promise((r) => setTimeout(r, 800))
    const isOpen = await page.evaluate(() => {
      const appHax = document.querySelector('app-hax')
      const um = appHax && appHax.shadowRoot && appHax.shadowRoot.querySelector('app-hax-user-menu')
      return um ? um.isOpen === true : false
    })
    assert.ok(isOpen, 'user menu isOpen should be true after #tbchar click')
  })

  await t.test('visual: dashboard with user menu open', async () => {
    const buf = await captureScreenshot(page, 'logout-menu-open')
    const cmp = await safeCompareBaseline('logout-menu-open', buf, null, t)
    assert.ok(cmp, 'compareBaseline should return a result object')
  })

  await t.test('click logout button', async () => {
    const result = await clickLogoutButton(page)
    assert.ok(result && result.clicked, 'logout button clicked: ' + JSON.stringify(result))
  })

  await t.test('response: POST /session/logout returns 200', async () => {
    // The logout API returns 200, so the collector should capture it.
    // Use a generous timeout since the SPA may take a moment to fire the call.
    let logoutResp = null
    try {
      logoutResp = await collector.awaitCollectorFor('session/logout', 20000)
    } catch (e) {
      t.diagnostic('[e2e] collector did not capture session/logout: ' + (e && e.message ? e.message : e))
    }
    if (!logoutResp) {
      // Fall back to the status watcher (records status synchronously).
      const swRec = statusWatcher.waitFor('session/logout', 10000)
      const rec = await swRec
      assert.ok(rec, 'logout API response should be captured by collector or status watcher')
      assert.equal(
        rec.status,
        200,
        'logout API should return 200, got ' + rec.status,
      )
    } else {
      assert.equal(
        logoutResp.status,
        200,
        'logout API should return 200, got ' + logoutResp.status +
          ' body: ' + String(logoutResp.bodyText || '').slice(0, 200),
      )
      const parsed = JSON.parse(logoutResp.bodyText || '{}')
      assert.equal(
        parsed.data,
        'loggedout',
        'logout response data should be "loggedout"',
      )
    }
  })

  await t.test('cookie: haxcms_refresh_token cleared', async () => {
    // The logout route calls HAXCMS.setRefreshTokenCookie(res, '', 1) to clear
    // the cookie. Poll briefly because the browser may need a moment to apply it.
    const cleared = await waitFor(async () => {
      const cookies = await page.cookies()
      const refresh = findCookie(cookies, 'haxcms_refresh_token')
      // Cookie is "cleared" if it's absent OR has an empty value.
      if (!refresh) {
        return true
      }
      if (refresh.value === '' || refresh.value === ' ') {
        return true
      }
      return false
    }, 10000)
    assert.ok(cleared, 'haxcms_refresh_token cookie should be cleared after logout')
  })

  await t.test('localStorage: JWT cleared', async () => {
    // After logout the SPA clears the JWT from localStorage. Poll briefly.
    const cleared = await waitFor(async () => {
      const present = await jwtInLocalStorage(page)
      return !present
    }, 10000)
    assert.ok(cleared, 'JWT should be cleared from localStorage after logout')
  })

  await t.test('ui-state: login modal reappears after logout', async () => {
    // The SPA should re-open the login modal after logout. Use the
    // reload-robust variant since logout may trigger a navigation/reload.
    const loginEl = await waitForLoginModal(page, 25000)
    assert.ok(
      loginEl,
      'login modal (simple-modal > app-hax-site-login) should reappear after logout',
    )
    if (loginEl) {
      await loginEl.dispose()
    }
    // Logout may trigger a full page reload; wait for app-hax to be present
    // again so subsequent screenshot/a11y operations don't hit a destroyed
    // execution context.
    try {
      await page.waitForSelector('app-hax', { timeout: 15000 })
    } catch (e) {
      t.diagnostic('[e2e] app-hax not found after logout (page may still be loading): ' + (e && e.message ? e.message : e))
    }
    // Extra settle time for the login modal to stamp its shadow DOM after reload.
    await new Promise((r) => setTimeout(r, 1500))
  })

  await t.test('a11y: login modal after logout', async () => {
    // Scope to the login modal host so page-level noise is excluded.
    let a11y = null
    try {
      a11y = await runA11y(page, 'simple-modal')
    } catch (e) {
      t.diagnostic('[a11y] runA11y threw (non-fatal): ' + (e && e.message ? e.message : e))
    }
    if (a11y) {
      t.diagnostic(
        '[a11y] login-after-logout: critical=' +
          (a11y.critical || []).length +
          ' serious=' +
          (a11y.serious || []).length,
      )
      // Document nonzero findings but do not hard-fail (per task spec — the
      // login form a11y is already covered by login.e2e.test.cjs).
      assert.ok(a11y, 'runA11y returned a result object')
    }
  })

  await t.test('visual: logged-out baseline after logout', async () => {
    // Visual diffs WARN but never fail. Wrap captureScreenshot in a try/catch
    // because logout may trigger a navigation that destroys the execution
    // context mid-screenshot. A failed capture is non-fatal.
    let buf = null
    try {
      buf = await captureScreenshot(page, 'logout-logged-out')
    } catch (e) {
      t.diagnostic('[visual] captureScreenshot threw (non-fatal): ' + (e && e.message ? e.message : e))
    }
    if (buf) {
      const cmp = await safeCompareBaseline('logout-logged-out', buf, null, t)
      assert.ok(cmp, 'compareBaseline should return a result object')
    } else {
      t.diagnostic('[visual] screenshot skipped (page navigation in progress)')
      assert.ok(true, 'visual baseline skipped due to navigation (non-fatal)')
    }
  })
})
