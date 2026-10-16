'use strict'

// Security (N1/N5 parity): page ids and page locations must never let a
// request (or a poisoned site.json) read or write outside the site directory.
//
// Layout used by every test:
//   <tmp>/sites/mysite        <- the site under attack
//   <tmp>/sites/othertenant   <- a sibling site holding a SECRET page
//   <tmp>/outside.txt         <- a file above the sites dir
// An id such as `../../othertenant` would (pre-fix) compose the location
// `pages/../../othertenant/index.html` and land in the sibling site.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const JSONOutlineSchemaItem = require('../../src/lib/JSONOutlineSchemaItem.js')
const JOSHelpers = require('../../src/lib/JOSHelpers.js')
const FeedMe = require('../../src/lib/RSS.js')
const {
  resolveContainedPath,
  pathWithinBase,
  hasTraversal,
} = require('../../src/lib/pathConfinement.js')
const createNode = require('../../src/siteRoutes/v1/routes/createNode.js')
const saveNode = require('../../src/siteRoutes/v1/routes/saveNode.js')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SECRET = '<p>SECRET other tenant content</p>'
const OUTSIDE = 'OUTSIDE secret'

const TRAVERSAL_IDS = [
  '../../othertenant',
  '../../../outside',
  '..%2F..%2Fothertenant',
  '....//....//othertenant',
  '..\\..\\othertenant',
  'item-1\0/../../othertenant',
]

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.body = obj
      return this
    },
  }
}

function listTree(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry)
      out.push(path.relative(dir, full))
      if (fs.lstatSync(full).isDirectory()) {
        walk(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}

async function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-confine-'))
  const sitesDir = path.join(root, 'sites')
  const siteDir = path.join(sitesDir, 'mysite')
  const otherDir = path.join(sitesDir, 'othertenant')
  fs.ensureDirSync(path.join(siteDir, 'pages'))
  const manifest = fs.readJsonSync(path.join(REPO_ROOT, 'src', 'boilerplate', 'site', 'site.json'))
  manifest.metadata = { site: { name: 'mysite' }, theme: {} }
  fs.writeJsonSync(path.join(siteDir, 'site.json'), manifest)
  fs.ensureDirSync(path.join(otherDir, 'pages', 'item-secret'))
  fs.writeFileSync(path.join(otherDir, 'index.html'), SECRET)
  fs.writeFileSync(path.join(otherDir, 'pages', 'item-secret', 'index.html'), SECRET)
  fs.writeFileSync(path.join(root, 'outside.txt'), OUTSIDE)
  const site = new HAXCMSSite()
  await site.load(sitesDir, '/', 'mysite')
  // keep side effects (git, feed regeneration) out of these unit tests
  site.gitCommit = async () => true
  site.updateAlternateFormats = async () => true
  t.after(() => fs.removeSync(root))
  return {
    root,
    sitesDir,
    siteDir,
    otherDir,
    site,
    snapshotOutside() {
      return {
        other: listTree(otherDir),
        otherIndex: fs.readFileSync(path.join(otherDir, 'index.html'), 'utf8'),
        outside: fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'),
        rootEntries: fs.readdirSync(root).sort(),
        sitesEntries: fs.readdirSync(sitesDir).sort(),
      }
    },
  }
}

