'use strict'

// Unit tests for the pure / near-pure helpers exported from
// src/siteRoutes/v1/siteRouteUtils.js.
//
// Constraints honored (per repo conventions):
// - CommonJS .cjs, require(), node:test + node:assert/strict
// - NO optional chaining (?.) — explicit && guards only
// - globalThis instead of window
// - no edits to dist/ or node_modules/, no ubiquity/monorepo builds
//
// The siteRouteUtils module requires the HAXCMS singleton, whose constructor
// reads config and may refuse to start over default credentials when not in
// CLI mode. We set haxcms_middleware=node-cli before requiring, mirroring
// small-utils.test.cjs.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')

process.env.haxcms_middleware = 'node-cli'

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const siteRouteUtils = require('../../src/siteRoutes/v1/siteRouteUtils.js')

// ---------------------------------------------------------------------------
// stub helpers
// ---------------------------------------------------------------------------

function stubRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(payload) {
      this.body = payload
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
      return this
    },
  }
}

function makeSite(overrides) {
  const base = {
    manifest: {
      items: [],
      metadata: {
        site: {
          name: 'test-site',
          settings: { lang: 'en' },
        },
        theme: { element: 'clean-two' },
      },
    },
    siteDirectory: '/tmp/fake-site',
    basePath: '/',
    language: 'en-us',
  }
  if (overrides) {
    for (const key in overrides) {
      base[key] = overrides[key]
    }
  }
  return base
}

// ---------------------------------------------------------------------------
// getRequestPath
// ---------------------------------------------------------------------------

describe('getRequestPath', () => {
  test('prefers originalUrl and strips query string', () => {
    assert.equal(
      siteRouteUtils.getRequestPath({ originalUrl: '/x/api/v1/items?foo=bar' }),
      '/x/api/v1/items',
    )
  })

  test('falls back to req.url when originalUrl is empty', () => {
    assert.equal(
      siteRouteUtils.getRequestPath({ originalUrl: '', url: '/sites/a/b?q=1' }),
      '/sites/a/b',
    )
  })

  test('falls back to req.url when originalUrl is missing', () => {
    assert.equal(
      siteRouteUtils.getRequestPath({ url: '/foo' }),
      '/foo',
    )
  })

  test('falls back to req.route.path when url/originalUrl absent', () => {
    assert.equal(
      siteRouteUtils.getRequestPath({ route: { path: '/x/api/v1/items/:id' } }),
      '/x/api/v1/items/:id',
    )
  })

  test('returns empty string for null/empty inputs', () => {
    assert.equal(siteRouteUtils.getRequestPath(null), '')
    assert.equal(siteRouteUtils.getRequestPath({}), '')
    assert.equal(
      siteRouteUtils.getRequestPath({ originalUrl: '', url: '', route: { path: '' } }),
      '',
    )
  })
})

// ---------------------------------------------------------------------------
// getApiBasePathFromRequestPath
// ---------------------------------------------------------------------------

describe('getApiBasePathFromRequestPath', () => {
  test('extracts the /x/api prefix when present', () => {
    assert.equal(
      siteRouteUtils.getApiBasePathFromRequestPath('/foo/x/api/v1/items'),
      '/foo/x/api',
    )
  })

  test('returns /x/api default when path does not contain /x/api', () => {
    assert.equal(siteRouteUtils.getApiBasePathFromRequestPath('/other/path'), '/x/api')
  })

  test('returns /x/api for empty input', () => {
    assert.equal(siteRouteUtils.getApiBasePathFromRequestPath(''), '/x/api')
    assert.equal(siteRouteUtils.getApiBasePathFromRequestPath(), '/x/api')
  })

  test('handles trailing /x/api with no subpath', () => {
    assert.equal(
      siteRouteUtils.getApiBasePathFromRequestPath('/foo/x/api'),
      '/foo/x/api',
    )
  })
})

// ---------------------------------------------------------------------------
// getApiBasePath
// ---------------------------------------------------------------------------

describe('getApiBasePath', () => {
  test('composes getRequestPath + getApiBasePathFromRequestPath', () => {
    assert.equal(
      siteRouteUtils.getApiBasePath({ originalUrl: '/sub/x/api/v1?x=1' }),
      '/sub/x/api',
    )
  })

  test('defaults to /x/api when request path lacks /x/api', () => {
    assert.equal(siteRouteUtils.getApiBasePath({ url: '/foo' }), '/x/api')
  })

  test('handles null req', () => {
    assert.equal(siteRouteUtils.getApiBasePath(null), '/x/api')
  })
})

// ---------------------------------------------------------------------------
// getMultisiteSiteNameFromPath
// ---------------------------------------------------------------------------

describe('getMultisiteSiteNameFromPath', () => {
  test('returns the segment after the sites directory', () => {
    assert.equal(
      siteRouteUtils.getMultisiteSiteNameFromPath('/_sites/my-site/pages'),
      'my-site',
    )
  })

  test('returns empty string when sites directory not present', () => {
    assert.equal(siteRouteUtils.getMultisiteSiteNameFromPath('/other/path'), '')
  })

  test('returns empty string when sites directory is last segment', () => {
    assert.equal(siteRouteUtils.getMultisiteSiteNameFromPath('/_sites'), '')
  })

  test('decodes percent-encoded site names', () => {
    assert.equal(
      siteRouteUtils.getMultisiteSiteNameFromPath('/_sites/my%20site/pages'),
      'my site',
    )
  })

  test('handles empty/null input', () => {
    assert.equal(siteRouteUtils.getMultisiteSiteNameFromPath(''), '')
    assert.equal(siteRouteUtils.getMultisiteSiteNameFromPath(null), '')
  })
})

// ---------------------------------------------------------------------------
// normalizeManifestItems
// ---------------------------------------------------------------------------

