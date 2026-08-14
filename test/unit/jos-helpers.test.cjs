'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')

const JOS = require('../../src/lib/JOSHelpers.js')

// Minimal element stand-in for typeFromElement / mediaStatus. These helpers
// only read tagName and getAttribute / querySelectorAll, so a plain object with
// those members exercises the public seam without spinning up a real DOM.
function mkEl(tag, attrs) {
  const a = attrs || {}
  return {
    tagName: tag,
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(a, name) ? a[name] : null
    },
    querySelectorAll: function () {
      return []
    },
  }
}

test('typeFromElement classifies audio elements as audio', () => {
  assert.strictEqual(JOS.typeFromElement(mkEl('audio')), 'audio')
  assert.strictEqual(JOS.typeFromElement(mkEl('audio-player')), 'audio')
})

test('typeFromElement classifies video elements as video', () => {
  assert.strictEqual(JOS.typeFromElement(mkEl('video')), 'video')
  assert.strictEqual(JOS.typeFromElement(mkEl('video-player')), 'video')
  assert.strictEqual(JOS.typeFromElement(mkEl('a11y-media-player')), 'video')
})

test('typeFromElement classifies image elements as image', () => {
  assert.strictEqual(JOS.typeFromElement(mkEl('img')), 'image')
  assert.strictEqual(JOS.typeFromElement(mkEl('simple-img')), 'image')
  assert.strictEqual(JOS.typeFromElement(mkEl('media-image')), 'image')
})

test('typeFromElement classifies iframe/embed/object by source host as video or h5p', () => {
  assert.strictEqual(
    JOS.typeFromElement(mkEl('iframe', { src: 'https://www.youtube.com/embed/abc' })),
    'video'
  )
  assert.strictEqual(
    JOS.typeFromElement(mkEl('iframe', { src: 'https://www.youtube-nocookie.com/embed/abc' })),
    'video'
  )
  assert.strictEqual(
    JOS.typeFromElement(mkEl('iframe', { src: 'https://vimeo.com/abc' })),
    'video'
  )
  assert.strictEqual(
    JOS.typeFromElement(mkEl('iframe', { class: 'elmsmedia_h5p_content' })),
    'h5p'
  )
  assert.strictEqual(
    JOS.typeFromElement(mkEl('iframe', { src: 'https://example.com/h5p/embed/1' })),
    'h5p'
  )
  assert.strictEqual(
    JOS.typeFromElement(mkEl('iframe', { src: 'https://example.com/whatever' })),
    'other'
  )
  assert.strictEqual(
    JOS.typeFromElement(mkEl('embed', { src: 'https://example.com/x' })),
    'other'
  )
})

test('typeFromElement returns other for unknown tags, null, and tagless objects', () => {
  assert.strictEqual(JOS.typeFromElement(mkEl('div')), 'other')
  assert.strictEqual(JOS.typeFromElement(null), 'other')
  assert.strictEqual(JOS.typeFromElement({}), 'other')
})

test('mediaStatus reports an error for images with a missing or "null" alt', () => {
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: null }), 'error')
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: 'null' }), 'error')
})

test('mediaStatus reports an error when the alt duplicates name, source, or title', () => {
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: 'same', name: 'same' }), 'error')
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: 'same', source: 'same' }), 'error')
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: 't', title: 't' }), 'error')
})

test('mediaStatus reports a warning for empty alt or alt containing image/picture', () => {
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: '' }), 'warning')
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: 'image of a cat' }), 'warning')
  assert.strictEqual(JOS.mediaStatus({ type: 'image', alt: 'picture of a dog' }), 'warning')
})

test('mediaStatus reports info for a descriptive image alt and for non-image media types', () => {
  assert.strictEqual(
    JOS.mediaStatus({ type: 'image', alt: 'A cat sitting on a mat', name: 'cat.png', source: 'cat.png', title: 'Cat' }),
    'info'
  )
  assert.strictEqual(JOS.mediaStatus({ type: 'audio' }), 'info')
  assert.strictEqual(JOS.mediaStatus({ type: 'other' }), 'info')
  assert.strictEqual(JOS.mediaStatus({ type: 'h5p' }), 'info')
  assert.strictEqual(JOS.mediaStatus({ type: 'unknown-type' }), 'info')
})

test('mediaStatus warns for a video-player element that has no transcript source', () => {
  const player = mkEl('video-player')
  assert.strictEqual(JOS.mediaStatus({ type: 'video' }, player), 'warning')
})

test('mediaStatus reports info for a video-player element that supplies a track attribute', () => {
  const player = mkEl('video-player', { track: 'https://example.com/captions.vtt' })
  assert.strictEqual(JOS.mediaStatus({ type: 'video' }, player), 'info')
})

test('mediaStatus reports info for video media when the element is not a video-player', () => {
  // A non-video-player element is treated as having a transcript, so no warning.
  assert.strictEqual(JOS.mediaStatus({ type: 'video' }, null), 'info')
})

test('YTDurationFormatConvert converts ISO 8601 durations to total seconds', () => {
  assert.strictEqual(JOS.YTDurationFormatConvert('PT1M30S'), 90)
  assert.strictEqual(JOS.YTDurationFormatConvert('PT1H'), 3600)
  assert.strictEqual(JOS.YTDurationFormatConvert('PT1H2M3S'), 3723)
  assert.strictEqual(JOS.YTDurationFormatConvert('PT45S'), 45)
  assert.strictEqual(JOS.YTDurationFormatConvert('PT0S'), 0)
})

