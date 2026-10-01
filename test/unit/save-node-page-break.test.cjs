'use strict'

// saveNode only writes content that follows a <page-break>. A body without
// one must be refused rather than answered with 200 and silently dropped.

const test = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const saveNode = require('../../src/siteRoutes/v1/routes/saveNode.js')

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

test('a body without a <page-break> is refused with 400 and nothing is written', async (t) => {
  let writes = 0
  const page = {
    id: 'item-1',
    title: 'Page',
    metadata: {},
    writeLocation: async () => {
      writes++
      return 1
    },
  }
  const site = { loadNode: () => page, manifest: { metadata: { site: {} } } }
  t.mock.method(HAXCMS, 'validateRequestToken', () => true)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
  const req = {
    headers: { 'x-haxcms-site-token': 'token' },
    body: { site: { name: 'demo' }, node: { id: 'item-1', body: '<p>Hello</p>' } },
  }
  const res = stubRes()
  await saveNode(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.data.message, /<page-break>/)
  assert.equal(writes, 0)
})
