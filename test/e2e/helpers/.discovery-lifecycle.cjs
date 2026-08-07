'use strict'

// Discovery script (dotfile, ignored by node --test glob).
// Boots the E2E harness, logs in, creates HAXSITEAUTOMATEDTESTING, then maps
// four lifecycle surfaces so selectors.cjs can be refined:
//   A) SAVE-AS-TEMPLATE  — more-vert -> "Create Template" menu item -> confirmation
//      modal (confirmText "Save to templates") -> POST /sites/:siteName/save-as-template
//      + skeleton file on disk under _config/user/skeletons/<name>.json.
//   B) CREATE-FROM-TEMPLATE — reload dashboard -> use-case-filter skeleton cards ->
//      find the just-saved template card -> call continueAction(index) -> modal
//      pre-filled with skeletonData/skeletonMachineName -> type a new name ->
//      "Create Site" -> POST /system/api/v1/sites (build.skeletonMachineName).
//   C) CLONE-SITE — more-vert -> "Copy" menu item -> confirmation modal
//      (confirmText "Confirm") -> POST /sites/:siteName/clone -> dynamic clone
//      name (getUniqueName) + files/ path rewrite.
//   D) RESTORE-SITE — archive via more-vert -> "Archive" -> confirm -> POST
//      /sites/:siteName/archive -> site moved to _archived/ -> (no restore UI)
//      move dir back to _sites/ -> reload -> card reappears.
//
// Run: node test/e2e/helpers/.discovery-lifecycle.cjs  (from repo root)

const path = require('path')
const fs = require('fs-extra')

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
  typeIntoShadow,
  performLoginEvaluate,
  reloadDashboard,
  createSiteViaUI,
  findSiteCard,
  waitForCardGone,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  findCreateSiteResponse,
} = require('./index.cjs')

const SITES_DIR = '_sites'
const ARCHIVE_DIR = '_archived'
const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase()

function section(title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

function logJSON(label, value) {
  console.log(label + ': ' + JSON.stringify(value, null, 2))
}

// --- local helpers (mirror .discovery-editor.cjs) ---------------------------

async function loginViaUI(page, collector, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
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
  if (!ready) throw new Error('login modal with #username did not appear')
  await performLoginEvaluate(page, E2E_USER_NAME, E2E_USER_PASSWORD)
  const loginResp = await collector.awaitCollectorFor('session/login', 20000)
  logJSON('LOGIN API', { status: loginResp.status, url: loginResp.url })
}

// open more-vert menu on a card + dump the menu items
async function openMoreVertAndDumpMenu(page, cardHandle) {
  const opened = await cardHandle.evaluate((el) => {
    const btn =
      el.shadowRoot &&
      el.shadowRoot.querySelector('simple-icon-button-lite[icon="lrn:more-vert"]')
    if (btn) {
      btn.click()
      return true
    }
    return false
  })
  if (!opened) return { opened: false }
  await new Promise((r) => setTimeout(r, 500))
  const dump = await cardHandle.evaluate((el) => {
    const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
    if (!menu) return { menuFound: false }
    const items = menu.querySelectorAll('simple-toolbar-button')
    const labels = []
    for (let i = 0; i < items.length; i++) {
      labels.push({
        label: String(items[i].getAttribute('label') || items[i].label || ''),
        icon: String(items[i].getAttribute('icon') || ''),
      })
    }
    return { menuFound: true, labels }
  })
  return { opened: true, dump }
}

// click a menu item by label (host first); return {clicked, label}
async function clickMenuItemByLabel(page, cardHandle, labelText) {
  return cardHandle.evaluate((el, label) => {
    const menu = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
    if (!menu) return { error: 'no menu' }
    const items = menu.querySelectorAll('simple-toolbar-button')
    for (let i = 0; i < items.length; i++) {
      const l = String(
        items[i].getAttribute('label') || items[i].label || '',
      ).toLowerCase()
      if (l === label.toLowerCase()) {
        items[i].click()
        return { clicked: true, label: l }
      }
    }
    return { error: 'label not found' }
  }, labelText)
}

// dump the confirmation modal currently on document.body
async function dumpConfirmationModal(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('app-hax-confirmation-modal')
    if (!modal || !modal.shadowRoot) {
      return { modalFound: false }
    }
    const btns = modal.shadowRoot.querySelectorAll('button')
    const buttonInfo = []
    for (let i = 0; i < btns.length; i++) {
      buttonInfo.push({
        text: (btns[i].textContent || '').trim(),
        classes: btns[i].className,
      })
    }
    return {
      modalFound: true,
      title: modal.title || '',
      message: modal.message || '',
      confirmText: modal.confirmText || '',
      cancelText: modal.cancelText || '',
      dangerous: modal.dangerous,
      buttons: buttonInfo,
    }
  })
}

