'use strict'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const { parse } = require('node-html-parser')

const {
  stripMSWord,
  validURL,
  htmlFromEl,
  processDocxHtml,
  sanitizeUntrustedHtml,
} = require('../../src/lib/convertUtils.js')

// Build a single parsed element the same way processDocxHtml does: wrap the
// fragment, then hand htmlFromEl the first element child of the wrapper. This
// is test input construction, not mocking of the module under test.
function firstEl(html) {
  const doc = parse('<div id="docx-import-wrapper">' + html + '</div>')
  const wrapper = doc.querySelector('#docx-import-wrapper')
  const nodes = wrapper.childNodes
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i] && nodes[i].tagName) {
      return nodes[i]
    }
  }
  return null
}

describe('validURL', () => {
  test('http URL is valid', () => {
    assert.equal(validURL('http://example.com'), true)
  })

  test('https URL is valid', () => {
    assert.equal(validURL('https://example.com'), true)
  })

  test('ftp URL is invalid (only http/https accepted)', () => {
    assert.equal(validURL('ftp://example.com'), false)
  })

  test('mailto URL is invalid (only http/https accepted)', () => {
    assert.equal(validURL('mailto:foo@bar.com'), false)
  })

  test('javascript: URL is invalid', () => {
    assert.equal(validURL('javascript:alert(1)'), false)
  })

  test('plain text is invalid', () => {
    assert.equal(validURL('not a url'), false)
  })

  test('empty string is invalid', () => {
    assert.equal(validURL(''), false)
  })

  test('relative path is invalid', () => {
    assert.equal(validURL('/path/to'), false)
  })
})

describe('htmlFromEl — video mapping', () => {
  test('youtube.com URL maps to video-player', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://www.youtube.com/watch?v=abc</a>')),
      '<video-player source="https://www.youtube.com/watch?v=abc"></video-player>',
    )
  })

  test('youtu.be URL maps to video-player', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://youtu.be/abc</a>')),
      '<video-player source="https://youtu.be/abc"></video-player>',
    )
  })

  test('youtube-nocookie.com URL maps to video-player', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://www.youtube-nocookie.com/embed/abc</a>')),
      '<video-player source="https://www.youtube-nocookie.com/embed/abc"></video-player>',
    )
  })

  test('vimeo.com URL maps to video-player', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://vimeo.com/123</a>')),
      '<video-player source="https://vimeo.com/123"></video-player>',
    )
  })

  test('.mp4 URL maps to video-player', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://example.com/clip.mp4</a>')),
      '<video-player source="https://example.com/clip.mp4"></video-player>',
    )
  })
})

describe('htmlFromEl — image mapping', () => {
  const IMG_EXPECTED =
    '<img src="SRC" loading="lazy" decoding="async" fetchpriority="high" alt="" />'

  test('.jpg URL maps to img', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://example.com/pic.jpg</a>')),
      IMG_EXPECTED.replace('SRC', 'https://example.com/pic.jpg'),
    )
  })

  test('.JPEG URL (uppercase) maps to img, original casing preserved in src', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://example.com/pic.JPEG</a>')),
      IMG_EXPECTED.replace('SRC', 'https://example.com/pic.JPEG'),
    )
  })

  test('.png URL maps to img', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://example.com/pic.png</a>')),
      IMG_EXPECTED.replace('SRC', 'https://example.com/pic.png'),
    )
  })

  test('.webp URL maps to img', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://example.com/pic.webp</a>')),
      IMG_EXPECTED.replace('SRC', 'https://example.com/pic.webp'),
    )
  })
})

describe('htmlFromEl — gif mapping', () => {
  test('.gif URL maps to a11y-gif-player with simple-img placeholder', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://example.com/anim.gif</a>')),
      '<a11y-gif-player src="https://example.com/anim.gif" style="width: 300px;">\n' +
        '      <simple-img width="300" src="https://example.com/anim.gif"></simple-img>\n' +
        '    </a11y-gif-player>',
    )
  })
})

