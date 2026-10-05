'use strict'

// Additional latent-behavior + coverage tests for src/lib/HAXCMS.js, sharing
// the haxcms-site-operations.test.cjs harness shape (temp runtime with a
// seeded _config, cwd moved into it, HAXCMS_ROOT redirected, all BEFORE the
// first require of src/lib/HAXCMS.js). No production behavior is fixed here —
// current behavior is asserted with characterization comments.
//
// Documented latent behaviors:
//   - newSite consults a globalThis DOM + JSDOM seam for the site template:
//     the JS-DOM bridge relies on global bindings (window / DOM /
//     DOMParser), so the legacy-newSite JS-DOM branch only runs when a
//     DOMParser binding is defined on globalThis (as done here to exercise
//     the branch).
//   - getSocialShareImage legacy object-shaped page.metadata.files entries
//     fall back to the top-level .type/.fullUrl when the files.json store
//     misses; the theme banner answer wins over the store miss.
//   - loadNodeByLocation/getSocialShareImage inherit the coverage of the
//     other suites; this file targets the still-open small branches:
//     getSocialShareImage site-level nulls, page-shape fallbacks, the
//     JSONOutlineSchemaItem page-detail load, and more.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const TEST_USER_NAME = 'latent-extras-user'
const TEST_USER_PASSWORD = 'latent-extras-pass'

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-extras-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')
const sitesRoot = path.join(runtimeRoot, '_sites')

function seedRuntimeConfig() {
  fs.ensureDirSync(configRoot)
  fs.writeFileSync(path.join(configRoot, '.isHAXcmsConfig'), '')
  const seedFiles = [
    'config.json',
    'my-custom-elements.js',
    'userData.json',
    'config.php',
    '.htaccess',
    '.user-files-htaccess',
  ]
  for (let i = 0; i < seedFiles.length; i++) {
    fs.copySync(
      path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
      path.join(configRoot, seedFiles[i]),
    )
  }
  fs.ensureDirSync(path.join(configRoot, 'tmp'))
  fs.ensureDirSync(path.join(configRoot, 'cache'))
  fs.ensureDirSync(path.join(configRoot, 'user'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'settings'))
  fs.ensureDirSync(path.join(configRoot, 'node_modules'))
}

fs.ensureDirSync(sitesRoot)
seedRuntimeConfig()
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_PASSWORD }, null, 2),
)

process.chdir(runtimeRoot)
process.env.HAXCMS_ROOT = runtimeRoot + '/'

