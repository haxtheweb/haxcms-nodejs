'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { siteImport } = require('../../src/systemRoutes/v1/routes/siteImport.js')

// Minimal stub res that captures the response like Express would.
function stubRes() {
  return {
    statusCode: null,
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

// Minimal stub req with empty body, no files, no query — just enough for the
// dispatcher to read req.params.platform. Each converter validates its own
// input from here, so an empty body triggers each converter's own 400.
function stubReq(platform) {
  return {
    params: { platform: platform },
    body: {},
    headers: {},
    files: [],
    query: {},
  }
}

test('unknown platform returns 400 with Unsupported import platform error', async () => {
  const res = stubRes()
  await siteImport(stubReq('xyz'), res)
  assert.equal(res.statusCode, 400)
  assert.ok(res.body && res.body.data, 'response should have a data payload')
  assert.equal(res.body.data.error, 'Unsupported import platform "xyz"')
  assert.deepEqual(res.body.data.items, [])
})

test('empty params object yields empty platform string in the error', async () => {
  const res = stubRes()
  await siteImport({ params: {}, body: {}, headers: {} }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Unsupported import platform ""')
})

test('null req falls back to empty platform and returns the unsupported error', async () => {
  const res = stubRes()
  await siteImport(null, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Unsupported import platform ""')
})

test('undefined params.platform falls back to empty platform string', async () => {
  const res = stubRes()
  await siteImport({ params: { platform: undefined }, body: {}, headers: {} }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'Unsupported import platform ""')
})

// Every known platform must route away from the "Unsupported import platform"
// default branch. With an empty body each converter emits its own validation
// 400, which proves the dispatcher delegated rather than rejecting the platform.
const KNOWN_PLATFORMS = [
  'haxcms',
  'html',
  'pressbooks',
  'gitbook',
  'notion',
  'wordpress',
  'elmsln',
  'drupal-book',
  'plone',
]

for (const platform of KNOWN_PLATFORMS) {
  test(`known platform "${platform}" is not rejected as unsupported`, async () => {
    const res = stubRes()
    await siteImport(stubReq(platform), res)
    assert.ok(res.body && res.body.data, 'converter should produce a response')
    const err = res.body.data.error
    assert.ok(
      typeof err === 'string' && err.indexOf('Unsupported import platform') === -1,
      `platform "${platform}" must not produce the unsupported-platform error, got: ${String(err)}`,
    )
  })
}

test('html platform with empty body returns the html converter own validation error', async () => {
  const res = stubRes()
  await siteImport(stubReq('html'), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
})

test('platform is normalized to lowercase before dispatch (HTML routes to html converter)', async () => {
  const res = stubRes()
  await siteImport(stubReq('HTML'), res)
  assert.equal(res.statusCode, 400)
  // If uppercase were not normalized, this would be the unsupported error.
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
})

test('platform is trimmed before dispatch (" html " routes to html converter)', async () => {
  const res = stubRes()
  await siteImport(stubReq(' html '), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
})

test('haxcms platform with empty body returns the haxcms converter own validation error', async () => {
  const res = stubRes()
  await siteImport(stubReq('haxcms'), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.data.error, 'missing `repoUrl` param')
})

test('unsupported response shape includes empty items array and null filename', async () => {
  const res = stubRes()
  await siteImport(stubReq('totally-unknown'), res)
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.body.data.items, [])
  assert.equal(res.body.data.filename, null)
})
