'use strict'

// Unit tests for the app-store + discovery cluster:
//   src/lib/HAXAppStoreService.js        (built-in app-store JSON specs)
//   src/systemRoutes/v1/routes/generateAppStore.js
//   src/systemRoutes/v1/routes/systemBlocksList.js
//   src/systemRoutes/v1/routes/siteSkeletonHelpers.js
//   src/systemRoutes/discovery/api.js
//
// HAXAppStoreService is tested directly against its fixed built-in JSON
// specs. generateAppStore runs against a fixed effective-api-keys fixture
// (readEffectiveApiKeys is mocked by mutating the shared module export
// BEFORE the route is required, since the route destructures it at require
// time - same pattern as convert-elmsln-to-site.test.cjs) plus a temp
// HAXCMS.configDirectory so settings/enabledBlocks.json writes hit scratch
// disk. siteSkeletonHelpers builds a skeleton from a fake manifest whose
// page content is read off real temp-dir files.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const { describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const apiKeysMod = require('../../src/lib/apiKeys.js')
// fixed app-store api-keys fixture for every generateAppStore test below
let effectiveApiKeysFixture = {}
apiKeysMod.readEffectiveApiKeys = async () => effectiveApiKeysFixture

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const HAXAppStoreService = require('../../src/lib/HAXAppStoreService.js')
const generateAppStore = require('../../src/systemRoutes/v1/routes/generateAppStore.js')
const systemBlocksList = require('../../src/systemRoutes/v1/routes/systemBlocksList.js')
const siteSkeletonHelpers = require('../../src/systemRoutes/v1/routes/siteSkeletonHelpers.js')
const { generateSiteSkeleton, normalizeMachineName } = siteSkeletonHelpers
const systemDiscoveryApi = require('../../src/systemRoutes/discovery/api.js')

const AppStoreService = new HAXAppStoreService()

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

// point HAXCMS.configDirectory at a scratch dir (restored after the test)
function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appstore-blocks-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

// override HAXCMS.config.appStore per test (undefined -> deleted; restored after)
function withAppStoreConfig(t, appStoreConfig) {
  const original = HAXCMS.config.appStore
  if (appStoreConfig === undefined) {
    delete HAXCMS.config.appStore
  } else {
    HAXCMS.config.appStore = appStoreConfig
  }
  t.after(() => {
    if (original === undefined) {
      delete HAXCMS.config.appStore
    } else {
      HAXCMS.config.appStore = original
    }
  })
}

function writeEnabledBlocksFile(configDir, value) {
  fs.ensureDirSync(path.join(configDir, 'settings'))
  fs.writeFileSync(
    path.join(configDir, 'settings', 'enabledBlocks.json'),
    JSON.stringify(value),
  )
}

