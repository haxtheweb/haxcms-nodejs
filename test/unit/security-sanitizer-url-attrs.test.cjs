'use strict'

// Security (review 2026-10), PR security/sanitizer-url-attrs. Pairs with the
// PHP tests in haxcms-php tests/Unit/SanitizerUrlAttrsSecurityTest.php; both
// suites also run the shared payload fixture
// scripts/sanitize-policy-payloads.json.
//
//  1. javascript:/data:/vbscript: URLs in custom-element attributes
//  2. theme style guide stored without sanitizing
//  3. saveOutline / createNode(addPage) metadata mass-assignment
//  5. strip_tags-then-decode revived &lt;img onerror&gt; in title/description
//  6. escapeXMLValue kept XML-illegal control characters
// (4, revision restore, lives in revisions-routes.test.cjs)

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const saveNode = require('../../src/siteRoutes/v1/routes/saveNode.js')
const saveOutline = require('../../src/siteRoutes/v1/routes/saveOutline.js')
const {
  sanitizeHTMLForStorage,
  sanitizeURLValue,
  sanitizePageMetadata,
  sanitizeTextValue,
  escapeXMLValue,
  isExecutableSchemeValue,
} = require('../../src/lib/sanitizeContent.js')

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

// ---- 1. shared payload fixture + custom element URL attributes -------------

test('shared sanitize-policy payload fixture passes (same file PHP uses)', () => {
  const payloads = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../scripts/sanitize-policy-payloads.json'), 'utf8'),
  )
  assert.ok(payloads.length >= 19)
  payloads.forEach((payload) => {
    const output = sanitizeHTMLForStorage(payload.input)
    ;(payload.mustContain || []).forEach((snippet) => {
      assert.ok(output.indexOf(snippet) !== -1, payload.name + ' missing ' + snippet + ' in ' + output)
    })
    ;(payload.mustNotContain || []).forEach((snippet) => {
      assert.equal(output.indexOf(snippet), -1, payload.name + ' kept ' + snippet + ' in ' + output)
    })
  })
})

test('javascript: in link/file/source attributes of HAX elements is removed', () => {
  assert.equal(
    sanitizeHTMLForStorage('<simple-cta link="javascript:alert(1)" label="go"></simple-cta>'),
    '<simple-cta label="go"></simple-cta>',
  )
  assert.equal(
    sanitizeHTMLForStorage('<pdf-browser-viewer file="javascript:alert(1)"></pdf-browser-viewer>'),
    '<pdf-browser-viewer></pdf-browser-viewer>',
  )
  assert.equal(
    sanitizeHTMLForStorage('<media-image link="javascript:alert(1)" source="x.png"></media-image>'),
    '<media-image source="x.png"></media-image>',
  )
  assert.equal(
    sanitizeHTMLForStorage('<h5p-element source="javascript:1"></h5p-element>'),
    '<h5p-element></h5p-element>',
  )
})

test('obfuscated schemes are removed from any attribute', () => {
  ;[
    ' JaVaScRiPt:alert(1)',
    'java&#x09;script:alert(1)',
    '&#106;avascript:alert(1)',
    '&#0000106avascript:alert(1)',
    'javascript&colon;alert(1)',
    'java&NewLine;script:alert(1)',
  ].forEach((value) => {
    const out = sanitizeHTMLForStorage('<simple-cta link="' + value + '"></simple-cta>')
    assert.equal(out, '<simple-cta></simple-cta>', value)
    const generic = sanitizeHTMLForStorage('<my-el thing="' + value + '"></my-el>')
    assert.equal(generic, '<my-el></my-el>', value)
  })
  assert.equal(
    sanitizeHTMLForStorage('<my-el a="data:text/html;base64,PHNjcmlwdD4=" b="vbscript:x" c="livescript:x"></my-el>'),
    '<my-el></my-el>',
  )
})

test('text that merely contains a colon is not treated as a scheme', () => {
  const input =
    '<p title="Note: x" data-time="10:30" data-c="Chapter 1: Intro" data-d="Data: 5 rows, 3 failed" ' +
    'alt="javascript: the good parts" aria-label="JavaScript: intro">t</p>'
  assert.equal(sanitizeHTMLForStorage(input), input)
  assert.equal(isExecutableSchemeValue('Note: x'), false)
  assert.equal(isExecutableSchemeValue('mailto:a@b.c'), false)
  assert.equal(isExecutableSchemeValue('https://x'), false)
  assert.equal(isExecutableSchemeValue('#anchor'), false)
  assert.equal(isExecutableSchemeValue('data:,alert(1)'), true)
})

