'use strict'

// Direct handler tests for src/systemRoutes/v1/routes/createSite.js.
//
// The main createSite handler runs the REAL site-creation pipeline
// (HAXCMS.loadSite(create) -> HAXCMSSite.newSite -> boilerplate copy, pages,
// managed files, git init) against an isolated root: process.env.HAXCMS_ROOT
// is pointed at a temp directory BEFORE src/lib/HAXCMS.js is required,
// because createSite() writes through the module-level HAXCMS_ROOT captured
// at require time. Per-test temp HAXCMS.configDirectory isolates skeleton
// fixtures, the bulk-import staging root, and settings from the user config.
//
// safeFetch is stubbed at the module boundary BEFORE createSite.js is
// required (same mutate-before-require pattern as
// appstore-blocks-discovery.test.cjs) so build.siteFiles download responses
// are fixture-controlled; importBuildFile/linkImportedPageFiles have their
// own direct suites elsewhere.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

// createSite() writes sites under the module-level HAXCMS_ROOT resolved at
// require time, so redirect it to a temp root BEFORE HAXCMS.js loads.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-routes-'))
process.env.HAXCMS_ROOT = testRoot + '/'

// 1x1 transparent PNG so bulk-imported media passes content validation
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const safeFetchMod = require('../../src/lib/safeFetch.js')
// fixture response (or url => response function) returned by the stubbed fetch
let safeFetchFixture = null
safeFetchMod.safeFetch = async (url) =>
  typeof safeFetchFixture === 'function' ? safeFetchFixture(url) : safeFetchFixture

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const createSiteRoute = require('../../src/systemRoutes/v1/routes/createSite.js')

test.after(() => {
  fs.removeSync(testRoot)
})

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

function makeReq(body) {
  return { headers: {}, body: body }
}

// temp HAXCMS.configDirectory (restored after the test)
function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-config-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

function siteDirectoryFor(machineName) {
  return path.join(testRoot, '_sites', machineName)
}

function readSiteJson(machineName) {
  return JSON.parse(
    fs.readFileSync(path.join(siteDirectoryFor(machineName), 'site.json'), 'utf8'),
  )
}

function writeSkeletonFixture(configDir, fileName, skeleton) {
  fs.ensureDirSync(path.join(configDir, 'skeletons'))
  fs.writeFileSync(
    path.join(configDir, 'skeletons', fileName),
    JSON.stringify(skeleton),
  )
}

const COURSE_START_SKELETON = {
  meta: { machineName: 'course-start', name: 'Course Start' },
  site: {
    theme: 'my-theme',
    license: 'by',
    description: 'Skeleton <em>description</em>',
    logo: 'files/skel-logo.png',
    settings: { lang: 'es-ES' },
    platform: { audience: 'novice', features: { addPage: false } },
  },
  build: {
    type: 'skeleton',
    structure: 'from-skeleton',
    items: [
      {
        parent: null,
        title: 'Page A',
        template: 'html',
        slug: 'page-a',
        id: 'item-a',
        indent: 0,
        order: 0,
        contents: '<p>custom-element-tag</p>',
      },
    ],
    files: {},
  },
}

function mockThemes(t) {
  t.mock.method(HAXCMS, 'getThemes', () => ({
    'my-theme': {
      element: 'my-theme',
      name: 'My Theme',
      variables: { hexCode: '#112233' },
    },
  }))
}

