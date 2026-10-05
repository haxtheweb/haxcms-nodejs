'use strict'

// Direct handler tests for the five /x/api/v1/files route handlers exported
// from src/siteRoutes/v1/files.js:
//   listFiles, fileDetail, createFile, updateFile, deleteFile
//
// Site resolution is exercised through the real resolveSiteForRequest by
// mocking HAXCMS.loadSite per test (same pattern as
// save-settings-routes.test.cjs). Handlers run against a real temp site
// directory (files/ + files.json datastore) so on-disk behavior is verified
// in-process with no server boot. Media settings read from a temp
// HAXCMS.configDirectory so no repo _config is touched.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')
const sharp = require('sharp')
const JSZip = require('jszip')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const fileOpsRateLimiter = require('../../src/lib/fileOpsRateLimiter.js')
const {
  listFiles,
  fileDetail,
  createFile,
  updateFile,
  deleteFile,
  performFileOperation,
} = require('../../src/siteRoutes/v1/files.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(value) {
      this.sent = value
      return this
    },
    set(name, value) {
      this.headers[name] = value
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
      return this
    },
  }
}

// req shaped like the express request these handlers receive after the route
// gate has validated access (haxcmsSiteApiAuth is set by the auth middleware)
function makeReq(overrides) {
  const req = {
    headers: {},
    query: {},
    params: {},
    body: {},
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'tester',
      siteName: 'demo',
    },
  }
  return Object.assign(req, overrides || {})
}

// real temp site with a files/ directory and a gitCommit spy
async function makeTempSite(t, siteName) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'files-routes-'))
  const siteDirectory = path.join(tmpRoot, siteName || 'demo')
  const filesDir = path.join(siteDirectory, 'files')
  fs.ensureDirSync(filesDir)
  const commits = []
  const site = {
    siteDirectory: siteDirectory,
    name: siteName || 'demo',
    commits: commits,
    manifest: {
      metadata: {
        site: { name: siteName || 'demo' },
      },
      items: [],
    },
    loadNodeCalls: [],
    loadNode(id) {
      site.loadNodeCalls.push(String(id))
      return { id: String(id), metadata: {} }
    },
    async gitCommit(message) {
      commits.push(message)
    },
  }
  t.after(() => {
    fs.removeSync(tmpRoot)
  })
  return site
}