// ---------------------------------------------------------------------------
// HAXAppStoreService (built-in, fixed app-store JSON specs)
// ---------------------------------------------------------------------------
describe('HAXAppStoreService.loadBaseAppStore', () => {
  const ALWAYS_ON_APPS = ['NASA', 'Sketchfab', 'Dailymotion', 'Wikipedia', 'CC Mixter']

  function titlesOf(apps) {
    return apps.map((app) => app.details.title)
  }

  test('with no api keys returns only the always-on providers', () => {
    const apps = AppStoreService.loadBaseAppStore([])
    assert.deepEqual(titlesOf(apps).sort(), ALWAYS_ON_APPS.slice().sort())
  })

  test('with every key set returns all ten providers with keys interpolated', () => {
    const apps = AppStoreService.loadBaseAppStore({
      youtube: 'yt-secret',
      vimeo: 'vimeo-secret',
      giphy: 'gif-secret',
      unsplash: 'unsplash-secret',
      flickr: 'flickr-secret',
    })
    assert.equal(apps.length, 10)
    const byTitle = {}
    for (let i = 0; i < apps.length; i++) {
      byTitle[apps[i].details.title] = apps[i]
    }
    assert.equal(byTitle['Youtube'].connection.data.key, 'yt-secret')
    assert.equal(byTitle['Vimeo'].connection.data.access_token, 'vimeo-secret')
    assert.equal(byTitle['Giphy'].connection.data.api_key, 'gif-secret')
    assert.equal(byTitle['Unsplash'].connection.data.client_id, 'unsplash-secret')
    assert.equal(byTitle['Flickr'].connection.data.api_key, 'flickr-secret')
    // key-less providers are unchanged
    assert.equal('data' in byTitle['NASA'].connection, false)
  })

  test('a single key only unlocks its own provider', () => {
    const apps = AppStoreService.loadBaseAppStore({ youtube: 'yt-secret' })
    const titles = titlesOf(apps)
    assert.equal(titles.indexOf('Youtube') !== -1, true)
    assert.equal(titles.indexOf('Vimeo') !== -1, false)
    assert.equal(apps.length, 6)
  })

  test('every spec is a well-formed appstore definition', () => {
    const apps = AppStoreService.loadBaseAppStore({
      youtube: 'yt-secret',
      vimeo: 'vimeo-secret',
      giphy: 'gif-secret',
      unsplash: 'unsplash-secret',
      flickr: 'flickr-secret',
    })
    for (let i = 0; i < apps.length; i++) {
      const app = apps[i]
      assert.equal(typeof app.details.title, 'string', 'details.title')
      assert.equal(typeof app.connection.protocol, 'string', 'connection.protocol')
      assert.equal(app.connection.operations.browse.method, 'GET')
      assert.ok(app.connection.operations.browse.resultMap, 'browse.resultMap')
    }
  })
})

describe('HAXAppStoreService.loadBaseStax', () => {
  test('returns the example lesson stax with h2, p, and video-player items', () => {
    const stax = AppStoreService.loadBaseStax()
    assert.equal(stax.length, 1)
    assert.equal(stax[0].details.title, 'Example Lesson')
    const tags = stax[0].stax.map((item) => item.tag)
    assert.deepEqual(tags, ['h2', 'p', 'video-player'])
    const video = stax[0].stax[2]
    assert.ok(video.properties.source.indexOf('youtube.com') !== -1)
    assert.equal(video.properties.iframed, true)
  })
})

describe('HAXAppStoreService.baseSupportedApps', () => {
  test('lists the five keyed providers with docs links', () => {
    const apps = AppStoreService.baseSupportedApps()
    assert.deepEqual(
      Object.keys(apps).sort(),
      ['flickr', 'giphy', 'unsplash', 'vimeo', 'youtube'],
    )
    for (const key of Object.keys(apps)) {
      assert.equal(typeof apps[key].name, 'string', key + ' name')
      assert.equal(typeof apps[key].docs, 'string', key + ' docs')
    }
  })
})

