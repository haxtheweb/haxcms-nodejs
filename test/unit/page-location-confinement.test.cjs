'use strict'

// Security (review 2026-10): regression tests for page-location confinement.
// A client-supplied node id (createNode / saveNode page-break / items API /
// addPage) or a crafted site.json `location` must never read or write outside
// the site directory. Mirrors PHP N1/N5 (generateMachineName on ids,
// JSONOutlineSchemaItem::readLocation/writeLocation realpath containment,
// HAXCMSSite::resolvePageLocationRealPath, recurseCopy dst guard).
//
// Uses a temp runtime (same pattern as haxcms-site-operations.test.cjs) so the
// real HAXCMS.createSite / createNode code paths write real files.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-unit-pageloc-'))
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
  const dirs = ['tmp', 'cache', 'user', 'user/files', 'user/skeletons', 'skeletons', 'settings', 'node_modules']
  for (let i = 0; i < dirs.length; i++) {
    fs.ensureDirSync(path.join(configRoot, dirs[i]))
  }
}

fs.ensureDirSync(sitesRoot)
seedRuntimeConfig()
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: 'unit-pageloc', password: 'unit-pageloc-pass' }, null, 2),
)
process.chdir(runtimeRoot)
process.env.HAXCMS_ROOT = runtimeRoot + '/'
process.env.GIT_AUTHOR_NAME = 'HAXcms Unit'
process.env.GIT_AUTHOR_EMAIL = 'unit@local.invalid'
process.env.GIT_COMMITTER_NAME = 'HAXcms Unit'
process.env.GIT_COMMITTER_EMAIL = 'unit@local.invalid'

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const JSONOutlineSchemaItem = require('../../src/lib/JSONOutlineSchemaItem.js')
const { siteHTMLContent } = require('../../src/lib/JOSHelpers.js')

// getItemHTML is module-private; reach it through siteHTMLContent with a
// one-item fake site so only that item's HTML is returned.
async function getItemHTML(realSite, item) {
  const fake = {
    siteDirectory: realSite.siteDirectory,
    manifest: { items: [item] },
  }
  const html = await siteHTMLContent(null, fake, null, true, false)
  // strip the per-item wrapper siteHTMLContent adds
  return html.replace(/^<div data-jos-item-id="[^"]*">/, '').replace(/<\/div>$/, '')
}
const {
  pathWithinBase,
  resolvePageLocation,
  isDestinationWithinBase,
} = require('../../src/lib/pageLocation.js')
const createNode = require('../../src/siteRoutes/v1/routes/createNode.js')

test.after(() => {
  process.chdir(originalCwd)
  delete process.env.HAXCMS_ROOT
  fs.removeSync(tempRoot)
})

const TRAVERSAL_IDS = [
  '../../othertenant',
  '..%2F..%2Fothertenant',
  '..%252F..%252Fothertenant',
  '..\\..\\othertenant',
  '..%5C..%5Cothertenant',
  'item\u0000/../../othertenant',
  '%00../../othertenant',
  '....//....//othertenant',
  '/etc/othertenant',
]

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    status(code) { this.statusCode = code; return this },
    json(obj) { this.body = obj; return this },
    send(value) { this.sent = value; return this },
  }
}

function mockAuth(t, site) {
  t.mock.method(HAXCMS, 'validateRequestToken', () => true)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'unit-pageloc')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

function makeReq(siteName, body) {
  return {
    headers: { 'x-haxcms-site-token': 'token' },
    query: {},
    params: {},
    body: Object.assign({ site: { name: siteName } }, body),
  }
}

let site
let siteDir
test.before(async () => {
  site = await HAXCMS.createSite('pageloc-site')
  siteDir = path.join(sitesRoot, 'pageloc-site')
})

// ---------------------------------------------------------------------------
// id sanitizer
// ---------------------------------------------------------------------------
test('sanitizeItemId strips traversal, slashes, backslashes, NUL and encoded variants', () => {
  for (let i = 0; i < TRAVERSAL_IDS.length; i++) {
    const out = HAXCMS.sanitizeItemId(TRAVERSAL_IDS[i])
    assert.match(out, /^[a-zA-Z0-9_-]+$/, TRAVERSAL_IDS[i] + ' -> ' + out)
    assert.equal(out.indexOf('..'), -1)
  }
  assert.equal(HAXCMS.sanitizeItemId(''), 'default')
  assert.equal(HAXCMS.sanitizeItemId('../..'), 'default')
  assert.equal(HAXCMS.sanitizeItemId(null), 'default')
})

