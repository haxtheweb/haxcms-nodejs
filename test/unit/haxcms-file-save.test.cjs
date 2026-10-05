'use strict'

// Unit tests for the HAXCMSFile surface in src/lib/HAXCMSFile.js: the save()
// branch matrix (bulk import, remote download + SSRF guard, size caps, image
// operations, datastore upsert), the magic-byte MIME detector branches, and
// the SSRF IPv4/IPv6 predicates.
//
// The HAXCMS singleton is constructed when HAXCMSFile.js is first required and
// reads/writes the on-disk config directory at load time. A temp runtime with a
// seeded _config (marked with .isHAXcmsConfig) is created and cwd moved into
// it BEFORE the first require so config discovery stays inside the temp tree.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const sharp = require('sharp')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-file-save-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')

function seedRuntimeConfig() {
  fs.ensureDirSync(configRoot)
  fs.writeFileSync(path.join(configRoot, '.isHAXcmsConfig'), '')
  const seedFiles = [
    'config.json',
    'my-custom-elements.js',
    'userData.json',
    'config.php',
    '.htaccess',
    '.user-files-htaccess',
  ]
  for (let i = 0; i < seedFiles.length; i++) {
    fs.copySync(
      path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
      path.join(configRoot, seedFiles[i]),
    )
  }
  fs.ensureDirSync(path.join(configRoot, 'tmp'))
  fs.ensureDirSync(path.join(configRoot, 'cache'))
  fs.ensureDirSync(path.join(configRoot, 'user'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'settings'))
  fs.ensureDirSync(path.join(configRoot, 'node_modules'))
}

fs.ensureDirSync(runtimeRoot)
seedRuntimeConfig()
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: 'unit-file-user', password: 'unit-file-pass' }, null, 2),
)

process.chdir(runtimeRoot)
process.env.HAXCMS_ROOT = runtimeRoot + '/'
const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')

const siteDir = path.join(tempRoot, 'file-site')
const site = {
  siteDirectory: siteDir,
  basePath: '/_sites/file-site/',
  manifest: { metadata: { site: { name: 'file-site' } } },
}

const uploadDir = path.join(tempRoot, 'uploads')
fs.ensureDirSync(uploadDir)
fs.ensureDirSync(siteDir)

async function makePng(name) {
  const filePath = path.join(uploadDir, name)
  await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#00ff00' },
  })
    .png()
    .toFile(filePath)
  return filePath
}

async function makeJpeg(name) {
  const filePath = path.join(uploadDir, name)
  await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#0000ff' },
  })
    .jpeg()
    .toFile(filePath)
  return filePath
}

function writeSample(name, buffer) {
  const filePath = path.join(uploadDir, name)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

test.after(() => {
  process.chdir(originalCwd)
  delete process.env.HAXCMS_ROOT
  fs.removeSync(tempRoot)
})

// ---------------------------------------------------------------------------
// magic-byte MIME detection branches
// ---------------------------------------------------------------------------
test('detectMimeTypeFromContent identifies container and document formats', () => {
  const samples = {
    webp: Buffer.from('RIFF0000WEBPVP8 ', 'latin1'),
    webm: Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from(' webm payload', 'latin1'),
    ]),
    quicktime: Buffer.concat([
      Buffer.from('0000', 'latin1'),
      Buffer.from('ftyp'),
      Buffer.from('qt  '),
    ]),
    mp4: Buffer.concat([
      Buffer.from('0000', 'latin1'),
      Buffer.from('ftyp'),
      Buffer.from('isom'),
    ]),
    mp3Sync: Buffer.from([0xff, 0xe0, 0x10, 0x00, 0x00, 0x00]),
    mp3Id3: Buffer.concat([Buffer.from('ID3'), Buffer.from(' tag data', 'latin1')]),
    pdf: Buffer.from('%PDF-1.4 body', 'latin1'),
    zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
    ole: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
    rtf: Buffer.from('{\\rtf1 document}', 'latin1'),
    xml: Buffer.from('<?xml version="1.0"?>', 'latin1'),
    htmlDoctype: Buffer.from('<!doctype html><html>', 'latin1'),
    htmlTag: Buffer.from('<html lang="en"><body>x</body></html>', 'latin1'),
    bodyTag: Buffer.from('junk<body>body only</body>', 'latin1'),
    plain: Buffer.from('just plain text for the detector', 'latin1'),
    binary: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    lowPrintable: Buffer.from(
      [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d],
    ),
  }
  const expected = {
    webp: 'image/webp',
    webm: 'video/webm',
    quicktime: 'video/quicktime',
    mp4: 'video/mp4',
    mp3Sync: 'audio/mpeg',
    mp3Id3: 'audio/mpeg',
    pdf: 'application/pdf',
    zip: 'application/zip',
    ole: 'application/x-ole-storage',
    rtf: 'application/rtf',
    xml: 'application/xml',
    htmlDoctype: 'text/html',
    htmlTag: 'text/html',
    bodyTag: 'text/html',
    plain: 'text/plain',
    binary: 'application/octet-stream',
    lowPrintable: 'application/octet-stream',
  }
  const names = Object.keys(samples)
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    const filePath = writeSample('detect-' + name, samples[name])
    assert.equal(HAXCMSFile.detectMimeTypeFromContent(filePath), expected[name], name)
  }
  // missing file degrades to an empty sample -> octet stream
  assert.equal(
    HAXCMSFile.detectMimeTypeFromContent(path.join(uploadDir, 'no-such-sample')),
    'application/octet-stream',
  )
})

