'use strict'

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')

// Set CLI mode before requiring HAXCMS so the constructor does not refuse
// to start over default credentials (the singleton is shared process-wide).
process.env.haxcms_middleware = 'node-cli'

const { HAXCMS } = require('../../src/lib/HAXCMS.js')

// Mock HAXCMS.loadSite to return a minimal fake site with a manifest so the
// site entities handler can resolve a site context without a real site on disk.
const FAKE_SITE = {
  manifest: {
    id: 'test-site-uuid',
    title: 'Test Site',
    metadata: { site: { name: 'testsite' } },
    items: [],
  },
  siteDirectory: '/tmp/testsite',
  name: 'testsite',
}

const originalLoadSite = HAXCMS.loadSite
const originalSitesDirectory = HAXCMS.sitesDirectory

before(() => {
  HAXCMS.sitesDirectory = '_sites'
  HAXCMS.loadSite = async (siteName) => {
    if (siteName === 'testsite') {
      return FAKE_SITE
    }
    return null
  }
})

after(() => {
  HAXCMS.loadSite = originalLoadSite
  HAXCMS.sitesDirectory = originalSitesDirectory
})

// Helper: create a mock Express response that captures res.json() calls.
function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(data) {
      this.body = data
      return data
    },
  }
  return res
}

const KNOWN_TYPES = ['file', 'item', 'theme', 'skeleton', 'site', 'system']

