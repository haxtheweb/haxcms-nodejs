'use strict'

// Unit tests for the pure module-scope helper functions attached as named
// properties on the siteSearch handler export (siteSearch.<helperName>).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const { describe } = require('node:test')
const assert = require('node:assert/strict')

const siteSearch = require('../../src/siteRoutes/v1/routes/siteSearch.js')

const {
  countTextMatches,
  replaceTextMatches,
  parseLimitValue,
  normalizeSearchFields,
  normalizeTagsValue,
  normalizeFieldValue,
  normalizeOperationValue,
  buildTextMatcher,
  parseSimpleSelectorPart,
  parseSimpleSelector,
  selectorMatchesInContent,
  buildSearchResponse,
} = siteSearch

describe('siteSearch.countTextMatches', () => {
  test('counts non-overlapping occurrences, case-insensitive by default', () => {
    assert.equal(countTextMatches('foo FOO foo', 'foo'), 3)
  })

  test('respects case sensitivity when requested', () => {
    assert.equal(countTextMatches('foo FOO foo', 'foo', true), 2)
  })

  test('returns 0 for empty/invalid value or search term', () => {
    assert.equal(countTextMatches('', 'foo'), 0)
    assert.equal(countTextMatches('foo', ''), 0)
    assert.equal(countTextMatches(null, 'foo'), 0)
    assert.equal(countTextMatches('foo', null), 0)
  })

  test('returns 0 when there is no match', () => {
    assert.equal(countTextMatches('bar baz', 'foo'), 0)
  })
})

describe('siteSearch.replaceTextMatches', () => {
  test('replaces all case-insensitive matches and reports the total', () => {
    const result = replaceTextMatches('foo FOO foo', 'foo', 'bar')
    assert.equal(result.content, 'bar bar bar')
    assert.equal(result.total, 3)
  })

  test('replaces only case-sensitive matches when requested', () => {
    const result = replaceTextMatches('foo FOO foo', 'foo', 'bar', true)
    assert.equal(result.content, 'bar FOO bar')
    assert.equal(result.total, 2)
  })

  test('returns the original content with total 0 for an empty search term', () => {
    const result = replaceTextMatches('hello', '')
    assert.equal(result.content, 'hello')
    assert.equal(result.total, 0)
  })

  test('returns empty content with total 0 for an empty value', () => {
    const result = replaceTextMatches('', 'foo')
    assert.equal(result.content, '')
    assert.equal(result.total, 0)
  })

  test('supports removing matches (replacement is empty string)', () => {
    const result = replaceTextMatches('a-x-b-x-c', 'x', '')
    assert.equal(result.content, 'a--b--c')
    assert.equal(result.total, 2)
  })
})

describe('siteSearch.parseLimitValue', () => {
  test('returns the fallback for undefined, null, or empty string', () => {
    assert.equal(parseLimitValue(undefined), 25)
    assert.equal(parseLimitValue(null), 25)
    assert.equal(parseLimitValue(''), 25)
  })

  test('returns the fallback for a non-numeric value', () => {
    assert.equal(parseLimitValue('abc'), 25)
  })

  test('clamps negative numbers to 0', () => {
    assert.equal(parseLimitValue(-5), 0)
    assert.equal(parseLimitValue('-1'), 0)
  })

  test('treats 0 as a valid explicit value (no limit), not the fallback', () => {
    assert.equal(parseLimitValue(0), 0)
    assert.equal(parseLimitValue('0'), 0)
  })

  test('clamps values above the max limit', () => {
    assert.equal(parseLimitValue(9999), 200)
  })

  test('passes through valid in-range numeric strings', () => {
    assert.equal(parseLimitValue('10'), 10)
    assert.equal(parseLimitValue(50), 50)
  })

  test('supports a custom fallback', () => {
    assert.equal(parseLimitValue(undefined, 5), 5)
  })
})

describe('siteSearch.normalizeSearchFields', () => {
  test('returns the default fields when no value is provided', () => {
    assert.deepEqual(normalizeSearchFields(undefined), ['title', 'slug', 'description', 'tags', 'content'])
    assert.deepEqual(normalizeSearchFields(''), ['title', 'slug', 'description', 'tags', 'content'])
  })

  test('filters out invalid/unknown fields', () => {
    assert.deepEqual(normalizeSearchFields('title,bogus,slug'), ['title', 'slug'])
  })

  test('falls back to defaults when no valid fields remain', () => {
    assert.deepEqual(normalizeSearchFields('bogus,another-bogus'), ['title', 'slug', 'description', 'tags', 'content'])
  })

  test('treats "all" as a shortcut for the default field set', () => {
    assert.deepEqual(normalizeSearchFields('all'), ['title', 'slug', 'description', 'tags', 'content'])
  })

  test('accepts an array input and dedups', () => {
    assert.deepEqual(normalizeSearchFields(['title', 'title', 'id']), ['title', 'id'])
  })

  test('trims and lowercases field names', () => {
    assert.deepEqual(normalizeSearchFields(' TITLE , Slug '), ['title', 'slug'])
  })
})

