'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const FeedMe = require('../../src/lib/RSS.js')

// Known unix-second timestamps (UTC) used as literals throughout these tests:
//   1500000000  ->  Fri, 14 Jul 2017 02:40:00 GMT   /  2017-07-14T02:40:00.000Z
//   1609459200  ->  Fri, 01 Jan 2021 00:00:00 GMT   /  2021-01-01T00:00:00.000Z
//   1704067200  ->  Mon, 01 Jan 2024 00:00:00 GMT   /  2024-01-01T00:00:00.000Z
// A known past instant (ms) used as a lower bound for "approximately now":
const PAST_INSTANT_MS = 1609459200000

// Extract the text between the first <tag>...</tag> pair in xml after start.
function extractTag(xml, tag, start) {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const openIdx = xml.indexOf(open, start == null ? 0 : start)
  if (openIdx === -1) {
    return null
  }
  const closeIdx = xml.indexOf(close, openIdx + open.length)
  if (closeIdx === -1) {
    return null
  }
  return xml.substring(openIdx + open.length, closeIdx)
}

// Build a site fixture with real page files in a temp dir so safeReadItemContent
// reads from disk (no fs mocking). sortItems returns items ascending by the
// given metadata key, mirroring the real HAXCMS default direction.
function buildKnownSite(options) {
  const opts = options || {}
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-site-'))
  const pagesDir = path.join(tmpRoot, 'pages')
  const items = opts.items || [
    {
      id: 'item-gamma',
      title: 'Gamma Page',
      slug: 'gamma',
      location: 'pages/gamma/index.html',
      description: 'Gamma summary',
      parent: 'item-alpha',
      indent: 2,
      metadata: {
        created: 1500000000,
        updated: 1500000000,
        tags: ['gamma-tag'],
      },
    },
    {
      id: 'item-alpha',
      title: 'Alpha Page',
      slug: 'alpha',
      location: 'pages/alpha/index.html',
      description: 'Alpha summary',
      parent: null,
      indent: 1,
      metadata: {
        created: 1609459200,
        updated: 1609459200,
        tags: ['alpha-tag', 'shared-tag'],
      },
    },
    {
      id: 'item-beta',
      title: 'Beta Page',
      slug: 'beta',
      location: 'pages/beta/index.html',
      description: 'Beta summary',
      parent: 'item-alpha',
      indent: 2,
      metadata: {
        created: 1704067200,
        updated: 1704067200,
        tags: 'beta-string-tag',
      },
    },
  ]

  // Write each item's page file unless the test opts out.
  if (!opts.skipPageFiles) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || !item.location) {
        continue
      }
      const filePath = path.join(tmpRoot, item.location.replace(/\.\.\//g, '').replace(/\.\//g, ''))
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, item.__body || `<p>${item.title} body text</p>`)
    }
  }

  const manifest = Object.assign(
    {
      title: 'Test Site',
      description: 'A test site description',
      author: 'Test Author',
      items: items,
      metadata: {
        site: { domain: 'https://example.com', updated: 1609459200 },
        tags: ['news', 'tech'],
        author: { name: 'Meta Author' },
      },
    },
    opts.manifestOverrides || {},
  )

  const site = {
    siteDirectory: tmpRoot,
    manifest: manifest,
    language: opts.language,
    sortItems: function (key) {
      const arr = manifest.items.slice()
      arr.sort(function (a, b) {
        const av = Number((a.metadata && a.metadata[key]) || 0)
        const bv = Number((b.metadata && b.metadata[key]) || 0)
        return av - bv
      })
      return arr
    },
  }
  return { site, tmpRoot }
}