test('allowed schemes, relative URLs and anchors survive in URL attributes', () => {
  ;['https://example.com/a', 'mailto:a@example.com', 'tel:+15555550100', '/rel/page', 'page.html', '#top'].forEach(
    (value) => {
      const html = '<simple-cta link="' + value + '"></simple-cta>'
      assert.equal(sanitizeHTMLForStorage(html), html)
    },
  )
})

test('video-player JSON sources/tracks are checked entry by entry', () => {
  const bad = sanitizeHTMLForStorage(
    '<video-player sources=\'[{"src":"javascript:alert(1)","type":"video/mp4"}]\'></video-player>',
  )
  assert.equal(bad, '<video-player></video-player>')
  const badTrack = sanitizeHTMLForStorage(
    '<video-player tracks=\'[{"src":"data:text/vtt,x","label":"en"}]\'></video-player>',
  )
  assert.equal(badTrack, '<video-player></video-player>')
  const good = sanitizeHTMLForStorage(
    '<video-player sources=\'[{"src":"https://example.com/v.mp4","type":"video/mp4"}]\'></video-player>',
  )
  assert.ok(good.indexOf('sources=') !== -1 && good.indexOf('https://example.com/v.mp4') !== -1)
})

test('sanitizeURLValue decodes character references before the scheme check', () => {
  assert.equal(sanitizeURLValue('&#106;avascript:alert(1)', ''), '')
  assert.equal(sanitizeURLValue('javascript&colon;alert(1)', ''), '')
  assert.equal(sanitizeURLValue('https://example.com/?a=1&amp;b=2', ''), 'https://example.com/?a=1&amp;b=2')
})

// ---- 2. style guide ---------------------------------------------------------

test('style guide save through saveNode is sanitized before writing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-styleguide-'))
  t.after(() => fs.removeSync(dir))
  const site = Object.create(HAXCMSSite.prototype)
  site.siteDirectory = dir
  site.manifest = { metadata: { theme: {} } }
  site.gitCommit = async () => {}
  t.mock.method(HAXCMS, 'validateRequestToken', () => true)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
  const res = stubRes()
  await saveNode(
    {
      headers: { 'x-haxcms-site-token': 'token' },
      body: {
        site: { name: 'demo' },
        node: {
          id: 'x/theme/style-guide',
          body: '<h1>Guide</h1><script>alert(1)</script><img src=x onerror="alert(2)"><simple-cta link="javascript:alert(3)"></simple-cta>',
        },
      },
    },
    res,
  )
  assert.equal(res.body.status, 200)
  const written = fs.readFileSync(path.join(dir, 'theme', 'style-guide.html'), 'utf8')
  assert.ok(written.indexOf('<h1>Guide</h1>') !== -1)
  assert.equal(written.indexOf('<script'), -1)
  assert.equal(written.indexOf('onerror'), -1)
  assert.equal(written.indexOf('javascript:'), -1)
})

// ---- 3. outline / addPage metadata -----------------------------------------

