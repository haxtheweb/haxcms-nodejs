'use strict'

// Unit tests for cloneSite files.json rewrite logic (#3043).
//
// Mirrors the PHP cloneSite test: when a site is cloned, the files.json
// datastore is copied into the clone and its path/fullUrl prefixes are
// rewritten for the new site name, PRESERVING uuids (per #3043: "uuids for
// files don't get rewritten if we clone the site").
//
// Tests the rewriteCloneFilesJson helper directly (extracted from cloneSite
// for testability). The helper reads the clone's files.json, rewrites each
// record's path/fullUrl/url, updates the envelope site name, and writes back.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const cloneSite = require('../../src/systemRoutes/v1/routes/cloneSite.js')
const rewriteCloneFilesJson = cloneSite.rewriteCloneFilesJson
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const {
  getDeterministicFileUuid,
} = require('../../src/lib/siteFileUuid.js')

// Helper: create a temp site directory with a files/ subdir.
async function makeTempSite(siteName) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
  const siteDirectory = path.join(tmpRoot, siteName || 'testsite')
  const filesDir = path.join(siteDirectory, 'files')
  await fs.ensureDir(filesDir)
  const site = {
    siteDirectory: siteDirectory,
    name: siteName || 'testsite',
    manifest: {
      metadata: {
        site: { name: siteName || 'testsite' },
      },
    },
  }
  return { tmpRoot, site, siteDirectory, filesDir }
}

