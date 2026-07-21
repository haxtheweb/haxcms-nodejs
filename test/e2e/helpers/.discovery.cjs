'use strict'

// Discovery script (dotfile, ignored by node --test glob).
// Boots the E2E harness, launches Chrome, navigates to the dashboard, waits for
// the login UI, dumps the real DOM structure (custom element tags, input
// selectors, button text), captures the login API response, logs in, waits for
// the dashboard, and dumps the dashboard site-list / create-site / archive
// selectors. Prints a structured report so selectors.cjs can be refined.
//
// Run: node test/e2e/helpers/.discovery.cjs
// (from the repo root)

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  E2E_USER_NAME,
  E2E_USER_PASSWORD,
  launchBrowser,
  newPage,
  createResponseCollector,
} = require('./index.cjs')

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

async function dumpLoginModal(page) {
  console.log('\n--- LOGIN MODAL DOM ---')
  const info = await page.evaluate(() => {
    const modal = document.querySelector('simple-modal')
    if (!modal) {
      return { modalFound: false }
    }
    const loginEl = modal.querySelector('app-hax-site-login')
    function dumpLoginShadow() {
      if (!loginEl || !loginEl.shadowRoot) return null
      const children = []
      loginEl.shadowRoot.querySelectorAll('input, button, #errorText, rpg-character').forEach((child) => {
        const tag = child.tagName.toLowerCase()
        const id = child.id ? `#${child.id}` : ''
        const cls = child.className && typeof child.className === 'string' && child.className.trim()
          ? '.' + child.className.trim().split(/\s+/).join('.')
          : ''
        const type = child.getAttribute ? child.getAttribute('type') : ''
        const placeholder = child.getAttribute ? child.getAttribute('placeholder') : ''
        const aria = child.getAttribute ? child.getAttribute('aria-label') : ''
        const text = child.textContent && child.textContent.trim() ? ` text="${child.textContent.trim()}"` : ''
        children.push(`${tag}${id}${cls}${type ? ` type=${type}` : ''}${placeholder ? ` ph="${placeholder}"` : ''}${aria ? ` aria="${aria}"` : ''}${text}`)
      })
      return children
    }
    return {
      modalFound: true,
      modalOpened: modal.opened === true,
      loginElFound: !!loginEl,
      loginShadowChildren: dumpLoginShadow(),
    }
  })
  console.log(JSON.stringify(info, null, 2))
}

async function dumpDashboard(page) {
  console.log('\n--- DASHBOARD DOM ---')
  const info = await page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) {
      return { appHaxFound: !!appHax }
    }
    const useCaseFilter = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!useCaseFilter || !useCaseFilter.shadowRoot) {
      return { appHaxFound: true, useCaseFilterFound: !!useCaseFilter }
    }
    const returnTo = useCaseFilter.shadowRoot.querySelector('#returnToSection')
    const searchResults = useCaseFilter.shadowRoot.querySelector('app-hax-search-results')
    const createHeading = useCaseFilter.shadowRoot.querySelector('#create-site-heading')
    const creationModal = useCaseFilter.shadowRoot.querySelector('app-hax-site-creation-modal')
    const useCases = useCaseFilter.shadowRoot.querySelectorAll('app-hax-use-case')

    let siteCardInfo = null
    if (searchResults && searchResults.shadowRoot) {
      const cards = searchResults.shadowRoot.querySelectorAll('app-hax-site-bar')
      siteCardInfo = {
        siteBarCount: cards.length,
        firstSiteBarShadow: cards.length > 0 && cards[0].shadowRoot
          ? (function () {
              const items = []
              cards[0].shadowRoot.querySelectorAll('simple-icon-button-lite, simple-context-menu, simple-toolbar-button, slot').forEach((child) => {
                const tag = child.tagName.toLowerCase()
                const icon = child.getAttribute ? child.getAttribute('icon') : ''
                const label = child.getAttribute ? child.getAttribute('label') : ''
                const slotAttr = child.getAttribute ? child.getAttribute('slot') : ''
                items.push(`${tag}${icon ? ` icon=${icon}` : ''}${label ? ` label=${label}` : ''}${slotAttr ? ` slot=${slotAttr}` : ''}`)
              })
              return items
            })()
          : null,
      }
    }

    let creationModalInfo = null
    if (creationModal && creationModal.shadowRoot) {
      const items = []
      creationModal.shadowRoot.querySelectorAll('input, button, web-dialog, .form-input, .button').forEach((child) => {
        const tag = child.tagName.toLowerCase()
        const id = child.id ? `#${child.id}` : ''
        const cls = child.className && typeof child.className === 'string' && child.className.trim()
          ? '.' + child.className.trim().split(/\s+/).join('.')
          : ''
        const text = child.textContent && child.textContent.trim() ? ` text="${child.textContent.trim().substring(0, 30)}"` : ''
        items.push(`${tag}${id}${cls}${text}`)
      })
      creationModalInfo = { open: creationModal.open === true, shadowChildren: items }
    }

    return {
      appHaxFound: true,
      useCaseFilterFound: true,
      returnToSectionFound: !!returnTo,
      searchResultsFound: !!searchResults,
      createHeadingFound: !!createHeading,
      createHeadingText: createHeading ? createHeading.textContent.trim() : null,
      creationModalFound: !!creationModal,
      creationModalInfo: creationModalInfo,
      useCaseCount: useCases.length,
      siteCardInfo: siteCardInfo,
    }
  })
  console.log(JSON.stringify(info, null, 2))
}

