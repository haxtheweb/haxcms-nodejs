'use strict'

// Security (review 2026-10): multer temp-file cleanup + stale sweeper.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('node:events')

const {
  getUploadTempDirectory,
  collectRequestUploadPaths,
  registerUploadTempCleanup,
  sweepStaleUploadTempFiles,
  createStaleUploadSweeper,
} = require('../../src/lib/uploadTempLifecycle.js')

const HOUR = 60 * 60 * 1000
const MULTER_NAME_A = 'a'.repeat(32)
const MULTER_NAME_B = '0123456789abcdef0123456789abcdef'

function makeConfigDir() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-upload-temp-'))
  fs.ensureDirSync(getUploadTempDirectory(configDir))
  fs.ensureDirSync(path.join(configDir, 'tmp', 'imports'))
  return configDir
}

function writeAged(filePath, ageMs, now) {
  fs.writeFileSync(filePath, 'x')
  const when = new Date(now - ageMs)
  fs.utimesSync(filePath, when, when)
}

test('upload temp dir is a dedicated subdirectory of <config>/tmp', () => {
  assert.equal(getUploadTempDirectory('/cfg'), path.join('/cfg', 'tmp', 'uploads'))
})

test('collectRequestUploadPaths handles any(), single() and fields() shapes', () => {
  assert.deepEqual(collectRequestUploadPaths({ files: [{ path: '/a' }, { path: '/b' }, {}] }), ['/a', '/b'])
  assert.deepEqual(collectRequestUploadPaths({ file: { path: '/c' } }), ['/c'])
  assert.deepEqual(collectRequestUploadPaths({ files: { x: [{ path: '/d' }], y: [{ path: '/e' }] } }), ['/d', '/e'])
  assert.deepEqual(collectRequestUploadPaths({}), [])
})

test('response finish removes the request temp files but not files outside the upload dir', () => {
  const configDir = makeConfigDir()
  const uploadDir = getUploadTempDirectory(configDir)
  const tempFile = path.join(uploadDir, MULTER_NAME_A)
  const outside = path.join(configDir, 'tmp', 'imports', 'staged.png')
  fs.writeFileSync(tempFile, 'temp')
  fs.writeFileSync(outside, 'keep')
  const req = {}
  const res = new EventEmitter()
  registerUploadTempCleanup(req, res, uploadDir)
  registerUploadTempCleanup(req, res, uploadDir) // idempotent
  assert.equal(res.listenerCount('finish'), 1)
  // multer populates req.files after the cleanup hook is registered
  req.files = [{ path: tempFile }, { path: outside }, { path: path.join(uploadDir, MULTER_NAME_B) }]
  res.emit('finish')
  res.emit('close')
  assert.equal(fs.existsSync(tempFile), false)
  assert.equal(fs.existsSync(outside), true, 'paths outside the upload dir are never unlinked')
  fs.removeSync(configDir)
})

test('sweeper deletes only stale multer-named files in its own directories', () => {
  const configDir = makeConfigDir()
  const now = Date.now()
  const uploadDir = getUploadTempDirectory(configDir)
  const tmpRoot = path.join(configDir, 'tmp')
  const staleUpload = path.join(uploadDir, MULTER_NAME_A)
  const freshUpload = path.join(uploadDir, MULTER_NAME_B)
  const staleLegacy = path.join(tmpRoot, MULTER_NAME_B)
  const staleOtherName = path.join(uploadDir, 'not-multer.txt')
  const staleImport = path.join(tmpRoot, 'imports', MULTER_NAME_A)
  const staleOtherTmp = path.join(tmpRoot, 'some-cache.json')
  writeAged(staleUpload, 2 * HOUR, now)
  writeAged(freshUpload, 5 * 60 * 1000, now)
  writeAged(staleLegacy, 2 * HOUR, now)
  writeAged(staleOtherName, 2 * HOUR, now)
  writeAged(staleImport, 2 * HOUR, now)
  writeAged(staleOtherTmp, 2 * HOUR, now)

  const sweep = createStaleUploadSweeper(configDir)
  const removed = sweep(now).sort()
  assert.deepEqual(removed, [staleLegacy, staleUpload].sort())
  assert.equal(fs.existsSync(freshUpload), true, 'files younger than 1h are kept')
  assert.equal(fs.existsSync(staleOtherName), true, 'non-multer names are kept')
  assert.equal(fs.existsSync(staleImport), true, 'tmp/imports (bulk-import staging) is never swept')
  assert.equal(fs.existsSync(staleOtherTmp), true, 'other tmp files are kept')
  assert.equal(fs.existsSync(path.join(tmpRoot, 'imports')), true)

  // throttled: a second call inside the interval does nothing
  writeAged(staleUpload, 2 * HOUR, now)
  assert.deepEqual(sweep(now + 1000), [])
  assert.equal(fs.existsSync(staleUpload), true)
  assert.deepEqual(sweep(now + 11 * 60 * 1000), [staleUpload])
  fs.removeSync(configDir)
})

test('sweeper ignores directories and symlinks and tolerates a missing dir', () => {
  const configDir = makeConfigDir()
  const now = Date.now()
  const uploadDir = getUploadTempDirectory(configDir)
  fs.ensureDirSync(path.join(uploadDir, MULTER_NAME_A))
  const target = path.join(configDir, 'precious')
  fs.writeFileSync(target, 'precious')
  fs.symlinkSync(target, path.join(uploadDir, MULTER_NAME_B))
  assert.deepEqual(sweepStaleUploadTempFiles(uploadDir, { maxAgeMs: 0, now: now + HOUR }), [])
  assert.equal(fs.existsSync(target), true)
  assert.deepEqual(sweepStaleUploadTempFiles(path.join(configDir, 'missing'), { now }), [])
  fs.removeSync(configDir)
})