// click the .button.button-confirm in the confirmation modal on document.body
async function clickConfirmButton(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('app-hax-confirmation-modal')
    if (!modal || !modal.shadowRoot) return { error: 'no modal' }
    const btn = modal.shadowRoot.querySelector('.button.button-confirm')
    if (!btn) return { error: 'no confirm button' }
    btn.click()
    return { clicked: true }
  })
}

// dump the use-case-filter skeleton cards (dataType skeleton)
async function dumpSkeletonCards(page) {
  return page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) return { appHaxFound: false }
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf || !ucf.shadowRoot) return { ucfFound: false }
    const cards = ucf.shadowRoot.querySelectorAll('app-hax-use-case')
    const out = []
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]
      out.push({
        index: c.getAttribute('data-item-index'),
        title: c.title || '',
        useCaseTitle: c.useCaseTitle || '',
        machineName: c.machineName || '',
        dataType: c.dataType || '',
        isSelected: !!c.isSelected,
        showContinue: !!c.showContinue,
      })
    }
    // also expose filteredItems machine names + skeletonUrls via the element
    let filtered = []
    try {
      filtered = (ucf.filteredItems || []).map((it) => ({
        dataType: it.dataType,
        useCaseTitle: it.useCaseTitle,
        machineName: it.machineName,
        skeletonUrl: it.skeletonUrl,
      }))
    } catch (e) {
      filtered = []
    }
    return { cardCount: cards.length, cards: out, filteredItems: filtered }
  })
}

// call continueAction(index) on the use-case-filter to open the modal pre-filled
async function callContinueAction(page, index) {
  return page.evaluate((idx) => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) return { error: 'no app-hax' }
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf) return { error: 'no ucf' }
    if (typeof ucf.continueAction !== 'function') return { error: 'no continueAction' }
    const p = ucf.continueAction(idx)
    return { dispatched: true, promise: !!p }
  }, index)
}

// dump the create-site modal state (skeletonData, skeletonMachineName, siteName, open)
async function dumpCreationModalState(page) {
  return page.evaluate(() => {
    const appHax = document.querySelector('app-hax')
    if (!appHax || !appHax.shadowRoot) return { appHaxFound: false }
    const ucf = appHax.shadowRoot.querySelector('app-hax-use-case-filter')
    if (!ucf || !ucf.shadowRoot) return { ucfFound: false }
    const modal = ucf.shadowRoot.querySelector('app-hax-site-creation-modal')
    if (!modal) return { modalFound: false }
    const skel = modal.skeletonData
    return {
      modalFound: true,
      open: modal.open,
      currentStep: modal.currentStep,
      siteName: modal.siteName,
      themeElement: modal.themeElement,
      skeletonMachineName: modal.skeletonMachineName,
      skeletonDataMetaMachineName:
        skel && skel.meta && typeof skel.meta.machineName === 'string'
          ? skel.meta.machineName
          : null,
      skeletonDataBuildStructure:
        skel && skel.build && typeof skel.build.structure === 'string'
          ? skel.build.structure
          : null,
      skeletonDataBuildType:
        skel && skel.build && typeof skel.build.type === 'string'
          ? skel.build.type
          : null,
      skeletonDataBuildItemsLen:
        skel && skel.build && Array.isArray(skel.build.items)
          ? skel.build.items.length
          : 0,
      skeletonDataBuildItemsTitles:
        skel && skel.build && Array.isArray(skel.build.items)
          ? skel.build.items.map((it) => it && it.title)
          : [],
    }
  })
}

