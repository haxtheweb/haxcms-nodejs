'use strict'

// Security (SEC-SANITIZE) regression tests:
//   1. script-capable schemes in custom-element attributes (any name)
//   3. saveOutline / addPage metadata mass-assignment
//   4. revision restore goes through the storage sanitizer
//   5. decode-then-strip for titles / descriptions
//   6. escapeXMLValue drops XML 1.0 illegal characters
// (2, the style guide, is covered in haxcms-site-operations.test.cjs.)
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const {
  sanitizeHTMLForStorage,
  sanitizeAttributeValue,
  sanitizeMetadataValue,
  escapeXMLValue,
} = require('../../src/lib/sanitizeContent.js')
const {
  toPlainText,
  sanitizePageMetadata,
  applyPageMetadata,
} = require('../../src/lib/sanitizePageMetadata.js')
const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const FileContentScanner = require('../../src/lib/FileContentScanner.js')
const saveNode = require('../../src/siteRoutes/v1/routes/saveNode.js')
const saveOutline = require('../../src/siteRoutes/v1/routes/saveOutline.js')
const { restoreItemRevision } = require('../../src/siteRoutes/v1/revisions.js')

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.body = obj
      return this
    },
  }
}

// -------------------------------------------------------------------------
// 1. attribute scheme handling
// -------------------------------------------------------------------------
describe('SEC-SANITIZE: custom element attribute schemes', () => {
  const removed = [
    ['simple-cta link', '<simple-cta link="javascript:alert(1)" label="go"></simple-cta>', 'link'],
    ['pdf-browser-viewer file', '<pdf-browser-viewer file="javascript:alert(1)"></pdf-browser-viewer>', 'file'],
    ['media-image link', '<media-image link="javascript:alert(1)" source="x.png"></media-image>', 'link'],
    ['h5p-element source', '<h5p-element source="javascript:1"></h5p-element>', 'source'],
    ['video-player sources', '<video-player sources="javascript:alert(1)"></video-player>', 'sources'],
    ['video-player tracks', '<video-player tracks="javascript:alert(1)"></video-player>', 'tracks'],
    ['mixed case', '<simple-cta link="JaVaScRiPt:alert(1)"></simple-cta>', 'link'],
    ['tab/newline inside scheme', '<simple-cta link="java\tscr\nipt:alert(1)"></simple-cta>', 'link'],
    ['leading whitespace', '<simple-cta link="   \t javascript:alert(1)"></simple-cta>', 'link'],
    ['numeric entity', '<simple-cta link="&#106;avascript:alert(1)"></simple-cta>', 'link'],
    ['hex entity, no semicolon', '<simple-cta link="&#x6A;avascript&#58alert(1)"></simple-cta>', 'link'],
    ['&colon;', '<simple-cta link="javascript&colon;alert(1)"></simple-cta>', 'link'],
    ['vbscript', '<simple-cta link="vbscript:msgbox(1)"></simple-cta>', 'link'],
    ['mocha', '<simple-cta link="mocha:alert(1)"></simple-cta>', 'link'],
    ['mocha in arbitrary attribute, obfuscated', '<my-element some-prop=" MO&#99;ha&colon;alert(1)"></my-element>', 'some-prop'],
    ['livescript in arbitrary attribute', '<my-element some-prop="livescript:alert(1)"></my-element>', 'some-prop'],
    ['data:text/html', '<simple-cta link="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"></simple-cta>', 'link'],
    // non-URL-named attributes: the script-scheme check applies to every name
    ['arbitrary attribute', '<my-element some-prop="javascript:alert(1)"></my-element>', 'some-prop'],
    ['arbitrary attribute, entity + whitespace', '<my-element some-prop=" j&#x61;vascript&colon;alert(1)"></my-element>', 'some-prop'],
    ['arbitrary attribute, double encoded', '<my-element some-prop="&amp;#106;avascript:alert(1)"></my-element>', 'some-prop'],
    ['arbitrary attribute, data:', '<my-element some-prop="data:text/html;base64,PHNjcmlwdD4="></my-element>', 'some-prop'],
    ['standard element, non-text attribute', '<a data-x="javascript:alert(1)" href="#x">x</a>', 'data-x'],
    ['arbitrary attribute, data:image/svg+xml', '<my-element some-prop="data:image/svg+xml;base64,PHN2Zz4="></my-element>', 'some-prop'],
    ['arbitrary attribute, tab inside scheme', '<my-element some-prop="java\tscript:alert(1)"></my-element>', 'some-prop'],
    ['arbitrary attribute, &#10; before scheme', '<my-element some-prop="&#10;javascript:alert(1)"></my-element>', 'some-prop'],
    ['media-image source, data:image/svg+xml', '<media-image source="data:image/svg+xml;base64,PHN2Zz4="></media-image>', 'source'],
    ['media-image source, data:text/html', '<media-image source="data:text/html,x"></media-image>', 'source'],
  ]
  for (const [name, input, attr] of removed) {
    test('removes ' + name, () => {
      const output = sanitizeHTMLForStorage(input)
      assert.ok(output.indexOf(' ' + attr + '=') === -1, output)
      assert.ok(!/javascript|vbscript|avascript|livescript|mocha|data:/i.test(output), output)
    })
  }

  test('keeps the rest of the element when an attribute is removed', () => {
    const output = sanitizeHTMLForStorage(
      '<media-image link="javascript:alert(1)" source="x.png" alt="cat"></media-image>',
    )
    assert.equal(output, '<media-image source="x.png" alt="cat"></media-image>')
  })

  test('keeps legitimate URLs, anchors and scheme-shaped plain text', () => {
    const input =
      '<simple-cta link="https://example.com/a" label="go"></simple-cta>' +
      '<media-image source="files/x.png" link="#top"></media-image>' +
      '<simple-cta link="mailto:a@example.com"></simple-cta>' +
      '<simple-cta link="tel:+15555550100"></simple-cta>' +
      '<simple-cta link="../relative/page"></simple-cta>' +
      '<simple-icon icon="icons:check" title="Note: hi" label="Chapter 1: Intro" accent-color="blue"></simple-icon>' +
      '<video-player sources=\'[{"src":"a.mp4","type":"video/mp4"}]\'></video-player>' +
      '<p title="Time 10:30">x</p>'
    const output = sanitizeHTMLForStorage(input)
    for (const snippet of [
      'link="https://example.com/a"',
      'source="files/x.png"',
      'link="#top"',
      'link="mailto:a@example.com"',
      'link="tel:+15555550100"',
      'link="../relative/page"',
      'icon="icons:check"',
      'title="Note: hi"',
      'label="Chapter 1: Intro"',
      'accent-color="blue"',
      'sources="[{&quot;src&quot;:&quot;a.mp4&quot;,&quot;type&quot;:&quot;video/mp4&quot;}]"',
      'title="Time 10:30"',
    ]) {
      assert.ok(output.indexOf(snippet) !== -1, snippet + ' missing from ' + output)
    }
  })

  test('text attributes and raster data: URIs survive (as on main)', () => {
    const output = sanitizeHTMLForStorage(
      '<img alt="Data: 2024 results" title="Data: 2024 results" src="files/a.png">' +
        '<media-image alt="JavaScript: the good parts" source="data:image/png;base64,iVBORw0KGgo="></media-image>' +
        '<my-element some-prop="data:image/webp;base64,AAAA" aria-description="javascript: notes" note="Data: 2024 results"></my-element>',
    )
    for (const snippet of [
      'alt="Data: 2024 results"',
      'title="Data: 2024 results"',
      'alt="JavaScript: the good parts"',
      'source="data:image/png;base64,iVBORw0KGgo="',
      'some-prop="data:image/webp;base64,AAAA"',
      'aria-description="javascript: notes"',
      'note="Data: 2024 results"',
    ]) {
      assert.ok(output.indexOf(snippet) !== -1, snippet + ' missing from ' + output)
    }
  })

  test('interior spaces are not removed before scheme detection', () => {
    const output = sanitizeHTMLForStorage('<my-element note="java script: two words"></my-element>')
    assert.equal(output, '<my-element note="java script: two words"></my-element>')
  })

  test('existing src-type attributes still reject data: URIs (unchanged from main)', () => {
    assert.equal(sanitizeHTMLForStorage('<img src="data:image/png;base64,AAAA">'), '<img>')
  })

  test('URL-named custom attributes still use the http/https/mailto/tel allowlist', () => {
    const output = sanitizeHTMLForStorage(
      '<simple-cta link="ftp://example.com/x"></simple-cta><pdf-browser-viewer file="file:///etc/passwd"></pdf-browser-viewer>',
    )
    assert.equal(output, '<simple-cta></simple-cta><pdf-browser-viewer></pdf-browser-viewer>')
  })

  test('empty boolean attributes survive', () => {
    const output = sanitizeHTMLForStorage('<input type="checkbox" correct><my-el hidden-thing=""></my-el>')
    assert.ok(output.indexOf('correct') !== -1, output)
    assert.ok(output.indexOf('hidden-thing') !== -1, output)
  })

  test('sanitizeAttributeValue contract: null means remove', () => {
    assert.equal(sanitizeAttributeValue('title', 'Note: hi'), 'Note: hi')
    assert.equal(sanitizeAttributeValue('icon', 'hax:page-edit'), 'hax:page-edit')
    assert.equal(sanitizeAttributeValue('title', ''), '')
    assert.equal(sanitizeAttributeValue('title', 'javascript:x'), 'javascript:x')
    assert.equal(sanitizeAttributeValue('aria-label', 'javascript:x'), 'javascript:x')
    assert.equal(sanitizeAttributeValue('data-x', 'livescript:x'), null)
    assert.equal(sanitizeAttributeValue('data-x', 'mocha:x'), null)
    assert.equal(sanitizeAttributeValue('data-x', '&#0;javascript:x'), null)
    assert.equal(sanitizeAttributeValue('data-x', 'data:,plain'), 'data:,plain')
    assert.equal(sanitizeAttributeValue('data-x', 'data:text/plain,x'), null)
    assert.equal(sanitizeAttributeValue('source', 'data:image/gif;base64,R0lG'), 'data:image/gif;base64,R0lG')
    assert.equal(sanitizeAttributeValue('src', 'data:image/gif;base64,R0lG'), null)
    assert.equal(sanitizeAttributeValue('link', 'blob:https://x/y'), null)
    assert.equal(sanitizeAttributeValue('link', ''), null)
    // non-script, non-allowlisted scheme in a non-URL attribute is plain text
    assert.equal(sanitizeAttributeValue('data-x', 'blob:https://x/y'), 'blob:https://x/y')
  })
})