test('sanitizePageMetadata applies saveNode field rules and passes safe keys through', () => {
  const themes = { 'clean-one': { element: 'clean-one', name: 'Clean one' } }
  const out = sanitizePageMetadata(
    {
      image: 'javascript:alert(1)',
      linkUrl: ' JaVaScRiPt:alert(1)',
      tags: '<img src=x onerror=alert(1)>',
      icon: 'icons:home',
      accentColor: 'red" onmouseover="x',
      linkTarget: '_blank',
      relatedItems: 'a &amp; b',
      author: '<b>me</b>',
      theme: { key: 'not-a-theme', element: 'evil-el' },
      created: 1700000000,
      published: true,
      hideInMenu: false,
      locked: false,
      pageType: 'lesson',
      images: ['files/a.png', 'javascript:alert(1)'],
      files: [{ uuid: 'u1' }],
      customUrl: 'vbscript:x',
      nested: { deep: { value: 'data:text/html,<script>' }, ok: 'fine' },
      note: 'Note: x',
    },
    themes,
  )
  assert.equal(out.image, '')
  assert.equal(out.linkUrl, '')
  assert.equal(out.tags, '&lt;img src=x onerror=alert(1)&gt;')
  assert.equal(out.icon, 'icons:home')
  assert.equal(out.accentColor, 'red&quot; onmouseover=&quot;x')
  assert.equal(out.linkTarget, '_blank')
  // already-escaped values round-trip without double encoding
  assert.equal(out.relatedItems, 'a &amp; b')
  assert.equal(out.author, '&lt;b&gt;me&lt;/b&gt;')
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'theme'), false)
  assert.equal(out.created, 1700000000)
  assert.equal(out.published, true)
  assert.equal(out.hideInMenu, false)
  assert.equal(out.locked, false)
  assert.equal(out.pageType, 'lesson')
  assert.deepEqual(out.images, ['files/a.png'])
  assert.deepEqual(out.files, [{ uuid: 'u1' }])
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'customUrl'), false)
  assert.deepEqual(out.nested, { deep: {}, ok: 'fine' })
  assert.equal(out.note, 'Note: x')
  // a real theme is canonicalised from the server's theme list
  const withTheme = sanitizePageMetadata({ theme: { key: 'clean-one', element: 'evil-el' } }, themes)
  assert.deepEqual(withTheme.theme, { element: 'clean-one', name: 'Clean one', key: 'clean-one' })
  assert.deepEqual(sanitizePageMetadata({ theme: 'clean-one' }, themes).theme.key, 'clean-one')
  // list-form tags / relatedItems (canonical site.json) are escaped entry by entry
  const listForm = sanitizePageMetadata(
    { tags: ['a &amp; b', '<i>x</i>', { bad: 1 }], relatedItems: ['item-1'] },
    themes,
  )
  assert.deepEqual(listForm.tags, ['a &amp; b', '&lt;i&gt;x&lt;/i&gt;'])
  assert.deepEqual(listForm.relatedItems, ['item-1'])
  // prototype keys never land
  const proto = sanitizePageMetadata(JSON.parse('{"__proto__":{"polluted":1},"a":1}'), themes)
  assert.equal(Object.prototype.hasOwnProperty.call(proto, '__proto__'), false)
  assert.equal({}.polluted, undefined)
})

function fakeOutlineSite(dir, items) {
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

test('saveOutline strips title markup and sanitizes metadata instead of mass-assigning', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-outline-sec-'))
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
      metadata: { created: 1, image: 'files/old.png' },
    },
  ]
  t.mock.method(HAXCMS, 'validateRequestToken', () => true)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => fakeOutlineSite(dir, items))
  t.mock.method(HAXCMS, 'getThemes', () => ({}))
  const res = stubRes()
  await saveOutline(
    {
      headers: { 'x-haxcms-site-token': 'token' },
      body: {
        site: { name: 'demo' },
        items: [
          {
            id: 'item-a',
            title: 'Intro<img src=x onerror=alert(1)>',
            parent: null,
            indent: 0,
            order: 0,
            metadata: {
              image: 'javascript:alert(1)',
              linkUrl: 'javascript:alert(2)',
              tags: '<svg onload=alert(3)>',
              theme: { key: 'evil', element: 'script' },
              hideInMenu: true,
              customLink: 'javascript:alert(4)',
            },
          },
        ],
      },
    },
    res,
  )
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const page = items.find((i) => i.id === 'item-a')
  assert.equal(page.title, 'Intro')
  assert.equal(page.metadata.image, '')
  assert.equal(page.metadata.linkUrl, '')
  assert.equal(page.metadata.tags, '&lt;svg onload=alert(3)&gt;')
  assert.equal(page.metadata.theme, undefined)
  assert.equal(page.metadata.hideInMenu, true)
  assert.equal(page.metadata.customLink, undefined)
  assert.equal(JSON.stringify(page).indexOf('javascript:'), -1)
})

