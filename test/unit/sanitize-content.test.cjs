'use strict'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const {
  sanitizeHTMLForStorage,
  sanitizeURLValue,
  sanitizeMetadataValue,
  escapeHTMLAttribute,
  escapeXMLValue,
} = require('../../src/lib/sanitizeContent.js')

// The default sandbox DOMPurify+normalizeIframeAttributes applies to every
// kept iframe that has no (or empty/invalid) sandbox attribute. Hand-picked
// known literal, not derived from the module under test.
const DEFAULT_SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-forms'

describe('sanitizeHTMLForStorage — forbidden tags stripped', () => {
  test('script tag and its contents are removed', () => {
    assert.equal(
      sanitizeHTMLForStorage('<script>alert(1)</script><p>hello</p>'),
      '<p>hello</p>',
    )
  })

  test('svg (and any onload handler inside) is removed', () => {
    assert.equal(
      sanitizeHTMLForStorage('<svg onload="alert(1)"><rect/></svg><p>hi</p>'),
      '<p>hi</p>',
    )
  })

  test('meta is removed', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<meta http-equiv="refresh" content="0;url=javascript:alert(1)"><p>hi</p>',
      ),
      '<p>hi</p>',
    )
  })

  test('link is removed', () => {
    assert.equal(
      sanitizeHTMLForStorage('<link rel="stylesheet" href="evil.css"><p>hi</p>'),
      '<p>hi</p>',
    )
  })

  test('style tag is removed', () => {
    assert.equal(
      sanitizeHTMLForStorage('<style>.x{color:red}</style><p>hi</p>'),
      '<p>hi</p>',
    )
  })

  test('base is removed', () => {
    assert.equal(
      sanitizeHTMLForStorage('<base href="javascript:alert(1)"><p>hi</p>'),
      '<p>hi</p>',
    )
  })

  test('frame and frameset are removed', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<frameset><frame src="a.html"></frame></frameset><p>hi</p>',
      ),
      '<p>hi</p>',
    )
  })

  test('applet is removed', () => {
    assert.equal(
      sanitizeHTMLForStorage('<applet code="Evil.class"></applet><p>hi</p>'),
      '<p>hi</p>',
    )
  })
})

describe('sanitizeHTMLForStorage — event-handler and dangerous attributes', () => {
  test('on* event attributes are stripped from kept elements', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<div onclick="alert(1)" onmouseover="x()" onload="y()">hi</div>',
      ),
      '<div>hi</div>',
    )
  })

  test('srcdoc attribute is dropped from iframe (iframe kept, default attrs applied)', () => {
    assert.equal(
      sanitizeHTMLForStorage('<iframe srcdoc="<script>alert(1)</script>"></iframe>'),
      '<iframe loading="lazy" referrerpolicy="no-referrer" sandbox="' +
        DEFAULT_SANDBOX +
        '"></iframe>',
    )
  })

  test('style attribute is dropped from kept elements', () => {
    assert.equal(
      sanitizeHTMLForStorage('<p style="color:red">hi</p>'),
      '<p>hi</p>',
    )
  })
})

describe('sanitizeHTMLForStorage — URL attributes', () => {
  test('javascript: URL is neutralized: href attribute dropped', () => {
    assert.equal(
      sanitizeHTMLForStorage('<a href="javascript:alert(1)">click</a>'),
      '<a>click</a>',
    )
  })

  test('data: URL is neutralized: href attribute dropped', () => {
    assert.equal(
      sanitizeHTMLForStorage('<a href="data:text/plain,hello">x</a>'),
      '<a>x</a>',
    )
  })

  test('http URL is preserved on a link', () => {
    assert.equal(
      sanitizeHTMLForStorage('<a href="http://example.com">x</a>'),
      '<a href="http://example.com">x</a>',
    )
  })

  test('https URL is preserved on a link', () => {
    assert.equal(
      sanitizeHTMLForStorage('<a href="https://example.com">x</a>'),
      '<a href="https://example.com">x</a>',
    )
  })

  test('mailto URL is preserved on a link', () => {
    assert.equal(
      sanitizeHTMLForStorage('<a href="mailto:foo@bar.com">x</a>'),
      '<a href="mailto:foo@bar.com">x</a>',
    )
  })

  test('tel URL is preserved on a link', () => {
    assert.equal(
      sanitizeHTMLForStorage('<a href="tel:+15551234">x</a>'),
      '<a href="tel:+15551234">x</a>',
    )
  })

  test('fragment identifier is preserved', () => {
    assert.equal(
      sanitizeHTMLForStorage('<a href="#section1">x</a>'),
      '<a href="#section1">x</a>',
    )
  })
})