test('YTDurationFormatConvert returns 0 for input that does not match the duration pattern', () => {
  assert.strictEqual(JOS.YTDurationFormatConvert('invalid'), 0)
  assert.strictEqual(JOS.YTDurationFormatConvert(''), 0)
})

test('getYoutubeDuration resolves to 0 when no YouTube API key is configured', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    const duration = await JOS.getYoutubeDuration('dQw4w9WgXcQ')
    assert.strictEqual(duration, 0)
  }
  finally {
    if (saved !== undefined) {
      process.env.YOUTUBE_API_KEY = saved
    }
  }
})

test('resolveLocalFile returns a fallback URL with an empty origin when no site location is given', () => {
  const result = JOS.resolveLocalFile('', 'images/foo.png')
  assert.strictEqual(result.origin, '')
  assert.strictEqual(result.pathname, 'images/foo.png')
  assert.strictEqual(result.href, 'images/foo.png')
  assert.strictEqual(String(result), 'images/foo.png')
})

test('resolveLocalFile returns a fallback URL with empty fields for an empty file path', () => {
  const result = JOS.resolveLocalFile('', '')
  assert.strictEqual(result.pathname, '')
  assert.strictEqual(result.href, '')
  assert.strictEqual(String(result), '')
})

test('resolveLocalFile parses absolute http(s) file paths directly into URL objects', () => {
  const result = JOS.resolveLocalFile('', 'https://example.com/foo.jpg')
  assert.strictEqual(result.href, 'https://example.com/foo.jpg')
  assert.strictEqual(result.origin, 'https://example.com')
})

test('resolveLocalFile resolves a relative file path against a site location URL', () => {
  const result = JOS.resolveLocalFile('https://example.com/site', 'images/foo.png')
  assert.strictEqual(result.href, 'https://example.com/site/images/foo.png')
  assert.strictEqual(result.pathname, '/site/images/foo.png')
  assert.strictEqual(result.origin, 'https://example.com')
})

test('resolveLocalFile resolves an absolute file path against the site origin', () => {
  const result = JOS.resolveLocalFile('https://example.com', '/abs/path')
  assert.strictEqual(result.href, 'https://example.com/abs/path')
  assert.strictEqual(result.pathname, '/abs/path')
})

test('resolveLocalFile strips a trailing slash and a /site.json suffix from the site location', () => {
  assert.strictEqual(
    JOS.resolveLocalFile('https://example.com/site/', 'images/foo.png').href,
    'https://example.com/site/images/foo.png'
  )
  assert.strictEqual(
    JOS.resolveLocalFile('https://example.com/site.json', 'images/foo.png').href,
    'https://example.com/images/foo.png'
  )
})

test('resolveSiteData returns null for a null location and a nonexistent path', async () => {
  assert.strictEqual(await JOS.resolveSiteData(null), null)
  assert.strictEqual(await JOS.resolveSiteData('/nonexistent/path/zzz'), null)
})

test('resolveSiteData returns the provided siteData object when it already has a manifest and siteDirectory', async () => {
  const siteData = { manifest: { items: [] }, siteDirectory: '/some/dir' }
  assert.strictEqual(await JOS.resolveSiteData('ignored', siteData), siteData)
  assert.strictEqual(await JOS.resolveSiteData(siteData), siteData)
})

test('resolveSiteData loads a manifest from a real site directory on disk', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jos-resolve-'))
  const siteDir = path.join(tmpRoot, 'mysite')
  fs.mkdirpSync(siteDir)
  const siteJson = {
    id: 'real-site-1',
    title: 'Real Site',
    author: 'A',
    description: 'D',
    license: 'by-sa',
    metadata: {},
    items: [
      { id: 'p1', indent: 0, location: 'pages/p1/index.html', slug: 'p1', order: 0, parent: '', title: 'P1', description: '', metadata: {} },
      { id: 'p2', indent: 0, location: 'pages/p2/index.html', slug: 'p2', order: 1, parent: '', title: 'P2', description: '', metadata: {} },
    ],
  }
  fs.writeFileSync(path.join(siteDir, 'site.json'), JSON.stringify(siteJson))
  try {
    const site = await JOS.resolveSiteData(siteDir)
    assert.ok(site && site.manifest)
    assert.strictEqual(path.basename(site.siteDirectory), 'mysite')
    assert.strictEqual(site.manifest.title, 'Real Site')
    assert.strictEqual(site.manifest.items.length, 2)
    assert.strictEqual(site.manifest.items[0].id, 'p1')
  }
  finally {
    fs.removeSync(tmpRoot)
  }
})

test('siteHTMLContent returns an empty string when the site cannot be resolved', async () => {
  assert.strictEqual(await JOS.siteHTMLContent('/nonexistent/zzz'), '')
})

test('courseStatsFromOutline returns an empty object when the site cannot be resolved', async () => {
  assert.deepStrictEqual(await JOS.courseStatsFromOutline('/nonexistent/zzz'), {})
})