// ---------------------------------------------------------------------------
// SSRF predicates
// ---------------------------------------------------------------------------
test('isPrivateOrReservedIP covers the private, reserved, and CGNAT ranges', () => {
  const reserved = [
    null,
    '',
    '0.0.0.0',
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '100.64.0.1',
    '100.127.255.255',
  ]
  for (let i = 0; i < reserved.length; i++) {
    assert.equal(HAXCMSFile.isPrivateOrReservedIP(reserved[i]), true, reserved[i])
  }
  const publicIps = [
    '172.32.0.1',
    '172.15.255.255',
    '100.63.0.1',
    '100.128.0.1',
    '8.8.8.8',
    '1.1.1.1',
  ]
  for (let i = 0; i < publicIps.length; i++) {
    assert.equal(HAXCMSFile.isPrivateOrReservedIP(publicIps[i]), false, publicIps[i])
  }
})

test('isPrivateOrReservedIP normalizes IPv6 mapped, compat, and local forms', () => {
  const reservedV6 = [
    '::',
    '::1',
    '::0001',
    '0:0:0:0:0:0:0:1',
    '::0.0.0.1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    '::7f00:1',
  ]
  for (let i = 0; i < reservedV6.length; i++) {
    assert.equal(HAXCMSFile.isPrivateOrReservedIP(reservedV6[i]), true, reservedV6[i])
  }
  assert.equal(HAXCMSFile.isPrivateOrReservedIP('2001:db8::1'), false)
  assert.equal(HAXCMSFile.isPrivateOrReservedIP('2001:db8::1.2.3.4'), false)
})

test('isPrivateOrReservedIP rejects malformed IPv6 shapes safely', () => {
  const malformed = [
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1:2:::3',
    '12345::',
    'gggg::1',
    ':1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:1.2.3.4',
    '1:2:3:4:5:6:1.2.3.4.5',
    '1:2:3:4:5:6:1.2.3.256',
    '1:2:3:4:5:6:1.2.3',
  ]
  for (let i = 0; i < malformed.length; i++) {
    const value = malformed[i]
    // every malformed shape must answer (never throw) and treat v6 miss as v4
    const answer = HAXCMSFile.isPrivateOrReservedIP(value)
    assert.equal(typeof answer, 'boolean', value)
  }
  // multiple '::' is rejected by the packer -> falls to v4 treatment
  assert.equal(HAXCMSFile.isPrivateOrReservedIP('::ffff::1'), false)
})

test('validateUrlNotSSRF resolves protocols, hostnames, and IP literals locally', async () => {
  assert.equal(await HAXCMSFile.validateUrlNotSSRF('not a url at all'), false)
  assert.equal(await HAXCMSFile.validateUrlNotSSRF('ftp://example.com/file'), false)
  assert.equal(await HAXCMSFile.validateUrlNotSSRF('http:///no-host'), false)
  assert.equal(await HAXCMSFile.validateUrlNotSSRF('http://127.0.0.1/x'), false)
  assert.equal(await HAXCMSFile.validateUrlNotSSRF('http://10.0.0.1/x'), false)
  // an IP literal resolves locally through dns.lookup without a network fetch
  assert.equal(await HAXCMSFile.validateUrlNotSSRF('http://8.8.8.8/x'), true)
  // a reserved .invalid hostname fails resolution without real DNS traffic
  assert.equal(
    await HAXCMSFile.validateUrlNotSSRF('http://definitely-not-real.invalid/x'),
    false,
  )
})

// ---------------------------------------------------------------------------
// HAXCMSFile.save() branch matrix
// ---------------------------------------------------------------------------
test('save answers undefined without an upload path', async () => {
  const result = await new HAXCMSFile().save({}, site, null, null, '')
  assert.equal(result, undefined)
})

