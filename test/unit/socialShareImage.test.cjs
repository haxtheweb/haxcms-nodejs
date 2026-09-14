'use strict'

// Unit tests for HAXCMSSite.getSocialShareImage (#3043).
//
// Mirrors the PHP HAXCMSSite::getSocialShareImage test: page.metadata.files
// is now an array of uuid strings. The method must resolve each uuid to its
// files.json record and return the first image record's fullUrl. Tolerate
// legacy object-shape entries on old pages (read .type/.fullUrl directly)
// until those pages are re-saved and converge to uuid-shape.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const { HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const {
  getDeterministicFileUuid,
} = require('../../src/lib/siteFileUuid.js')

// Helper: create a temp site directory with a files/ subdir.
async function makeTempSite(siteName) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
  const siteDirectory = path.join(tmpRoot, siteName || 'testsite')
  const filesDir = path.join(siteDirectory, 'files')
  await fs.ensureDir(filesDir)
  const site = new HAXCMSSite()
  site.name = siteName || 'testsite'
  site.siteDirectory = siteDirectory
  site.manifest = {
    metadata: {
      site: { name: siteName || 'testsite' },
    },
    items: [],
  }
  return { tmpRoot, site, siteDirectory, filesDir }
}

describe('socialShareImage — #3043', () => {
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

  test('resolves first image via files.json uuid string', async () => {
    // Create an image file on disk and upsert its record into files.json.
    const imgPath = path.join(filesDir, 'cover.jpg')
    await fs.writeFile(imgPath, 'fake-jpg')
    const dataStore = new FilesDataStore(site)
    const record = await dataStore.buildFileRecordFromDisk('files/cover.jpg')
    dataStore.upsertRecord(record)

    // Page has metadata.files as uuid strings.
    const page = {
      id: 'page-1',
      metadata: {
        files: [record.uuid],
      },
    }
    const result = site.getSocialShareImage(page)
    assert.ok(result, 'should return a fullUrl')
    assert.equal(result, record.fullUrl)
  })

  test('returns first image mimetype, skips non-image uuid entries', async () => {
    // Create a PDF and an image.
    await fs.writeFile(path.join(filesDir, 'doc.pdf'), 'pdf')
    await fs.writeFile(path.join(filesDir, 'photo.png'), 'png')
    const dataStore = new FilesDataStore(site)
    const pdfRecord = await dataStore.buildFileRecordFromDisk('files/doc.pdf')
    const imgRecord = await dataStore.buildFileRecordFromDisk('files/photo.png')
    dataStore.upsertRecord(pdfRecord)
    dataStore.upsertRecord(imgRecord)

    // PDF first, then image — should skip the PDF and return the image.
    const page = {
      id: 'page-1',
      metadata: {
        files: [pdfRecord.uuid, imgRecord.uuid],
      },
    }
    const result = site.getSocialShareImage(page)
    assert.ok(result)
    assert.equal(result, imgRecord.fullUrl)
  })

  test('tolerates legacy object-shape entries (old pages)', async () => {
    // Page has legacy object-shape entries (pre-Phase 2).
    const page = {
      id: 'page-1',
      metadata: {
        files: [
          { path: 'files/old.jpg', type: 'image/jpeg', fullUrl: '/files/old.jpg' },
        ],
      },
    }
    const result = site.getSocialShareImage(page)
    assert.ok(result)
    assert.equal(result, '/files/old.jpg')
  })

  test('legacy object with non-image type is skipped', async () => {
    const page = {
      id: 'page-1',
      metadata: {
        files: [
          { path: 'files/doc.pdf', type: 'application/pdf', fullUrl: '/files/doc.pdf' },
          { path: 'files/banner.jpg', type: 'image/jpeg', fullUrl: '/files/banner.jpg' },
        ],
      },
    }
    const result = site.getSocialShareImage(page)
    assert.ok(result)
    assert.equal(result, '/files/banner.jpg')
  })

  test('mixed uuid strings and legacy objects — uuid resolved first', async () => {
    await fs.writeFile(path.join(filesDir, 'new.png'), 'png')
    const dataStore = new FilesDataStore(site)
    const imgRecord = await dataStore.buildFileRecordFromDisk('files/new.png')
    dataStore.upsertRecord(imgRecord)

    const page = {
      id: 'page-1',
      metadata: {
        files: [
          imgRecord.uuid,
          { path: 'files/legacy.jpg', type: 'image/jpeg', fullUrl: '/files/legacy.jpg' },
        ],
      },
    }
    const result = site.getSocialShareImage(page)
    assert.ok(result)
    assert.equal(result, imgRecord.fullUrl)
  })

  test('returns undefined when no images in files array', async () => {
    await fs.writeFile(path.join(filesDir, 'doc.pdf'), 'pdf')
    const dataStore = new FilesDataStore(site)
    const pdfRecord = await dataStore.buildFileRecordFromDisk('files/doc.pdf')
    dataStore.upsertRecord(pdfRecord)

    const page = {
      id: 'page-1',
      metadata: {
        files: [pdfRecord.uuid],
      },
    }
    const result = site.getSocialShareImage(page)
    // No image found; fileName stays undefined (no theme banner set).
    assert.ok(result === undefined || result === null || result === '')
  })

  test('theme banner overrides when no image in files', async () => {
    const page = {
      id: 'page-1',
      metadata: {
        files: [],
      },
    }
    site.manifest.metadata.theme = {
      variables: {
        image: '/theme/banner.jpg',
      },
    }
    const result = site.getSocialShareImage(page)
    assert.equal(result, '/theme/banner.jpg')
  })

  test('SVG uuid entries are skipped (not raster images)', async () => {
    // Create an SVG file.
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'
    await fs.writeFile(path.join(filesDir, 'icon.svg'), svgContent)
    await fs.writeFile(path.join(filesDir, 'photo.jpg'), 'jpg')
    const dataStore = new FilesDataStore(site)
    const svgRecord = await dataStore.buildFileRecordFromDisk('files/icon.svg')
    const jpgRecord = await dataStore.buildFileRecordFromDisk('files/photo.jpg')
    dataStore.upsertRecord(svgRecord)
    dataStore.upsertRecord(jpgRecord)

    const page = {
      id: 'page-1',
      metadata: {
        files: [svgRecord.uuid, jpgRecord.uuid],
      },
    }
    const result = site.getSocialShareImage(page)
    assert.ok(result)
    assert.equal(result, jpgRecord.fullUrl)
  })
})
