'use strict'

// Latent-behavior + coverage tests for src/siteRoutes/v1/files.js, extending
// the files-routes-handlers.test.cjs patterns (direct handler tests, real temp
// site directories, HAXCMS.loadSite mocked per test, temp HAXCMS.configDirectory
// for media settings). No production behavior is fixed here — current behavior
// is asserted with characterization comments where it is a known bug.
//
// Documented latent behaviors:
//   - KNOWN BUG: convert-jpg on an already-.jpg source rejects inside sharp
//     (same input/output path) with a non-status error, so the route answers
//     the generic 500. Asserted here at the performFileOperation level; the
//     handler-level 500 is asserted in files-routes-handlers.test.cjs.
//   - rotate-90 on a truncated (header-valid, data-broken) JPEG leaks the raw
//     sharp/vips message through the 500 response (createStatusError copies
//     e.message for internal errors with a status).
//   - a corrupt files.json envelope whose `data` is a truthy non-object throws
//     a strict-mode TypeError inside FilesDataStore.load which its own catch
//     swallows: the detail silently answers 404 (empty auto-built index) and
//     the post-delete uuid scrub no-ops leaving the corrupt file in place,
//     while the DELETE still answers 200.
//
// Residue in files.js that stays uncovered (dead/defensive code, no caller):
//   - toFileRecord + getDateCreatedValue fallback branches (86-139): no caller
//   - getImgOpsOutputPath + getSafeOutputBasename (605-662): no caller
//   - convertImageToJpg sepia/black-and-white transform modes (714-725): only
//     ever invoked with 'none'
//   - scaleImageToPreset (734-758): no caller
//   - transformImageInPlace unsupported-mode branch (896-897): callers only
//     pass 'sepia'/'black-and-white'
//   - defensive/race branches: 235-236, 297-298, 324-328, 358-359, 468-472,
//     541-545, 573-574, 809-810, 855-856, 922-923, 954, 1174-1175
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')
const sharp = require('sharp')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const fileOpsRateLimiter = require('../../src/lib/fileOpsRateLimiter.js')
const {
  fileDetail,
  createFile,
  updateFile,
  deleteFile,
  performFileOperation,
  resolveSiteFilePath,
  upsertFileRecordInDataStore,
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

async function makeTempSite(t, siteName) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'files-latent-'))
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

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-latent-config-'))
  const originalConfigDirectory = HAXCMS.configDirectory
  HAXCMS.configDirectory = tmpDir
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(tmpDir)
  })
  return tmpDir
}

function writeMediaSettings(t, settings) {
  const tmpDir = useTempConfigDirectory(t)
  fs.ensureDirSync(path.join(tmpDir, 'settings'))
  fs.writeFileSync(
    path.join(tmpDir, 'settings', 'media.json'),
    JSON.stringify(settings),
  )
  return tmpDir
}

async function makeRealJpeg(filePath, width, height) {
  await sharp({
    create: { width: width, height: height, channels: 3, background: 'red' },
  })
    .jpeg({ quality: 100 })
    .toFile(filePath)
}

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

// a corrupt envelope whose `data` is a truthy non-object: FilesDataStore.load
// throws a strict-mode TypeError assigning `.files` onto a primitive
function writeCorruptFilesJson(site) {
  fs.writeFileSync(
    path.join(site.siteDirectory, 'files', 'files.json'),
    '{"schema":"HAXCMS-FILE-SCHEMA-V1","data":"corrupt-not-an-object"}',
  )
}