describe('siteSearch.normalizeTagsValue', () => {
  test('joins array tags with a comma+space', () => {
    assert.equal(normalizeTagsValue({ metadata: { tags: ['a', 'b'] } }), 'a, b')
  })

  test('returns a string tags value as-is', () => {
    assert.equal(normalizeTagsValue({ metadata: { tags: 'a, b' } }), 'a, b')
  })

  test('returns empty string when item, metadata, or tags is missing/null', () => {
    assert.equal(normalizeTagsValue(null), '')
    assert.equal(normalizeTagsValue({}), '')
    assert.equal(normalizeTagsValue({ metadata: {} }), '')
    assert.equal(normalizeTagsValue({ metadata: { tags: null } }), '')
  })

  test('stringifies a non-array, non-string tags value', () => {
    assert.equal(normalizeTagsValue({ metadata: { tags: { a: 1 } } }), JSON.stringify({ a: 1 }))
  })
})

describe('siteSearch.normalizeFieldValue', () => {
  const item = {
    id: 'abc',
    title: 'My Title',
    slug: 'my-title',
    description: 'A description',
    location: 'pages/abc/index.html',
    parent: 'root-id',
    metadata: { tags: ['x', 'y'] },
  }

  test('returns the corresponding field value for known fields', () => {
    assert.equal(normalizeFieldValue('id', item), 'abc')
    assert.equal(normalizeFieldValue('title', item), 'My Title')
    assert.equal(normalizeFieldValue('slug', item), 'my-title')
    assert.equal(normalizeFieldValue('description', item), 'A description')
    assert.equal(normalizeFieldValue('location', item), 'pages/abc/index.html')
    assert.equal(normalizeFieldValue('parent', item), 'root-id')
    assert.equal(normalizeFieldValue('tags', item), 'x, y')
  })

  test('returns the passed-in content for the content field', () => {
    assert.equal(normalizeFieldValue('content', item, '<p>hi</p>'), '<p>hi</p>')
    assert.equal(normalizeFieldValue('content', item, 42), '')
  })

  test('returns empty string for an unknown field', () => {
    assert.equal(normalizeFieldValue('unknown-field', item), '')
  })

  test('returns empty string when item is missing/falsey field values', () => {
    assert.equal(normalizeFieldValue('title', {}), '')
    assert.equal(normalizeFieldValue('id', null), '')
  })
})

describe('siteSearch.normalizeOperationValue', () => {
  test('defaults to "search" for missing/invalid/unknown values', () => {
    assert.equal(normalizeOperationValue(undefined), 'search')
    assert.equal(normalizeOperationValue(null), 'search')
    assert.equal(normalizeOperationValue(''), 'search')
    assert.equal(normalizeOperationValue('bogus'), 'search')
    assert.equal(normalizeOperationValue(42), 'search')
  })

  test('accepts "replace" (case-insensitive, trimmed)', () => {
    assert.equal(normalizeOperationValue('replace'), 'replace')
    assert.equal(normalizeOperationValue(' REPLACE '), 'replace')
  })

  test('accepts "search" explicitly', () => {
    assert.equal(normalizeOperationValue('search'), 'search')
  })
})

describe('siteSearch.buildTextMatcher', () => {
  test('matches case-insensitively by default and extracts a snippet', () => {
    const matcher = buildTextMatcher('world')
    const result = matcher('hello WORLD, this is a test string')
    assert.ok(result)
    assert.equal(result.index, 6)
    assert.equal(result.length, 5)
    assert.ok(result.snippet.indexOf('WORLD') !== -1)
  })

  test('matches case-sensitively when requested', () => {
    const matcher = buildTextMatcher('World', true)
    assert.equal(matcher('hello world'), null)
    const result = matcher('hello World')
    assert.ok(result)
    assert.equal(result.index, 6)
  })

  test('returns null for non-string or empty value', () => {
    const matcher = buildTextMatcher('foo')
    assert.equal(matcher(null), null)
    assert.equal(matcher(''), null)
    assert.equal(matcher(42), null)
  })

  test('returns null when there is no match', () => {
    const matcher = buildTextMatcher('nomatch')
    assert.equal(matcher('some other content'), null)
  })
})