describe('cloneSiteFilesJson — #3043', () => {
  let tmpRoot
  let filesDir
  let cloneFilesJsonPath

  beforeEach(async () => {
    const ctx = await makeTempSite('clonesite')
    tmpRoot = ctx.tmpRoot
    filesDir = ctx.filesDir
    cloneFilesJsonPath = path.join(filesDir, 'files.json')
  })

  afterEach(async () => {
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  test('rewrites fullUrl prefix and preserves uuids', async () => {
    // Manually create a source files.json with a multisite fullUrl prefix
    // (buildFilePublicUrl only adds the /_sites/<name>/ prefix in multisite
    // mode, so we craft the envelope directly to test the rewrite logic).
    const testUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const envelope = {
      schema: 'HAXCMS-FILE-SCHEMA-V1',
      site: 'source',
      generated: 0,
      data: {
        path: 'files',
        files: [{
          uuid: testUuid,
          path: 'files/banner.jpg',
          fullUrl: '/_sites/source/files/banner.jpg?t=123',
          url: 'files/banner.jpg',
          name: 'banner.jpg',
          mimetype: 'image/jpeg',
          size: 100,
        }],
      },
    }
    await fs.writeFile(cloneFilesJsonPath, JSON.stringify(envelope))

    // Run the rewrite.
    const result = rewriteCloneFilesJson({
      cloneFilesJsonPath: cloneFilesJsonPath,
      cloneName: 'clone',
      sourceUrlPrefixes: ['/_sites/source/files/', '/sites/source/files/'],
      targetUrlPrefix: '/_sites/clone/files/',
      sourceFileSystemPrefix: '',
      targetFileSystemPrefix: '',
    })
    assert.equal(result, true)

    // Read the rewritten files.json.
    const rewritten = JSON.parse(fs.readFileSync(cloneFilesJsonPath, 'utf8'))
    assert.equal(rewritten.site, 'clone')
    assert.equal(rewritten.data.files.length, 1)
    // uuid preserved.
    assert.equal(rewritten.data.files[0].uuid, testUuid)
    // path stays relative (files/...).
    assert.equal(rewritten.data.files[0].path, 'files/banner.jpg')
    // fullUrl prefix rewritten from /_sites/source/ to /_sites/clone/.
    assert.ok(rewritten.data.files[0].fullUrl.indexOf('/_sites/clone/files/') !== -1)
    assert.ok(rewritten.data.files[0].fullUrl.indexOf('/_sites/source/') === -1)
    // url mirrors path.
    assert.equal(rewritten.data.files[0].url, 'files/banner.jpg')
  })

  test('preserves uuids across multiple records', async () => {
    const sourceSite = {
      siteDirectory: path.join(tmpRoot, 'source2'),
      name: 'source2',
      manifest: { metadata: { site: { name: 'source2' } } },
    }
    const sourceFilesDir = path.join(sourceSite.siteDirectory, 'files')
    await fs.ensureDir(sourceFilesDir)
    await fs.writeFile(path.join(sourceFilesDir, 'a.jpg'), 'aaa')
    await fs.writeFile(path.join(sourceFilesDir, 'b.pdf'), 'bbb')
    const sourceStore = new FilesDataStore(sourceSite)
    const recA = await sourceStore.buildFileRecordFromDisk('files/a.jpg')
    const recB = await sourceStore.buildFileRecordFromDisk('files/b.pdf')
    sourceStore.upsertRecord(recA)
    sourceStore.upsertRecord(recB)

    await fs.copy(
      path.join(sourceFilesDir, 'files.json'),
      cloneFilesJsonPath,
    )

    rewriteCloneFilesJson({
      cloneFilesJsonPath: cloneFilesJsonPath,
      cloneName: 'clone2',
      sourceUrlPrefixes: ['/_sites/source2/files/'],
      targetUrlPrefix: '/_sites/clone2/files/',
      sourceFileSystemPrefix: '',
      targetFileSystemPrefix: '',
    })

    const rewritten = JSON.parse(fs.readFileSync(cloneFilesJsonPath, 'utf8'))
    assert.equal(rewritten.data.files.length, 2)
    // Both uuids preserved.
    const uuids = rewritten.data.files.map(function (r) { return r.uuid })
    assert.ok(uuids.indexOf(recA.uuid) !== -1)
    assert.ok(uuids.indexOf(recB.uuid) !== -1)
  })

  test('returns false when files.json is missing', () => {
    const result = rewriteCloneFilesJson({
      cloneFilesJsonPath: path.join(filesDir, 'nonexistent.json'),
      cloneName: 'clone',
      sourceUrlPrefixes: [],
      targetUrlPrefix: '',
      sourceFileSystemPrefix: '',
      targetFileSystemPrefix: '',
    })
    assert.equal(result, false)
  })

  test('returns false when files.json is corrupt', async () => {
    await fs.writeFile(cloneFilesJsonPath, 'not valid json{{{')
    const result = rewriteCloneFilesJson({
      cloneFilesJsonPath: cloneFilesJsonPath,
      cloneName: 'clone',
      sourceUrlPrefixes: [],
      targetUrlPrefix: '',
      sourceFileSystemPrefix: '',
      targetFileSystemPrefix: '',
    })
    assert.equal(result, false)
  })

  test('handles empty files array', async () => {
    const emptyEnvelope = {
      schema: 'HAXCMS-FILE-SCHEMA-V1',
      site: 'source',
      generated: 0,
      data: { path: 'files', files: [] },
    }
    await fs.writeFile(cloneFilesJsonPath, JSON.stringify(emptyEnvelope))
    const result = rewriteCloneFilesJson({
      cloneFilesJsonPath: cloneFilesJsonPath,
      cloneName: 'clone',
      sourceUrlPrefixes: [],
      targetUrlPrefix: '',
      sourceFileSystemPrefix: '',
      targetFileSystemPrefix: '',
    })
    assert.equal(result, true)
    const rewritten = JSON.parse(fs.readFileSync(cloneFilesJsonPath, 'utf8'))
    assert.equal(rewritten.site, 'clone')
    assert.deepEqual(rewritten.data.files, [])
  })

  test('rewrites legacy /sites/ prefix in fullUrl', async () => {
    const envelope = {
      schema: 'HAXCMS-FILE-SCHEMA-V1',
      site: 'source',
      generated: 0,
      data: {
        path: 'files',
        files: [{
          uuid: 'test-uuid-123',
          path: 'files/legacy.jpg',
          fullUrl: '/sites/source/files/legacy.jpg',
          url: 'files/legacy.jpg',
          name: 'legacy.jpg',
          mimetype: 'image/jpeg',
          size: 100,
        }],
      },
    }
    await fs.writeFile(cloneFilesJsonPath, JSON.stringify(envelope))
    rewriteCloneFilesJson({
      cloneFilesJsonPath: cloneFilesJsonPath,
      cloneName: 'clone',
      sourceUrlPrefixes: ['/sites/source/files/'],
      targetUrlPrefix: '/sites/clone/files/',
      sourceFileSystemPrefix: '',
      targetFileSystemPrefix: '',
    })
    const rewritten = JSON.parse(fs.readFileSync(cloneFilesJsonPath, 'utf8'))
    assert.equal(rewritten.data.files[0].fullUrl, '/sites/clone/files/legacy.jpg')
    // uuid preserved.
    assert.equal(rewritten.data.files[0].uuid, 'test-uuid-123')
  })
})
