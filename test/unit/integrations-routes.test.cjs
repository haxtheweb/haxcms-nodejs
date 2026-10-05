'use strict'

// Direct handler unit tests for src/systemRoutes/v1/integrations.js
// (appStoreProviderSearch): provider validation, API-key gating for keyed
// providers (readEffectiveApiKeys is stubbed at the module boundary BEFORE
// integrations.js is required, the same mutate-before-require pattern as
// appstore-blocks-discovery.test.cjs, because the machine's real config can
// carry live keys), forwarded search-param filtering (reserved/blocked
// params dropped, array values appended, body params merged), upstream
// request construction (URL + query string + API key param), and every
// upstream outcome branch (ok JSON passthrough, failed status with message
// and error.message shapes, non-JSON body, unreadable body, unreachable
// upstream) with globalThis.fetch stubbed per test via t.mock.method.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const apiKeysMod = require('../../src/lib/apiKeys.js')
// fixture key map returned by the stubbed readEffectiveApiKeys
let effectiveApiKeysFixture = {}
apiKeysMod.readEffectiveApiKeys = async () => effectiveApiKeysFixture

const { appStoreProviderSearch } = require('../../src/systemRoutes/v1/integrations.js')

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

function makeReq(params, query, body) {
  return {
    headers: {},
    params: params || {},
    query: query || {},
    body: body || {},
  }
}

// stub fetch and capture the upstream request
function stubFetch(t, response) {
  const captured = { url: null, options: null, calls: 0 }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured.url = url
    captured.options = options
    captured.calls++
    if (response instanceof Error) {
      throw response
    }
    return response
  })
  return captured
}

function upstreamResponse(status, ok, text) {
  return {
    status: status,
    ok: ok,
    text: async () => text,
  }
}

describe('integrations — appStoreProviderSearch', () => {
  test('a missing or unknown provider answers 400', async (t) => {
    stubFetch(t, null)
    const resMissing = stubRes()
    await appStoreProviderSearch(makeReq(), resMissing)
    assert.equal(resMissing.statusCode, 400)
    assert.equal(resMissing.body.message, 'Unsupported app store provider')

    const resUnknown = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'bogus' }), resUnknown)
    assert.equal(resUnknown.statusCode, 400)
    assert.equal(resUnknown.body.message, 'Unsupported app store provider')
  })

  test('a keyed provider without a stored key answers 400', async (t) => {
    effectiveApiKeysFixture = {}
    t.after(() => {
      effectiveApiKeysFixture = {}
    })
    stubFetch(t, null)
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'youtube' }, { q: 'cats' }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.message, 'Missing API key for youtube')
  })

  test('a keyed provider forwards the stored key and filtered search params', async (t) => {
    effectiveApiKeysFixture = { youtube: 'yt-secret' }
    t.after(() => {
      effectiveApiKeysFixture = {}
    })
    const captured = stubFetch(
      t,
      upstreamResponse(200, true, JSON.stringify({ items: [{ id: 'a' }] })),
    )
    const res = stubRes()
    await appStoreProviderSearch(
      makeReq(
        { provider: 'youtube' },
        // reserved and blocked auth params are dropped; array values append
        {
          q: 'cats',
          siteName: 'demo',
          jwt: 'x',
          token: 'y',
          key: 'client-key',
          api_key: 'client-key',
          maxResults: ['5', '10'],
        },
        { order: 'date' },
      ),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, { items: [{ id: 'a' }] })
    assert.equal(captured.calls, 1)
    // params serialize in insertion order: query params, then body params,
    // then the brokered API key
    assert.equal(
      captured.url,
      'https://www.googleapis.com/youtube/v3/search?q=cats&maxResults=5&maxResults=10&order=date&key=yt-secret',
    )
    assert.equal(captured.options.method, 'GET')
    assert.equal(captured.options.headers.Accept, 'application/json')
  })

  test('a keyless provider forwards the search without any key', async (t) => {
    const captured = stubFetch(
      t,
      upstreamResponse(200, true, JSON.stringify({ collection: { items: [] } })),
    )
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'nasa' }, { q: 'mars' }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(
      captured.url,
      'https://images-api.nasa.gov/search?q=mars',
    )
  })

  test('an unreachable upstream answers 502', async (t) => {
    effectiveApiKeysFixture = { youtube: 'yt-secret' }
    t.after(() => {
      effectiveApiKeysFixture = {}
    })
    stubFetch(t, new Error('network down'))
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'youtube' }, { q: 'x' }), res)
    assert.equal(res.statusCode, 502)
    assert.equal(res.body.message, 'Unable to reach upstream provider')
  })

  test('a failed upstream status forwards its status and message', async (t) => {
    effectiveApiKeysFixture = { youtube: 'yt-secret' }
    t.after(() => {
      effectiveApiKeysFixture = {}
    })
    stubFetch(
      t,
      upstreamResponse(403, false, JSON.stringify({ message: 'quota exceeded' })),
    )
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'youtube' }, { q: 'x' }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.status, 403)
    assert.equal(res.body.message, 'quota exceeded')
  })

  test('a failed upstream error.message shape is forwarded', async (t) => {
    stubFetch(
      t,
      upstreamResponse(400, false, JSON.stringify({ error: { message: 'bad request shape' } })),
    )
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'wikipedia' }, { q: 'x' }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.message, 'bad request shape')
  })

  test('a non-JSON upstream body answers 502', async (t) => {
    stubFetch(t, upstreamResponse(200, true, '<html>not json</html>'))
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'ccmixter' }, { q: 'x' }), res)
    assert.equal(res.statusCode, 502)
    assert.equal(res.body.message, 'Upstream provider response was not valid JSON')
  })

  test('an unreadable upstream body answers the non-JSON 502', async (t) => {
    stubFetch(t, {
      status: 200,
      ok: true,
      text: async () => {
        throw new Error('body read failed')
      },
    })
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'dailymotion' }, { q: 'x' }), res)
    assert.equal(res.statusCode, 502)
    assert.equal(res.body.message, 'Upstream provider response was not valid JSON')
  })

  test('an upstream status other than 200 still passes its JSON through', async (t) => {
    stubFetch(t, upstreamResponse(201, true, JSON.stringify({ created: true })))
    const res = stubRes()
    await appStoreProviderSearch(makeReq({ provider: 'sketchfab' }, { q: 'x' }), res)
    assert.equal(res.statusCode, 201)
    assert.deepEqual(res.body, { created: true })
  })

  test('a query with no forwarded params hits the bare endpoint URL', async (t) => {
    const captured = stubFetch(t, upstreamResponse(200, true, JSON.stringify({ ok: true })))
    const res = stubRes()
    // wikipedia is a keyless provider, so no key param is appended
    await appStoreProviderSearch(makeReq({ provider: 'wikipedia' }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(captured.url, 'https://en.wikipedia.org/w/api.php')
  })
})