describe('siteSearch.parseSimpleSelectorPart', () => {
  test('parses a tag-only selector', () => {
    const result = parseSimpleSelectorPart('div')
    assert.equal(result.valid, true)
    assert.equal(result.selector, 'div')
  })

  test('parses an attribute-only selector', () => {
    const result = parseSimpleSelectorPart('[data-foo]')
    assert.equal(result.valid, true)
    assert.equal(result.selector, '[data-foo]')
  })

  test('parses a tag with an attribute=value selector', () => {
    const result = parseSimpleSelectorPart('a[href="/foo"]')
    assert.equal(result.valid, true)
    assert.equal(result.selector, 'a[href="/foo"]')
  })

  test('rejects complex combinator selectors', () => {
    assert.equal(parseSimpleSelectorPart('div > p').valid, false)
    assert.equal(parseSimpleSelectorPart('div + p').valid, false)
    assert.equal(parseSimpleSelectorPart('div ~ p').valid, false)
    assert.equal(parseSimpleSelectorPart('div:hover').valid, false)
  })

  test('rejects an empty selector', () => {
    assert.equal(parseSimpleSelectorPart('').valid, false)
    assert.equal(parseSimpleSelectorPart('   ').valid, false)
  })

  test('rejects malformed selector syntax', () => {
    assert.equal(parseSimpleSelectorPart('[[[').valid, false)
  })
})

describe('siteSearch.parseSimpleSelector', () => {
  test('parses a single simple selector', () => {
    const result = parseSimpleSelector('div')
    assert.equal(result.valid, true)
    assert.equal(result.selector, 'div')
  })

  test('parses a comma-separated selector group', () => {
    const result = parseSimpleSelector('div, p, [data-foo]')
    assert.equal(result.valid, true)
    assert.equal(result.selector, 'div, p, [data-foo]')
  })

  test('rejects an empty selector string', () => {
    assert.equal(parseSimpleSelector('').valid, false)
  })

  test('rejects a selector group containing an empty part', () => {
    assert.equal(parseSimpleSelector('div,, p').valid, false)
  })

  test('propagates invalid-part errors from the group', () => {
    const result = parseSimpleSelector('div, p:hover')
    assert.equal(result.valid, false)
  })
})

describe('siteSearch.selectorMatchesInContent', () => {
  // Note: the implementation wraps content in a `<div id="hax-search-wrapper">`
  // before querying, so a selector of `div` would also match that wrapper.
  // Use `p`/`span` selectors here to test matches against the content only.
  test('returns null when content or selector is missing', () => {
    assert.equal(selectorMatchesInContent('', 'p'), null)
    assert.equal(selectorMatchesInContent('<p></p>', ''), null)
    assert.equal(selectorMatchesInContent(null, 'p'), null)
  })

  test('returns null when the selector matches nothing', () => {
    assert.equal(selectorMatchesInContent('<p>hello</p>', 'span'), null)
  })

  test('returns a count and snippets for matching nodes', () => {
    const result = selectorMatchesInContent('<p>one</p><p>two</p>', 'p')
    assert.ok(result)
    assert.equal(result.count, 2)
    assert.equal(result.snippets.length, 2)
    assert.ok(result.snippets[0].indexOf('one') !== -1)
  })

  test('caps returned snippets at 3 even with more matches', () => {
    const content = '<p>1</p><p>2</p><p>3</p><p>4</p>'
    const result = selectorMatchesInContent(content, 'p')
    assert.equal(result.count, 4)
    assert.equal(result.snippets.length, 3)
  })
})

describe('siteSearch.buildSearchResponse', () => {
  test('builds an empty-matches response with defaults', () => {
    const response = buildSearchResponse()
    assert.equal(response.status, 200)
    assert.deepEqual(response.data.matches, [])
    assert.equal(response.data.total, 0)
    assert.equal(response.data.operation, 'search')
    assert.equal(response.data.mode, 'text')
    assert.equal(response.data.caseSensitive, false)
    assert.equal(response.data.limit, 25)
  })

  test('builds a populated response with the correct shape and total', () => {
    const matches = [{ id: 'a' }, { id: 'b' }]
    const response = buildSearchResponse({
      operation: 'search',
      searchTerm: 'foo',
      searchFields: ['title'],
      mode: 'text',
      caseSensitive: true,
      searchLimit: 10,
      matches,
    })
    assert.equal(response.status, 200)
    assert.equal(response.data.query, 'foo')
    assert.deepEqual(response.data.fields, ['title'])
    assert.equal(response.data.caseSensitive, true)
    assert.equal(response.data.limit, 10)
    assert.equal(response.data.total, 2)
    assert.deepEqual(response.data.matches, matches)
  })
})
