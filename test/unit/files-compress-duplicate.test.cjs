'use strict'

// Unit tests for compressImageInPlace and getDuplicateFileInfo
// (src/siteRoutes/v1/files.js) — added alongside the compress/duplicate file
// operations for haxtheweb/issues#3034.
//
// Mirrors the style of test/unit/files-image-ops.test.cjs: call the
// operations directly against real temp files/paths and assert on-disk
// behavior. Both functions are exported off the files module solely for
// these tests (performFileOperation remains the sole production caller).
//
// NOTE on readMeta: read result metadata via a Buffer, NOT sharp(path), since
// sharp/libvips caches operation results by file path and an in-place
// overwrite (same path, new bytes) can otherwise report stale dimensions.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const sharp = require('sharp')

const {
  compressImageInPlace,
  getDuplicateFileInfo,
} = require('../../src/siteRoutes/v1/files.js')

async function makeImage(dir, fileName, format, width, height) {
  const filePath = path.join(dir, fileName)
  let pipeline = sharp({
    create: { width: width, height: height, channels: 3, background: { r: 0, g: 128, b: 255 } },
  })
  if (format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: 95 })
  } else if (format === 'png') {
    pipeline = pipeline.png()
  } else if (format === 'webp') {
    pipeline = pipeline.webp({ quality: 95 })
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

function tempLeftovers(dir, label) {
  return fs.readdirSync(dir).filter(function (name) {
    return name.indexOf('-' + label + '-') !== -1
  })
}

describe('compressImageInPlace — in-place, format-preserving re-encode', () => {
  let tmpDir = null

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxfiles-compress-'))
  })

  test.after(() => {
    if (tmpDir) {
      fs.removeSync(tmpDir)
    }
  })

  test('PNG in -> PNG out, same path, same dimensions', async () => {
    const src = await makeImage(tmpDir, 'photo.png', 'png', 400, 300)
    const before = await readMeta(src)
    assert.equal(before.format, 'png')

    await compressImageInPlace(src, 30)

    assert.equal(fs.pathExistsSync(src), true, 'original path still exists')
    assert.deepEqual(tempLeftovers(tmpDir, 'compress'), [], 'no -compress- temp leftover')

    const after = await readMeta(src)
    assert.equal(after.format, 'png', 'format preserved as png')
    assert.equal(after.width, before.width, 'width unchanged (no resize)')
    assert.equal(after.height, before.height, 'height unchanged (no resize)')
  })

  test('JPEG in -> JPEG out, same path, lower quality shrinks file size', async () => {
    const src = await makeImage(tmpDir, 'photo.jpg', 'jpeg', 400, 300)
    const before = await readMeta(src)
    const beforeSize = fs.statSync(src).size
    assert.equal(before.format, 'jpeg')

    await compressImageInPlace(src, 10)

    assert.equal(fs.pathExistsSync(src), true, 'original path still exists')
    assert.deepEqual(tempLeftovers(tmpDir, 'compress'), [], 'no -compress- temp leftover')

    const after = await readMeta(src)
    const afterSize = fs.statSync(src).size
    assert.equal(after.format, 'jpeg', 'format preserved as jpeg')
    assert.equal(after.width, before.width, 'width unchanged (no resize)')
    assert.equal(after.height, before.height, 'height unchanged (no resize)')
    assert.ok(afterSize < beforeSize, 'lower quality compression reduces file size')
  })

  test('WebP in -> WebP out, same path, same dimensions', async () => {
    const src = await makeImage(tmpDir, 'photo.webp', 'webp', 400, 300)
    const before = await readMeta(src)
    assert.equal(before.format, 'webp')

    await compressImageInPlace(src, 50)

    assert.equal(fs.pathExistsSync(src), true, 'original path still exists')
    assert.deepEqual(tempLeftovers(tmpDir, 'compress'), [], 'no -compress- temp leftover')

    const after = await readMeta(src)
    assert.equal(after.format, 'webp', 'format preserved as webp')
    assert.equal(after.width, before.width, 'width unchanged (no resize)')
    assert.equal(after.height, before.height, 'height unchanged (no resize)')
  })

  test('SVG is rejected with a 400 and leaves no temp file', async () => {
    const svgPath = path.join(tmpDir, 'icon.svg')
    fs.writeFileSync(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    )

    await assert.rejects(
      function () {
        return compressImageInPlace(svgPath, 70)
      },
      function (err) {
        return err && err.status === 400
      },
      'SVG compression should be rejected with status 400',
    )

    assert.equal(fs.pathExistsSync(svgPath), true, 'svg left untouched')
    assert.deepEqual(tempLeftovers(tmpDir, 'compress'), [], 'no -compress- temp leftover on rejection')
  })

  test('unreadable path is rejected with a 400', async () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.png')

    await assert.rejects(
      function () {
        return compressImageInPlace(missingPath, 70)
      },
      function (err) {
        return err && err.status === 400
      },
      'missing source file should be rejected with status 400',
    )
  })
})

describe('getDuplicateFileInfo — collision-safe "-copy" naming', () => {
  let tmpDir = null
  let filesRootPath = null

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxfiles-duplicate-'))
    filesRootPath = path.join(tmpDir, 'files')
    fs.ensureDirSync(filesRootPath)
  })

  test.after(() => {
    if (tmpDir) {
      fs.removeSync(tmpDir)
    }
  })

  function fileInfoFor(fileName) {
    return {
      normalizedPath: 'files/' + fileName,
      resolvedPath: path.join(filesRootPath, fileName),
      filesRootPath: filesRootPath,
    }
  }

  test('first duplicate uses the "-copy" suffix', () => {
    const fileName = 'report.pdf'
    fs.writeFileSync(path.join(filesRootPath, fileName), 'contents')

    const result = getDuplicateFileInfo(fileInfoFor(fileName))

    assert.equal(result.normalizedOutputPath, 'files/report-copy.pdf')
    assert.equal(path.basename(result.outputPath), 'report-copy.pdf')
  })

  test('subsequent duplicates increment to "-copy-2", "-copy-3", ...', () => {
    const fileName = 'image.png'
    fs.writeFileSync(path.join(filesRootPath, fileName), 'contents')
    // Pre-create the -copy and -copy-2 collisions so the generator must skip
    // both and land on -copy-3.
    fs.writeFileSync(path.join(filesRootPath, 'image-copy.png'), 'contents')
    fs.writeFileSync(path.join(filesRootPath, 'image-copy-2.png'), 'contents')

    const result = getDuplicateFileInfo(fileInfoFor(fileName))

    assert.equal(result.normalizedOutputPath, 'files/image-copy-3.png')
    assert.equal(path.basename(result.outputPath), 'image-copy-3.png')
  })

  test('preserves extension and base name for multi-dot file names', () => {
    const fileName = 'archive.tar.gz'
    fs.writeFileSync(path.join(filesRootPath, fileName), 'contents')

    const result = getDuplicateFileInfo(fileInfoFor(fileName))

    // path.extname('archive.tar.gz') === '.gz', so only the final extension
    // is treated as the extension (matches production path.extname usage).
    assert.equal(result.normalizedOutputPath, 'files/archive.tar-copy.gz')
  })

  test('does not mutate the source file', () => {
    const fileName = 'notes.txt'
    const sourcePath = path.join(filesRootPath, fileName)
    fs.writeFileSync(sourcePath, 'original contents')

    getDuplicateFileInfo(fileInfoFor(fileName))

    assert.equal(fs.pathExistsSync(sourcePath), true, 'source file untouched')
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'original contents')
  })
})
