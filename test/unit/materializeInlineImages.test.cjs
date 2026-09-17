'use strict'

// Unit tests for materializeInlineImages (#2945).
//
// Imported docx HTML carries its images as data: URIs, which
// sanitizeHTMLForStorage strips. The helper saves each one through
// HAXCMSFile (so it is validated and recorded in files.json) and renders it
// as media-image; anything it cannot save becomes an image place-holder.
// Both write paths, HAXCMSSite.addPage and the createNode route, then
// reference the saved file by its FileEntity uuid in page.metadata.files,
// sourced from the Entity API by the helper rather than a content re-scan.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

// createNode is required before HAXCMS.js on purpose: createNode pulls
// materializeInlineImages at module scope, which HAXCMS.js also does. This
// exercises that module-scope chain and proves materializeInlineImages keeps
// its Entity/FileStorage requires lazy (a module-scope require there would
// cycle back through siteFileUrl -> HAXCMS and break file URLs).
const createNode = require('../../src/siteRoutes/v1/routes/createNode.js')
const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const FileStorage = require('../../src/lib/FileStorage.js')
const FilesDataStore = require('../../src/lib/FilesDataStore.js')
const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const {
  materializeInlineImages,
  fileNameBaseFromPageTitle,
  MAX_INLINE_IMAGE_WIDTH,
  MAX_INLINE_IMAGE_HEIGHT,
} = require('../../src/lib/materializeInlineImages.js')
const sharp = require('sharp')

// a minimal valid 1x1 PNG, as mammoth would hand it over base64 encoded
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_DATA_URI = 'data:image/png;base64,' + PNG_BASE64

// a second, different valid PNG for pages with more than one image
async function otherPngDataUri() {
  const buffer = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  return 'data:image/png;base64,' + buffer.toString('base64')
}

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

// The file entity for a saved path, through the Entity API (#3043).
async function loadFileEntity(site, relativePath) {
  const registry = new EntityRegistry(site)
  FileStorage.registerOn(registry)
  const fileStorage = registry.getStorage('file')
  const uuid = await fileStorage.getDataStore().resolveUuidByPath(relativePath)
  return { uuid: uuid, entity: fileStorage.load(uuid) }
}