// ---------------------------------------------------------------------------
// generateAppStore
// ---------------------------------------------------------------------------
describe('generateAppStore', () => {
  function genReq(query, headers) {
    return {
      headers: Object.assign(
        { 'x-haxcms-site-token': 'token' },
        headers || {},
      ),
      query: query || { siteName: 'demo' },
    }
  }

  function mockGenAuth(t) {
    t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  }

  function appByTitle(body, title) {
    for (let i = 0; i < body.apps.length; i++) {
      if (body.apps[i].details.title === title) {
        return body.apps[i]
      }
    }
    return null
  }

  test('missing site token answers 403 invalid request token', async (t) => {
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore({ headers: {}, query: { siteName: 'demo' } }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('missing siteName answers 403 invalid request token', async (t) => {
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore({ headers: { 'x-haxcms-site-token': 'token' }, query: {} }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('a wrong site token answers 403 invalid request token', async (t) => {
    t.mock.method(HAXCMS, 'validateRequestToken', () => false)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'invalid request token')
  })

  test('a valid request with no api keys returns brokered defaults', async (t) => {
    const originalOperatingContext = HAXCMS.operatingContext
    const originalDeploymentProfile = HAXCMS.config.deploymentProfile
    HAXCMS.operatingContext = 'single'
    HAXCMS.config.deploymentProfile = 'single-site'
    t.after(() => {
      HAXCMS.operatingContext = originalOperatingContext
      if (originalDeploymentProfile === undefined) {
        delete HAXCMS.config.deploymentProfile
      } else {
        HAXCMS.config.deploymentProfile = originalDeploymentProfile
      }
    })
    useTempConfigDirectory(t)
    withAppStoreConfig(t, undefined)
    effectiveApiKeysFixture = {}
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    // 5 always-on provider apps + the Local files app
    assert.equal(res.body.apps.length, 6)
    const nasa = appByTitle(res.body, 'NASA')
    assert.ok(nasa, 'NASA app present')
    // broker rewrite: url is the local domain, endPoint is the provider search
    assert.equal(nasa.connection.url, 'localhost')
    assert.equal(
      nasa.connection.operations.browse.endPoint,
      'system/api/v1/integrations/app-store/providers/nasa/search',
    )
    // site token forwarded to the broker
    assert.equal(nasa.connection.headers['X-HAXCMS-Site-Token'], 'token')
    // stax/autoloader fall back to base defaults
    assert.equal(res.body.stax.length, 1)
    assert.equal(res.body.stax[0].details.title, 'Example Lesson')
    assert.deepEqual(res.body.autoloader, ['grid-plate'])
    // Local files app rides along with the site API endpoint
    const localFiles = appByTitle(res.body, 'Local files')
    assert.ok(localFiles, 'Local files app present')
    assert.equal(localFiles.connection.operations.browse.endPoint, 'x/api/v1/files')
  })

  test('keyed providers are included and their secret params are stripped by the broker', async (t) => {
    useTempConfigDirectory(t)
    withAppStoreConfig(t, undefined)
    effectiveApiKeysFixture = { youtube: 'yt-secret', giphy: 'gif-secret' }
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.equal(res.statusCode, null)
    // youtube + giphy + 5 always-on + local files
    assert.equal(res.body.apps.length, 8)
    const youtube = appByTitle(res.body, 'Youtube')
    assert.ok(youtube, 'Youtube app present')
    const giphy = appByTitle(res.body, 'Giphy')
    assert.ok(giphy, 'Giphy app present')
    // the broker endpoint is used and auth params never reach the client spec
    assert.equal(
      youtube.connection.operations.browse.endPoint,
      'system/api/v1/integrations/app-store/providers/youtube/search',
    )
    assert.equal('key' in youtube.connection.data, false, 'youtube key stripped')
    assert.equal('api_key' in giphy.connection.data, false, 'giphy key stripped')
  })

  test('an enabled-blocks file filters the autoloader list (case-insensitive)', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['grid-plate', 'my-widget'])
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player', 'My-Widget'] })
    effectiveApiKeysFixture = {}
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.equal(res.statusCode, null)
    assert.deepEqual(res.body.autoloader, ['grid-plate', 'My-Widget'])
  })

  test('an empty enabled-blocks file empties the autoloader list', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, [])
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    effectiveApiKeysFixture = {}
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.deepEqual(res.body.autoloader, [])
  })

  test('a non-array enabled-blocks file is ignored (no filtering)', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, { grid: true })
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    effectiveApiKeysFixture = {}
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.deepEqual(res.body.autoloader, ['grid-plate', 'video-player'])
  })

  test('an object autoloader map is filtered by its keys', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['grid-plate'])
    withAppStoreConfig(t, {
      autoloader: {
        'grid-plate': '@haxtheweb/grid-plate/grid-plate.js',
        'video-player': '@haxtheweb/video-player/video-player.js',
      },
    })
    effectiveApiKeysFixture = {}
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.deepEqual(res.body.autoloader, {
      'grid-plate': '@haxtheweb/grid-plate/grid-plate.js',
    })
  })

  test('config appStore stax override replaces the base stax', async (t) => {
    useTempConfigDirectory(t)
    withAppStoreConfig(t, { stax: [{ details: { title: 'Custom Stax' }, stax: [] }] })
    effectiveApiKeysFixture = {}
    mockGenAuth(t)
    const res = stubRes()
    await generateAppStore(genReq(), res)
    assert.equal(res.body.stax.length, 1)
    assert.equal(res.body.stax[0].details.title, 'Custom Stax')
  })
})