test('save rejects disallowed extensions and strips executable parts', async () => {
  const file = writeSample('disallowed.zzz', Buffer.from('nope'))
  const rejected = await new HAXCMSFile().save(
    { path: file, originalname: 'disallowed.zzz' },
    site,
  )
  assert.equal(rejected.status, 500)
  assert.equal(rejected.data.message, 'File type not allowed')
  // a real jpeg keeps the detected mime aligned with the .jpg extension
  const phpFile = await makeJpeg('shell.php.jpg')
  const cleaned = await new HAXCMSFile().save(
    { path: phpFile, originalname: 'shell.php.jpg' },
    site,
  )
  assert.equal(cleaned.status, 200)
  assert.equal(cleaned.data.file.name, 'shell.jpg')
  assert.equal(cleaned.data.file.type, 'image/jpeg')
})

async function makePngBytes() {
  return await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer()
}

test('save enforces the configured max upload size', async () => {
  const mediaSettingsPath = path.join(configRoot, 'settings', 'media.json')
  fs.ensureDirSync(path.join(configRoot, 'settings'))
  // the normalizer clamps maxUploadSizeMb up to a 1MB floor, so a 2MB size
  // exceeds the configured (clamped) cap
  fs.writeJsonSync(mediaSettingsPath, { maxUploadSizeMb: 1 })
  try {
    const file = await makePng('oversize.png')
    const rejected = await new HAXCMSFile().save(
      { path: file, originalname: 'oversize.png', size: 2 * 1024 * 1024 },
      site,
    )
    assert.equal(rejected.status, 500)
    assert.ok(rejected.data.message.indexOf('maximum upload size') !== -1)
  }
  finally {
    fs.removeSync(mediaSettingsPath)
  }
})

test('save rejects a detected mime that does not match the extension', async () => {
  const pngFile = await makePng('mime-mismatch.jpg')
  const rejected = await new HAXCMSFile().save(
    { path: pngFile, originalname: 'mime-mismatch.jpg' },
    site,
  )
  assert.equal(rejected.status, 500)
  assert.ok(rejected.data.message.indexOf('Detected MIME type image/png') === 0)
  // PNG magic bytes with a broken body: detected as image/png but sharp fails
  const garbage = writeSample(
    'garbage-image.png',
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('broken body'),
    ]),
  )
  const invalidImage = await new HAXCMSFile().save(
    { path: garbage, originalname: 'garbage-image.png' },
    site,
  )
  assert.equal(invalidImage.status, 500)
  assert.equal(invalidImage.data.message, 'Invalid image file content')
  const missing = await new HAXCMSFile().save(
    { path: path.join(uploadDir, 'no-such-upload.png'), originalname: 'no-such.png' },
    site,
  )
  assert.equal(missing.status, 500)
  assert.equal(missing.data.message, 'Uploaded file is missing')
})

test('save stores a valid png with a uuid, dimensions, and a datastore record', async () => {
  const file = await makePng('valid-upload.png')
  const result = await new HAXCMSFile().save(
    { path: file, originalname: 'valid-upload.png' },
    site,
  )
  assert.equal(result.status, 200)
  assert.equal(result.data.file.name, 'valid-upload.png')
  assert.equal(result.data.file.type, 'image/png')
  assert.ok(result.data.file.uuid)
  assert.equal(result.data.file.width, 32)
  assert.equal(result.data.file.height, 32)
  assert.ok(result.data.file.fullUrl.indexOf('valid-upload.png') !== -1)
  assert.ok(fs.statSync(path.join(siteDir, 'files', 'valid-upload.png')).isFile())
  // the datastore envelope lives at <site>/files/files.json
  const filesJson = fs.readFileSync(
    path.join(siteDir, 'files', 'files.json'),
    'utf8',
  )
  assert.ok(filesJson.indexOf('valid-upload.png') !== -1)
  assert.ok(filesJson.indexOf(result.data.file.uuid) !== -1)
})

test('save stores a jpeg, applies configured quality, and renames collisions', async () => {
  const mediaSettingsPath = path.join(configRoot, 'settings', 'media.json')
  fs.ensureDirSync(path.join(configRoot, 'settings'))
  fs.writeJsonSync(mediaSettingsPath, { jpegQuality: 50 })
  try {
    const first = await makeJpeg('quality-upload.jpg')
    const result = await new HAXCMSFile().save(
      { path: first, originalname: 'quality-upload.jpg' },
      site,
    )
    assert.equal(result.status, 200)
    assert.equal(result.data.file.type, 'image/jpeg')
    assert.equal(result.data.file.width, 32)
    // a second upload with the same name collides onto a _1 suffix
    const second = await makeJpeg('quality-upload.jpg')
    const collision = await new HAXCMSFile().save(
      { path: second, originalname: 'quality-upload.jpg' },
      site,
    )
    assert.equal(collision.status, 200)
    assert.equal(collision.data.file.name, 'quality-upload_1.jpg')
    // a NaN quality setting leaves the jpeg untouched (quality apply skipped)
    fs.writeJsonSync(mediaSettingsPath, { jpegQuality: 'not-a-number' })
    const third = await makeJpeg('quality-upload.jpg')
    const untouched = await new HAXCMSFile().save(
      { path: third, originalname: 'quality-upload.jpg' },
      site,
    )
    assert.equal(untouched.status, 200)
  }
  finally {
    fs.removeSync(mediaSettingsPath)
  }
})

