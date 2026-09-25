'use strict'

// Unit tests for convertVitepressToSite (#2923).
//
// VitePress declares its outline in JavaScript rather than in a markdown file,
// so the converter reads themeConfig.sidebar out of .vitepress/config.* as
// data and never executes it. These tests cover the outline (sidebar, nested
// groups, the file-tree fallback), the page pipeline (frontmatter, OER
// containers, footnotes, VideoEmbed, images, links, assets) and the safety
// valves.
//
// The network is stubbed at safeFetch, so the suite never leaves the machine:
// api.github.com answers the repo and tree calls, raw.githubusercontent.com
// answers file reads from an in-memory fixture repository.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const safeFetchMod = require('../../src/lib/safeFetch.js')
const {
  convertVitepressToSite,
  LIMITS,
} = require('../../src/systemRoutes/v1/routes/imports/convertVitepressToSite.js')

const OWNER = 'dmd-program'
const REPO = 'dmd-100-book'
const REPO_URL = `https://github.com/${OWNER}/${REPO}`

const CONFIG = `import { defineConfig } from 'vitepress'
import footnote from 'markdown-it-footnote'
import { oerSchemaPlugin } from '../../vitepress-plugin/index.js'

const config = {
  title: "DMD 100",
  description: "Digital Multimedia Design Foundations",
  base: '/dmd-100-book/',
  markdown: {
    config: (md) => {
      md.use(footnote)
      md.use(oerSchemaPlugin)
    }
  },
  themeConfig: {
    license: 'cc-by',
    defaultAuthor: 'Michael Collins',
    workTitle: 'DMD 100: Digital Multimedia Design Foundations',
    siteUrl: 'https://dmd-program.github.io',
    // the outline, with a trailing comma and a comment in the way
    sidebar: [
      {
        text: 'Introduction',
        collapsible: true,
        items: [
          { text: 'Home', link: '/' },
          { text: 'About this course', link: '/introduction/about' },
        ],
      },
      {
        text: 'Lesson 1: What is design?',
        link: '/lessons/lesson-1',
        items: [
          { text: 'Topics', link: '/lessons/lesson-1/topics' },
        ],
      },
      {
        text: 'Resources',
        items: [],
      },
    ],
  },
}

export default defineConfig(config)
`

const DEFAULT_FILES = {
  'docs/.vitepress/config.mjs': CONFIG,
  'docs/index.md': '# Home\n\nWelcome to the course.\n',
  'docs/introduction/about.md': '# About\n\nAbout the course.\n',
  'docs/lessons/lesson-1.md': '# Lesson 1\n\nThe lesson landing page.\n',
  'docs/lessons/lesson-1/topics.md': '# Topics\n\nTopic detail.\n',
  'docs/public/assets/hero.png': 'PNG',
  'docs/assets/photo.png': 'PNG',
  'docs/assets/diagram.svg': 'SVG',
  'docs/assets/videos/demo.webm': 'WEBM',
}

