'use strict'

// Latent-branch + coverage tests for src/systemRoutes/v1/routes/createSite.js,
// extending the create-site-route.test.cjs harness (temp HAXCMS_ROOT pointed
// at a temp tree BEFORE HAXCMS.js loads, safeFetch stubbed at the module
// boundary, per-test temp HAXCMS.configDirectory, mockable HAXCMS.getThemes).
// No production behavior is fixed here — current behavior is asserted with
// characterization comments where it is latent.
//
// Documented latent behaviors:
//   - getSupportedSiteLicenseCodes consults HAXCMS.getLicenseData, but that
//     method lives on HAXCMSSite, not the HAXCMS core singleton, so the
//     dynamic license-options block never runs in production; it is exercised
//     here with a method ASSIGNED onto the core singleton (t.mock.method
//     cannot create a missing method).
//   - a from-skeleton machine name that normalizes to the empty string
//     ('.json') resolves nothing and answers the unresolvable-skeleton 400.
//   - resolveSkeletonBuildByThemeMachineName without a default-starter
//     skeleton anywhere generates a bare trusted skeleton and still creates
//     the site.
//   - the theme-machine-name fallback prefers the registry theme over the
//     crafted default-starter's own _skeleton.fullThemeConfig: the generated
//     skeleton's site.theme (the matched theme key) wins.
//   - cloneJsonValue falls back to the ORIGINAL reference for JSON-hostile
//     values (BigInt), so the site schema can end up sharing the theme
//     registry object.
//   - KNOWN BUG: configured git staticBranch/branch are NEVER created. The
//     publishing git settings mirror into the new site's manifest, but
//     git-interface's createBranch wraps the branch name in literal single
//     quotes (its splitRegex tokenizes "'checkout", "-b", "'probe-branch'"),
//     so `git checkout -b "'probe-branch'"` exits non-zero, the throw is
//     swallowed by the surrounding catch, and the site is still created 200
//     with only the default branch. Asserted as current behavior.
//
// Residue in createSite.js that stays uncovered (dead/defensive code):
//   - normalizeSiteFilePath non-string branch (26-27): for-in keys are strings
//   - siteFileContentTypeAcceptable unmapped-extension branch (64-65): every
//     SAFE_SITE_FILE extension is mapped in HAXCMSFile.ALLOWED_MIME_BY_EXTENSION
//   - normalizeSkeletonMachineName non-string branch (114-115): callers
//     type-check first
//   - resolveSkeletonByBuildItems stat-race continue (332-333)
//   - cloneJsonValue undefined/null branch (367-368): callers guard
//   - getTrustedSkeletonSettings/Platform/Theme non-object guards (379-380,
//     400-401, 417-418): useTrustedSkeleton guarantees object-like skeletons
//   - the post-assignment theme guard (770-771): theme is always object-like
//     by the time it runs
//   - isSystemV1Request (483-494): defined but never called
//   - the 403 Authentication required branch (952-954): both token helpers
//     always return true
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const util = require('node:util')
const childProcess = require('node:child_process')

const execFile = util.promisify(childProcess.execFile)

// createSite() writes sites under the module-level HAXCMS_ROOT resolved at
// require time, so redirect it to a temp root BEFORE HAXCMS.js loads.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-latent-'))
process.env.HAXCMS_ROOT = testRoot + '/'

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

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-latent-config-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

