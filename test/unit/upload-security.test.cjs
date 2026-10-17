'use strict'

// Unit tests for src/lib/uploadSecurity.js (SEC-UPLOAD): temp-file cleanup,
// stale temp sweeper, conversion upload cap, and the decoded-path
// force-download decision for site files/ directories.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict, temp dirs via fs.mkdtempSync.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const uploadSecurity = require(path.resolve(__dirname, '..', '..', 'src', 'lib', 'uploadSecurity.js'))

const HOUR = 60 * 60 * 1000

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-upload-security-'))
}

function writeAged(filePath, ageMs, now) {
  fs.outputFileSync(filePath, 'x')
  const when = new Date(now - ageMs)
  fs.utimesSync(filePath, when, when)
}

test('isUploadTempFileName only matches multer and HAXcms temp names', () => {
  assert.equal(uploadSecurity.isUploadTempFileName('0123456789abcdef0123456789abcdef'), true)
  assert.equal(
    uploadSecurity.isUploadTempFileName('inline-image-123e4567-e89b-12d3-a456-426614174000'),
    true,
  )
  assert.equal(uploadSecurity.isUploadTempFileName('haxcms-upload-1700000000000-42'), true)
  assert.equal(uploadSecurity.isUploadTempFileName('0123456789ABCDEF0123456789ABCDEF'), false)
  assert.equal(uploadSecurity.isUploadTempFileName('0123456789abcdef0123456789abcdef.html'), false)
  assert.equal(uploadSecurity.isUploadTempFileName('imports'), false)
  assert.equal(uploadSecurity.isUploadTempFileName('keep-me.txt'), false)
})