describe('convertVitepressToSite — #2923', () => {
  const realSafeFetch = safeFetchMod.safeFetch
  let fetched
  let requests

  beforeEach(() => {
    fetched = []
    requests = []
  })

  afterEach(() => {
    safeFetchMod.safeFetch = realSafeFetch
  })

  function response(body, status, isJson) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      headers: {
        get: function () {
          return null
        },
      },
      json: async function () {
        return isJson ? body : JSON.parse(body)
      },
      text: async function () {
        return isJson ? JSON.stringify(body) : body
      },
    }
  }

  // answer the GitHub API and raw file reads from an in-memory repository
  function stubRepository(options) {
    const settings = options || {}
    const files = Object.assign({}, DEFAULT_FILES, settings.files || {})
    Object.keys(settings.removed || {}).forEach((path) => {
      delete files[path]
    })
    const branch = settings.branch || 'main'
    safeFetchMod.safeFetch = async function (url, options) {
      fetched.push(url)
      requests.push({ url: url, options: options || {} })
      if (url === `https://api.github.com/repos/${OWNER}/${REPO}`) {
        if (settings.repoStatus) {
          return response({}, settings.repoStatus, true)
        }
        return response({ default_branch: branch }, 200, true)
      }
      if (url.indexOf(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/`) === 0) {
        const tree = Object.keys(files).map((path) => ({ path: path, type: 'blob' }))
        return response({ tree: tree }, 200, true)
      }
      const rawPrefix = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${branch}/`
      if (url.indexOf(rawPrefix) === 0) {
        const path = decodeURI(url.slice(rawPrefix.length))
        if (settings.unreadable && settings.unreadable.indexOf(path) !== -1) {
          return response('', 500, false)
        }
        if (typeof files[path] === 'string') {
          return response(files[path], 200, false)
        }
      }
      return response('', 404, false)
    }
    return files
  }

  async function run(repoUrl) {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        this.body = payload
        return this
      },
    }
    await convertVitepressToSite({ body: { repoUrl: repoUrl === undefined ? REPO_URL : repoUrl } }, res)
    return res
  }

  function itemBySlug(items, slug) {
    return items.filter((item) => item.slug === slug)[0]
  }

  // --- request validation -------------------------------------------------

  test('a missing repoUrl is rejected before any fetch', async () => {
    stubRepository()
    const res = await run('')
    assert.equal(res.statusCode, 400)
    assert.match(res.body.data.error, /missing `repoUrl`/)
    assert.equal(fetched.length, 0)
  })

  test('a non-GitHub URL is rejected', async () => {
    stubRepository()
    const res = await run('https://gitlab.com/owner/repo')
    assert.equal(res.statusCode, 400)
    assert.match(res.body.data.error, /github\.com/)
    assert.equal(fetched.length, 0)
  })

  test('a URL without owner/repo is rejected', async () => {
    stubRepository()
    const res = await run('https://github.com/dmd-program')
    assert.equal(res.statusCode, 400)
    assert.match(res.body.data.error, /owner\/repo/)
  })

  test('a repository with no .vitepress config reports 422', async () => {
    stubRepository({ removed: { 'docs/.vitepress/config.mjs': true } })
    const res = await run()
    assert.equal(res.statusCode, 422)
    assert.match(res.body.data.error, /No \.vitepress\/config/)
  })

  // --- outline ------------------------------------------------------------

  test('the sidebar becomes the outline, with nesting, order and slugs', async () => {
    stubRepository()
    const res = await run()
    assert.equal(res.statusCode, 200)
    const items = res.body.data.items
    assert.deepEqual(
      items.map((item) => [item.title, item.indent, item.order, item.slug]),
      [
        ['Introduction', 0, 0, 'introduction'],
        ['Home', 1, 0, 'introduction/home'],
        ['About this course', 1, 1, 'introduction/about-this-course'],
        ['Lesson 1: What is design?', 0, 1, 'lesson-1-what-is-design'],
        ['Topics', 1, 0, 'lesson-1-what-is-design/topics'],
        ['Resources', 0, 2, 'resources'],
      ],
    )
    // children point at their parent, top level items have none
    const parent = itemBySlug(items, 'lesson-1-what-is-design')
    assert.equal(itemBySlug(items, 'lesson-1-what-is-design/topics').parent, parent.id)
    assert.equal(parent.parent, null)
  })

  test('a group with a link of its own gets that page, a group without one is a landing page', async () => {
    stubRepository()
    const items = (await run()).body.data.items
    assert.match(itemBySlug(items, 'lesson-1-what-is-design').contents, /The lesson landing page/)
    assert.equal(itemBySlug(items, 'resources').contents, '<p></p>')
  })

  test('the root link reads index.md', async () => {
    stubRepository()
    const items = (await run()).body.data.items
    assert.match(itemBySlug(items, 'introduction/home').contents, /Welcome to the course/)
  })

  test('a /tree/<branch> URL imports that branch', async () => {
    stubRepository({ branch: 'draft' })
    const res = await run(`${REPO_URL}/tree/draft`)
    assert.equal(res.statusCode, 200)
    assert.ok(
      fetched.some((url) => url.indexOf('/draft/docs/index.md') !== -1),
      'pages are read from the named branch',
    )
  })

  test('a sidebar keyed by path prefix is flattened into one outline', async () => {
    const config = CONFIG.replace(
      /sidebar: \[[\s\S]*?\n    \],/,
      `sidebar: {
      '/introduction/': [{ text: 'About this course', link: '/introduction/about' }],
      '/lessons/': [{ text: 'Topics', link: '/lessons/lesson-1/topics' }],
    },`,
    )
    stubRepository({ files: { 'docs/.vitepress/config.mjs': config } })
    const items = (await run()).body.data.items
    assert.deepEqual(items.map((item) => item.title), ['About this course', 'Topics'])
  })

  test('a sidebar that is not plain data falls back to the file tree', async () => {
    const config = CONFIG.replace(/sidebar: \[[\s\S]*?\n    \],/, 'sidebar: buildSidebar(),')
    stubRepository({ files: { 'docs/.vitepress/config.mjs': config } })
    const res = await run()
    assert.equal(res.statusCode, 200)
    const titles = res.body.data.items.map((item) => item.title)
    // every markdown page in the docs root, index first, and nothing executed
    assert.deepEqual(titles, ['Home', 'About', 'Lesson 1', 'Topics'])
    assert.ok(titles.indexOf('Introduction') === -1, 'the sidebar was not used')
  })

  test('a sidebar that names no pages falls back to the file tree', async () => {
    // VitePress accepts an empty multi-sidebar map, and sidebar: false
    const config = CONFIG.replace(/sidebar: \[[\s\S]*?\n    \],/, 'sidebar: {},')
    stubRepository({ files: { 'docs/.vitepress/config.mjs': config } })
    const res = await run()
    assert.equal(res.statusCode, 200, res.body.data.error)
    assert.deepEqual(res.body.data.items.map((item) => item.title), ['Home', 'About', 'Lesson 1', 'Topics'])
  })

  test('a config with no sidebar at all falls back to the file tree', async () => {
    const config = 'export default { title: "No sidebar" }\n'
    stubRepository({ files: { 'docs/.vitepress/config.mjs': config } })
    const items = (await run()).body.data.items
    assert.deepEqual(items.map((item) => item.title), ['Home', 'About', 'Lesson 1', 'Topics'])
  })

  // --- page content -------------------------------------------------------

  test('frontmatter sets the title, license and author', async () => {
    stubRepository({
      files: {
        'docs/introduction/about.md':
          '---\ntitle: About This Course\nlicense: cc-by-sa\nauthor: Ada Lovelace\n---\n\n# About\n\nBody.\n',
      },
    })
    const items = (await run()).body.data.items
    const about = items.filter((item) => item.metadata.vitepress.path === 'docs/introduction/about.md')[0]
    assert.equal(about.title, 'About This Course')
    assert.equal(about.metadata.vitepress.license, 'by-sa')
    assert.equal(about.metadata.vitepress.author, 'Ada Lovelace')
    assert.match(about.contents, /<license-element license="by-sa"/)
    assert.match(about.contents, /creator="Ada Lovelace"/)
    assert.ok(about.contents.indexOf('title: About This Course') === -1, 'frontmatter is not rendered')
  })

  test('the themeConfig license becomes the site license and each page carries it', async () => {
    stubRepository()
    const data = (await run()).body.data
    assert.deepEqual(data.site, { license: 'by' })
    assert.match(itemBySlug(data.items, 'introduction/home').contents, /<license-element license="by"/)
    assert.match(itemBySlug(data.items, 'introduction/home').contents, /creator="Michael Collins"/)
  })

  test('OER containers become oer-schema elements carrying their properties', async () => {
    stubRepository({
      files: {
        'docs/index.md':
          '# Objectives\n\n::: learning-objective skill="explain photosynthesis" course="BIOL-101"\n' +
          'Students will explain photosynthesis.\n:::\n\n' +
          '::: assessment type="Quiz" points="10"\nQuick check.\n:::\n',
      },
    })
    const contents = itemBySlug((await run()).body.data.items, 'introduction/home').contents
    assert.match(contents, /<oer-schema typeof="LearningObjective">/)
    assert.match(contents, /<oer-schema oer-property="skill" text="explain photosynthesis">/)
    assert.match(contents, /<oer-schema oer-property="forCourse" text="BIOL-101">/)
    assert.match(contents, /<oer-schema typeof="Assessment">/)
    assert.match(contents, /<oer-schema oer-property="additionalType" text="Quiz">/)
    assert.match(contents, /<oer-schema oer-property="gradingFormat" text="10">/)
    assert.match(contents, /Students will explain photosynthesis/)
    assert.ok(contents.indexOf(':::') === -1, 'no container markers survive')
  })

  test('footnotes render as links and an end-of-page list', async () => {
    stubRepository({
      files: { 'docs/index.md': '# Home\n\nA claim.[^1]\n\n[^1]: The supporting note.\n' },
    })
    const contents = itemBySlug((await run()).body.data.items, 'introduction/home').contents
    assert.match(contents, /footnote-ref/)
    assert.match(contents, /The supporting note/)
    assert.ok(contents.indexOf('[^1]') === -1, 'the footnote marker is rendered, not literal')
  })

  test('VideoEmbed becomes a video-player, with its local file imported', async () => {
    stubRepository({
      files: {
        'docs/index.md':
          '# Home\n\n<VideoEmbed\n  src="/assets/videos/demo.webm"\n  type="local"\n' +
          '  caption="Adding a Frame"\n  autoplay\n  muted\n/>\n',
      },
    })
    const data = (await run()).body.data
    const contents = itemBySlug(data.items, 'introduction/home').contents
    assert.match(contents, /<video-player source="files\/demo\.webm"/)
    assert.match(contents, /media-title="Adding a Frame"/)
    assert.match(contents, /<div slot="caption">Adding a Frame<\/div>/)
    assert.equal(
      data.files['files/demo.webm'],
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/docs/assets/videos/demo.webm`,
    )
    assert.ok(contents.indexOf('VideoEmbed') === -1)
  })

  test('a hosted VideoEmbed keeps its URL', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n<VideoEmbed src="https://youtu.be/abc123" type="youtube" title="Intro" />\n',
      },
    })
    const data = (await run()).body.data
    const contents = itemBySlug(data.items, 'introduction/home').contents
    assert.match(contents, /<video-player source="https:\/\/youtu\.be\/abc123" media-title="Intro">/)
    assert.deepEqual(data.files, {})
  })

  test('images become media-image and their files are imported', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n![Course banner](/assets/hero.png)\n\n![Diagram](/assets/diagram.svg)\n',
        'docs/introduction/about.md': '# About\n\n![Photo](../assets/photo.png)\n',
      },
    })
    const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main`
    const data = (await run()).body.data
    const home = itemBySlug(data.items, 'introduction/home').contents
    const about = itemBySlug(data.items, 'introduction/about-this-course').contents
    // public/ is served at the site root, so /assets/hero.png resolves there
    assert.match(home, /<media-image source="files\/hero\.png" alt="Course banner">/)
    assert.equal(data.files['files/hero.png'], `${raw}/docs/public/assets/hero.png`)
    // a relative reference resolves against the page that carries it, and
    // /assets/photo.png is not in public/, so the docs root answers instead
    assert.match(about, /<media-image source="files\/photo\.png" alt="Photo">/)
    assert.equal(data.files['files/photo.png'], `${raw}/docs/assets/photo.png`)
    // .svg is not importable by createSite, so it keeps its real source URL
    assert.ok(typeof data.files['files/diagram.svg'] === 'undefined')
    assert.match(home, /src="https:\/\/raw\.githubusercontent\.com\/[^"]*docs\/assets\/diagram\.svg"/)
  })

  test('in-book links point at the imported slugs and outside links are left alone', async () => {
    stubRepository({
      files: {
        'docs/index.md':
          '# Home\n\n[Topics](/lessons/lesson-1/topics#intro)\n\n[About](./introduction/about.md)\n\n' +
          '[Penn State](https://psu.edu)\n',
      },
    })
    const contents = itemBySlug((await run()).body.data.items, 'introduction/home').contents
    assert.match(contents, /href="lesson-1-what-is-design\/topics#intro"/)
    assert.match(contents, /href="introduction\/about-this-course"/)
    assert.match(contents, /href="https:\/\/psu\.edu"/)
  })

  test('the VitePress base prefix is dropped from links', async () => {
    stubRepository({
      files: { 'docs/index.md': '# Home\n\n[Topics](/dmd-100-book/lessons/lesson-1/topics)\n' },
    })
    const contents = itemBySlug((await run()).body.data.items, 'introduction/home').contents
    assert.match(contents, /href="lesson-1-what-is-design\/topics"/)
  })

  test('unknown Vue components are unwrapped and reported', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n<LicenseFooter />\n\n<Callout type="note">\n\nKeep this text.\n\n</Callout>\n',
      },
    })
    const data = (await run()).body.data
    const contents = itemBySlug(data.items, 'introduction/home').contents
    assert.match(contents, /Keep this text/)
    assert.ok(contents.indexOf('LicenseFooter') === -1)
    assert.ok(contents.indexOf('<Callout') === -1)
    assert.deepEqual(data.unmappedComponents, ['Callout', 'LicenseFooter'])
  })

  test('two different files with the same basename both import', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n![Public](/assets/photo.png)\n',
        'docs/introduction/about.md': '# About\n\n![Docs](../assets/photo.png)\n',
        'docs/public/assets/photo.png': 'PNG',
      },
    })
    const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main`
    const data = (await run()).body.data
    // public/assets/photo.png and assets/photo.png are different files
    assert.equal(Object.keys(data.files).length, 2)
    assert.equal(data.files['files/photo.png'], `${raw}/docs/public/assets/photo.png`)
    assert.equal(data.files['files/photo-1.png'], `${raw}/docs/assets/photo.png`)
    assert.match(itemBySlug(data.items, 'introduction/home').contents, /source="files\/photo\.png"/)
    assert.match(itemBySlug(data.items, 'introduction/about-this-course').contents, /source="files\/photo-1\.png"/)
  })

  test('a page that cannot be read links to its source instead of arriving empty', async () => {
    stubRepository({ unreadable: ['docs/introduction/about.md'] })
    const items = (await run()).body.data.items
    const about = itemBySlug(items, 'introduction/about-this-course')
    assert.match(about.contents, /Read this page on <a href="https:\/\/dmd-program\.github\.io\/dmd-100-book\/introduction\/about">/)
  })

  test('each item records where it came from', async () => {
    stubRepository()
    const items = (await run()).body.data.items
    const topics = itemBySlug(items, 'lesson-1-what-is-design/topics')
    assert.equal(topics.metadata.sourceType, 'vitepress')
    assert.equal(topics.metadata.vitepress.repo, `${OWNER}/${REPO}`)
    assert.equal(topics.metadata.vitepress.branch, 'main')
    assert.equal(topics.metadata.vitepress.path, 'docs/lessons/lesson-1/topics.md')
    assert.equal(topics.metadata.vitepress.workTitle, 'DMD 100: Digital Multimedia Design Foundations')
    assert.equal(topics.metadata.source, 'https://dmd-program.github.io/dmd-100-book/lessons/lesson-1/topics')
  })

  test('the response carries the site title and the import is not truncated', async () => {
    stubRepository()
    const data = (await run()).body.data
    assert.equal(data.filename, 'DMD 100')
    assert.equal(data.truncated, false)
    assert.deepEqual(data.unmappedComponents, [])
  })

  test('docs/.vitepress wins when a repository carries more than one config', async () => {
    // the sample repo ships a plugin example beside the real site
    stubRepository({
      files: {
        '.vitepress/config.mjs': 'export default { title: "Plugin example" }\n',
        'vitepress-plugin/example/.vitepress/config.js': 'export default { title: "Fixture" }\n',
      },
    })
    const data = (await run()).body.data
    assert.equal(data.filename, 'DMD 100', 'the docs/ config describes the site')
    assert.equal(data.items[0].title, 'Introduction', 'its sidebar is the outline')
  })

  test('a sidebar written with comments, numbers and escapes still reads', async () => {
    const config = `export default {
  title: "Edge cases",
  themeConfig: {
    sidebar: [
      /* a block comment */
      {
        text: 'It\\'s here', // a line comment
        collapsed: 1,
        items: [{ text: "Quoted \\"page\\"", link: '/introduction/about' }],
      },
    ],
  },
}
`
    stubRepository({ files: { 'docs/.vitepress/config.mjs': config } })
    const items = (await run()).body.data.items
    assert.deepEqual(items.map((item) => item.title), ["It's here", 'Quoted "page"'])
  })

  test('a sidebar entry that is not an object or lacks a title is skipped', async () => {
    const config = CONFIG.replace(
      /sidebar: \[[\s\S]*?\n    \],/,
      `sidebar: [
      'just a string',
      { link: '/introduction/about' },
      { text: 'Real page', link: '/introduction/about' },
    ],`,
    )
    stubRepository({ files: { 'docs/.vitepress/config.mjs': config } })
    const items = (await run()).body.data.items
    assert.deepEqual(items.map((item) => item.title), ['Real page'])
  })

  test('a link backed by a directory index resolves to that index', async () => {
    const config = CONFIG.replace("link: '/lessons/lesson-1'", "link: '/lessons/lesson-2'")
    stubRepository({
      files: {
        'docs/.vitepress/config.mjs': config,
        'docs/lessons/lesson-2/index.md': '# Lesson 2\n\nFrom the directory index.\n',
      },
    })
    const items = (await run()).body.data.items
    const lesson = items.filter((item) => item.metadata.vitepress.path === 'docs/lessons/lesson-2/index.md')[0]
    assert.ok(lesson, 'the directory index backs the link')
    assert.match(lesson.contents, /From the directory index/)
  })

  test('an asset referenced twice is imported once', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n![One](/assets/hero.png)\n\n![Again](/assets/hero.png)\n',
      },
    })
    const data = (await run()).body.data
    assert.equal(Object.keys(data.files).length, 1)
    const contents = itemBySlug(data.items, 'introduction/home').contents
    assert.equal((contents.match(/files\/hero\.png/g) || []).length, 2)
  })

  test('assets referenced through the base prefix resolve', async () => {
    stubRepository({
      files: { 'docs/index.md': '# Home\n\n![Banner](/dmd-100-book/assets/hero.png)\n' },
    })
    const data = (await run()).body.data
    assert.match(itemBySlug(data.items, 'introduction/home').contents, /source="files\/hero\.png"/)
  })

  test('a third file with the same basename keeps counting', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n![A](/assets/photo.png)\n',
        'docs/introduction/about.md': '# About\n\n![B](../assets/photo.png)\n![C](./photo.png)\n',
        'docs/public/assets/photo.png': 'PNG',
        'docs/introduction/photo.png': 'PNG',
      },
    })
    const data = (await run()).body.data
    assert.deepEqual(
      Object.keys(data.files).sort(),
      ['files/photo-1.png', 'files/photo-2.png', 'files/photo.png'],
    )
  })

  test('a link to an importable file joins the file map', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n[Syllabus](/assets/syllabus.pdf)\n',
        'docs/public/assets/syllabus.pdf': 'PDF',
      },
    })
    const data = (await run()).body.data
    assert.match(itemBySlug(data.items, 'introduction/home').contents, /href="files\/syllabus\.pdf"/)
    assert.ok(data.files['files/syllabus.pdf'])
  })

  test('a video-player written directly in markdown has its source imported', async () => {
    stubRepository({
      files: {
        'docs/index.md': '# Home\n\n<video-player source="/assets/videos/demo.webm"></video-player>\n',
      },
    })
    const data = (await run()).body.data
    assert.match(itemBySlug(data.items, 'introduction/home').contents, /<video-player source="files\/demo\.webm">/)
    assert.ok(data.files['files/demo.webm'])
  })

  test('a VideoEmbed without a src is dropped', async () => {
    stubRepository({
      files: { 'docs/index.md': '# Home\n\n<VideoEmbed type="local" caption="Nothing" />\n\nAfter.\n' },
    })
    const contents = itemBySlug((await run()).body.data.items, 'introduction/home').contents
    assert.ok(contents.indexOf('video-player') === -1)
    assert.match(contents, /After\./)
  })

  test('a page that cannot be read and has no source URL is left empty', async () => {
    const config = CONFIG.replace("siteUrl: 'https://dmd-program.github.io',", '')
    stubRepository({
      files: { 'docs/.vitepress/config.mjs': config },
      unreadable: ['docs/introduction/about.md'],
    })
    const items = (await run()).body.data.items
    assert.equal(itemBySlug(items, 'introduction/about-this-course').contents, '<p></p>')
  })

  test('a JSON string body is accepted like a parsed one', async () => {
    stubRepository()
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        this.body = payload
        return this
      },
    }
    await convertVitepressToSite({ body: JSON.stringify({ repoUrl: REPO_URL }) }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.items.length, 6)
  })

  test('every request carries the User-Agent the GitHub API demands', async () => {
    // without one the API answers 403 on every call, which is how the Gitbook
    // importer silently imported zero files before it started sending one
    stubRepository()
    await run()
    const apiCalls = requests.filter((entry) => entry.url.indexOf('https://api.github.com/') === 0)
    const rawCalls = requests.filter((entry) => entry.url.indexOf('https://raw.githubusercontent.com/') === 0)
    assert.ok(apiCalls.length >= 2, 'the repo and tree are read from the API')
    assert.ok(rawCalls.length >= 2, 'the config and pages are read raw')
    apiCalls.concat(rawCalls).forEach((entry) => {
      assert.equal(
        entry.options.headers && entry.options.headers['User-Agent'],
        'HAXcms-Import/1.0',
        entry.url,
      )
    })
    assert.equal(apiCalls[0].options.headers.Accept, 'application/vnd.github.v3+json')
  })

  // --- safety valves ------------------------------------------------------

  test('the page cap truncates the import and the rest link to their source', async () => {
    const original = LIMITS.maxPages
    LIMITS.maxPages = 1
    try {
      stubRepository()
      const data = (await run()).body.data
      assert.equal(data.truncated, true)
      const about = itemBySlug(data.items, 'introduction/about-this-course')
      assert.match(about.contents, /Read this page on/)
    }
    finally {
      LIMITS.maxPages = original
    }
  })

  test('the time budget truncates the import', async () => {
    const original = LIMITS.fetchBudgetSeconds
    LIMITS.fetchBudgetSeconds = -1
    try {
      stubRepository()
      const data = (await run()).body.data
      assert.equal(data.truncated, true)
    }
    finally {
      LIMITS.fetchBudgetSeconds = original
    }
  })

  test('the file cap stops importing assets', async () => {
    const original = LIMITS.maxFiles
    LIMITS.maxFiles = 1
    try {
      stubRepository({
        files: {
          'docs/index.md': '# Home\n\n![One](/assets/hero.png)\n',
          'docs/introduction/about.md': '# About\n\n![Two](../assets/photo.png)\n',
        },
      })
      const data = (await run()).body.data
      assert.equal(Object.keys(data.files).length, 1)
      assert.equal(data.truncated, true)
    }
    finally {
      LIMITS.maxFiles = original
    }
  })

  test('an unreachable repository reports the failure', async () => {
    stubRepository({ repoStatus: 404 })
    const res = await run()
    assert.equal(res.statusCode, 422)
    assert.match(res.body.data.error, /Unable to read the repository/)
  })
})