// --- main -------------------------------------------------------------------

async function main() {
  section('DISCOVERY-LIFECYCLE: booting E2E runtime')
  const runtime = await setupE2ERuntime()
  console.log('baseUrl:', runtime.baseUrl)
  patchHaxcmsRootForHarness(runtime)

  let browser = null
  let page = null
  let collector = null
  const evidence = {}

  try {
    browser = await launchBrowser()
    page = await newPage(browser)
    collector = createResponseCollector(page)

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
    if (!card) throw new Error('site card not found after reload')
    console.log('site card found')

    // ---------- PHASE A: save-as-template ----------
    section('PHASE A: more-vert menu + Create Template')
    const menuResult = await openMoreVertAndDumpMenu(page, card)
    logJSON('MORE-VERT MENU', menuResult)
    evidence.moreVertMenu = menuResult

    // close the menu first (clicking Create Template also closes it, but re-open
    // cleanly to avoid a stale menu state)
    await card.evaluate((el) => {
      const m = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
      if (m && typeof m.close === 'function') m.close()
    })
    await new Promise((r) => setTimeout(r, 300))

    const createTemplateClick = await clickMenuItemByLabel(page, card, 'Create Template')
    logJSON('CREATE TEMPLATE MENU CLICK', createTemplateClick)
    await new Promise((r) => setTimeout(r, 1200))
    const templateModal = await waitFor(
      async () => {
        const d = await dumpConfirmationModal(page)
        if (d && d.modalFound) return d
        return false
      },
      12000,
    )
    logJSON('CREATE TEMPLATE CONFIRM MODAL', templateModal)
    evidence.createTemplateModal = templateModal

    if (templateModal && templateModal.modalFound) {
      const confirmClick = await clickConfirmButton(page)
      logJSON('SAVE-TO-TEMPLATES CONFIRM CLICK', confirmClick)
      let templateResp = null
      try {
        templateResp = await collector.awaitCollectorFor('/save-as-template', 25000)
      } catch (e) {
        console.log('save-as-template response NOT captured:', e.message)
      }
      if (templateResp) {
        logJSON('SAVE-AS-TEMPLATE RESPONSE', {
          url: templateResp.url,
          status: templateResp.status,
          bodyFirst500: templateResp.bodyText.substring(0, 500),
        })
        evidence.saveTemplateResponse = {
          url: templateResp.url,
          status: templateResp.status,
          body: templateResp.bodyText.substring(0, 800),
        }
        // parse data.name + data.path + check the file on disk
        try {
          const parsed = JSON.parse(templateResp.bodyText)
          const dataName = parsed && parsed.data && parsed.data.name
          const dataPath = parsed && parsed.data && parsed.data.path
          evidence.templateName = dataName
          evidence.templatePath = dataPath
          if (dataPath) {
            evidence.templateFileExists = fs.pathExistsSync(dataPath)
          }
          // also check the expected path under runtimeRoot/_config/user/skeletons
          const expectedPath = path.join(
            runtime.runtimeRoot,
            '_config',
            'user',
            'skeletons',
            dataName + '.json',
          )
          evidence.templateExpectedPath = expectedPath
          evidence.templateExpectedPathExists = fs.pathExistsSync(expectedPath)
        } catch (e) {
          console.log('parse save-as-template body failed:', e.message)
        }
      }
    } else {
      // escalate: call createTemplate() directly
      console.log('confirm modal not seen; calling createTemplate() directly')
      const direct = await card.evaluate((el) => {
        if (typeof el.createTemplate === 'function') {
          el.createTemplate()
          return { called: true }
        }
        return { called: false }
      })
      logJSON('CREATE TEMPLATE DIRECT CALL', direct)
      await new Promise((r) => setTimeout(r, 1500))
      const templateModal2 = await dumpConfirmationModal(page)
      logJSON('CREATE TEMPLATE CONFIRM MODAL (direct)', templateModal2)
      if (templateModal2 && templateModal2.modalFound) {
        await clickConfirmButton(page)
        let templateResp = null
        try {
          templateResp = await collector.awaitCollectorFor('/save-as-template', 25000)
        } catch (e) {
          console.log('save-as-template response NOT captured (direct):', e.message)
        }
        if (templateResp) {
          logJSON('SAVE-AS-TEMPLATE RESPONSE (direct)', {
            status: templateResp.status,
            bodyFirst500: templateResp.bodyText.substring(0, 500),
          })
          evidence.saveTemplateResponse = {
            status: templateResp.status,
            body: templateResp.bodyText.substring(0, 800),
          }
          try {
            const parsed = JSON.parse(templateResp.bodyText)
            evidence.templateName = parsed && parsed.data && parsed.data.name
            evidence.templatePath = parsed && parsed.data && parsed.data.path
            if (evidence.templatePath)
              evidence.templateFileExists = fs.pathExistsSync(evidence.templatePath)
          } catch (e) {
            /* ignore */
          }
        }
      }
    }

    // wait for the modal to be removed from body
    await new Promise((r) => setTimeout(r, 1500))

    // ---------- PHASE B: create-from-template ----------
    section('PHASE B: reload + skeleton cards + create from template')
    await reloadDashboard(page, null)
    await new Promise((r) => setTimeout(r, 2000))
    const skelCards = await dumpSkeletonCards(page)
    logJSON('SKELETON CARDS', skelCards)
    evidence.skeletonCards = skelCards

    // find the template card index (match by machineName or title)
    let templateIndex = null
    let templateMachineName = evidence.templateName || null
    if (skelCards && Array.isArray(skelCards.filteredItems)) {
      for (let i = 0; i < skelCards.filteredItems.length; i++) {
        const it = skelCards.filteredItems[i]
        if (
          it &&
          it.dataType === 'skeleton' &&
          templateMachineName &&
          it.machineName === templateMachineName
        ) {
          templateIndex = i
          break
        }
      }
    }
    if (templateIndex === null && skelCards && Array.isArray(skelCards.cards)) {
      for (let i = 0; i < skelCards.cards.length; i++) {
        const c = skelCards.cards[i]
        if (
          c &&
          c.dataType === 'skeleton' &&
          templateMachineName &&
          c.machineName === templateMachineName
        ) {
          templateIndex = Number(c.index)
          break
        }
      }
    }
    logJSON('TEMPLATE CARD INDEX', templateIndex)
    evidence.templateCardIndex = templateIndex

    if (templateIndex !== null) {
      const cont = await callContinueAction(page, templateIndex)
      logJSON('CONTINUE ACTION', cont)
      await new Promise((r) => setTimeout(r, 2500))
      const modalState = await dumpCreationModalState(page)
      logJSON('CREATION MODAL STATE (after continueAction)', modalState)
      evidence.creationModalState = modalState

      // capture the getSkeleton fetch that openTemplateModal makes
      let getSkelResp = null
      try {
        getSkelResp = collector.getResponsesFor('/skeletons/').slice(-1)[0]
      } catch (e) {
        /* ignore */
      }
      if (getSkelResp) {
        logJSON('GET SKELETON RESPONSE', {
          url: getSkelResp.url,
          status: getSkelResp.status,
        })
        evidence.getSkeletonResponse = { url: getSkelResp.url, status: getSkelResp.status }
      }

      // type a new site name + click Create Site
      if (modalState && modalState.modalFound && modalState.open) {
        const newName = 'E2E FROM TEMPLATE'
        await waitForDeep(page, selectors.create.siteNameInputChain, 10000)
        await typeIntoShadow(page, selectors.create.siteNameInputChain, newName)
        await new Promise((r) => setTimeout(r, 300))
        const createBtn = await deepQuery(page, selectors.create.createSiteButtonChain)
        if (createBtn) {
          await createBtn.evaluate((b) => b.click())
          let fromTemplateResp = null
          try {
            fromTemplateResp = await collector.awaitCollectorFor('/system/api/v1/sites', 40000)
          } catch (e) {
            console.log('create-from-template /sites response NOT captured:', e.message)
          }
          // find the create response matching the new name
          const allSites = collector.getResponsesFor('/system/api/v1/sites')
          let matched = null
          for (let i = 0; i < allSites.length; i++) {
            let parsed = null
            try {
              parsed = JSON.parse(allSites[i].bodyText)
            } catch (e) {
              continue
            }
            const metaSite =
              parsed && parsed.data && parsed.data.metadata && parsed.data.metadata.site
            if (
              parsed &&
              parsed.status === 200 &&
              metaSite &&
              typeof metaSite.name === 'string' &&
              metaSite.name.toLowerCase() === newName.toLowerCase()
            ) {
              matched = allSites[i]
              break
            }
          }
          if (matched) {
            logJSON('CREATE-FROM-TEMPLATE /sites RESPONSE', {
              url: matched.url,
              status: matched.status,
              bodyFirst500: matched.bodyText.substring(0, 500),
            })
            evidence.createFromTemplateResponse = {
              url: matched.url,
              status: matched.status,
              body: matched.bodyText.substring(0, 800),
            }
            // check the new site's site.json items match the template build items
            try {
              const parsed = JSON.parse(matched.bodyText)
              const newSiteName =
                parsed && parsed.data && parsed.data.metadata && parsed.data.metadata.site
                  ? parsed.data.metadata.site.name
                  : null
              if (newSiteName) {
                const newSiteDir = path.join(
                  runtime.runtimeRoot,
                  SITES_DIR,
                  newSiteName,
                )
                const siteJsonPath = path.join(newSiteDir, 'site.json')
                evidence.newFromTemplateName = newSiteName
                evidence.newFromTemplateSiteJsonExists = fs.pathExistsSync(siteJsonPath)
                if (fs.pathExistsSync(siteJsonPath)) {
                  const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
                  evidence.newFromTemplateItemTitles = (siteJson.items || []).map(
                    (it) => it && it.title,
                  )
                  evidence.newFromTemplateItemCount = (siteJson.items || []).length
                }
                // relocate if needed (module-const path workaround)
                const relocatedFromTemplate = relocateCreatedSite(runtime, newSiteName)
                evidence.newFromTemplateRelocated = relocatedFromTemplate
              }
            } catch (e) {
              console.log('parse create-from-template body failed:', e.message)
            }
          }
        }
      }
    } else {
      console.log('template card index not found; skipping create-from-template UI flow')
    }

    // ---------- PHASE C: clone-site ----------
    section('PHASE C: reload + more-vert Copy -> clone')
    await reloadDashboard(page, null)
    await new Promise((r) => setTimeout(r, 2000))
    const cardC = await findSiteCard(page, FIXED_SITE_NAME)
    if (!cardC) {
      console.log('original card not found after reload; cannot test clone')
    } else {
      const menuC = await openMoreVertAndDumpMenu(page, cardC)
      logJSON('MORE-VERT MENU (clone phase)', menuC)
      // close menu then click Copy
      await cardC.evaluate((el) => {
        const m = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
        if (m && typeof m.close === 'function') m.close()
      })
      await new Promise((r) => setTimeout(r, 300))
      const copyClick = await clickMenuItemByLabel(page, cardC, 'Copy')
      logJSON('COPY MENU CLICK', copyClick)
      await new Promise((r) => setTimeout(r, 1500))
      const copyModal = await waitFor(
        async () => {
          const d = await dumpConfirmationModal(page)
          if (d && d.modalFound) return d
          return false
        },
        12000,
      )
      logJSON('COPY CONFIRM MODAL', copyModal)
      evidence.copyModal = copyModal
      if (copyModal && copyModal.modalFound) {
        const confirmClick = await clickConfirmButton(page)
        logJSON('COPY CONFIRM CLICK', confirmClick)
        let cloneResp = null
        try {
          cloneResp = await collector.awaitCollectorFor('/clone', 30000)
        } catch (e) {
          console.log('clone response NOT captured:', e.message)
        }
        if (cloneResp) {
          logJSON('CLONE RESPONSE', {
            url: cloneResp.url,
            status: cloneResp.status,
            bodyFirst500: cloneResp.bodyText.substring(0, 500),
          })
          evidence.cloneResponse = {
            url: cloneResp.url,
            status: cloneResp.status,
            body: cloneResp.bodyText.substring(0, 800),
          }
          try {
            const parsed = JSON.parse(cloneResp.bodyText)
            const cloneName = parsed && parsed.data && parsed.data.name
            evidence.cloneName = cloneName
            if (cloneName) {
              const cloneDir = path.join(runtime.runtimeRoot, SITES_DIR, cloneName)
              evidence.cloneDirExists = fs.pathExistsSync(cloneDir)
              // check the clone's site.json exists + items
              const cloneSiteJson = path.join(cloneDir, 'site.json')
              if (fs.pathExistsSync(cloneSiteJson)) {
                const sj = JSON.parse(fs.readFileSync(cloneSiteJson, 'utf8'))
                evidence.cloneSiteName = sj.metadata && sj.metadata.site && sj.metadata.site.name
                evidence.cloneItemCount = (sj.items || []).length
                // check files/ path rewrite: look for the clone name in any item metadata.files path
                let filesRewritten = false
                for (let i = 0; i < (sj.items || []).length; i++) {
                  const it = sj.items[i]
                  const files = it && it.metadata && it.metadata.files
                  if (Array.isArray(files)) {
                    for (let j = 0; j < files.length; j++) {
                      const p = files[j] && (files[j].path || files[j].fullUrl)
                      if (typeof p === 'string' && p.indexOf(cloneName) !== -1) {
                        filesRewritten = true
                      }
                    }
                  }
                }
                evidence.cloneFilesRewritten = filesRewritten
              }
            }
          } catch (e) {
            console.log('parse clone body failed:', e.message)
          }
        }
      } else {
        // escalate: call copySite() directly
        console.log('copy confirm modal not seen; calling copySite() directly')
        const direct = await cardC.evaluate((el) => {
          if (typeof el.copySite === 'function') {
            el.copySite()
            return { called: true }
          }
          return { called: false }
        })
        logJSON('COPY DIRECT CALL', direct)
        await new Promise((r) => setTimeout(r, 1500))
        const copyModal2 = await dumpConfirmationModal(page)
        if (copyModal2 && copyModal2.modalFound) {
          await clickConfirmButton(page)
          let cloneResp = null
          try {
            cloneResp = await collector.awaitCollectorFor('/clone', 30000)
          } catch (e) {
            console.log('clone response NOT captured (direct):', e.message)
          }
          if (cloneResp) {
            logJSON('CLONE RESPONSE (direct)', {
              status: cloneResp.status,
              bodyFirst400: cloneResp.bodyText.substring(0, 400),
            })
            evidence.cloneResponse = {
              status: cloneResp.status,
              body: cloneResp.bodyText.substring(0, 800),
            }
            try {
              const parsed = JSON.parse(cloneResp.bodyText)
              evidence.cloneName = parsed && parsed.data && parsed.data.name
            } catch (e) {
              /* ignore */
            }
          }
        }
      }
      if (cardC) {
        try {
          await cardC.dispose()
        } catch (e) {
          /* ignore */
        }
      }
    }

    // ---------- PHASE D: restore-site ----------
    section('PHASE D: archive + restore (filesystem)')
    await reloadDashboard(page, null)
    await new Promise((r) => setTimeout(r, 2000))
    const cardD = await findSiteCard(page, FIXED_SITE_NAME)
    if (!cardD) {
      console.log('card not found for archive phase; skipping restore discovery')
    } else {
      // archive via more-vert -> Archive -> confirm
      const menuD = await openMoreVertAndDumpMenu(page, cardD)
      logJSON('MORE-VERT MENU (archive phase)', menuD)
      await cardD.evaluate((el) => {
        const m = el.shadowRoot && el.shadowRoot.querySelector('simple-context-menu')
        if (m && typeof m.close === 'function') m.close()
      })
      await new Promise((r) => setTimeout(r, 300))
      const archiveClick = await clickMenuItemByLabel(page, cardD, 'Archive')
      logJSON('ARCHIVE MENU CLICK', archiveClick)
      await new Promise((r) => setTimeout(r, 1500))
      const archiveModal = await waitFor(
        async () => {
          const d = await dumpConfirmationModal(page)
          if (d && d.modalFound) return d
          return false
        },
        12000,
      )
      logJSON('ARCHIVE CONFIRM MODAL', archiveModal)
      if (archiveModal && archiveModal.modalFound) {
        await clickConfirmButton(page)
        let archiveResp = null
        try {
          archiveResp = await collector.awaitCollectorFor('/archive', 25000)
        } catch (e) {
          console.log('archive response NOT captured:', e.message)
        }
        if (archiveResp) {
          logJSON('ARCHIVE RESPONSE', {
            status: archiveResp.status,
            bodyFirst400: archiveResp.bodyText.substring(0, 400),
          })
          evidence.archiveResponse = {
            status: archiveResp.status,
            body: archiveResp.bodyText.substring(0, 600),
          }
          try {
            const parsed = JSON.parse(archiveResp.bodyText)
            evidence.archivedName =
              parsed && parsed.data && (parsed.data.archivedName || parsed.data.name)
          } catch (e) {
            /* ignore */
          }
        }
      }
      // wait for card to disappear
      await new Promise((r) => setTimeout(r, 2000))
      const gone = await waitForCardGone(page, FIXED_SITE_NAME)
      logJSON('CARD GONE AFTER ARCHIVE', gone)

      // check the archived dir on disk
      const archivedName = evidence.archivedName || EXPECTED_SITE_NAME
      const archivedPath = path.join(runtime.runtimeRoot, ARCHIVE_DIR, archivedName)
      const sitesPath = path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME)
      evidence.archivedPath = archivedPath
      evidence.archivedPathExists = fs.pathExistsSync(archivedPath)
      evidence.sitesPathGone = !fs.pathExistsSync(sitesPath)
      logJSON('ARCHIVE FS CHECK', {
        archivedPath,
        archivedPathExists: evidence.archivedPathExists,
        sitesPathGone: evidence.sitesPathGone,
      })

      // RESTORE: move the dir back from _archived to _sites (no restore UI)
      if (fs.pathExistsSync(archivedPath)) {
        const restoreTarget = path.join(runtime.runtimeRoot, SITES_DIR, archivedName)
        fs.moveSync(archivedPath, restoreTarget, { overwrite: true })
        evidence.restoredToPath = restoreTarget
        evidence.restoredPathExists = fs.pathExistsSync(restoreTarget)
        logJSON('RESTORE FS MOVE', {
          restoreTarget,
          restoredPathExists: evidence.restoredPathExists,
        })

        // reload + verify card reappears
        await reloadDashboard(page, null)
        await new Promise((r) => setTimeout(r, 2500))
        const restoredCard = await findSiteCard(page, archivedName)
        logJSON('RESTORED CARD FOUND', !!restoredCard)
        evidence.restoredCardFound = !!restoredCard
        if (restoredCard) {
          try {
            await restoredCard.dispose()
          } catch (e) {
            /* ignore */
          }
        }
      }
      if (cardD) {
        try {
          await cardD.dispose()
        } catch (e) {
          /* ignore */
        }
      }
    }

    section('DISCOVERY-LIFECYCLE: SUMMARY')
    console.log('Evidence keys: ' + Object.keys(evidence).join(', '))
    logJSON('EVIDENCE', evidence)
  } catch (err) {
    console.error('DISCOVERY-LIFECYCLE FAILED:', err && err.stack ? err.stack : err)
    try {
      const dump = await page.evaluate(() => document.body.innerHTML.substring(0, 1500))
      console.error('PAGE BODY SNIPPET:', dump)
    } catch (e) {
      /* ignore */
    }
  } finally {
    try {
      if (collector) collector.detach()
    } catch (e) {
      /* ignore */
    }
    try {
      if (browser) await browser.close()
    } catch (e) {
      /* ignore */
    }
    try {
      await teardownE2ERuntime(runtime)
    } catch (e) {
      /* ignore */
    }
    console.log('\nTeardown complete.')
  }
}

main().catch((err) => {
  console.error('DISCOVERY-LIFECYCLE TOP-LEVEL FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
