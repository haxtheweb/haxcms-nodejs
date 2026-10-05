'use strict'

// Unit tests for convertPptxToDeck (src/lib/pptxDeckHelper.js): extension /
// empty / ZIP-signature validation, and the happy path running the REAL
// pptx-in-html-out converter against a minimal-but-real .pptx built at
// runtime with JSZip (same fixture approach as pptx-in-html-out.test.cjs),
// including a picture relationship so media extraction, the slide html
// rewrite from files/pptx-media/ to files/decks/<name>/, deck.json writing,
// and the per-site FilesDataStore registration all run for real against a
// temp site directory.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')

const { convertPptxToDeck } = require('../../src/lib/pptxDeckHelper.js')

// 1x1 transparent PNG so extracted media registers with real image metadata
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`

// slide with a title, body text, and a picture bound to rId2 (the media)
function slideXml(titleText, bodyText) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:txBody>
          <a:p><a:r><a:t>${titleText}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:nvPr/>
        </p:nvSpPr>
        <p:txBody>
          <a:p><a:r><a:t>${bodyText}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:pic>
        <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
        <p:spPr/>
      </p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`
}

const SLIDE_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`

const PRESENTATION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rIdSlide1"/></p:sldIdLst>
</p:presentation>`

async function buildPptxBuffer() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML)
  zip.folder('_rels').file('.rels', ROOT_RELS_XML)
  zip.folder('ppt').file('presentation.xml', PRESENTATION_XML)
  zip.folder('ppt/slides').file('slide1.xml', slideXml('Sample Deck Title', 'Sample deck body'))
  zip.folder('ppt/slides/_rels').file('slide1.xml.rels', SLIDE_RELS_XML)
  zip.folder('ppt/media').file('image1.png', PNG_1X1)
  return zip.generateAsync({ type: 'nodebuffer' })
}

let tmpDir
let site
let pptxPath

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-deck-'))
  fs.ensureDirSync(path.join(tmpDir, 'files'))
  // minimal site stand-in: the deck helper only needs siteDirectory (+ name
  // for the FilesDataStore deterministic uuid identity)
  site = { siteDirectory: tmpDir, name: 'deck-test-site' }
  pptxPath = path.join(tmpDir, 'files', 'my-deck.pptx')
  fs.writeFileSync(pptxPath, await buildPptxBuffer())
})

test.after(() => {
  fs.removeSync(tmpDir)
})

test('rejects a non-pptx normalized path with a 400', async () => {
  await assert.rejects(
    () => convertPptxToDeck(site, pptxPath, 'files/my-deck.txt'),
    (error) => {
      assert.equal(error.message, 'File must have a .pptx extension')
      assert.equal(error.status, 400)
      return true
    },
  )
})

test('rejects an empty pptx file with a 400', async () => {
  const emptyPath = path.join(tmpDir, 'files', 'empty.pptx')
  fs.writeFileSync(emptyPath, Buffer.alloc(0))
  await assert.rejects(
    () => convertPptxToDeck(site, emptyPath, 'files/empty.pptx'),
    (error) => {
      assert.equal(error.message, 'PPTX file is empty')
      assert.equal(error.status, 400)
      return true
    },
  )
})

test('rejects a file without the ZIP signature with a 400', async () => {
  const fakePath = path.join(tmpDir, 'files', 'fake.pptx')
  fs.writeFileSync(fakePath, 'plainly not a zip archive')
  await assert.rejects(
    () => convertPptxToDeck(site, fakePath, 'files/fake.pptx'),
    (error) => {
      assert.equal(error.message, 'File is not a valid .pptx (missing ZIP signature)')
      assert.equal(error.status, 400)
      return true
    },
  )
})

test('rejects a basename that sanitizes to an empty deck name', async () => {
  // '.pptx' sanitizes to an empty deck name after the extension strip
  await assert.rejects(
    () => convertPptxToDeck(site, pptxPath, 'files/.pptx'),
    (error) => {
      assert.equal(error.message, 'Unable to derive a deck name from the file name')
      assert.equal(error.status, 400)
      return true
    },
  )
})

