'use strict'

// Direct handler unit tests for the thin system-route delegation modules:
//   src/systemRoutes/v1/settings.js  (every wrapper + PATCH dispatch +
//                                    getSkeleton query injection)
//   src/systemRoutes/v1/lifecycle.js (wrappers + applySiteNameFromParams +
//                                    archive collision resolution)
//
// Both modules bind their delegate routes at require time through plain
// `module.exports = handler` modules, so the delegates are stubbed by
// seeding the require cache with spy handlers BEFORE the delegation
// modules load (the same boundary-stubbing approach the repo uses for
// destructured exports — see appstore-blocks-discovery.test.cjs). The real
// delegate routes keep their own coverage in their own suites; these tests
// verify the delegation, parameter injection, and archive-collision logic
// that lives in the two modules under test.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

// ---------------------------------------------------------------------------
// Spy seeding: replace delegate route modules in the require cache before
// settings.js / lifecycle.js are loaded.
// ---------------------------------------------------------------------------
// per-test behavior overrides for a seeded delegate (see the archive
// collision tests); lifecycle/settings bind the export at require time, so
// behavior changes must flow through this mutable registry
const delegateBehavior = {}
const delegateCalls = {}
function seedRouteModule(file) {
  const resolved = require.resolve('../../src/systemRoutes/v1/routes/' + file)
  delegateCalls[file] = []
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: async (req, res) => {
      const behavior = delegateBehavior[file]
      if (behavior) {
        return behavior(req, res)
      }
      delegateCalls[file].push({
        siteName: req && req.body && req.body.site ? req.body.site.name : null,
        queryName:
          req && req.query && req.query.name !== undefined ? req.query.name : null,
      })
      return res.json({ status: 200, data: { delegated: file } })
    },
  }
}

const ROUTES_TO_SEED = [
  'listSites.js',
  'createSite.js',
  'cloneSite.js',
  'archiveSite.js',
  'downloadSite.js',
  'downloadSiteSkeleton.js',
  'saveSiteAsTemplate.js',
  'siteInfo.js',
  'generateAppStore.js',
  'systemStatus.js',
  'getApiKeys.js',
  'saveApiKeys.js',
  'getMediaSettings.js',
  'saveMediaSettings.js',
  'getLocalizationSettings.js',
  'saveLocalizationSettings.js',
  'saveEnabledSkeletons.js',
  'schemaFileOperation.js',
  'saveEnabledThemes.js',
  'saveEnabledBlocks.js',
  'systemBlocksList.js',
  'skeletonsList.js',
  'getSkeleton.js',
  'themesList.js',
  'systemVersion.js',
  'systemEntities.js',
  'systemSchemas.js',
]
for (let i = 0; i < ROUTES_TO_SEED.length; i++) {
  seedRouteModule(ROUTES_TO_SEED[i])
}

const settings = require('../../src/systemRoutes/v1/settings.js')
const lifecycle = require('../../src/systemRoutes/v1/lifecycle.js')
const { HAXCMS } = require('../../src/lib/HAXCMS.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.sent = obj
      return this
    },
  }
}

function makeReq(overrides) {
  const req = {
    method: 'GET',
    headers: {},
    query: {},
    params: {},
    body: {},
  }
  return Object.assign(req, overrides || {})
}

function assertDelegated(file, res) {
  assert.equal(res.statusCode, null)
  assert.equal(res.body.status, 200)
  assert.equal(res.body.data.delegated, file)
  assert.equal(delegateCalls[file].length, 1)
  const call = delegateCalls[file][0]
  delegateCalls[file].length = 0
  return call
}