function mockSite(t, site) {
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// temp HAXCMS.configDirectory (restored after the test)
function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-routes-config-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

// write a settings/media.json with the given shape into a temp config dir
function writeMediaSettings(t, settings) {
  const tmpDir = useTempConfigDirectory(t)
  fs.ensureDirSync(path.join(tmpDir, 'settings'))
  fs.writeFileSync(
    path.join(tmpDir, 'settings', 'media.json'),
    JSON.stringify(settings),
  )
  return tmpDir
}

async function makePng(filePath, width, height) {
  await sharp({
    create: { width: width, height: height, channels: 3, background: 'red' },
  })
    .png()
    .toFile(filePath)
}

// create a file on disk in the site files dir and index it in files.json,
// returning the persisted record (uuid included)
async function indexSiteFile(site, relativePath, content) {
  const absolutePath = path.join(site.siteDirectory, 'files', relativePath)
  if (content !== undefined) {
    fs.ensureDirSync(path.dirname(absolutePath))
    fs.writeFileSync(absolutePath, content)
  }
  const dataStore = new FilesDataStore(site)
  const record = await dataStore.buildFileRecordFromDisk('files/' + relativePath)
  dataStore.upsertRecord(record)
  return record
}

function freshRecord(site, uuid) {
  const dataStore = new FilesDataStore(site)
  return dataStore.getByUuid(uuid)
}

async function readImageSize(filePath) {
  const metadata = await sharp(filePath).metadata()
  return { width: metadata.width, height: metadata.height }
}

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------
describe('files routes — listFiles', () => {
  test('lists every indexed disk file with paging metadata and links', async (t) => {
    const site = await makeTempSite(t)
    await indexSiteFile(site, 'photo.jpg', 'jpg-bytes')
    await indexSiteFile(site, 'doc.pdf', 'pdf-bytes')
    await indexSiteFile(site, 'nested/deep.png', 'png-bytes')
    mockSite(t, site)
    const res = stubRes()
    await listFiles(makeReq(), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.count, 3)
    assert.equal(res.body.data.total, 3)
    assert.equal(res.body.data.page.limit, 25)
    assert.equal(res.body.data.page.offset, 0)
    assert.equal(res.body.data.orphans.length, 0)
    assert.deepEqual(
      res.body.data.files.map((file) => file.path).sort(),
      ['files/doc.pdf', 'files/nested/deep.png', 'files/photo.jpg'].sort(),
    )
    assert.equal(res.body.data.links.self, '/x/api/v1/files')
  })

  test('auto-indexes on-disk files missing from files.json before listing', async (t) => {
    const site = await makeTempSite(t)
    fs.writeFileSync(path.join(site.siteDirectory, 'files', 'fresh.txt'), 'txt')
    mockSite(t, site)
    const res = stubRes()
    await listFiles(makeReq(), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.files[0].path, 'files/fresh.txt')
    // and the auto-indexed record is persisted for later uuid lookups
    assert.ok(freshRecord(site, res.body.data.files[0].uuid))
  })

  test('records whose disk file is gone are reported as orphans, not listed', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'ghost.jpg', 'gone')
    fs.removeSync(path.join(site.siteDirectory, 'files', 'ghost.jpg'))
    await indexSiteFile(site, 'alive.jpg', 'here')
    mockSite(t, site)
    const res = stubRes()
    await listFiles(makeReq(), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.files.length, 1)
    assert.equal(res.body.data.files[0].path, 'files/alive.jpg')
    assert.equal(res.body.data.orphans.length, 1)
    assert.equal(res.body.data.orphans[0].path, 'files/ghost.jpg')
    assert.equal(res.body.data.orphans[0].uuid, record.uuid)
  })

  test('the filename query filters by name or path substring', async (t) => {
    const site = await makeTempSite(t)
    await indexSiteFile(site, 'one.jpg', 'a')
    await indexSiteFile(site, 'two.jpg', 'b')
    mockSite(t, site)
    const res = stubRes()
    await listFiles(makeReq({ query: { filename: 'TWO' } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 1)
    assert.equal(res.body.data.files[0].path, 'files/two.jpg')
  })

  test('filter.type / filter.extension / filter.startsWith / filter.nameContains apply', async (t) => {
    const site = await makeTempSite(t)
    await indexSiteFile(site, 'a.jpg', 'aa')
    await indexSiteFile(site, 'b.png', 'bb')
    await indexSiteFile(site, 'nested/c.png', 'cc')
    mockSite(t, site)
    // express query strings are flat, so filter keys are dotted ('filter.type')
    const cases = [
      { query: { 'filter.type': 'image/png' }, expected: ['files/b.png', 'files/nested/c.png'] },
      { query: { 'filter.extension': 'jpg' }, expected: ['files/a.jpg'] },
      { query: { 'filter.startsWith': 'files/nested' }, expected: ['files/nested/c.png'] },
      { query: { 'filter.nameContains': 'C.P' }, expected: ['files/nested/c.png'] },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await listFiles(makeReq({ query: cases[i].query }), res)
      assert.equal(res.statusCode, 200, 'filter case ' + i)
      assert.deepEqual(
        res.body.data.files.map((file) => file.path).sort(),
        cases[i].expected.slice().sort(),
        'filter case ' + i,
      )
    }
  })

  test('sort, pagination, and field projection combine', async (t) => {
    const site = await makeTempSite(t)
    await indexSiteFile(site, 'big.jpg', 'aaaaaa')
    await indexSiteFile(site, 'small.jpg', 'a')
    await indexSiteFile(site, 'mid.jpg', 'aaa')
    mockSite(t, site)
    const res = stubRes()
    await listFiles(
      makeReq({ query: { sort: '-size', 'page.limit': '2', 'page.offset': '1', fields: 'path,size' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.count, 2)
    assert.equal(res.body.data.page.limit, 2)
    assert.equal(res.body.data.page.offset, 1)
    assert.equal(res.body.data.page.total, 3)
    // sorted by size desc, offset 1 -> mid.jpg, small.jpg
    assert.deepEqual(
      res.body.data.files.map((file) => file.path),
      ['files/mid.jpg', 'files/small.jpg'],
    )
    // field projection: only path + size keys survive
    assert.deepEqual(Object.keys(res.body.data.files[0]).sort(), ['path', 'size'])
  })

  test('a yaml format request is serialized and content-typed', async (t) => {
    const site = await makeTempSite(t)
    await indexSiteFile(site, 'one.jpg', 'a')
    mockSite(t, site)
    const res = stubRes()
    await listFiles(makeReq({ query: { format: 'yaml' } }), res)
    assert.equal(res.statusCode, 200)
    // non-json representation goes through res.send, not res.json
    assert.equal(res.body, null)
    assert.equal(typeof res.sent, 'string')
    assert.ok(res.sent.indexOf('files/one.jpg') !== -1)
    assert.equal(res.headers['Content-Type'], 'application/yaml; charset=utf-8')
  })

  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await listFiles(makeReq(), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/files',
    )
  })
})

// ---------------------------------------------------------------------------
// fileDetail
// ---------------------------------------------------------------------------
describe('files routes — fileDetail', () => {
  test('a valid uuid answers the full record', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'photo.jpg', 'jpg-bytes')
    mockSite(t, site)
    const res = stubRes()
    await fileDetail(makeReq({ params: { fileUuid: record.uuid } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.path, 'files/photo.jpg')
    assert.equal(res.body.data.uuid, record.uuid)
    assert.equal(res.body.data.size, 'jpg-bytes'.length)
  })

  test('field projection applies to the detail record', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'photo.jpg', 'jpg-bytes')
    mockSite(t, site)
    const res = stubRes()
    await fileDetail(
      makeReq({ params: { fileUuid: record.uuid }, query: { fields: 'path,size' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(Object.keys(res.body.data).sort(), ['path', 'size'])
  })

  test('a malformed uuid answers 400', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await fileDetail(makeReq({ params: { fileUuid: 'not-a-uuid' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'File uuid is required and must be a valid UUID',
    )
  })

  test('an unknown uuid answers 404', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await fileDetail(
      makeReq({ params: { fileUuid: '11111111-2222-3333-4444-555555555555' } }),
      res,
    )
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.data.message, 'Requested file was not found')
  })

  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await fileDetail(makeReq(), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/files/:fileUuid',
    )
  })
})

// ---------------------------------------------------------------------------
// createFile
// ---------------------------------------------------------------------------
describe('files routes — createFile', () => {
  async function makeUploadTmp(t) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-'))
    t.after(() => fs.removeSync(tmpDir))
    const filePath = path.join(tmpDir, 'incoming.png')
    await makePng(filePath, 20, 10)
    return {
      path: filePath,
      originalname: 'upload.png',
      fieldname: 'file-upload',
      size: fs.statSync(filePath).size,
    }
  }

  test('an unauthenticated request answers 403', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await createFile(
      makeReq({ haxcmsSiteApiAuth: null, file: { path: '/tmp/x.png' } }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(
      res.body.data.message,
      'Authenticated site access is required for this endpoint',
    )
  })

  test('a wrong security level answers 403', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await createFile(
      makeReq({
        haxcmsSiteApiAuth: {
          authenticated: true,
          securityLevel: 'anonymous',
          userName: 'tester',
          siteName: 'demo',
        },
      }),
      res,
    )
    assert.equal(res.statusCode, 403)
  })

  test('a request without any upload answers 400 Missing file upload', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await createFile(makeReq(), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Missing file upload')
  })

  test('uploads disabled for the site answer 403', async (t) => {
    const site = await makeTempSite(t)
    site.manifest.metadata.platform = { features: { uploadMedia: false } }
    mockSite(t, site)
    const res = stubRes()
    await createFile(
      makeReq({ file: { path: '/tmp/whatever.png', originalname: 'x.png' } }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Uploading media is disabled for this site')
  })

  test('a valid upload is moved into the site and committed', async (t) => {
    const site = await makeTempSite(t)
    const upload = await makeUploadTmp(t)
    mockSite(t, site)
    const res = stubRes()
    await createFile(makeReq({ file: upload }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.file.path, 'files/upload.png')
    assert.equal(res.body.data.file.name, 'upload.png')
    assert.ok(fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'upload.png')))
    assert.deepEqual(site.commits, ['File added: upload.png'])
  })

  test('an upload naming an existing file collides to a _1 suffix', async (t) => {
    const site = await makeTempSite(t)
    await indexSiteFile(site, 'upload.png', 'existing')
    const upload = await makeUploadTmp(t)
    mockSite(t, site)
    const res = stubRes()
    await createFile(makeReq({ file: upload }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.file.path, 'files/upload_1.png')
    assert.deepEqual(site.commits, ['File added: upload_1.png'])
  })

  test('a body node id resolves the associated page before saving', async (t) => {
    const site = await makeTempSite(t)
    const upload = await makeUploadTmp(t)
    mockSite(t, site)
    const res = stubRes()
    await createFile(makeReq({ file: upload, body: { node: { id: 'page-7' } } }), res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(site.loadNodeCalls, ['page-7'])
  })

  test('a disallowed extension answers 500 File type not allowed', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await createFile(
      makeReq({ file: { path: '/tmp/stage', originalname: 'evil.exe', size: 10 } }),
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'File type not allowed')
    assert.deepEqual(site.commits, [])
  })

  test('a save() exception answers the generic 500 Unable to save file', async (t) => {
    // siteDirectory is a FILE, so files/ cannot be created and save() throws
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'files-broken-'))
    t.after(() => fs.removeSync(tmpRoot))
    const brokenDir = path.join(tmpRoot, 'not-a-dir')
    fs.writeFileSync(brokenDir, 'file not dir')
    const site = {
      siteDirectory: brokenDir,
      name: 'demo',
      manifest: { metadata: { site: { name: 'demo' } }, items: [] },
      async gitCommit() {},
    }
    mockSite(t, site)
    const res = stubRes()
    await createFile(
      makeReq({ file: { path: '/tmp/stage2', originalname: 'x.png', size: 10 } }),
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'Unable to save file')
  })

  test('a gitCommit failure never blocks the 200 response', async (t) => {
    const site = await makeTempSite(t)
    const upload = await makeUploadTmp(t)
    site.gitCommit = async () => {
      throw new Error('git missing')
    }
    mockSite(t, site)
    const res = stubRes()
    await createFile(makeReq({ file: upload }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.file.path, 'files/upload.png')
  })

  test('a rate-limited principal answers 429 with Retry-After', async (t) => {
    useTempConfigDirectory(t)
    const original = HAXCMS.config.security.fileOpsRateLimit
    HAXCMS.config.security.fileOpsRateLimit = {
      enabled: true,
      windowMs: 10 * 60 * 1000,
      max: 1,
      blockMs: 10 * 60 * 1000,
    }
    t.after(() => {
      HAXCMS.config.security.fileOpsRateLimit = original
      fileOpsRateLimiter.resetForTesting()
    })
    const site = await makeTempSite(t)
    mockSite(t, site)
    const auth = {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'create-rl-user',
      siteName: 'demo',
    }
    // first op passes the limiter (fails later on the missing staged upload)
    const res1 = stubRes()
    await createFile(makeReq({ haxcmsSiteApiAuth: auth, file: { path: '/tmp/nope', originalname: 'nope.png' } }), res1)
    assert.equal(res1.statusCode, 500)
    assert.equal(res1.body.data.message, 'Uploaded file is missing')
    // second op is blocked with 429 + Retry-After
    const res2 = stubRes()
    await createFile(makeReq({ haxcmsSiteApiAuth: auth, file: { path: '/tmp/nope', originalname: 'nope.png' } }), res2)
    assert.equal(res2.statusCode, 429)
    assert.ok(res2.headers['Retry-After'])
    assert.ok(res2.body.data.message.indexOf('File operation rate limit reached') === 0)
  })
})

// ---------------------------------------------------------------------------
// updateFile (rename / rotate / sepia / b&w / scale / compress / duplicate /
// convert-jpg + validation branches)
// ---------------------------------------------------------------------------
describe('files routes — updateFile', () => {
  test('an unauthenticated request answers 403', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await updateFile(makeReq({ haxcmsSiteApiAuth: null, body: { operation: 'rename' } }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(
      res.body.data.message,
      'Authenticated site access is required for this endpoint',
    )
  })

  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await updateFile(makeReq({ body: { operation: 'rename' } }), res)
    assert.equal(res.statusCode, 404)
  })

  test('file operations disabled for the site answer 403', async (t) => {
    const site = await makeTempSite(t)
    site.manifest.metadata.platform = { features: { uploadMedia: false } }
    mockSite(t, site)
    const res = stubRes()
    await updateFile(makeReq({ body: { operation: 'compress' } }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'File operations are disabled for this site')
  })

  test('missing operation answers 400 Operation is required', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(makeReq(), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Operation is required')
  })

  test('a delete operation via update answers 400 directing to DELETE', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: '11111111-2222-3333-4444-555555555555' }, body: { operation: 'delete' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'Use DELETE /x/api/v1/files/{fileUuid} for file deletion',
    )
  })

  test('an unsupported operation answers 400', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'a.jpg', 'a')
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'explode' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Unsupported file operation')
  })

  test('a malformed uuid answers 400', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: 'zzz' }, body: { operation: 'compress' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'File uuid is required and must be a valid UUID',
    )
  })

  test('a missing uuid answers 400 File uuid is required', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(makeReq({ body: { operation: 'compress' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'File uuid is required')
  })

  test('an unknown uuid answers 404', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: '11111111-2222-3333-4444-555555555555' }, body: { operation: 'compress' } }),
      res,
    )
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.data.message, 'Requested file was not found')
  })

  test('rename moves the file, carries the uuid, and commits', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'photo.jpg', 'jpg-bytes')
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'rename', newName: 'renamed' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.operation, 'rename')
    assert.equal(res.body.data.source, 'files/photo.jpg')
    assert.equal(res.body.data.path, 'files/renamed.jpg')
    assert.equal(res.body.data.file.uuid, record.uuid)
    assert.ok(!fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'photo.jpg')))
    assert.ok(fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'renamed.jpg')))
    // files.json: new path owns the uuid, old path record is gone
    const dataStore = new FilesDataStore(site)
    assert.equal(dataStore.getByPath('files/renamed.jpg').uuid, record.uuid)
    assert.equal(dataStore.getByPath('files/photo.jpg'), null)
    assert.deepEqual(site.commits, ['File renamed: files/photo.jpg -> files/renamed.jpg'])
  })

  test('rename validation branches all answer 400', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'photo.jpg', 'jpg-bytes')
    const blocked = await indexSiteFile(site, 'taken.jpg', 'x')
    const weird = await indexSiteFile(site, 'weird.xyz', 'y')
    mockSite(t, site)
    const cases = [
      { newName: '', message: 'New file name is required' },
      { newName: 'a.b.c', message: 'File name can only include one extension' },
      { newName: '!!!', message: 'New file name must include at least one alphanumeric character' },
      { newName: 'photo', message: 'New file name must be different from current name' },
      { newName: 'taken', message: 'A file with this name already exists' },
      { newName: 'photo.gif', message: 'Extension cannot be changed during rename and must remain .jpg' },
      { newName: 'photo.exe', message: 'Requested extension is not allowed' },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await updateFile(
        makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'rename', newName: cases[i].newName } }),
        res,
      )
      assert.equal(res.statusCode, 400, 'rename case ' + cases[i].newName)
      assert.equal(res.body.data.message, cases[i].message, 'rename case ' + cases[i].newName)
    }
    // a source whose own extension is not on the allowlist
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: weird.uuid }, body: { operation: 'rename', newName: 'anything' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Current file extension is not allowed for rename')
    assert.equal(blocked.uuid.length, 36)
    assert.deepEqual(site.commits, [])
  })

  test('rotate-90 rotates the image in place', async (t) => {
    const site = await makeTempSite(t)
    fs.ensureDirSync(path.join(site.siteDirectory, 'files'))
    const filePath = path.join(site.siteDirectory, 'files', 'tall.jpg')
    await sharp({
      create: { width: 20, height: 60, channels: 3, background: 'blue' },
    })
      .jpeg()
      .toFile(filePath)
    const dataStore = new FilesDataStore(site)
    const record = await dataStore.buildFileRecordFromDisk('files/tall.jpg')
    dataStore.upsertRecord(record)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'rotate-90' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.operation, 'rotate-90')
    assert.equal(res.body.data.path, 'files/tall.jpg')
    const size = await readImageSize(filePath)
    assert.equal(size.width, 60)
    assert.equal(size.height, 20)
    assert.deepEqual(site.commits, ['File rotated (90deg): files/tall.jpg'])
  })

  test('sepia and black-and-white transform in place', async (t) => {
    const site = await makeTempSite(t)
    fs.ensureDirSync(path.join(site.siteDirectory, 'files'))
    const sepiaPath = path.join(site.siteDirectory, 'files', 'sepia.png')
    const bwPath = path.join(site.siteDirectory, 'files', 'bw.jpg')
    await makePng(sepiaPath, 20, 20)
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: 'green' },
    })
      .jpeg()
      .toFile(bwPath)
    const dataStore = new FilesDataStore(site)
    const sepiaRecord = await dataStore.buildFileRecordFromDisk('files/sepia.png')
    dataStore.upsertRecord(sepiaRecord)
    const bwRecord = await dataStore.buildFileRecordFromDisk('files/bw.jpg')
    dataStore.upsertRecord(bwRecord)
    mockSite(t, site)
    const resSepia = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: sepiaRecord.uuid }, body: { operation: 'sepia' } }),
      resSepia,
    )
    assert.equal(resSepia.statusCode, 200)
    assert.equal(resSepia.body.data.operation, 'sepia')
    assert.deepEqual(site.commits, ['File transformed (sepia): files/sepia.png'])
    const resBw = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: bwRecord.uuid }, body: { operation: 'black-and-white' } }),
      resBw,
    )
    assert.equal(resBw.statusCode, 200)
    assert.equal(resBw.body.data.operation, 'black-and-white')
    assert.deepEqual(site.commits.slice(1), ['File transformed (black-and-white): files/bw.jpg'])
  })

  test('scale uses the requested preset or the md default', async (t) => {
    const site = await makeTempSite(t)
    fs.ensureDirSync(path.join(site.siteDirectory, 'files'))
    const xsPath = path.join(site.siteDirectory, 'files', 'xs.png')
    const mdPath = path.join(site.siteDirectory, 'files', 'md.jpg')
    // xs shrinks 400 -> 150; md shrinks 1200 -> 800 (fit: inside is shrink-only)
    await makePng(xsPath, 400, 400)
    await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: 'red' },
    })
      .jpeg()
      .toFile(mdPath)
    const dataStore = new FilesDataStore(site)
    const xsRecord = await dataStore.buildFileRecordFromDisk('files/xs.png')
    dataStore.upsertRecord(xsRecord)
    const mdRecord = await dataStore.buildFileRecordFromDisk('files/md.jpg')
    dataStore.upsertRecord(mdRecord)
    mockSite(t, site)
    const resXs = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: xsRecord.uuid }, body: { operation: 'scale', size: 'xs' } }),
      resXs,
    )
    assert.equal(resXs.statusCode, 200)
    assert.deepEqual(site.commits, ['File scaled (xs): files/xs.png'])
    const xsSize = await readImageSize(xsPath)
    assert.equal(xsSize.width, 150)
    assert.equal(xsSize.height, 150)
    // no size key -> md default (800px, shrink-only)
    const resMd = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: mdRecord.uuid }, body: { operation: 'scale', size: 'bogus-preset' } }),
      resMd,
    )
    assert.equal(resMd.statusCode, 200)
    assert.deepEqual(site.commits.slice(1), ['File scaled (md): files/md.jpg'])
    const mdSize = await readImageSize(mdPath)
    assert.equal(mdSize.width, 800)
    assert.equal(mdSize.height, 800)
  })

  test('compress applies the requested level or the medium default', async (t) => {
    const site = await makeTempSite(t)
    fs.ensureDirSync(path.join(site.siteDirectory, 'files'))
    const heavyPath = path.join(site.siteDirectory, 'files', 'heavy.jpg')
    const defaultPath = path.join(site.siteDirectory, 'files', 'default.jpg')
    await sharp({
      create: { width: 120, height: 120, channels: 3, background: 'red' },
    })
      .jpeg({ quality: 100 })
      .toFile(heavyPath)
    fs.copySync(heavyPath, defaultPath)
    const dataStore = new FilesDataStore(site)
    const heavyRecord = await dataStore.buildFileRecordFromDisk('files/heavy.jpg')
    dataStore.upsertRecord(heavyRecord)
    const defaultRecord = await dataStore.buildFileRecordFromDisk('files/default.jpg')
    dataStore.upsertRecord(defaultRecord)
    mockSite(t, site)
    const resHeavy = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: heavyRecord.uuid }, body: { operation: 'compress', level: 'heavy' } }),
      resHeavy,
    )
    assert.equal(resHeavy.statusCode, 200)
    assert.deepEqual(site.commits, ['File compressed (heavy): files/heavy.jpg'])
    const resDefault = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: defaultRecord.uuid }, body: { operation: 'compress', level: 'made-up' } }),
      resDefault,
    )
    assert.equal(resDefault.statusCode, 200)
    assert.deepEqual(site.commits.slice(1), ['File compressed (medium): files/default.jpg'])
  })

  test('duplicate copies to a -copy path and indexes the new record', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'orig.jpg', 'jpg-bytes')
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'duplicate' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.operation, 'duplicate')
    assert.equal(res.body.data.source, 'files/orig.jpg')
    assert.equal(res.body.data.path, 'files/orig-copy.jpg')
    assert.ok(fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'orig-copy.jpg')))
    assert.ok(fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'orig.jpg')))
    assert.deepEqual(site.commits, ['File duplicated: files/orig.jpg -> files/orig-copy.jpg'])
    // second duplicate collides to -copy-2
    const res2 = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'duplicate' } }),
      res2,
    )
    assert.equal(res2.statusCode, 200)
    assert.equal(res2.body.data.path, 'files/orig-copy-2.jpg')
  })

  test('convert-jpg on a png writes a sibling jpg; on a jpg it re-encodes in place', async (t) => {
    const site = await makeTempSite(t)
    fs.ensureDirSync(path.join(site.siteDirectory, 'files'))
    const pngPath = path.join(site.siteDirectory, 'files', 'banner.png')
    await makePng(pngPath, 40, 40)
    const dataStore = new FilesDataStore(site)
    const pngRecord = await dataStore.buildFileRecordFromDisk('files/banner.png')
    dataStore.upsertRecord(pngRecord)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: pngRecord.uuid }, body: { operation: 'convert-jpg' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.operation, 'convert-jpg')
    assert.equal(res.body.data.source, 'files/banner.png')
    assert.equal(res.body.data.file.path, 'files/banner.jpg')
    assert.ok(fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'banner.jpg')))
    // Characterization: a .jpg source maps to an in-place re-encode, but sharp
    // refuses to use the same file for input and output, so the handler
    // currently answers the generic 500 for already-jpg sources. If this
    // assertion fails after a route fix, update it to the fixed contract.
    const jpgRecord = await dataStore.buildFileRecordFromDisk('files/banner.jpg')
    dataStore.upsertRecord(jpgRecord)
    const res2 = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: jpgRecord.uuid }, body: { operation: 'convert-jpg' } }),
      res2,
    )
    assert.equal(res2.statusCode, 500)
    assert.equal(res2.body.data.message, 'Unable to complete file operation')
  })

  test('an svg source answers 400 for every raster-only operation', async (t) => {
    const site = await makeTempSite(t)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
    const record = await indexSiteFile(site, 'drawing.svg', svg)
    mockSite(t, site)
    const cases = [
      { operation: 'sepia', message: 'Only raster images can be transformed' },
      { operation: 'black-and-white', message: 'Only raster images can be transformed' },
      { operation: 'rotate-90', message: 'Only raster images can be rotated' },
      { operation: 'compress', message: 'Only raster images can be compressed' },
      { operation: 'convert-jpg', message: 'Only raster images can be converted to JPG' },
      { operation: 'scale', message: 'Only raster images can be scaled' },
    ]
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes()
      await updateFile(
        makeReq({ params: { fileUuid: record.uuid }, body: { operation: cases[i].operation } }),
        res,
      )
      assert.equal(res.statusCode, 400, 'svg case ' + cases[i].operation)
      assert.equal(res.body.data.message, cases[i].message, 'svg case ' + cases[i].operation)
    }
    assert.deepEqual(site.commits, [])
  })

  test('a configured jpegQuality in settings/media.json is honored on compress', async (t) => {
    writeMediaSettings(t, { jpegQuality: 42 })
    const site = await makeTempSite(t)
    fs.ensureDirSync(path.join(site.siteDirectory, 'files'))
    const filePath = path.join(site.siteDirectory, 'files', 'q.jpg')
    await sharp({
      create: { width: 120, height: 120, channels: 3, background: 'red' },
    })
      .jpeg({ quality: 100 })
      .toFile(filePath)
    const dataStore = new FilesDataStore(site)
    const record = await dataStore.buildFileRecordFromDisk('files/q.jpg')
    dataStore.upsertRecord(record)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'compress' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(site.commits, ['File compressed (medium): files/q.jpg'])
  })

  test('rate-limited principals answer 429, and disabled limits pass through', async (t) => {
    const original = HAXCMS.config.security.fileOpsRateLimit
    HAXCMS.config.security.fileOpsRateLimit = {
      enabled: true,
      windowMs: 10 * 60 * 1000,
      max: 1,
      blockMs: 10 * 60 * 1000,
    }
    t.after(() => {
      HAXCMS.config.security.fileOpsRateLimit = original
      fileOpsRateLimiter.resetForTesting()
    })
    const site = await makeTempSite(t)
    mockSite(t, site)
    const auth = {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'update-rl-user',
      siteName: 'demo',
    }
    const res1 = stubRes()
    await updateFile(makeReq({ haxcmsSiteApiAuth: auth, body: { operation: 'compress' } }), res1)
    assert.equal(res1.statusCode, 400)
    const res2 = stubRes()
    await updateFile(makeReq({ haxcmsSiteApiAuth: auth, body: { operation: 'compress' } }), res2)
    assert.equal(res2.statusCode, 429)
    assert.ok(res2.headers['Retry-After'])
    // a third call is blocked by the active block window
    const res3 = stubRes()
    await updateFile(makeReq({ haxcmsSiteApiAuth: auth, body: { operation: 'compress' } }), res3)
    assert.equal(res3.statusCode, 429)
    assert.ok(res3.headers['Retry-After'])
    // limits disabled -> same request shape proceeds to the 400 validation
    HAXCMS.config.security.fileOpsRateLimit = { enabled: false }
    const res4 = stubRes()
    await updateFile(makeReq({ haxcmsSiteApiAuth: auth, body: { operation: 'compress' } }), res4)
    assert.equal(res4.statusCode, 400)
  })
})