test('converts a pptx into a deck folder, manifest, and datastore records', async () => {
  const result = await convertPptxToDeck(site, pptxPath, 'files/my-deck.pptx')

  assert.equal(result.commitMessage, 'PPTX converted to deck: files/my-deck.pptx')
  assert.equal(result.data.operation, 'convert-pptx-deck')
  assert.equal(result.data.deckPath, 'files/decks/my-deck/deck.json')
  assert.equal(result.data.embedHtml, '<slide-deck source="files/decks/my-deck/deck.json"></slide-deck>')

  // deck.json was written with the manifest contract
  const deckDir = path.join(tmpDir, 'files', 'decks', 'my-deck')
  assert.ok(fs.existsSync(path.join(deckDir, 'deck.json')), 'deck.json written')
  const manifest = JSON.parse(fs.readFileSync(path.join(deckDir, 'deck.json'), 'utf8'))
  assert.equal(manifest.title, 'my-deck')
  assert.equal(manifest.source, 'my-deck.pptx')
  assert.equal(manifest.pptx, 'files/my-deck.pptx')
  assert.equal(manifest.slides.length, 1)
  assert.equal(manifest.slides[0].title, 'Sample Deck Title')
  // the media src was rewritten from files/pptx-media/ to the deck folder
  assert.ok(
    manifest.slides[0].html.indexOf('src="files/decks/my-deck/slide-1-image-1.png"') !== -1,
    'slide image src rewritten to the deck folder',
  )
  assert.equal(manifest.slides[0].html.indexOf('files/pptx-media/'), -1, 'no pptx-media refs remain')

  // extracted media was written to the deck folder verbatim
  const mediaPath = path.join(deckDir, 'slide-1-image-1.png')
  assert.ok(fs.existsSync(mediaPath), 'extracted media written')
  assert.deepEqual(fs.readFileSync(mediaPath), PNG_1X1)

  // the deck + media registered into the per-site files.json datastore
  const filesJsonPath = path.join(tmpDir, 'files', 'files.json')
  assert.ok(fs.existsSync(filesJsonPath), 'files.json persisted')
  const envelope = JSON.parse(fs.readFileSync(filesJsonPath, 'utf8'))
  const registeredPaths = envelope.data.files.map((record) => record.path).sort()
  assert.deepEqual(registeredPaths, [
    'files/decks/my-deck/deck.json',
    'files/decks/my-deck/slide-1-image-1.png',
  ])
})

test('re-converting the same file uniquifies the deck folder name', async () => {
  // fresh deck name so this test does not collide with earlier conversions
  const repeatPath = path.join(tmpDir, 'files', 'repeat-deck.pptx')
  fs.writeFileSync(repeatPath, await buildPptxBuffer())
  const first = await convertPptxToDeck(site, repeatPath, 'files/repeat-deck.pptx')
  assert.equal(first.data.deckPath, 'files/decks/repeat-deck/deck.json')
  const second = await convertPptxToDeck(site, repeatPath, 'files/repeat-deck.pptx')
  // the first deck folder exists, so the second gets a -1 suffix
  assert.equal(second.data.deckPath, 'files/decks/repeat-deck-1/deck.json')
  assert.ok(fs.existsSync(path.join(tmpDir, 'files', 'decks', 'repeat-deck-1', 'deck.json')))
})

test('deck names sanitize characters outside the allowlist', async () => {
  const fancyPath = path.join(tmpDir, 'files', 'Fancy Deck!.pptx')
  fs.writeFileSync(fancyPath, await buildPptxBuffer())
  const result = await convertPptxToDeck(site, fancyPath, 'files/Fancy Deck!.pptx')
  assert.equal(result.data.deckPath, 'files/decks/Fancy-Deck-/deck.json')
})