// -------------------------------------------------------------------------
// 6. escapeXMLValue
// -------------------------------------------------------------------------
describe('SEC-SANITIZE: escapeXMLValue drops XML-illegal characters', () => {
  test('control chars, U+FFFE/U+FFFF and lone surrogates are removed', () => {
    const input = 'a\u0000b\u0001\u0008\u000b\u000c\u000e\u001f￾￿\ud800c\udc00d'
    assert.equal(escapeXMLValue(input), 'abcd')
  })
  test('allowed whitespace, BMP text and astral characters are kept and escaped', () => {
    assert.equal(
      escapeXMLValue('\t\n\r \u007f퟿�😀<&>"\''),
      '\t\n\r \u007f퟿�😀&lt;&amp;&gt;&quot;&apos;',
    )
  })
  test('output parses as XML-safe text in an RSS-like envelope', () => {
    const value = escapeXMLValue('Title\u0003 with \u0007bell & <tag>')
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    assert.equal(value, 'Title with bell &amp; &lt;tag&gt;')
  })
})

// -------------------------------------------------------------------------
// 5. decode then strip
// -------------------------------------------------------------------------
describe('SEC-SANITIZE: toPlainText decodes before stripping', () => {
  test('entity-encoded markup does not survive', () => {
    assert.equal(toPlainText('&lt;img src=x onerror=alert(1)&gt;'), '')
    assert.equal(toPlainText('Hi &lt;b&gt;there&lt;/b&gt;'), 'Hi there')
  })
  test('ordinary text and entities decode to plain text', () => {
    assert.equal(toPlainText('Tom &amp; Jerry'), 'Tom & Jerry')
    assert.equal(toPlainText('it&#039;s &quot;fine&quot;'), 'it\'s "fine"')
    assert.equal(toPlainText('a &lt; b'), 'a < b')
    assert.equal(toPlainText('<b>bold</b> text'), 'bold text')
    assert.equal(toPlainText(null), '')
  })

  test('saveNode stores titles/descriptions decoded and tag-free', async (t) => {
    const page = {
      id: 'item-1',
      title: 'Page',
      metadata: {},
      writeLocation: async () => 1,
    }
    const site = {
      loadNode: () => page,
      updateNode: async () => {},
      writePageAlternateFormats: async () => {},
      gitCommit: async () => {},
      getUniqueSlugName: (s) => s,
      manifest: { metadata: { site: {} }, save: async () => {} },
    }
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    t.mock.method(FileContentScanner, 'rebuildPageFilesUuids', async () => {})
    const req = {
      headers: { 'x-haxcms-site-token': 'token' },
      body: {
        site: { name: 'demo' },
        node: {
          id: 'item-1',
          body:
            // page-break attributes reach saveNode undecoded, so this is the
            // shape that used to decode into live markup after strip_tags
            '<page-break title="&lt;img src=x onerror=alert(1)&gt;Safe" item-id="item-1" ' +
            'description="&lt;b onmouseover=x&gt;Desc&lt;/b&gt; &amp; more"></page-break>' +
            '<p>&lt;img src=x onerror=alert(2)&gt; body</p>',
        },
      },
    }
    const res = stubRes()
    await saveNode(req, res)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(page.title, 'Safe')
    assert.equal(page.description, 'Desc & more')
    assert.ok(page.title.indexOf('<') === -1)
    assert.ok(page.description.indexOf('<') === -1)
  })

  test('saveNode auto description from the body is plain text', async (t) => {
    const page = { id: 'item-1', title: 'Page', metadata: {}, writeLocation: async () => 1 }
    const site = {
      loadNode: () => page,
      updateNode: async () => {},
      writePageAlternateFormats: async () => {},
      gitCommit: async () => {},
      getUniqueSlugName: (s) => s,
      manifest: { metadata: { site: {} }, save: async () => {} },
    }
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    t.mock.method(FileContentScanner, 'rebuildPageFilesUuids', async () => {})
    const req = {
      headers: { 'x-haxcms-site-token': 'token' },
      body: {
        site: { name: 'demo' },
        node: {
          id: 'item-1',
          body: '<page-break title="T" item-id="item-1"></page-break><p>&lt;img src=x onerror=alert(2)&gt;Body text</p>',
        },
      },
    }
    const res = stubRes()
    await saveNode(req, res)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.ok(page.description.indexOf('<') === -1, page.description)
    assert.ok(page.description.indexOf('onerror') === -1, page.description)
    assert.ok(page.description.indexOf('Body text') !== -1, page.description)
  })
})