function cleanupSite(tmpRoot) {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

describe('FeedMe.ensureTrailingSlash', () => {
  const feed = new FeedMe()

  test('returns empty string for empty input', () => {
    assert.equal(feed.ensureTrailingSlash(''), '')
    assert.equal(feed.ensureTrailingSlash(), '')
  })

  test('appends a trailing slash when missing', () => {
    assert.equal(feed.ensureTrailingSlash('https://example.com'), 'https://example.com/')
  })

  test('leaves a trailing slash in place', () => {
    assert.equal(feed.ensureTrailingSlash('https://example.com/'), 'https://example.com/')
  })
})

describe('FeedMe.normalizeTimestamp', () => {
  const feed = new FeedMe()

  test('multiplies unix seconds into milliseconds', () => {
    assert.equal(feed.normalizeTimestamp(1609459200), 1609459200000)
  })

  test('passes millisecond timestamps through unchanged', () => {
    assert.equal(feed.normalizeTimestamp(1609459200000), 1609459200000)
  })

  test('parses ISO date strings', () => {
    assert.equal(feed.normalizeTimestamp('2021-01-01T00:00:00Z'), 1609459200000)
  })

  test('falls back to ~now for null, undefined, and empty', () => {
    for (const input of [null, undefined, '']) {
      const value = feed.normalizeTimestamp(input)
      assert.equal(typeof value, 'number')
      assert.ok(Number.isFinite(value))
      assert.ok(value > PAST_INSTANT_MS, `expected fallback > past instant for ${String(input)}`)
    }
  })

  test('falls back to ~now for unparseable strings', () => {
    const value = feed.normalizeTimestamp('not-a-date')
    assert.equal(typeof value, 'number')
    assert.ok(value > PAST_INSTANT_MS)
  })
})

describe('FeedMe.stripHTML', () => {
  const feed = new FeedMe()

  test('removes tags and collapses whitespace', () => {
    assert.equal(
      feed.stripHTML('<p>Hello <b>world</b></p>  <div>foo</div>'),
      'Hello world foo',
    )
  })

  test('collapses surrounding whitespace', () => {
    assert.equal(feed.stripHTML('  a   b  '), 'a b')
  })

  test('returns plain text unchanged (trimmed)', () => {
    assert.equal(feed.stripHTML('plain text'), 'plain text')
  })
})

describe('FeedMe.xmlEscape', () => {
  const feed = new FeedMe()

  test('escapes the five XML special characters', () => {
    assert.equal(
      feed.xmlEscape('a & b < c > d " e'),
      'a &amp; b &lt; c &gt; d &quot; e',
    )
  })

  test('escapes single quotes as &apos;', () => {
    assert.equal(feed.xmlEscape("it's"), "it&apos;s")
  })
})

describe('FeedMe.getItemLink', () => {
  const feed = new FeedMe()
  const domain = 'https://example.com/'

  test('builds a link from a slug', () => {
    assert.equal(
      feed.getItemLink({ slug: 'page-one' }, domain),
      'https://example.com/page-one',
    )
  })

  test('strips a leading slash from the slug', () => {
    assert.equal(
      feed.getItemLink({ slug: '/page-two' }, domain),
      'https://example.com/page-two',
    )
  })

  test('falls back to location, stripping pages/ and /index.html', () => {
    assert.equal(
      feed.getItemLink({ location: 'pages/foo/index.html' }, domain),
      'https://example.com/foo',
    )
  })
})

describe('FeedMe.getRSSFeed', () => {
  test('produces a well-formed RSS 2.0 feed with channel metadata and items', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')

      assert.equal(
        xml.indexOf('<?xml version="1.0" encoding="utf-8"?>'),
        0,
        'starts with the xml declaration',
      )
      assert.ok(
        xml.indexOf('<rss xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">') !== -1,
        'has the rss root element',
      )
      assert.ok(xml.indexOf('<channel>') !== -1, 'has a channel element')
      assert.ok(
        xml.indexOf('<title>Test Site</title>') !== -1,
        'channel title comes from manifest.title',
      )
      assert.ok(
        xml.indexOf('<link>https://example.com/</link>') !== -1,
        'channel link is the trailing-slashed domain',
      )
      assert.ok(
        xml.indexOf('<description>A test site description</description>') !== -1,
        'channel description is stripped manifest.description',
      )
      assert.ok(
        xml.indexOf('<language>en-us</language>') !== -1,
        'channel language defaults to en-us',
      )
      assert.ok(
        xml.indexOf('<generator>HAXcms NodeJS</generator>') !== -1,
        'has the HAXcms generator tag',
      )
      assert.ok(
        xml.indexOf('<lastBuildDate>Fri, 01 Jan 2021 00:00:00 GMT</lastBuildDate>') !== -1,
        'lastBuildDate comes from manifest.metadata.site.updated',
      )
      assert.ok(
        xml.indexOf('<atom:link href="https://example.com/rss.xml" rel="self" type="application/rss+xml"/>') !== -1,
        'has the atom self link',
      )
      // copyright line has a dynamic year; assert structure only
      assert.ok(
        /<copyright>Copyright \(C\) \d{4} https:\/\/example\.com<\/copyright>/.test(xml),
        'copyright line has a 4-digit year and the domain',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('emits one <item> per outline entry with known titles, links, and pubDates', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')

      assert.equal((xml.match(/<item>/g) || []).length, 3)

      assert.ok(xml.indexOf('<title>Gamma Page</title>') !== -1)
      assert.ok(xml.indexOf('<title>Alpha Page</title>') !== -1)
      assert.ok(xml.indexOf('<title>Beta Page</title>') !== -1)

      assert.ok(xml.indexOf('<link>https://example.com/gamma</link>') !== -1)
      assert.ok(xml.indexOf('<link>https://example.com/alpha</link>') !== -1)
      assert.ok(xml.indexOf('<link>https://example.com/beta</link>') !== -1)

      assert.ok(
        xml.indexOf('<pubDate>Fri, 14 Jul 2017 02:40:00 GMT</pubDate>') !== -1,
        'gamma pubDate',
      )
      assert.ok(
        xml.indexOf('<pubDate>Fri, 01 Jan 2021 00:00:00 GMT</pubDate>') !== -1,
        'alpha pubDate',
      )
      assert.ok(
        xml.indexOf('<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>') !== -1,
        'beta pubDate',
      )

      // guid matches link
      assert.ok(xml.indexOf('<guid>https://example.com/alpha</guid>') !== -1)
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('orders items by created ascending so the oldest item is first', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')
      const firstItemIdx = xml.indexOf('<item>')
      const firstItemEnd = xml.indexOf('</item>', firstItemIdx)
      const firstItem = xml.substring(firstItemIdx, firstItemEnd)
      assert.ok(firstItem.indexOf('Gamma Page') !== -1, 'oldest item (gamma) is first')
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('item description is stripped page body text', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')
      assert.ok(
        xml.indexOf('<description>Gamma Page body text</description>') !== -1,
        'gamma description from page body',
      )
      assert.ok(
        xml.indexOf('<description>Alpha Page body text</description>') !== -1,
        'alpha description from page body',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('emits site-level and item-level categories', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')
      assert.ok(xml.indexOf('<category>news</category>') !== -1, 'site tag news')
      assert.ok(xml.indexOf('<category>tech</category>') !== -1, 'site tag tech')
      assert.ok(xml.indexOf('<category>alpha-tag</category>') !== -1, 'array item tag')
      assert.ok(xml.indexOf('<category>shared-tag</category>') !== -1, 'array item tag')
      assert.ok(xml.indexOf('<category>beta-string-tag</category>') !== -1, 'string item tag')
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('falls back to manifest.metadata.site.domain when no domain is passed', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site)
      assert.ok(
        xml.indexOf('<link>https://example.com/</link>') !== -1,
        'uses the manifest domain',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('uses site.language when set', () => {
    const { site, tmpRoot } = buildKnownSite({ language: 'fr-fr' })
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')
      assert.ok(xml.indexOf('<language>fr-fr</language>') !== -1)
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })
})

describe('FeedMe.rssItems limit', () => {
  test('limits the number of emitted items to the given limit', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')
      // default limit is 25; with 3 items all appear
      assert.equal((xml.match(/<item>/g) || []).length, 3)
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('truncates descriptions longer than 500 characters to 497 plus ellipsis', () => {
    const longBody = '<p>' + 'X'.repeat(600) + '</p>'
    const items = [
      {
        id: 'item-long',
        title: 'Long Page',
        slug: 'long',
        location: 'pages/long/index.html',
        description: 'Long summary',
        parent: null,
        indent: 1,
        metadata: { created: 1609459200, updated: 1609459200, tags: [] },
        __body: longBody,
      },
    ]
    const { site, tmpRoot } = buildKnownSite({ items: items })
    try {
      const feed = new FeedMe()
      const xml = feed.getRSSFeed(site, 'https://example.com')
      // extract the item-level description (skip the channel-level <description>)
      const itemIdx = xml.indexOf('<item>')
      assert.notEqual(itemIdx, -1, 'an item exists')
      const desc = extractTag(xml, 'description', itemIdx)
      assert.equal(desc, 'X'.repeat(497) + '...')
      assert.equal(desc.length, 500)
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })
})

describe('FeedMe.getAtomFeed', () => {
  test('produces a well-formed Atom feed with channel metadata and entries', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getAtomFeed(site, 'https://example.com')

      assert.equal(
        xml.indexOf('<?xml version="1.0" encoding="utf-8"?>'),
        0,
        'starts with the xml declaration',
      )
      assert.ok(
        xml.indexOf('<feed xmlns="http://www.w3.org/2005/Atom">') !== -1,
        'has the atom feed root',
      )
      assert.ok(xml.indexOf('<title>Test Site</title>') !== -1, 'feed title')
      assert.ok(
        xml.indexOf('<subtitle>A test site description</subtitle>') !== -1,
        'feed subtitle',
      )
      assert.ok(
        xml.indexOf('<updated>2021-01-01T00:00:00.000Z</updated>') !== -1,
        'feed updated is ISO from manifest.metadata.site.updated',
      )
      assert.ok(
        xml.indexOf('<name>Test Author</name>') !== -1,
        'author name from manifest.author',
      )
      assert.ok(
        xml.indexOf('<id>https://example.com/</id>') !== -1,
        'feed id is the trailing-slashed domain',
      )
      assert.equal((xml.match(/<entry>/g) || []).length, 3, 'one entry per item')
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('entries contain known titles, ids, published/updated ISO dates, and summaries', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getAtomFeed(site, 'https://example.com')

      assert.ok(xml.indexOf('<title>Gamma Page</title>') !== -1)
      assert.ok(xml.indexOf('<title>Alpha Page</title>') !== -1)
      assert.ok(xml.indexOf('<title>Beta Page</title>') !== -1)

      // entry id falls back to item.id when present
      assert.ok(xml.indexOf('<id>item-gamma</id>') !== -1, 'gamma entry id')
      assert.ok(xml.indexOf('<id>item-alpha</id>') !== -1, 'alpha entry id')

      assert.ok(
        xml.indexOf('<published>2017-07-14T02:40:00.000Z</published>') !== -1,
        'gamma published ISO',
      )
      assert.ok(
        xml.indexOf('<published>2021-01-01T00:00:00.000Z</published>') !== -1,
        'alpha published ISO',
      )
      assert.ok(
        xml.indexOf('<updated>2017-07-14T02:40:00.000Z</updated>') !== -1,
        'gamma updated ISO',
      )

      assert.ok(
        xml.indexOf('<summary>Gamma summary</summary>') !== -1,
        'gamma summary from item.description',
      )
      assert.ok(
        xml.indexOf('<link href="https://example.com/gamma"/>') !== -1,
        'gamma entry link',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('entry content is the raw page body wrapped in CDATA', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getAtomFeed(site, 'https://example.com')
      assert.ok(xml.indexOf('<content type="html">') !== -1)
      assert.ok(
        xml.indexOf('<![CDATA[ <p>Gamma Page body text</p> ]]') !== -1,
        'gamma body in CDATA',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('emits atom categories for array and string tags', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getAtomFeed(site, 'https://example.com')
      assert.ok(
        xml.indexOf('term="alpha-tag" label="alpha-tag"') !== -1,
        'array tag becomes atom category',
      )
      assert.ok(
        xml.indexOf('term="beta-string-tag" label="beta-string-tag"') !== -1,
        'string tag becomes atom category',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('falls back to metadata.author.name when manifest.author is absent', () => {
    const manifestOverrides = { author: undefined }
    const { site, tmpRoot } = buildKnownSite({ manifestOverrides: manifestOverrides })
    try {
      const feed = new FeedMe()
      const xml = feed.getAtomFeed(site, 'https://example.com')
      assert.ok(
        xml.indexOf('<name>Meta Author</name>') !== -1,
        'author name from metadata.author.name',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })
})

describe('FeedMe.getSitemap', () => {
  test('produces a sitemap urlset with one url per item', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getSitemap(site, 'https://example.com')

      assert.equal(
        xml.indexOf('<?xml version="1.0" encoding="UTF-8"?>'),
        0,
        'starts with the xml declaration',
      )
      assert.ok(
        xml.indexOf('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') !== -1,
        'has the sitemap urlset root',
      )
      assert.equal((xml.match(/<url>/g) || []).length, 3, 'one url per item')

      assert.ok(xml.indexOf('<loc>https://example.com/alpha</loc>') !== -1)
      assert.ok(xml.indexOf('<loc>https://example.com/beta</loc>') !== -1)
      assert.ok(xml.indexOf('<loc>https://example.com/gamma</loc>') !== -1)
      assert.ok(
        xml.indexOf('<changefreq>daily</changefreq>') !== -1,
        'all urls have daily changefreq',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('assigns priority 1.0 to root pages (parent null) and 0.7 to indent-2 children', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getSitemap(site, 'https://example.com')
      assert.ok(
        xml.indexOf('<priority>1.0</priority>') !== -1,
        'root page priority 1.0',
      )
      assert.equal(
        (xml.match(/<priority>0\.7<\/priority>/g) || []).length,
        2,
        'two indent-2 children get 0.7',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('lastmod is the ISO timestamp from item.metadata.updated', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getSitemap(site, 'https://example.com')
      assert.ok(
        xml.indexOf('<lastmod>2021-01-01T00:00:00.000Z</lastmod>') !== -1,
        'alpha lastmod ISO',
      )
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })

  test('falls back to manifest.metadata.site.domain when no domain is passed', () => {
    const { site, tmpRoot } = buildKnownSite()
    try {
      const feed = new FeedMe()
      const xml = feed.getSitemap(site)
      assert.ok(xml.indexOf('<loc>https://example.com/alpha</loc>') !== -1)
    }
    finally {
      cleanupSite(tmpRoot)
    }
  })
})

describe('FeedMe.getSitemapIndex', () => {
  test('produces a sitemapindex pointing at sitemap.xml for the domain', () => {
    const feed = new FeedMe()
    const xml = feed.getSitemapIndex('https://example.com')

    assert.equal(
      xml.indexOf('<?xml version="1.0" encoding="UTF-8"?>'),
      0,
      'starts with the xml declaration',
    )
    assert.ok(
      xml.indexOf('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') !== -1,
      'has the sitemapindex root',
    )
    assert.ok(
      xml.indexOf('<loc>https://example.com/sitemap.xml</loc>') !== -1,
      'points at sitemap.xml under the domain',
    )
    assert.ok(
      xml.indexOf('<sitemap>') !== -1 && xml.indexOf('</sitemap>') !== -1,
      'has a sitemap entry',
    )
  })
})