test('sanitizeItemId leaves canonical item-<uuid> ids and mixed-case ids unchanged', () => {
  const ids = [
    'item-3f1c2b4a-9d8e-4f7a-8b6c-1a2b3c4d5e6f',
    'item-' + require('crypto').randomUUID(),
    'imported-one',
    'Item-ABC_def-123',
    'welcome',
  ]
  for (let i = 0; i < ids.length; i++) {
    assert.equal(HAXCMS.sanitizeItemId(ids[i]), ids[i])
  }
})

test('generateMachineName behaviour for other callers is unchanged (still lowercases)', () => {
  assert.equal(HAXCMS.generateMachineName('My-Site'), 'my-site')
})

// ---------------------------------------------------------------------------
// itemFromParams / addPage
// ---------------------------------------------------------------------------
test('itemFromParams confines node.id to pages/<safe-id>/index.html', () => {
  for (let i = 0; i < TRAVERSAL_IDS.length; i++) {
    const item = site.itemFromParams({ node: { title: 'x', id: TRAVERSAL_IDS[i] } })
    assert.match(item.location, /^pages\/[a-zA-Z0-9_-]+\/index\.html$/, item.location)
    assert.equal(resolvePageLocation(siteDir, item.location, { mustExist: false }) !== false, true)
  }
  const uuidId = 'item-' + require('crypto').randomUUID()
  const ok = site.itemFromParams({ node: { title: 'x', id: uuidId } })
  assert.equal(ok.id, uuidId)
  assert.equal(ok.location, 'pages/' + uuidId + '/index.html')
})

test('addPage sanitizes a caller-supplied id and writes inside the site', async () => {
  const page = await site.addPage(null, 'Evil add', 'html', 'evil-add', '../../addpage-escape', 0, '<p>addpage body</p>')
  assert.ok(page)
  assert.equal(page.id.indexOf('..'), -1)
  assert.equal(fs.existsSync(path.join(sitesRoot, 'addpage-escape')), false)
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'addpage-escape')), false)
  assert.ok(fs.existsSync(path.join(siteDir, 'pages', page.id, 'index.html')))
})

// ---------------------------------------------------------------------------
// createNode route (also reached via POST /x/api/v1/items)
// ---------------------------------------------------------------------------
test('createNode with a traversal node.id cannot create or write outside the site', async (t) => {
  mockAuth(t, site)
  for (let i = 0; i < TRAVERSAL_IDS.length; i++) {
    const res = stubRes()
    await createNode(
      makeReq('pageloc-site', {
        node: { title: 'Escape ' + i, id: TRAVERSAL_IDS[i], contents: '<p>PWNED-' + i + '</p>' },
      }),
      res,
    )
    assert.ok(res.sent && res.sent.status === 200, 'createNode should succeed with a sanitized id')
    const created = res.sent.data
    assert.match(created.location, /^pages\/[a-zA-Z0-9_-]+\/index\.html$/)
    const written = fs.readFileSync(path.join(siteDir, created.location), 'utf8')
    assert.ok(written.indexOf('PWNED-' + i) !== -1)
  }
  assert.equal(fs.existsSync(path.join(sitesRoot, 'othertenant')), false)
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'othertenant')), false)
  assert.equal(fs.existsSync('/etc/othertenant'), false)
})

test('createNode items[] batch sanitizes ids passed to addPage', async (t) => {
  mockAuth(t, site)
  const res = stubRes()
  await createNode(
    makeReq('pageloc-site', {
      items: [{ title: 'Batch evil', id: '../../batch-escape', parent: null, contents: '<p>b</p>' }],
    }),
    res,
  )
  assert.equal(fs.existsSync(path.join(sitesRoot, 'batch-escape')), false)
})

test('a normal item-<uuid> id works end-to-end through createNode', async (t) => {
  mockAuth(t, site)
  const uuidId = 'item-' + require('crypto').randomUUID()
  const res = stubRes()
  await createNode(
    makeReq('pageloc-site', { node: { title: 'Normal page', id: uuidId, contents: '<p>hello normal</p>' } }),
    res,
  )
  assert.equal(res.sent.status, 200)
  assert.equal(res.sent.data.id, uuidId)
  assert.equal(res.sent.data.location, 'pages/' + uuidId + '/index.html')
  const page = site.loadNode(uuidId)
  assert.ok(page)
  const content = await site.getPageContent(page)
  assert.ok(content.indexOf('hello normal') !== -1)
  assert.ok((await page.readLocation(site.siteDirectory)).indexOf('hello normal') !== -1)
  assert.equal(await page.writeLocation('<p>rewritten</p>', site.siteDirectory), true)
  assert.ok((await site.getPageContent(page)).indexOf('rewritten') !== -1)
})

