'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parse } = require('node-html-parser')
const {
  getHighestHeadingLevel,
  processSinglePageContent,
  importSinglePage,
  nextUntilElement,
  getFallbackContent,
} = require('../../src/siteRoutes/v1/site.js')

test('getHighestHeadingLevel returns lowest heading level present', async () => {
  const h1Only = parse('<div><h1>Title</h1><p>Body</p></div>')
  assert.equal(getHighestHeadingLevel(h1Only), 1)

  const h2Only = parse('<div><h2>Title</h2><p>Body</p></div>')
  assert.equal(getHighestHeadingLevel(h2Only), 2)

  const h3Only = parse('<div><h3>Title</h3><p>Body</p></div>')
  assert.equal(getHighestHeadingLevel(h3Only), 3)

  const h4Only = parse('<div><h4>Title</h4><p>Body</p></div>')
  assert.equal(getHighestHeadingLevel(h4Only), 4)

  const h2WithH3 = parse('<div><h2>Title</h2><h3>Sub</h3></div>')
  assert.equal(getHighestHeadingLevel(h2WithH3), 2)

  const h3WithH1 = parse('<div><h3>Sub</h3><h1>Title</h1></div>')
  assert.equal(getHighestHeadingLevel(h3WithH1), 1)

  const noHeadings = parse('<div><p>Body</p></div>')
  assert.equal(getHighestHeadingLevel(noHeadings), null)

  const emptyDoc = parse('<div></div>')
  assert.equal(getHighestHeadingLevel(emptyDoc), null)

  const h5Only = parse('<div><h5>Title</h5></div>')
  assert.equal(getHighestHeadingLevel(h5Only), null)

  const h6Only = parse('<div><h6>Title</h6></div>')
  assert.equal(getHighestHeadingLevel(h6Only), null)
})

test('processSinglePageContent concatenates element node html', async () => {
  const wrapper = parse('<div id="wrap"><p>One</p><h2>Two</h2></div>')
  const el = wrapper.querySelector('#wrap')
  const result = processSinglePageContent(el)
  assert.ok(result.indexOf('<p>One</p>') !== -1)
  assert.ok(result.indexOf('<h2>Two</h2>') !== -1)
})

test('processSinglePageContent falls back to innerHTML when no element children', async () => {
  const wrapper = parse('<div id="wrap">text only</div>')
  const el = wrapper.querySelector('#wrap')
  const result = processSinglePageContent(el)
  assert.equal(result, 'text only')
})

test('processSinglePageContent returns empty paragraph for null input', async () => {
  assert.equal(processSinglePageContent(null), '<p></p>')
})

test('importSinglePage builds an item with required fields', async () => {
  const item = importSinglePage('My Title', '<p>content</p>', 'parent-123')
  assert.equal(item.title, 'My Title')
  assert.equal(item.contents, '<p>content</p>')
  assert.equal(item.parent, 'parent-123')
  assert.equal(item.order, 0)
  assert.ok(item.id && item.id.length > 0)
  assert.ok(item.slug && item.slug.length > 0)
  assert.ok(item.metadata && typeof item.metadata === 'object')
})

test('nextUntilElement collects siblings until a stop tag', async () => {
  const dom = parse('<div><h1>A</h1><p>1</p><p>2</p><h1>B</h1></div>')
  const h1 = dom.querySelector('h1')
  const result = await nextUntilElement(h1, ['H1'])
  assert.equal(result.siblings.length, 2)
  assert.equal(result.siblings[0].tagName, 'P')
  assert.equal(result.siblings[0].innerText, '1')
  assert.equal(result.lastEl.tagName, 'H1')
  assert.equal(result.lastEl.innerText, 'B')
})

test('nextUntilElement stops at first matching tag in list', async () => {
  const dom = parse('<div><h1>A</h1><p>1</p><h2>2</h2><p>3</p></div>')
  const h1 = dom.querySelector('h1')
  const result = await nextUntilElement(h1, ['H1', 'H2'])
  assert.equal(result.siblings.length, 1)
  assert.equal(result.siblings[0].tagName, 'P')
  assert.equal(result.lastEl.tagName, 'H2')
})

test('nextUntilElement returns all siblings when no stop tag found', async () => {
  const dom = parse('<div><h1>A</h1><p>1</p><p>2</p></div>')
  const h1 = dom.querySelector('h1')
  const result = await nextUntilElement(h1, ['H3'])
  assert.equal(result.siblings.length, 2)
  assert.equal(result.lastEl, null)
})

test('getFallbackContent returns expected templates', async () => {
  const portfolio = getFallbackContent('portfolio')
  assert.ok(portfolio.indexOf('lesson-overview') !== -1)
  assert.ok(portfolio.indexOf('pages') !== -1)

  const course = getFallbackContent('course')
  assert.ok(course.indexOf('Welcome to the lesson') !== -1)
  assert.ok(course.indexOf('readTime') !== -1)
  assert.ok(course.indexOf('selfChecks') !== -1)

  const unknown = getFallbackContent('unknown')
  assert.equal(unknown, '<p></p>')
})

test('getHighestHeadingLevel respects level ordering', async () => {
  // h1 appears later in DOM but is still highest priority
  const mixed = parse('<div><h2>First</h2><p>Body</p><h1>Second</h1></div>')
  assert.equal(getHighestHeadingLevel(mixed), 1)
})