// Records page.metadata.files at every manifest save, so a test can check
// the uuid references were persisted rather than only set in memory.
function recordManifestSaves(site) {
  const saves = []
  site.manifest.addItem = function (item) {
    site.manifest.items.push(item)
  }
  site.manifest.save = async function () {
    saves.push(
      site.manifest.items.map(function (item) {
        return item.metadata && item.metadata.files ? item.metadata.files.slice() : []
      }),
    )
    return true
  }
  return saves
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
    const { html: result, uuids } = await materializeInlineImages(
      '<p>Before</p><p><img alt="A red square" src="' + PNG_DATA_URI + '"></p>',
      site,
      { pageTitle: 'Intro to HAX' },
    )
    const files = savedImages(siteDirectory)
    assert.equal(files.length, 1)
    assert.equal(files[0], 'intro-to-hax.jpg', 'png imports convert to jpg named from page title')
    assert.equal(
      result,
      '<p>Before</p><p><media-image source="files/' +
        files[0] +
        '" alt="A red square"></media-image></p>',
    )
    assert.equal(uuids.length, 1)
    // optimized (compressed) bytes may differ from the raw inline payload
    assert.ok(
      fs.statSync(path.join(siteDirectory, 'files', files[0])).size > 0,
      'saved image has bytes on disk',
    )
  })

  test('records the saved file as a file entity', async () => {
    const { uuids } = await materializeInlineImages(
      '<p><img src="' + PNG_DATA_URI + '"></p>',
      site,
    )
    const files = savedImages(siteDirectory)
    const loaded = await loadFileEntity(site, 'files/' + files[0])
    assert.notEqual(loaded.uuid, '')
    assert.ok(loaded.entity, 'files.json has a record for the saved image')
    assert.equal(loaded.entity.get('path'), 'files/' + files[0])
    assert.equal(loaded.entity.getMimetype(), 'image/jpeg')
    assert.ok(/\.jpg$/i.test(files[0]), 'png data URI is stored as jpg')
    assert.ok(loaded.entity.isImage())
    // the uuid the helper returns is the FileEntity uuid (Entity API source of truth)
    assert.deepEqual(uuids, [loaded.uuid])
  })

  test('an image repeated on the page is saved once', async () => {
    const { html: result, uuids } = await materializeInlineImages(
      '<p><img src="' + PNG_DATA_URI + '"></p><p><img src="' + PNG_DATA_URI + '"></p>',
      site,
    )
    const files = savedImages(siteDirectory)
    assert.equal(files.length, 1)
    assert.equal(result.split('source="files/' + files[0] + '"').length - 1, 2)
    assert.equal(uuids.length, 1, 'one uuid despite two tags')
  })

  test('each import keeps its own file when names collide', async () => {
    const first = await materializeInlineImages('<p><img src="' + PNG_DATA_URI + '"></p>', site)
    const second = await materializeInlineImages('<p><img src="' + PNG_DATA_URI + '"></p>', site)
    assert.equal(savedImages(siteDirectory).length, 2)
    assert.notEqual(first.html, second.html, 'the second import points at its own file')
    assert.notEqual(first.uuids[0], second.uuids[0], 'each import has its own uuid')
  })

  test('each saved image is referenced by the uuid files.json holds, even for a reused path', async () => {
    // files.json owns identity (#3043): a record can already exist for the
    // name an import is about to take (a stale or cloned record), so the uuid
    // must be read back from files.json after the save, not assumed
    new FilesDataStore(site).upsertRecord({
      uuid: '11111111-1111-1111-1111-111111111111',
      path: 'files/page_1.jpg',
      name: 'page_1.jpg',
      mimetype: 'image/jpeg',
      size: 1,
    })
    const { html, uuids } = await materializeInlineImages(
      '<p><img src="' + PNG_DATA_URI + '"></p><p><img src="' + (await otherPngDataUri()) + '"></p>',
      site,
    )
    const sources = html.match(/source="[^"]+"/g).map(function (attribute) {
      return attribute.slice('source="'.length, -1)
    })
    assert.deepEqual(sources, ['files/page.jpg', 'files/page_1.jpg'])
    for (let i = 0; i < sources.length; i++) {
      const loaded = await loadFileEntity(site, sources[i])
      assert.equal(uuids[i], loaded.uuid, sources[i] + ' is referenced by the uuid files.json resolves')
    }
  })

  test('keeps files.json records another upload writes while images are saved', async () => {
    const originalSave = HAXCMSFile.prototype.save
    let calls = 0
    HAXCMSFile.prototype.save = async function () {
      const result = await originalSave.apply(this, arguments)
      calls++
      if (calls === 2) {
        // another request uploads a file before this import has finished
        await fs.writeFile(path.join(siteDirectory, 'files', 'other.png'), Buffer.from(PNG_BASE64, 'base64'))
        const other = new FilesDataStore(site)
        other.upsertRecord(await other.buildFileRecordFromDisk('files/other.png'))
      }
      return result
    }
    try {
      await materializeInlineImages(
        '<p><img src="' + PNG_DATA_URI + '"></p><p><img src="' + (await otherPngDataUri()) + '"></p>',
        site,
      )
    } finally {
      HAXCMSFile.prototype.save = originalSave
    }
    assert.equal(calls, 2)
    assert.ok(new FilesDataStore(site).getByPath('files/other.png'), 'the other upload is still recorded')
  })

  test('missing alt becomes an empty alt, and alt text is escaped', async () => {
    const { html: result } = await materializeInlineImages(
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
      const { html: result, uuids } = await materializeInlineImages(
        '<p><img alt="' + entry[1] + '" src="' + entry[0] + '"></p>',
        site,
      )
      assert.equal(
        result,
        '<p><place-holder type="image" text="' + entry[1] + '"></place-holder></p>',
      )
      assert.deepEqual(uuids, [])
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
      const { html: out, uuids } = await materializeInlineImages(html, site)
      assert.equal(out, html)
      assert.deepEqual(uuids, [])
    }
    assert.deepEqual(savedImages(siteDirectory), [])
  })

  test('addPage stores imported images as files and references them by uuid', async () => {
    const saves = recordManifestSaves(site)
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
    const loaded = await loadFileEntity(site, 'files/' + files[0])
    assert.deepEqual(page.metadata.files, [loaded.uuid], 'page references the file by uuid')
    assert.deepEqual(saves[saves.length - 1], [[loaded.uuid]], 'the uuid reference is saved to the manifest')
  })

  describe('createNode', () => {
    let saves

    beforeEach(() => {
      saves = recordManifestSaves(site)
      site.gitCommit = async function () {
        return true
      }
    })

    // Drive the route with the site loaded and the site token accepted
    // (unless options.validToken is false); returns the captured response.
    async function callCreateNode(body, options) {
      const opts = options || {}
      const originals = {
        loadSite: HAXCMS.loadSite,
        validateRequestToken: HAXCMS.validateRequestToken,
      }
      HAXCMS.loadSite = async function () {
        return site
      }
      HAXCMS.validateRequestToken = function () {
        return opts.validToken !== false
      }
      const res = {
        statusCode: 200,
        body: null,
        status: function (code) {
          this.statusCode = code
          return this
        },
        json: function (payload) {
          this.body = payload
          return this
        },
        send: function (payload) {
          this.body = payload
          return this
        },
      }
      try {
        await createNode(
          {
            headers: { 'x-haxcms-site-token': 'site-token' },
            body: Object.assign({ site: { name: 'testsite' } }, body),
          },
          res,
        )
      } finally {
        HAXCMS.loadSite = originals.loadSite
        HAXCMS.validateRequestToken = originals.validateRequestToken
      }
      return res
    }

    function pageContent(page) {
      return fs.readFileSync(path.join(siteDirectory, page.location), 'utf8')
    }

    function pageByTitle(title) {
      return site.manifest.items.find(function (item) {
        return item.title === title
      })
    }

    test('single page from docx: the image is saved and referenced by uuid', async () => {
      const res = await callCreateNode({
        node: {
          title: 'From docx',
          contents: '<p><img alt="A red square" src="' + PNG_DATA_URI + '"></p>',
        },
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      const page = site.loadNode(res.body.data.id)
      const files = savedImages(siteDirectory)
      assert.equal(files.length, 1)
      const content = pageContent(page)
      assert.ok(
        content.indexOf('<media-image source="files/' + files[0] + '" alt="A red square">') !== -1,
        'page renders the saved file as media-image: ' + content,
      )
      assert.equal(content.indexOf('data:image'), -1, 'no data: URI is written to the page')
      const loaded = await loadFileEntity(site, 'files/' + files[0])
      assert.deepEqual(page.metadata.files, [loaded.uuid], 'page references the file by uuid')
      assert.deepEqual(saves[saves.length - 1], [[loaded.uuid]], 'the uuid reference is saved to the manifest')
    })

    test('single page repeating an image saves one file with one uuid reference', async () => {
      const res = await callCreateNode({
        node: {
          title: 'Repeated',
          contents:
            '<p><img alt="first" src="' + PNG_DATA_URI + '"></p><p><img alt="second" src="' + PNG_DATA_URI + '"></p>',
        },
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      const page = site.loadNode(res.body.data.id)
      const files = savedImages(siteDirectory)
      assert.equal(files.length, 1)
      assert.equal(pageContent(page).split('source="files/' + files[0] + '"').length - 1, 2)
      const loaded = await loadFileEntity(site, 'files/' + files[0])
      assert.deepEqual(page.metadata.files, [loaded.uuid])
    })

    test('single page whose images cannot be saved gets placeholders and no file references', async () => {
      const res = await callCreateNode({
        node: {
          title: 'Unsupported',
          contents:
            '<p><img alt="vector chart" src="data:image/x-emf;base64,' +
            Buffer.from('emf').toString('base64') +
            '"></p>',
        },
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      const page = site.loadNode(res.body.data.id)
      assert.deepEqual(savedImages(siteDirectory), [])
      assert.ok(pageContent(page).indexOf('<place-holder type="image" text="vector chart"></place-holder>') !== -1)
      assert.deepEqual(page.metadata.files, [])
      assert.equal(saves.length, 1, 'no extra manifest save when the page references no files')
    })

    test('single page without inline images is written as before', async () => {
      const res = await callCreateNode({
        node: { title: 'Plain', contents: '<p>Just text</p>' },
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      const page = site.loadNode(res.body.data.id)
      assert.equal(pageContent(page), '<p>Just text</p>')
      assert.deepEqual(savedImages(siteDirectory), [])
      assert.equal(saves.length, 1, 'no extra manifest save when the page references no files')
    })

    test('blank page (no contents) saves no files', async () => {
      const res = await callCreateNode({ node: { title: 'Blank' } })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.deepEqual(savedImages(siteDirectory), [])
      assert.equal(saves.length, 1)
    })

    test('outline import (items): only the page with an image references a file', async () => {
      const res = await callCreateNode({
        items: [
          { title: 'With image', slug: 'with-image', contents: '<p><img alt="chart" src="' + PNG_DATA_URI + '"></p>' },
          { title: 'Text only', slug: 'text-only', contents: '<p>No images here</p>' },
        ],
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      const files = savedImages(siteDirectory)
      assert.equal(files.length, 1)
      const loaded = await loadFileEntity(site, 'files/' + files[0])
      const withImage = pageByTitle('With image')
      const textOnly = pageByTitle('Text only')
      assert.ok(pageContent(withImage).indexOf('<media-image source="files/' + files[0] + '" alt="chart">') !== -1)
      assert.deepEqual(withImage.metadata.files, [loaded.uuid])
      assert.deepEqual(textOnly.metadata.files, [])
      assert.deepEqual(saves[saves.length - 1], [[loaded.uuid], []], 'the manifest save carries the uuid reference')
    })

    test('outline import (items): the same image on two pages gives each page its own file', async () => {
      const res = await callCreateNode({
        items: [
          { title: 'First', slug: 'first', contents: '<p><img src="' + PNG_DATA_URI + '"></p>' },
          { title: 'Second', slug: 'second', contents: '<p><img src="' + PNG_DATA_URI + '"></p>' },
        ],
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.equal(savedImages(siteDirectory).length, 2)
      const first = pageByTitle('First')
      const second = pageByTitle('Second')
      assert.equal(first.metadata.files.length, 1)
      assert.equal(second.metadata.files.length, 1)
      assert.notEqual(first.metadata.files[0], second.metadata.files[0])
    })

    test('outline import (items): an item marked for delete is skipped and saves nothing', async () => {
      const res = await callCreateNode({
        items: [
          { title: 'Deleted', slug: 'deleted', delete: true, contents: '<p><img src="' + PNG_DATA_URI + '"></p>' },
        ],
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.equal(site.manifest.items.length, 0)
      assert.deepEqual(savedImages(siteDirectory), [])
    })

    test('duplicating a page copies its content without saving images', async () => {
      await fs.outputFile(
        path.join(siteDirectory, 'pages', 'source', 'index.html'),
        '<p><img alt="legacy" src="' + PNG_DATA_URI + '"></p>',
      )
      site.manifest.items.push({ id: 'source', title: 'Source', location: 'pages/source/index.html', metadata: {} })
      const res = await callCreateNode({ node: { title: 'Copy', duplicate: 'source' } })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.deepEqual(savedImages(siteDirectory), [])
      assert.equal(pageContent(site.loadNode(res.body.data.id)).indexOf('media-image'), -1)
    })

    test('an invalid site token is rejected before any image is saved', async () => {
      const res = await callCreateNode(
        { node: { title: 'Rejected', contents: '<p><img src="' + PNG_DATA_URI + '"></p>' } },
        { validToken: false },
      )
      assert.equal(res.statusCode, 403)
      assert.equal(site.manifest.items.length, 0)
      assert.deepEqual(savedImages(siteDirectory), [])
    })

    test('a site with adding pages disabled saves no images', async () => {
      site.manifest.metadata.platform = { addPage: false }
      const res = await callCreateNode({
        node: { title: 'Disabled', contents: '<p><img src="' + PNG_DATA_URI + '"></p>' },
      })
      assert.equal(res.statusCode, 403)
      assert.equal(site.manifest.items.length, 0)
      assert.deepEqual(savedImages(siteDirectory), [])
    })
  })

  test('non-string content is returned as it came in', async () => {
    const u = await materializeInlineImages(undefined, site)
    assert.equal(u.html, undefined)
    assert.deepEqual(u.uuids, [])
    const n = await materializeInlineImages(null, site)
    assert.equal(n.html, null)
    assert.deepEqual(n.uuids, [])
  })

  test('fileNameBaseFromPageTitle cleans titles for filesystem use', () => {
    assert.equal(fileNameBaseFromPageTitle('Intro to HAX'), 'intro-to-hax')
    assert.equal(fileNameBaseFromPageTitle('  Hello, World!  '), 'hello-world')
    assert.equal(fileNameBaseFromPageTitle(''), 'page')
    assert.equal(fileNameBaseFromPageTitle(null), 'page')
  })

  test('oversized inline images are resized to the largest recommended preset', async () => {
    const big = await sharp({
      create: {
        width: 2400,
        height: 1800,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer()
    const dataUri = 'data:image/png;base64,' + big.toString('base64')
    await materializeInlineImages('<p><img src="' + dataUri + '"></p>', site, {
      pageTitle: 'Wide Diagram',
    })
    const files = savedImages(siteDirectory)
    assert.equal(files.length, 1)
    assert.equal(files[0], 'wide-diagram.jpg', 'oversized png becomes sized jpg')
    const meta = await sharp(fs.readFileSync(path.join(siteDirectory, 'files', files[0]))).metadata()
    assert.equal(meta.format, 'jpeg')
    assert.ok(meta.width <= MAX_INLINE_IMAGE_WIDTH, 'width capped at xl preset')
    assert.ok(meta.height <= MAX_INLINE_IMAGE_HEIGHT, 'height capped at xl preset')
  })

  test('png and webp imports are converted to jpg', async () => {
    const webp = await sharp({
      create: { width: 30, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .webp()
      .toBuffer()
    const webpUri = 'data:image/webp;base64,' + webp.toString('base64')
    await materializeInlineImages(
      '<p><img src="' + PNG_DATA_URI + '"></p><p><img src="' + webpUri + '"></p>',
      site,
      { pageTitle: 'Mixed Formats' },
    )
    const files = savedImages(siteDirectory).sort()
    assert.equal(files.length, 2)
    assert.ok(files.every(function (name) {
      return /\.jpg$/i.test(name)
    }), 'all non-jpg sources land as jpg: ' + files.join(','))
    for (let i = 0; i < files.length; i++) {
      const meta = await sharp(fs.readFileSync(path.join(siteDirectory, 'files', files[i]))).metadata()
      assert.equal(meta.format, 'jpeg')
    }
  })
})
