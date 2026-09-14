'use strict'

// Unit tests for the page-save file-tracking wiring (#3043).
//
// Mirrors the PHP saveNodeDetails / saveNode page-save test: after a page
// save, page.metadata.files must be an array of uuid STRINGS (references into
// files.json), never full file objects. A file removed from the content
// drops out of the set automatically. Legacy object-shape entries on
// existing pages self-heal to uuid strings on the next save.
//
// Tests the wiring at the function level:
//   - FileContentScanner.rebuildPageFilesUuids (called by saveNode,
//     saveNodeDetails, saveOutline) produces uuid strings from a content
//     path-scan.
//   - applyNodeDetailOperation (nodeDetailOperations.js) calls
//     rebuildPageFilesUuids as part of the details save flow, so the
//     metadata.files array on the saved page is uuid strings.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const FileContentScanner = require('../../src/lib/FileContentScanner.js')
const {
  applyNodeDetailOperation,
} = require('../../src/lib/nodeDetailOperations.js')
const {
  getDeterministicFileUuid,
} = require('../../src/lib/siteFileUuid.js')

// Helper: create a temp site directory with a files/ subdir and a manifest.
async function makeTempSite(siteName) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
  const siteDirectory = path.join(tmpRoot, siteName || 'testsite')
  const filesDir = path.join(siteDirectory, 'files')
  const pagesDir = path.join(siteDirectory, 'pages', 'page-1')
  await fs.ensureDir(filesDir)
  await fs.ensureDir(pagesDir)
  const site = {
    siteDirectory: siteDirectory,
    name: siteName || 'testsite',
    manifest: {
      metadata: {
        site: { name: siteName || 'testsite' },
      },
      items: [],
      save: async function () { return true },
    },
    loadNode: function (id) {
      for (var i = 0; i < this.manifest.items.length; i++) {
        if (this.manifest.items[i].id === id) {
          return this.manifest.items[i]
        }
      }
      return false
    },
    getPageContent: async function (page) {
      if (page && page.location) {
        const p = path.join(this.siteDirectory, page.location)
        if (fs.pathExistsSync(p)) {
          return fs.readFileSync(p, 'utf8')
        }
      }
      return ''
    },
    updateAlternateFormats: async function () { return true },
    gitCommit: async function () { return true },
    updateNode: async function () { return true },
    isPathautoEnabled: function () { return false },
    getUniqueSlugName: function (title) { return title },
  }
  return { tmpRoot, site, siteDirectory, filesDir }
}

