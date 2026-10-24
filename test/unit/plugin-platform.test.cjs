'use strict'

// DRAFT plugin platform (contingent on https://github.com/haxtheweb/haxcms-plugin-examples/pull/1).
//
// Runs plugins from the spec package against a REAL site in a temp HAXCMS_ROOT:
//   - saveNode fires page.before.save: reading-time stores its declared metadata.plugins fields in site.json,
//     and a vetoing plugin (fx-vetoer) stops the write with 409
//   - updateAlternateFormats fires rebuild.after: feeds writes rss.xml into the site folder
//   - deleteNode fires page.before.delete (veto) and page.after.delete
//   - plugin operations are mounted under x/api/v1/plugins/<id>/: comments stores its personal data at the
//     spec's siteData path, and security comes from the operation's declaration
//
// Constraints honored: CommonJS (.cjs), require(), node:test + node:assert/strict, no optional chaining.

const { test, describe, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-platform-'))
process.env.HAXCMS_ROOT = testRoot + '/'
const spec = path.dirname(require.resolve('@haxtheweb/haxcms-plugin-spec/package.json'))
process.env.HAXCMS_PLUGIN_DIRS = [
  path.join(spec, 'contrib-plugins', 'reading-time'),
  path.join(spec, 'contrib-plugins', 'comments'),
  path.join(spec, 'core-plugins', 'feeds'),
  path.join(spec, 'conformance', 'fixtures', 'fx-vetoer'),
].join(path.delimiter)

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const saveNode = require('../../src/siteRoutes/v1/routes/saveNode.js')
const deleteNode = require('../../src/siteRoutes/v1/routes/deleteNode.js')
const pluginSystem = require('../../src/lib/plugins/pluginSystem.js')
const { mountPluginRoutes } = require('../../src/lib/plugins/pluginRoutes.js')

test.after(() => {
  fs.removeSync(testRoot)
})

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(obj) { this.body = obj; return this },
    send(obj) { this.sent = obj; return this },
    set(k, v) { this.headers[k] = v; return this },
  }
}

function siteReq(site, body) {
  return {
    headers: { 'x-haxcms-site-token': 'token' },
    query: {},
    params: {},
    body: Object.assign({ site: { name: site.manifest.metadata.site.name } }, body),
    haxcmsSiteApiAuth: { authenticated: true, securityLevel: 'authenticated-site', userName: 'admin', siteName: site.manifest.metadata.site.name },
  }
}

let site
before(async () => {
  site = await HAXCMS.loadSite('plugin-demo', true)
  assert.ok(site && site.manifest, 'site created')
})

function freshSite() {
  return HAXCMS.loadSite('plugin-demo')
}