describe('htmlFromEl — audio mapping', () => {
  const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'mid', 'midi']
  AUDIO_EXTS.forEach(function (ext) {
    test('.' + ext + ' URL maps to audio-player', () => {
      assert.equal(
        htmlFromEl(firstEl('<a>https://example.com/song.' + ext + '</a>')),
        '<audio-player source="https://example.com/song.' + ext + '"></audio-player>',
      )
    })
  })
})

describe('htmlFromEl — pdf mapping', () => {
  test('.pdf URL maps to pdf-browser-viewer', () => {
    assert.equal(
      htmlFromEl(firstEl('<a>https://example.com/doc.pdf</a>')),
      '<pdf-browser-viewer file="https://example.com/doc.pdf" width="100%"></pdf-browser-viewer>',
    )
  })
})

describe('htmlFromEl — bracket placeholder conventions', () => {
  test('[math:...] maps to lrn-math with the inner expression', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[math:x^2]</p>')),
      '<lrn-math>x^2</lrn-math>',
    )
  })

  test('[mathjax:...] maps to lrn-math with the inner expression', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[mathjax:a/b]</p>')),
      '<lrn-math>a/b</lrn-math>',
    )
  })

  test('[video:...] maps to place-holder type=video', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[video:my clip]</p>')),
      '<place-holder type="video" text="my clip"></place-holder>',
    )
  })

  test('[audio:...] maps to place-holder type=audio', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[audio:song name]</p>')),
      '<place-holder type="audio" text="song name"></place-holder>',
    )
  })

  test('[document:...] maps to place-holder type=document', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[document:doc1]</p>')),
      '<place-holder type="document" text="doc1"></place-holder>',
    )
  })

  test('[text:...] maps to place-holder type=text', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[text:note]</p>')),
      '<place-holder type="text" text="note"></place-holder>',
    )
  })

  test('[image:...] maps to place-holder type=image', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[image:pic]</p>')),
      '<place-holder type="image" text="pic"></place-holder>',
    )
  })

  test('bracketed youtube URL maps to video-player (brackets stripped)', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[https://youtube.com/watch?v=z]</p>')),
      '<video-player source="https://youtube.com/watch?v=z"></video-player>',
    )
  })

  test('bracketed plain text maps to place-holder type=text', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>[some random text]</p>')),
      '<place-holder type="text" text="some random text"></place-holder>',
    )
  })
})

describe('htmlFromEl — bang tag insertion', () => {
  test('!my-tag maps to <my-tag></my-tag> (a dash is required)', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>!my-tag</p>')),
      '<my-tag></my-tag>',
    )
  })

  test('!tag without a dash falls through to the outerHTML fallback', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>!tag</p>')),
      '<p>!tag</p>',
    )
  })
})

describe('htmlFromEl — fallback (outerHTML)', () => {
  test('plain paragraph returns its outerHTML', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>Hello world</p>')),
      '<p>Hello world</p>',
    )
  })

  test('inline [math:...] inside other text is converted in the fallback', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>Hello [math:x^2] world</p>')),
      '<p>Hello <lrn-math>x^2</lrn-math> world</p>',
    )
  })

  test('tab characters are stripped from the fallback outerHTML', () => {
    assert.equal(
      htmlFromEl(firstEl('<p>\ta\tb\t</p>')),
      '<p>ab</p>',
    )
  })
})

describe('processDocxHtml — walks wrapper children and concatenates', () => {
  test('two sibling paragraphs are concatenated', () => {
    assert.equal(
      processDocxHtml('<p>Hello</p><p>World</p>'),
      '<p>Hello</p><p>World</p>',
    )
  })

  test('text-only nodes between elements are skipped (no tagName)', () => {
    assert.equal(
      processDocxHtml('<p>A</p>\n<p>B</p>'),
      '<p>A</p><p>B</p>',
    )
  })

  test('a youtube link child becomes a video-player, concatenated with the next p', () => {
    assert.equal(
      processDocxHtml('<a>https://youtube.com/watch?v=q</a><p>text</p>'),
      '<video-player source="https://youtube.com/watch?v=q"></video-player><p>text</p>',
    )
  })

  test('empty input returns empty string', () => {
    assert.equal(processDocxHtml(''), '')
  })

  test('only-text input (no element children) returns the original html', () => {
    assert.equal(processDocxHtml('just text'), 'just text')
  })
})

