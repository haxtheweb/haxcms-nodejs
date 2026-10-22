'use strict'

// Unit tests for accepting .h5p packages as uploads.
//
// An H5P package is a zip archive (h5p.json, content/content.json and the
// libraries the content needs). The server never unpacks it: it is stored as
// is, and the h5p-element web component unpacks and plays it in the browser.
// So it only has to clear the same three gates as every other type: the upload
// extension allowlist, the bulk-import extension allowlist, and the extension
// -> MIME table checked against the type sniffed from the file's own bytes.
// The tests go through importBuildFile, the real bulk-import path, so the whole
// chain is exercised rather than the regexes in isolation.
//
// The security case worth pinning: an archive is only accepted when its bytes
// really are a zip. A script or page renamed to .h5p sniffs as something else
// and is rejected instead of being stored and later served.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const safeFetchMod = require('../../src/lib/safeFetch.js')
const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const createSite = require('../../src/systemRoutes/v1/routes/createSite.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const FileStorage = require('../../src/lib/FileStorage.js')

const { importBuildFile } = createSite

function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

// a minimal, valid zip (stored entries) so no archive library is needed
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  Object.keys(entries).forEach(function (name) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(entries[name], 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  })
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat(locals.concat([centralBuf, end]))
}

const H5P = buildZip({
  'h5p.json': JSON.stringify({
    title: 'Sample',
    mainLibrary: 'H5P.Blanks',
    preloadedDependencies: [
      { machineName: 'H5P.Blanks', majorVersion: 1, minorVersion: 14 },
    ],
  }),
  'content/content.json': '{}',
})

const NOT_AN_ARCHIVE = Buffer.from(
  '<html><body><script>alert(1)</script></body></html>',
  'utf8',
)

describe('h5p upload allowlist', () => {
  const realSafeFetch = safeFetchMod.safeFetch
  const realConfigDirectory = HAXCMS.configDirectory
  let tmpRoot
  let stagingRoot
  let site

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-h5p-'))
    HAXCMS.configDirectory = path.join(tmpRoot, 'config')
    stagingRoot = path.join(HAXCMS.configDirectory, 'tmp', 'imports')
    await fs.ensureDir(stagingRoot)
    site = new HAXCMSSite()
    site.name = 'testsite'
    site.siteDirectory = path.join(tmpRoot, 'testsite')
    await fs.ensureDir(path.join(site.siteDirectory, 'files'))
    site.manifest = {
      metadata: { site: { name: 'testsite' } },
      items: [],
      save: async function () {
        return true
      },
    }
  })

  afterEach(async () => {
    safeFetchMod.safeFetch = realSafeFetch
    HAXCMS.configDirectory = realConfigDirectory
    try {
      await fs.remove(tmpRoot)
    } catch {
      // intentionally ignored
    }
  })

  function stubNetwork(responses) {
    safeFetchMod.safeFetch = async function (url) {
      const entry = responses[url]
      const status = entry ? entry.status || 200 : 404
      const body = entry && entry.body ? entry.body : Buffer.alloc(0)
      return {
        ok: status >= 200 && status < 300,
        status: status,
        headers: { get: function () { return null } },
        arrayBuffer: async function () { return body },
      }
    }
  }

  function entityAt(relativePath) {
    const fileStorage = FileStorage.registerOn(new EntityRegistry(site))
    const record = fileStorage.getDataStore().getByPath(relativePath)
    return record ? fileStorage.load(record.uuid) : null
  }

  describe('the MIME table', () => {
    test('a package accepts the zip types', () => {
      const allowed = HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['h5p']
      assert.ok(allowed, 'h5p has an entry')
      assert.deepEqual(allowed, [
        'application/zip',
        'application/x-zip-compressed',
      ])
    })

    test('a package does not accept html or scripts', () => {
      const allowed = HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['h5p']
      ;['text/html', 'text/javascript', 'text/plain'].forEach(function (mime) {
        assert.equal(HAXCMSFile.mimeMatchesAllowed(mime, allowed), false, mime)
      })
    })
  })

  describe('what the sniffer reports', () => {
    test('a real package sniffs as a zip, which the table allows', async () => {
      const staged = path.join(stagingRoot, 'probe.h5p')
      await fs.writeFile(staged, H5P)
      const detected = HAXCMSFile.detectMimeTypeFromContent(staged)
      assert.equal(detected, 'application/zip')
      assert.equal(
        HAXCMSFile.mimeMatchesAllowed(
          detected,
          HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['h5p'],
        ),
        true,
      )
    })

    test('a page renamed to .h5p does not sniff as a zip', async () => {
      const staged = path.join(stagingRoot, 'fake.h5p')
      await fs.writeFile(staged, NOT_AN_ARCHIVE)
      const detected = HAXCMSFile.detectMimeTypeFromContent(staged)
      assert.equal(
        HAXCMSFile.mimeMatchesAllowed(
          detected,
          HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['h5p'],
        ),
        false,
      )
    })
  })

  describe('through the bulk import path', () => {
    test('a package is imported and recorded in files.json', async () => {
      stubNetwork({ 'https://example.org/quiz.h5p': { body: H5P } })
      assert.equal(
        await importBuildFile(
          site,
          'files/quiz.h5p',
          'https://example.org/quiz.h5p',
          0,
        ),
        true,
      )
      assert.ok(entityAt('files/quiz.h5p'), 'files.json records the package')
      assert.ok(
        fs.existsSync(path.join(site.siteDirectory, 'files', 'quiz.h5p')),
        'and the bytes are on disk',
      )
    })

    test('a page renamed to .h5p is refused and not recorded', async () => {
      stubNetwork({ 'https://example.org/fake.h5p': { body: NOT_AN_ARCHIVE } })
      // importBuildFile reports true for any file that downloaded, even when
      // HAXCMSFile.save then refused it (existing behaviour for every type),
      // so the assertions are about what reached the site
      await importBuildFile(
        site,
        'files/fake.h5p',
        'https://example.org/fake.h5p',
        0,
      )
      assert.equal(
        fs.existsSync(path.join(site.siteDirectory, 'files', 'fake.h5p')),
        false,
      )
      assert.equal(entityAt('files/fake.h5p'), null)
    })
  })
})