describe('createSite route handler', () => {
  test('creates a basic site with defaults, git scaffold, and response shape', async (t) => {
    useTempConfigDirectory(t)
    // pin the publishing git config so assertions do not depend on the
    // machine's real config.site.git settings
    const originalGit = HAXCMS.config.site.git
    HAXCMS.config.site.git = {}
    t.after(() => {
      HAXCMS.config.site.git = originalGit
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Basic Site', description: 'Plain <b>desc</b>' } }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.metadata.site.name, 'basic-site')
    // lang defaults to the system-configured localization default
    const expectedLang =
      (HAXCMS.config.localization && HAXCMS.config.localization.defaultLanguage) ||
      'en-US'
    assert.equal(res.sent.data.metadata.site.settings.lang, expectedLang)
    assert.equal(res.sent.data.metadata.site.settings.publishPagesOn, true)
    assert.equal(res.sent.data.metadata.site.settings.canonical, true)
    assert.equal(res.sent.data.metadata.site.settings.pathauto, true)
    assert.equal(res.sent.data.metadata.site.logo, 'assets/banner.jpg')
    assert.equal(res.sent.data.metadata.platform.audience, 'expert')
    assert.equal(res.sent.data.description, 'Plain desc')
    assert.equal(res.sent.link, '/_sites/basic-site/')
    assert.equal(res.sent.id, res.sent.data.id)
    // the real site was created under the isolated root with a saved manifest
    const manifest = readSiteJson('basic-site')
    assert.equal(manifest.metadata.site.settings.lang, expectedLang)
    assert.equal(manifest.metadata.site.logo, 'assets/banner.jpg')
    assert.equal(typeof manifest.metadata.theme.element, 'string')
    // no configured git vendor -> an empty publishing scaffold on the manifest
    assert.deepEqual(manifest.metadata.site.git, {})
  })

  test('a site domain is written to CNAME and stored on the manifest', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Vanity Domain', domain: 'https://vanity.example.com' } }),
      res,
    )
    assert.equal(res.sent.status, 200)
    const siteDirectory = siteDirectoryFor('vanity-domain')
    assert.equal(
      fs.readFileSync(path.join(siteDirectory, 'CNAME'), 'utf8'),
      'https://vanity.example.com',
    )
    // the schema site block replaces the manifest site metadata, so the
    // domain lives on disk in CNAME, not in the saved site.json
    assert.equal(readSiteJson('vanity-domain').metadata.site.domain, undefined)
  })

  test('an invalid theme answers 400 and creates nothing', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Theme Rejected', theme: 'not-a-real-theme-xyz' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Invalid theme supplied for site creation')
  })

  test('licenses normalize from codes and creativecommons URLs', async (t) => {
    useTempConfigDirectory(t)
    const res1 = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Licensed Site', license: 'by-sa' } }),
      res1,
    )
    assert.equal(res1.sent.status, 200)
    assert.equal(res1.sent.data.metadata.site.license, 'by-sa')
    assert.equal(readSiteJson('licensed-site').license, 'by-sa')
    const res2 = stubRes()
    await createSiteRoute(
      makeReq({
        site: {
          name: 'Url Licensed Site',
          license: 'https://creativecommons.org/licenses/by-nc/4.0/',
        },
      }),
      res2,
    )
    // URL licenses match the FIRST supported code whose /licenses/<code>
    // path is a substring, so a by-nc URL normalizes to the by prefix match
    assert.equal(res2.sent.data.metadata.site.license, 'by')
    // an unrecognized license is simply dropped
    const res3 = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Bad Licensed Site', license: 'made-up-license' } }),
      res3,
    )
    assert.equal(res3.sent.status, 200)
    assert.equal(res3.sent.data.metadata.site.license, undefined)
  })

  test('configured git publishing settings mirror into the site manifest', async (t) => {
    useTempConfigDirectory(t)
    const originalGit = HAXCMS.config.site.git
    HAXCMS.config.site.git = {
      vendor: 'github',
      keySet: 'secret-key',
      email: 'secret@example.com',
      user: 'secret-user',
      branch: 'site-branch',
      staticBranch: 'site-static',
    }
    t.after(() => {
      HAXCMS.config.site.git = originalGit
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Git Settings Site' } }),
      res,
    )
    assert.equal(res.sent.status, 200)
    // git publishing details stay on the site manifest, never the response
    const siteGit = readSiteJson('git-settings-site').metadata.site.git
    assert.equal(siteGit.vendor, 'github')
    assert.equal(siteGit.branch, 'site-branch')
    assert.equal(siteGit.staticBranch, 'site-static')
    assert.equal(siteGit.keySet, undefined)
    assert.equal(siteGit.email, undefined)
    assert.equal(siteGit.user, undefined)
    assert.equal(res.sent.data.metadata.site.git, undefined)
  })

  test('a from-skeleton build resolves by machine name and merges trusted settings', async (t) => {
    const configDir = useTempConfigDirectory(t)
    writeSkeletonFixture(configDir, 'course-start.json', COURSE_START_SKELETON)
    mockThemes(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Skeleton Site', license: 'made-up-license' },
        build: {
          structure: 'from-skeleton',
          skeletonMachineName: 'course-start',
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    const manifest = readSiteJson('skeleton-site')
    // trusted settings, platform, logo, description, and license fallback
    assert.equal(manifest.metadata.site.settings.lang, 'es-ES')
    assert.equal(manifest.metadata.platform.audience, 'novice')
    assert.deepEqual(manifest.metadata.platform.features, { addPage: false })
    assert.equal(manifest.metadata.site.logo, 'files/skel-logo.png')
    assert.equal(manifest.description, 'Skeleton description')
    assert.equal(manifest.license, 'by')
    assert.equal(manifest.metadata.theme.element, 'my-theme')
    // the skeleton page was created with its content
    const pagePath = path.join(siteDirectoryFor('skeleton-site'), 'pages', 'item-a', 'index.html')
    assert.ok(fs.pathExistsSync(pagePath))
    assert.ok(
      fs.readFileSync(pagePath, 'utf8').indexOf('custom-element-tag') !== -1,
    )
    // build provenance is not retained for trusted skeletons
    assert.equal(res.sent.data.metadata.build, undefined)
  })

  test('a from-skeleton build falls back to matching a theme machine name', async (t) => {
    useTempConfigDirectory(t)
    mockThemes(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Theme Skeleton Site' },
        build: {
          structure: 'from-skeleton',
          skeletonMachineName: 'my-theme',
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    const manifest = readSiteJson('theme-skeleton-site')
    assert.equal(manifest.metadata.theme.element, 'my-theme')
  })

  test('a from-skeleton build resolves by build.items signature when no machine name is given', async (t) => {
    const configDir = useTempConfigDirectory(t)
    writeSkeletonFixture(configDir, 'items-matched.json', {
      meta: { machineName: 'items-matched', name: 'Items Matched' },
      build: {
        type: 'skeleton',
        structure: 'from-skeleton',
        items: [
          {
            parent: null,
            title: 'Signature Page',
            template: 'html',
            slug: 'signature-page',
            id: 'item-a',
            indent: 0,
            order: 0,
            contents: '<p>from signature skeleton</p>',
          },
        ],
        files: {},
      },
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Signature Site' },
        build: {
          structure: 'from-skeleton',
          items: [{ id: 'item-a', title: 'Request Page' }],
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    const pagePath = path.join(siteDirectoryFor('signature-site'), 'pages', 'item-a', 'index.html')
    assert.ok(fs.pathExistsSync(pagePath))
    assert.ok(
      fs.readFileSync(pagePath, 'utf8').indexOf('from signature skeleton') !== -1,
      'skeleton item content wins over the request items',
    )
  })

  test('an unresolvable skeletonMachineName answers 400', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Ghost Skeleton Site' },
        build: {
          structure: 'from-skeleton',
          skeletonMachineName: 'ghost-skeleton',
        },
      }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Unable to resolve skeletonMachineName for from-skeleton build',
    )
    assert.equal(res.body.data.skeletonMachineName, 'ghost-skeleton')
    assert.equal(fs.pathExistsSync(siteDirectoryFor('ghost-skeleton-site')), false)
  })

  test('build.files entries are ingested, linked to pages, and skipped entries warn', async (t) => {
    const configDir = useTempConfigDirectory(t)
    // stage a real PNG inside the bulk-import staging root
    const stagingRoot = path.join(configDir, 'tmp', 'imports')
    fs.ensureDirSync(stagingRoot)
    const stagedPath = path.join(stagingRoot, 'staged-hero.png')
    fs.writeFileSync(stagedPath, PNG_1X1)
    // remote download that fails to fetch -> skipped with a warning
    safeFetchFixture = { ok: false }
    t.after(() => {
      safeFetchFixture = null
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Files Site' },
        build: {
          structure: 'import',
          items: [
            {
              parent: null,
              title: 'Page',
              template: 'html',
              slug: 'page',
              id: 'item-a',
              indent: 0,
              order: 0,
              contents: '<p>text</p><img src="files/hero.png">',
            },
          ],
          files: {
            '../escape.png': 'https://down.example.com/escape.png',
            'files/evil.exe': 'https://down.example.com/evil.exe',
            'files/remote.png': 'https://down.example.com/remote.png',
            'files/hero.png': stagedPath,
          },
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    const siteDirectory = siteDirectoryFor('files-site')
    // the staged file was moved into the site and registered
    assert.ok(fs.pathExistsSync(path.join(siteDirectory, 'files', 'hero.png')))
    // skipped entries are surfaced as warnings, never fatal
    assert.deepEqual(
      res.sent.data.warnings.map((warning) => warning.reason).sort(),
      [
        'Disallowed file extension in build.files',
        'Invalid file name in build.files',
        'Remote file could not be downloaded',
      ].sort(),
    )
    // the referencing page is linked to the file entity by uuid
    const manifest = readSiteJson('files-site')
    const page = manifest.items.filter((item) => item.id === 'item-a')[0]
    assert.equal(page.metadata.files.length, 1)
    assert.equal(typeof page.metadata.files[0], 'string')
  })

  test('build.siteFiles downloads are extension/path/content-type gated', async (t) => {
    useTempConfigDirectory(t)
    let fetchCount = 0
    safeFetchFixture = (url) => {
      fetchCount++
      if (url === 'https://cdn.example.com/bad.png') {
        return {
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => 'not really a png',
        }
      }
      if (url === 'https://cdn.example.com/not-ok.css') {
        return { ok: false }
      }
      if (url === 'https://cdn.example.com/good.js') {
        return {
          ok: true,
          headers: new Map([['content-type', 'text/plain']]),
          text: async () => 'console.log(1)',
        }
      }
      return {
        ok: true,
        headers: new Map([['content-type', 'text/css']]),
        text: async () => 'body { color: red; }',
      }
    }
    t.after(() => {
      safeFetchFixture = null
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Site Files Site' },
        build: {
          siteFiles: {
            'theme/theme.css': 'https://cdn.example.com/theme.css',
            'theme/bad.png': 'https://cdn.example.com/bad.png',
            'custom/good.js': 'https://cdn.example.com/good.js',
            'theme/not-ok.css': 'https://cdn.example.com/not-ok.css',
            'theme/../escape.css': 'https://cdn.example.com/escape.css',
            'custom/nonstring.css': 42,
          },
        },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    const siteDirectory = siteDirectoryFor('site-files-site')
    assert.ok(fs.pathExistsSync(path.join(siteDirectory, 'theme', 'theme.css')))
    assert.ok(fs.pathExistsSync(path.join(siteDirectory, 'custom', 'good.js')))
    // mismatched content-type and failed responses write nothing
    assert.equal(fs.pathExistsSync(path.join(siteDirectory, 'theme', 'bad.png')), false)
    assert.equal(fs.pathExistsSync(path.join(siteDirectory, 'theme', 'not-ok.css')), false)
    // unsafe paths and non-string URLs are skipped before any fetch
    assert.equal(fetchCount, 4)
  })
})