describe('sanitizeHTMLForStorage — iframe sandbox normalization', () => {
  test('missing sandbox receives the default sandbox tokens', () => {
    assert.equal(
      sanitizeHTMLForStorage('<iframe src="https://example.com"></iframe>'),
      '<iframe src="https://example.com" loading="lazy" referrerpolicy="no-referrer" sandbox="' +
        DEFAULT_SANDBOX +
        '"></iframe>',
    )
  })

  test('empty sandbox receives the default sandbox tokens', () => {
    assert.equal(
      sanitizeHTMLForStorage('<iframe sandbox=""></iframe>'),
      '<iframe sandbox="' +
        DEFAULT_SANDBOX +
        '" loading="lazy" referrerpolicy="no-referrer"></iframe>',
    )
  })

  test('allowed sandbox tokens are kept (deduped, lowercased)', () => {
    assert.equal(
      sanitizeHTMLForStorage('<iframe sandbox="allow-scripts allow-forms"></iframe>'),
      '<iframe sandbox="allow-scripts allow-forms" loading="lazy" referrerpolicy="no-referrer"></iframe>',
    )
  })

  test('disallowed sandbox tokens are dropped, allowed ones kept', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<iframe sandbox="allow-scripts evil-token"></iframe>',
      ),
      '<iframe sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer"></iframe>',
    )
  })

  test('duplicate sandbox tokens are collapsed to one', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<iframe sandbox="allow-scripts allow-scripts"></iframe>',
      ),
      '<iframe sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer"></iframe>',
    )
  })
})

describe('sanitizeHTMLForStorage — referrerpolicy normalization', () => {
  test('invalid referrerpolicy is normalized to no-referrer', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<iframe src="https://example.com" referrerpolicy="bogus"></iframe>',
      ),
      '<iframe src="https://example.com" referrerpolicy="no-referrer" loading="lazy" sandbox="' +
        DEFAULT_SANDBOX +
        '"></iframe>',
    )
  })

  test('missing referrerpolicy defaults to no-referrer', () => {
    assert.equal(
      sanitizeHTMLForStorage('<iframe sandbox="allow-scripts"></iframe>'),
      '<iframe sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer"></iframe>',
    )
  })

  test('valid referrerpolicy is preserved (lowercased)', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<iframe src="https://example.com" referrerpolicy="origin"></iframe>',
      ),
      '<iframe src="https://example.com" referrerpolicy="origin" loading="lazy" sandbox="' +
        DEFAULT_SANDBOX +
        '"></iframe>',
    )
  })

  test('uppercase referrerpolicy is lowercased to the canonical value', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<iframe src="https://example.com" referrerpolicy="ORIGIN"></iframe>',
      ),
      '<iframe src="https://example.com" referrerpolicy="origin" loading="lazy" sandbox="' +
        DEFAULT_SANDBOX +
        '"></iframe>',
    )
  })
})

describe('sanitizeHTMLForStorage — template text inside host elements', () => {
  test('template markup inside code-sample is escaped to inert text', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<code-sample><template><script>alert(1)</script></template></code-sample>',
      ),
      '<code-sample><template>&lt;script&gt;alert(1)&lt;/script&gt;</template></code-sample>',
    )
  })

  test('template markup inside runkit-embed is escaped to inert text', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<runkit-embed><template><img src=x onerror=alert(1)></template></runkit-embed>',
      ),
      '<runkit-embed><template>&lt;img src="x" onerror="alert(1)"&gt;</template></runkit-embed>',
    )
  })

  test('template markup inside web-container is escaped to inert text', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<web-container><template><div>hi</div></template></web-container>',
      ),
      '<web-container><template>&lt;div&gt;hi&lt;/div&gt;</template></web-container>',
    )
  })

  test('template NOT inside a host is sanitized (script removed), not escaped', () => {
    assert.equal(
      sanitizeHTMLForStorage(
        '<div><template><script>alert(1)</script></template></div>',
      ),
      '<div><template></template></div>',
    )
  })
})

describe('sanitizeHTMLForStorage — input handling', () => {
  test('non-string input returns empty string', () => {
    assert.equal(sanitizeHTMLForStorage(null), '')
    assert.equal(sanitizeHTMLForStorage(undefined), '')
    assert.equal(sanitizeHTMLForStorage(123), '')
    assert.equal(sanitizeHTMLForStorage({}), '')
  })
})

