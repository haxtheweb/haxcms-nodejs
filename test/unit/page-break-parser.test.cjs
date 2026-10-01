'use strict'

// Unit tests for HAXCMS.pageBreakParser: the attributes of each page-break
// (title, published, locked...) as saveNode reads them.

const test = require('node:test')
const assert = require('node:assert/strict')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')

function attrsOf(body) {
  const pages = HAXCMS.pageBreakParser(body)
  assert.equal(pages.length, 1)
  return Object.assign({}, pages[0].attributes)
}

test('bare published as the last attribute is expanded', () => {
  const attrs = attrsOf('<page-break title="A" published></page-break><p>x</p>')
  assert.equal(attrs.published, 'published')
  assert.equal(attrs.title, 'A')
})

test('bare published and locked in the middle are expanded', () => {
  const attrs = attrsOf('<page-break published locked title="A"></page-break><p>x</p>')
  assert.equal(attrs.published, 'published')
  assert.equal(attrs.locked, 'locked')
  assert.equal(attrs.title, 'A')
})

test('the words published and locked inside a value are left alone', () => {
  const attrs = attrsOf('<page-break title="Get published fast or locked out" published="published"></page-break><p>x</p>')
  assert.equal(attrs.title, 'Get published fast or locked out')
  assert.equal(attrs.published, 'published')
  assert.equal(Object.prototype.hasOwnProperty.call(attrs, 'fast'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(attrs, 'locked'), false)
})

test('explicit values are unchanged', () => {
  const attrs = attrsOf('<page-break title="A" published="published" locked="locked"></page-break><p>x</p>')
  assert.deepEqual(attrs, { title: 'A', published: 'published', locked: 'locked' })
})

test('whitespace around = keeps an explicit value', () => {
  const attrs = attrsOf('<page-break title="A" published = "" locked = "locked"></page-break><p>x</p>')
  assert.equal(attrs.published, '')
  assert.equal(attrs.locked, 'locked')
})

test('content after the page-break is returned as the page body', () => {
  const pages = HAXCMS.pageBreakParser('<page-break title="A"></page-break><p>Hello</p>')
  assert.equal(pages[0].content, '<p>Hello</p>')
})
