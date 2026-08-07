'use strict'

// Discovery script for the auth-dashboard E2E test group (dotfile, ignored by
// node --test glob).
//
// Boots the E2E harness, logs in via the two-step UI, creates
// HAXSITEAUTOMATEDTESTING, reloads the dashboard, then maps three surfaces:
//   1) LOGOUT CONTROL  — user menu toggle (#tbchar), app-hax-user-menu-button.logout,
//      POST /system/api/v1/session/logout response.
//   2) SEARCH INPUT    — #searchField inside app-hax-use-case-filter shadowRoot,
//      client-side filtering of app-hax-site-bar cards.
//   3) SITE CARD CLICK — app-hax-site-bar a.imageLink href (dashboard→editor entry).
//
// Run: node test/e2e/helpers/.discovery-auth-dashboard.cjs  (from repo root)

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  selectors,
  FIXED_SITE_NAME,
  deepQuery,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  // flows helpers
  waitFor,
  waitForDeep,
  loginViaUI,
  createSiteViaUI,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  reloadDashboard,
  findSiteCard,
} = require('./index.cjs')

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

// --- status watcher (for 4xx that the collector hangs on) ---
function createStatusWatcher(page) {
  const records = []
  const handler = (response) => {
    const rec = {
      url: response.url(),
      status: response.status(),
      method: response.request() ? response.request().method() : '',
      bodyText: '',
      timestamp: Date.now(),
    }
    records.push(rec)
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
    getFor: (sub) => records.filter((r) => r.url.indexOf(sub) !== -1),
    detach: () => page.off('response', handler),
  }
}

// --- dump the user menu + logout control ---
async function dumpUserMenu(page) {
  return page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) {
      return { appHaxFound: !!appHax }
    }
    const userMenu = appHax.shadowRoot.querySelector('app-hax-user-menu')
    if (!userMenu) {
      return { appHaxFound: true, userMenuFound: false }
    }
    const toggle = userMenu.querySelector('#tbchar')
    const toggleTag = toggle ? toggle.tagName.toLowerCase() : ''
    const toggleHasShadow = !!(toggle && toggle.shadowRoot)
    let toggleShadowChildren = []
    if (toggle && toggle.shadowRoot) {
      toggle.shadowRoot.querySelectorAll('*').forEach((el) => {
        toggleShadowChildren.push(el.tagName.toLowerCase())
      })
    }
    // The logout button is a light-DOM child of userMenu (slotted into post-menu).
    const allButtons = userMenu.querySelectorAll('app-hax-user-menu-button')
    const buttonInfo = []
    for (let i = 0; i < allButtons.length; i++) {
      const b = allButtons[i]
      buttonInfo.push({
        tag: b.tagName.toLowerCase(),
        id: b.id || '',
        class: b.className || '',
        slot: b.getAttribute('slot') || '',
        label: b.label || '',
        icon: b.icon || '',
        hasShadow: !!b.shadowRoot,
        innerButtonClass: b.shadowRoot
          ? (b.shadowRoot.querySelector('button')
            ? b.shadowRoot.querySelector('button').className
            : '')
          : '',
      })
    }
    // specifically the .logout button
    const logoutBtn = userMenu.querySelector('app-hax-user-menu-button.logout')
    let logoutInfo = null
    if (logoutBtn) {
      const inner = logoutBtn.shadowRoot
        ? logoutBtn.shadowRoot.querySelector('button')
        : null
      logoutInfo = {
        found: true,
        label: logoutBtn.label || '',
        icon: logoutBtn.icon || '',
        slot: logoutBtn.getAttribute('slot') || '',
        innerButtonFound: !!inner,
        innerButtonClass: inner ? inner.className : '',
        innerButtonText: inner ? (inner.textContent || '').trim() : '',
      }
    } else {
      logoutInfo = { found: false }
    }
    return {
      appHaxFound: true,
      userMenuFound: true,
      userMenuIsOpen: userMenu.isOpen,
      toggleFound: !!toggle,
      toggleTag: toggleTag,
      toggleHasShadow: toggleHasShadow,
      toggleShadowChildren: toggleShadowChildren,
      allButtons: buttonInfo,
      logoutButton: logoutInfo,
    }
  })
}