// point coreConfigPath at a temp core-config tree (skeletons/nodeFields.json)
function useTempCoreConfigPath(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-latent-core-'))
  const originalCoreConfigPath = HAXCMS.coreConfigPath
  HAXCMS.coreConfigPath = tmpDir + '/'
  t.after(() => {
    HAXCMS.coreConfigPath = originalCoreConfigPath
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
    typeof skeleton === 'string' ? skeleton : JSON.stringify(skeleton),
  )
}

function mockThemes(t, themes) {
  t.mock.method(HAXCMS, 'getThemes', () => themes)
}

// a registry carrying BOTH the harness theme and the platform default
// (clean-two) so requests that do not specify a theme still resolve
function mockStandardThemes(t) {
  mockThemes(t, {
    'my-theme': { element: 'my-theme', name: 'My Theme', variables: {} },
    'clean-two': { element: 'clean-two', name: 'Clean Two', variables: {} },
  })
}

// getLicenseData lives on HAXCMSSite, not the core singleton, so the dynamic
// license-options branch needs the method ASSIGNED onto the singleton
function useCoreGetLicenseData(t, options) {
  const hadMethod = typeof HAXCMS.getLicenseData === 'function'
  const original = HAXCMS.getLicenseData
  HAXCMS.getLicenseData = () => options
  t.after(() => {
    if (hadMethod) {
      HAXCMS.getLicenseData = original
    } else {
      delete HAXCMS.getLicenseData
    }
  })
}

async function listBranches(machineName) {
  const result = await execFile('git', ['--no-pager', 'branch'], {
    cwd: siteDirectoryFor(machineName),
    maxBuffer: 1024 * 1024,
  })
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.replace('*', '').trim())
    .filter((line) => line !== '')
}

describe('createSite latent branches — build.siteFiles gates', () => {
  test('unsafe siteFiles names and extension denials are skipped, headerless responses write', async (t) => {
    useTempConfigDirectory(t)
    const fetched = []
    safeFetchFixture = (url) => {
      fetched.push(url)
      // a response with NO content-type header is acceptable
      return { ok: true, headers: new Map(), text: async () => 'headerless body' }
    }
    t.after(() => {
      safeFetchFixture = null
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent Site Files' },
        build: {
          siteFiles: {
            'theme//double-slash.css': 'https://cdn.example.com/double.css',
            'theme/evil.php': 'https://cdn.example.com/evil.php',
            'theme/headerless.css': 'https://cdn.example.com/headerless.css',
            'custom/nonstring.css': 42,
          },
        },
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    const siteDirectory = siteDirectoryFor('latent-site-files')
    // absent Content-Type is accepted, so the headerless file is written
    assert.ok(fs.pathExistsSync(path.join(siteDirectory, 'theme', 'headerless.css')))
    // double-slash segment and denied extension are rejected before any fetch
    assert.deepEqual(fetched, ['https://cdn.example.com/headerless.css'])
  })
})

describe('createSite latent branches — importBuildFile boolean contract', () => {
  test('non-string and empty-segment names answer false with warnings', async (t) => {
    const site = {
      siteDirectory: siteDirectoryFor('latent-import-contract'),
      manifest: { metadata: { site: { name: 'x' } }, items: [] },
    }
    const warnings = []
    assert.equal(await createSiteRoute.importBuildFile(site, 42, 'staged', 0, warnings), false)
    assert.equal(
      await createSiteRoute.importBuildFile(site, 'a//b.jpg', 'staged', 1, warnings),
      false,
    )
    assert.deepEqual(warnings.map((warning) => warning.reason), [
      'Invalid file name in build.files',
      'Invalid file name in build.files',
    ])
  })
})

describe('createSite latent branches — licenses', () => {
  test('a mocked core getLicenseData replaces the supported license options', async (t) => {
    useTempConfigDirectory(t)
    mockStandardThemes(t)
    // Characterization: getSupportedSiteLicenseCodes reads
    // HAXCMS.getLicenseData, but that method is defined on HAXCMSSite, so in
    // production the dynamic license-options block never runs and the default
    // six CC codes stay. Assigned onto the core here to walk the block.
    useCoreGetLicenseData(t, {
      'custom-license': 'Custom License',
      'by_ish': 'By Ish',
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Latent Custom License', license: 'custom-license' } }),
      res,
    )
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.metadata.site.license, 'custom-license')
    assert.equal(readSiteJson('latent-custom-license').license, 'custom-license')
    // underscores in option keys normalize to hyphens
    const resUnderscore = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Latent Underscore License', license: 'by-ish' } }),
      resUnderscore,
    )
    assert.equal(resUnderscore.sent.data.metadata.site.license, 'by-ish')
  })

  test('a whitespace-only license normalizes to null and is dropped', async (t) => {
    useTempConfigDirectory(t)
    mockStandardThemes(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({ site: { name: 'Latent Blank License', license: '   ' } }),
      res,
    )
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.metadata.site.license, undefined)
  })
})