// ---------------------------------------------------------------------------
// systemBlocksList
// ---------------------------------------------------------------------------
describe('systemBlocksList', () => {
  test('defaults to grid-plate with no settings file', async (t) => {
    useTempConfigDirectory(t)
    withAppStoreConfig(t, undefined)
    const res = stubRes()
    await systemBlocksList({ query: {} }, res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.deepEqual(res.body.data.autoloader, ['grid-plate'])
    assert.deepEqual(res.body.data.enabledBlocks, [])
    assert.deepEqual(res.body.data.apps, [])
    assert.deepEqual(res.body.data.stax, [])
  })

  test('enabled=true keeps only blocks in the enabled set', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['video-player'])
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player', 'other-widget'] })
    const res = stubRes()
    await systemBlocksList({ query: { enabled: 'true' } }, res)
    assert.deepEqual(res.body.data.autoloader, ['video-player'])
    assert.deepEqual(res.body.data.enabledBlocks, ['video-player'])
  })

  test('enabled=false keeps only blocks outside the enabled set', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['video-player'])
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player', 'other-widget'] })
    const res = stubRes()
    await systemBlocksList({ query: { enabled: 'false' } }, res)
    assert.deepEqual(res.body.data.autoloader, ['grid-plate', 'other-widget'])
  })

  test('the enabled flag is also honored from the request body', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['grid-plate'])
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    const res = stubRes()
    await systemBlocksList({ query: {}, body: { enabled: 'yes' } }, res)
    assert.deepEqual(res.body.data.autoloader, ['grid-plate'])
  })

  test('a falsey body flag selects the disabled filter', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['grid-plate'])
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    const res = stubRes()
    await systemBlocksList({ query: {}, body: { enabled: 'off' } }, res)
    assert.deepEqual(res.body.data.autoloader, ['video-player'])
  })

  test('an object autoloader map is filtered by key', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['grid-plate'])
    withAppStoreConfig(t, {
      autoloader: {
        'grid-plate': '@haxtheweb/grid-plate/grid-plate.js',
        'video-player': '@haxtheweb/video-player/video-player.js',
      },
    })
    const res = stubRes()
    await systemBlocksList({ query: { enabled: true } }, res)
    assert.deepEqual(res.body.data.autoloader, {
      'grid-plate': '@haxtheweb/grid-plate/grid-plate.js',
    })
  })

  test('enabled=true with no settings file yields an empty autoloader', async (t) => {
    useTempConfigDirectory(t)
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    const res = stubRes()
    await systemBlocksList({ query: { enabled: true } }, res)
    assert.deepEqual(res.body.data.autoloader, [])
  })

  test('enabled=false with no settings file keeps the autoloader intact', async (t) => {
    useTempConfigDirectory(t)
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    const res = stubRes()
    await systemBlocksList({ query: { enabled: false } }, res)
    assert.deepEqual(res.body.data.autoloader, ['grid-plate', 'video-player'])
  })

  test('no enabled flag returns the unfiltered autoloader', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, ['grid-plate'])
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    const res = stubRes()
    await systemBlocksList({ query: {} }, res)
    assert.deepEqual(res.body.data.autoloader, ['grid-plate', 'video-player'])
    assert.deepEqual(res.body.data.enabledBlocks, ['grid-plate'])
  })

  test('a non-array enabled-blocks file reports empty enabledBlocks and no filtering', async (t) => {
    const tmpDir = useTempConfigDirectory(t)
    writeEnabledBlocksFile(tmpDir, { grid: true })
    withAppStoreConfig(t, { autoloader: ['grid-plate', 'video-player'] })
    const res = stubRes()
    await systemBlocksList({ query: {} }, res)
    assert.deepEqual(res.body.data.autoloader, ['grid-plate', 'video-player'])
    assert.deepEqual(res.body.data.enabledBlocks, [])
  })
})