test('sweeper deletes only old multer temp files and old import staging entries', () => {
  const dir = makeTempDir()
  const now = Date.now()
  const oldMulter = path.join(dir, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const freshMulter = path.join(dir, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  const oldInline = path.join(dir, 'inline-image-123e4567-e89b-12d3-a456-426614174000')
  const oldOther = path.join(dir, 'notes.txt')
  const oldHexWithExt = path.join(dir, 'cccccccccccccccccccccccccccccccc.html')
  const oldHexDir = path.join(dir, 'dddddddddddddddddddddddddddddddd')
  const importsOld = path.join(dir, 'imports', 'haximp-old.png')
  const importsTwoHours = path.join(dir, 'imports', 'haximp-recent.png')
  writeAged(oldMulter, 2 * HOUR, now)
  writeAged(freshMulter, 10 * 60 * 1000, now)
  writeAged(oldInline, 3 * HOUR, now)
  writeAged(oldOther, 48 * HOUR, now)
  writeAged(oldHexWithExt, 48 * HOUR, now)
  fs.ensureDirSync(oldHexDir)
  fs.utimesSync(oldHexDir, new Date(now - 48 * HOUR), new Date(now - 48 * HOUR))
  writeAged(importsOld, 25 * HOUR, now)
  writeAged(importsTwoHours, 2 * HOUR, now)
  try {
    const removed = uploadSecurity.sweepUploadTempDirectory(dir, { now: now })
    assert.deepEqual(removed.slice().sort(), [importsOld, oldInline, oldMulter].sort())
    assert.equal(fs.existsSync(oldMulter), false)
    assert.equal(fs.existsSync(oldInline), false)
    assert.equal(fs.existsSync(importsOld), false)
    assert.equal(fs.existsSync(freshMulter), true)
    assert.equal(fs.existsSync(oldOther), true)
    assert.equal(fs.existsSync(oldHexWithExt), true)
    assert.equal(fs.existsSync(oldHexDir), true)
    assert.equal(fs.existsSync(importsTwoHours), true)
    assert.equal(fs.existsSync(path.join(dir, 'imports')), true)
  } finally {
    fs.removeSync(dir)
  }
})

test('sweeper tolerates a missing directory', () => {
  const removed = uploadSecurity.sweepUploadTempDirectory(
    path.join(os.tmpdir(), 'haxcms-upload-security-does-not-exist-' + Date.now()),
  )
  assert.deepEqual(removed, [])
})

test('startUploadTempSweeper sweeps immediately and returns a stop function', () => {
  const dir = makeTempDir()
  const now = Date.now()
  const oldMulter = path.join(dir, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
  writeAged(oldMulter, 2 * HOUR, now)
  try {
    const stop = uploadSecurity.startUploadTempSweeper(dir, { intervalMs: 60 * 1000 })
    assert.equal(typeof stop, 'function')
    stop()
    assert.equal(fs.existsSync(oldMulter), false)
  } finally {
    fs.removeSync(dir)
  }
})

test('collectUploadedTempPaths handles single, any() and fields() shapes', () => {
  assert.deepEqual(uploadSecurity.collectUploadedTempPaths(null), [])
  assert.deepEqual(
    uploadSecurity.collectUploadedTempPaths({ file: { path: '/t/a' } }),
    ['/t/a'],
  )
  assert.deepEqual(
    uploadSecurity.collectUploadedTempPaths({ files: [{ path: '/t/a' }, { path: '' }, {}] }),
    ['/t/a'],
  )
  assert.deepEqual(
    uploadSecurity.collectUploadedTempPaths({
      files: { upload: [{ path: '/t/a' }], other: [{ path: '/t/b' }] },
    }),
    ['/t/a', '/t/b'],
  )
})

test('cleanup middleware unlinks temp files on finish, ignores moved files and outside paths', () => {
  const dir = makeTempDir()
  const outside = makeTempDir()
  const tempA = path.join(dir, 'ffffffffffffffffffffffffffffffff')
  const tempMoved = path.join(dir, '11111111111111111111111111111111')
  const movedTarget = path.join(outside, 'moved.png')
  const outsideFile = path.join(outside, 'not-a-temp.txt')
  fs.outputFileSync(tempA, 'a')
  fs.outputFileSync(tempMoved, 'b')
  fs.outputFileSync(outsideFile, 'c')
  try {
    const middleware = uploadSecurity.createUploadTempCleanupMiddleware(dir)
    const req = {}
    const res = new EventEmitter()
    let nextCalls = 0
    middleware(req, res, function () {
      nextCalls++
    })
    // re-entry (two parsers on one request) must not double-register
    middleware(req, res, function () {
      nextCalls++
    })
    assert.equal(nextCalls, 2)
    assert.equal(res.listenerCount('finish'), 1)
    assert.equal(res.listenerCount('close'), 1)
    // simulate multer populating req.files, then a handler moving one away
    req.files = [{ path: tempA }, { path: tempMoved }, { path: outsideFile }]
    fs.moveSync(tempMoved, movedTarget)
    res.emit('finish')
    res.emit('close')
    assert.equal(fs.existsSync(tempA), false)
    assert.equal(fs.existsSync(movedTarget), true)
    assert.equal(fs.existsSync(outsideFile), true)
  } finally {
    fs.removeSync(dir)
    fs.removeSync(outside)
  }
})

test('cleanup middleware also runs on an aborted connection (close only)', () => {
  const dir = makeTempDir()
  const temp = path.join(dir, '22222222222222222222222222222222')
  fs.outputFileSync(temp, 'a')
  try {
    const middleware = uploadSecurity.createUploadTempCleanupMiddleware(dir)
    const req = {}
    const res = new EventEmitter()
    middleware(req, res, function () {})
    req.file = { path: temp }
    res.emit('close')
    assert.equal(fs.existsSync(temp), false)
  } finally {
    fs.removeSync(dir)
  }
})

test('conversion upload cap defaults to 50 MB and is configurable', () => {
  const MB = 1024 * 1024
  assert.equal(uploadSecurity.getConversionUploadMaxBytes(null, {}), 50 * MB)
  assert.equal(
    uploadSecurity.getConversionUploadMaxBytes({ security: { conversionMaxUploadMb: 10 } }, {}),
    10 * MB,
  )
  assert.equal(
    uploadSecurity.getConversionUploadMaxBytes(
      { security: { conversionMaxUploadMb: 10 } },
      { HAXCMS_CONVERSION_MAX_UPLOAD_MB: '5' },
    ),
    5 * MB,
  )
  // invalid values fall back to the default; huge values clamp to 1 GB
  assert.equal(
    uploadSecurity.getConversionUploadMaxBytes({ security: { conversionMaxUploadMb: 'nope' } }, {}),
    50 * MB,
  )
  assert.equal(
    uploadSecurity.getConversionUploadMaxBytes({ security: { conversionMaxUploadMb: -1 } }, {}),
    50 * MB,
  )
  assert.equal(
    uploadSecurity.getConversionUploadMaxBytes({ security: { conversionMaxUploadMb: 999999 } }, {}),
    1024 * MB,
  )
})

test('force-download decision is made on the decoded files/ path', () => {
  const yes = [
    '/_sites/s/files/x.html',
    '/_sites/s/files/x.htm',
    '/_sites/s/files/x.HTML',
    '/_sites/s/files/x%2ehtml',
    '/_sites/s/files/x%2EHTML?download=0',
    '/_sites/s/files/sub/x.xhtml',
    '/_sites/s/files/x.xml',
    '/_sites/s/files/x.svg',
    '/_sites/s/files/x.SvG',
    '/_sites/s/files%2fx.svg',
    '/files/x.html',
    '/_sites/s/files/x%252ehtml.svg',
  ]
  for (let i = 0; i < yes.length; i++) {
    assert.equal(uploadSecurity.shouldForceDownloadFilesRequest(yes[i]), true, yes[i])
  }
  const no = [
    '/_sites/s/files/x.png',
    '/_sites/s/files/x.html.png',
    '/_sites/s/files/x%252ehtml',
    '/_sites/s/pages/x.html',
    '/_sites/s/files',
    '/_sites/s/x.html',
    '/_sites/s/files/%E0%A4%A',
  ]
  for (let i = 0; i < no.length; i++) {
    assert.equal(uploadSecurity.shouldForceDownloadFilesRequest(no[i]), false, no[i])
  }
  assert.deepEqual(uploadSecurity.FORCE_DOWNLOAD_FILES_EXTENSIONS, ['html', 'htm', 'xhtml', 'xml', 'svg'])
})