// --- dump the search input + results ---
async function dumpSearchAndResults(page) {
  return page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) {
      return { appHaxFound: false }
    }
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf || !ucf.shadowRoot) {
      return { appHaxFound: true, ucfFound: !!ucf }
    }
    const searchField = ucf.shadowRoot.querySelector('#searchField')
    const sr = ucf.shadowRoot.querySelector('app-hax-search-results')
    let srInfo = null
    if (sr && sr.shadowRoot) {
      const cards = sr.shadowRoot.querySelectorAll('app-hax-site-bar')
      const headings = []
      for (let i = 0; i < cards.length; i++) {
        const slot = cards[i].shadowRoot
          ? cards[i].shadowRoot.querySelector('slot[name="heading"]')
          : null
        let txt = ''
        if (slot) {
          slot.assignedNodes({ flatten: true }).forEach((n) => {
            txt += n.textContent || ''
          })
        }
        headings.push((txt || '').trim())
      }
      srInfo = {
        found: true,
        displayItemsLen: Array.isArray(sr.displayItems) ? sr.displayItems.length : -1,
        searchTerm: sr.searchTerm || '',
        totalItems: sr.totalItems,
        siteBarCount: cards.length,
        headings: headings,
      }
    }
    return {
      appHaxFound: true,
      ucfFound: true,
      searchFieldFound: !!searchField,
      searchFieldType: searchField ? searchField.type : '',
      searchFieldPlaceholder: searchField ? searchField.placeholder : '',
      searchFieldAriaLabel: searchField ? searchField.getAttribute('aria-label') : '',
      searchResults: srInfo,
    }
  })
}