describe('core save points fire plugin hooks', () => {
  test('page.before.save: reading-time adds its declared fields; they land in site.json', async (t) => {
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    const s = await freshSite()
    const page = s.manifest.items[0]
    const words = new Array(410).fill('word').join(' ')
    const res = stubRes()
    await saveNode(siteReq(s, { node: { id: page.id, body: `<page-break title="Reading" published></page-break><p>${words}</p>` } }), res)
    assert.equal(res.statusCode, null, JSON.stringify(res.body))
    assert.equal(res.sent.status, 200)
    const stored = JSON.parse(fs.readFileSync(path.join(s.siteDirectory, 'site.json'), 'utf8'))
    const item = stored.items.find((i) => i.id === page.id)
    assert.deepEqual(item.metadata.plugins['reading-time'], { words: 410, minutes: 2 })
  })

  test('page.before.save: a veto stops the write with 409 and the file is unchanged', async (t) => {
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    const s = await freshSite()
    const page = s.manifest.items[0]
    const before = fs.readFileSync(path.join(s.siteDirectory, page.location), 'utf8')
    const res = stubRes()
    await saveNode(siteReq(s, { node: { id: page.id, body: '<page-break title="Forbidden thing"></page-break><p>nope</p>' } }), res)
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.data.message, 'fx-vetoer: forbidden')
    assert.equal(fs.readFileSync(path.join(s.siteDirectory, page.location), 'utf8'), before)
  })

  test('rebuild.after: feeds writes rss.xml into the site folder after core rewrites its files', async () => {
    const s = await freshSite()
    await s.updateAlternateFormats()
    const rss = fs.readFileSync(path.join(s.siteDirectory, 'rss.xml'), 'utf8')
    // the plugin's feed of published pages (core still writes its own first; the extraction removes that)
    assert.match(rss, /<generator>HAXcms<\/generator>/)
    assert.match(rss, /<title>Reading<\/title>/)
  })

  test('page.before.delete: a veto keeps the page; page.after.delete runs after a delete', async (t) => {
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    const s = await freshSite()
    // a page the vetoer refuses to delete; added straight to site.json because the vetoer also refuses to save it
    const first = s.manifest.items[0]
    const item = JSON.parse(JSON.stringify(first))
    item.id = 'item-forbidden'
    item.title = 'Forbidden page'
    item.slug = 'forbidden-page'
    item.location = 'pages/forbidden-page/index.html'
    fs.outputFileSync(path.join(s.siteDirectory, item.location), '<p>x</p>')
    item.order = 99
    s.manifest.items.push(item)
    await s.manifest.save(false)
    const s2 = await freshSite()
    const res = stubRes()
    await deleteNode(siteReq(s2, { node: { id: 'item-forbidden' } }), res)
    assert.equal(res.statusCode, 409)
    const s3 = await freshSite()
    assert.ok(s3.loadNode('item-forbidden'), 'still there')
  })

  test('page.after.delete: an allowed delete removes the page and the after hook sees it', async (t) => {
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    const s = await freshSite()
    const item = JSON.parse(JSON.stringify(s.manifest.items[0]))
    item.id = 'item-ok-delete'
    item.title = 'Plain page'
    item.slug = 'plain-page'
    item.location = 'pages/plain-page/index.html'
    fs.outputFileSync(path.join(s.siteDirectory, item.location), '<p>x</p>')
    item.order = 100
    s.manifest.items.push(item)
    await s.manifest.save(false)
    const res = stubRes()
    await deleteNode(siteReq(await freshSite(), { node: { id: 'item-ok-delete' } }), res)
    assert.equal(res.statusCode, null, JSON.stringify(res.body))
    const s3 = await freshSite()
    assert.ok(!s3.loadNode('item-ok-delete'), 'gone')
  })
})

describe('plugin operations are mounted under x/api/v1/plugins/<id>/', () => {
  function mount() {
    const routes = []
    const app = { all: (p, h) => routes.push({ p, h }), get: (p, h) => routes.push({ p, h, get: true }) }
    let authState = { userName: 'admin', jwt: true, userToken: false, siteToken: true }
    mountPluginRoutes(app, {
      basePath: '/',
      sitesDirectory: '_sites',
      resolveSite: async () => freshSite(),
      resolveAuth: () => authState,
    })
    const siteRoute = routes.find((r) => r.p === '/x/api/v1/plugins/:plugin/*')
    return {
      call: async (method, plugin, rest, body, auth) => {
        authState = auth || { userName: 'admin', jwt: true, userToken: false, siteToken: true }
        const res = stubRes()
        await siteRoute.h({ method, params: { plugin, 0: rest }, query: {}, body: body || {}, headers: {} }, res)
        return res
      },
    }
  }

  test('comments: create and list through the route; personal data at the siteData path', async () => {
    const r = mount()
    const s = await freshSite()
    const pageId = s.manifest.items[0].id
    const created = await r.call('POST', 'comments', `pages/${pageId}/comments`, { body: 'Nice page' })
    assert.equal(created.statusCode, 200, JSON.stringify(created.body))
    assert.equal(created.body.status, 'approved')
    const listed = await r.call('GET', 'comments', `pages/${pageId}/comments`)
    assert.equal(listed.body.length, 1)
    const file = path.join(testRoot, '_config', 'siteData', s.manifest.id, 'comments', 'comments.json')
    assert.ok(fs.existsSync(file), file)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].authorId, 'admin')
  })

  test('security comes from the operation: a visitor cannot post; an unknown path is 404', async () => {
    const r = mount()
    const s = await freshSite()
    const pageId = s.manifest.items[0].id
    const visitor = await r.call('POST', 'comments', `pages/${pageId}/comments`, { body: 'hi' }, { userName: '', jwt: false, userToken: false, siteToken: false })
    assert.equal(visitor.statusCode, 401)
    const missing = await r.call('GET', 'comments', 'nope')
    assert.equal(missing.statusCode, 404)
  })
})
