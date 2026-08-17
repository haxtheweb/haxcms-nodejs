'use strict'

// Unit tests for the pure/file-system helper functions exported off of
// HAXCMSFile (src/lib/HAXCMSFile.js). These are attached via
// `HAXCMSFile.helperName = helperName` assignments near the bottom of the
// source file, alongside `module.exports = HAXCMSFile`.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const { HAXCMS } = require('../../src/lib/HAXCMS.js')

// ---------------------------------------------------------------------------
// stripExecutableExtensionPatterns
// ---------------------------------------------------------------------------
describe('HAXCMSFile.stripExecutableExtensionPatterns', () => {
  test('strips an executable extension embedded mid-filename', () => {
    assert.equal(
      HAXCMSFile.stripExecutableExtensionPatterns('shell.php.jpg'),
      'shell.jpg',
    )
  })

  test('strips multiple embedded executable extensions', () => {
    assert.equal(
      HAXCMSFile.stripExecutableExtensionPatterns('shell.php.php3.jpg'),
      'shell.jpg',
    )
  })

  test('strips a trailing executable extension entirely', () => {
    assert.equal(HAXCMSFile.stripExecutableExtensionPatterns('file.sh'), 'file')
    assert.equal(HAXCMSFile.stripExecutableExtensionPatterns('app.exe'), 'app')
  })

  test('leaves a normal double extension alone', () => {
    assert.equal(
      HAXCMSFile.stripExecutableExtensionPatterns('archive.tar.gz'),
      'archive.tar.gz',
    )
    assert.equal(
      HAXCMSFile.stripExecutableExtensionPatterns('photo.jpg'),
      'photo.jpg',
    )
  })

  test('preserves a directory portion of the path', () => {
    assert.equal(
      HAXCMSFile.stripExecutableExtensionPatterns('foo/bar/shell.php.jpg'),
      path.join('foo/bar', 'shell.jpg'),
    )
  })

  test('handles a filename with no extension', () => {
    assert.equal(HAXCMSFile.stripExecutableExtensionPatterns('README'), 'README')
  })

  test('handles empty and non-string input', () => {
    assert.equal(HAXCMSFile.stripExecutableExtensionPatterns(''), '')
    assert.equal(HAXCMSFile.stripExecutableExtensionPatterns(null), '')
    assert.equal(HAXCMSFile.stripExecutableExtensionPatterns(undefined), '')
    assert.equal(HAXCMSFile.stripExecutableExtensionPatterns(42), '')
  })
})

// ---------------------------------------------------------------------------
// normalizeFilenameExtensionCasing
// ---------------------------------------------------------------------------
describe('HAXCMSFile.normalizeFilenameExtensionCasing', () => {
  test('lowercases only the extension, preserving base name casing', () => {
    assert.equal(
      HAXCMSFile.normalizeFilenameExtensionCasing('Photo.JPG'),
      'Photo.jpg',
    )
    assert.equal(
      HAXCMSFile.normalizeFilenameExtensionCasing('MyDocument.PDF'),
      'MyDocument.pdf',
    )
  })

  test('handles a filename with no extension by returning it unchanged', () => {
    assert.equal(
      HAXCMSFile.normalizeFilenameExtensionCasing('README'),
      'README',
    )
  })

  test('preserves a directory portion of the path', () => {
    assert.equal(
      HAXCMSFile.normalizeFilenameExtensionCasing('foo/bar/Photo.JPG'),
      path.join('foo/bar', 'Photo.jpg'),
    )
  })

  test('handles empty and non-string input', () => {
    assert.equal(HAXCMSFile.normalizeFilenameExtensionCasing(''), '')
    assert.equal(HAXCMSFile.normalizeFilenameExtensionCasing(null), '')
    assert.equal(HAXCMSFile.normalizeFilenameExtensionCasing(undefined), '')
  })
})

