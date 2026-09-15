'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { pathToFileURL } = require('url')
const JSZip = require('jszip')

// dynamic import() requires a proper file:// URL on Windows - a raw drive-letter
// path (e.g. "C:\...") throws ERR_UNSUPPORTED_ESM_URL_SCHEME
const CONVERTER_PATH = pathToFileURL(
  path.resolve(
    __dirname,
    '..',
    '..',
    'src',
    'lib',
    'vendor',
    'pptx-in-html-out',
    'src',
    'index.js',
  ),
).href

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`

function slideXml(titleText, bodyText) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
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
    </p:spTree>
  </p:cSld>
</p:sld>`
}

function slideRelsXml(notesTarget) {
  const notesRelationship = notesTarget
    ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="${notesTarget}"/>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  ${notesRelationship}
</Relationships>`
}

function notesSlideXml(notesText) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr>
          <p:nvPr><p:ph type="sldImg"/></p:nvPr>
        </p:nvSpPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:nvPr><p:ph type="body"/></p:nvPr>
        </p:nvSpPr>
        <p:txBody>
          <a:p><a:r><a:t>${notesText}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`
}

function presentationXml(slideCount) {
  const sldIds = []
  for (let i = 1; i <= slideCount; i += 1) {
    sldIds.push(`<p:sldId id="${255 + i}" r:id="rIdSlide${i}"/>`)
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${sldIds.join('')}</p:sldIdLst>
</p:presentation>`
}

// builds a minimal-but-real .pptx with `slideCount` slides. Slide 1 gets real
// title/body text and (if withNotes) a linked notes slide with real notes
// text; every other slide is bare (empty title/body) since the ordering test
// only cares about file processing order, not content.
async function buildPptxBuffer({ slideCount = 1, withNotes = false } = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML)
  zip.folder('_rels').file('.rels', ROOT_RELS_XML)
  zip.folder('ppt').file('presentation.xml', presentationXml(slideCount))

  for (let i = 1; i <= slideCount; i += 1) {
    const isFirstSlide = i === 1
    const titleText = isFirstSlide ? 'Sample Title' : `Slide ${i}`
    const bodyText = isFirstSlide ? 'Sample body text' : ''
    zip.folder('ppt/slides').file(`slide${i}.xml`, slideXml(titleText, bodyText))
    const notesTarget = isFirstSlide && withNotes ? '../notesSlides/notesSlide1.xml' : null
    zip.folder('ppt/slides/_rels').file(`slide${i}.xml.rels`, slideRelsXml(notesTarget))
  }

  if (withNotes) {
    zip.folder('ppt/notesSlides').file('notesSlide1.xml', notesSlideXml('These are the speaker notes.'))
  }

  return zip.generateAsync({ type: 'nodebuffer' })
}

test('toDeckManifest() extracts speaker notes when a notesSlide relationship exists', async () => {
  const { PPTXInHTMLOut } = await import(CONVERTER_PATH)
  const buffer = await buildPptxBuffer({ slideCount: 1, withNotes: true })
  const converter = new PPTXInHTMLOut(buffer)
  const manifest = await converter.toDeckManifest()

  assert.equal(manifest.slides.length, 1)
  assert.equal(manifest.slides[0].notes, 'These are the speaker notes.')
  assert.equal(manifest.slides[0].title, 'Sample Title')
  assert.ok(manifest.slides[0].html.indexOf('Sample body text') !== -1)
})

test('toDeckManifest() returns empty notes for a slide with no notesSlide relationship', async () => {
  const { PPTXInHTMLOut } = await import(CONVERTER_PATH)
  const buffer = await buildPptxBuffer({ slideCount: 1, withNotes: false })
  const converter = new PPTXInHTMLOut(buffer)
  const manifest = await converter.toDeckManifest()

  assert.equal(manifest.slides.length, 1)
  assert.equal(manifest.slides[0].notes, '')
})

test('getSlideNotesText() returns empty string for a slide number that does not exist', async () => {
  const { PPTXInHTMLOut } = await import(CONVERTER_PATH)
  const buffer = await buildPptxBuffer({ slideCount: 1, withNotes: true })
  const converter = new PPTXInHTMLOut(buffer)
  await converter.initialize()
  const notes = await converter.getSlideNotesText('ppt/slides/slide99.xml')
  assert.equal(notes, '')
})

test('parseSlides() orders slides numerically, not lexicographically, past 9 slides', async () => {
  const { PPTXInHTMLOut } = await import(CONVERTER_PATH)
  // 11 slides is enough to prove the fix: a lexicographic string sort would
  // place "slide10.xml" and "slide11.xml" immediately after "slide1.xml",
  // before "slide2.xml" - reproducing the exact bug found against a real
  // 34-slide deck (Waypoint-Presentation-v2.pptx) during manual verification.
  const buffer = await buildPptxBuffer({ slideCount: 11, withNotes: false })
  const converter = new PPTXInHTMLOut(buffer)
  await converter.initialize()
  const slides = await converter.parseSlides()
  const order = slides.map((slide) => converter.getSlideNumber(slide.file))
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('toDeckManifest() preserves numeric slide order end to end', async () => {
  const { PPTXInHTMLOut } = await import(CONVERTER_PATH)
  const buffer = await buildPptxBuffer({ slideCount: 11, withNotes: false })
  const converter = new PPTXInHTMLOut(buffer)
  const manifest = await converter.toDeckManifest()
  const numbers = manifest.slides.map((slide) => slide.number)
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})