async function main() {
  section('DISCOVERY: booting E2E runtime')
  const runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  console.log('port:', runtime.port)
  console.log('jwt (first 20 chars):', runtime.jwt.substring(0, 20) + '...')

  let browser = null
  let page = null
  let collector = null
  try {
    section('DISCOVERY: launching Chrome')
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)
    console.log('Chrome launched, page created at 1280x800')

    section('DISCOVERY: navigating to dashboard')
    await page.goto(runtime.baseUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    console.log('Navigated. Waiting for app-hax to load...')

    await page.waitForSelector('app-hax', { timeout: 20000 })
    console.log('app-hax present. Waiting for login modal...')

    let loginModalSeen = false
    try {
      await page.waitForSelector('simple-modal', { timeout: 20000 })
      loginModalSeen = true
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000))
      try {
        await page.waitForSelector('simple-modal', { timeout: 10000 })
        loginModalSeen = true
      } catch (e2) {
        console.log('simple-modal NOT found after wait')
      }
    }
    console.log('loginModalSeen:', loginModalSeen)

    if (loginModalSeen) {
      await new Promise((r) => setTimeout(r, 2000))
      await dumpLoginModal(page)
    }

    section('DISCOVERY: attempting UI login')
    const loginResult = await page.evaluate(async (username, password) => {
      const modal = document.querySelector('simple-modal')
      if (!modal) return { error: 'no modal' }
      const loginEl = modal.querySelector('app-hax-site-login')
      if (!loginEl || !loginEl.shadowRoot) return { error: 'no login el' }

      const usernameInput = loginEl.shadowRoot.querySelector('#username')
      if (!usernameInput) return { error: 'no username input' }
      usernameInput.value = username
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 100))

      const nextBtn = Array.from(loginEl.shadowRoot.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Next'),
      )
      if (nextBtn) {
        nextBtn.click()
      } else {
        return { error: 'no Next button', buttons: Array.from(loginEl.shadowRoot.querySelectorAll('button')).map((b) => b.textContent.trim()) }
      }
      await new Promise((r) => setTimeout(r, 500))

      const passwordInput = loginEl.shadowRoot.querySelector('#password')
      if (!passwordInput) return { error: 'no password input after Next' }
      passwordInput.value = password
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 100))

      const loginBtn = Array.from(loginEl.shadowRoot.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Login'),
      )
      if (loginBtn) {
        loginBtn.click()
      } else {
        return { error: 'no Login button', buttons: Array.from(loginEl.shadowRoot.querySelectorAll('button')).map((b) => b.textContent.trim()) }
      }
      return { clicked: true }
    }, E2E_USER_NAME, E2E_USER_PASSWORD)
    logJSON('loginResult', loginResult)

    try {
      const loginResp = await collector.awaitCollectorFor('session/login', 15000)
      section('DISCOVERY: login API response')
      logJSON('loginResponse', {
        url: loginResp.url,
        status: loginResp.status,
        bodyText: loginResp.bodyText.substring(0, 300),
      })
      try {
        const parsed = JSON.parse(loginResp.bodyText)
        logJSON('loginResponseParsed', { status: parsed.status, hasJwt: typeof parsed.jwt === 'string', jwtLen: parsed.jwt ? parsed.jwt.length : 0 })
      } catch (e) {
        console.log('login response not JSON parseable')
      }
    } catch (e) {
      console.log('login response NOT captured:', e.message)
    }

    await new Promise((r) => setTimeout(r, 5000))
    section('DISCOVERY: dashboard after login')
    await dumpDashboard(page)

    const sitesResps = collector.getResponsesFor('sites')
    section('DISCOVERY: sites API responses')
    sitesResps.forEach((r, i) => {
      console.log(`[${i}] ${r.status} ${r.url}`)
      console.log('  body (first 200):', r.bodyText.substring(0, 200))
    })

    section('DISCOVERY: DONE')
  } finally {
    if (collector) collector.detach()
    if (browser) {
      await browser.close()
    }
    await teardownE2ERuntime(runtime)
    console.log('\nTeardown complete.')
  }
}

main().catch((err) => {
  console.error('DISCOVERY FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