// ---------------------------------------------------------------------------
// mimeMatchesAllowed
// ---------------------------------------------------------------------------
describe('HAXCMSFile.mimeMatchesAllowed', () => {
  test('returns true for an exact match', () => {
    assert.equal(
      HAXCMSFile.mimeMatchesAllowed('image/png', ['image/png', 'image/jpeg']),
      true,
    )
  })

  test('returns true for a wildcard prefix match', () => {
    assert.equal(HAXCMSFile.mimeMatchesAllowed('image/png', ['image/*']), true)
    assert.equal(
      HAXCMSFile.mimeMatchesAllowed('image/svg+xml', ['image/*']),
      true,
    )
  })

  test('returns false for a non-matching mime type', () => {
    assert.equal(
      HAXCMSFile.mimeMatchesAllowed('text/plain', ['image/*', 'image/png']),
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// detectMimeTypeFromContent
// ---------------------------------------------------------------------------
describe('HAXCMSFile.detectMimeTypeFromContent', () => {
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haxfile-mime-'))

  test.after(() => {
    fs.removeSync(TMP_DIR)
  })

  function writeSample(fileName, buffer) {
    const filePath = path.join(TMP_DIR, fileName)
    fs.writeFileSync(filePath, buffer)
    return filePath
  }

  test('detects a jpeg from its magic bytes', () => {
    const filePath = writeSample(
      'sample.jpg',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    )
    assert.equal(HAXCMSFile.detectMimeTypeFromContent(filePath), 'image/jpeg')
  })

  test('detects a png from its magic bytes', () => {
    const filePath = writeSample(
      'sample.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    )
    assert.equal(HAXCMSFile.detectMimeTypeFromContent(filePath), 'image/png')
  })

  test('detects a gif from its magic bytes', () => {
    const filePath = writeSample('sample.gif', Buffer.from('GIF89a' + 'extra'))
    assert.equal(HAXCMSFile.detectMimeTypeFromContent(filePath), 'image/gif')
  })

  test('detects a plain text file', () => {
    const filePath = writeSample(
      'sample.txt',
      Buffer.from('just some plain readable text content', 'utf8'),
    )
    assert.equal(HAXCMSFile.detectMimeTypeFromContent(filePath), 'text/plain')
  })

  test('falls back to application/octet-stream for an empty file', () => {
    const filePath = writeSample('sample.empty', Buffer.alloc(0))
    assert.equal(
      HAXCMSFile.detectMimeTypeFromContent(filePath),
      'application/octet-stream',
    )
  })
})

// ---------------------------------------------------------------------------
// isValidBulkImportStagedPath / getBulkImportStagingRootPath / isPathWithinRoot
// ---------------------------------------------------------------------------
describe('HAXCMSFile bulk-import staging path helpers', () => {
  const originalConfigDirectory = HAXCMS.configDirectory
  const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'haxfile-stage-'))

  test.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory
    fs.removeSync(TMP_BASE)
  })

  test('isPathWithinRoot: exact match, nested match, and sibling-prefix rejection', () => {
    assert.equal(HAXCMSFile.isPathWithinRoot('/a/b', '/a/b'), true)
    assert.equal(HAXCMSFile.isPathWithinRoot('/a/b/c', '/a/b'), true)
    // must not match on plain string-prefix without a path separator
    assert.equal(HAXCMSFile.isPathWithinRoot('/a/bc', '/a/b'), false)
    assert.equal(HAXCMSFile.isPathWithinRoot(null, '/a/b'), false)
    assert.equal(HAXCMSFile.isPathWithinRoot('/a/b', null), false)
  })

  test('getBulkImportStagingRootPath returns null when the staging dir does not exist', () => {
    HAXCMS.configDirectory = path.join(TMP_BASE, 'no-staging-yet')
    fs.mkdirpSync(HAXCMS.configDirectory)
    assert.equal(HAXCMSFile.getBulkImportStagingRootPath(), null)
  })

  test('isValidBulkImportStagedPath accepts a real file staged inside the root', () => {
    const configDir = path.join(TMP_BASE, 'with-staging')
    const importsRoot = path.join(configDir, 'tmp', 'imports')
    fs.mkdirpSync(importsRoot)
    HAXCMS.configDirectory = configDir

    const stagedFile = path.join(importsRoot, 'staged.txt')
    fs.writeFileSync(stagedFile, 'hello world')

    assert.equal(HAXCMSFile.getBulkImportStagingRootPath(), fs.realpathSync(importsRoot))
    assert.equal(HAXCMSFile.isValidBulkImportStagedPath(stagedFile), true)
  })

  test('isValidBulkImportStagedPath rejects a path outside the staging root', () => {
    const configDir = path.join(TMP_BASE, 'reject-outside')
    const importsRoot = path.join(configDir, 'tmp', 'imports')
    fs.mkdirpSync(importsRoot)
    HAXCMS.configDirectory = configDir

    const outsideFile = path.join(TMP_BASE, 'outside.txt')
    fs.writeFileSync(outsideFile, 'nope')

    assert.equal(HAXCMSFile.isValidBulkImportStagedPath(outsideFile), false)
  })

  test('isValidBulkImportStagedPath rejects a non-existent path', () => {
    const configDir = path.join(TMP_BASE, 'reject-missing')
    const importsRoot = path.join(configDir, 'tmp', 'imports')
    fs.mkdirpSync(importsRoot)
    HAXCMS.configDirectory = configDir

    assert.equal(
      HAXCMSFile.isValidBulkImportStagedPath(path.join(importsRoot, 'does-not-exist.txt')),
      false,
    )
  })

  test('isValidBulkImportStagedPath rejects a relative path', () => {
    const configDir = path.join(TMP_BASE, 'reject-relative')
    const importsRoot = path.join(configDir, 'tmp', 'imports')
    fs.mkdirpSync(importsRoot)
    HAXCMS.configDirectory = configDir
    fs.writeFileSync(path.join(importsRoot, 'rel.txt'), 'x')

    assert.equal(HAXCMSFile.isValidBulkImportStagedPath('tmp/imports/rel.txt'), false)
  })

  test('isValidBulkImportStagedPath rejects non-string input', () => {
    assert.equal(HAXCMSFile.isValidBulkImportStagedPath(null), false)
    assert.equal(HAXCMSFile.isValidBulkImportStagedPath(undefined), false)
    assert.equal(HAXCMSFile.isValidBulkImportStagedPath(42), false)
  })

  test('isValidBulkImportStagedPath rejects a symlinked file inside the root', (t) => {
    const configDir = path.join(TMP_BASE, 'reject-symlink')
    const importsRoot = path.join(configDir, 'tmp', 'imports')
    fs.mkdirpSync(importsRoot)
    HAXCMS.configDirectory = configDir

    const realFile = path.join(TMP_BASE, 'real-target.txt')
    fs.writeFileSync(realFile, 'target contents')
    const symlinkPath = path.join(importsRoot, 'staged-symlink.txt')
    try {
      fs.symlinkSync(realFile, symlinkPath)
    }
    catch (e) {
      // symlink creation can fail without elevated privileges on some
      // platforms (notably Windows); skip in that case rather than fail.
      t.skip('symlink creation not permitted on this platform: ' + e.message)
      return
    }
    assert.equal(HAXCMSFile.isValidBulkImportStagedPath(symlinkPath), false)
  })
})