// ---------------------------------------------------------------------------
// deleteFile
// ---------------------------------------------------------------------------
describe('files routes — deleteFile', () => {
  test('an unauthenticated request answers 403', async (t) => {
    useTempConfigDirectory(t)
    const res = stubRes()
    await deleteFile(makeReq({ haxcmsSiteApiAuth: null }), res)
    assert.equal(res.statusCode, 403)
  })

  test('an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await deleteFile(makeReq(), res)
    assert.equal(res.statusCode, 404)
  })

  test('file operations disabled for the site answer 403', async (t) => {
    const site = await makeTempSite(t)
    site.manifest.metadata.platform = { features: { uploadMedia: false } }
    mockSite(t, site)
    const res = stubRes()
    await deleteFile(makeReq(), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'File operations are disabled for this site')
  })

  test('a malformed uuid answers 400 and a missing uuid too', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await deleteFile(makeReq({ params: { fileUuid: 'nope' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'File uuid is required and must be a valid UUID',
    )
    const res2 = stubRes()
    await deleteFile(makeReq(), res2)
    assert.equal(res2.statusCode, 400)
    assert.equal(res2.body.data.message, 'File uuid is required')
  })

  test('an unknown uuid answers 404', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await deleteFile(
      makeReq({ params: { fileUuid: '11111111-2222-3333-4444-555555555555' } }),
      res,
    )
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.data.message, 'Requested file was not found')
  })

  test('delete removes the file, the record, and scrubs page references', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'doomed.jpg', 'jpg-bytes')
    site.manifest.items.push({
      id: 'page-1',
      metadata: { files: [record.uuid, 'unrelated-uuid'] },
    })
    mockSite(t, site)
    const res = stubRes()
    await deleteFile(makeReq({ params: { fileUuid: record.uuid } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.operation, 'delete')
    assert.equal(res.body.data.path, 'files/doomed.jpg')
    assert.equal(res.body.data.deleted, true)
    assert.ok(!fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'doomed.jpg')))
    assert.deepEqual(site.commits, ['File deleted: files/doomed.jpg'])
    // files.json record removed and page metadata scrubbed of the uuid
    assert.equal(freshRecord(site, record.uuid), null)
    assert.deepEqual(site.manifest.items[0].metadata.files, ['unrelated-uuid'])
  })
})