describe('sanitizeURLValue', () => {
  test('null and undefined return the fallback (default empty)', () => {
    assert.equal(sanitizeURLValue(null), '')
    assert.equal(sanitizeURLValue(undefined), '')
  })

  test('empty or whitespace-only returns the fallback', () => {
    assert.equal(sanitizeURLValue(''), '')
    assert.equal(sanitizeURLValue('   '), '')
  })

  test('a custom fallback is returned for rejected values', () => {
    assert.equal(
      sanitizeURLValue('javascript:alert(1)', 'about:blank'),
      'about:blank',
    )
  })

  test('fragment identifier is preserved verbatim', () => {
    assert.equal(sanitizeURLValue('#section1'), '#section1')
  })

  test('fragment identifier with surrounding whitespace is trimmed then preserved', () => {
    assert.equal(sanitizeURLValue('  #section1  '), '#section1')
  })

  test('http URL is preserved', () => {
    assert.equal(sanitizeURLValue('http://example.com'), 'http://example.com')
  })

  test('https URL is preserved', () => {
    assert.equal(sanitizeURLValue('https://example.com'), 'https://example.com')
  })

  test('mailto URL is preserved', () => {
    assert.equal(sanitizeURLValue('mailto:foo@bar.com'), 'mailto:foo@bar.com')
  })

  test('tel URL is preserved', () => {
    assert.equal(sanitizeURLValue('tel:+15551234'), 'tel:+15551234')
  })

  test('javascript: URL is neutralized to empty', () => {
    assert.equal(sanitizeURLValue('javascript:alert(1)'), '')
  })

  test('javascript: URL disguised with a space is neutralized to empty', () => {
    assert.equal(sanitizeURLValue('java script:alert(1)'), '')
  })

  test('javascript: URL disguised with a tab is neutralized to empty', () => {
    assert.equal(sanitizeURLValue('java\tscript:alert(1)'), '')
  })

  test('data: URL is neutralized to empty', () => {
    assert.equal(sanitizeURLValue('data:text/plain,hello'), '')
  })

  test('ftp URL is neutralized to empty (protocol not allow-listed)', () => {
    assert.equal(sanitizeURLValue('ftp://foo'), '')
  })

  test('relative URL with no protocol is preserved', () => {
    assert.equal(sanitizeURLValue('/path/to/page'), '/path/to/page')
  })

  test('bare hostname with no protocol is preserved', () => {
    assert.equal(sanitizeURLValue('example.com'), 'example.com')
  })
})

describe('sanitizeMetadataValue', () => {
  test('null and undefined return empty string', () => {
    assert.equal(sanitizeMetadataValue(null), '')
    assert.equal(sanitizeMetadataValue(undefined), '')
  })

  test('HTML-attribute-escapes the value', () => {
    assert.equal(
      sanitizeMetadataValue('a<b>"c\'d'),
      'a&lt;b&gt;&quot;c&#039;d',
    )
  })
})

describe('escapeHTMLAttribute', () => {
  test('escapes &, <, >, ", and \\\' (apostrophe as &#039;)', () => {
    assert.equal(
      escapeHTMLAttribute('a&b<c>d"e\'f'),
      'a&amp;b&lt;c&gt;d&quot;e&#039;f',
    )
  })

  test('ampersand is escaped first so it never double-escapes inserted entities', () => {
    assert.equal(escapeHTMLAttribute('<&>'), '&lt;&amp;&gt;')
  })

  test('null and undefined return empty string', () => {
    assert.equal(escapeHTMLAttribute(null), '')
    assert.equal(escapeHTMLAttribute(undefined), '')
  })
})

describe('escapeXMLValue', () => {
  test('escapes &, <, >, ", and \\\' (apostrophe as &apos;)', () => {
    assert.equal(
      escapeXMLValue('a&b<c>d"e\'f'),
      'a&amp;b&lt;c&gt;d&quot;e&apos;f',
    )
  })

  test('XML uses &apos; for apostrophe while HTML uses &#039;', () => {
    assert.equal(escapeXMLValue("it's"), "it&apos;s")
    assert.equal(escapeHTMLAttribute("it's"), "it&#039;s")
  })

  test('null and undefined return empty string', () => {
    assert.equal(escapeXMLValue(null), '')
    assert.equal(escapeXMLValue(undefined), '')
  })
})
