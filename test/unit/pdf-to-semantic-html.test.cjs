'use strict'

// Unit tests for convertPdfBufferToHtml (pdfToSemanticHtml.js): runs the real
// unpdf/pdf.js parser against a minimal-but-valid PDF generated at runtime
// (matching the pptx-in-html-out.test.cjs approach of building real binary
// fixtures instead of mocking the parser), then verifies the text-layer
// normalization (y-row grouping, gap insertion), font-size stats (body vs
// heading tiers), heading detection, list detection (bulleted + ordered),
// paragraph merging, and html escaping.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const { convertPdfBufferToHtml } = require('../../src/lib/pdfToSemanticHtml.js')

// Build a single- or multi-page PDF from text draws ({ size, x, y, text }).
// The xref offsets are computed byte-exact so pdf.js parses it without
// rebuilding the cross-reference table.
function buildPdfBuffer(pageDraws) {
  const drawsByPage = Array.isArray(pageDraws[0]) ? pageDraws : [pageDraws]
  function pdfString(text) {
    return text.replace(/[()\\]/g, (ch) => '\\' + ch)
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' +
      drawsByPage.map((page, i) => `${4 + i * 2} 0 R`).join(' ') +
      `] /Count ${drawsByPage.length} >>`,
  ]
  drawsByPage.forEach((draws, i) => {
    let content = ''
    draws.forEach((draw) => {
      content += `BT\n/F1 ${draw.size} Tf\n${draw.x} ${draw.y} Td\n(${pdfString(draw.text)}) Tj\nET\n`
    })
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    )
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  })
  objects.splice(2, 0, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((obj, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefOffset = pdf.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((offset) => {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += xref
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// Text layout exercising every semantic tier: h1/h2/h3 heading sizes (24/18/14
// vs the 12pt body), paragraph splitting + merging, html escaping, bulleted
// and ordered lists, list type switching, and an intra-row x-gap.
const SEMANTIC_DRAWS = [
  { size: 24, x: 72, y: 720, text: 'Big Heading' },
  { size: 18, x: 72, y: 680, text: 'Section Heading' },
  { size: 14, x: 72, y: 640, text: 'Sub Heading' },
  { size: 12, x: 72, y: 600, text: 'Body text sentence one.' },
  { size: 12, x: 72, y: 580, text: 'Continues with more' },
  { size: 12, x: 72, y: 560, text: 'merged into one.' },
  { size: 12, x: 72, y: 540, text: 'Ampersand & and less < than' },
  { size: 12, x: 72, y: 520, text: '- bullet one' },
  { size: 12, x: 72, y: 500, text: '- bullet two' },
  { size: 12, x: 72, y: 480, text: '2. ordered item' },
  { size: 12, x: 72, y: 460, text: '1) paren item' },
  { size: 24, x: 72, y: 420, text: 'Final Heading' },
  { size: 12, x: 72, y: 380, text: 'Left part' },
  { size: 12, x: 300, y: 380, text: 'right part' },
]

test('converts a single page into tiered headings, paragraphs, lists, and escapes html', async () => {
  const html = await convertPdfBufferToHtml(buildPdfBuffer(SEMANTIC_DRAWS))
  // the exact part sequence is deterministic for this fixture
  assert.deepEqual(html.split('\n'), [
    '<h1>Big Heading</h1>',
    '<h2>Section Heading</h2>',
    '<h3>Sub Heading</h3>',
    '<p>Body text sentence one.</p>',
    // the continuation lines merge into one paragraph until sentence end
    '<p>Continues with more merged into one.</p>',
    '<p>Ampersand &amp; and less &lt; than</p>',
    '<ul>',
    '<li>bullet one</li>',
    '<li>bullet two</li>',
    '</ul>',
    '<ol>',
    '<li>ordered item</li>',
    '<li>paren item</li>',
    '</ol>',
    '<h1>Final Heading</h1>',
    // same-row items with a horizontal gap get a joining space
    '<p>Left part right part</p>',
  ])
})

test('converts multiple pages into one html document', async () => {
  const html = await convertPdfBufferToHtml(
    buildPdfBuffer([
      [
        { size: 24, x: 72, y: 720, text: 'Page One Title' },
        { size: 12, x: 72, y: 680, text: 'First page body.' },
      ],
      [
        { size: 12, x: 72, y: 720, text: 'Second page body.' },
        { size: 12, x: 72, y: 700, text: 'Keeps going' },
      ],
    ]),
  )
  const parts = html.split('\n')
  assert.deepEqual(
    parts.filter((part) => part.indexOf('<h1>') === 0),
    ['<h1>Page One Title</h1>'],
    'page 1 heading detected',
  )
  assert.ok(parts.indexOf('<p>First page body.</p>') !== -1, 'page 1 paragraph present')
  // paragraph merging is per page, so page 2 emits its own paragraphs
  assert.ok(parts.indexOf('<p>Second page body.</p>') !== -1, 'page 2 paragraph present')
  assert.ok(parts.indexOf('<p>Keeps going</p>') !== -1, 'page 2 second paragraph present')
  assert.ok(
    parts.indexOf('<p>First page body.</p>') < parts.indexOf('<p>Second page body.</p>'),
    'page order preserved in the output',
  )
})

test('a PDF with no text layer converts to an empty paragraph', async () => {
  const html = await convertPdfBufferToHtml(buildPdfBuffer([]))
  assert.equal(html, '<p></p>')
})

test('an unparseable buffer rejects with an Unable to parse PDF error', async () => {
  await assert.rejects(
    () => convertPdfBufferToHtml(Buffer.from('this is not a pdf at all')),
    (error) => {
      assert.match(error.message, /Unable to parse PDF:/)
      return true
    },
  )
})
