'use strict'

// saveOutline: descriptions sent with outline items are saved, and the
// response maps the ids the client gave new items to the ids the server
// assigned (the server never trusts a front-end id for a new item).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const saveOutline = require('../../src/siteRoutes/v1/routes/saveOutline.js')

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
  }
}

function fakeSite(dir, items) {
  return {
    name: 'demo',
    siteDirectory: dir,
    manifest: {
      items,
      metadata: { site: {} },
      addItem(page) {
        items.push(page)
      },
      save: async () => {},
    },
    loadNode(id) {
      return items.find((i) => i.id === id) || null
    },
    updateNode: async (page) => {
      const index = items.findIndex((i) => i.id === page.id)
      if (index !== -1) items[index] = page
    },
    getUniqueSlugName: (slug) => slug,
    getPageContent: async () => '',
    deleteNode: async () => {},
    gitCommit: async () => {},
    rebuildManagedFiles: async () => {},
    updateAlternateFormats: async () => {},
    writePageAlternateFormats: async () => {},
  }
}

test('outline items keep their descriptions and new ids are reported', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-outline-'))
  t.after(() => fs.removeSync(dir))
  fs.outputFileSync(path.join(dir, 'pages/item-a/index.html'), '<p>A</p>')
  const items = [
    {
      id: 'item-a',
      title: 'A',
      description: 'Old',
      location: 'pages/item-a/index.html',
      slug: 'a',
      parent: null,
      indent: 0,
      order: 0,
      metadata: { created: 1 },
    },
  ]
  const site = fakeSite(dir, items)
  t.mock.method(HAXCMS, 'validateRequestToken', () => true)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
  const req = {
    headers: { 'x-haxcms-site-token': 'token' },
    body: {
      site: { name: 'demo' },
      items: [
        { id: 'item-a', title: 'A', description: 'New <b>text</b>', parent: null, indent: 0, order: 0, metadata: {} },
        { id: 'client-1', title: 'B', description: 'Child', parent: 'item-a', indent: 1, order: 0, metadata: {}, new: true },
        { id: '__proto__', title: 'C', parent: 'client-1', indent: 2, order: 0, metadata: {}, new: true },
      ],
    },
  }
  const res = stubRes()
  await saveOutline(req, res)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(items.find((i) => i.id === 'item-a').description, 'New text')
  const idMap = res.body.data.idMap
  assert.ok(idMap && typeof idMap['client-1'] === 'string')
  const created = items.find((i) => i.id === idMap['client-1'])
  assert.ok(created, 'new item is saved under the mapped id')
  assert.equal(created.description, 'Child')
  assert.equal(created.parent, 'item-a')
  // reserved names are mapped like any other client id
  assert.ok(Object.prototype.hasOwnProperty.call(idMap, '__proto__'))
  const reserved = items.find((i) => i.id === idMap['__proto__'])
  assert.ok(reserved, 'item with a reserved client id is saved under the mapped id')
  assert.equal(reserved.parent, created.id)
})