function mockAuth(t, site) {
  t.mock.method(HAXCMS, 'validateRequestToken', () => true)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// --- helper ----------------------------------------------------------------

test('pathConfinement: lexical traversal and NUL bytes are rejected', () => {
  assert.equal(hasTraversal('pages/item-1/index.html'), false)
  assert.equal(hasTraversal('pages/../x'), true)
  assert.equal(hasTraversal('pages\\..\\x'), true)
  assert.equal(hasTraversal('..'), true)
  assert.equal(hasTraversal('pages/item\0/index.html'), true)
  // `..foo` is a legal file name, not a traversal segment
  assert.equal(hasTraversal('pages/..foo/index.html'), false)
  assert.equal(pathWithinBase('/a/b', '/a/b'), true)
  assert.equal(pathWithinBase('/a/b/c', '/a/b'), true)
  assert.equal(pathWithinBase('/a/bc', '/a/b'), false)
})

test('pathConfinement: symlink escaping the base is rejected', async (t) => {
  const fx = await makeFixture(t)
  fs.symlinkSync(fx.otherDir, path.join(fx.siteDir, 'pages', 'evil'))
  assert.equal(resolveContainedPath(fx.siteDir, 'pages/evil/index.html'), false)
  // not-yet-existing file below a symlinked dir is also refused
  assert.equal(resolveContainedPath(fx.siteDir, 'pages/evil/new/index.html'), false)
  // an absolute-looking location is joined beneath the base, never used as-is
  assert.equal(
    resolveContainedPath(fx.siteDir, '/etc/passwd'),
    path.join(fx.siteDir, 'etc', 'passwd'),
  )
  const ok = resolveContainedPath(fx.siteDir, 'pages/item-new/index.html')
  assert.equal(ok, path.join(fx.siteDir, 'pages', 'item-new', 'index.html'))
})

// --- id sanitization (write side) -----------------------------------------

test('itemFromParams: traversal ids are sanitized to a safe machine name', async (t) => {
  const fx = await makeFixture(t)
  for (const id of TRAVERSAL_IDS) {
    const item = fx.site.itemFromParams({ node: { id, title: 'x' } })
    assert.doesNotMatch(item.id, /[./\\\0]/, `id ${JSON.stringify(id)} -> ${item.id}`)
    assert.equal(item.location, 'pages/' + item.id + '/index.html')
    assert.notEqual(resolveContainedPath(fx.siteDir, item.location), false)
  }
  assert.equal(
    fx.site.itemFromParams({ node: { id: '../../othertenant', title: 'x' } }).id,
    'othertenant',
  )
})

test('itemFromParams / addPage: normal item-<uuid> ids are preserved', async (t) => {
  const fx = await makeFixture(t)
  const id = 'item-3f1c2a9e-7b4d-4e2f-9a6b-0c1d2e3f4a5b'
  const item = fx.site.itemFromParams({ node: { id, title: 'Hello' } })
  assert.equal(item.id, id)
  assert.equal(item.location, 'pages/' + id + '/index.html')
  const page = await fx.site.addPage(null, 'Hello', 'html', 'hello', id, 0, '<p>hi</p>')
  assert.equal(page.id, id)
  const written = fs.readFileSync(path.join(fx.siteDir, 'pages', id, 'index.html'), 'utf8')
  assert.match(written, /hi/)
  assert.equal(await fx.site.getPageContent(page), written)
})

test('addPage: traversal id cannot write outside the site directory', async (t) => {
  const fx = await makeFixture(t)
  const before = fx.snapshotOutside()
  for (const id of TRAVERSAL_IDS) {
    const page = await fx.site.addPage(null, 'Evil', 'html', 'evil', id, 0, '<p>PWNED</p>')
    assert.doesNotMatch(page.id, /[./\\\0]/)
    assert.ok(fs.existsSync(path.join(fx.siteDir, 'pages', page.id, 'index.html')))
  }
  assert.deepEqual(fx.snapshotOutside(), before)
})

test('createNode (node path): traversal id stays inside the site', async (t) => {
  const fx = await makeFixture(t)
  mockAuth(t, fx.site)
  const before = fx.snapshotOutside()
  const req = {
    headers: { 'x-haxcms-site-token': 'token' },
    body: {
      site: { name: 'mysite' },
      node: { id: '../../othertenant', title: 'Evil', contents: '<p>PWNED</p>' },
    },
  }
  const res = stubRes()
  await createNode(req, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(fx.snapshotOutside(), before)
  const created = fx.site.manifest.items.find((i) => i.title === 'Evil')
  assert.ok(created)
  assert.equal(created.id, 'othertenant')
  assert.equal(created.location, 'pages/othertenant/index.html')
  assert.ok(fs.existsSync(path.join(fx.siteDir, 'pages', 'othertenant', 'index.html')))
})

test('createNode (items[] path): traversal ids stay inside the site', async (t) => {
  const fx = await makeFixture(t)
  mockAuth(t, fx.site)
  const before = fx.snapshotOutside()
  const req = {
    headers: { 'x-haxcms-site-token': 'token' },
    body: {
      site: { name: 'mysite' },
      items: TRAVERSAL_IDS.map((id, i) => ({
        id,
        title: 'Evil ' + i,
        slug: 'evil-' + i,
        parent: null,
        indent: 0,
        order: i,
        contents: '<p>PWNED</p>',
      })),
    },
  }
  const res = stubRes()
  await createNode(req, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(fx.snapshotOutside(), before)
  for (const item of fx.site.manifest.items) {
    assert.notEqual(fx.site.resolvePageLocationRealPath(item.location), false)
  }
})

test('saveNode page-break: traversal item-id stays inside the site', async (t) => {
  const fx = await makeFixture(t)
  mockAuth(t, fx.site)
  const existing = await fx.site.addPage(null, 'Host', 'html', 'host', null, 0, '<p>host</p>')
  const before = fx.snapshotOutside()
  const req = {
    headers: { 'x-haxcms-site-token': 'token' },
    body: {
      site: { name: 'mysite' },
      node: {
        id: existing.id,
        body:
          '<page-break title="Evil" item-id="../../othertenant" path="evil"></page-break><p>PWNED</p>',
      },
    },
  }
  const res = stubRes()
  await saveNode(req, res)
  assert.deepEqual(fx.snapshotOutside(), before)
  const created = fx.site.manifest.items.find((i) => i.title === 'Evil')
  assert.ok(created, 'page-break page created')
  assert.equal(created.id, 'othertenant')
  const written = fs.readFileSync(path.join(fx.siteDir, 'pages', 'othertenant', 'index.html'), 'utf8')
  assert.match(written, /PWNED/)
})

test('recurseCopy: refuses traversal and destinations outside the base', async (t) => {
  const fx = await makeFixture(t)
  const src = HAXCMS.boilerplatePath + 'page/default'
  assert.equal(
    await HAXCMS.recurseCopy(src, path.join(fx.siteDir, 'pages') + '/../../othertenant'),
    false,
  )
  assert.equal(await HAXCMS.recurseCopy(src, fx.siteDir + '/pages/x\0'), false)
  assert.equal(await HAXCMS.recurseCopy(src, fx.otherDir + '/pages/new', [], fx.siteDir), false)
  fs.symlinkSync(fx.otherDir, path.join(fx.siteDir, 'pages', 'link'))
  assert.equal(
    await HAXCMS.recurseCopy(src, path.join(fx.siteDir, 'pages', 'link', 'new'), [], fx.siteDir),
    false,
  )
  assert.equal(fs.existsSync(path.join(fx.otherDir, 'pages', 'new')), false)
  assert.equal(
    await HAXCMS.recurseCopy(src, path.join(fx.siteDir, 'pages', 'item-ok'), [], fx.siteDir),
    true,
  )
  assert.ok(fs.existsSync(path.join(fx.siteDir, 'pages', 'item-ok', 'index.html')))
})

// --- poisoned manifest location (read side) --------------------------------

const POISONED_LOCATIONS = [
  '../othertenant/index.html',
  '../othertenant/pages/item-secret/index.html',
  '../../outside.txt',
  'pages/../../othertenant/index.html',
  '....//othertenant/index.html',
  'pages\\..\\..\\othertenant\\index.html',
  'pages/x\0/../../othertenant/index.html',
]

test('poisoned manifest location: page reads cannot escape the site', async (t) => {
  const fx = await makeFixture(t)
  for (const location of POISONED_LOCATIONS) {
    const item = new JSONOutlineSchemaItem()
    item.location = location
    item.title = 'Poisoned'
    assert.equal(await item.readLocation(fx.siteDir), false, location)
    assert.equal(await fx.site.getPageContent(item), '', location)
    assert.equal(fx.site.resolvePageLocationRealPath(location), false, location)
    assert.equal(fx.site.validatePageLocation(location), false, location)
    assert.equal(new FeedMe().safeReadItemContent(fx.site, item), '', location)
  }
})

test('poisoned manifest location: writeLocation cannot escape the site', async (t) => {
  const fx = await makeFixture(t)
  const before = fx.snapshotOutside()
  for (const location of POISONED_LOCATIONS) {
    const item = new JSONOutlineSchemaItem()
    item.location = location
    assert.equal(await item.writeLocation('<p>PWNED</p>', fx.siteDir), false, location)
  }
  assert.deepEqual(fx.snapshotOutside(), before)
})

test('poisoned manifest location: symlinked page file is not followed out', async (t) => {
  const fx = await makeFixture(t)
  fs.ensureDirSync(path.join(fx.siteDir, 'pages', 'item-link'))
  fs.symlinkSync(
    path.join(fx.otherDir, 'index.html'),
    path.join(fx.siteDir, 'pages', 'item-link', 'index.html'),
  )
  const item = new JSONOutlineSchemaItem()
  item.location = 'pages/item-link/index.html'
  assert.equal(await item.readLocation(fx.siteDir), false)
  assert.equal(await fx.site.getPageContent(item), '')
  assert.equal(await item.writeLocation('<p>PWNED</p>', fx.siteDir), false)
  assert.equal(fs.readFileSync(path.join(fx.otherDir, 'index.html'), 'utf8'), SECRET)
})

test('poisoned site.json: search index and json feed skip escaping locations', async (t) => {
  const fx = await makeFixture(t)
  const good = await fx.site.addPage(null, 'Good', 'html', 'good', null, 0, '<p>goodcontent</p>')
  const evil = new JSONOutlineSchemaItem()
  evil.title = 'Evil'
  evil.slug = 'evil'
  evil.location = '../othertenant/index.html'
  fx.site.manifest.addItem(evil)
  const items = fx.site.manifest.items
  const index = await fx.site.lunrSearchIndex(items)
  const text = JSON.stringify(index)
  assert.doesNotMatch(text, /secret other tenant/i)
  assert.match(text, /goodcontent/)
  assert.ok(good)
  // JOSHelpers.getItemHTML (via siteHTMLContent) skips the poisoned item too
  const html = await JOSHelpers.siteHTMLContent(null, fx.site)
  assert.doesNotMatch(html, /SECRET/)
  assert.match(html, /goodcontent/)
})

test('legitimate page locations still read and write', async (t) => {
  const fx = await makeFixture(t)
  const page = await fx.site.addPage(null, 'Fine', 'html', 'fine', null, 0, '<p>original</p>')
  assert.match(page.id, /^item-[0-9a-f-]{36}$/)
  assert.equal(fx.site.validatePageLocation(page.location), true)
  assert.equal(await page.writeLocation('<p>updated</p>', fx.siteDir), true)
  assert.equal(await page.readLocation(fx.siteDir), '<p>updated</p>')
  assert.equal(await fx.site.getPageContent(page), '<p>updated</p>')
  assert.match(await JOSHelpers.siteHTMLContent(null, fx.site), /<p>updated<\/p>/)
  assert.equal(new FeedMe().safeReadItemContent(fx.site, page), '<p>updated</p>')
})