test('save stores non-image documents without pixel dimensions', async () => {
  const file = writeSample('notes.txt', Buffer.from('plain text notes', 'utf8'))
  const result = await new HAXCMSFile().save(
    { path: file, originalname: 'notes.txt' },
    site,
  )
  assert.equal(result.status, 200)
  assert.equal(result.data.file.type, 'text/plain')
  assert.equal(result.data.file.name, 'notes.txt')
  assert.equal(result.data.file.width, 0)
  assert.equal(result.data.file.height, 0)
})

test('save rejects on the thumbnail operation in place', async () => {
  const file = await makePng('thumbnail-op.png')
  // the imageOps resize runs after the move with the destination as BOTH the
  // sharp input and output, and the sharp rejection is not caught in save()
  await assert.rejects(
    () =>
      new HAXCMSFile().save(
        { path: file, originalname: 'thumbnail-op.png' },
        site,
        null,
        'thumbnail',
      ),
    function (err) {
      return err && err.message.indexOf('Cannot use same file') !== -1
    },
  )
  // the move itself completed before the resize rejected
  assert.ok(fs.statSync(path.join(siteDir, 'files', 'thumbnail-op.png')).isFile())
})

test('save supports the tmpFile name fallback and nested subfolders', async () => {
  const file = await makePng('name-fallback.png')
  const result = await new HAXCMSFile().save(
    { path: file, name: 'name-fallback.png' },
    site,
    null,
    null,
    'decks/unit-deck',
  )
  assert.equal(result.status, 200)
  assert.equal(result.data.file.path, 'files/decks/unit-deck/name-fallback.png')
  assert.ok(
    fs.statSync(path.join(siteDir, 'files', 'decks', 'unit-deck', 'name-fallback.png')).isFile(),
  )
})

test('save preserves the bulk import directory tree from staged files', async () => {
  const stagingRoot = path.join(configRoot, 'tmp', 'imports', 'assets', 'nested')
  fs.ensureDirSync(stagingRoot)
  const staged = path.join(stagingRoot, 'staged.png')
  fs.copySync(await makePng('staged-src.png'), staged)
  const result = await new HAXCMSFile().save(
    { path: staged, originalname: 'assets/nested/staged.png', 'bulk-import': true },
    site,
  )
  assert.equal(result.status, 200)
  assert.equal(result.data.file.path, 'files/assets/nested/staged.png')
  assert.ok(
    fs.statSync(path.join(siteDir, 'files', 'assets', 'nested', 'staged.png')).isFile(),
  )
})

test('save rejects hostile bulk import source paths and names', async () => {
  const outside = await makePng('outside-staged.png')
  const invalidSource = await new HAXCMSFile().save(
    { path: outside, originalname: 'outside.png', 'bulk-import': true },
    site,
  )
  assert.equal(invalidSource.status, 500)
  assert.equal(invalidSource.data.message, 'Invalid bulk import source')
  const stagingRoot = path.join(configRoot, 'tmp', 'imports')
  fs.ensureDirSync(stagingRoot)
  const stagedTraversal = path.join(stagingRoot, 'staged-traversal.png')
  fs.copySync(await makePng('staged-traversal-src.png'), stagedTraversal)
  const traversal = await new HAXCMSFile().save(
    { path: stagedTraversal, originalname: 'files/../../evil.png', 'bulk-import': true },
    site,
  )
  assert.equal(traversal.status, 500)
  assert.equal(traversal.data.message, 'Invalid bulk import path')
  const stagedAbsolute = path.join(stagingRoot, 'staged-absolute.png')
  fs.copySync(await makePng('staged-absolute-src.png'), stagedAbsolute)
  const absolute = await new HAXCMSFile().save(
    { path: stagedAbsolute, originalname: '/abs/evil.png', 'bulk-import': true },
    site,
  )
  assert.equal(absolute.status, 500)
  assert.equal(absolute.data.message, 'Invalid bulk import path')
})

test('save rejects remote downloads that target private or unresolvable hosts', async () => {
  const loopback = await new HAXCMSFile().save(
    { path: 'https://127.0.0.1/remote.png', originalname: 'remote.png' },
    site,
  )
  assert.equal(loopback.status, 500)
  assert.equal(loopback.data.message, 'URL target is not allowed')
  const unresolvable = await new HAXCMSFile().save(
    {
      path: 'https://definitely-not-real.invalid/remote.png',
      originalname: 'remote.png',
    },
    site,
  )
  assert.equal(unresolvable.status, 500)
  assert.equal(unresolvable.data.message, 'URL target is not allowed')
})