describe('files routes — latent behaviors', () => {
  test('an upload array whose entries have no staged path answers 400 Missing file upload', async (t) => {
    const site = await makeTempSite(t)
    mockSite(t, site)
    const res = stubRes()
    await createFile(
      makeReq({ files: [{ fieldname: 'upload', originalname: 'ghost.png' }] }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.data.message, 'Missing file upload')
  })

  test('a createFile call with an unresolvable site answers 404', async (t) => {
    t.mock.method(HAXCMS, 'loadSite', async () => null)
    const res = stubRes()
    await createFile(makeReq(), res)
    assert.equal(res.statusCode, 404)
    assert.equal(
      res.body.data.message,
      'Unable to resolve site context for /x/api/v1/files',
    )
  })

  test('jpegQuality settings clamp into the 1-100 band and fall back on NaN', async (t) => {
    // non-numeric quality -> parseInt NaN -> null -> DEFAULT (90)
    writeMediaSettings(t, { jpegQuality: 'not-a-number' })
    const siteNaN = await makeTempSite(t, 'nan-quality')
    await makeRealJpeg(path.join(siteNaN.siteDirectory, 'files', 'q.jpg'), 60, 60)
    const recordNaN = await indexSiteFile(siteNaN, 'q.jpg')
    mockSite(t, siteNaN)
    const resNaN = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: recordNaN.uuid }, body: { operation: 'compress' } }),
      resNaN,
    )
    assert.equal(resNaN.statusCode, 200)
    assert.deepEqual(siteNaN.commits, ['File compressed (medium): files/q.jpg'])
    // below the floor -> clamped to 1
    writeMediaSettings(t, { jpegQuality: 0 })
    const siteFloor = await makeTempSite(t, 'floor-quality')
    await makeRealJpeg(path.join(siteFloor.siteDirectory, 'files', 'q.jpg'), 60, 60)
    const recordFloor = await indexSiteFile(siteFloor, 'q.jpg')
    mockSite(t, siteFloor)
    const resFloor = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: recordFloor.uuid }, body: { operation: 'compress' } }),
      resFloor,
    )
    assert.equal(resFloor.statusCode, 200)
    // above the ceiling -> clamped to 100
    writeMediaSettings(t, { jpegQuality: 500 })
    const siteCeiling = await makeTempSite(t, 'ceiling-quality')
    await makeRealJpeg(path.join(siteCeiling.siteDirectory, 'files', 'q.jpg'), 60, 60)
    const recordCeiling = await indexSiteFile(siteCeiling, 'q.jpg')
    mockSite(t, siteCeiling)
    const resCeiling = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: recordCeiling.uuid }, body: { operation: 'compress' } }),
      resCeiling,
    )
    assert.equal(resCeiling.statusCode, 200)
  })

  test('resolveSiteFilePath accepts the exact files/ root as the boundary case', async (t) => {
    const site = await makeTempSite(t)
    const info = resolveSiteFilePath(site, 'files/')
    assert.equal(info.normalizedPath, 'files/')
    // no symlinks: resolvedPath equals realpath(filesRootPath) so the
    // exact-equal branch of isPathInsideDirectory is the one taken
    assert.equal(info.resolvedPath, info.filesRootPath)
  })

  test('rename with a dot-only name answers the alphanumeric 400', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'photo.jpg', 'jpg-bytes')
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'rename', newName: '.' } }),
      res,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(
      res.body.data.message,
      'New file name must include at least one alphanumeric character',
    )
  })

  test('an operation on a file behind a symlinked subdirectory answers 403', async (t) => {
    const site = await makeTempSite(t)
    // files/ itself stays real; a subdirectory inside files/ is a symlink to
    // an outside tree, so the resolved (non-real) path passes the gate but the
    // realpath lands outside the files root
    const outsideDir = path.join(path.dirname(site.siteDirectory), 'outside')
    fs.ensureDirSync(outsideDir)
    fs.symlinkSync(outsideDir, path.join(site.siteDirectory, 'files', 'sub'))
    await makeRealJpeg(path.join(outsideDir, 'escape.jpg'), 30, 30)
    const record = await indexSiteFile(site, 'sub/escape.jpg')
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'rotate-90' } }),
      res,
    )
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'File path is outside of allowed files directory')
  })

  test('scale, compress, and sepia run in place for gif and webp sources', async (t) => {
    const site = await makeTempSite(t)
    const filesDir = path.join(site.siteDirectory, 'files')
    const gifScalePath = path.join(filesDir, 'scale.gif')
    const gifCompressPath = path.join(filesDir, 'compress.gif')
    const gifSepiaPath = path.join(filesDir, 'sepia.gif')
    const webpSepiaPath = path.join(filesDir, 'sepia.webp')
    for (const target of [gifScalePath, gifCompressPath, gifSepiaPath]) {
      await sharp({
        create: { width: 90, height: 90, channels: 3, background: 'green' },
      })
        .gif()
        .toFile(target)
    }
    await sharp({
      create: { width: 90, height: 90, channels: 3, background: 'blue' },
    })
      .webp()
      .toFile(webpSepiaPath)
    const dataStore = new FilesDataStore(site)
    for (const relative of ['scale.gif', 'compress.gif', 'sepia.gif', 'sepia.webp']) {
      const record = await dataStore.buildFileRecordFromDisk('files/' + relative)
      dataStore.upsertRecord(record)
    }
    mockSite(t, site)
    const resScale = stubRes()
    await updateFile(
      makeReq({
        params: { fileUuid: dataStore.getByPath('files/scale.gif').uuid },
        body: { operation: 'scale', size: 'xs' },
      }),
      resScale,
    )
    assert.equal(resScale.statusCode, 200)
    assert.deepEqual(site.commits, ['File scaled (xs): files/scale.gif'])
    const resCompress = stubRes()
    await updateFile(
      makeReq({
        params: { fileUuid: dataStore.getByPath('files/compress.gif').uuid },
        body: { operation: 'compress' },
      }),
      resCompress,
    )
    assert.equal(resCompress.statusCode, 200)
    assert.deepEqual(
      site.commits.slice(1),
      ['File compressed (medium): files/compress.gif'],
    )
    const resWebp = stubRes()
    await updateFile(
      makeReq({
        params: { fileUuid: dataStore.getByPath('files/sepia.webp').uuid },
        body: { operation: 'sepia' },
      }),
      resWebp,
    )
    assert.equal(resWebp.statusCode, 200)
    assert.deepEqual(
      site.commits.slice(2),
      ['File transformed (sepia): files/sepia.webp'],
    )
    const resGif = stubRes()
    await updateFile(
      makeReq({
        params: { fileUuid: dataStore.getByPath('files/sepia.gif').uuid },
        body: { operation: 'black-and-white' },
      }),
      resGif,
    )
    assert.equal(resGif.statusCode, 200)
    assert.deepEqual(
      site.commits.slice(3),
      ['File transformed (black-and-white): files/sepia.gif'],
    )
  })

  test('rotate-90 on a truncated JPEG leaks the raw decoder error through the 500', async (t) => {
    const site = await makeTempSite(t)
    const filesDir = path.join(site.siteDirectory, 'files')
    const truncatedPath = path.join(filesDir, 'truncated.jpg')
    // a noise jpeg is large enough that cutting half the bytes keeps the
    // header (metadata() parses) but breaks the scan data (decode fails)
    const noise = Buffer.alloc(120 * 120 * 3)
    for (let i = 0; i < noise.length; i++) {
      noise[i] = Math.floor(Math.random() * 256)
    }
    await sharp(noise, { raw: { width: 120, height: 120, channels: 3 } })
      .jpeg()
      .toFile(truncatedPath)
    const bytes = fs.readFileSync(truncatedPath)
    fs.writeFileSync(truncatedPath, bytes.slice(0, Math.floor(bytes.length / 2)))
    const record = await indexSiteFile(site, 'truncated.jpg')
    mockSite(t, site)
    const res = stubRes()
    await updateFile(
      makeReq({ params: { fileUuid: record.uuid }, body: { operation: 'rotate-90' } }),
      res,
    )
    // Characterization: the rotate catch rethrows createStatusError(e.message,
    // 500) for internal decoder errors, so the route surfaces the raw
    // sharp/vips message instead of the generic fallback. If this fails after
    // an error-leak fix, update it to the fixed contract.
    assert.equal(res.statusCode, 500)
    assert.ok(res.body.data.message.length > 0)
    assert.notEqual(res.body.data.message, 'Unable to complete file operation')
  })

  test('KNOWN BUG: convert-jpg on a .jpg source rejects inside sharp', async (t) => {
    const site = await makeTempSite(t)
    await makeRealJpeg(path.join(site.siteDirectory, 'files', 'already.jpg'), 40, 40)
    // Characterization: getUniqueJpgOutputPaths maps an already-.jpg source
    // to an in-place re-encode (same input and output path), and sharp
    // refuses to read and write the same file, so performFileOperation
    // rejects with a NON-status error — the route then answers the generic
    // 500 'Unable to complete file operation' (asserted in
    // files-routes-handlers.test.cjs). If this fails after a route fix,
    // update it to the fixed contract.
    await assert.rejects(
      () => performFileOperation(site, 'files/already.jpg', { operation: 'convert-jpg' }, 90),
      function (err) {
        return err instanceof Error &&
          err.status === undefined &&
          err.message === 'Cannot use same file for input and output'
      },
    )
  })

  test('upsertFileRecordInDataStore answers null for a path with no file on disk', async (t) => {
    const site = await makeTempSite(t)
    const result = await upsertFileRecordInDataStore(site, 'files/ghost.jpg')
    assert.equal(result, null)
  })

  test('upsertFileRecordInDataStore scrubs a stale duplicate-path record', async (t) => {
    const site = await makeTempSite(t)
    await makeRealJpeg(path.join(site.siteDirectory, 'files', 'old.jpg'), 30, 30)
    fs.copySync(
      path.join(site.siteDirectory, 'files', 'old.jpg'),
      path.join(site.siteDirectory, 'files', 'new.jpg'),
    )
    // two records sharing one path with different uuids: the path index
    // resolves the LAST one, the rename upsert leaves the other stale, and
    // the old-path cleanup removes it
    const dataStore = new FilesDataStore(site)
    dataStore.upsertRecord({
      uuid: '11111111-1111-4111-8111-111111111111',
      path: 'files/old.jpg',
      name: 'old.jpg',
      mimetype: 'image/jpeg',
    })
    dataStore.upsertRecord({
      uuid: '22222222-2222-4222-8222-222222222222',
      path: 'files/old.jpg',
      name: 'old.jpg',
      mimetype: 'image/jpeg',
    })
    const record = await upsertFileRecordInDataStore(
      site,
      'files/new.jpg',
      'files/old.jpg',
    )
    assert.ok(record)
    assert.equal(record.uuid, '22222222-2222-4222-8222-222222222222')
    const after = new FilesDataStore(site)
    assert.equal(after.getByUuid('11111111-1111-4111-8111-111111111111'), null)
    assert.ok(after.getByUuid('22222222-2222-4222-8222-222222222222'))
  })

  test('a corrupt files.json envelope is swallowed and answers the detail 404', async (t) => {
    const site = await makeTempSite(t)
    const record = await indexSiteFile(site, 'photo.jpg', 'jpg-bytes')
    writeCorruptFilesJson(site)
    mockSite(t, site)
    const res = stubRes()
    await fileDetail(makeReq({ params: { fileUuid: record.uuid } }), res)
    // Characterization: a corrupt envelope (truthy non-object `data`) throws
    // a strict-mode TypeError inside FilesDataStore.load, but load() catches
    // it and silently auto-builds an empty index — so the detail answers a
    // plain 404 for the uuid instead of a 500. If this fails after a store
    // hardening fix, update it to the fixed contract.
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.data.message, 'Requested file was not found')
  })

  test('rate-limited deleteFile principals answer 429 with Retry-After', async (t) => {
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
      userName: 'delete-latent-rl-user',
      siteName: 'demo',
    }
    const res1 = stubRes()
    await deleteFile(makeReq({ haxcmsSiteApiAuth: auth }), res1)
    assert.equal(res1.statusCode, 400)
    assert.equal(res1.body.data.message, 'File uuid is required')
    const res2 = stubRes()
    await deleteFile(makeReq({ haxcmsSiteApiAuth: auth }), res2)
    assert.equal(res2.statusCode, 429)
    assert.ok(res2.headers['Retry-After'])
  })

  test('a delete after files.json goes corrupt still answers 200; the scrub no-ops', async (t) => {
    const site = await makeTempSite(t)
    await makeRealJpeg(path.join(site.siteDirectory, 'files', 'doomed.jpg'), 30, 30)
    const record = await indexSiteFile(site, 'doomed.jpg')
    // corrupt files.json between the uuid resolution and the post-delete
    // scrub: the scrub's store load swallows the corruption and auto-builds
    // an empty index, removeRecord finds nothing so it never rewrites the
    // file, and the delete still answers 200 with the store left corrupt
    site.gitCommit = async () => {
      writeCorruptFilesJson(site)
    }
    mockSite(t, site)
    const res = stubRes()
    await deleteFile(makeReq({ params: { fileUuid: record.uuid } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.deleted, true)
    assert.ok(!fs.pathExistsSync(path.join(site.siteDirectory, 'files', 'doomed.jpg')))
    // Characterization: the post-delete uuid scrub is a silent no-op on a
    // corrupt store — the corrupt envelope stays on disk untouched. If this
    // fails after a store hardening fix, update it to the fixed contract.
    const stillCorrupt = JSON.parse(
      fs.readFileSync(path.join(site.siteDirectory, 'files', 'files.json'), 'utf8'),
    )
    assert.equal(stillCorrupt.schema, 'HAXCMS-FILE-SCHEMA-V1')
    assert.equal(stillCorrupt.data, 'corrupt-not-an-object')
  })
})
