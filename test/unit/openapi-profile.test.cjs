'use strict'

// GET x/api/openapi (haxtheweb/issues#3104): anonymous callers get the
// public profile (only operations that need no login), the server URL is the
// base of the site the request came through, and the spec carries examples
// for agents. Mirrors PHP SiteRoutesOpenApiProfileTest.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const siteOpenapi = require('../../src/siteRoutes/discovery/openapi.js')

function stubRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(key, value) {
      this.headers[key] = value
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

function makeReq(overrides) {
  return Object.assign(
    {
      headers: { host: 'example.org', accept: 'application/json' },
      query: {},
      originalUrl: '/_sites/biology/x/api/openapi.json',
      url: '/_sites/biology/x/api/openapi.json',
      haxcmsSiteApiAuth: null,
    },
    overrides || {},
  )
}

async function fetchSpec(t, overrides) {
  t.mock.method(HAXCMS, 'getHAXCMSVersion', async () => '0.0.0-test')
  const res = stubRes()
  await siteOpenapi(makeReq(overrides), res)
  assert.equal(res.statusCode, 200)
  return JSON.parse(res.body)
}

function operationIds(spec) {
  const ids = []
  Object.keys(spec.paths).forEach((pathKey) => {
    const pathItem = spec.paths[pathKey]
    Object.keys(pathItem).forEach((key) => {
      if (pathItem[key] && pathItem[key].operationId) {
        ids.push(pathItem[key].operationId)
      }
    })
  })
  return ids
}

describe('site OpenAPI agent profile', () => {
  test('anonymous callers get only public operations', async (t) => {
    const spec = await fetchSpec(t)
    const ids = operationIds(spec)
    assert.ok(ids.indexOf('searchContent') !== -1)
    assert.ok(ids.indexOf('getItemByIdOrSlug') !== -1)
    assert.equal(ids.indexOf('createItem'), -1)
    assert.equal(ids.indexOf('updateItem'), -1)
    assert.equal(ids.indexOf('listFiles'), -1)
    assert.equal(spec['x-haxcms-profile'], 'public')
    assert.ok(spec.info.description.indexOf('?profile=full') !== -1)
    Object.keys(spec.paths).forEach((pathKey) => {
      const pathItem = spec.paths[pathKey]
      Object.keys(pathItem).forEach((key) => {
        const op = pathItem[key]
        if (op && op.operationId) {
          assert.ok(!op.security || op.security.length === 0, `${op.operationId} should be public`)
        }
      })
    })
  })

  test('?profile=full and logged-in callers get every operation', async (t) => {
    const full = operationIds(await fetchSpec(t, { query: { profile: 'full' } }))
    const authed = operationIds(
      await fetchSpec(t, { haxcmsSiteApiAuth: { authenticated: true, userName: 'tester' } }),
    )
    const anon = operationIds(await fetchSpec(t))
    assert.ok(full.indexOf('createItem') !== -1)
    assert.ok(authed.indexOf('createItem') !== -1)
    assert.equal(full.length, authed.length)
    assert.ok(full.length > anon.length)
  })

  test('the server URL is the base of the requesting site', async (t) => {
    const originalProtocol = HAXCMS.protocol
    const originalDomain = HAXCMS.domain
    HAXCMS.protocol = 'https'
    HAXCMS.domain = 'example.org'
    t.after(() => {
      HAXCMS.protocol = originalProtocol
      HAXCMS.domain = originalDomain
    })
    const spec = await fetchSpec(t)
    assert.equal(spec.servers[0].url, 'https://example.org/_sites/biology/')
  })

  test('the spec carries examples for agents', async (t) => {
    const spec = await fetchSpec(t)
    const search = spec.paths['/x/api/v1/search'].get.responses['200'].content['application/json']
    assert.equal(search.example.status, 200)
    assert.equal(spec.components.parameters.RequiredSearchQuery.example, 'photosynthesis')
    assert.equal(spec.components.parameters.IdOrSlug.example, 'getting-started')
  })
})