// --- main ---
async function main() {
  section('DISCOVERY auth-dashboard: booting E2E runtime')
  const runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  patchHaxcmsRootForHarness(runtime)

  let browser = null
  let page = null
  let collector = null
  let statusWatcher = null

  try {
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)
    statusWatcher = createStatusWatcher(page)

    section('login')
    await loginViaUI(page, collector, runtime.baseUrl)

    section('create site')
    const createResp = await createSiteViaUI(page, collector, FIXED_SITE_NAME)
    logJSON('CREATE SITE API', { status: createResp.status, url: createResp.url })
    const relocated = relocateCreatedSite(runtime, FIXED_SITE_NAME)
    console.log('relocated created site into _sites:', relocated)

    section('reload dashboard + find card')
    await reloadDashboard(page, null)
    const card = await findSiteCard(page, FIXED_SITE_NAME)
    if (!card) {
      throw new Error('site card not found after reload')
    }
    console.log('site card found')

    // ---------- PHASE 1: logout control ----------
    section('PHASE 1: dump user menu (before opening)')
    const menuBefore = await dumpUserMenu(page)
    logJSON('USER MENU (closed)', menuBefore)

    section('PHASE 1: open user menu via #tbchar click')
    const opened = await page.evaluate(() => {
      const appHax = document.querySelector('app-hax')
      if (!appHax || !appHax.shadowRoot) return { error: 'no app-hax' }
      const userMenu = appHax.shadowRoot.querySelector('app-hax-user-menu')
      if (!userMenu) return { error: 'no user-menu' }
      const toggle = userMenu.querySelector('#tbchar')
      if (!toggle) return { error: 'no #tbchar' }
      // click the toggle element — Lit @click handler is on the host
      toggle.click()
      return { clicked: true }
    })
    logJSON('TOGGLE CLICK', opened)
    await new Promise((r) => setTimeout(r, 1000))

    const menuAfter = await dumpUserMenu(page)
    logJSON('USER MENU (opened)', menuAfter)

    section('PHASE 1: click logout button + observe API')
    const logoutClick = await page.evaluate(() => {
      const appHax = document.querySelector('app-hax')
      if (!appHax || !appHax.shadowRoot) return { error: 'no app-hax' }
      const userMenu = appHax.shadowRoot.querySelector('app-hax-user-menu')
      if (!userMenu) return { error: 'no user-menu' }
      const logoutBtn = userMenu.querySelector('app-hax-user-menu-button.logout')
      if (!logoutBtn) return { error: 'no logout button' }
      // Click the inner button in the shadowRoot (handleClick bubbles to host)
      const inner = logoutBtn.shadowRoot && logoutBtn.shadowRoot.querySelector('button')
      if (inner) {
        inner.click()
      } else {
        logoutBtn.click()
      }
      return { clicked: true, usedInner: !!inner }
    })
    logJSON('LOGOUT CLICK', logoutClick)

    // Observe the logout API response (both collector + status watcher)
    let logoutResp = null
    try {
      logoutResp = await collector.awaitCollectorFor('session/logout', 15000)
    } catch (e) {
      console.log('collector did not capture session/logout:', e.message)
    }
    if (logoutResp) {
      logJSON('LOGOUT API (collector)', {
        url: logoutResp.url,
        status: logoutResp.status,
        body: (logoutResp.bodyText || '').substring(0, 300),
      })
    }
    // also check the status watcher
    await new Promise((r) => setTimeout(r, 3000))
    const swLogout = statusWatcher.getFor('session/logout')
    logJSON('LOGOUT API (status watcher)', swLogout.map((r) => ({
      url: r.url,
      status: r.status,
      method: r.method,
      body: (r.bodyText || '').substring(0, 200),
    })))

    // Check what happens after logout — does the login modal reappear?
    await new Promise((r) => setTimeout(r, 3000))
    const postLogout = await page.evaluate(() => {
      const modal = document.querySelector('simple-modal')
      const loginEl = modal ? modal.querySelector('app-hax-site-login') : null
      const appHax = document.querySelector('app-hax')
      // check localStorage for jwt
      let jwtInStorage = false
      try {
        for (let i = 0; i < globalThis.localStorage.length; i++) {
          const key = globalThis.localStorage.key(i)
          if (key && key.indexOf('jwt') !== -1) {
            const val = globalThis.localStorage.getItem(key)
            if (val && val.length > 10) {
              jwtInStorage = true
            }
          }
        }
      } catch (e) {}
      return {
        modalFound: !!modal,
        modalOpened: modal ? modal.opened === true : false,
        loginElFound: !!loginEl,
        loginHasShadow: !!(loginEl && loginEl.shadowRoot),
        usernameInputFound: !!(loginEl && loginEl.shadowRoot && loginEl.shadowRoot.querySelector('#username')),
        appHaxFound: !!appHax,
        jwtInLocalStorage: jwtInStorage,
      }
    })
    logJSON('POST-LOGOUT STATE', postLogout)

    // Check cookies after logout
    const cookiesAfter = await page.cookies()
    logJSON('COOKIES AFTER LOGOUT', cookiesAfter.map((c) => ({ name: c.name, value: c.value.substring(0, 20) })))

    // ---------- PHASE 2: search input (fresh login + reload) ----------
    section('PHASE 2: re-login for search discovery')
    // After logout we need to re-login to test search
    const needsLogin = await page.evaluate(() => {
      const m = document.querySelector('simple-modal')
      if (!m) return false
      const l = m.querySelector('app-hax-site-login')
      return !!(l && l.shadowRoot && l.shadowRoot.querySelector('#username'))
    })
    if (needsLogin) {
      console.log('login modal present; performing UI re-login')
      const { performLoginEvaluate } = require('./flows.cjs')
      await performLoginEvaluate(page, E2E_USER_NAME, E2E_USER_PASSWORD)
      try {
        await collector.awaitCollectorFor('session/login', 20000)
      } catch (e) {
        console.log('re-login response not captured:', e.message)
      }
      await new Promise((r) => setTimeout(r, 3000))
    }

    section('PHASE 2: dump search input + results (before typing)')
    await reloadDashboard(page, null)
    await new Promise((r) => setTimeout(r, 3000))
    const searchBefore = await dumpSearchAndResults(page)
    logJSON('SEARCH + RESULTS (before)', searchBefore)

    section('PHASE 2: type into #searchField')
    // Type a search term that should narrow results to just our site
    const searchResult = await page.evaluate((term) => {
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
    }, 'haxsite')
    logJSON('SEARCH TYPED', searchResult)

    // Wait for client-side filtering to apply
    await new Promise((r) => setTimeout(r, 2000))
    const searchAfter = await dumpSearchAndResults(page)
    logJSON('SEARCH + RESULTS (after typing "haxsite")', searchAfter)

    // Type a non-matching term
    section('PHASE 2: type non-matching term')
    await page.evaluate((term) => {
      const appHax = document.querySelector('app-hax')
      const ucf = appHax && appHax.shadowRoot && appHax.shadowRoot.querySelector('app-hax-use-case-filter')
      const input = ucf && ucf.shadowRoot && ucf.shadowRoot.querySelector('#searchField')
      if (input) {
        input.value = term
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return true
    }, 'zzzznonexistent')
    await new Promise((r) => setTimeout(r, 2000))
    const searchNoMatch = await dumpSearchAndResults(page)
    logJSON('SEARCH + RESULTS (after typing "zzzznonexistent")', searchNoMatch)

    // Check if any search API fired
    const allResponses = statusWatcher.getAll()
    const sitesResponses = allResponses.filter((r) => r.url.indexOf('/system/api/v1/sites') !== -1)
    logJSON('ALL /system/api/v1/sites RESPONSES', sitesResponses.map((r) => ({
      url: r.url,
      status: r.status,
      method: r.method,
    })))

    // ---------- PHASE 3: site card click target ----------
    section('PHASE 3: dump site card click target')
    // Clear search first so the card is visible
    await page.evaluate(() => {
      const appHax = document.querySelector('app-hax')
      const ucf = appHax && appHax.shadowRoot && appHax.shadowRoot.querySelector('app-hax-use-case-filter')
      const input = ucf && ucf.shadowRoot && ucf.shadowRoot.querySelector('#searchField')
      if (input) {
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return true
    })
    await new Promise((r) => setTimeout(r, 2000))

    const cardInfo = await page.evaluate((siteName) => {
      const appHax = document.querySelector('app-hax')
      if (!appHax || !appHax.shadowRoot) return { error: 'no app-hax' }
      const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
      const sr = ucf && ucf.shadowRoot && ucf.shadowRoot.querySelector('app-hax-search-results')
      if (!sr || !sr.shadowRoot) return { error: 'no search-results' }
      const cards = sr.shadowRoot.querySelectorAll('app-hax-site-bar')
      const target = siteName.toLowerCase()
      let card = null
      for (let i = 0; i < cards.length; i++) {
        if ((cards[i].textContent || '').toLowerCase().indexOf(target) !== -1) {
          card = cards[i]
          break
        }
      }
      if (!card) return { error: 'card not found', cardCount: cards.length }
      const imageLink = card.shadowRoot ? card.shadowRoot.querySelector('a.imageLink') : null
      const headingSlot = card.shadowRoot ? card.shadowRoot.querySelector('slot[name="heading"]') : null
      let headingHref = ''
      if (headingSlot) {
        const assigned = headingSlot.assignedNodes({ flatten: true })
        for (let i = 0; i < assigned.length; i++) {
          if (assigned[i] && assigned[i].tagName && assigned[i].tagName.toLowerCase() === 'a') {
            headingHref = assigned[i].href || ''
            break
          }
        }
      }
      return {
        found: true,
        siteUrl: card.siteUrl || '',
        slug: card.slug || '',
        title: card.title || '',
        imageLinkFound: !!imageLink,
        imageLinkHref: imageLink ? imageLink.href : '',
        imageLinkAriaLabel: imageLink ? imageLink.getAttribute('aria-label') : '',
        headingSlotFound: !!headingSlot,
        headingHref: headingHref,
      }
    }, FIXED_SITE_NAME)
    logJSON('SITE CARD CLICK TARGET', cardInfo)

    section('DISCOVERY auth-dashboard: DONE')
  } catch (err) {
    console.error('DISCOVERY FAILED:', err && err.stack ? err.stack : err)
    try {
      const dump = await page.evaluate(() => document.body.innerHTML.substring(0, 1500))
      console.error('PAGE BODY SNIPPET:', dump)
    } catch (e) {
      // ignore
    }
  } finally {
    try {
      if (statusWatcher) statusWatcher.detach()
    } catch (e) {
      // ignore
    }
    try {
      if (collector) collector.detach()
    } catch (e) {
      // ignore
    }
    try {
      if (browser) await browser.close()
    } catch (e) {
      // ignore
    }
    try {
      await teardownE2ERuntime(runtime)
    } catch (e) {
      // ignore
    }
    console.log('\nTeardown complete.')
  }
}

main().catch((err) => {
  console.error('DISCOVERY TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
