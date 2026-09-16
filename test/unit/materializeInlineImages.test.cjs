'use strict'

// Unit tests for materializeInlineImages (#2945).
//
// Imported docx HTML carries its images as data: URIs, which
// sanitizeHTMLForStorage strips. The helper saves each one through
// HAXCMSFile (so it is validated and recorded in files.json) and renders it
// as media-image; anything it cannot save becomes an image place-holder.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const { HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const { materializeInlineImages } = require('../../src/lib/materializeInlineImages.js')

// a minimal valid 1x1 PNG, as mammoth would hand it over base64 encoded
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_DATA_URI = 'data:image/png;base64,' + PNG_BASE64

async function makeTempSite(siteName) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
  const siteDirectory = path.join(tmpRoot, siteName || 'testsite')
  await fs.ensureDir(path.join(siteDirectory, 'files'))
  const site = new HAXCMSSite()
  site.name = siteName || 'testsite'
  site.siteDirectory = siteDirectory
  site.manifest = {
    metadata: {
      site: { name: siteName || 'testsite' },
    },
    items: [],
  }
  return { tmpRoot, site, siteDirectory }
}

function savedImages(siteDirectory) {
  return fs
    .readdirSync(path.join(siteDirectory, 'files'))
    .filter(function (name) {
      return /\.(png|jpg|gif|webp)$/.test(name)
    })
}

describe('materializeInlineImages — #2945', () => {
  let tmpRoot
  let site
  let siteDirectory

  beforeEach(async () => {
    const ctx = await makeTempSite('testsite')
    tmpRoot = ctx.tmpRoot
    site = ctx.site
    siteDirectory = ctx.siteDirectory
  })

  afterEach(async () => {
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  test('saves an inline image as a site file and renders media-image', async () => {
    const result = await materializeInlineImages(
      '<p>Before</p><p><img alt="A red square" src="' + PNG_DATA_URI + '"></p>',
      site,
    )
    const files = savedImages(siteDirectory)
    assert.equal(files.length, 1)
    assert.equal(
      result,
      '<p>Before</p><p><media-image source="files/' +
        files[0] +
        '" alt="A red square"></media-image></p>',
    )
    assert.deepEqual(
      fs.readFileSync(path.join(siteDirectory, 'files', files[0])),
      Buffer.from(PNG_BASE64, 'base64'),
      'saved bytes match the inline image',
    )
  })

  test('records the saved file in files.json so it resolves to a uuid', async () => {
    const result = await materializeInlineImages(
      '<p><img src="' + PNG_DATA_URI + '"></p>',
      site,
    )
    const files = savedImages(siteDirectory)
    const dataStore = new FilesDataStore(site)
    const uuid = await dataStore.resolveUuidByPath('files/' + files[0])
    assert.notEqual(uuid, '')
    assert.ok(result.indexOf('source="files/' + files[0] + '"') !== -1)
    const record = dataStore.getByUuid(uuid)
    assert.equal(record.path, 'files/' + files[0])
    assert.equal(record.mimetype, 'image/png')
  })

  test('an image repeated on the page is saved once', async () => {
    const result = await materializeInlineImages(
      '<p><img src="' + PNG_DATA_URI + '"></p><p><img src="' + PNG_DATA_URI + '"></p>',
      site,
    )
    const files = savedImages(siteDirectory)
    assert.equal(files.length, 1)
    assert.equal(result.split('source="files/' + files[0] + '"').length - 1, 2)
  })

  test('missing alt becomes an empty alt, and alt text is escaped', async () => {
    const result = await materializeInlineImages(
      '<p><img src="' + PNG_DATA_URI + '"></p><p><img alt="a &quot;q&quot; b" src="' + PNG_DATA_URI + '"></p>',
      site,
    )
    assert.ok(result.indexOf('alt=""') !== -1)
    assert.ok(result.indexOf('alt="a &quot;q&quot; b"') !== -1)
  })

  test('image types that cannot be saved become image place-holders', async () => {
    const cases = [
      ['data:image/x-emf;base64,' + Buffer.from('emf').toString('base64'), 'vector chart'],
      ['data:image/svg+xml,%3Csvg%3E%3C/svg%3E', 'drawing'],
      ['data:image/png;base64,' + Buffer.from('not a png').toString('base64'), 'broken'],
    ]
    for (const entry of cases) {
      const result = await materializeInlineImages(
        '<p><img alt="' + entry[1] + '" src="' + entry[0] + '"></p>',
        site,
      )
      assert.equal(
        result,
        '<p><place-holder type="image" text="' + entry[1] + '"></place-holder></p>',
      )
    }
    assert.deepEqual(savedImages(siteDirectory), [])
  })

  test('leaves everything that is not a real inline image untouched', async () => {
    const cases = [
      // already a site file
      '<p><img src="files/banner.jpg" alt="Banner"></p>',
      // inert markup: the sanitizer escapes template content as code
      '<code-sample><template preserve-content="preserve-content"><img src="' +
        PNG_DATA_URI +
        '"></template></code-sample>',
      // a data: URI that is only text, in a comment or an attribute value
      '<!-- <img src="' + PNG_DATA_URI + '"> -->',
      '<div data-example="<img src=\'' + PNG_DATA_URI + '\'>">text</div>',
      // not an img element
      '<p><a href="data:text/plain,hi">link</a></p>',
    ]
    for (const html of cases) {
      assert.equal(await materializeInlineImages(html, site), html)
    }
    assert.deepEqual(savedImages(siteDirectory), [])
  })

  test('addPage stores imported images as files and references them by uuid', async () => {
    const saved = []
    site.manifest.addItem = function (item) {
      site.manifest.items.push(item)
    }
    site.manifest.save = async function () {
      saved.push(site.manifest.items.length)
      return true
    }
    const page = await site.addPage(
      null,
      'Imported',
      'html',
      'imported',
      null,
      null,
      '<p><img alt="A red square" src="' + PNG_DATA_URI + '"></p>',
    )
    const files = savedImages(siteDirectory)
    assert.equal(files.length, 1)
    const content = fs.readFileSync(path.join(siteDirectory, page.location), 'utf8')
    assert.ok(
      content.indexOf('<media-image source="files/' + files[0] + '" alt="A red square">') !== -1,
      'page renders the saved file as media-image: ' + content,
    )
    assert.equal(content.indexOf('data:image'), -1, 'no data: URI is written to the page')
    const uuid = await new FilesDataStore(site).resolveUuidByPath('files/' + files[0])
    assert.deepEqual(page.metadata.files, [uuid], 'page references the file by uuid')
  })

  test('non-string content is returned as it came in', async () => {
    assert.equal(await materializeInlineImages(undefined, site), undefined)
    assert.equal(await materializeInlineImages(null, site), null)
  })
})