// -------------------------------------------------------------------------
// 3. metadata mass-assignment
// -------------------------------------------------------------------------
const THEMES = {
  'clean-one': { element: 'clean-one', path: '@haxtheweb/clean-one/clean-one.js', name: 'Clean one' },
}

describe('SEC-SANITIZE: sanitizePageMetadata', () => {
  test('applies saveNode per-field rules and keeps unknown scalars', () => {
    const incoming = JSON.parse(
      '{"image":"javascript:alert(1)","linkUrl":" JaVa\\tscript:alert(1)","tags":"<b>x</b>",' +
        '"icon":"icons:check","accentColor":"blue\\"><script>","linkTarget":"_blank","relatedItems":"a,b",' +
        '"theme":{"key":"evil","element":"script-tag","path":"https://evil.example/x.js"},' +
        '"__proto__":{"polluted":true},"constructor":"x","prototype":"y",' +
        '"published":true,"order":3,"custom":"<img src=x onerror=1>","nested":{"a":["<i>",1,false,null]}}',
    )
    const { values, remove } = sanitizePageMetadata(incoming, { themes: THEMES })
    assert.deepEqual(remove.sort(), ['image', 'linkUrl', 'theme'])
    assert.equal(values.tags, '&lt;b&gt;x&lt;/b&gt;')
    assert.equal(values.icon, 'icons:check')
    assert.equal(values.accentColor, 'blue&quot;&gt;&lt;script&gt;')
    assert.equal(values.linkTarget, '_blank')
    assert.equal(values.relatedItems, 'a,b')
    assert.equal(values.published, true)
    assert.equal(values.order, 3)
    assert.equal(values.custom, '&lt;img src=x onerror=1&gt;')
    assert.deepEqual(values.nested, { a: ['&lt;i&gt;', 1, false, null] })
    assert.ok(!Object.prototype.hasOwnProperty.call(values, '__proto__'))
    assert.ok(!Object.prototype.hasOwnProperty.call(values, 'constructor'))
    assert.ok(!Object.prototype.hasOwnProperty.call(values, 'prototype'))
    assert.equal({}.polluted, undefined)
  })

  test('valid theme keys resolve to a copy of the installed theme', () => {
    const { values } = sanitizePageMetadata({ theme: { key: 'clean-one', path: 'https://evil.example/x.js' } }, { themes: THEMES })
    assert.deepEqual(values.theme, Object.assign({}, THEMES['clean-one'], { key: 'clean-one' }))
    assert.equal(THEMES['clean-one'].key, undefined, 'shared themes config is not mutated')
    const byString = sanitizePageMetadata({ theme: 'clean-one' }, { themes: THEMES })
    assert.equal(byString.values.theme.key, 'clean-one')
    const none = sanitizePageMetadata({ theme: '_none_' }, { themes: THEMES })
    assert.deepEqual(none.remove, ['theme'])
  })

  test('safe URL values are kept', () => {
    const { values } = sanitizePageMetadata(
      { image: 'files/a.png', linkUrl: 'https://example.com/x' },
      { themes: THEMES },
    )
    assert.equal(values.image, 'files/a.png')
    assert.equal(values.linkUrl, 'https://example.com/x')
  })

  test('re-saving already-escaped values does not double encode', () => {
    const page = { metadata: {} }
    applyPageMetadata(page, { tags: 'Tom & Jerry\'s', custom: 'a < b' }, { themes: THEMES })
    const first = JSON.parse(JSON.stringify(page.metadata))
    applyPageMetadata(page, first, { themes: THEMES })
    applyPageMetadata(page, JSON.parse(JSON.stringify(page.metadata)), { themes: THEMES })
    assert.deepEqual(page.metadata, first)
    assert.equal(page.metadata.tags, 'Tom &amp; Jerry&#039;s')
    // the single-argument form keeps its historical (double-encoding) behaviour
    assert.equal(sanitizeMetadataValue('&amp;'), '&amp;amp;')
    assert.equal(sanitizeMetadataValue('&amp; &', false), '&amp; &amp;')
  })

  test('unknown keys: only < > " escaped, & and \' kept, script schemes dropped', () => {
    const { values } = sanitizePageMetadata(
      {
        images: ['files/a.png?x=1&y=2', 'javascript:alert(1)', '<b>"q"</b>'],
        note: 'Tom & Jerry\'s',
        evil: ' JAVA\tSCRIPT:alert(1)',
        nested: { link: 'vbscript:x', ok: 'mocha is a drink' },
      },
      { themes: THEMES },
    )
    assert.deepEqual(values.images, ['files/a.png?x=1&y=2', '&lt;b&gt;&quot;q&quot;&lt;/b&gt;'])
    assert.equal(values.note, 'Tom & Jerry\'s')
    assert.ok(!Object.prototype.hasOwnProperty.call(values, 'evil'))
    assert.deepEqual(values.nested, { ok: 'mocha is a drink' })
  })

  test('non-object metadata is ignored', () => {
    const page = { metadata: { keep: 1 } }
    applyPageMetadata(page, 'nope', {})
    applyPageMetadata(page, ['a'], {})
    assert.deepEqual(page.metadata, { keep: 1 })
  })
})

