'use strict'

// Direct handler unit tests for two system routes:
//   src/systemRoutes/v1/routes/downloadSite.js (real archiver zip of a temp
//     site directory under isolated instance-level HAXCMS_ROOT/sites/
//     published directories, verified by unzipping the produced archive)
//   src/systemRoutes/v1/routes/cloneSite.js (HAXCMS.loadSite/getUniqueName/
//     recurseCopy/generateUUID mocked per test; the clone's files.json
//     prefix rewrite runs for real against temp directories)
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const downloadSite = require('../../src/systemRoutes/v1/routes/downloadSite.js')
const cloneSite = require('../../src/systemRoutes/v1/routes/cloneSite.js')

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

// isolate the instance-level root/directories downloadSite writes through
function useTempRoots(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siteops-'))
  const originalRoot = HAXCMS.HAXCMS_ROOT
  const originalSites = HAXCMS.sitesDirectory
  const originalPublished = HAXCMS.publishedDirectory
  HAXCMS.HAXCMS_ROOT = tmpRoot + '/'
  HAXCMS.sitesDirectory = '_sites'
  HAXCMS.publishedDirectory = '_published'
  t.after(() => {
    HAXCMS.HAXCMS_ROOT = originalRoot
    HAXCMS.sitesDirectory = originalSites
    HAXCMS.publishedDirectory = originalPublished
    fs.removeSync(tmpRoot)
  })
  return tmpRoot
}

describe('downloadSite route', () => {
  test('zips the site directory and answers the download link', async (t) => {
    const tmpRoot = useTempRoots(t)
    const siteDirectory = path.join(tmpRoot, '_sites', 'demosite')
    fs.ensureDirSync(path.join(siteDirectory, 'pages'))
    fs.writeFileSync(path.join(siteDirectory, 'site.json'), '{"id":"demo"}')
    fs.writeFileSync(path.join(siteDirectory, 'pages', 'index.html'), '<p>page</p>')
    fs.ensureDirSync(path.join(siteDirectory, 'node_modules', 'junk'))
    fs.writeFileSync(path.join(siteDirectory, 'node_modules', 'junk', 'x.js'), 'x')
    t.mock.method(HAXCMS, 'loadSite', async () => ({
      name: 'demosite',
      manifest: { metadata: { site: { name: 'demosite' } } },
    }))
    const res = stubRes()
    await downloadSite({ body: { site: { name: 'demosite' } } }, res)
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.name, 'demosite.zip')
    assert.equal(res.sent.data.link, '/_published/demosite.zip')
    // the zip exists and carries the site files, without node_modules
    const zipPath = path.join(tmpRoot, '_published', 'demosite.zip')
    assert.ok(fs.pathExistsSync(zipPath))
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
    const names = Object.keys(zip.files)
    assert.ok(names.indexOf('site.json') !== -1)
    assert.ok(names.indexOf('pages/index.html') !== -1)
    assert.equal(names.some((name) => name.indexOf('node_modules') !== -1), false)
    const siteJson = JSON.parse(await zip.file('site.json').async('string'))
    assert.equal(siteJson.id, 'demo')
  })

  test('leaves symlinks out of the zip so it carries no dangling links', async (t) => {
    const tmpRoot = useTempRoots(t)
    const siteDirectory = path.join(tmpRoot, '_sites', 'demosite')
    fs.ensureDirSync(path.join(siteDirectory, 'assets'))
    fs.ensureDirSync(path.join(siteDirectory, 'files'))
    fs.writeFileSync(path.join(siteDirectory, 'site.json'), '{"id":"demo"}')
    fs.writeFileSync(path.join(siteDirectory, 'assets', 'logo.svg'), '<svg/>')
    // multi-site layout: shared assets live above the site directory and a
    // scaffolded site links to them (HAXCMS.createSite)
    fs.ensureDirSync(path.join(tmpRoot, 'build', 'es6'))
    fs.writeFileSync(path.join(tmpRoot, 'build', 'es6', 'x.js'), 'x')
    fs.writeFileSync(path.join(tmpRoot, 'wc-registry.json'), '{}')
    fs.symlinkSync('../../build', path.join(siteDirectory, 'build'))
    fs.symlinkSync('../../dist', path.join(siteDirectory, 'dist'))
    fs.symlinkSync('../../wc-registry.json', path.join(siteDirectory, 'wc-registry.json'))
    // the babel targets sit outside this layout, so this one already dangles
    fs.symlinkSync('../../../babel/babel-top.js', path.join(siteDirectory, 'assets', 'babel-top.js'))
    // names containing glob characters must be matched literally
    fs.symlinkSync(
      '../../wc-registry.json',
      path.join(siteDirectory, 'files', 'link[1] (copy).json'),
    )
    t.mock.method(HAXCMS, 'loadSite', async () => ({
      name: 'demosite',
      manifest: { metadata: { site: { name: 'demosite' } } },
    }))
    const res = stubRes()
    await downloadSite({ body: { site: { name: 'demosite' } } }, res)
    assert.equal(res.sent.status, 200)
    const zipPath = path.join(tmpRoot, '_published', 'demosite.zip')
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
    const names = Object.keys(zip.files)
    // real files are untouched
    assert.ok(names.indexOf('site.json') !== -1)
    assert.ok(names.indexOf('assets/logo.svg') !== -1)
    // none of the links made it in, valid or dangling
    assert.deepEqual(
      names.filter((name) => zip.files[name].unixPermissions !== null && (zip.files[name].unixPermissions & 0o170000) === 0o120000),
      [],
    )
    assert.equal(names.indexOf('build'), -1)
    assert.equal(names.indexOf('dist'), -1)
    assert.equal(names.indexOf('wc-registry.json'), -1)
    assert.equal(names.indexOf('assets/babel-top.js'), -1)
    assert.equal(names.some((name) => name.indexOf('link[1]') !== -1), false)
  })
})

