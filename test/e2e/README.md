# E2E UI Tests for haxcms-nodejs

Automated end-to-end tests that drive the real app-hax dashboard through a headless
browser (puppeteer-core + system Chrome), validating that common user tasks still
succeed after code changes. Each test boots an isolated haxcms-nodejs server in a
temp directory on an ephemeral port with JWT auth enabled, then exercises the UI.

Tracks: haxtheweb/issues#2939

## Prerequisites

- **Chrome/Chromium** installed on the host. The harness auto-detects
  `/usr/bin/google-chrome` (and common alternatives). Override with
  `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome` for CI or non-standard installs.
- **Node >= 18.20.3** (matches `package.json` engines).
- Dependencies (`puppeteer-core`, `sharp`, `axe-core`, `pixelmatch`, `pngjs`) are
  already in `package.json` — just run `npm install` at the repo root.

## Running the tests

```bash
# from the haxcms-nodejs repo root
npm run test:e2e
```

This runs all `test/e2e/*.e2e.test.cjs` files via Node's built-in test runner.

### Individual test files

```bash
node --test test/e2e/login.e2e.test.cjs
node --test test/e2e/create-site.e2e.test.cjs
node --test test/e2e/archive-site.e2e.test.cjs
node --test test/e2e/edit-content.e2e.test.cjs
node --test test/e2e/export-site.e2e.test.cjs
node --test test/e2e/page-management.e2e.test.cjs
```

### Updating visual baselines

Visual diffs **warn but do not fail** the test run. When a diff is intentional
(e.g. a theme change, a new modal design), regenerate baselines:

```bash
npm run test:e2e:update
# or
HAXCMS_E2E_UPDATE_SCREENSHOTS=1 node --test test/e2e/*.e2e.test.cjs
```

Baselines are stored under `test/e2e/__screenshots__/` as `*.png` files.
Runtime artifacts (`*.current.png`, `*.diff.png`) are written alongside for
manual inspection and should not be committed.

## What the tests cover

| Test file | Task | Key assertions |
|---|---|---|
| `login.e2e.test.cjs` | Login via two-step modal | POST `/session/login` → 200 + jwt + refresh cookie; dashboard renders; a11y scan of login form; visual baselines (logged-out + logged-in) |
| `create-site.e2e.test.cjs` | Create `HAXSITEAUTOMATEDTESTING` | POST `/sites` → 200 + `data.metadata.site.name` match + `link`; site exists on disk + in list API; a11y scan of create modal; visual baselines (modal + post-create) |
| `archive-site.e2e.test.cjs` | Archive `HAXSITEAUTOMATEDTESTING` | POST `/sites/:siteName/archive` → 200 + `data.name` + `detail === 'Site archived'`; site card removed from dashboard; site directory moved to `_archived/` on disk; a11y + visual baselines |
| `edit-content.e2e.test.cjs` | Edit & save content in HAX editor | PATCH `/x/api/v1/content/:idOrSlug` (saveNode) → 200; typed content present in the page HTML file on disk; a11y scan of editor chrome; visual baseline (editor in edit mode) |
| `export-site.e2e.test.cjs` | Export/download site as zip | POST `/sites/:siteName/download` → 200 + `data.link` ends `.zip` + `data.name`; zip file exists at `_published/haxsiteautomatedtesting.zip` with PK magic bytes; a11y + visual baselines |
| `page-management.e2e.test.cjs` | Add + delete a page | POST `/x/api/v1/items` (createNode) → 200 + `data.id` + `data.title`; DELETE `/x/api/v1/items/:id` → 200; page removed from site.json manifest + items list (page directory is intentionally left on disk by the backend); a11y + visual baselines |

All site operations target the fixed name `HAXSITEAUTOMATEDTESTING`. Each run
boots an isolated temp runtime so the name never collides with real work.

## How it works (the five layers)

1. **Server harness** (`helpers/harness.cjs`) — boots a real haxcms-nodejs server
   in a temp dir on an ephemeral port with auth enabled. Adapted from the API
   conformance harness at `test/api-conformance/`.
2. **Browser driving** (`helpers/browser.cjs`) — launches headless Chrome via
   `puppeteer-core` + the system Chrome binary. Fixed 1280x800 viewport.
3. **Response interception** (`helpers/browser.cjs` `createResponseCollector`) —
   captures every XHR/fetch to `/system/api/v1/*` and `/x/api/*` so tests can
   assert on the JSON response status and body, independent of rendering.
4. **Accessibility** (`helpers/axe.cjs`) — injects `axe-core` and runs WCAG 2.1
   AA rules scoped to the task-relevant UI region.
5. **Visual regression** (`helpers/visual.cjs`) — captures screenshots and diffs
   against committed baselines with `pixelmatch`/`sharp`. Diffs **warn but never
   fail**; a human reviews the notice because a diff may be intentional.

## Debugging

### Headed mode (watch the browser)

Set `headless: false` in the `launchBrowser()` call, or pass it from the test:

```js
const browser = await launchBrowser({ headless: false })
```

Add `await new Promise(r => setTimeout(r, 5000))` at key points to pause and
inspect the UI.

### SlowMo

```js
const browser = await launchBrowser({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--slow-mo=100'] })
```

### Selector discovery

The selector map lives in `helpers/selectors.cjs`. Discovery scripts (dotfiles,
ignored by the test glob) boot the server + browser and print the real DOM
structure for confirming selectors:

```bash
node test/e2e/helpers/.discovery.cjs            # login + dashboard + create + archive
node test/e2e/helpers/.discovery-editor.cjs     # site editor + export + outline
```

### Console output

The tests emit `[e2e]`, `[visual]`, `[a11y]`, and `[diag]` prefixed warnings with
progress markers and diagnostic info. Pipe through `grep` to filter:

```bash
node --test test/e2e/create-site.e2e.test.cjs 2>&1 | grep '\[e2e\]'
```

## File layout

```
test/e2e/
  helpers/
    harness.cjs       # server bootstrap (temp dir, ephemeral port, auth enabled)
    browser.cjs       # puppeteer launch + response collector
    axe.cjs           # axe-core inject + runA11y
    visual.cjs        # screenshot capture + baseline diff (WARN not fail)
    selectors.cjs     # centralised app-hax selector map (shadow-DOM chains)
    index.cjs         # re-exports all helpers
    .discovery.cjs    # dotfile discovery script (login + dashboard + create + archive)
    .discovery-editor.cjs  # dotfile discovery script (editor + export + outline)
  login.e2e.test.cjs
  create-site.e2e.test.cjs
  archive-site.e2e.test.cjs
  edit-content.e2e.test.cjs
  export-site.e2e.test.cjs
  page-management.e2e.test.cjs
  __screenshots__/    # committed baselines (*.png) + runtime artifacts (*.current.png)
  README.md           # this file
```