describe('SEC-SANITIZE: saveOutline metadata and title', () => {
  function fakeSite(dir, items) {
    return {
      name: 'demo',
      siteDirectory: dir,
      manifest: {
        items,
        metadata: { site: {} },
        addItem(page) {
          items.push(page)
        },
        save: async () => {},
      },
      loadNode(id) {
        return items.find((i) => i.id === id) || null
      },
      updateNode: async (page) => {
        const index = items.findIndex((i) => i.id === page.id)
        if (index !== -1) items[index] = page
      },
      getUniqueSlugName: (slug) => slug,
      getPageContent: async () => '',
      deleteNode: async () => {},
      gitCommit: async () => {},
      rebuildManagedFiles: async () => {},
      updateAlternateFormats: async () => {},
      writePageAlternateFormats: async () => {},
    }
  }

  test('outline items cannot mass-assign unsafe metadata', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-sec-outline-'))
    t.after(() => fs.removeSync(dir))
    fs.outputFileSync(path.join(dir, 'pages/item-a/index.html'), '<p>A</p>')
    const items = [
      {
        id: 'item-a',
        title: 'A',
        location: 'pages/item-a/index.html',
        slug: 'a',
        parent: null,
        indent: 0,
        order: 0,
        metadata: { created: 1, image: 'files/old.png', theme: { key: 'clean-one' } },
      },
    ]
    const site = fakeSite(dir, items)
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    t.mock.method(HAXCMS, 'getThemes', () => THEMES)
    const metadata = JSON.parse(
      '{"linkUrl":"javascript:alert(1)","image":"data:text/html,x","tags":"<script>x</script>",' +
        '"theme":{"key":"nope","path":"https://evil.example/x.js"},"__proto__":{"polluted":1},' +
        '"created":1,"files":["uuid-1"],"locked":true}',
    )
    const req = {
      headers: { 'x-haxcms-site-token': 'token' },
      body: {
        site: { name: 'demo' },
        items: [
          {
            id: 'item-a',
            title: '&lt;img src=x onerror=alert(1)&gt;<b>Real</b> title',
            parent: null,
            indent: 0,
            order: 0,
            metadata: metadata,
          },
        ],
      },
    }
    const res = stubRes()
    await saveOutline(req, res)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const saved = items.find((i) => i.id === 'item-a')
    assert.equal(saved.title, 'Real title')
    assert.equal(saved.metadata.linkUrl, undefined)
    assert.equal(saved.metadata.image, undefined)
    assert.equal(saved.metadata.theme, undefined)
    assert.equal(saved.metadata.tags, '&lt;script&gt;x&lt;/script&gt;')
    assert.equal(saved.metadata.locked, true)
    assert.equal(saved.metadata.polluted, undefined)
    assert.equal({}.polluted, undefined)
  })
})