describe('cloneSite route', () => {
  test('clones the site, rewrites files.json prefixes, and saves', async (t) => {
    const tmpRoot = useTempRoots(t)
    const sourceDirectory = path.join(tmpRoot, '_sites', 'demosite')
    const cloneDirectory = path.join(tmpRoot, '_sites', 'clone-site')
    fs.ensureDirSync(path.join(sourceDirectory, 'files'))
    fs.writeFileSync(path.join(sourceDirectory, 'site.json'), '{"id":"source"}')
    // the recurseCopy spy materializes the clone tree the handler expects
    fs.ensureDirSync(path.join(cloneDirectory, 'files'))
    fs.copySync(
      path.join(sourceDirectory, 'site.json'),
      path.join(cloneDirectory, 'site.json'),
    )
    fs.writeFileSync(
      path.join(cloneDirectory, 'files', 'files.json'),
      JSON.stringify({
        schema: 'HAXCMS-FILE-SCHEMA-V1',
        site: 'demosite',
        data: {
          files: [
            {
              uuid: 'keep-this-uuid',
              path: 'files/hero.png',
              url: 'files/hero.png',
              fullUrl: '/_sites/demosite/files/hero.png',
            },
          ],
        },
      }),
    )
    const sourceSite = {
      name: 'demosite',
      siteDirectory: sourceDirectory,
      manifest: { metadata: { site: { name: 'demosite' } } },
    }
    const newSite = {
      name: 'clone-site',
      siteDirectory: cloneDirectory,
      saveCalls: [],
      async save() {
        newSite.saveCalls.push(true)
      },
      manifest: {
        id: 'source-uuid',
        metadata: { site: { name: 'demosite' } },
      },
    }
    let loadCall = 0
    t.mock.method(HAXCMS, 'loadSite', async () => {
      loadCall++
      return loadCall === 1 ? sourceSite : newSite
    })
    t.mock.method(HAXCMS, 'getUniqueName', () => 'clone-site')
    t.mock.method(HAXCMS, 'generateUUID', () => 'fresh-clone-uuid')
    const copyCalls = []
    t.mock.method(HAXCMS, 'recurseCopy', async (source, destination) => {
      copyCalls.push({ source: source, destination: destination })
    })
    const res = stubRes()
    await cloneSite({ body: { site: { name: 'demosite' } } }, res)
    assert.equal(res.statusCode, null)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.name, 'clone-site')
    assert.equal(res.sent.data.detail, '/_sites/clone-site')
    // the clone copy ran from source to clone paths
    assert.equal(copyCalls.length, 1)
    assert.equal(copyCalls[0].source, tmpRoot + '/_sites/demosite')
    assert.equal(copyCalls[0].destination, tmpRoot + '/_sites/clone-site')
    // the clone manifest was renamed and re-identified
    assert.equal(newSite.manifest.metadata.site.name, 'clone-site')
    assert.equal(newSite.manifest.id, 'fresh-clone-uuid')
    assert.deepEqual(newSite.saveCalls, [true])
    // files.json rewritten: new prefix, uuid preserved
    const rewritten = JSON.parse(
      fs.readFileSync(path.join(cloneDirectory, 'files', 'files.json'), 'utf8'),
    )
    assert.equal(rewritten.site, 'clone-site')
    assert.equal(rewritten.data.files[0].uuid, 'keep-this-uuid')
    assert.equal(rewritten.data.files[0].path, 'files/hero.png')
    assert.equal(rewritten.data.files[0].fullUrl, '/_sites/clone-site/files/hero.png')
  })

  test('a missing files.json clones cleanly without the rewrite', async (t) => {
    const tmpRoot = useTempRoots(t)
    const sourceDirectory = path.join(tmpRoot, '_sites', 'demosite')
    const cloneDirectory = path.join(tmpRoot, '_sites', 'clone-site')
    fs.ensureDirSync(sourceDirectory)
    fs.ensureDirSync(cloneDirectory)
    const sourceSite = {
      name: 'demosite',
      siteDirectory: sourceDirectory,
      manifest: { metadata: { site: { name: 'demosite' } } },
    }
    const newSite = {
      name: 'clone-site',
      siteDirectory: cloneDirectory,
      saveCalls: [],
      async save() {
        newSite.saveCalls.push(true)
      },
      manifest: {
        metadata: { site: { name: 'demosite' } },
      },
    }
    let loadCall = 0
    t.mock.method(HAXCMS, 'loadSite', async () => {
      loadCall++
      return loadCall === 1 ? sourceSite : newSite
    })
    t.mock.method(HAXCMS, 'getUniqueName', () => 'clone-site')
    t.mock.method(HAXCMS, 'generateUUID', () => 'fresh-clone-uuid')
    t.mock.method(HAXCMS, 'recurseCopy', async () => {})
    const res = stubRes()
    await cloneSite({ body: { site: { name: 'demosite' } } }, res)
    assert.equal(res.sent.status, 200)
    assert.equal(res.sent.data.name, 'clone-site')
    assert.deepEqual(newSite.saveCalls, [true])
    assert.equal(fs.pathExistsSync(path.join(cloneDirectory, 'files', 'files.json')), false)
  })
})