describe('createSite latent branches — skeleton resolution', () => {
  test('junk skeleton dir entries are skipped while resolving by machine name', async (t) => {
    const configDir = useTempConfigDirectory(t)
    // a non-json file and a corrupt json are both skipped during the walk
    writeSkeletonFixture(configDir, 'notes.txt', 'not a skeleton')
    writeSkeletonFixture(configDir, 'broken.json', '{ this is not json')
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent Junk Skel' },
        build: { structure: 'from-skeleton', skeletonMachineName: 'ghost-skel' },
      }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Unable to resolve skeletonMachineName for from-skeleton build',
    )
  })

  test('a machine name that normalizes to empty (dot-json) answers the 400', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent Dot Json' },
        build: { structure: 'from-skeleton', skeletonMachineName: '.json' },
      }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.skeletonMachineName, '.json')
  })

  test('a null theme registry answers the unresolvable 400', async (t) => {
    useTempConfigDirectory(t)
    mockThemes(t, null)
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent No Themes' },
        build: { structure: 'from-skeleton', skeletonMachineName: 'my-theme' },
      }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Unable to resolve skeletonMachineName for from-skeleton build',
    )
  })

  test('no default-starter anywhere generates a bare theme-fallback skeleton', async (t) => {
    useTempConfigDirectory(t)
    // empty temp core config: no default-starter.json anywhere
    const coreDir = useTempCoreConfigPath(t)
    assert.ok(fs.existsSync(path.join(coreDir, 'skeletons')) === false)
    mockThemes(t, {
      'my-theme': { element: 'my-theme', name: 'My Theme', variables: {} },
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent Generated Skel' },
        build: { structure: 'from-skeleton', skeletonMachineName: 'my-theme' },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    const manifest = readSiteJson('latent-generated-skel')
    assert.equal(manifest.metadata.theme.element, 'my-theme')
  })

  test('a crafted default-starter walks the trusted-skeleton fallback branches', async (t) => {
    useTempConfigDirectory(t)
    const coreDir = useTempCoreConfigPath(t)
    // corrupt meta/site strings exercise the normalization branches while
    // _skeleton carries fullThemeConfig + originalSettings + originalMetadata
    fs.ensureDirSync(path.join(coreDir, 'skeletons'))
    fs.writeFileSync(
      path.join(coreDir, 'skeletons', 'default-starter.json'),
      JSON.stringify({
        meta: 'corrupt-meta',
        site: 'corrupt-site',
        _skeleton: {
          fullThemeConfig: {
            settings: { lang: 'es-ES' },
            element: 'crafted-theme',
            variables: { icon: 'icons:crafted', cssVariable: '--crafted-var', hexCode: '#abcdef' },
          },
          originalSettings: { lang: 'de-DE' },
          originalMetadata: {
            platform: { audience: 'novice', features: { addPage: false } },
          },
        },
      }),
    )
    mockThemes(t, {
      'my-theme': { element: 'my-theme', name: 'My Theme', variables: {} },
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent Crafted Skel' },
        build: { structure: 'from-skeleton', skeletonMachineName: 'my-theme' },
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    const manifest = readSiteJson('latent-crafted-skel')
    // Characterization: the registry theme won the theme merge, so the crafted
    // fullThemeConfig's element/variables did NOT land on the manifest (the
    // generated fallback skeleton's own site.theme is the matched theme key,
    // and the registry clone overrides the crafted config). The crafted
    // originalSettings/originalMetadata still provided site settings +
    // platform. If this fails after a merge-order fix, update it.
    assert.equal(manifest.metadata.theme.element, 'my-theme')
    // originalSettings (site.settings absent) provided the site settings
    assert.equal(manifest.metadata.site.settings.lang, 'de-DE')
    // originalMetadata.platform provided the platform
    assert.equal(manifest.metadata.platform.audience, 'novice')
    assert.deepEqual(manifest.metadata.platform.features, { addPage: false })
  })

  test('a machine-name skeleton with a path-only theme infers the element', async (t) => {
    const configDir = useTempConfigDirectory(t)
    // the crafted skeleton is resolved BY MACHINE NAME (my-theme.json in the
    // config skeletons dir), so the raw skeleton content flows through as
    // the trusted skeleton. The theme-machine-name fallback path force-sets
    // trustedSkeleton.site.theme to the matched key, so it can never reach
    // the skeleton.theme branch below; a machine-name resolve can.
    writeSkeletonFixture(configDir, 'my-theme.json', {
      meta: { machineName: 'my-theme', name: 'My Theme Skeleton' },
      // site carries license/description/logo but no theme/settings/platform
      site: {
        license: 'by-sa',
        description: 'Crafted two <b>desc</b>',
        logo: 'files/crafted-logo.png',
      },
      // top-level theme has a path but no element/variables, so the element
      // is inferred from the basename and variables default to {}
      theme: { path: 'build/es6/inferred-theme.js' },
      _skeleton: {
        originalMetadata: {
          site: { settings: { lang: 'it-IT', pathauto: false } },
          platform: { audience: 'beginner' },
        },
      },
    })
    mockStandardThemes(t)
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent Crafted Two', license: 'made-up' },
        build: { structure: 'from-skeleton', skeletonMachineName: 'my-theme' },
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    const manifest = readSiteJson('latent-crafted-two')
    // element inferred from the theme path basename; the variable defaults
    // (icon / hexCode / cssVariable) are injected for every site afterwards
    assert.equal(manifest.metadata.theme.element, 'inferred-theme')
    assert.equal(manifest.metadata.theme.variables.icon, 'icons:record-voice-over')
    assert.equal(manifest.metadata.theme.variables.hexCode, '#3f51b5')
    assert.equal(
      manifest.metadata.theme.variables.cssVariable,
      '--simple-colors-default-theme-light-blue-7',
    )
    // the skeleton license answered for the dropped request license
    assert.equal(manifest.license, 'by-sa')
    // originalMetadata.site.settings provided the site settings
    assert.equal(manifest.metadata.site.settings.lang, 'it-IT')
    assert.equal(manifest.metadata.site.settings.pathauto, false)
    assert.equal(manifest.metadata.site.logo, 'files/crafted-logo.png')
  })

  test('a JSON-hostile theme registry value breaks the site save entirely', async (t) => {
    useTempConfigDirectory(t)
    // Characterization: cloneJsonValue(JSON.stringify) throws for BigInt, so
    // the theme falls back to the ORIGINAL registry object (shared reference)
    // with the hostile value still inside — and the shared reference then
    // poisons manifest.save, so createSite rejects with the BigInt TypeError
    // after the site directory was already copied to disk. If this fails
    // after a hardening fix, update it to the fixed contract.
    const registryTheme = {
      element: 'bigint-theme',
      name: 'Big Int Theme',
      variables: {},
      hostile: BigInt(7),
    }
    mockThemes(t, {
      'bigint-theme': registryTheme,
      'clean-two': { element: 'clean-two', name: 'Clean Two', variables: {} },
    })
    await assert.rejects(
      () => createSiteRoute(
        makeReq({ site: { name: 'Latent Bigint Theme', theme: 'bigint-theme' } }),
        stubRes(),
      ),
      function (err) {
        return err instanceof TypeError &&
          err.message.indexOf('Do not know how to serialize a BigInt') !== -1
      },
    )
    // the boilerplate site directory was created and the manifest was
    // saved once during the initial page build, but the poisoned theme
    // prevents the post-merge manifest save — so the hostile value never
    // persists and the request never answers 200
    assert.ok(fs.pathExistsSync(siteDirectoryFor('latent-bigint-theme')))
    const partialManifest = readSiteJson('latent-bigint-theme')
    assert.equal(partialManifest.metadata.theme.hostile, undefined)
    assert.equal(partialManifest.metadata.theme.element, undefined)
  })

  test('a skeleton matching by items signature walks the resolver skips', async (t) => {
    const configDir = useTempConfigDirectory(t)
    // junk that resolveSkeletonByBuildItems must skip: non-json file, a
    // directory named *.json, corrupt json, array json, and an empty-items
    // skeleton; a 7-item skeleton exercises the signature cap without matching
    fs.ensureDirSync(path.join(configDir, 'skeletons', 'subdir.json'))
    writeSkeletonFixture(configDir, 'skip-notes.txt', 'not json')
    writeSkeletonFixture(configDir, 'skip-broken.json', '{ nope')
    writeSkeletonFixture(configDir, 'skip-array.json', JSON.stringify([1, 2]))
    writeSkeletonFixture(configDir, 'skip-empty.json', {
      meta: { machineName: 'skip-empty' },
      build: { type: 'skeleton', structure: 'from-skeleton', items: [], files: {} },
    })
    const wantedItems = []
    for (let i = 0; i < 7; i++) {
      wantedItems.push({ id: 'wanted-' + i, title: 'Wanted ' + i })
    }
    writeSkeletonFixture(configDir, 'wanted-skeleton.json', {
      meta: { machineName: 'wanted-skeleton' },
      build: {
        type: 'skeleton',
        structure: 'from-skeleton',
        items: wantedItems,
        files: {},
      },
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent Signature Skel' },
        build: {
          structure: 'from-skeleton',
          items: wantedItems.slice(0, 2),
        },
      }),
      res,
    )
    // the wanted skeleton's 7-item signature does not match the 2-item
    // request signature, so nothing resolves and no machine name was given
    assert.equal(res.sent.status, 200)
    assert.ok(fs.pathExistsSync(siteDirectoryFor('latent-signature-skel')))
  })

  test('a request signature without string ids falls back to the passed items', async (t) => {
    const configDir = useTempConfigDirectory(t)
    writeSkeletonFixture(configDir, 'real-skeleton.json', {
      meta: { machineName: 'real-skeleton' },
      build: {
        type: 'skeleton',
        structure: 'from-skeleton',
        items: [{ id: 'real-item', title: 'Real Item' }],
        files: {},
      },
    })
    const res = stubRes()
    await createSiteRoute(
      makeReq({
        site: { name: 'Latent No Ids' },
        build: {
          structure: 'from-skeleton',
          items: [{ title: 'No Id Given', contents: '<p>passed item body</p>' }],
        },
      }),
      res,
    )
    assert.equal(res.sent.status, 200)
    // the id-less signature matched nothing, so the request items themselves
    // built the pages
    const manifest = readSiteJson('latent-no-ids')
    assert.equal(manifest.items.length, 1)
    assert.equal(manifest.items[0].title, 'No Id Given')
  })
})

describe('createSite latent branches — git publishing', () => {
  test('KNOWN BUG: configured staticBranch/branch never materialize in the repo', async (t) => {
    useTempConfigDirectory(t)
    const originalGit = HAXCMS.config.site.git
    HAXCMS.config.site.git = {
      vendor: 'github',
      keySet: 'secret-key',
      email: 'secret@example.com',
      user: 'secret-user',
      branch: 'latent-site-branch',
      staticBranch: 'latent-static-branch',
    }
    t.after(() => {
      HAXCMS.config.site.git = originalGit
    })
    const res = stubRes()
    await createSiteRoute(makeReq({ site: { name: 'Latent Git Branches' } }), res)
    assert.equal(res.sent.status, 200)
    // the publishing settings DID mirror into the site manifest
    const manifest = readSiteJson('latent-git-branches')
    assert.equal(manifest.metadata.site.git.staticBranch, 'latent-static-branch')
    assert.equal(manifest.metadata.site.git.branch, 'latent-site-branch')
    // Characterization: git-interface's createBranch wraps the branch name in
    // literal single quotes ('checkout -b 'name'' tokenizes into quoted
    // tokens), so both `git checkout -b` calls exit non-zero inside the
    // swallowed catch and the repo keeps only the default branch. If this
    // fails after a git-interface fix or a createSite workaround, update it
    // to assert the branches exist.
    const branches = await listBranches('latent-git-branches')
    assert.ok(branches.indexOf('master') !== -1 || branches.indexOf('main') !== -1)
    assert.equal(branches.indexOf('latent-static-branch'), -1)
    assert.equal(branches.indexOf('latent-site-branch'), -1)
  })
})