// ---------------------------------------------------------------------------
// siteSkeletonHelpers
// ---------------------------------------------------------------------------
describe('siteSkeletonHelpers.normalizeMachineName', () => {
  test('machine-names a plain title', () => {
    assert.equal(normalizeMachineName('Course Skeleton!'), 'course-skeleton')
    assert.equal(normalizeMachineName('My Site'), 'my-site')
  })

  test('falls back to site-template for unusable input', () => {
    assert.equal(normalizeMachineName(null), 'site-template')
    assert.equal(normalizeMachineName(undefined), 'site-template')
    assert.equal(normalizeMachineName(42), 'site-template')
    assert.equal(normalizeMachineName(''), 'site-template')
  })
})

describe('siteSkeletonHelpers.generateSiteSkeleton', () => {
  test('throws for a site without a usable manifest', async () => {
    await assert.rejects(generateSiteSkeleton(null), /Invalid site requested/)
    await assert.rejects(generateSiteSkeleton({}), /Invalid site requested/)
    await assert.rejects(
      generateSiteSkeleton({ manifest: 'not-an-object' }),
      /Invalid site requested/,
    )
  })

  function makeSkeletonSite(siteDirectory) {
    return {
      siteDirectory: siteDirectory,
      manifest: {
        title: 'My Course Title',
        description: 'My Course Description',
        metadata: {
          site: {
            name: 'My Course',
            settings: { lang: 'es-ES', gaID: 'UA-1', canonical: false },
            category: ['course', 'higher-ed'],
            tags: ['demo'],
          },
          theme: {
            element: 'my-theme',
            variables: { accent: 'blue' },
            thumbnail: 'theme-shot.png',
          },
          platform: { features: { addPage: false } },
        },
        items: [
          { id: 'item-2', title: 'Second', slug: 'second', order: 2, indent: 1, parent: 'item-1', location: 'pages/second/index.html', metadata: { tags: ['t2'], published: false, hideInMenu: true } },
          { id: 'item-1', title: 'First', slug: 'first', order: 1, location: 'pages/first/index.html', metadata: {} },
          { location: '../escape' },
          { location: 'pages/missing' },
          { location: 'pages' },
          {},
        ],
      },
    }
  }

  function writeSkeletonPages(siteDirectory) {
    fs.ensureDirSync(path.join(siteDirectory, 'pages', 'first'))
    fs.ensureDirSync(path.join(siteDirectory, 'pages', 'second'))
    fs.writeFileSync(
      path.join(siteDirectory, 'pages', 'first', 'index.html'),
      '<p>first content</p>',
    )
    fs.writeFileSync(
      path.join(siteDirectory, 'pages', 'second', 'index.html'),
      '<p>second content</p>',
    )
  }

  test('builds a full skeleton from a manifest with real page content', async (t) => {
    const siteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-site-'))
    t.after(() => fs.removeSync(siteDirectory))
    writeSkeletonPages(siteDirectory)
    t.mock.method(HAXCMS, 'getThemes', () => ({
      'my-theme': {
        element: 'my-theme',
        name: 'My Theme',
        thumbnail: 'reg-thumb.png',
      },
    }))
    const site = makeSkeletonSite(siteDirectory)
    const skeleton = await siteSkeletonHelpers.generateSiteSkeleton(site)

    // meta block
    assert.equal(skeleton.meta.name, 'my-course')
    assert.equal(skeleton.meta.machineName, 'my-course')
    assert.equal(skeleton.meta.useCaseTitle, 'My Course Title')
    assert.equal(skeleton.meta.description, 'Template based on My Course Description')
    assert.equal(skeleton.meta.type, 'skeleton')
    assert.equal(skeleton.meta.version, '1.0.0')
    assert.equal(skeleton.meta.sourceUrl, '/_sites/my-course/')
    assert.equal(skeleton.meta.useCaseImage, 'theme-shot.png')
    assert.deepEqual(skeleton.meta.category, ['course', 'higher-ed'])
    assert.deepEqual(skeleton.meta.tags, ['demo'])
    // site block: instance settings reset to defaults, others preserved
    assert.equal(skeleton.site.name, 'my-course')
    assert.equal(skeleton.site.theme, 'my-theme')
    assert.equal(skeleton.site.settings.lang, 'es-ES')
    assert.equal(skeleton.site.settings.publishPagesOn, true)
    assert.equal(skeleton.site.settings.canonical, true)
    assert.equal(skeleton.site.settings.gaID, '')
    assert.deepEqual(skeleton.site.platform, { features: { addPage: false } })
    // theme + full config snapshot
    assert.equal(skeleton.theme.name, 'My Theme')
    assert.equal(skeleton.theme.thumbnail, 'theme-shot.png')
    assert.deepEqual(skeleton._skeleton.fullThemeConfig, {
      element: 'my-theme',
      variables: { accent: 'blue' },
    })
    // build block: ordered structure with real content reads
    assert.equal(skeleton.build.type, 'skeleton')
    assert.equal(skeleton.build.structure, 'from-skeleton')
    assert.deepEqual(skeleton.build.files, [])
    const structure = skeleton.build.items
    assert.equal(structure.length, 6)
    assert.equal(structure[0].id, 'item-1')
    assert.equal(structure[0].content, '<p>first content</p>')
    assert.deepEqual(structure[0].metadata, { tags: [], published: true, hideInMenu: false })
    assert.equal(structure[1].id, 'item-2')
    assert.equal(structure[1].content, '<p>second content</p>')
    assert.equal(structure[1].indent, 1)
    assert.equal(structure[1].parent, 'item-1')
    assert.deepEqual(structure[1].metadata, { tags: ['t2'], published: false, hideInMenu: true })
    // traversal / missing / directory locations read as empty content
    assert.equal(structure[2].content, '')
    assert.equal(structure[3].content, '')
    assert.equal(structure[4].content, '')
    // bare item gets generated defaults
    assert.equal(typeof structure[5].id, 'string')
    assert.ok(structure[5].id.length > 10, 'generated uuid id')
    assert.equal(structure[5].title, 'Page 6')
    assert.equal(structure[5].slug, 'page-6')
    assert.equal(structure[5].parent, null)
    assert.equal(structure[5].indent, 0)
    assert.equal(structure[5].order, 5)
  })

  test('falls back to the default theme when the manifest has none', async (t) => {
    const siteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-deftheme-'))
    t.after(() => fs.removeSync(siteDirectory))
    t.mock.method(HAXCMS, 'getThemes', () => ({}))
    const skeleton = await siteSkeletonHelpers.generateSiteSkeleton({
      siteDirectory: siteDirectory,
      manifest: {
        title: 'Untitled',
        metadata: { site: { name: 'Plain Site' } },
        items: [],
      },
    })
    assert.equal(skeleton.site.theme, HAXCMS.HAXCMS_DEFAULT_THEME)
    assert.equal(
      skeleton.meta.useCaseImage,
      '@haxtheweb/haxcms-elements/lib/theme-screenshots/theme-' +
        HAXCMS.HAXCMS_DEFAULT_THEME +
        '-thumb.jpg',
    )
    assert.deepEqual(skeleton.build.items, [])
    assert.equal(skeleton.site.settings.lang, 'en-US')
    assert.equal(skeleton.site.settings.publishPagesOn, true)
  })

  test('resolves the site directory from site.directory when unset', async (t) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-dir-'))
    t.after(() => fs.removeSync(rootDir))
    // pages are read from <site.directory>/<machineName>/ when siteDirectory
    // is absent, mirroring how a loaded site lays out its files
    const joinedSiteDir = path.join(rootDir, 'dir-site')
    fs.ensureDirSync(path.join(joinedSiteDir, 'pages', 'one'))
    fs.writeFileSync(
      path.join(joinedSiteDir, 'pages', 'one', 'index.html'),
      '<p>directory content</p>',
    )
    const skeleton = await generateSiteSkeleton({
      directory: rootDir,
      manifest: {
        title: 'From Directory',
        metadata: { site: { name: 'Dir Site' } },
        items: [{ id: 'item-1', title: 'One', location: 'pages/one/index.html' }],
      },
    })
    assert.equal(skeleton.meta.name, 'dir-site')
    assert.equal(skeleton.build.items[0].content, '<p>directory content</p>')
  })

  test('falls back to site.name then site-template when metadata has no name', async (t) => {
    const siteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-name-'))
    t.after(() => fs.removeSync(siteDirectory))
    const skeleton1 = await siteSkeletonHelpers.generateSiteSkeleton({
      siteDirectory: siteDirectory,
      name: 'Fallback Name',
      manifest: { title: 'T', metadata: {}, items: [] },
    })
    assert.equal(skeleton1.meta.name, 'fallback-name')
    const skeleton2 = await siteSkeletonHelpers.generateSiteSkeleton({
      siteDirectory: siteDirectory,
      manifest: { title: 'T2', metadata: {}, items: [] },
    })
    assert.equal(skeleton2.meta.name, 'site-template')
  })
})

