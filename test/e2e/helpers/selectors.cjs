'use strict'

// Centralised selector map for the app-hax dashboard UI.
// Populated from source analysis of the built app-hax components under
// src/public/build/es6/node_modules/@haxtheweb/app-hax/ and refined by the
// runtime discovery pass (test/e2e/helpers/.discovery.cjs).
//
// SELECTORS ARE SHADOW-DOM SCOPED. Most app-hax elements render their controls
// inside shadow DOM. Tests must pierce shadow roots with page.$() /
// page.evaluate() that calls el.shadowRoot.querySelector(...). The helper
// `deepQuery(page, selectorChain)` in this file walks a chain of shadow roots.
//
// VERIFICATION STATUS (from discovery pass):
// - LOGIN: VERIFIED at runtime (simple-modal > app-hax-site-login, #username,
//   Next button, #password, Login button, login API {status:200, jwt}).
// - DASHBOARD: VERIFIED at runtime (app-hax > app-hax-use-case-filter >
//   #returnToSection > app-hax-search-results, #create-site-heading,
//   app-hax-site-creation-modal with #siteName + Create Site button).
// - CREATE SITE: VERIFIED at runtime (modal exists with #siteName.form-input,
//   .button.button-primary text="Create Site", .button.button-secondary text="Cancel").
//   The entry-point trigger (clicking app-hax-use-case to open the modal) is
//   documented from source but NOT exercised in the discovery pass.
// - ARCHIVE: UNVERIFIED at runtime (site list was empty in fresh runtime, so
//   app-hax-site-bar cards did not render). Selectors below are from source
//   analysis of app-hax-site-bar.js. Task agents MUST verify against a live
//   site card before relying on them.

// The fixed site name used by every E2E site operation. Each run boots an
// isolated temp runtime so this name never collides with real work.
const FIXED_SITE_NAME = 'HAXSITEAUTOMATEDTESTING'

// Walk a chain of [shadowRoot]querySelector calls to pierce shadow DOM.
// selectorChain: array of strings, each applied to the current root's
// shadowRoot (or the document for the first element).
// Returns the element handle or null.
async function deepQuery(page, selectorChain) {
  if (!Array.isArray(selectorChain) || selectorChain.length === 0) {
    return null
  }
  const handle = await page.evaluateHandle((chain) => {
    let root = document
    for (let i = 0; i < chain.length; i++) {
      const sel = chain[i]
      let el = null
      if (i === 0) {
        el = root.querySelector(sel)
      } else {
        if (!root || !root.shadowRoot) {
          return null
        }
        el = root.shadowRoot.querySelector(sel)
      }
      if (!el) {
        return null
      }
      root = el
    }
    return root
  }, selectorChain)
  const element = handle.asElement()
  if (!element) {
    await handle.dispose()
    return null
  }
  return element
}

// Query all matches across a shadow-DOM chain (last selector is the "all" one).
async function deepQueryAll(page, selectorChain) {
  if (!Array.isArray(selectorChain) || selectorChain.length === 0) {
    return []
  }
  const handles = await page.evaluateHandle((chain) => {
    let root = document
    for (let i = 0; i < chain.length - 1; i++) {
      const sel = chain[i]
      let el = null
      if (i === 0) {
        el = root.querySelector(sel)
      } else {
        if (!root || !root.shadowRoot) {
          return []
        }
        el = root.shadowRoot.querySelector(sel)
      }
      if (!el) {
        return []
      }
      root = el
    }
    if (!root || !root.shadowRoot) {
      // last selector may be on document or a shadowRoot depending on chain length
      if (chain.length === 1) {
        return Array.prototype.slice.call(root.querySelectorAll(chain[0]))
      }
      return []
    }
    const lastRoot = chain.length === 1 ? root : root.shadowRoot
    return Array.prototype.slice.call(lastRoot.querySelectorAll(chain[chain.length - 1]))
  }, selectorChain)
  const props = await handles.getProperties()
  const elements = []
  for (const key of Object.keys(props)) {
    const el = props[key]
    if (el && typeof el.asElement === 'function') {
      const element = el.asElement()
      if (element) {
        elements.push(element)
      }
    }
  }
  await handles.dispose()
  return elements
}