describe('SEC-SANITIZE: saveOutline metadata round-trip', () => {
  test('metadata.images URLs with & survive two outline saves unchanged', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-sec-outline-rt-'))
    t.after(() => fs.removeSync(dir))
    fs.outputFileSync(path.join(dir, 'pages/item-a/index.html'), '<p>A</p>')
    const items = [
      {
        id: 'item-a',
        title: 'A',
        location: 'pages/item-a/index.html',
        slug: 'a',
        parent: null,
        indent: 0,
        order: 0,
        metadata: { created: 1 },
      },
    ]
    const site = {
      name: 'demo',
      siteDirectory: dir,
      manifest: { items, metadata: { site: {} }, addItem(p) { items.push(p) }, save: async () => {} },
      loadNode(id) {
        return items.find((i) => i.id === id) || null
      },
      updateNode: async (page) => {
        const index = items.findIndex((i) => i.id === page.id)
        if (index !== -1) items[index] = page
      },
      getUniqueSlugName: (slug) => slug,
      getPageContent: async () => '',
      deleteNode: async () => {},
      gitCommit: async () => {},
      rebuildManagedFiles: async () => {},
      updateAlternateFormats: async () => {},
      writePageAlternateFormats: async () => {},
    }
    t.mock.method(HAXCMS, 'validateRequestToken', () => true)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    t.mock.method(HAXCMS, 'getThemes', () => THEMES)
    const imageUrl = 'https://cdn.example.com/a.png?w=100&h=200&fit=crop'
    let metadata = { created: 1, images: [imageUrl], caption: 'Tom & Jerry\'s' }
    for (let round = 0; round < 2; round++) {
      const req = {
        headers: { 'x-haxcms-site-token': 'token' },
        body: {
          site: { name: 'demo' },
          items: [{ id: 'item-a', title: 'A', parent: null, indent: 0, order: 0, metadata: metadata }],
        },
      }
      const res = stubRes()
      await saveOutline(req, res)
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      // the client sends back exactly what the server stored
      metadata = JSON.parse(JSON.stringify(items.find((i) => i.id === 'item-a').metadata))
    }
    assert.deepEqual(metadata.images, [imageUrl])
    assert.equal(metadata.caption, 'Tom & Jerry\'s')
  })
})