describe('sanitizeUntrustedHtml', () => {
  test('script tags are stripped', () => {
    assert.equal(
      sanitizeUntrustedHtml('<p>hi</p><script>alert(1)</script>'),
      '<p>hi</p>',
    )
  })

  test('style tags are stripped', () => {
    assert.equal(
      sanitizeUntrustedHtml('<p>hi</p><style>.x{}</style>'),
      '<p>hi</p>',
    )
  })

  test('iframe tags are stripped', () => {
    assert.equal(
      sanitizeUntrustedHtml('<p>hi</p><iframe src=evil></iframe>'),
      '<p>hi</p>',
    )
  })

  test('HTML comments are stripped', () => {
    assert.equal(
      sanitizeUntrustedHtml('<p>hi</p><!-- secret -->'),
      '<p>hi</p>',
    )
  })

  test('null bytes are removed', () => {
    assert.equal(sanitizeUntrustedHtml('a\x00b'), 'ab')
  })

  test('all dangerous content is stripped and result is trimmed', () => {
    assert.equal(
      sanitizeUntrustedHtml(
        '<script>x</script><style>y</style><iframe src=z></iframe><!-- c -->\x00<p>ok</p>',
      ),
      '<p>ok</p>',
    )
  })

  test('non-string input returns empty string', () => {
    assert.equal(sanitizeUntrustedHtml(null), '')
    assert.equal(sanitizeUntrustedHtml(undefined), '')
    assert.equal(sanitizeUntrustedHtml(42), '')
  })

  test('empty string returns empty string', () => {
    assert.equal(sanitizeUntrustedHtml(''), '')
  })
})

describe('stripMSWord', () => {
  test('non-string input returns empty string', () => {
    assert.equal(stripMSWord(null), '')
    assert.equal(stripMSWord(undefined), '')
    assert.equal(stripMSWord(123), '')
  })

  test('removes Mso* classes', () => {
    assert.equal(stripMSWord('<p class="MsoChpDefault">x</p>'), '<p>x</p>')
  })

  test('removes conditional comments', () => {
    assert.equal(
      stripMSWord('a<!--[if gte mso 9]>secret<![endif]-->b'),
      'ab',
    )
  })

  test('removes o: prefixed tags (keeps inner text)', () => {
    assert.equal(stripMSWord('<o:p>para</o:p>'), 'para')
  })

  test('removes w: prefixed tags (keeps inner text)', () => {
    assert.equal(stripMSWord('<w:body>content</w:body>'), 'content')
  })

  test('removes xml: prefixed tags (keeps inner text)', () => {
    assert.equal(stripMSWord('<xml:x>content</xml:x>'), 'content')
  })

  test('removes inline style attributes', () => {
    assert.equal(stripMSWord('<p style="color:red">x</p>'), '<p>x</p>')
  })

  test('removes empty paragraphs', () => {
    assert.equal(stripMSWord('<p></p><p>real</p>'), '<p>real</p>')
  })

  test('a full Word-style block: Mso class, conditional comment, o: tag, inline styles, empty paragraphs, nbsp, and <b> -> <strong>', () => {
    const input =
      '<p class="MsoNormal" style="margin: 0; line-height: 1.5;">Hello&nbsp;World</p>' +
      '<!--[if gte mso 9]><xml><o:DocumentProperties></o:DocumentProperties></xml><![endif]-->' +
      '<p style="font-weight:normal;text-decoration:none;">Bold</p>' +
      '<p></p><p><br/></p><b>bold</b>'
    assert.equal(
      stripMSWord(input),
      '<p>Hello World</p><p>Bold</p>  <strong>bold</strong>',
    )
  })
})