const selectors = {
  // --- LOGIN (VERIFIED at runtime) ---------------------------------------
  // Confirmed by discovery: document > simple-modal[opened] > app-hax-site-login
  // (shadowRoot) contains rpg-character, p#errorText, input#username, then after
  // clicking "Next" shows input#password + "Login" button.
  // Login API: POST /system/api/v1/session/login -> {status:200, jwt:"..."}.
  login: {
    // The host app element on the page.
    appHax: 'app-hax',
    // The login custom element (slotted into simple-modal content).
    siteLogin: 'app-hax-site-login',
    // The modal that wraps the login element.
    loginModal: 'simple-modal',
    // Shadow-DOM chain to the login host element: document -> simple-modal -> app-hax-site-login
    siteLoginChain: ['simple-modal', 'app-hax-site-login'],
    // Input fields inside app-hax-site-login shadowRoot.
    // VERIFIED: input#username type=text placeholder="Enter your username" aria-label="Username"
    usernameInput: '#username',
    // VERIFIED: input#password type=password placeholder="Enter your password" aria-label="Password"
    // (only present AFTER clicking Next)
    passwordInput: '#password',
    // Buttons inside app-hax-site-login shadowRoot. The form is two-step:
    // step 1 shows the "Next" button, step 2 shows the "Login" button.
    // VERIFIED: button text="Next" (step 1), button text="Login" (step 2).
    nextButton: 'button', // text "Next" — disambiguate by text content
    loginButton: 'button', // text "Login" — disambiguate by text content
    // Full shadow-DOM chains (document -> simple-modal -> app-hax-site-login -> field)
    // VERIFIED at runtime.
    usernameInputChain: ['simple-modal', 'app-hax-site-login', '#username'],
    passwordInputChain: ['simple-modal', 'app-hax-site-login', '#password'],
    // Error text element inside the login shadowRoot.
    // VERIFIED: p#errorText text="Enter User name" (initial)
    errorText: '#errorText',
    // Global event fired on successful login (detail: true).
    loggedInEvent: 'jwt-logged-in',
    // Global event fired to attempt login (detail: { username, password }).
    loginAttemptEvent: 'jwt-login-login',
  },

  // --- DASHBOARD (VERIFIED at runtime) ------------------------------------
  // Confirmed by discovery: document > app-hax (shadowRoot) > app-hax-use-case-filter
  // (shadowRoot) contains #returnToSection > app-hax-search-results,
  // #create-site-heading (text "Create New Site"), app-hax-site-creation-modal,
  // and 43 app-hax-use-case cards.
  // sites API: GET /system/api/v1/sites -> {status:200, data:{items:[...]}}.
  dashboard: {
    // Shadow-DOM chain to the use-case-filter host: document -> app-hax -> app-hax-use-case-filter
    // VERIFIED at runtime.
    useCaseFilterChain: ['app-hax', 'app-hax-use-case-filter'],
    // The "Return to..." section containing the site list.
    // VERIFIED: section#returnToSection.returnTo[aria-labelledby="return-to-heading"]
    returnToSection: '#returnToSection',
    // The search-results host element that renders site cards.
    // VERIFIED: app-hax-search-results inside #returnToSection.
    searchResults: 'app-hax-search-results',
    // Full chain to the site-list container.
    siteListChain: [
      'app-hax',
      'app-hax-use-case-filter',
      '#returnToSection',
      'app-hax-search-results',
    ],
    // Individual site card element (rendered by app-hax-search-results).
    // UNVERIFIED at runtime — site list was empty in fresh runtime so no
    // app-hax-site-bar cards rendered. app-hax-site-bar is the card component
    // per source (app-hax-site-bar.js). Task agents should verify after creating
    // a site.
    siteCard: 'app-hax-site-bar',
    // The heading slot inside a site card.
    siteCardHeadingSlot: 'slot[name="heading"]',
  },

  // --- CREATE SITE (modal VERIFIED, trigger UNVERIFIED) ------------------
  // Confirmed by discovery: app-hax-site-creation-modal exists in use-case-filter
  // shadowDOM with open=false. Its shadowRoot contains web-dialog,
  // button.close-button, input#siteName.form-input, button.button.button-primary
  // (text "Create Site"), button.button.button-secondary (text "Cancel").
  // The modal uses web-dialog (NOT simple-modal). To OPEN the modal, the
  // discovery pass did NOT click a use-case card.
  create: {
    // The create-site modal host element.
    // VERIFIED: app-hax-site-creation-modal in use-case-filter shadowDOM.
    siteCreationModal: 'app-hax-site-creation-modal',
    // Shadow-DOM chain to the modal: document -> app-hax -> app-hax-use-case-filter -> app-hax-site-creation-modal
    // VERIFIED at runtime.
    siteCreationModalChain: [
      'app-hax',
      'app-hax-use-case-filter',
      'app-hax-site-creation-modal',
    ],
    // The site name input inside the modal shadowRoot.
    // VERIFIED: input#siteName.form-input type=text placeholder="Enter your site name..."
    siteNameInput: '#siteName',
    // Full chain to the site name input.
    siteNameInputChain: [
      'app-hax',
      'app-hax-use-case-filter',
      'app-hax-site-creation-modal',
      '#siteName',
    ],
    // "Create Site" button (class .button.button-primary) inside modal shadowRoot.
    // VERIFIED: button.button.button-primary text="Create Site" (with simple-icon-lite icons:add-circle)
    createSiteButton: '.button.button-primary',
    // VERIFIED at runtime.
    createSiteButtonChain: [
      'app-hax',
      'app-hax-use-case-filter',
      'app-hax-site-creation-modal',
      '.button.button-primary',
    ],
    // "Cancel" button (class .button.button-secondary).
    // VERIFIED: button.button.button-secondary text="Cancel"
    cancelButton: '.button.button-secondary',
    // The use-case cards that trigger the create flow. Clicking one with
    // showContinue fires `continue-action`.
    // UNVERIFIED at runtime — discovery did not click a card. Per source
    // (app-hax-use-case-filter.js continueAction()), the blank-site path is
    // index -1. Task agents should trigger the modal by calling
    // continueAction(-1) on the use-case-filter element handle, OR by clicking
    // an app-hax-use-case card's continue button.
    useCaseCard: 'app-hax-use-case',
    // The "Create New Site" section heading (id create-site-heading).
    // VERIFIED: h2#create-site-heading text="Create New Site"
    createSiteHeading: '#create-site-heading',
    // Entry point: to open the create modal programmatically, call
    // continueAction(-1) on the use-case-filter element, OR set
    // store.createSiteSteps = true. See app-hax-use-case-filter.js
    // continueAction().
  },

  // --- ARCHIVE SITE (UNVERIFIED at runtime — source-only) -----------------
  // Archive flow (from app-hax-site-bar.js source): on a site card
  // (app-hax-site-bar), click the "more options" button
  // (simple-icon-button-lite with icon lrn:more-vert), which opens a
  // simple-context-menu. Click the "Archive" simple-toolbar-button, which calls
  // siteOperation("archiveSite",...) creating an `app-hax-confirmation-modal`
  // (appended to document.body) with .button-confirm ("Confirm") and
  // .button-cancel ("Cancel") buttons. Clicking Confirm calls confirmOperation()
  // which calls the archive API.
  //
  // ALL SELECTORS BELOW ARE UNVERIFIED — the discovery pass had an empty site
  // list so no app-hax-site-bar cards rendered. Task agents MUST verify these
  // against a live site card (create a site first, then re-query).
  archive: {
    // The more-options trigger button on a site card (inside app-hax-site-bar shadowRoot).
    // UNVERIFIED — the moreOptionsId is dynamic (`moreOptions-${n}`); select by
    // icon attribute instead. Per source: simple-icon-button-lite icon="lrn:more-vert"
    moreOptionsButton: 'simple-icon-button-lite[icon="lrn:more-vert"]',
    // The context menu that opens.
    // UNVERIFIED — per source: simple-context-menu title="Options"
    contextMenu: 'simple-context-menu',
    // The archive menu item (simple-toolbar-button with label "Archive").
    // UNVERIFIED — per source: simple-toolbar-button label="Archive" icon="archive".
    // Select by label text "Archive" (there are multiple simple-toolbar-button siblings).
    archiveMenuItem: 'simple-toolbar-button',
    // The confirmation modal that appears after clicking Archive.
    // UNVERIFIED — per source: app-hax-confirmation-modal appended to document.body.
    confirmationModal: 'app-hax-confirmation-modal',
    // Confirm button inside confirmation modal shadowRoot.
    // UNVERIFIED — per source (app-hax-confirmation-modal.js): button.button.button-confirm
    confirmButton: '.button.button-confirm',
    // Cancel button inside confirmation modal shadowRoot.
    // UNVERIFIED — per source: button.button.button-cancel (autofocus)
    cancelButton: '.button.button-cancel',
    // Full chain to confirm button (confirmation modal is appended to document.body).
    // UNVERIFIED — document > app-hax-confirmation-modal (shadowRoot) > .button.button-confirm
    confirmButtonChain: ['app-hax-confirmation-modal', '.button.button-confirm'],
    cancelButtonChain: ['app-hax-confirmation-modal', '.button.button-cancel'],
  },

  // --- SITE EDITOR (VERIFIED at runtime by .discovery-editor.cjs) ---------
  // The site editor is reached by navigating to the site URL
  // (runtime.baseUrl + '/_sites/haxsiteautomatedtesting/'). The editor chrome
  // is `haxcms-site-editor-ui` at document root (has shadowRoot). The content
  // body lives inside `haxcms-site-editor` (NO shadowRoot — createRenderRoot
  // returns this) which renders `<h-a-x id="hax">` in light DOM; h-a-x has a
  // shadowRoot containing `<hax-body>` (the content-editable region).
  //
  // The #editbutton toggles edit mode: label="Edit" icon="icons:create" when
  // viewing, label="Save" icon="icons:save" when editing. Clicking it in edit
  // mode fires the global `haxcms-save-node` event which the site-editor
  // handles by calling @site/updateContentByIdOrSlug
  // (PATCH /x/api/v1/content/:idOrSlug).
  editor: {
    // The editor chrome host element at document root.
    // VERIFIED: document > haxcms-site-editor-ui (shadowRoot)
    editorUi: 'haxcms-site-editor-ui',
    // The edit/save toggle button inside editor-ui shadowRoot.
    // VERIFIED: simple-toolbar-button#editbutton, label="Edit • Ctrl⇧E" → "Save • Ctrl⇧S"
    editButton: '#editbutton',
    // The cancel button (exits edit mode without saving).
    // VERIFIED: simple-toolbar-button#cancelbutton, label="Cancel • Ctrl⇧/"
    cancelButton: '#cancelbutton',
    // The outline-editor opener button (disabled while in edit mode).
    // VERIFIED: simple-toolbar-button#outlinebutton, label="Outline • Ctrl⇧2", icon="hax:site-map"
    outlineButton: '#outlinebutton',
    // The add-page button (opens a super-daemon menu; disabled in edit mode).
    // VERIFIED: haxcms-button-add#addpagebutton, label="Add page • Ctrl⇧1", icon="hax:add-page"
    addPageButton: '#addpagebutton',
    // The site-settings button (disabled in edit mode).
    // VERIFIED: simple-toolbar-button#manifestbtn, label="Site Settings • Ctrl⇧3"
    manifestButton: '#manifestbtn',
    // The editor host element (renders inside the active theme).
    // VERIFIED: haxcms-site-editor found via recursive shadow-DOM walk; it has
    // NO shadowRoot (createRenderRoot returns this). Its parent is a <section>.
    // Tests must locate it with a recursive walk (see deepFindRecursive pattern
    // in .discovery-editor.cjs) — deepQuery cannot reach it because it is
    // nested inside theme shadow DOM at an unknown depth.
    editorHost: 'haxcms-site-editor',
    // The HAX editor instance (light DOM child of haxcms-site-editor).
    // VERIFIED: h-a-x#hax inside haxcms-site-editor; has shadowRoot.
    haxInstance: '#hax',
    // The content-editable body inside #hax shadowRoot.
    // VERIFIED: hax-body inside h-a-x#hax shadowRoot. contenteditable=true in
    // edit mode. Has importContent(htmlString) method to load HTML content.
    // To type: call body.importContent(html) then dispatch 'input' event.
    contentBody: 'hax-body',
    // Full chain to the content body. NOTE: haxcms-site-editor is NOT at a
    // fixed shadow-DOM depth (it renders inside the active theme). Tests must
    // use a recursive shadow walk to find haxcms-site-editor, then traverse
    // light DOM to #hax, then shadowRoot to hax-body. This chain is NOT
    // usable with deepQuery directly — it is documented for reference.
    // UNVERIFIED as a deepQuery chain — use recursive walk instead.
    contentBodyChain: ['haxcms-site-editor', '#hax', 'hax-body'],
    // Global event fired to save the active page (site-editor listens).
    // VERIFIED from source (haxcms-site-editor.js connectedCallback).
    saveNodeEvent: 'haxcms-save-node',
    // Global event fired to create a new page (site-editor listens).
    // VERIFIED from source + runtime: dispatching this event with
    // detail.values = {node:{title,location,contents}, order, parent} triggers
    // POST /x/api/v1/items (createNode).
    createNodeEvent: 'haxcms-create-node',
    // Global event fired to delete a page (site-editor listens).
    // VERIFIED from source + runtime: dispatching this event with
    // detail.item = {id} triggers DELETE /x/api/v1/items/:idOrSlug (deleteNode).
    deleteNodeEvent: 'haxcms-delete-node',
  },

  // --- EXPORT / DOWNLOAD SITE (VERIFIED menu, UNVERIFIED confirm modal) ---
  // The export (download) flow reuses the more-vert menu on a site card
  // (app-hax-site-bar). The menu items are: Copy, Download, Create Template,
  // Archive (and conditionally User Access). Clicking "Download" calls
  // downloadSite() which calls siteOperation("downloadSite",...) — this
  // creates an app-hax-confirmation-modal on document.body (same pattern as
  // archive). Clicking Confirm calls confirmOperation() which calls the
  // download API and triggers a browser file download via an <a> click.
  //
  // MENU ITEMS + DOWNLOAD LABEL: VERIFIED at runtime.
  // CONFIRMATION MODAL: UNVERIFIED at runtime — in the discovery pass the
  // app-hax-confirmation-modal did not appear on document.body after clicking
  // Download. This is likely the same store-manifest timing issue documented
  // in the archive flow (siteOperation looks up the site in store.manifest.items
  // by siteId). Task agents should reuse the archive test's fallback pattern:
  // if the confirmation modal does not appear after clicking the Download menu
  // item, call cardHandle.evaluate((el) => el.downloadSite()) directly, or
  // call cardHandle.evaluate((el) => el.siteOperation("downloadSite","Download","file-download")) directly.
  export: {
    // The more-options trigger button on a site card (same as archive).
    // VERIFIED: simple-icon-button-lite[icon="lrn:more-vert"] in app-hax-site-bar shadowRoot.
    moreOptionsButton: 'simple-icon-button-lite[icon="lrn:more-vert"]',
    // The context menu that opens.
    // VERIFIED: simple-context-menu title="Options" in app-hax-site-bar shadowRoot.
    contextMenu: 'simple-context-menu',
    // ALL menu items in the more-vert context menu (in order).
    // VERIFIED at runtime: Copy, Download, Create Template, Archive.
    // (User Access appears only if AppHaxAPI.supportsCall("haxiamAddUserAccess")).
    menuItems: {
      copy: 'Copy',
      download: 'Download',
      createTemplate: 'Create Template',
      archive: 'Archive',
      userAccess: 'User Access',
    },
    // The download menu item (simple-toolbar-button label="Download").
    // VERIFIED: simple-toolbar-button label="Download" icon="file-download".
    // Select by label text "Download" among simple-toolbar-button siblings.
    downloadMenuItem: 'simple-toolbar-button',
    // The confirmation modal (same component as archive).
    // UNVERIFIED for download — see note above. Same as archive confirmation modal.
    confirmationModal: 'app-hax-confirmation-modal',
    confirmButton: '.button.button-confirm',
    cancelButton: '.button.button-cancel',
    confirmButtonChain: ['app-hax-confirmation-modal', '.button.button-confirm'],
    cancelButtonChain: ['app-hax-confirmation-modal', '.button.button-cancel'],
    // The card method to call directly if the menu click doesn't open the modal.
    // UNVERIFIED at runtime (fallback) — call via cardHandle.evaluate((el) => el.downloadSite())
    downloadSiteMethod: 'downloadSite',
  },

  // --- OUTLINE EDITOR (VERIFIED at runtime by .discovery-editor.cjs) -------
  // The outline editor (page management) is opened by clicking #outlinebutton
  // in the editor chrome (haxcms-site-editor-ui shadowRoot). It opens a
  // simple-modal containing haxcms-outline-editor-dialog as a light-DOM
  // (slotted) child. The dialog shadowRoot contains outline-designer#outline
  // and two .hax-modal-btn buttons ("Save Outline" and "Import From File").
  // The outline-designer has its own shadowRoot with an "Add page"
  // simple-toolbar-button.
  //
  // Adding a page via the outline-designer fires haxcms-save-outline with the
  // updated items array, which the site-editor handles by calling
  // @site/updateSiteOutline (PATCH /x/api/v1/site/outline). Individual
  // createNode/deleteNode can also be triggered directly via the
  // haxcms-create-node / haxcms-delete-node global events (see selectors.editor).
  outline: {
    // The outline editor dialog host element (slotted into simple-modal).
    // VERIFIED: haxcms-outline-editor-dialog is a light-DOM child of simple-modal
    // (NOT in simple-modal's shadowRoot — same pattern as login).
    // To reach it: document.querySelector('simple-modal').querySelector('haxcms-outline-editor-dialog')
    outlineDialog: 'haxcms-outline-editor-dialog',
    // The outline-designer element inside the dialog shadowRoot.
    // VERIFIED: outline-designer#outline inside haxcms-outline-editor-dialog shadowRoot.
    outlineDesigner: '#outline',
    // The "Save Outline" button inside the dialog shadowRoot.
    // VERIFIED: button.hax-modal-btn text="Save Outline"
    saveOutlineButton: '.hax-modal-btn',
    // The "Import From File" button inside the dialog shadowRoot.
    // VERIFIED: button.hax-modal-btn.import text="Import From File"
    importButton: '.hax-modal-btn.import',
    // The "Add page" button inside outline-designer shadowRoot.
    // VERIFIED: simple-toolbar-button label="Add page" found via recursive
    // shadow search inside outline-designer. No fixed id — select by label text.
    addPageButton: 'simple-toolbar-button',
    // Global event fired by the dialog when Save Outline is clicked.
    // VERIFIED from source (haxcms-outline-editor-dialog.js _saveTap):
    // dispatches haxcms-save-outline with detail = items array.
    saveOutlineEvent: 'haxcms-save-outline',
    // The outline dialog is in simple-modal light DOM, so deepQuery cannot
    // reach it (same as login). Use: document.querySelector('simple-modal').querySelector('haxcms-outline-editor-dialog')
    // then operate on its shadowRoot.
    // VERIFIED at runtime: dialog.shadowRoot.querySelector('#outline') + '.hax-modal-btn'

    // --- outline-designer row detail controls (VERIFIED by .discovery-outline.cjs) ---
    // Each page in the outline is a <li class="item indent-N" data-item-id="...">
    // inside outline-designer shadowRoot. Rows have leading-operations, a
    // content-toggle-btn, a .label.shown (title display) + .label-edit
    // (contenteditable title input), and a simple-context-menu.actions-menu
    // with 10 simple-toolbar-button[value=...] action items.
    //
    // The actions menu is opened by clicking .actions-menu-button
    // (simple-toolbar-button icon="icons:more-vert"). Each menu item is a
    // simple-toolbar-button with a `value` attribute identifying the operation.
    // The outline-designer.itemOp(index, op) method applies the change in-memory;
    // clicking "Save Outline" (.hax-modal-btn) then dispatches
    // haxcms-save-outline with the full items array → PATCH /x/api/v1/site/outline.
    //
    // To rename: click the edit-title menu item (value="edit-title") which calls
    // outline-designer.editTitle() on the row's .label.shown, making .label-edit
    // contenteditable. Type the new title + Enter (monitorTitle handler) to
    // commit the change in-memory. Then click Save Outline to persist.
    //
    // To reorder/nest: click the up/down/in/out menu items which call
    // outline-designer.itemOp(index, op) to swap orders or change parent+indent.
    // Then click Save Outline to persist.

    // Row selector inside outline-designer shadowRoot.
    // VERIFIED: li.item with data-item-id attribute; role="treeitem".
    row: 'li.item',
    // The data attribute holding the page id on each row.
    // VERIFIED: data-item-id="item-<uuid>"
    rowItemIdAttr: 'data-item-id',
    // The title display span (visible when not editing).
    // VERIFIED: span.label.shown with the page title textContent.
    rowLabel: '.label.shown',
    // The contenteditable title edit span (visible when editing title).
    // VERIFIED: span.label-edit; gets contenteditable="true" on editTitle().
    rowLabelEdit: '.label-edit',
    // The more-vert actions menu trigger button per row.
    // VERIFIED: simple-toolbar-button.actions-menu-button icon="icons:more-vert".
    rowActionsMenuButton: '.actions-menu-button',
    // The actions context menu per row.
    // VERIFIED: simple-context-menu.actions-menu with 10 simple-toolbar-button children.
    rowActionsMenu: 'simple-context-menu.actions-menu',
    // Action menu item values (simple-toolbar-button[value=...]).
    // VERIFIED at runtime: up, down, in, out, edit-title, add, duplicate, goto, lock, delete.
    actionValues: {
      moveUp: 'up',
      moveDown: 'down',
      indent: 'in',
      outdent: 'out',
      editTitle: 'edit-title',
      add: 'add',
      duplicate: 'duplicate',
      goToPage: 'goto',
      lock: 'lock',
      delete: 'delete',
    },
    // The top-level "Add page" control button (in .controls toolbar).
    // VERIFIED: simple-toolbar-button[icon="add"] label="Add page".
    addPageControlButton: 'simple-toolbar-button[icon="add"]',
    // Event dispatched by Import From File (.hax-modal-btn.import) — triggers
    // _selectFileForHierarchyImport on the site-editor-ui which opens a file
    // picker. For E2E, dispatching haxcms-docx-import-items with test items
    // simulates the post-file-pick result (opens the import hierarchy dialog).
    // VERIFIED from source (haxcms-outline-editor-dialog.js _importTap +
    // haxcms-site-editor-ui.js __winEvents mapping).
    importRequestEvent: 'haxcms-outline-import-request',
    // Event that opens the import hierarchy dialog with pre-parsed items.
    // VERIFIED from source (haxcms-site-editor.js createNode handler dispatches
    // haxcms-docx-import-items with {items, parentId} after a successful import API call).
    importItemsEvent: 'haxcms-docx-import-items',
  },

  // --- AUTH-DASHBOARD (VERIFIED at runtime by .discovery-auth-dashboard.cjs) ---
  // User menu + logout control, dashboard search input, and the site card
  // click target (the real dashboard→editor entry point).
  //
  // LOGOUT: document > app-hax (shadow) > app-hax-user-menu (light DOM) >
  //   app-hax-user-menu-button.logout (slotted into post-menu). The menu is
  //   opened by clicking #tbchar (app-hax-user-menu-toggle, slotted into
  //   menuButton). The logout button has an inner button.menu-button in its
  //   shadowRoot; clicking it fires @click=${this.logout} on the host (bubbles).
  //   POST /system/api/v1/session/logout → {status:200, data:"loggedout"}.
  //   After logout: login modal reappears, JWT cleared from localStorage,
  //   haxcms_refresh_token cookie cleared.
  //
  // SEARCH: #searchField input inside app-hax-use-case-filter shadowRoot.
  //   Typing dispatches input → handleSearch → sets store.searchTerm +
  //   applyFilters() which filters displayItems CLIENT-SIDE (no search API
  //   fires). app-hax-search-results.displayItems narrows; a non-matching term
  //   yields 0 app-hax-site-bar cards.
  //
  // SITE CARD CLICK: app-hax-site-bar has a.imageLink in its shadowRoot with
  //   href="/_sites/<slug>/" — clicking it navigates to the site editor.
  authDashboard: {
    // --- logout control ---
    // The user menu host inside app-hax shadowRoot.
    // VERIFIED: app-hax.shadowRoot.querySelector('app-hax-user-menu') (id="user-menu")
    userMenu: 'app-hax-user-menu',
    // The menu toggle button (slotted into menuButton slot).
    // VERIFIED: app-hax-user-menu-toggle#tbchar — click to open the menu.
    userMenuToggle: '#tbchar',
    // The logout button (light-DOM child of app-hax-user-menu, slotted post-menu).
    // VERIFIED: app-hax-user-menu-button.logout, label="Log out", icon="account-circle".
    logoutButton: 'app-hax-user-menu-button.logout',
    // The inner button inside logout button's shadowRoot.
    // VERIFIED: button.menu-button (clicking it bubbles to host → this.logout())
    logoutInnerButton: '.menu-button',
    // Logout API path.
    // VERIFIED: POST /system/api/v1/session/logout → {status:200, data:"loggedout"}
    logoutApi: '/system/api/v1/session/logout',
    // The refresh-token cookie cleared on logout.
    // VERIFIED: haxcms_refresh_token cookie is empty after logout.
    refreshTokenCookie: 'haxcms_refresh_token',

    // --- search input ---
    // The search input inside app-hax-use-case-filter shadowRoot.
    // VERIFIED: input#searchField type=text placeholder="Search" aria-label="Search"
    searchField: '#searchField',
    // Full chain to the search input: document > app-hax > app-hax-use-case-filter > #searchField
    // VERIFIED at runtime.
    searchFieldChain: ['app-hax', 'app-hax-use-case-filter', '#searchField'],

    // --- site card click target ---
    // The image link inside app-hax-site-bar shadowRoot.
    // VERIFIED: a.imageLink href="/_sites/<slug>/" aria-label="Open <title>"
    siteCardImageLink: 'a.imageLink',
    // The heading link (slotted into app-hax-site-bar heading slot).
    // VERIFIED: a[slot="heading"] href="/_sites/<slug>/"
    siteCardHeadingLink: 'a[slot="heading"]',
  },

  // --- REVISIONS (VERIFIED at runtime by .discovery-revisions.cjs) ---------
  // The page revisions UI is a haxcms-page-revisions-dialog element slotted
  // as a light-DOM child of simple-modal (same pattern as login + outline).
  // It is opened by dispatching the global event `haxcms-open-page-revisions`
  // with detail { nodeId, nodeTitle, source }. The site-editor listens for
  // this event and opens the dialog via simple-modal-show.
  //
  // The dialog renders an editable-table-display with revision rows. Each row
  // has two simple-icon-button-lite action buttons: a preview button
  // (data-action="preview", icon="icons:visibility") and a restore button
  // (data-action="restore", icon="icons:restore"). Both carry data-hash="<full
  // git hash>". The FIRST row (current revision) has both buttons disabled.
  //
  // The dialog loads revisions by dispatching `haxcms-load-node-revisions`
  // which the site-editor answers by calling @site/listItemRevisions
  // (GET /x/api/v1/items/:idOrSlug/revisions). Selecting a row dispatches
  // `haxcms-load-node-revision` → @site/getItemRevisionById (GET
  // .../revisions/:revisionId). Restore dispatches `haxcms-restore-node-revision`
  // → @site/restoreItemRevision (POST .../revisions/:revisionId/restore), which
  // writes the old content to disk AND creates a new git commit.
  //
  // Auth: revisions routes require Bearer JWT + X-HAXCMS-Site-Token header
  // (policy 'authenticated-site'). The site token is
  // HAXCMS.getRequestToken(userName + ':' + siteName), computed server-side.
  // The browser frontend auto-attaches it; direct axios calls must add it.
  revisions: {
    // The revisions dialog host element (slotted into simple-modal light DOM).
    // VERIFIED: haxcms-page-revisions-dialog is a light-DOM child of simple-modal.
    // To reach it: document.querySelector('simple-modal').querySelector('haxcms-page-revisions-dialog')
    // then operate on its shadowRoot.
    revisionsDialog: 'haxcms-page-revisions-dialog',
    // Global event to open the revisions dialog.
    // VERIFIED: dispatching haxcms-open-page-revisions with
    // detail { nodeId, nodeTitle, source } opens the dialog.
    openRevisionsEvent: 'haxcms-open-page-revisions',
    // Global event fired by the dialog to request the revisions list.
    // VERIFIED from source (haxcms-page-revisions-dialog.js _loadRevisions).
    loadRevisionsEvent: 'haxcms-load-node-revisions',
    // Global event fired by the dialog to request one revision detail.
    loadRevisionEvent: 'haxcms-load-node-revision',
    // Global event fired by the dialog to request a restore.
    restoreRevisionEvent: 'haxcms-restore-node-revision',
    // Global event fired by the site-editor when revisions list loads.
    revisionsLoadedEvent: 'haxcms-node-revisions-loaded',
    // Global event fired when one revision detail loads.
    revisionLoadedEvent: 'haxcms-node-revision-loaded',
    // Global event fired when a restore completes.
    revisionRestoredEvent: 'haxcms-node-revision-restored',
    // The table row selector inside the dialog shadowRoot.
    // VERIFIED: tbody tr inside editable-table-display.
    revisionRow: 'tbody tr',
    // The restore action button inside a row.
    // VERIFIED: simple-icon-button-lite[icon="icons:restore"][data-action="restore"]
    // with data-hash="<full hash>". Disabled on the first row (current revision).
    restoreButton: 'simple-icon-button-lite[data-action="restore"]',
    // The preview action button inside a row.
    // VERIFIED: simple-icon-button-lite[icon="icons:visibility"][data-action="preview"]
    previewButton: 'simple-icon-button-lite[data-action="preview"]',
    // The preview <pre> element inside the dialog shadowRoot (source mode).
    // VERIFIED: pre element contains the revision content as HTML source text.
    previewPre: 'pre',
    // Dialog properties (read via elementHandle.evaluate):
    //   nodeId (string), nodeTitle (string), revisions (array),
    //   selectedHash (string), loading (bool), restoring (bool),
    //   previewMode ('source' | 'rendered'), previewContent (string).
    // VERIFIED at runtime.
  },

  // --- LIFECYCLE (VERIFIED at runtime by .discovery-lifecycle.cjs) ---------
  // These surfaces reuse the more-vert menu on app-hax-site-bar (Copy, Create
  // Template, Archive) and the use-case-filter skeleton picker. The more-vert
  // menu items are VERIFIED, but clicking the simple-toolbar-button HOST does
  // NOT reliably open the app-hax-confirmation-modal (store-manifest timing
  // issue — same as archive/download). Tests must escalate: call the card
  // method directly (el.copySite(), el.createTemplate(), el.archiveSite()) if
  // the modal does not appear after the host click, then click .button-confirm.
  lifecycle: {
    // The more-options trigger button on a site card (same as archive/export).
    // VERIFIED: simple-icon-button-lite[icon="lrn:more-vert"] in app-hax-site-bar shadowRoot.
    moreOptionsButton: 'simple-icon-button-lite[icon="lrn:more-vert"]',
    // The context menu that opens (same as archive/export).
    // VERIFIED: simple-context-menu title="Options" in app-hax-site-bar shadowRoot.
    contextMenu: 'simple-context-menu',
    // Menu items in the more-vert context menu (VERIFIED labels + icons).
    // Order: Copy (content-copy), Download (file-download), Create Template
    // (icons:add-circle), Archive (archive).
    menuItems: {
      copy: 'Copy',
      createTemplate: 'Create Template',
      archive: 'Archive',
    },
    // Card methods to call directly if the host click does not open the modal.
    // VERIFIED: el.copySite() / el.createTemplate() / el.archiveSite() each
    // create an app-hax-confirmation-modal on document.body.
    copySiteMethod: 'copySite',
    createTemplateMethod: 'createTemplate',
    archiveSiteMethod: 'archiveSite',
    // The confirmation modal appended to document.body (same as archive/export).
    // VERIFIED: app-hax-confirmation-modal on document.body with
    // .button.button-confirm + .button.button-cancel in its shadowRoot.
    confirmationModal: 'app-hax-confirmation-modal',
    confirmButton: '.button.button-confirm',
    cancelButton: '.button.button-cancel',
    confirmButtonChain: ['app-hax-confirmation-modal', '.button.button-confirm'],
    cancelButtonChain: ['app-hax-confirmation-modal', '.button.button-cancel'],
    // Save-template modal button text (VERIFIED):
    //   confirmText = "Save to templates" (.button.button-confirm)
    //   cancelText  = "Download skeleton" (.button.button-cancel)
    //   title       = "Create template from <name>?"
    saveTemplateConfirmText: 'Save to templates',
    saveTemplateCancelText: 'Download skeleton',
    // Clone (Copy) modal button text (VERIFIED):
    //   confirmText = "Confirm" (.button.button-confirm)
    //   cancelText  = "Cancel" (.button.button-cancel)
    //   title       = "Copy <name>?"
    cloneConfirmText: 'Confirm',
    // --- Skeleton picker (create-from-template) ---
    // The use-case card element that renders skeleton/blank/import templates.
    // VERIFIED: app-hax-use-case in app-hax-use-case-filter shadowRoot. Each
    // card has a data-item-index attribute matching its filteredItems index.
    useCaseCard: 'app-hax-use-case',
    // The use-case-filter element (same chain as dashboard.useCaseFilterChain).
    // VERIFIED: continueAction(index) on this element opens the creation modal
    // pre-filled with skeletonData + skeletonMachineName for the skeleton at
    // that filteredItems index. The skeleton card is found by matching
    // machineName in ucf.filteredItems (dataType === 'skeleton').
    useCaseFilterChain: ['app-hax', 'app-hax-use-case-filter'],
    // The creation modal chains (same as selectors.create.* but duplicated here
    // for the create-from-template flow which reuses the same modal).
    siteCreationModalChain: [
      'app-hax',
      'app-hax-use-case-filter',
      'app-hax-site-creation-modal',
    ],
    siteNameInputChain: [
      'app-hax',
      'app-hax-use-case-filter',
      'app-hax-site-creation-modal',
      '#siteName',
    ],
    createSiteButtonChain: [
      'app-hax',
      'app-hax-use-case-filter',
      'app-hax-site-creation-modal',
      '.button.button-primary',
    ],
  },

  // --- API PATHS (canonical v1 system + site API) -------------------------
  api: {
    // system API (dashboard / site lifecycle)
    login: '/system/api/v1/session/login',
    createSite: '/system/api/v1/sites',
    listSites: '/system/api/v1/sites',
    archiveSite: '/system/api/v1/sites/:siteName/archive',
    downloadSite: '/system/api/v1/sites/:siteName/download',
    connectionSettings: '/system/api/v1/session/connection-settings',
    // site API (per-site, under /x/api/v1)
    // saveNode: PATCH /x/api/v1/content/:idOrSlug → {status:200, data:page}
    saveNode: '/x/api/v1/content/:idOrSlug',
    // createNode: POST /x/api/v1/items → {status:200, data:item}
    createNode: '/x/api/v1/items',
    // deleteNode: DELETE /x/api/v1/items/:idOrSlug → {status:200, data:item}
    deleteNode: '/x/api/v1/items/:idOrSlug',
    // saveOutline: PATCH /x/api/v1/site/outline → {status:200, data:{items:[...]}}
    saveOutline: '/x/api/v1/site/outline',
    // --- revisions (VERIFIED at runtime) ---
    // listItemRevisions: GET → {status:200, data:{nodeId, nodeSlug, nodeTitle,
    //   count, total, page:{limit,offset,total}, revisions:[{revisionNumber,
    //   hash, shortHash, author, authorEmail, timestamp, date, message}],
    //   links:{self, item}}}
    listItemRevisions: '/x/api/v1/items/:idOrSlug/revisions',
    // itemRevisionDetail: GET → {status:200, data:{..., revision:{...},
    //   content, jsonVariantLocation, hasItemMetadata, itemMetadata,
    //   links:{self, revisions, restore, item}}}
    itemRevisionDetail: '/x/api/v1/items/:idOrSlug/revisions/:revisionId',
    // restoreItemRevision: POST → {status:200, data:{..., restoredFromHash,
    //   itemMetadataRestored, links:{self, revision, revisions, item}}}
    restoreItemRevision:
      '/x/api/v1/items/:idOrSlug/revisions/:revisionId/restore',
    // --- site reads (VERIFIED at runtime) ---
    // search: GET → {status:200, data:{query, fields, count, total, page,
    //   results:[{id, title, slug, location, score, snippet, matches, links}]}}
    // Auth: PUBLIC (security: [] in OpenAPI) — no token needed.
    search: '/x/api/v1/search',
    // tags: GET → {status:200, data:{count, total, page, tags:[{tag, count}],
    //   links:{self}}}. Auth: PUBLIC.
    tags: '/x/api/v1/tags',
    // siteSummary: GET → {status:200, data:{id, name, title, description,
    //   language, basePath, theme, updated, counts:{items, publishedItems,
    //   tags, regions, files}, links:{...}, jsonld:{...}}}. Auth: PUBLIC.
    siteSummary: '/x/api/v1/site',
    // --- system admin (VERIFIED at runtime) ---
    // themesList: GET → {status:200, data:[{machineName, ..., enabled, hidden}]}
    // saveEnabledThemes: PATCH (or POST) → {status:200, data:{enabledThemes, settings}}
    // Auth: Bearer JWT; PATCH additionally requires X-HAXCMS-User-Token.
    themesList: '/system/api/v1/themes',
    // skeletonsList: GET → {status:200, data:[{machineName, ..., enabled}]}
    // saveEnabledSkeletons: PATCH (or POST) → {status:200, data:{enabledSkeletons, settings}}
    skeletonsList: '/system/api/v1/skeletons',
    // getApiKeys: GET (or POST) → {status:200, data:{...apiKeys}}
    // saveApiKeys: PATCH (or POST) → {status:200, data:{...apiKeys}}
    apiKeys: '/system/api/v1/configuration/api-keys',
    // getMediaSettings: GET (or POST) → {status:200, data:{...mediaSettings}}
    // saveMediaSettings: PATCH (or POST) → {status:200, data:{...mediaSettings}}
    mediaSettings: '/system/api/v1/configuration/media',
    // systemStatus: GET (or POST) → {status:200, data:{...statusReport}}
    systemStatus: '/system/api/v1/status',
    // systemVersion: GET (or POST) → {status:200, data:{version}}
    systemVersion: '/system/api/v1/system/version',
    // normalizeSiteSlugs: POST /x/api/v1/site/normalize-slugs?preview=true
    // → {status:200, data:{changed:bool, preview:bool, changes:[{id,title,oldSlug,newSlug}], skipped:[...]}}
    // Without preview: applies the slug changes to the manifest + commits.
    normalizeSlugs: '/x/api/v1/site/normalize-slugs',
  },
}

module.exports = {
  selectors,
  FIXED_SITE_NAME,
  deepQuery,
  deepQueryAll,
}
