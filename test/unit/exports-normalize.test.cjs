'use strict'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const { normalizeHtmlForDocumentExport } = require('../../src/siteRoutes/v1/exports.js')

describe('normalizeHtmlForDocumentExport — video handling by mode', () => {
  test('pdf mode converts video-player to a clickable [Video] link', () => {
    const html = '<video-player source="https://www.youtube.com/watch?v=abc123"></video-player>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'pdf')
    assert.ok(out.indexOf('<a href="https://www.youtube.com/watch?v=abc123"') !== -1, 'link href present')
    assert.ok(out.indexOf('[Video]') !== -1, '[Video] prefix present')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in pdf mode')
    assert.ok(out.indexOf('video-player') === -1, 'video-player tag removed')
  })

  test('docx mode converts video-player to a clickable [Video] link', () => {
    // DOCX can't render iframes and html-to-docx strips <iframe> tags, so a
    // video-player must become a clickable link instead of vanishing.
    const html = '<video-player source="https://www.youtube.com/watch?v=abc123"></video-player>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'docx')
    assert.ok(out.indexOf('<a href="https://www.youtube.com/watch?v=abc123"') !== -1, 'link href present')
    assert.ok(out.indexOf('[Video]') !== -1, '[Video] prefix present')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in docx mode')
    assert.ok(out.indexOf('video-player') === -1, 'video-player tag removed')
  })

  test('docx mode uses resolved URL for local video source', () => {
    const html = '<video-player source="files/clip.mp4"></video-player>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'docx')
    assert.ok(out.indexOf('href="/site/files/clip.mp4"') !== -1, 'resolved local URL in href')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in docx mode')
  })

  test('pdf mode uses resolved URL for local video source', () => {
    const html = '<video-player source="files/clip.mp4"></video-player>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'pdf')
    assert.ok(out.indexOf('href="/site/files/clip.mp4"') !== -1, 'resolved local URL in href')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in pdf mode')
  })

  test('docx mode removes video-player with no source', () => {
    const html = '<video-player></video-player><p>kept</p>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'docx')
    assert.ok(out.indexOf('kept') !== -1, 'following content kept')
    assert.ok(out.indexOf('video-player') === -1, 'video-player tag removed')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in docx mode')
    assert.ok(out.indexOf('[Video]') === -1, 'no [Video] link when no source')
  })

  test('pdf mode removes video-player with no source', () => {
    const html = '<video-player></video-player><p>kept</p>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'pdf')
    assert.ok(out.indexOf('kept') !== -1, 'following content kept')
    assert.ok(out.indexOf('video-player') === -1, 'video-player tag removed')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in pdf mode')
    assert.ok(out.indexOf('[Video]') === -1, 'no [Video] link when no source')
  })

  test('a11y-media-player is converted to link in docx mode', () => {
    const html = '<a11y-media-player source="https://vimeo.com/12345"></a11y-media-player>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'docx')
    assert.ok(out.indexOf('href="https://vimeo.com/12345"') !== -1, 'vimeo URL in href')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in docx mode')
    assert.ok(out.indexOf('a11y-media-player') === -1, 'a11y-media-player tag removed')
  })

  test('epub mode still produces an iframe embed (unchanged)', () => {
    const html = '<video-player source="https://www.youtube.com/watch?v=abc123"></video-player>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'epub')
    assert.ok(out.indexOf('<iframe') !== -1, 'iframe present in epub mode')
    assert.ok(out.indexOf('youtube-nocookie.com/embed/abc123') !== -1, 'youtube embed URL')
    assert.ok(out.indexOf('video-player') === -1, 'video-player tag removed')
  })

  test('following content is not swallowed in docx mode', () => {
    // Regression guard: the old DOCX path let the iframe through, which
    // html-to-docx then stripped — silently dropping the video AND any
    // content the iframe would have swallowed in a stricter parser. The
    // link replacement ensures following content survives.
    const html =
      '<video-player source="files/clip.mp4"></video-player>' +
      '<p>After the video — this must survive.</p>' +
      '<h2>Next heading</h2>'
    const out = normalizeHtmlForDocumentExport(html, '/site/', [], 'docx')
    assert.ok(out.indexOf('After the video') !== -1, 'following paragraph kept')
    assert.ok(out.indexOf('Next heading') !== -1, 'following heading kept')
    assert.ok(out.indexOf('<iframe') === -1, 'no iframe in docx mode')
  })
})
