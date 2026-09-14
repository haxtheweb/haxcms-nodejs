'use strict'

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const FileContentScanner = require('../../src/lib/FileContentScanner.js')
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

describe('FileContentScanner — Phase 2 (#3043)', () => {
  let tmpRoot
  let site
  let filesDir

  beforeEach(async () => {
    const ctx = await makeTempSite('testsite')
    tmpRoot = ctx.tmpRoot
    site = ctx.site
    filesDir = ctx.filesDir
  })

  afterEach(async () => {
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  describe('extractFileReferences', () => {
    test('extracts img src (double-quoted)', () => {
      const html = '<img src="files/banner.jpg" alt="Banner">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/banner.jpg'])
    })

    test('extracts img src (single-quoted)', () => {
      const html = "<img src='files/photo.png' alt='Photo'>"
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/photo.png'])
    })

    test('extracts a href', () => {
      const html = '<a href="files/document.pdf">Download</a>'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/document.pdf'])
    })

    test('extracts media-image source', () => {
      const html = '<media-image source="files/hero.jpg"></media-image>'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/hero.jpg'])
    })

    test('extracts video-player source and poster', () => {
      const html =
        '<video-player source="files/intro.mp4" poster="files/poster.jpg"></video-player>'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.equal(refs.length, 2)
      assert.ok(refs.indexOf('files/intro.mp4') !== -1)
      assert.ok(refs.indexOf('files/poster.jpg') !== -1)
    })

    test('ignores external URLs (http, https, protocol-relative)', () => {
      const html =
        '<img src="https://example.com/files/external.jpg">' +
        '<img src="http://example.com/files/x.png">' +
        '<img src="//cdn.example.com/files/y.gif">' +
        '<a href="https://google.com">Link</a>'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, [])
    })

    test('ignores data: URIs', () => {
      const html = '<img src="data:image/png;base64,iVBORw0KGgo=">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, [])
    })

    test('ignores non-files relative paths', () => {
      const html = '<a href="pages/about.html">About</a><img src="assets/logo.png">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, [])
    })

    test('strips query strings and fragments', () => {
      const html =
        '<img src="files/cached.jpg?v=123">' +
        '<img src="files/frag.jpg#section">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/cached.jpg', 'files/frag.jpg'])
    })

    test('dedupes repeated references (preserves first-seen order)', () => {
      const html =
        '<img src="files/dup.jpg">' +
        '<a href="files/dup.jpg">' +
        '<img src="files/dup.jpg">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/dup.jpg'])
    })

    test('rejects traversal attempts', () => {
      const html = '<img src="files/../../../etc/passwd">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, [])
    })

    test('handles multiple distinct files in one HTML block', () => {
      const html =
        '<img src="files/a.jpg">' +
        '<a href="files/b.pdf">' +
        '<media-image source="files/c.png"></media-image>'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/a.jpg', 'files/b.pdf', 'files/c.png'])
    })

    test('returns empty for empty html', () => {
      assert.deepEqual(FileContentScanner.extractFileReferences(''), [])
      assert.deepEqual(FileContentScanner.extractFileReferences(null), [])
    })

    test('strips leading ./ from file references', () => {
      const html = '<img src="./files/dotted.jpg">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/dotted.jpg'])
    })

    test('reduces sitesDirectory/siteName/files/ prefix to files/...', () => {
      const html = '<img src="_sites/mysite/files/prefixed.jpg">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/prefixed.jpg'])
    })

    test('case-insensitive attribute matching', () => {
      const html = '<IMG SRC="files/caps.jpg">'
      const refs = FileContentScanner.extractFileReferences(html)
      assert.deepEqual(refs, ['files/caps.jpg'])
    })
  })

  describe('normalizeFileReference', () => {
    test('returns canonical files/ path for simple relative input', () => {
      assert.equal(
        FileContentScanner.normalizeFileReference('files/test.jpg'),
        'files/test.jpg',
      )
    })

    test('returns empty for empty string', () => {
      assert.equal(FileContentScanner.normalizeFileReference(''), '')
      assert.equal(FileContentScanner.normalizeFileReference(null), '')
    })

    test('returns empty for external URLs', () => {
      assert.equal(FileContentScanner.normalizeFileReference('https://example.com/x'), '')
      assert.equal(FileContentScanner.normalizeFileReference('http://example.com/y'), '')
      assert.equal(FileContentScanner.normalizeFileReference('//cdn.example.com/z'), '')
      assert.equal(FileContentScanner.normalizeFileReference('data:image/png;base64,abc'), '')
      assert.equal(FileContentScanner.normalizeFileReference('mailto:a@b.com'), '')
    })

    test('returns empty for non-files paths', () => {
      assert.equal(FileContentScanner.normalizeFileReference('pages/about.html'), '')
      assert.equal(FileContentScanner.normalizeFileReference('assets/logo.png'), '')
      assert.equal(FileContentScanner.normalizeFileReference('/random/path'), '')
    })

    test('strips query and fragment', () => {
      assert.equal(
        FileContentScanner.normalizeFileReference('files/x.jpg?v=1'),
        'files/x.jpg',
      )
      assert.equal(
        FileContentScanner.normalizeFileReference('files/y.png#frag'),
        'files/y.png',
      )
    })

    test('rejects traversal', () => {
      assert.equal(
        FileContentScanner.normalizeFileReference('files/../../../etc/passwd'),
        '',
      )
      assert.equal(
        FileContentScanner.normalizeFileReference('files/../secret'),
        '',
      )
    })

    test('strips leading ./', () => {
      assert.equal(
        FileContentScanner.normalizeFileReference('./files/dot.jpg'),
        'files/dot.jpg',
      )
      assert.equal(
        FileContentScanner.normalizeFileReference('././files/double.jpg'),
        'files/double.jpg',
      )
    })

    test('normalizes backslashes to forward slashes', () => {
      assert.equal(
        FileContentScanner.normalizeFileReference('files\\sub\\win.png'),
        'files/sub/win.png',
      )
    })
  })

  describe('rebuildPageFilesUuids', () => {
    test('sets uuid array for known files', async () => {
      // Create files on disk.
      await fs.writeFile(path.join(filesDir, 'a.jpg'), 'aaa')
      await fs.writeFile(path.join(filesDir, 'b.pdf'), 'bbb')
      const html =
        '<img src="files/a.jpg"><a href="files/b.pdf">'
      const page = { id: 'page-1', metadata: {} }
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.ok(Array.isArray(uuids))
      assert.equal(uuids.length, 2)
      assert.equal(uuids[0], getDeterministicFileUuid(site, 'files/a.jpg', 3))
      assert.equal(uuids[1], getDeterministicFileUuid(site, 'files/b.pdf', 3))
      // page.metadata.files should be set to the uuid array.
      assert.deepEqual(page.metadata.files, uuids)
    })

    test('unknown file resolves to empty string and is dropped', async () => {
      // Only a.jpg exists on disk; ghost.png does not.
      await fs.writeFile(path.join(filesDir, 'a.jpg'), 'aaa')
      const html = '<img src="files/a.jpg"><img src="files/ghost.png">'
      const page = { id: 'page-1', metadata: {} }
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.equal(uuids.length, 1)
      assert.equal(uuids[0], getDeterministicFileUuid(site, 'files/a.jpg', 3))
    })

    test('legacy object entries in metadata.files are replaced', async () => {
      await fs.writeFile(path.join(filesDir, 'new.jpg'), 'nnn')
      const page = {
        id: 'page-1',
        metadata: {
          files: [{ path: 'files/old.jpg', name: 'old.jpg' }],
        },
      }
      const html = '<img src="files/new.jpg">'
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      // The legacy object should be replaced by the new uuid array.
      assert.equal(uuids.length, 1)
      assert.equal(typeof uuids[0], 'string')
      assert.deepEqual(page.metadata.files, uuids)
    })

    test('empty html results in empty uuid array', async () => {
      const page = { id: 'page-1', metadata: { files: ['old-uuid'] } }
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, '')
      assert.deepEqual(uuids, [])
      assert.deepEqual(page.metadata.files, [])
    })

    test('dedupes repeated file references', async () => {
      await fs.writeFile(path.join(filesDir, 'dup.jpg'), 'd')
      const html = '<img src="files/dup.jpg"><img src="files/dup.jpg">'
      const page = { id: 'page-1', metadata: {} }
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.equal(uuids.length, 1)
    })

    test('creates metadata object if page has none', async () => {
      await fs.writeFile(path.join(filesDir, 'meta.jpg'), 'm')
      const page = { id: 'page-1' }
      const html = '<img src="files/meta.jpg">'
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.ok(page.metadata)
      assert.deepEqual(page.metadata.files, uuids)
    })
  })
})