// ---------------------------------------------------------------------------
// settings.js
// ---------------------------------------------------------------------------
describe('settings routes — plain delegates', () => {
  const plainDelegates = [
    { fn: settings.generateAppStore, file: 'generateAppStore.js' },
    { fn: settings.systemStatus, file: 'systemStatus.js' },
    { fn: settings.getApiKeys, file: 'getApiKeys.js' },
    { fn: settings.saveApiKeys, file: 'saveApiKeys.js' },
    { fn: settings.getMediaSettings, file: 'getMediaSettings.js' },
    { fn: settings.saveMediaSettings, file: 'saveMediaSettings.js' },
    { fn: settings.getLocalizationSettings, file: 'getLocalizationSettings.js' },
    { fn: settings.saveLocalizationSettings, file: 'saveLocalizationSettings.js' },
    { fn: settings.saveEnabledSkeletons, file: 'saveEnabledSkeletons.js' },
    { fn: settings.schemaFileOperation, file: 'schemaFileOperation.js' },
    { fn: settings.saveEnabledThemes, file: 'saveEnabledThemes.js' },
    { fn: settings.saveEnabledBlocks, file: 'saveEnabledBlocks.js' },
    { fn: settings.systemBlocksList, file: 'systemBlocksList.js' },
    { fn: settings.skeletonsList, file: 'skeletonsList.js' },
    { fn: settings.themesList, file: 'themesList.js' },
    { fn: settings.systemVersion, file: 'systemVersion.js' },
    { fn: settings.systemEntities, file: 'systemEntities.js' },
    { fn: settings.systemSchemas, file: 'systemSchemas.js' },
  ]

  test('every wrapper delegates to its bound route module', async () => {
    for (let i = 0; i < plainDelegates.length; i++) {
      const res = stubRes()
      await plainDelegates[i].fn(makeReq(), res, () => {})
      assertDelegated(plainDelegates[i].file, res)
    }
  })
})

describe('settings routes — PATCH dispatch', () => {
  const patchDispatches = [
    { fn: settings.configurationApiKeys, patch: 'saveApiKeys.js', get: 'getApiKeys.js' },
    { fn: settings.configurationMedia, patch: 'saveMediaSettings.js', get: 'getMediaSettings.js' },
    { fn: settings.configurationLocalization, patch: 'saveLocalizationSettings.js', get: 'getLocalizationSettings.js' },
    { fn: settings.configurationBlocks, patch: 'saveEnabledBlocks.js', get: 'systemBlocksList.js' },
    { fn: settings.configurationSkeletons, patch: 'saveEnabledSkeletons.js', get: 'skeletonsList.js' },
    { fn: settings.configurationThemes, patch: 'saveEnabledThemes.js', get: 'themesList.js' },
  ]

  test('PATCH requests dispatch to the save handler, others to the read handler', async () => {
    for (let i = 0; i < patchDispatches.length; i++) {
      const dispatch = patchDispatches[i]
      const resPatch = stubRes()
      await dispatch.fn(makeReq({ method: 'PATCH' }), resPatch, () => {})
      assertDelegated(dispatch.patch, resPatch)
      const resGet = stubRes()
      await dispatch.fn(makeReq({ method: 'GET' }), resGet, () => {})
      assertDelegated(dispatch.get, resGet)
      // lowercase patch also dispatches to save
      const resLower = stubRes()
      await dispatch.fn(makeReq({ method: 'patch' }), resLower, () => {})
      assertDelegated(dispatch.patch, resLower)
    }
  })
})

describe('settings routes — getSkeleton query injection', () => {
  test('route params, query, and body all seed the skeleton name', async () => {
    const resParams = stubRes()
    await settings.getSkeleton(makeReq({ params: { name: 'course-start' } }), resParams, () => {})
    assert.equal(assertDelegated('getSkeleton.js', resParams).queryName, 'course-start')

    const resSkeletonParam = stubRes()
    await settings.getSkeleton(
      makeReq({ params: { skeletonName: 'resume-journey' } }),
      resSkeletonParam,
      () => {},
    )
    assert.equal(assertDelegated('getSkeleton.js', resSkeletonParam).queryName, 'resume-journey')

    const resQuery = stubRes()
    await settings.getSkeleton(makeReq({ query: { skeletonName: 'blog-start' } }), resQuery, () => {})
    assert.equal(assertDelegated('getSkeleton.js', resQuery).queryName, 'blog-start')

    const resBody = stubRes()
    await settings.getSkeleton(makeReq({ body: { skeletonName: 'club-start' } }), resBody, () => {})
    assert.equal(assertDelegated('getSkeleton.js', resBody).queryName, 'club-start')

    // an existing query.name wins over every other source
    const resExisting = stubRes()
    await settings.getSkeleton(
      makeReq({
        params: { name: 'course-start' },
        query: { name: 'already-set' },
        body: { skeletonName: 'blog-start' },
      }),
      resExisting,
      () => {},
    )
    assert.equal(assertDelegated('getSkeleton.js', resExisting).queryName, 'already-set')

    // no name anywhere delegates without injecting one
    const resNone = stubRes()
    await settings.getSkeleton(makeReq(), resNone, () => {})
    assert.equal(assertDelegated('getSkeleton.js', resNone).queryName, null)
  })
})