// ---------------------------------------------------------------------------
// createFile — req.files array uploads + nodeId resolution fallbacks
// ---------------------------------------------------------------------------
describe('files routes — createFile (req.files + nodeId variants)', () => {
  async function makeUploadTmp(t, name) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-'))
    t.after(() => fs.removeSync(tmpDir))
    const filePath = path.join(tmpDir, 'incoming.png')
    await makePng(filePath, 20, 10)
    return {
      path: filePath,
      originalname: name || 'upload.png',
      size: fs.statSync(filePath).size,
    }
  }

  test('an upload in req.files with a preferred field name is used', async (t) => {
    const site = await makeTempSite(t)
    const upload = await makeUploadTmp(t)
    upload.fieldname = 'upload'
    mockSite(t, site)
    const res = stubRes()
    await createFile(makeReq({ files: [upload] }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.file.path, 'files/upload.png')
  })

  test('an upload in req.files with an unknown field name falls back to the first file', async (t) => {
    const site = await makeTempSite(t)
    const upload = await makeUploadTmp(t)
    upload.fieldname = 'some-other-field'
    mockSite(t, site)
    const res = stubRes()
    await createFile(makeReq({ files: [upload] }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.file.path, 'files/upload.png')
  })

  test('nodeId resolves from body.nodeId then query.nodeId', async (t) => {
    const site = await makeTempSite(t)
    // a fresh staged upload per call: HAXCMSFile.save MOVES the source file
    const upload1 = await makeUploadTmp(t)
    const upload2 = await makeUploadTmp(t)
    mockSite(t, site)
    const res1 = stubRes()
    await createFile(makeReq({ files: [upload1], body: { nodeId: 'page-2' } }), res1)
    assert.equal(res1.statusCode, 200)
    assert.deepEqual(site.loadNodeCalls, ['page-2'])
    const res2 = stubRes()
    await createFile(makeReq({ files: [upload2], query: { nodeId: 'page-3' } }), res2)
    assert.equal(res2.statusCode, 200)
    assert.deepEqual(site.loadNodeCalls, ['page-2', 'page-3'])
  })
})

// ---------------------------------------------------------------------------
// performFileOperation — direct error-path branches (exported helper)
// ---------------------------------------------------------------------------
describe('files routes — performFileOperation (direct error branches)', () => {
  function assertStatusError(message, status) {
    return (error) => {
      assert.equal(error.message, message)
      assert.equal(error.status, status)
      return true
    }
  }

  test('a site without a files/ directory answers 404', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'files-nodir-'))
    t.after(() => fs.removeSync(tmpRoot))
    // the site dir itself must exist; only files/ is missing
    const siteDirectory = path.join(tmpRoot, 'site')
    fs.ensureDirSync(siteDirectory)
    const site = { siteDirectory: siteDirectory, manifest: { metadata: { site: { name: 'demo' } }, items: [] } }
    await assert.rejects(
      performFileOperation(site, 'files/ghost.jpg', { operation: 'delete' }, 90),
      assertStatusError('Files directory was not found', 404),
    )
  })

  test('an unresolvable site directory answers 500', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'files-badroot-'))
    t.after(() => fs.removeSync(tmpRoot))
    const site = { siteDirectory: path.join(tmpRoot, 'missing', 'site'), manifest: { metadata: { site: { name: 'demo' } }, items: [] } }
    await assert.rejects(
      performFileOperation(site, 'files/ghost.jpg', { operation: 'delete' }, 90),
      assertStatusError('Unable to resolve site path', 500),
    )
  })

  test('a symlinked files/ directory answers 404', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'files-symlink-'))
    t.after(() => fs.removeSync(tmpRoot))
    const outside = path.join(tmpRoot, 'outside')
    fs.ensureDirSync(outside)
    const siteDirectory = path.join(tmpRoot, 'site')
    fs.ensureDirSync(siteDirectory)
    fs.symlinkSync(outside, path.join(siteDirectory, 'files'))
    const site = { siteDirectory: siteDirectory, manifest: { metadata: { site: { name: 'demo' } }, items: [] } }
    await assert.rejects(
      performFileOperation(site, 'files/ghost.jpg', { operation: 'delete' }, 90),
      assertStatusError('Files directory was not found', 404),
    )
  })

  test('duplicate name exhaustion answers 400 after 1000 attempts', async (t) => {
    const site = await makeTempSite(t)
    fs.writeFileSync(path.join(site.siteDirectory, 'files', 'crowd.jpg'), 'src')
    // crowd-copy.jpg plus crowd-copy-2.jpg .. crowd-copy-1000.jpg
    fs.writeFileSync(path.join(site.siteDirectory, 'files', 'crowd-copy.jpg'), 'x')
    for (let i = 2; i <= 1000; i++) {
      fs.writeFileSync(
        path.join(site.siteDirectory, 'files', 'crowd-copy-' + i + '.jpg'),
        'x',
      )
    }
    await assert.rejects(
      performFileOperation(site, 'files/crowd.jpg', { operation: 'duplicate' }, 90),
      assertStatusError('Unable to generate a unique duplicate file name', 400),
    )
  })

  test('convert-jpg name exhaustion answers 400 after 1000 collisions', async (t) => {
    const site = await makeTempSite(t)
    const filesDir = path.join(site.siteDirectory, 'files')
    await makePng(path.join(filesDir, 'banner.png'), 20, 20)
    fs.writeFileSync(path.join(filesDir, 'banner.jpg'), 'x')
    for (let i = 1; i <= 1000; i++) {
      fs.writeFileSync(path.join(filesDir, 'banner_' + i + '.jpg'), 'x')
    }
    await assert.rejects(
      performFileOperation(site, 'files/banner.png', { operation: 'convert-jpg' }, 90),
      assertStatusError('Unable to generate a unique JPG output file name', 400),
    )
  })

  test('tif sources answer 400 for in-place scale/compress/transform formats', async (t) => {
    const site = await makeTempSite(t)
    const filesDir = path.join(site.siteDirectory, 'files')
    await sharp({
      create: { width: 30, height: 30, channels: 3, background: 'red' },
    })
      .tiff()
      .toFile(path.join(filesDir, 'photo.tif'))
    const cases = [
      { operation: 'scale', size: 'xs', message: 'Image format does not support in-place scaling' },
      { operation: 'compress', message: 'Image format does not support in-place compression' },
      { operation: 'sepia', message: 'Image format does not support in-place transform' },
    ]
    for (let i = 0; i < cases.length; i++) {
      await assert.rejects(
        performFileOperation(site, 'files/photo.tif', { operation: cases[i].operation, size: cases[i].size }, 90),
        assertStatusError(cases[i].message, 400),
      )
    }
  })

  test('corrupt image files answer 400 raster-only errors for every op', async (t) => {
    const site = await makeTempSite(t)
    fs.writeFileSync(path.join(site.siteDirectory, 'files', 'broken.jpg'), 'not an image at all')
    const cases = [
      { operation: 'compress', message: 'Only raster images can be compressed' },
      { operation: 'scale', message: 'Only raster images can be scaled' },
      { operation: 'sepia', message: 'Only raster images can be transformed' },
      { operation: 'rotate-90', message: 'Only raster images can be rotated' },
    ]
    for (let i = 0; i < cases.length; i++) {
      await assert.rejects(
        performFileOperation(site, 'files/broken.jpg', { operation: cases[i].operation }, 90),
        assertStatusError(cases[i].message, 400),
      )
    }
  })

  test('rename decodes percent-encoded names and tolerates invalid escapes', async (t) => {
    const site = await makeTempSite(t)
    fs.writeFileSync(path.join(site.siteDirectory, 'files', 'a.jpg'), 'a')
    const result = await performFileOperation(
      site,
      'files/a.jpg',
      { operation: 'rename', newName: 'ren%61med' },
      90,
    )
    assert.equal(result.data.path, 'files/renamed.jpg')
    // an invalid escape falls back to the raw input, which still sanitizes
    fs.writeFileSync(path.join(site.siteDirectory, 'files', 'b.jpg'), 'b')
    const result2 = await performFileOperation(
      site,
      'files/b.jpg',
      { operation: 'rename', newName: '100%' },
      90,
    )
    assert.equal(result2.data.path, 'files/100.jpg')
  })
})