describe('Entities endpoints — Phase 1 (#3043)', () => {
  describe('/x/api/v1/entities (site)', () => {
    const entities = require('../../src/siteRoutes/v1/entities.js')

    function makeSiteReq(query = {}) {
      return {
        originalUrl: '/_sites/testsite/x/api/v1/entities',
        url: '/_sites/testsite/x/api/v1/entities',
        query,
      }
    }

    test('returns merged set matching entities.yaml (6 types)', async () => {
      const req = makeSiteReq()
      const res = mockRes()
      await entities(req, res)
      assert.equal(res.statusCode, 200)
      assert.ok(res.body)
      const data = res.body.data
      assert.ok(data)
      assert.equal(data.count, 6)
      assert.ok(Array.isArray(data.entities))
      assert.equal(data.entities.length, 6)
      const types = data.entities.map((e) => e.type)
      for (const expected of KNOWN_TYPES) {
        assert.ok(types.indexOf(expected) !== -1, `Expected type "${expected}"`)
      }
    })

    test('scope=site filters to file and item', async () => {
      const req = makeSiteReq({ scope: 'site' })
      const res = mockRes()
      await entities(req, res)
      const data = res.body.data
      const types = data.entities.map((e) => e.type).sort()
      assert.deepEqual(types, ['file', 'item'])
      assert.equal(data.count, 2)
    })

    test('scope=system filters to theme, skeleton, site, system', async () => {
      const req = makeSiteReq({ scope: 'system' })
      const res = mockRes()
      await entities(req, res)
      const data = res.body.data
      const types = data.entities.map((e) => e.type).sort()
      assert.deepEqual(types, ['site', 'skeleton', 'system', 'theme'])
      assert.equal(data.count, 4)
    })

    test('file descriptor shape matches extended EntityDescriptor', async () => {
      const req = makeSiteReq()
      const res = mockRes()
      await entities(req, res)
      const entitiesArr = res.body.data.entities
      const fileEntity = entitiesArr.find((e) => e.type === 'file')
      assert.ok(fileEntity)
      assert.equal(fileEntity.name, 'file') // backward-compat alias
      assert.equal(fileEntity.scope, 'site')
      assert.equal(fileEntity.primaryKey, 'uuid')
      assert.deepEqual(fileEntity.uniqueKeys, ['uuid'])
      assert.deepEqual(fileEntity.requiredFields, ['uuid', 'path', 'name', 'mimetype'])
      assert.equal(fileEntity.storage.type, 'datastore')
      assert.equal(fileEntity.storage.enabled, true)
      assert.equal(fileEntity.storage.indexKey, 'uuid')
      assert.equal(fileEntity.storage.storeSchema, 'HAXCMS-FILE-SCHEMA-V1')
      assert.ok(fileEntity.supportedOperations.indexOf('save') !== -1)
      assert.ok(fileEntity.endpoints.indexOf('/x/api/v1/files') !== -1)
      assert.equal(fileEntity.enabled, true)
    })

    test('links include self and schemas', async () => {
      const req = makeSiteReq()
      const res = mockRes()
      await entities(req, res)
      const links = res.body.data.links
      assert.equal(links.self, '/_sites/testsite/x/api/v1/entities')
      assert.equal(links.schemas, '/_sites/testsite/x/api/v1/schemas')
    })

    test('returns 404 when site context cannot be resolved', async () => {
      const req = {
        originalUrl: '/_sites/nonexistent/x/api/v1/entities',
        url: '/_sites/nonexistent/x/api/v1/entities',
        query: {},
      }
      const res = mockRes()
      await entities(req, res)
      assert.equal(res.statusCode, 404)
    })
  })

  describe('/system/api/v1/entities (system)', () => {
    const systemEntities = require('../../src/systemRoutes/v1/routes/systemEntities.js')

    function makeSystemReq(query = {}) {
      return {
        originalUrl: '/system/api/v1/entities',
        url: '/system/api/v1/entities',
        query,
      }
    }

    test('returns merged set matching entities.yaml (6 types)', async () => {
      const req = makeSystemReq()
      const res = mockRes()
      await systemEntities(req, res)
      assert.equal(res.statusCode, 200)
      assert.ok(res.body)
      const data = res.body.data
      assert.ok(data)
      assert.equal(data.count, 6)
      assert.ok(Array.isArray(data.entities))
      assert.equal(data.entities.length, 6)
      const types = data.entities.map((e) => e.type)
      for (const expected of KNOWN_TYPES) {
        assert.ok(types.indexOf(expected) !== -1, `Expected type "${expected}"`)
      }
    })

    test('scope=site filters to file and item', async () => {
      const req = makeSystemReq({ scope: 'site' })
      const res = mockRes()
      await systemEntities(req, res)
      const data = res.body.data
      const types = data.entities.map((e) => e.type).sort()
      assert.deepEqual(types, ['file', 'item'])
      assert.equal(data.count, 2)
    })

    test('scope=system filters to theme, skeleton, site, system', async () => {
      const req = makeSystemReq({ scope: 'system' })
      const res = mockRes()
      await systemEntities(req, res)
      const data = res.body.data
      const types = data.entities.map((e) => e.type).sort()
      assert.deepEqual(types, ['site', 'skeleton', 'system', 'theme'])
      assert.equal(data.count, 4)
    })

    test('theme descriptor shape matches extended EntityDescriptor', async () => {
      const req = makeSystemReq()
      const res = mockRes()
      await systemEntities(req, res)
      const entitiesArr = res.body.data.entities
      const themeEntity = entitiesArr.find((e) => e.type === 'theme')
      assert.ok(themeEntity)
      assert.equal(themeEntity.name, 'theme')
      assert.equal(themeEntity.scope, 'system')
      assert.equal(themeEntity.primaryKey, 'element')
      assert.deepEqual(themeEntity.uniqueKeys, ['element'])
      assert.deepEqual(themeEntity.requiredFields, ['element'])
      assert.equal(themeEntity.storage.type, 'webcomponent')
      assert.equal(themeEntity.storage.enabled, false)
      assert.equal(themeEntity.storage.source, 'themeSettings')
      assert.deepEqual(themeEntity.endpoints, ['/system/api/v1/themes'])
      assert.equal(themeEntity.enabled, true)
    })

    test('links include self and sites', async () => {
      const req = makeSystemReq()
      const res = mockRes()
      await systemEntities(req, res)
      const links = res.body.data.links
      assert.equal(links.self, '/system/api/v1/entities')
      assert.equal(links.sites, '/system/api/v1/sites')
    })
  })
})