describe('normalizeManifestItems', () => {
  test('returns [] when site/manifest/items missing', () => {
    assert.deepEqual(siteRouteUtils.normalizeManifestItems(null), [])
    assert.deepEqual(siteRouteUtils.normalizeManifestItems({}), [])
    assert.deepEqual(siteRouteUtils.normalizeManifestItems({ manifest: {} }), [])
    assert.deepEqual(
      siteRouteUtils.normalizeManifestItems({ manifest: { items: null } }),
      [],
    )
  })

  test('filters falsy entries from an array', () => {
    const items = [{ id: 'a' }, null, { id: 'b' }, undefined, { id: 'c' }]
    const out = siteRouteUtils.normalizeManifestItems({ manifest: { items: items } })
    assert.equal(out.length, 3)
    assert.deepEqual(out.map((i) => i.id), ['a', 'b', 'c'])
  })

  test('collects values when items is an object map', () => {
    const items = { a: { id: 'a' }, b: { id: 'b' }, c: null }
    const out = siteRouteUtils.normalizeManifestItems({ manifest: { items: items } })
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((i) => i.id), ['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// getOrderedItems
// ---------------------------------------------------------------------------

describe('getOrderedItems', () => {
  test('returns normalized items when no orderTree', () => {
    const site = { manifest: { items: [{ id: 'a' }, null, { id: 'b' }] } }
    const out = siteRouteUtils.getOrderedItems(site)
    assert.equal(out.length, 2)
  })

  test('calls manifest.orderTree when it is a function', () => {
    let calledWith = null
    const site = {
      manifest: {
        items: [{ id: 'a' }, { id: 'b' }],
        orderTree(items) {
          calledWith = items
          return [{ id: 'b' }, { id: 'a' }]
        },
      },
    }
    const out = siteRouteUtils.getOrderedItems(site)
    assert.deepEqual(out.map((i) => i.id), ['b', 'a'])
    assert.equal(calledWith.length, 2)
  })

  test('falls back to normalized items when orderTree throws', () => {
    const site = {
      manifest: {
        items: [{ id: 'a' }],
        orderTree() {
          throw new Error('boom')
        },
      },
    }
    const out = siteRouteUtils.getOrderedItems(site)
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'a')
  })

  test('returns [] for null site', () => {
    assert.deepEqual(siteRouteUtils.getOrderedItems(null), [])
  })
})

// ---------------------------------------------------------------------------
// normalizeTagList
// ---------------------------------------------------------------------------

describe('normalizeTagList', () => {
  test('trims and filters an array', () => {
    assert.deepEqual(
      siteRouteUtils.normalizeTagList(['  a ', '', 'b', null, 'c']),
      ['a', 'b', 'c'],
    )
  })

  test('splits a comma-separated string', () => {
    assert.deepEqual(
      siteRouteUtils.normalizeTagList('a, b , ,c'),
      ['a', 'b', 'c'],
    )
  })

  test('returns [] for non-array/non-string', () => {
    assert.deepEqual(siteRouteUtils.normalizeTagList(null), [])
    assert.deepEqual(siteRouteUtils.normalizeTagList(42), [])
    assert.deepEqual(siteRouteUtils.normalizeTagList({}), [])
  })

  test('returns [] for empty string', () => {
    assert.deepEqual(siteRouteUtils.normalizeTagList(''), [])
  })
})

// ---------------------------------------------------------------------------
// toIsoDateFromUnixTime
// ---------------------------------------------------------------------------

describe('toIsoDateFromUnixTime', () => {
  test('converts a valid unix timestamp to ISO string', () => {
    // 1700000000 -> 2023-11-14T22:13:20.000Z
    assert.equal(
      siteRouteUtils.toIsoDateFromUnixTime(1700000000),
      '2023-11-14T22:13:20.000Z',
    )
  })

  test('accepts numeric strings', () => {
    assert.equal(
      siteRouteUtils.toIsoDateFromUnixTime('1700000000'),
      '2023-11-14T22:13:20.000Z',
    )
  })

  test('returns null for NaN', () => {
    assert.equal(siteRouteUtils.toIsoDateFromUnixTime('abc'), null)
  })

  test('returns null for zero and negative', () => {
    assert.equal(siteRouteUtils.toIsoDateFromUnixTime(0), null)
    assert.equal(siteRouteUtils.toIsoDateFromUnixTime(-1), null)
  })

  test('returns null for null/undefined', () => {
    assert.equal(siteRouteUtils.toIsoDateFromUnixTime(null), null)
    assert.equal(siteRouteUtils.toIsoDateFromUnixTime(undefined), null)
  })
})

// ---------------------------------------------------------------------------
// getSiteLanguage
// ---------------------------------------------------------------------------

describe('getSiteLanguage', () => {
  test('reads manifest.metadata.site.settings.lang', () => {
    const site = makeSite()
    site.manifest.metadata.site.settings.lang = 'fr'
    assert.equal(siteRouteUtils.getSiteLanguage(site), 'fr')
  })

  test('falls back to site.language', () => {
    const site = makeSite()
    site.manifest.metadata.site.settings = {}
    site.language = 'de'
    assert.equal(siteRouteUtils.getSiteLanguage(site), 'de')
  })

  test('defaults to en', () => {
    assert.equal(siteRouteUtils.getSiteLanguage(null), 'en')
    assert.equal(siteRouteUtils.getSiteLanguage({}), 'en')
    assert.equal(siteRouteUtils.getSiteLanguage({ language: '' }), 'en')
  })
})

// ---------------------------------------------------------------------------
// getSiteTheme
// ---------------------------------------------------------------------------

describe('getSiteTheme', () => {
  test('reads manifest.metadata.theme.element', () => {
    const site = makeSite()
    assert.equal(siteRouteUtils.getSiteTheme(site), 'clean-two')
  })

  test('returns null when theme.element missing', () => {
    const site = makeSite()
    site.manifest.metadata.theme = {}
    assert.equal(siteRouteUtils.getSiteTheme(site), null)
  })

  test('returns null for null/empty site', () => {
    assert.equal(siteRouteUtils.getSiteTheme(null), null)
    assert.equal(siteRouteUtils.getSiteTheme({}), null)
  })
})

// ---------------------------------------------------------------------------
// getSiteBasePath
// ---------------------------------------------------------------------------

describe('getSiteBasePath', () => {
  let saved

  beforeEach(() => {
    saved = {
      basePath: HAXCMS.basePath,
      sitesDirectory: HAXCMS.sitesDirectory,
    }
  })

  afterEach(() => {
    HAXCMS.basePath = saved.basePath
    HAXCMS.sitesDirectory = saved.sitesDirectory
  })

  test('returns basePath + siteName/ when site.basePath is not multisite', () => {
    HAXCMS.basePath = '/'
    HAXCMS.sitesDirectory = '_sites'
    const site = makeSite()
    assert.equal(siteRouteUtils.getSiteBasePath(site), '/test-site/')
  })

  test('returns basePath + sitesDirectory/siteName/ when site.basePath is multisite', () => {
    HAXCMS.basePath = '/'
    HAXCMS.sitesDirectory = '_sites'
    const site = makeSite()
    site.basePath = '/var/www/_sites/test-site'
    assert.equal(
      siteRouteUtils.getSiteBasePath(site),
      '/_sites/test-site/',
    )
  })

  test('normalizes a non-root basePath with trailing slash', () => {
    HAXCMS.basePath = '/app'
    HAXCMS.sitesDirectory = '_sites'
    const site = makeSite()
    assert.equal(siteRouteUtils.getSiteBasePath(site), '/app/test-site/')
  })

  test('falls back to HAXCMS.basePath when site has no metadata.site.name', () => {
    HAXCMS.basePath = '/'
    assert.equal(siteRouteUtils.getSiteBasePath(null), '/')
    assert.equal(siteRouteUtils.getSiteBasePath({}), '/')
  })
})

// ---------------------------------------------------------------------------
// ensureRequestQueryObject
// ---------------------------------------------------------------------------

describe('ensureRequestQueryObject', () => {
  test('returns existing query object', () => {
    const req = { query: { foo: 'bar' } }
    assert.equal(siteRouteUtils.ensureRequestQueryObject(req), req.query)
  })

  test('creates query={} when missing or non-object', () => {
    const req1 = {}
    siteRouteUtils.ensureRequestQueryObject(req1)
    assert.deepEqual(req1.query, {})

    const req2 = { query: 'notobj' }
    siteRouteUtils.ensureRequestQueryObject(req2)
    assert.deepEqual(req2.query, {})

    const req3 = { query: null }
    siteRouteUtils.ensureRequestQueryObject(req3)
    assert.deepEqual(req3.query, {})
  })

  test('preserves array query is replaced (array is object but treated as non-object here? array IS object)', () => {
    // ensureRequestQueryObject only checks typeof === 'object', so arrays pass
    const req = { query: ['a', 'b'] }
    const out = siteRouteUtils.ensureRequestQueryObject(req)
    assert.equal(out, req.query)
    assert.ok(Array.isArray(out))
  })
})

// ---------------------------------------------------------------------------
// ensureRequestBodyObject
// ---------------------------------------------------------------------------

describe('ensureRequestBodyObject', () => {
  test('returns existing body object', () => {
    const req = { body: { foo: 'bar' } }
    assert.equal(siteRouteUtils.ensureRequestBodyObject(req), req.body)
  })

  test('creates body={} when missing', () => {
    const req = {}
    siteRouteUtils.ensureRequestBodyObject(req)
    assert.deepEqual(req.body, {})
  })

  test('replaces body when it is an array', () => {
    const req = { body: ['a'] }
    siteRouteUtils.ensureRequestBodyObject(req)
    assert.deepEqual(req.body, {})
  })

  test('replaces body when non-object', () => {
    const req = { body: 'string' }
    siteRouteUtils.ensureRequestBodyObject(req)
    assert.deepEqual(req.body, {})
  })
})

// ---------------------------------------------------------------------------
// getRequestHeaderValue
// ---------------------------------------------------------------------------

describe('getRequestHeaderValue', () => {
  test('returns trimmed string header (case-insensitive name)', () => {
    const req = { headers: { 'content-type': ' application/json ' } }
    assert.equal(
      siteRouteUtils.getRequestHeaderValue(req, 'Content-Type'),
      'application/json',
    )
  })

  test('returns first element of array header', () => {
    const req = { headers: { accept: ['text/html', 'application/json'] } }
    assert.equal(siteRouteUtils.getRequestHeaderValue(req, 'accept'), 'text/html')
  })

  test('returns empty string for empty array', () => {
    const req = { headers: { accept: [] } }
    assert.equal(siteRouteUtils.getRequestHeaderValue(req, 'accept'), '')
  })

  test('returns empty string for missing header', () => {
    const req = { headers: {} }
    assert.equal(siteRouteUtils.getRequestHeaderValue(req, 'accept'), '')
  })

  test('returns empty string for null/empty req', () => {
    assert.equal(siteRouteUtils.getRequestHeaderValue(null, 'accept'), '')
    assert.equal(siteRouteUtils.getRequestHeaderValue({}, 'accept'), '')
  })

  test('returns empty string for empty header name', () => {
    const req = { headers: { accept: 'x' } }
    assert.equal(siteRouteUtils.getRequestHeaderValue(req, ''), '')
  })
})

// ---------------------------------------------------------------------------
// getSiteNameFromResolvedSite
// ---------------------------------------------------------------------------

describe('getSiteNameFromResolvedSite', () => {
  test('returns trimmed manifest.metadata.site.name', () => {
    const site = makeSite()
    site.manifest.metadata.site.name = '  my-site  '
    assert.equal(siteRouteUtils.getSiteNameFromResolvedSite(site), 'my-site')
  })

  test('returns empty string when name is missing or not string', () => {
    const site = makeSite()
    site.manifest.metadata.site.name = 123
    assert.equal(siteRouteUtils.getSiteNameFromResolvedSite(site), '')
  })

  test('returns empty string for null/empty site', () => {
    assert.equal(siteRouteUtils.getSiteNameFromResolvedSite(null), '')
    assert.equal(siteRouteUtils.getSiteNameFromResolvedSite({}), '')
  })
})

// ---------------------------------------------------------------------------
// decodePathToken
// ---------------------------------------------------------------------------

describe('decodePathToken', () => {
  test('decodes percent-encoded tokens', () => {
    assert.equal(siteRouteUtils.decodePathToken('my%20page'), 'my page')
  })

  test('strips leading slashes after normalization', () => {
    assert.equal(siteRouteUtils.decodePathToken('/foo/bar'), 'foo/bar')
  })

  test('returns empty string for empty/null', () => {
    assert.equal(siteRouteUtils.decodePathToken(''), '')
    assert.equal(siteRouteUtils.decodePathToken(null), '')
    assert.equal(siteRouteUtils.decodePathToken(), '')
  })

  test('handles already-decoded values', () => {
    assert.equal(siteRouteUtils.decodePathToken('simple-path'), 'simple-path')
  })
})

// ---------------------------------------------------------------------------
// normalizeOperationName
// ---------------------------------------------------------------------------

describe('normalizeOperationName', () => {
  test('trims and lowercases', () => {
    assert.equal(siteRouteUtils.normalizeOperationName('  UpdatePage  '), 'updatepage')
  })

  test('returns empty string for null/undefined', () => {
    assert.equal(siteRouteUtils.normalizeOperationName(null), '')
    assert.equal(siteRouteUtils.normalizeOperationName(undefined), '')
    assert.equal(siteRouteUtils.normalizeOperationName(), '')
  })
})

// ---------------------------------------------------------------------------
// getQueryValue
// ---------------------------------------------------------------------------

describe('getQueryValue', () => {
  test('returns the value when key present', () => {
    const req = { query: { format: 'json', empty: '' } }
    assert.equal(siteRouteUtils.getQueryValue(req, 'format', 'md'), 'json')
  })

  test('returns fallback when key absent', () => {
    const req = { query: {} }
    assert.equal(siteRouteUtils.getQueryValue(req, 'format', 'md'), 'md')
  })

  test('returns value even when it is empty string (hasOwn)', () => {
    const req = { query: { empty: '' } }
    assert.equal(siteRouteUtils.getQueryValue(req, 'empty', 'fallback'), '')
  })

  test('handles missing req.query', () => {
    assert.equal(siteRouteUtils.getQueryValue({}, 'format', 'md'), 'md')
    assert.equal(siteRouteUtils.getQueryValue(null, 'format', 'md'), 'md')
  })
})

// ---------------------------------------------------------------------------
// getCsvQuery
// ---------------------------------------------------------------------------

describe('getCsvQuery', () => {
  test('splits a comma-separated string', () => {
    const req = { query: { tags: 'a, b , ,c' } }
    assert.deepEqual(siteRouteUtils.getCsvQuery(req, 'tags'), ['a', 'b', 'c'])
  })

  test('trims and filters an array value', () => {
    const req = { query: { tags: ['  a ', '', 'b'] } }
    assert.deepEqual(siteRouteUtils.getCsvQuery(req, 'tags'), ['a', 'b'])
  })

  test('returns [] when key missing', () => {
    const req = { query: {} }
    assert.deepEqual(siteRouteUtils.getCsvQuery(req, 'tags'), [])
  })

  test('returns [] for non-string non-array value', () => {
    const req = { query: { tags: 42 } }
    assert.deepEqual(siteRouteUtils.getCsvQuery(req, 'tags'), [])
  })

  test('returns [] for empty string value', () => {
    const req = { query: { tags: '' } }
    assert.deepEqual(siteRouteUtils.getCsvQuery(req, 'tags'), [])
  })
})

// ---------------------------------------------------------------------------
// getNumberQuery
// ---------------------------------------------------------------------------

describe('getNumberQuery', () => {
  test('parses an integer string', () => {
    const req = { query: { 'page.limit': '25' } }
    assert.equal(siteRouteUtils.getNumberQuery(req, 'page.limit', 10), 25)
  })

  test('returns fallback for non-numeric', () => {
    const req = { query: { 'page.limit': 'abc' } }
    assert.equal(siteRouteUtils.getNumberQuery(req, 'page.limit', 10), 10)
  })

  test('returns fallback when key missing', () => {
    const req = { query: {} }
    assert.equal(siteRouteUtils.getNumberQuery(req, 'page.limit', 10), 10)
  })

  test('clamps below min', () => {
    const req = { query: { 'page.limit': '0' } }
    assert.equal(siteRouteUtils.getNumberQuery(req, 'page.limit', 10, 1, 100), 1)
  })

  test('clamps above max', () => {
    const req = { query: { 'page.limit': '999' } }
    assert.equal(siteRouteUtils.getNumberQuery(req, 'page.limit', 10, 1, 100), 100)
  })

  test('parses numeric value that is already a number', () => {
    const req = { query: { 'page.limit': 50 } }
    assert.equal(siteRouteUtils.getNumberQuery(req, 'page.limit', 10), 50)
  })
})

// ---------------------------------------------------------------------------
// getBooleanQuery
// ---------------------------------------------------------------------------

describe('getBooleanQuery', () => {
  test('returns parsed boolean when key present', () => {
    const req = { query: { published: 'true' } }
    assert.equal(siteRouteUtils.getBooleanQuery(req, 'published', null), true)
  })

  test('returns fallback when key absent', () => {
    const req = { query: {} }
    assert.equal(siteRouteUtils.getBooleanQuery(req, 'published', null), null)
  })
})

// ---------------------------------------------------------------------------
// parseBooleanFromInput
// ---------------------------------------------------------------------------

describe('parseBooleanFromInput', () => {
  test('returns fallback for null/undefined/empty', () => {
    assert.equal(siteRouteUtils.parseBooleanFromInput(null, 'fb'), 'fb')
    assert.equal(siteRouteUtils.parseBooleanFromInput(undefined, 'fb'), 'fb')
    assert.equal(siteRouteUtils.parseBooleanFromInput('', 'fb'), 'fb')
  })

  test('passes through booleans', () => {
    assert.equal(siteRouteUtils.parseBooleanFromInput(true, null), true)
    assert.equal(siteRouteUtils.parseBooleanFromInput(false, null), false)
  })

  test('treats non-zero numbers as true, zero as false', () => {
    assert.equal(siteRouteUtils.parseBooleanFromInput(1, null), true)
    assert.equal(siteRouteUtils.parseBooleanFromInput(5, null), true)
    assert.equal(siteRouteUtils.parseBooleanFromInput(0, null), false)
  })

  test('recognizes truthy strings', () => {
    assert.equal(siteRouteUtils.parseBooleanFromInput('1', null), true)
    assert.equal(siteRouteUtils.parseBooleanFromInput('true', null), true)
    assert.equal(siteRouteUtils.parseBooleanFromInput('YES', null), true)
    assert.equal(siteRouteUtils.parseBooleanFromInput('On', null), true)
  })

  test('recognizes falsey strings', () => {
    assert.equal(siteRouteUtils.parseBooleanFromInput('0', null), false)
    assert.equal(siteRouteUtils.parseBooleanFromInput('false', null), false)
    assert.equal(siteRouteUtils.parseBooleanFromInput('No', null), false)
    assert.equal(siteRouteUtils.parseBooleanFromInput('off', null), false)
  })

  test('returns fallback for unrecognized strings', () => {
    assert.equal(siteRouteUtils.parseBooleanFromInput('maybe', 'fb'), 'fb')
  })
})

// ---------------------------------------------------------------------------
// isPlainObject
// ---------------------------------------------------------------------------

describe('isPlainObject', () => {
  test('true for plain objects', () => {
    assert.equal(siteRouteUtils.isPlainObject({}), true)
    assert.equal(siteRouteUtils.isPlainObject({ a: 1 }), true)
  })

  test('false for null, arrays, primitives', () => {
    assert.equal(siteRouteUtils.isPlainObject(null), false)
    assert.equal(siteRouteUtils.isPlainObject(undefined), false)
    assert.equal(siteRouteUtils.isPlainObject([]), false)
    assert.equal(siteRouteUtils.isPlainObject('s'), false)
    assert.equal(siteRouteUtils.isPlainObject(42), false)
  })
})

// ---------------------------------------------------------------------------
// hasOnlyAllowedKeys
// ---------------------------------------------------------------------------

describe('hasOnlyAllowedKeys', () => {
  test('true when all keys are in the allowed set', () => {
    const allowed = new Set(['a', 'b'])
    assert.equal(siteRouteUtils.hasOnlyAllowedKeys({ a: 1, b: 2 }, allowed), true)
  })

  test('false when a key is not in the allowed set', () => {
    const allowed = new Set(['a'])
    assert.equal(siteRouteUtils.hasOnlyAllowedKeys({ a: 1, c: 2 }, allowed), false)
  })

  test('true for empty object', () => {
    assert.equal(siteRouteUtils.hasOnlyAllowedKeys({}, new Set()), true)
  })

  test('false for non-object input', () => {
    assert.equal(siteRouteUtils.hasOnlyAllowedKeys(null, new Set()), false)
    assert.equal(siteRouteUtils.hasOnlyAllowedKeys([], new Set()), false)
  })
})

// ---------------------------------------------------------------------------
// hasOwn
// ---------------------------------------------------------------------------

describe('hasOwn', () => {
  test('true for own properties', () => {
    assert.equal(siteRouteUtils.hasOwn({ a: 1 }, 'a'), true)
  })

  test('false for inherited properties', () => {
    const obj = Object.create({ inherited: 1 })
    assert.equal(siteRouteUtils.hasOwn(obj, 'inherited'), false)
  })

  test('false for missing keys', () => {
    assert.equal(siteRouteUtils.hasOwn({}, 'a'), false)
  })
})

// ---------------------------------------------------------------------------
// normalizeString
// ---------------------------------------------------------------------------

describe('normalizeString', () => {
  test('returns empty string for null/undefined', () => {
    assert.equal(siteRouteUtils.normalizeString(null), '')
    assert.equal(siteRouteUtils.normalizeString(undefined), '')
  })

  test('stringifies other values', () => {
    assert.equal(siteRouteUtils.normalizeString(42), '42')
    assert.equal(siteRouteUtils.normalizeString(true), 'true')
    assert.equal(siteRouteUtils.normalizeString('hi'), 'hi')
  })
})

// ---------------------------------------------------------------------------
// ensureSiteMetadataContainers
// ---------------------------------------------------------------------------

describe('ensureSiteMetadataContainers', () => {
  test('creates metadata, site, and settings containers', () => {
    const site = { manifest: {} }
    siteRouteUtils.ensureSiteMetadataContainers(site)
    assert.deepEqual(site.manifest.metadata, { site: { settings: {} } })
  })

  test('preserves existing containers', () => {
    const site = { manifest: { metadata: { site: { settings: { lang: 'fr' } } } } }
    siteRouteUtils.ensureSiteMetadataContainers(site)
    assert.equal(site.manifest.metadata.site.settings.lang, 'fr')
  })

  test('creates settings when metadata.site exists but settings missing', () => {
    const site = { manifest: { metadata: { site: {} } } }
    siteRouteUtils.ensureSiteMetadataContainers(site)
    assert.deepEqual(site.manifest.metadata.site.settings, {})
  })
})

// ---------------------------------------------------------------------------
// assertSiteFeature
// ---------------------------------------------------------------------------

describe('assertSiteFeature', () => {
  test('returns false and sends 400 when site is null', () => {
    const res = stubRes()
    const ok = siteRouteUtils.assertSiteFeature(null, res, 'uploadMedia', 'nope')
    assert.equal(ok, false)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.status, 400)
    assert.equal(res.body.data.message, 'Site is required')
  })

  test('returns false and sends 400 when site has no manifest', () => {
    const res = stubRes()
    const ok = siteRouteUtils.assertSiteFeature({}, res, 'uploadMedia', 'nope')
    assert.equal(ok, false)
    assert.equal(res.statusCode, 400)
  })

  test('returns false and sends 403 when platform disallows the feature', () => {
    const res = stubRes()
    const site = {
      manifest: {
        metadata: {
          platform: { uploadMedia: false },
        },
      },
    }
    const ok = siteRouteUtils.assertSiteFeature(site, res, 'uploadMedia', 'disabled')
    assert.equal(ok, false)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'disabled')
  })

  test('returns true when platform allows the feature', () => {
    const res = stubRes()
    const site = {
      manifest: {
        metadata: {
          platform: { uploadMedia: true },
        },
      },
    }
    const ok = siteRouteUtils.assertSiteFeature(site, res, 'uploadMedia', 'disabled')
    assert.equal(ok, true)
    assert.equal(res.statusCode, null)
  })

  test('returns true when no platform metadata is present (default allow)', () => {
    const res = stubRes()
    const site = { manifest: { metadata: {} } }
    const ok = siteRouteUtils.assertSiteFeature(site, res, 'uploadMedia', 'disabled')
    assert.equal(ok, true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSortTokens
// ---------------------------------------------------------------------------

describe('normalizeSortTokens', () => {
  test('parses ascending and descending tokens', () => {
    const tokens = siteRouteUtils.normalizeSortTokens('-title,created')
    assert.deepEqual(tokens, [
      { key: 'title', desc: true },
      { key: 'created', desc: false },
    ])
  })

  test('falls back to defaultSort when sortValue is empty', () => {
    const tokens = siteRouteUtils.normalizeSortTokens('', '-order')
    assert.deepEqual(tokens, [{ key: 'order', desc: true }])
  })

  test('returns [] when both sortValue and defaultSort are empty', () => {
    assert.deepEqual(siteRouteUtils.normalizeSortTokens('', ''), [])
    assert.deepEqual(siteRouteUtils.normalizeSortTokens(), [])
  })

  test('trims and filters empty parts', () => {
    const tokens = siteRouteUtils.normalizeSortTokens(' a , , -b ')
    assert.deepEqual(tokens, [
      { key: 'a', desc: false },
      { key: 'b', desc: true },
    ])
  })

  test('drops tokens that become empty after stripping -', () => {
    const tokens = siteRouteUtils.normalizeSortTokens('-,a')
    assert.deepEqual(tokens, [{ key: 'a', desc: false }])
  })
})

// ---------------------------------------------------------------------------
// sortRecords
// ---------------------------------------------------------------------------

describe('sortRecords', () => {
  const records = [
    { id: 1, title: 'banana', metadata: { created: 3 } },
    { id: 2, title: 'apple', metadata: { created: 1 } },
    { id: 3, title: 'cherry', metadata: { created: 2 } },
  ]

  test('sorts ascending by a top-level key', () => {
    const out = siteRouteUtils.sortRecords(records, 'title')
    assert.deepEqual(out.map((r) => r.id), [2, 1, 3])
  })

  test('sorts descending by a top-level key', () => {
    const out = siteRouteUtils.sortRecords(records, '-title')
    assert.deepEqual(out.map((r) => r.id), [3, 1, 2])
  })

  test('falls back to metadata.<key> for flat keys', () => {
    const out = siteRouteUtils.sortRecords(records, 'created')
    assert.deepEqual(out.map((r) => r.id), [2, 3, 1])
  })

  test('returns a copy when no sort tokens', () => {
    const out = siteRouteUtils.sortRecords(records, '')
    assert.notEqual(out, records)
    assert.deepEqual(out.map((r) => r.id), [1, 2, 3])
  })

  test('does not mutate the input array', () => {
    const copy = records.slice()
    siteRouteUtils.sortRecords(records, '-title')
    assert.deepEqual(records.map((r) => r.id), copy.map((r) => r.id))
  })

  test('uses defaultSort when sortValue empty', () => {
    const out = siteRouteUtils.sortRecords(records, '', '-title')
    assert.deepEqual(out.map((r) => r.id), [3, 1, 2])
  })

  test('handles empty records', () => {
    assert.deepEqual(siteRouteUtils.sortRecords([], 'title'), [])
  })
})

// ---------------------------------------------------------------------------
// paginateRecords
// ---------------------------------------------------------------------------

describe('paginateRecords', () => {
  const records = []
  for (let i = 0; i < 10; i++) {
    records.push({ id: i })
  }

  test('returns a page with default limit and offset 0', () => {
    const req = { query: {} }
    const out = siteRouteUtils.paginateRecords(records, req)
    assert.equal(out.page.limit, 25)
    assert.equal(out.page.offset, 0)
    assert.equal(out.page.total, 10)
    assert.equal(out.records.length, 10)
  })

  test('respects page.limit query', () => {
    const req = { query: { 'page.limit': '3' } }
    const out = siteRouteUtils.paginateRecords(records, req)
    assert.equal(out.page.limit, 3)
    assert.equal(out.records.length, 3)
    assert.deepEqual(out.records.map((r) => r.id), [0, 1, 2])
  })

  test('respects page.offset query', () => {
    const req = { query: { 'page.limit': '3', 'page.offset': '5' } }
    const out = siteRouteUtils.paginateRecords(records, req)
    assert.deepEqual(out.records.map((r) => r.id), [5, 6, 7])
  })

  test('clamps limit to min 1', () => {
    const req = { query: { 'page.limit': '0' } }
    const out = siteRouteUtils.paginateRecords(records, req, 25, 200)
    assert.equal(out.page.limit, 1)
  })

  test('clamps limit to maxLimit', () => {
    const req = { query: { 'page.limit': '1000' } }
    const out = siteRouteUtils.paginateRecords(records, req, 25, 50)
    assert.equal(out.page.limit, 50)
  })

  test('handles empty records', () => {
    const out = siteRouteUtils.paginateRecords([], { query: {} })
    assert.equal(out.page.total, 0)
    assert.deepEqual(out.records, [])
  })
})

// ---------------------------------------------------------------------------
// projectRecord
// ---------------------------------------------------------------------------

describe('projectRecord', () => {
  test('returns record unchanged when fields is empty', () => {
    const record = { a: 1, b: 2 }
    assert.equal(siteRouteUtils.projectRecord(record, []), record)
  })

  test('returns record unchanged when fields is not an array', () => {
    const record = { a: 1 }
    assert.equal(siteRouteUtils.projectRecord(record, null), record)
  })

  test('picks a flat field', () => {
    const record = { a: 1, b: 2, c: 3 }
    assert.deepEqual(siteRouteUtils.projectRecord(record, ['a', 'c']), { a: 1, c: 3 })
  })

  test('picks a nested field and rebuilds the path', () => {
    const record = { a: { b: { c: 1 } }, d: 2 }
    assert.deepEqual(
      siteRouteUtils.projectRecord(record, ['a.b.c']),
      { a: { b: { c: 1 } } },
    )
  })

  test('skips undefined fields', () => {
    const record = { a: 1 }
    assert.deepEqual(siteRouteUtils.projectRecord(record, ['a', 'missing']), { a: 1 })
  })

  test('returns record unchanged for null/non-object record', () => {
    assert.equal(siteRouteUtils.projectRecord(null, ['a']), null)
    assert.equal(siteRouteUtils.projectRecord('s', ['a']), 's')
  })
})

// ---------------------------------------------------------------------------
// projectCollection
// ---------------------------------------------------------------------------

describe('projectCollection', () => {
  test('maps projectRecord over the array', () => {
    const records = [{ a: 1, b: 2 }, { a: 3, b: 4 }]
    assert.deepEqual(
      siteRouteUtils.projectCollection(records, ['a']),
      [{ a: 1 }, { a: 3 }],
    )
  })

  test('returns records unchanged when fields is empty', () => {
    const records = [{ a: 1 }]
    assert.equal(siteRouteUtils.projectCollection(records, []), records)
  })
})

// ---------------------------------------------------------------------------
// findItemByIdOrSlug
// ---------------------------------------------------------------------------

describe('findItemByIdOrSlug', () => {
  test('returns null for null site or missing idOrSlug', () => {
    assert.equal(siteRouteUtils.findItemByIdOrSlug(null, 'x'), null)
    assert.equal(siteRouteUtils.findItemByIdOrSlug(makeSite(), null), null)
    assert.equal(siteRouteUtils.findItemByIdOrSlug(makeSite(), ''), null)
  })

  test('uses manifest.getItemById when available', () => {
    const site = makeSite()
    const target = { id: 'item-1', slug: 'first' }
    site.manifest.getItemById = function (id) {
      return id === 'item-1' ? target : null
    }
    assert.equal(siteRouteUtils.findItemByIdOrSlug(site, 'item-1'), target)
  })

  test('uses manifest.getItemByProperty(slug) when getItemById misses', () => {
    const site = makeSite()
    const target = { id: 'item-1', slug: 'first' }
    site.manifest.getItemById = function () { return null }
    site.manifest.getItemByProperty = function (prop, val) {
      if (prop === 'slug' && val === 'first') {
        return target
      }
      return null
    }
    assert.equal(siteRouteUtils.findItemByIdOrSlug(site, 'first'), target)
  })

  test('falls back to scanning normalizeManifestItems', () => {
    const site = makeSite()
    site.manifest.items = [
      { id: 'a', slug: 'alpha' },
      { id: 'b', slug: 'beta' },
    ]
    assert.equal(siteRouteUtils.findItemByIdOrSlug(site, 'b').id, 'b')
    assert.equal(siteRouteUtils.findItemByIdOrSlug(site, 'beta').id, 'b')
  })

  test('returns null when nothing matches', () => {
    const site = makeSite()
    site.manifest.items = [{ id: 'a', slug: 'alpha' }]
    assert.equal(siteRouteUtils.findItemByIdOrSlug(site, 'zzz'), null)
  })

  test('decodes percent-encoded idOrSlug', () => {
    const site = makeSite()
    const target = { id: 'my id', slug: 'my-slug' }
    site.manifest.getItemById = function (id) {
      return id === 'my id' ? target : null
    }
    assert.equal(siteRouteUtils.findItemByIdOrSlug(site, 'my%20id'), target)
  })
})

// ---------------------------------------------------------------------------
// getItemContent
// ---------------------------------------------------------------------------

describe('getItemContent', () => {
  test('returns empty string for null site or item', async () => {
    assert.equal(await siteRouteUtils.getItemContent(null, { id: 'x' }), '')
    assert.equal(await siteRouteUtils.getItemContent(makeSite(), null), '')
  })

  test('returns empty string when item has no id', async () => {
    assert.equal(await siteRouteUtils.getItemContent(makeSite(), { slug: 'x' }), '')
  })

  test('returns empty string when site has no loadNode', async () => {
    const site = makeSite()
    assert.equal(await siteRouteUtils.getItemContent(site, { id: 'x' }), '')
  })

  test('returns empty string when loadNode returns falsy', async () => {
    const site = makeSite()
    site.loadNode = function () { return false }
    assert.equal(await siteRouteUtils.getItemContent(site, { id: 'x' }), '')
  })

  test('returns empty string when getPageContent is missing', async () => {
    const site = makeSite()
    site.loadNode = function () { return { location: 'pages/x/index.html' } }
    assert.equal(await siteRouteUtils.getItemContent(site, { id: 'x' }), '')
  })

  test('returns content string from getPageContent', async () => {
    const site = makeSite()
    site.loadNode = function () { return { location: 'pages/x/index.html' } }
    site.getPageContent = async function () { return '<p>hello</p>' }
    assert.equal(await siteRouteUtils.getItemContent(site, { id: 'x' }), '<p>hello</p>')
  })

  test('returns empty string when getPageContent throws', async () => {
    const site = makeSite()
    site.loadNode = function () { return { location: 'pages/x/index.html' } }
    site.getPageContent = async function () { throw new Error('boom') }
    assert.equal(await siteRouteUtils.getItemContent(site, { id: 'x' }), '')
  })

  test('returns empty string when getPageContent returns non-string', async () => {
    const site = makeSite()
    site.loadNode = function () { return { location: 'pages/x/index.html' } }
    site.getPageContent = async function () { return { not: 'a string' } }
    assert.equal(await siteRouteUtils.getItemContent(site, { id: 'x' }), '')
  })
})

// ---------------------------------------------------------------------------
// extractCustomElementTagsFromHtml
// ---------------------------------------------------------------------------

describe('extractCustomElementTagsFromHtml', () => {
  test('counts custom element tags (hyphenated)', () => {
    const usage = siteRouteUtils.extractCustomElementTagsFromHtml(
      '<my-tag></my-tag><my-tag></my-tag><other-tag></other-tag>',
    )
    assert.equal(usage['my-tag'], 2)
    assert.equal(usage['other-tag'], 1)
  })

  test('ignores standard html tags without a hyphen', () => {
    const usage = siteRouteUtils.extractCustomElementTagsFromHtml(
      '<div></div><span></span><a></a>',
    )
    assert.deepEqual(usage, {})
  })

  test('lowercases tag names', () => {
    const usage = siteRouteUtils.extractCustomElementTagsFromHtml('<My-Tag></My-Tag>')
    assert.equal(usage['my-tag'], 1)
  })

  test('handles empty/null', () => {
    assert.deepEqual(siteRouteUtils.extractCustomElementTagsFromHtml(''), {})
    assert.deepEqual(siteRouteUtils.extractCustomElementTagsFromHtml(null), {})
  })
})

// ---------------------------------------------------------------------------
// collectCustomElementUsage
// ---------------------------------------------------------------------------

describe('collectCustomElementUsage', () => {
  test('aggregates usage across items', async () => {
    const site = makeSite()
    // loadNode receives item.id and must return a distinct page per item so
    // getPageContent can return distinct content per item.
    site.loadNode = function (id) {
      return { location: 'pages/' + id + '/index.html' }
    }
    const pages = {
      'pages/a/index.html': '<a-tag></a-tag>',
      'pages/b/index.html': '<a-tag></a-tag><b-tag></b-tag>',
    }
    site.getPageContent = async function (page) {
      return pages[page.location] || ''
    }
    const items = [{ id: 'a' }, { id: 'b' }]
    const usage = await siteRouteUtils.collectCustomElementUsage(site, items)
    assert.equal(usage['a-tag'], 2)
    assert.equal(usage['b-tag'], 1)
  })

  test('returns {} for empty items', async () => {
    const usage = await siteRouteUtils.collectCustomElementUsage(makeSite(), [])
    assert.deepEqual(usage, {})
  })
})

// ---------------------------------------------------------------------------
// collectSiteFiles (uses a real temp directory)
// ---------------------------------------------------------------------------

describe('collectSiteFiles', () => {
  let tmpRoot

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srf-'))
  })

  afterEach(() => {
    fs.removeSync(tmpRoot)
  })

  test('returns [] when the path does not exist', () => {
    assert.deepEqual(
      siteRouteUtils.collectSiteFiles({}, path.join(tmpRoot, 'missing')),
      [],
    )
  })

  test('returns [] when the path is a file, not a directory', () => {
    const filePath = path.join(tmpRoot, 'file.txt')
    fs.writeFileSync(filePath, 'hi')
    assert.deepEqual(siteRouteUtils.collectSiteFiles({}, filePath), [])
  })

  test('collects files recursively with relative paths, sorted', () => {
    fs.mkdirSync(path.join(tmpRoot, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'a')
    fs.writeFileSync(path.join(tmpRoot, 'sub', 'b.txt'), 'b')
    const files = siteRouteUtils.collectSiteFiles({}, tmpRoot)
    assert.equal(files.length, 2)
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['a.txt', 'sub/b.txt'],
    )
    assert.ok(files[0].absolutePath.indexOf(tmpRoot) === 0)
    assert.ok(files[0].stats && typeof files[0].stats.isFile === 'function')
  })

  test('ignores standard ignored files (.DS_Store, .gitkeep, .htaccess)', () => {
    fs.writeFileSync(path.join(tmpRoot, '.DS_Store'), 'x')
    fs.writeFileSync(path.join(tmpRoot, '.gitkeep'), 'x')
    fs.writeFileSync(path.join(tmpRoot, '.htaccess'), 'x')
    fs.writeFileSync(path.join(tmpRoot, 'real.txt'), 'x')
    const files = siteRouteUtils.collectSiteFiles({}, tmpRoot)
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['real.txt'],
    )
  })

  test('skips haxcms-managed directories', () => {
    fs.mkdirSync(path.join(tmpRoot, 'haxcms-managed'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'haxcms-managed', 'managed.txt'), 'x')
    fs.writeFileSync(path.join(tmpRoot, 'real.txt'), 'x')
    const files = siteRouteUtils.collectSiteFiles({}, tmpRoot)
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['real.txt'],
    )
  })

  test('filters by search term (case-insensitive, matches path or filename)', () => {
    fs.writeFileSync(path.join(tmpRoot, 'alpha.txt'), 'x')
    fs.writeFileSync(path.join(tmpRoot, 'beta.md'), 'x')
    const files = siteRouteUtils.collectSiteFiles({}, tmpRoot, 'ALPHA')
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['alpha.txt'],
    )
  })

  test('search matches against the relative path, not just the filename', () => {
    fs.mkdirSync(path.join(tmpRoot, 'deep'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'deep', 'nested.txt'), 'x')
    const files = siteRouteUtils.collectSiteFiles({}, tmpRoot, 'deep')
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['deep/nested.txt'],
    )
  })
})

// ---------------------------------------------------------------------------
// normalizePathForResponse
// ---------------------------------------------------------------------------

describe('normalizePathForResponse', () => {
  test('returns string unchanged on posix (sep is /)', () => {
    assert.equal(siteRouteUtils.normalizePathForResponse('a/b/c'), 'a/b/c')
  })

  test('coerces non-string to string', () => {
    assert.equal(siteRouteUtils.normalizePathForResponse(42), '42')
  })

  test('returns "null" for null input (String(null))', () => {
    assert.equal(siteRouteUtils.normalizePathForResponse(null), 'null')
  })

  test('returns "" for undefined (String(undefined) is "undefined" but default arg is "")', () => {
    // default arg is '' so no-arg returns ''
    assert.equal(siteRouteUtils.normalizePathForResponse(), '')
  })
})

// ---------------------------------------------------------------------------
// normalizeFormatValue
// ---------------------------------------------------------------------------

describe('normalizeFormatValue', () => {
  test('normalizes aliases to canonical format', () => {
    assert.equal(siteRouteUtils.normalizeFormatValue('json'), 'json')
    assert.equal(siteRouteUtils.normalizeFormatValue('application/json'), 'json')
    assert.equal(siteRouteUtils.normalizeFormatValue('md'), 'md')
    assert.equal(siteRouteUtils.normalizeFormatValue('markdown'), 'md')
    assert.equal(siteRouteUtils.normalizeFormatValue('text/markdown'), 'md')
    assert.equal(siteRouteUtils.normalizeFormatValue('yaml'), 'yaml')
    assert.equal(siteRouteUtils.normalizeFormatValue('yml'), 'yaml')
    assert.equal(siteRouteUtils.normalizeFormatValue('application/yaml'), 'yaml')
    assert.equal(siteRouteUtils.normalizeFormatValue('xml'), 'xml')
    assert.equal(siteRouteUtils.normalizeFormatValue('application/xml'), 'xml')
    assert.equal(siteRouteUtils.normalizeFormatValue('html'), 'html')
    assert.equal(siteRouteUtils.normalizeFormatValue('text/html'), 'html')
  })

  test('is case-insensitive and trims', () => {
    assert.equal(siteRouteUtils.normalizeFormatValue('  JSON  '), 'json')
    assert.equal(siteRouteUtils.normalizeFormatValue('Markdown'), 'md')
  })

  test('returns "" for unknown format', () => {
    assert.equal(siteRouteUtils.normalizeFormatValue('csv'), '')
  })

  test('returns "" for empty/null', () => {
    assert.equal(siteRouteUtils.normalizeFormatValue(''), '')
    assert.equal(siteRouteUtils.normalizeFormatValue(null), '')
  })
})

// ---------------------------------------------------------------------------
// detectResponseFormat
// ---------------------------------------------------------------------------

describe('detectResponseFormat', () => {
  test('prefers query format when allowed', () => {
    const req = { query: { format: 'yaml' }, headers: {} }
    assert.equal(siteRouteUtils.detectResponseFormat(req, ['json', 'yaml'], 'json'), 'yaml')
  })

  test('ignores query format not in allowed list', () => {
    const req = { query: { format: 'xml' }, headers: {} }
    assert.equal(siteRouteUtils.detectResponseFormat(req, ['json', 'yaml'], 'json'), 'json')
  })

  test('falls back to defaultFormat when no query and no accept', () => {
    const req = { query: {}, headers: {} }
    assert.equal(siteRouteUtils.detectResponseFormat(req, ['json', 'yaml'], 'yaml'), 'yaml')
  })

  test('falls back to accept header when no query and defaultFormat not allowed', () => {
    // defaultFormat='xml' is not in allowedFormats, so the accept header is
    // the next resolver. detectResponseFormat intentionally prioritizes
    // query > defaultFormat > accept header > first allowed.
    const req = { query: {}, headers: { accept: 'application/yaml' } }
    assert.equal(siteRouteUtils.detectResponseFormat(req, ['json', 'yaml'], 'xml'), 'yaml')
  })

  test('defaultFormat wins over accept header when defaultFormat is allowed', () => {
    const req = { query: {}, headers: { accept: 'application/yaml' } }
    assert.equal(siteRouteUtils.detectResponseFormat(req, ['json', 'yaml'], 'json'), 'json')
  })

  test('falls back to first allowed when nothing matches', () => {
    const req = { query: {}, headers: { accept: 'text/csv' } }
    assert.equal(siteRouteUtils.detectResponseFormat(req, ['json', 'yaml'], 'json'), 'json')
  })

  test('returns first allowed when defaultFormat is not allowed', () => {
    const req = { query: {}, headers: {} }
    assert.equal(siteRouteUtils.detectResponseFormat(req, ['json'], 'xml'), 'json')
  })

  test('returns first allowed when allowedFormats is empty (normalized to json)', () => {
    const req = { query: {}, headers: {} }
    assert.equal(siteRouteUtils.detectResponseFormat(req, [], 'xml'), 'json')
  })

  test('handles null req', () => {
    assert.equal(siteRouteUtils.detectResponseFormat(null, ['json'], 'json'), 'json')
  })
})

// ---------------------------------------------------------------------------
// setRepresentationHeaders
// ---------------------------------------------------------------------------

describe('setRepresentationHeaders', () => {
  test('sets Vary, Content-Location, and Link headers', () => {
    const res = stubRes()
    siteRouteUtils.setRepresentationHeaders(
      res,
      '/x/api/v1/items',
      ['json', 'yaml'],
      'json',
    )
    assert.equal(res.headers['Vary'], 'Accept')
    assert.equal(res.headers['Content-Location'], '/x/api/v1/items.json')
    assert.ok(res.headers['Link'].indexOf('/x/api/v1/items.json') !== -1)
    assert.ok(res.headers['Link'].indexOf('/x/api/v1/items.yaml') !== -1)
  })

  test('no-ops when res lacks setHeader', () => {
    assert.doesNotThrow(function () {
      siteRouteUtils.setRepresentationHeaders({}, '/x', ['json'], 'json')
    })
  })
})

// ---------------------------------------------------------------------------
// serializePayload
// ---------------------------------------------------------------------------

describe('serializePayload', () => {
  test('json: pretty-stringifies', () => {
    const out = siteRouteUtils.serializePayload({ a: 1 }, 'json')
    assert.equal(out, '{\n  "a": 1\n}')
  })

  test('md: stringifies non-string payloads as JSON', () => {
    const out = siteRouteUtils.serializePayload({ a: 1 }, 'md')
    assert.equal(out, '{\n  "a": 1\n}')
  })

  test('md: passes through string payloads', () => {
    assert.equal(siteRouteUtils.serializePayload('# hi', 'md'), '# hi')
  })

  test('yaml: stringifies via YAML.stringify', () => {
    const out = siteRouteUtils.serializePayload({ a: 1 }, 'yaml')
    assert.ok(out.indexOf('a: 1') !== -1)
  })

  test('xml: wraps with xml declaration and response root', () => {
    const out = siteRouteUtils.serializePayload({ a: 1 }, 'xml')
    assert.ok(out.indexOf('<?xml version="1.0" encoding="UTF-8"?>') === 0)
    assert.ok(out.indexOf('<response>') !== -1)
    assert.ok(out.indexOf('<a>1</a>') !== -1)
  })

  test('html: wraps non-string payload in <pre> with escaped JSON', () => {
    const out = siteRouteUtils.serializePayload({ a: '<b>' }, 'html')
    assert.ok(out.indexOf('<pre>') === 0)
    assert.ok(out.indexOf('&lt;b&gt;') !== -1)
  })

  test('html: passes through string payloads', () => {
    assert.equal(siteRouteUtils.serializePayload('<p>hi</p>', 'html'), '<p>hi</p>')
  })

  test('unknown format defaults to json', () => {
    const out = siteRouteUtils.serializePayload({ a: 1 }, 'totally-unknown')
    assert.equal(out, '{\n  "a": 1\n}')
  })
})

// ---------------------------------------------------------------------------
// sendFormattedResponse
// ---------------------------------------------------------------------------

describe('sendFormattedResponse', () => {
  test('json: calls res.status().json() with envelope', () => {
    const res = stubRes()
    const req = { query: {}, headers: {} }
    siteRouteUtils.sendFormattedResponse(req, res, { hello: 'world' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.deepEqual(res.body.data, { hello: 'world' })
  })

  test('json: disables envelope when envelope=false', () => {
    const res = stubRes()
    const req = { query: {}, headers: {} }
    siteRouteUtils.sendFormattedResponse(req, res, { hello: 'world' }, {
      envelope: false,
    })
    assert.deepEqual(res.body, { hello: 'world' })
  })

  test('yaml: calls res.status().setHeader().send() with serialized yaml', () => {
    const res = stubRes()
    const req = { query: { format: 'yaml' }, headers: {} }
    // yaml must be in allowedFormats or detectResponseFormat falls back to json
    siteRouteUtils.sendFormattedResponse(req, res, { hello: 'world' }, {
      allowedFormats: ['json', 'yaml'],
    })
    assert.equal(res.statusCode, 200)
    assert.ok(typeof res.body === 'string')
    assert.ok(res.body.indexOf('hello: world') !== -1)
    assert.ok(String(res.headers['Content-Type']).indexOf('application/yaml') !== -1)
  })

  test('respects options.statusCode', () => {
    const res = stubRes()
    const req = { query: {}, headers: {} }
    siteRouteUtils.sendFormattedResponse(req, res, { error: 'x' }, {
      statusCode: 404,
    })
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.status, 404)
  })

  test('respects options.allowedFormats and selected format via query', () => {
    const res = stubRes()
    const req = { query: { format: 'xml' }, headers: {} }
    siteRouteUtils.sendFormattedResponse(req, res, { a: 1 }, {
      allowedFormats: ['json', 'xml'],
    })
    assert.ok(typeof res.body === 'string')
    assert.ok(String(res.body).indexOf('<response>') !== -1)
    assert.ok(String(res.headers['Content-Type']).indexOf('application/xml') !== -1)
  })

  test('rawByFormat overrides serialized payload for that format', () => {
    const res = stubRes()
    const req = { query: { format: 'md' }, headers: {} }
    siteRouteUtils.sendFormattedResponse(req, res, { a: 1 }, {
      allowedFormats: ['json', 'md'],
      rawByFormat: { md: '# raw markdown' },
    })
    assert.equal(res.body, '# raw markdown')
  })

  test('rawByFormat non-string value is serialized for that format', () => {
    const res = stubRes()
    const req = { query: { format: 'md' }, headers: {} }
    siteRouteUtils.sendFormattedResponse(req, res, { a: 1 }, {
      allowedFormats: ['json', 'md'],
      rawByFormat: { md: { b: 2 } },
    })
    // md serializer stringifies objects as JSON
    assert.equal(res.body, '{\n  "b": 2\n}')
  })
})

// ---------------------------------------------------------------------------
// itemToSummary
// ---------------------------------------------------------------------------

describe('itemToSummary', () => {
  test('builds a summary with self/content links and related refs', () => {
    const item = {
      id: 'item-1',
      title: 'First',
      slug: 'first',
      parent: 'item-0',
      indent: 1,
      order: 2,
      location: 'pages/item-1/index.html',
      description: 'desc',
      metadata: { region: 'top', tags: ['a', 'b'], published: true },
    }
    const summary = siteRouteUtils.itemToSummary(item, '/x/api')
    assert.equal(summary.id, 'item-1')
    assert.equal(summary.title, 'First')
    assert.equal(summary.slug, 'first')
    assert.equal(summary.parent, 'item-0')
    assert.equal(summary.indent, 1)
    assert.equal(summary.order, 2)
    assert.equal(summary.location, 'pages/item-1/index.html')
    assert.equal(summary.description, 'desc')
    assert.equal(summary.region, 'top')
    assert.deepEqual(summary.tags, ['a', 'b'])
    assert.equal(summary.published, true)
    assert.equal(summary.links.self, '/x/api/v1/items/first')
    assert.equal(summary.links.content, '/x/api/v1/content/first')
    assert.equal(summary.links.parent, '/x/api/v1/items/item-0')
    assert.ok(summary.links.children.indexOf('filter.parent=item-1') !== -1)
    assert.equal(summary.related.length, 3)
  })

  test('omits parent link when parent is missing', () => {
    const item = { id: 'item-1', slug: 'first' }
    const summary = siteRouteUtils.itemToSummary(item, '/x/api')
    assert.ok(!Object.prototype.hasOwnProperty.call(summary.links, 'parent'))
  })

  test('omits children link when id is missing', () => {
    const item = { slug: 'first' }
    const summary = siteRouteUtils.itemToSummary(item, '/x/api')
    assert.ok(!Object.prototype.hasOwnProperty.call(summary.links, 'children'))
  })

  test('uses id for lookup when slug is missing', () => {
    const item = { id: 'item-1' }
    const summary = siteRouteUtils.itemToSummary(item, '/x/api')
    assert.equal(summary.links.self, '/x/api/v1/items/item-1')
  })

  test('defaults metadata to {} and published to true when metadata.published is not false', () => {
    const item = { id: 'x', slug: 'x' }
    const summary = siteRouteUtils.itemToSummary(item, '/x/api')
    assert.deepEqual(summary.metadata, {})
    assert.equal(summary.published, true)
    assert.equal(summary.region, null)
    assert.deepEqual(summary.tags, [])
  })

  test('published is false only when metadata.published === false', () => {
    const item = { id: 'x', slug: 'x', metadata: { published: false } }
    assert.equal(siteRouteUtils.itemToSummary(item, '/x/api').published, false)

    const item2 = { id: 'x', slug: 'x', metadata: { published: 'false' } }
    // metadata.published !== false (the string 'false' is not === false)
    assert.equal(siteRouteUtils.itemToSummary(item2, '/x/api').published, true)
  })

  test('handles null item', () => {
    const summary = siteRouteUtils.itemToSummary(null, '/x/api')
    assert.equal(summary.id, null)
    assert.equal(summary.title, '')
    assert.equal(summary.slug, '')
    assert.equal(summary.parent, null)
    assert.equal(summary.published, true)
    assert.equal(summary.links.self, '/x/api/v1/items/')
  })
})

// ---------------------------------------------------------------------------
// contentToRecord
// ---------------------------------------------------------------------------

describe('contentToRecord', () => {
  test('builds a content record with body string', () => {
    const item = { id: 'x', slug: 'x-slug', title: 'X' }
    assert.deepEqual(siteRouteUtils.contentToRecord(item, '<p>hi</p>'), {
      id: 'x',
      slug: 'x-slug',
      title: 'X',
      format: 'html',
      mode: 'bundle',
      body: '<p>hi</p>',
    })
  })

  test('coerces non-string body to empty string', () => {
    const item = { id: 'x' }
    const rec = siteRouteUtils.contentToRecord(item, { not: 'string' })
    assert.equal(rec.body, '')
  })

  test('handles null item', () => {
    const rec = siteRouteUtils.contentToRecord(null, 'body')
    assert.equal(rec.id, null)
    assert.equal(rec.slug, '')
    assert.equal(rec.title, '')
    assert.equal(rec.body, 'body')
  })
})

// ---------------------------------------------------------------------------
// isItemPublished
// ---------------------------------------------------------------------------

describe('isItemPublished', () => {
  test('defaults to true when published is absent', () => {
    assert.equal(siteRouteUtils.isItemPublished({}), true)
    assert.equal(siteRouteUtils.isItemPublished({ metadata: {} }), true)
    assert.equal(siteRouteUtils.isItemPublished(null), true)
  })

  test('is false when metadata.published is boolean false', () => {
    assert.equal(
      siteRouteUtils.isItemPublished({ metadata: { published: false } }),
      false,
    )
  })

  test('is false when metadata.published is falsey string/number', () => {
    assert.equal(
      siteRouteUtils.isItemPublished({ metadata: { published: 'false' } }),
      false,
    )
    assert.equal(
      siteRouteUtils.isItemPublished({ metadata: { published: 0 } }),
      false,
    )
    assert.equal(
      siteRouteUtils.isItemPublished({ metadata: { published: 'off' } }),
      false,
    )
  })

  test('is true when metadata.published is truthy', () => {
    assert.equal(
      siteRouteUtils.isItemPublished({ metadata: { published: true } }),
      true,
    )
    assert.equal(
      siteRouteUtils.isItemPublished({ metadata: { published: 'true' } }),
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// isItemVisibleToAnonymous
// ---------------------------------------------------------------------------

describe('isItemVisibleToAnonymous', () => {
  test('true when published and not hidden', () => {
    assert.equal(
      siteRouteUtils.isItemVisibleToAnonymous({ metadata: { published: true } }),
      true,
    )
  })

  test('false when unpublished', () => {
    assert.equal(
      siteRouteUtils.isItemVisibleToAnonymous({ metadata: { published: false } }),
      false,
    )
  })

  test('false when hidden in menu', () => {
    assert.equal(
      siteRouteUtils.isItemVisibleToAnonymous({
        metadata: { published: true, hideInMenu: true },
      }),
      false,
    )
  })

  test('true when hideInMenu is falsey', () => {
    assert.equal(
      siteRouteUtils.isItemVisibleToAnonymous({
        metadata: { published: true, hideInMenu: false },
      }),
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// isAnonymousSiteApiRequest
// ---------------------------------------------------------------------------

describe('isAnonymousSiteApiRequest', () => {
  test('true when req is null or has no auth context', () => {
    assert.equal(siteRouteUtils.isAnonymousSiteApiRequest(null), true)
    assert.equal(siteRouteUtils.isAnonymousSiteApiRequest({}), true)
  })

  test('true when auth context is not authenticated', () => {
    assert.equal(
      siteRouteUtils.isAnonymousSiteApiRequest({ haxcmsSiteApiAuth: { authenticated: false } }),
      true,
    )
  })

  test('false when auth context is authenticated', () => {
    assert.equal(
      siteRouteUtils.isAnonymousSiteApiRequest({ haxcmsSiteApiAuth: { authenticated: true } }),
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// isSiteApiRequestAuthenticated
// ---------------------------------------------------------------------------

describe('isSiteApiRequestAuthenticated', () => {
  test('false for null/missing auth context', () => {
    assert.equal(siteRouteUtils.isSiteApiRequestAuthenticated(null), false)
    assert.equal(siteRouteUtils.isSiteApiRequestAuthenticated({}), false)
  })

  test('false when authenticated !== true', () => {
    assert.equal(
      siteRouteUtils.isSiteApiRequestAuthenticated({
        haxcmsSiteApiAuth: { authenticated: false },
      }),
      false,
    )
  })

  test('true when authenticated and no expected level', () => {
    assert.equal(
      siteRouteUtils.isSiteApiRequestAuthenticated({
        haxcmsSiteApiAuth: { authenticated: true },
      }),
      true,
    )
  })

  test('true when expected level matches', () => {
    assert.equal(
      siteRouteUtils.isSiteApiRequestAuthenticated(
        { haxcmsSiteApiAuth: { authenticated: true, securityLevel: 'admin' } },
        'admin',
      ),
      true,
    )
  })

  test('false when expected level does not match', () => {
    assert.equal(
      siteRouteUtils.isSiteApiRequestAuthenticated(
        { haxcmsSiteApiAuth: { authenticated: true, securityLevel: 'user' } },
        'admin',
      ),
      false,
    )
  })

  test('false when expected level set but securityLevel missing', () => {
    assert.equal(
      siteRouteUtils.isSiteApiRequestAuthenticated(
        { haxcmsSiteApiAuth: { authenticated: true } },
        'admin',
      ),
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// applyItemFilters
// ---------------------------------------------------------------------------

describe('applyItemFilters', () => {
  const items = [
    { id: '1', parent: 'root', indent: 0, metadata: { tags: ['a'], published: true, pageType: 'lesson', region: 'top' } },
    { id: '2', parent: 'root', indent: 1, metadata: { tags: ['b'], published: false, pageType: 'page', region: 'bottom' } },
    { id: '3', parent: '1', indent: 1, metadata: { tags: ['a', 'c'], published: true, pageType: 'lesson', region: 'top' } },
  ]

  test('returns a copy of all items when no filters', () => {
    const out = siteRouteUtils.applyItemFilters(items, { query: {} })
    assert.notEqual(out, items)
    assert.equal(out.length, 3)
  })

  test('filter.parent keeps only children of that parent', () => {
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.parent': '1' },
    })
    assert.deepEqual(out.map((i) => i.id), ['3'])
  })

  test('filter.tags (case-insensitive) keeps items with any matching tag', () => {
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.tags': 'A,C' },
    })
    assert.deepEqual(out.map((i) => i.id), ['1', '3'])
  })

  test('filter.published=true keeps only published items', () => {
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.published': 'true' },
    })
    assert.deepEqual(out.map((i) => i.id), ['1', '3'])
  })

  test('filter.published=false keeps only unpublished items', () => {
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.published': 'false' },
    })
    assert.deepEqual(out.map((i) => i.id), ['2'])
  })

  test('filter.pageType keeps items with matching pageType', () => {
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.pageType': 'lesson' },
    })
    assert.deepEqual(out.map((i) => i.id), ['1', '3'])
  })

  test('filter.region keeps items with matching region', () => {
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.region': 'top' },
    })
    assert.deepEqual(out.map((i) => i.id), ['1', '3'])
  })

  test('enforceAnonymousVisibility filters out unpublished + hidden items when anonymous', () => {
    const mixed = [
      { id: 'a', metadata: { published: true } },
      { id: 'b', metadata: { published: false } },
      { id: 'c', metadata: { published: true, hideInMenu: true } },
    ]
    const out = siteRouteUtils.applyItemFilters(mixed, { query: {} }, null, {
      enforceAnonymousVisibility: true,
    })
    assert.deepEqual(out.map((i) => i.id), ['a'])
  })

  test('enforceAnonymousVisibility is a no-op when authenticated', () => {
    const mixed = [
      { id: 'a', metadata: { published: true } },
      { id: 'b', metadata: { published: false } },
    ]
    const out = siteRouteUtils.applyItemFilters(mixed, {
      query: {},
      haxcmsSiteApiAuth: { authenticated: true },
    }, null, { enforceAnonymousVisibility: true })
    assert.deepEqual(out.map((i) => i.id), ['a', 'b'])
  })

  test('filter.ancestor uses site.manifest.findBranch when available', () => {
    const site = {
      manifest: {
        findBranch: function (ancestor) {
          if (ancestor === 'root') {
            return [{ id: '1' }, { id: '3' }]
          }
          return null
        },
      },
    }
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.ancestor': 'root' },
    }, site)
    assert.deepEqual(out.map((i) => i.id).sort(), ['1', '3'])
  })

  test('filter.ancestor is a no-op when site has no findBranch', () => {
    const out = siteRouteUtils.applyItemFilters(items, {
      query: { 'filter.ancestor': 'root' },
    }, { manifest: {} })
    assert.equal(out.length, 3)
  })
})

// ---------------------------------------------------------------------------
// escapeHtmlValue
// ---------------------------------------------------------------------------

describe('escapeHtmlValue', () => {
  test('escapes & < > " \'', () => {
    assert.equal(
      siteRouteUtils.escapeHtmlValue('<a href="x">"\'&</a>'),
      '&lt;a href=&quot;x&quot;&gt;&quot;&#39;&amp;&lt;/a&gt;',
    )
  })

  test('escapes & first to avoid double-encoding', () => {
    assert.equal(siteRouteUtils.escapeHtmlValue('&amp;'), '&amp;amp;')
  })

  test('coerces non-string to string', () => {
    assert.equal(siteRouteUtils.escapeHtmlValue(42), '42')
  })
})

// ---------------------------------------------------------------------------
// escapeXmlValue
// ---------------------------------------------------------------------------

describe('escapeXmlValue', () => {
  test('escapes & < > " \' (apos)', () => {
    assert.equal(
      siteRouteUtils.escapeXmlValue('<a>"\'&</a>'),
      '&lt;a&gt;&quot;&apos;&amp;&lt;/a&gt;',
    )
  })

  test('uses &apos; for single quote (vs &#39; in html)', () => {
    assert.equal(siteRouteUtils.escapeXmlValue("'"), '&apos;')
  })

  test('coerces non-string to string', () => {
    assert.equal(siteRouteUtils.escapeXmlValue(42), '42')
  })
})

// ---------------------------------------------------------------------------
// resolveSiteForRequest / loadResolvedSiteByName (HAXCMS.loadSite stubbed)
// ---------------------------------------------------------------------------

describe('resolveSiteForRequest (HAXCMS.loadSite stubbed)', () => {
  // NOTE: loadResolvedSiteByName is an internal helper not exposed via
  // module.exports, so we exercise it only indirectly through
  // resolveSiteForRequest, which calls it for each candidate site name.
  let savedLoadSite

  beforeEach(() => {
    savedLoadSite = HAXCMS.loadSite
  })

  afterEach(() => {
    HAXCMS.loadSite = savedLoadSite
  })

  test('resolveSiteForRequest resolves from path segment', async () => {
    const fakeSite = makeSite()
    fakeSite.siteDirectory = '/tmp/fake'
    HAXCMS.loadSite = async function (name) {
      if (name === 'frompath') {
        return fakeSite
      }
      return false
    }
    const req = { originalUrl: '/_sites/frompath/pages' }
    const out = await siteRouteUtils.resolveSiteForRequest(req)
    assert.equal(out, fakeSite)
  })

  test('resolveSiteForRequest resolves from auth context when path misses', async () => {
    const fakeSite = makeSite()
    fakeSite.siteDirectory = '/tmp/fake'
    HAXCMS.loadSite = async function (name) {
      if (name === 'fromauth') {
        return fakeSite
      }
      return false
    }
    const req = {
      originalUrl: '/other/path',
      haxcmsSiteApiAuth: { siteName: 'fromauth' },
    }
    const out = await siteRouteUtils.resolveSiteForRequest(req)
    assert.equal(out, fakeSite)
  })

  test('resolveSiteForRequest falls through to payload siteName', async () => {
    const fakeSite = makeSite()
    fakeSite.siteDirectory = '/tmp/fake'
    HAXCMS.loadSite = async function (name) {
      if (name === 'frompayload') {
        return fakeSite
      }
      return false
    }
    const req = {
      originalUrl: '/other/path',
      body: { siteName: 'frompayload' },
    }
    const out = await siteRouteUtils.resolveSiteForRequest(req)
    assert.equal(out, fakeSite)
  })

  test('resolveSiteForRequest returns systemStructureContext when nothing resolves', async () => {
    HAXCMS.loadSite = async function () { return false }
    const req = { originalUrl: '/other/path' }
    const out = await siteRouteUtils.resolveSiteForRequest(req)
    // systemStructureContext() walks from cwd looking for a site.json;
    // in the test cwd (haxcms-nodejs) there is no site.json, so this is null
    assert.equal(out, null)
  })
})