// ---------------------------------------------------------------------------
// lifecycle.js
// ---------------------------------------------------------------------------
describe('lifecycle routes — wrappers and param injection', () => {
  test('listSites and createSite delegate directly', async () => {
    const resList = stubRes()
    await lifecycle.listSites(makeReq(), resList, () => {})
    assertDelegated('listSites.js', resList)
    const resCreate = stubRes()
    await lifecycle.createSite(makeReq(), resCreate, () => {})
    assertDelegated('createSite.js', resCreate)
  })

  test('param site names inject into the body site name', async () => {
    const res = stubRes()
    await lifecycle.cloneSite(
      makeReq({ params: { siteName: 'demosite' }, body: {} }),
      res,
      () => {},
    )
    assert.equal(assertDelegated('cloneSite.js', res).siteName, 'demosite')

    // body site.name wins when the param is missing
    const resBody = stubRes()
    await lifecycle.downloadSite(
      makeReq({ body: { site: { name: 'from-body' } } }),
      resBody,
      () => {},
    )
    assert.equal(assertDelegated('downloadSite.js', resBody).siteName, 'from-body')

    // body site.name replaces a {placeholder} param
    const resPlaceholder = stubRes()
    await lifecycle.downloadSiteSkeleton(
      makeReq({
        params: { siteName: '{siteName}' },
        body: { site: { name: 'placeholder-body' } },
      }),
      resPlaceholder,
      () => {},
    )
    assert.equal(assertDelegated('downloadSiteSkeleton.js', resPlaceholder).siteName, 'placeholder-body')

    // a concrete param wins over the body name
    const resConcrete = stubRes()
    await lifecycle.saveSiteAsTemplate(
      makeReq({
        params: { siteName: 'concrete-param' },
        body: { site: { name: 'ignored-body' } },
      }),
      resConcrete,
      () => {},
    )
    assert.equal(assertDelegated('saveSiteAsTemplate.js', resConcrete).siteName, 'concrete-param')

    // siteName as a bare body field is honored too
    const resSiteName = stubRes()
    await lifecycle.siteInfo(makeReq({ body: { siteName: 'bare-site-name' } }), resSiteName, () => {})
    assert.equal(assertDelegated('siteInfo.js', resSiteName).siteName, 'bare-site-name')

    // no name anywhere delegates without injecting one (an empty site
    // object remains nameless)
    const resNone = stubRes()
    await lifecycle.siteInfo(makeReq({ body: { site: {} } }), resNone, () => {})
    assert.equal(assertDelegated('siteInfo.js', resNone).siteName, undefined)
  })
})