// -------------------------------------------------------------------------
// 4. revision restore
// -------------------------------------------------------------------------
describe('SEC-SANITIZE: revision restore sanitizes restored content', () => {
  function git(cwd, ...args) {
    return execFileSync(
      'git',
      ['-c', 'user.name=Test Author', '-c', 'user.email=author@example.com'].concat(args),
      { cwd: cwd, encoding: 'utf8' },
    ).trim()
  }

  test('script and event handlers in an old revision are not written back', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-revisions-'))
    t.after(() => fs.removeSync(tmpRoot))
    const siteDirectory = path.join(tmpRoot, 'demo')
    const htmlPath = path.join(siteDirectory, 'pages', 'item-1', 'index.html')
    fs.ensureDirSync(path.dirname(htmlPath))
    git(siteDirectory, 'init', '--quiet')
    fs.writeFileSync(
      htmlPath,
      '<p onclick="alert(1)">old</p><script>alert(2)</script><simple-cta link="javascript:alert(3)" label="go"></simple-cta>\n',
    )
    git(siteDirectory, 'add', '.')
    git(siteDirectory, 'commit', '--quiet', '-m', 'unsafe revision')
    const badHash = git(siteDirectory, 'rev-parse', 'HEAD')
    fs.writeFileSync(htmlPath, '<p>current</p>\n')
    git(siteDirectory, 'add', '.')
    git(siteDirectory, 'commit', '--quiet', '-m', 'current')

    const written = []
    const alternates = []
    const page = {
      id: 'item-1',
      title: 'T',
      slug: 'first-page',
      parent: null,
      location: 'pages/item-1/index.html',
      metadata: {},
      async writeLocation(content) {
        written.push(content)
        fs.writeFileSync(htmlPath, content)
        return content.length
      },
    }
    const site = {
      siteDirectory: siteDirectory,
      name: 'demo',
      manifest: { items: [page], metadata: { site: {} }, async save() {} },
      loadNode(id) {
        return id === 'item-1' ? page : null
      },
      getPageAlternateLocation(location, extension) {
        return String(location).replace(/\.html?$/i, '.' + extension)
      },
      async writePageAlternateFormats(p, content) {
        alternates.push(content)
      },
      async gitCommit() {},
    }
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    const res = stubRes()
    await restoreItemRevision(
      {
        headers: {},
        query: {},
        body: {},
        params: { idOrSlug: 'first-page', revisionId: badHash },
        originalUrl: '/_sites/demo/x/api/v1/items/first-page/revisions',
      },
      res,
    )
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(written.length, 1)
    const onDisk = fs.readFileSync(htmlPath, 'utf8')
    for (const content of [written[0], onDisk, alternates[0]]) {
      assert.ok(content.indexOf('old') !== -1, content)
      assert.ok(content.indexOf('label="go"') !== -1, content)
      assert.ok(!/onclick|<script|javascript:/i.test(content), content)
    }
  })
})