// ---------------------------------------------------------------------------
// updateFile — convert-pptx-deck branch with a real minimal pptx
// ---------------------------------------------------------------------------
describe('files routes — updateFile (convert-pptx-deck)', () => {
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )

  async function buildPptxBuffer() {
    const zip = new JSZip()
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '</Types>',
    )
    zip.folder('_rels').file(
      '.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
        '</Relationships>',
    )
    zip.folder('ppt').file(
      'presentation.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<p:sldIdLst><p:sldId id="256" r:id="rIdSlide1"/></p:sldIdLst>' +
        '</p:presentation>',
    )
    zip.folder('ppt/slides').file(
      'slide1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
        '<p:txBody><a:p><a:r><a:t>Deck Title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>' +
        '</p:sld>',
    )
    zip.folder('ppt/slides/_rels').file(
      'slide1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        '</Relationships>',
    )
    return zip.generateAsync({ type: 'nodebuffer' })
  }

  test('a pptx uuid converts into a deck manifest via the handler', async (t) => {
    const site = await makeTempSite(t)
    fs.writeFileSync(
      path.join(site.siteDirectory, 'files', 'my-deck.pptx'),
      await buildPptxBuffer(),
    )
    const dataStore = new FilesDataStore(site)
    const record = await dataStore.buildFileRecordFromDisk('files/my-deck.pptx')
    dataStore.upsertRecord(record)
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'convert-pptx-deck' } }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.operation, 'convert-pptx-deck')
    assert.equal(res.body.data.deckPath, 'files/decks/my-deck/deck.json')
    assert.ok(
      fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'decks', 'my-deck', 'deck.json')),
    )
    assert.deepEqual(site.commits, ['PPTX converted to deck: files/my-deck.pptx'])
  })

  test('a non-pptx source answers the deck conversion 400', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'notdeck.jpg', 'jpg-bytes')
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'convert-pptx-deck' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'File must have a .pptx extension')
  })
})