describe('lifecycle routes — archive collision resolution', () => {
  function useTempRoots(t) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'))
    const originalRoot = HAXCMS.HAXCMS_ROOT
    const originalSites = HAXCMS.sitesDirectory
    const originalArchived = HAXCMS.archivedDirectory
    HAXCMS.HAXCMS_ROOT = tmpRoot + '/'
    HAXCMS.sitesDirectory = '_sites'
    HAXCMS.archivedDirectory = '_archived'
    t.after(() => {
      HAXCMS.HAXCMS_ROOT = originalRoot
      HAXCMS.sitesDirectory = originalSites
      HAXCMS.archivedDirectory = originalArchived
      fs.removeSync(tmpRoot)
    })
    return tmpRoot
  }

  test('an ENOTEMPTY collision archives under the next free -N name', async (t) => {
    const tmpRoot = useTempRoots(t)
    // source site plus one existing archived copy
    fs.ensureDirSync(path.join(tmpRoot, '_sites', 'demosite'))
    fs.writeFileSync(path.join(tmpRoot, '_sites', 'demosite', 'marker.txt'), 'source')
    fs.ensureDirSync(path.join(tmpRoot, '_archived', 'demosite'))
    // the delegate rejects with the collision error
    delegateBehavior['archiveSite.js'] = async () => {
      const error = new Error('destination not empty')
      error.code = 'ENOTEMPTY'
      throw error
    }
    t.after(() => {
      delete delegateBehavior['archiveSite.js']
    })
    const res = stubRes()
    await lifecycle.archiveSite(
      makeReq({ body: { site: { name: 'demosite' } } }),
      res,
      () => {},
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.name, 'demosite')
    assert.equal(res.sent.data.archivedName, 'demosite-1')
    assert.equal(
      res.sent.data.detail,
      'Site archived as demosite-1 because an archived copy already existed',
    )
    // the source moved into the -1 archive slot
    assert.equal(fs.pathExistsSync(path.join(tmpRoot, '_sites', 'demosite')), false)
    assert.ok(fs.pathExistsSync(path.join(tmpRoot, '_archived', 'demosite-1', 'marker.txt')))
    // a second collision takes -2
    fs.ensureDirSync(path.join(tmpRoot, '_sites', 'demosite'))
    fs.writeFileSync(path.join(tmpRoot, '_sites', 'demosite', 'marker.txt'), 'source-2')
    const res2 = stubRes()
    await lifecycle.archiveSite(
      makeReq({ body: { site: { name: 'demosite' } } }),
      res2,
      () => {},
    )
    assert.equal(res2.sent.data.archivedName, 'demosite-2')
  })

  test('an EEXIST collision archives to the free base name when none exists', async (t) => {
    const tmpRoot = useTempRoots(t)
    fs.ensureDirSync(path.join(tmpRoot, '_sites', 'freshsite'))
    delegateBehavior['archiveSite.js'] = async () => {
      const error = new Error('destination exists')
      error.code = 'EEXIST'
      throw error
    }
    t.after(() => {
      delete delegateBehavior['archiveSite.js']
    })
    const res = stubRes()
    await lifecycle.archiveSite(
      makeReq({ body: { site: { name: 'freshsite' } } }),
      res,
      () => {},
    )
    assert.equal(res.sent.data.archivedName, 'freshsite')
    assert.equal(res.sent.data.detail, 'Site archived')
    assert.ok(fs.pathExistsSync(path.join(tmpRoot, '_archived', 'freshsite')))
  })

  test('non-collision errors and empty site names rethrow', async (t) => {
    useTempRoots(t)
    delegateBehavior['archiveSite.js'] = async () => {
      throw new Error('archive exploded')
    }
    t.after(() => {
      delete delegateBehavior['archiveSite.js']
    })
    await assert.rejects(
      lifecycle.archiveSite(makeReq({ body: { site: { name: 'demosite' } } }), stubRes(), () => {}),
      /archive exploded/,
    )
    // a collision-shaped error without a site name in the payload rethrows
    delegateBehavior['archiveSite.js'] = async () => {
      const error = new Error('destination not empty')
      error.code = 'ENOTEMPTY'
      throw error
    }
    await assert.rejects(
      lifecycle.archiveSite(makeReq({ body: {} }), stubRes(), () => {}),
      /destination not empty/,
    )
  })

  test('a successful archive delegates untouched', async (t) => {
    delegateCalls['archiveSite.js'] = []
    delegateBehavior['archiveSite.js'] = async (req, res) => {
      delegateCalls['archiveSite.js'].push(req.body.site.name)
      return res.json({ status: 200, data: { name: req.body.site.name } })
    }
    t.after(() => {
      delete delegateBehavior['archiveSite.js']
      delegateCalls['archiveSite.js'].length = 0
    })
    const res = stubRes()
    await lifecycle.archiveSite(
      makeReq({ params: { siteName: 'param-site' }, body: {} }),
      res,
      () => {},
    )
    assert.equal(res.body.status, 200)
    assert.deepEqual(delegateCalls['archiveSite.js'], ['param-site'])
  })
})