describe('pageSaveFilesTracking — #3043', () => {
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

  describe('rebuildPageFilesUuids (page save simulation)', () => {
    test('page save produces uuid-string array from content path-scan', async () => {
      await fs.writeFile(path.join(filesDir, 'banner.jpg'), 'jpg-content')
      await fs.writeFile(path.join(filesDir, 'doc.pdf'), 'pdf-content')
      const html = '<img src="files/banner.jpg"><a href="files/doc.pdf">Doc</a>'
      const page = { id: 'page-1', metadata: {} }
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.ok(Array.isArray(uuids))
      assert.equal(uuids.length, 2)
      // Every entry must be a string (uuid), never an object.
      for (let i = 0; i < uuids.length; i++) {
        assert.equal(typeof uuids[i], 'string', 'entry ' + i + ' must be a string')
      }
      assert.deepEqual(page.metadata.files, uuids)
    })

    test('file removed from content drops out of the uuid set', async () => {
      await fs.writeFile(path.join(filesDir, 'keep.jpg'), 'keep')
      await fs.writeFile(path.join(filesDir, 'drop.jpg'), 'drop')
      // First save: both files referenced.
      let html = '<img src="files/keep.jpg"><img src="files/drop.jpg">'
      let page = { id: 'page-1', metadata: {} }
      let uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.equal(uuids.length, 2)
      // Second save: drop.jpg removed from content.
      html = '<img src="files/keep.jpg">'
      uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.equal(uuids.length, 1)
      assert.equal(uuids[0], getDeterministicFileUuid(site, 'files/keep.jpg', 4))
    })

    test('legacy object entries replaced by uuid strings on next save', async () => {
      await fs.writeFile(path.join(filesDir, 'new.jpg'), 'new')
      // Page has legacy object-shape entries.
      const page = {
        id: 'page-1',
        metadata: {
          files: [
            { path: 'files/old.jpg', name: 'old.jpg', type: 'image/jpeg', fullUrl: '/files/old.jpg' },
            { path: 'files/legacy.pdf', name: 'legacy.pdf', type: 'application/pdf' },
          ],
        },
      }
      const html = '<img src="files/new.jpg">'
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      // The legacy objects should be replaced by the new uuid array.
      assert.equal(uuids.length, 1)
      assert.equal(typeof uuids[0], 'string')
      assert.deepEqual(page.metadata.files, uuids)
      // No objects remain in the array.
      for (let i = 0; i < page.metadata.files.length; i++) {
        assert.equal(typeof page.metadata.files[i], 'string')
      }
    })

    test('empty content results in empty uuid array (all files dropped)', async () => {
      await fs.writeFile(path.join(filesDir, 'a.jpg'), 'a')
      const page = {
        id: 'page-1',
        metadata: {
          files: ['some-old-uuid'],
        },
      }
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, '')
      assert.deepEqual(uuids, [])
      assert.deepEqual(page.metadata.files, [])
    })

    test('media-image source and video-player poster are scanned', async () => {
      await fs.writeFile(path.join(filesDir, 'hero.jpg'), 'hero')
      await fs.writeFile(path.join(filesDir, 'poster.jpg'), 'poster')
      await fs.writeFile(path.join(filesDir, 'intro.mp4'), 'mp4')
      const html =
        '<media-image source="files/hero.jpg"></media-image>' +
        '<video-player source="files/intro.mp4" poster="files/poster.jpg"></video-player>'
      const page = { id: 'page-1', metadata: {} }
      const uuids = await FileContentScanner.rebuildPageFilesUuids(site, page, html)
      assert.equal(uuids.length, 3)
      for (let i = 0; i < uuids.length; i++) {
        assert.equal(typeof uuids[i], 'string')
      }
    })
  })

  describe('applyNodeDetailOperation calls rebuildPageFilesUuids', () => {
    test('details save (setTitle) rebuilds metadata.files as uuid strings', async () => {
      // Create a page with an HTML file on disk and legacy object entries.
      await fs.writeFile(path.join(filesDir, 'photo.jpg'), 'photo')
      const pageHtml = '<img src="files/photo.jpg">'
      const page = {
        id: 'page-1',
        title: 'Old Title',
        slug: 'old-title',
        location: 'pages/page-1/index.html',
        metadata: {
          files: [{ path: 'files/old.jpg', type: 'image/jpeg' }],
        },
      }
      // Write the page content to disk so getPageContent can read it.
      await fs.writeFile(
        path.join(site.siteDirectory, 'pages/page-1/index.html'),
        pageHtml,
      )
      site.manifest.items.push(page)

      // Apply setTitle operation — this should also rebuild metadata.files.
      await applyNodeDetailOperation(site, 'page-1', {
        operation: 'setTitle',
        title: 'New Title',
      })

      const updated = site.loadNode('page-1')
      assert.ok(updated)
      assert.equal(updated.title, 'New Title')
      // metadata.files must now be uuid strings, not objects.
      assert.ok(Array.isArray(updated.metadata.files))
      assert.equal(updated.metadata.files.length, 1)
      assert.equal(typeof updated.metadata.files[0], 'string')
    })

    test('details save with no file refs results in empty uuid array', async () => {
      const page = {
        id: 'page-2',
        title: 'Page 2',
        slug: 'page-2',
        location: 'pages/page-1/index.html',
        metadata: {
          files: ['legacy-uuid-1', 'legacy-uuid-2'],
        },
      }
      // Page content has no files/ references.
      await fs.writeFile(
        path.join(site.siteDirectory, 'pages/page-1/index.html'),
        '<p>No files here</p>',
      )
      site.manifest.items.push(page)

      await applyNodeDetailOperation(site, 'page-2', {
        operation: 'setDescription',
        description: 'A page with no files',
      })

      const updated = site.loadNode('page-2')
      assert.ok(updated)
      assert.deepEqual(updated.metadata.files, [])
    })
  })
})