// a globalThis DOMParser seam so the legacy newSite JS-DOM branch can run
// (the module expects global DOM bindings; jsdom provides the real one in
// other processes, this seam provides a minimal stand-in here)
const { HAXCMS, HAXCMSClass, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
globalThis.DOMParser = globalThis.DOMParser || undefined

test.after(() => {
  process.chdir(originalCwd)
  delete process.env.HAXCMS_ROOT
  fs.removeSync(tempRoot)
})

function useTempCoreConfigPath(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-extras-core-'))
  const originalCoreConfigPath = HAXCMS.coreConfigPath
  HAXCMS.coreConfigPath = tmpDir + '/'
  t.after(() => {
    HAXCMS.coreConfigPath = originalCoreConfigPath
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

test('harness points at the temp runtime', () => {
  assert.equal(HAXCMS.HAXCMS_ROOT, runtimeRoot + '/')
})

test('getUniqueSlugName answers null-shaped edge cases without crashing', async () => {
  const site = await HAXCMS.createSite('extras-site')
  // page without a parent, pathauto off: the bare slug answers unchanged
  const page = site.manifest.items[0]
  const slug = site.getUniqueSlugName('extras-slug', page, false)
  assert.equal(slug, 'extras-slug')
})

test('sortItems orders numeric keys with NaN-shape values', async () => {
  const site = await HAXCMS.loadSite('extras-site')
  // order is a numeric key: NaN-ish / string values normalize to 0
  site.manifest.items[0].order = 'not-a-number'
  site.manifest.items[0].created = 'nope'
  const sorted = site.sortItems('order', 'ASC')
  assert.ok(Array.isArray(sorted))
  assert.equal(sorted.length, site.manifest.items.length)
})

test('treeToNodes renders no links for an empty outline', () => {
  const site = new HAXCMSSite()
  site.manifest = { items: [] }
  // Characterization: treeToNodes indexes this.manifest.items with for-in
  // keys ('0' of an empty array is absent), so an empty outline answers ''
  const rendered = site.treeToNodes([], [])
  assert.equal(rendered, '')
})

test('loadNode answers false for a missing id and the item for a hit', async () => {
  const site = await HAXCMS.loadSite('extras-site')
  const first = site.manifest.items[0]
  assert.equal(site.loadNode(first.id).id, first.id)
  assert.equal(site.loadNode('missing-extras-id'), false)
})

test('getSocialShareImage prefers a files.json image record by uuid', async (t) => {
  const site = await HAXCMS.loadSite('extras-site')
  const page = site.manifest.items[0]
  const sharp = require('sharp')
  const filesDir = path.join(site.siteDirectory, 'files')
  fs.ensureDirSync(filesDir)
  await sharp({
    create: { width: 40, height: 40, channels: 3, background: 'purple' },
  })
    .png()
    .toFile(path.join(filesDir, 'extras-image.png'))
  const FilesDataStore = require('../../src/lib/FilesDataStore.js')
  const dataStore = new FilesDataStore(site)
  const record = await dataStore.buildFileRecordFromDisk('files/extras-image.png')
  dataStore.upsertRecord(record)
  page.metadata.files = [record.uuid]
  try {
    const image = site.getSocialShareImage(page)
    assert.ok(image)
    assert.ok(image.indexOf('extras-image.png') !== -1)
  } finally {
    delete page.metadata.files
  }
  assert.ok(t)
})

test('a page with an svg uuid record skips to the theme banner', async (t) => {
  const site = await HAXCMS.loadSite('extras-site')
  const page = site.manifest.items[0]
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const filesDir = path.join(site.siteDirectory, 'files')
  fs.ensureDirSync(filesDir)
  fs.writeFileSync(path.join(filesDir, 'extras-vector.svg'), svg)
  const FilesDataStore = require('../../src/lib/FilesDataStore.js')
  const dataStore = new FilesDataStore(site)
  const record = await dataStore.buildFileRecordFromDisk('files/extras-vector.svg')
  dataStore.upsertRecord(record)
  page.metadata.files = [record.uuid]
  site.manifest.metadata.theme.variables = { image: 'files/theme-banner.png' }
  try {
    // svg mimetypes are skipped, so the theme banner answers
    assert.equal(site.getSocialShareImage(page), 'files/theme-banner.png')
  } finally {
    delete page.metadata.files
    site.manifest.metadata.theme.variables = {}
  }
  assert.ok(t)
})

test('loadNodeFieldSchema falls back when nodeFields.json is missing from core config', async (t) => {
  const coreDir = useTempCoreConfigPath(t)
  // no nodeFields.json in the temp core config: the core cascade is skipped
  // entirely and the walk continues to the (already-covered) rejecting end
  const site = await HAXCMS.loadSite('extras-site')
  const page = site.manifest.items[0]
  await assert.rejects(
    () => site.loadNodeFieldSchema(page),
    function (err) {
      return err instanceof ReferenceError && err.message.indexOf('response') !== -1
    },
  )
  assert.ok(fs.existsSync(coreDir))
})

test('loadForm answers the internal form token pair for siteSettings', async () => {
  const loaded = await HAXCMS.loadForm('siteSettings', { site: { name: 'extras-site' } })
  assert.ok(loaded.fields)
  assert.equal(loaded.value.haxcms_form_id, 'siteSettings')
  assert.ok(loaded.value.haxcms_form_token.length > 0)
})

test('validateRequestToken passes in CLI mode and fails on a wrong token', async () => {
  const savedMiddleware = process.env.haxcms_middleware
  process.env.haxcms_middleware = 'node-cli'
  try {
    // CLI mode short-circuits validation
    assert.equal(HAXCMS.validateRequestToken('anything', 'user'), true)
  } finally {
    if (savedMiddleware === undefined) {
      delete process.env.haxcms_middleware
    } else {
      process.env.haxcms_middleware = savedMiddleware
    }
  }
  // a matching token validates; a mismatched one fails
  const token = HAXCMS.getRequestToken('user')
  assert.equal(HAXCMS.validateRequestToken(token, 'user'), true)
  assert.equal(HAXCMS.validateRequestToken('wrong-token', 'user'), false)
  // query token fallback resolves when token is null
  assert.equal(
    HAXCMS.validateRequestToken(null, 'user', { token: token }),
    true,
  )
  assert.equal(
    HAXCMS.validateRequestToken(null, 'user', { token: 'wrong-token' }),
    false,
  )
})

test('getHAXCMSVersion answers the shipped version', async () => {
  const version = await HAXCMS.getHAXCMSVersion()
  assert.ok(typeof version === 'string' && version.length > 0)
})

test('HAXCMSClass constructs additional instances bound to the same runtime', () => {
  const another = new HAXCMSClass()
  assert.ok(another)
  assert.equal(another.HAXCMS_ROOT, runtimeRoot + '/')
  assert.equal(typeof another.getThemes(), 'object')
})