// ---------------------------------------------------------------------------
// systemRoutes/discovery/api
// ---------------------------------------------------------------------------
describe('systemRoutes/discovery/api', () => {
  function mockDiscoveryExtras(t, protocol, host) {
    t.mock.method(HAXCMS, 'resolveTrustedProtocol', () => protocol)
    t.mock.method(HAXCMS, 'resolveTrustedHost', () => host)
    t.mock.method(HAXCMS, 'getHAXCMSVersion', async () => 'v-test')
  }

  test('answers the discovery document with relative and absolute links', async (t) => {
    mockDiscoveryExtras(t, 'https', 'cms.example.com')
    const res = stubRes()
    await systemDiscoveryApi(
      { headers: { host: 'cms.example.com' }, originalUrl: '/system/api/v1?verbose=1' },
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.name, 'HAXcms System API')
    assert.equal(res.body.data.version, 'v-test')
    assert.equal(res.body.data.mode, 'admin')
    assert.equal(res.body.data.links.self, '/system/api/v1')
    assert.equal(res.body.data.links.sites, '/system/api/v1/sites')
    assert.equal(res.body.data.links.openapiJson, '/system/api/v1/openapi.json')
    assert.equal(res.body.data.absoluteLinks.self, 'https://cms.example.com/system/api/v1')
    assert.deepEqual(res.body.data.supports.formats, [
      'application/json',
      'application/yaml',
    ])
    assert.equal(res.body.data.openapi.source, 'systemRoutes/openapi/system-spec.yaml')
    assert.equal(res.body.data.openapi.routeDriven, true)
  })

  test('falls back to req.url and strips deeper paths and query strings', async (t) => {
    mockDiscoveryExtras(t, 'https', 'cms.example.com')
    const res = stubRes()
    await systemDiscoveryApi(
      { headers: { host: 'cms.example.com' }, url: '/system/api/v1/system/blocks?x=1' },
      res,
    )
    assert.equal(res.body.data.links.self, '/system/api/v1')
    assert.equal(
      res.body.data.absoluteLinks.self,
      'https://cms.example.com/system/api/v1',
    )
  })

  test('an unmatched request path falls back to the configured system base', async (t) => {
    mockDiscoveryExtras(t, 'https', 'cms.example.com')
    const res = stubRes()
    await systemDiscoveryApi(
      { headers: { host: 'cms.example.com' }, originalUrl: '/somewhere/else' },
      res,
    )
    assert.equal(res.body.data.links.self, '/system/api/v1')
  })

  test('an empty trusted host keeps absolute links relative', async (t) => {
    mockDiscoveryExtras(t, 'https', '')
    const res = stubRes()
    await systemDiscoveryApi({ headers: {}, originalUrl: '/system/api/v1' }, res)
    assert.equal(res.body.data.absoluteLinks.self, '/system/api/v1')
  })
})