// ---------------------------------------------------------------------------
// readers / writers refuse crafted manifest locations
// ---------------------------------------------------------------------------
test('readLocation / getPageContent / getItemHTML refuse pages/../../../etc/passwd', async () => {
  const secretDir = path.join(tempRoot, 'secret')
  fs.ensureDirSync(secretDir)
  fs.writeFileSync(path.join(secretDir, 'passwd'), 'TOP-SECRET')
  const evil = new JSONOutlineSchemaItem()
  const locations = [
    'pages/../../../etc/passwd',
    'pages/../../../secret/passwd',
    'pages\\..\\..\\..\\secret\\passwd',
    'pages/x/index.html\u0000.txt',
    '../secret/passwd',
  ]
  for (let i = 0; i < locations.length; i++) {
    evil.location = locations[i]
    assert.equal(await evil.readLocation(site.siteDirectory), false, locations[i])
    assert.equal(await site.getPageContent(evil), '', locations[i])
    assert.equal(await getItemHTML(site, evil), '', locations[i])
    assert.equal(await evil.writeLocation('<p>overwrite</p>', site.siteDirectory), false, locations[i])
  }
  assert.equal(fs.readFileSync(path.join(secretDir, 'passwd'), 'utf8'), 'TOP-SECRET')
})

test('readLocation / writeLocation / getPageContent refuse a symlink that escapes the site', async () => {
  const outsideDir = path.join(tempRoot, 'outside')
  fs.ensureDirSync(outsideDir)
  fs.writeFileSync(path.join(outsideDir, 'index.html'), 'OUTSIDE-SECRET')
  fs.ensureDirSync(path.join(siteDir, 'pages'))
  fs.symlinkSync(outsideDir, path.join(siteDir, 'pages', 'linked-out'))
  const evil = new JSONOutlineSchemaItem()
  evil.location = 'pages/linked-out/index.html'
  assert.equal(await evil.readLocation(site.siteDirectory), false)
  assert.equal(await site.getPageContent(evil), '')
  assert.equal(await getItemHTML(site, evil), '')
  assert.equal(await evil.writeLocation('<p>overwrite</p>', site.siteDirectory), false)
  assert.equal(fs.readFileSync(path.join(outsideDir, 'index.html'), 'utf8'), 'OUTSIDE-SECRET')
  // boilerplate copy into a symlinked-out page dir is refused as well
  const copied = await HAXCMS.recurseCopy(
    HAXCMS.boilerplatePath + 'page/default',
    path.join(siteDir, 'pages', 'linked-out', 'sub'),
    [],
    siteDir,
  )
  assert.equal(copied, false)
  assert.equal(fs.existsSync(path.join(outsideDir, 'sub')), false)
})

// ---------------------------------------------------------------------------
// helper + recurseCopy
// ---------------------------------------------------------------------------
test('recurseCopy with a base refuses destinations outside it; without a base it is unchanged', async () => {
  const outside = path.join(siteDir, 'pages', '..', '..', 'rc-escape')
  assert.equal(
    await HAXCMS.recurseCopy(HAXCMS.boilerplatePath + 'page/default', outside, [], siteDir),
    false,
  )
  assert.equal(fs.existsSync(path.join(sitesRoot, 'rc-escape')), false)
  // the site root itself is not a valid page destination
  assert.equal(
    await HAXCMS.recurseCopy(HAXCMS.boilerplatePath + 'page/default', siteDir, [], siteDir),
    false,
  )
  // system copies (no base) keep working
  const sysDst = path.join(tempRoot, 'system-copy')
  assert.equal(await HAXCMS.recurseCopy(HAXCMS.boilerplatePath + 'page/default', sysDst), true)
  assert.ok(fs.existsSync(path.join(sysDst, 'index.html')))
})

test('pathWithinBase / isDestinationWithinBase prefix checks use a trailing separator', () => {
  assert.equal(pathWithinBase('/a/site', '/a/site'), true)
  assert.equal(pathWithinBase('/a/site/pages/x', '/a/site'), true)
  assert.equal(pathWithinBase('/a/site-other/x', '/a/site'), false)
  assert.equal(isDestinationWithinBase(siteDir, siteDir + '-other/pages/x'), false)
  assert.equal(isDestinationWithinBase(siteDir, path.join(siteDir, 'pages', 'new-one')), true)
})