test('addPage (createNode items) sanitizes metadata', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-addpage-sec-'))
  t.after(() => fs.removeSync(dir))
  const site = Object.create(HAXCMSSite.prototype)
  site.siteDirectory = dir
  site.manifest = {
    items: [],
    metadata: { site: {} },
    addItem(page) {
      this.items.push(page)
    },
    save: async () => {},
  }
  site.getUniqueSlugName = (slug) => slug
  site.writePageAlternateFormats = async () => {}
  t.mock.method(HAXCMS, 'recurseCopy', async () => {})
  t.mock.method(HAXCMS, 'getThemes', () => ({}))
  const page = await site.addPage(null, 'T', 'default', 't', null, null, '<p></p>', null, {
    image: 'javascript:alert(1)',
    linkUrl: 'https://example.com',
    tags: '<b>x</b>',
    pageType: 'lesson',
    other: 'vbscript:x',
  })
  assert.equal(page.metadata.image, '')
  assert.equal(page.metadata.linkUrl, 'https://example.com')
  assert.equal(page.metadata.tags, '&lt;b&gt;x&lt;/b&gt;')
  assert.equal(page.metadata.pageType, 'lesson')
  assert.equal(page.metadata.other, undefined)
})

// ---- 5. decode then strip ---------------------------------------------------

test('sanitizeTextValue decodes then strips, once', () => {
  assert.equal(sanitizeTextValue('&lt;img src=x onerror=alert(1)&gt;Title'), 'Title')
  assert.equal(sanitizeTextValue('<b>Bold</b> &amp; plain'), 'Bold & plain')
  // double-encoded input decodes one level and stays inert text
  assert.equal(
    sanitizeTextValue('&amp;lt;img src=x onerror=alert(1)&amp;gt;'),
    '&lt;img src=x onerror=alert(1)&gt;',
  )
})

test('saveNode stores encoded markup in title/description as inert text', async (t) => {
  const writes = []
  const page = {
    id: 'item-1',
    title: 'Page',
    metadata: {},
    writeLocation: async (content) => {
      writes.push(content)
      return 1
    },
  }
  const site = {
    loadNode: () => page,
    manifest: { metadata: { site: {} }, save: async () => {} },
    updateNode: async () => {},
    writePageAlternateFormats: async () => {},
    gitCommit: async () => {},
    getUniqueSlugName: (s) => s,
    settings: {},
  }
  t.mock.method(HAXCMS, 'validateRequestToken', () => true)
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
  const payload = '&lt;img src=x onerror=alert(1)&gt;'
  const res = stubRes()
  await saveNode(
    {
      headers: { 'x-haxcms-site-token': 'token' },
      body: {
        site: { name: 'demo' },
        node: {
          id: 'item-1',
          body:
            '<page-break title="Hello ' + payload + '" description="Desc ' + payload + '" item-id="item-1"></page-break>' +
            '<p>Body text ' + payload + '</p>',
        },
      },
    },
    res,
  )
  assert.equal(res.body && res.body.status, 200, JSON.stringify(res.body))
  assert.equal(page.title.indexOf('<img'), -1)
  assert.equal(page.description.indexOf('<img'), -1)
  assert.equal(page.title.trim(), 'Hello')
  assert.equal(page.description.trim(), 'Desc')

  // description generated from the body follows the same rule
  const res2 = stubRes()
  await saveNode(
    {
      headers: { 'x-haxcms-site-token': 'token' },
      body: {
        site: { name: 'demo' },
        node: {
          id: 'item-1',
          body: '<page-break title="T" item-id="item-1"></page-break><p>Body ' + payload + ' end</p>',
        },
      },
    },
    res2,
  )
  assert.equal(page.description.indexOf('<img'), -1)
  assert.ok(page.description.indexOf('Body') !== -1)
})

// ---- 6. XML escaping ---------------------------------------------------------

test('escapeXMLValue strips characters that are illegal in XML 1.0', () => {
  assert.equal(escapeXMLValue('a\u0000b\u0001c\u000bd\u001fe'), 'abcde')
  assert.equal(escapeXMLValue('tab\tlf\ncr\r'), 'tab\tlf\ncr\r')
  assert.equal(escapeXMLValue('x￾y￿z'), 'xyz')
  assert.equal(escapeXMLValue('lone\uD800surrogate'), 'lonesurrogate')
  assert.equal(escapeXMLValue('emoji \u{1F600} <&>"\''), 'emoji \u{1F600} &lt;&amp;&gt;&quot;&apos;')
})
