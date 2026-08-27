'use strict'

// Unit tests for scaleImageInPlace (src/siteRoutes/v1/files.js) — the
// in-place, format-preserving image resize introduced for issues#3001.
//
// Mirrors the PHP OperationsFileOperationTest characterization style: call
// the operation directly against a real temp image and assert on-disk
// behavior. scaleImageInPlace is exported off the files module solely for
// these tests (performFileOperation remains the only production caller).
//
// Covers: PNG/JPEG/WebP resize in place (same path, format preserved, pixels
// fit inside the preset, never upscaled), the no-upscale no-op for an
// already-small image, and SVG rejection with a 400.
//
// NOTE on readMeta: we read result metadata via a Buffer, NOT sharp(path).
// sharp/libvips caches operation results by file path, so after an in-place
// overwrite (same path, new bytes) sharp(filePath).metadata() can return the
// STALE pre-overwrite dimensions (observed for WebP). Reading the bytes fresh
// sidesteps the cache so assertions see what is actually on disk. Production
// code is unaffected — buildFileRecord uses fs.statSync + extension-based
// mime, never sharp().metadata().
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const sharp = require('sharp')

const { scaleImageInPlace } = require('../../src/siteRoutes/v1/files.js')

// xs preset from IMAGE_SCALE_PRESETS — a real downscale target.
const TARGET_WIDTH = 200
const TARGET_HEIGHT = 150

async function makeImage(dir, fileName, format, width, height) {
  const filePath = path.join(dir, fileName)
  let pipeline = sharp({
    create: { width: width, height: height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
  if (format === 'jpeg') {
    pipeline = pipeline.jpeg()
  } else if (format === 'png') {
    pipeline = pipeline.png()
  } else if (format === 'webp') {
    pipeline = pipeline.webp()
  } else {
    throw new Error('Unsupported fixture format: ' + format)
  }
  await pipeline.toFile(filePath)
  return filePath
}

// Read metadata from the file's bytes to bypass sharp's path-keyed cache.
async function readMeta(filePath) {
  return sharp(fs.readFileSync(filePath)).metadata()
}

function tempLeftovers(dir) {
  return fs.readdirSync(dir).filter(function (name) {
    return name.indexOf('-scale-') !== -1
  })
}

describe('scaleImageInPlace — in-place, format-preserving resize', () => {
  let tmpDir = null

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxfiles-imgops-'))
  })

  test.after(() => {
    if (tmpDir) {
      fs.removeSync(tmpDir)
    }
  })

  test('PNG in -> PNG out, resized in place at the same path', async () => {
    const src = await makeImage(tmpDir, 'photo.png', 'png', 800, 600)
    const before = await readMeta(src)
    assert.equal(before.format, 'png')

    await scaleImageInPlace(src, TARGET_WIDTH, TARGET_HEIGHT, 90)

    // Still exists at the SAME path (no derivative).
    assert.equal(fs.pathExistsSync(src), true, 'original path still exists')
    // No stray temp file left behind in the directory.
    assert.deepEqual(tempLeftovers(tmpDir), [], 'no -scale- temp leftover')

    const after = await readMeta(src)
    assert.equal(after.format, 'png', 'format preserved as png')
    assert.ok(after.width <= TARGET_WIDTH, 'width fits inside preset')
    assert.ok(after.height <= TARGET_HEIGHT, 'height fits inside preset')
    assert.ok(after.width < before.width || after.height < before.height, 'pixels actually shrank')
  })

  test('JPEG in -> JPEG out, resized in place at the same path', async () => {
    const src = await makeImage(tmpDir, 'photo.jpg', 'jpeg', 800, 600)
    const before = await readMeta(src)
    assert.equal(before.format, 'jpeg')

    await scaleImageInPlace(src, TARGET_WIDTH, TARGET_HEIGHT, 90)

    assert.equal(fs.pathExistsSync(src), true, 'original path still exists')
    assert.deepEqual(tempLeftovers(tmpDir), [], 'no -scale- temp leftover')

    const after = await readMeta(src)
    assert.equal(after.format, 'jpeg', 'format preserved as jpeg (not forced to png)')
    assert.ok(after.width <= TARGET_WIDTH && after.height <= TARGET_HEIGHT, 'fits inside preset')
  })

  test('WebP in -> WebP out, resized in place at the same path', async () => {
    const src = await makeImage(tmpDir, 'photo.webp', 'webp', 800, 600)
    const before = await readMeta(src)
    assert.equal(before.format, 'webp')

    await scaleImageInPlace(src, TARGET_WIDTH, TARGET_HEIGHT, 90)

    assert.equal(fs.pathExistsSync(src), true, 'original path still exists')
    assert.deepEqual(tempLeftovers(tmpDir), [], 'no -scale- temp leftover')

    const after = await readMeta(src)
    assert.equal(after.format, 'webp', 'format preserved as webp')
    assert.ok(after.width <= TARGET_WIDTH && after.height <= TARGET_HEIGHT, 'fits inside preset')
  })

  test('already-small image is a no-op (never upscaled)', async () => {
    // 20x15 is smaller than every preset, so withoutEnlargement keeps it as-is.
    const src = await makeImage(tmpDir, 'tiny.png', 'png', 20, 15)
    const before = await readMeta(src)

    await scaleImageInPlace(src, TARGET_WIDTH, TARGET_HEIGHT, 90)

    const after = await readMeta(src)
    assert.equal(after.format, 'png', 'format preserved')
    assert.equal(after.width, before.width, 'width unchanged (no upscale)')
    assert.equal(after.height, before.height, 'height unchanged (no upscale)')
    assert.deepEqual(tempLeftovers(tmpDir), [], 'no -scale- temp leftover')
  })

  test('SVG is rejected with a 400 and leaves no temp file', async () => {
    const svgPath = path.join(tmpDir, 'icon.svg')
    fs.writeFileSync(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    )

    await assert.rejects(
      function () {
        return scaleImageInPlace(svgPath, TARGET_WIDTH, TARGET_HEIGHT, 90)
      },
      function (err) {
        return err && err.status === 400
      },
      'SVG resize should be rejected with status 400',
    )

    // The original SVG is untouched and no temp was created.
    assert.equal(fs.pathExistsSync(svgPath), true, 'svg left untouched')
    assert.deepEqual(tempLeftovers(tmpDir), [], 'no -scale- temp leftover on rejection')
  })
})
