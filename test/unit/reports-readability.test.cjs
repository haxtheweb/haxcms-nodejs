'use strict'

// Latent-behavior + coverage tests for src/siteRoutes/v1/reports.js, extending
// the reports patterns from site-schemas-blocks-reports-routes.test.cjs
// (JOSHelpers stubbed at the module boundary, HAXCMS.loadSite mocked per
// test). This file runs in its own test process, so module-boundary seams are
// safe to use here.
//
// Module seams for the text-readability dependency of reports.js:
//   1. Missing-module fallback: Module._resolveFilename is patched to throw
//      for 'text-readability' before reports.js is FIRST required, so its
//      `rs = require('text-readability')` throws and the hardcoded fallback
//      object is used — every metric answers 0 and gradeLevel always lands
//      in the '4th grade or lower' band.
//   2. Bound-metric variants: the require cache entry for
//      'text-readability' is replaced with a stub (exercising the
//      rs.default unwrapping) whose daleChallReadabilityScore answers a
//      mutable value, so every gradeLevel band is walked. The other metrics
//      answer real numbers, documenting the working path when the module
//      provides plain (bound-safe) functions.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const Module = require('module')

// stub JOSHelpers at the module boundary before reports.js binds them
const josHelpers = require('../../src/lib/JOSHelpers.js')
let courseStatsFixture = {}
let siteHtmlFixture = ''
josHelpers.courseStatsFromOutline = async () => courseStatsFixture
josHelpers.siteHTMLContent = async () => siteHtmlFixture

const { HAXCMS } = require('../../src/lib/HAXCMS.js')

const reportsPath = require.resolve('../../src/siteRoutes/v1/reports.js')
const textReadabilityId = require.resolve('text-readability')

// 1) missing-module variant: reports.js sees the require throw and falls
// back to the hardcoded zeroed metrics object
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'text-readability') {
    throw new Error("Cannot find module 'text-readability'")
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}
const fallbackReports = require(reportsPath)
Module._resolveFilename = originalResolveFilename

// 2) stubbed-module variant: a require-cache stub (with a `default` export,
// exercising the rs.default unwrap) whose dale-chall score is mutable
let daleChallScore = 0
const stubReadability = {
  daleChallReadabilityScore: () => daleChallScore,
  difficultWords: () => 3,
  syllableCount: () => 9,
  lexiconCount: () => 12,
  sentenceCount: () => 2,
}
require.cache[textReadabilityId] = {
  id: textReadabilityId,
  filename: textReadabilityId,
  loaded: true,
  exports: { default: stubReadability },
}
delete require.cache[reportsPath]
const stubbedReports = require(reportsPath)

function stubRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
  }
}

function makeReq(overrides) {
  const req = {
    headers: {},
    query: {},
    params: {},
    body: {},
    originalUrl: '/_sites/demo/x/api/v1/reports',
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: 'authenticated-site',
      userName: 'tester',
      siteName: 'demo',
    },
  }
  return Object.assign(req, overrides || {})
}

function makeFakeSite(t, overrides) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-readability-'))
  const siteDirectory = path.join(tmpRoot, 'demo')
  t.after(() => {
    fs.removeSync(tmpRoot)
  })
  const items = [
    {
      id: 'item-1',
      title: 'First Page',
      slug: 'first-page',
      parent: null,
      indent: 0,
      order: 0,
      location: 'pages/item-1/index.html',
      metadata: { published: true },
    },
    {
      id: 'item-2',
      title: 'Second Page',
      slug: 'second-page',
      parent: 'item-1',
      indent: 1,
      order: 1,
      location: 'pages/item-2/index.html',
      metadata: {},
    },
  ]
  const site = {
    siteDirectory: siteDirectory,
    name: 'demo',
    manifest: {
      items: items,
      getItemById(id) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].id === id) {
            return items[i]
          }
        }
        return false
      },
      metadata: {
        site: { name: 'demo', settings: { lang: 'en' } },
      },
    },
  }
  return Object.assign(site, overrides || {})
}

function mockSite(t, site) {
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

describe('reports routes — missing text-readability fallback', () => {
  test('the overview report answers zeroed metrics and the lowest grade band', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = { totalWords: 500 }
    siteHtmlFixture = 'The cat sat on the mat. It was a good day for reading.'
    t.after(() => {
      courseStatsFixture = {}
      siteHtmlFixture = ''
    })
    const res = stubRes()
    await fallbackReports.reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/overview',
        params: { report: 'overview' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    // Characterization: when require('text-readability') throws, reports.js
    // falls back to a hardcoded zeroed metric object, so every readability
    // number answers 0 and the dale-chall score (0) always lands in the
    // lowest band. If this fails after a fallback fix, update it.
    const readability = res.body.data.data.readability
    assert.equal(readability.gradeLevel, '4th grade or lower')
    assert.equal(readability.difficultWords, 0)
    assert.equal(readability.syllableCount, 0)
    assert.equal(readability.lexiconCount, 0)
    assert.equal(readability.sentenceCount, 0)
  })
})

describe('reports routes — grade-level bands from the stubbed module', () => {
  const cases = [
    { score: 4.9, grade: '4th grade or lower' },
    { score: 5.5, grade: '5th / 6th grade' },
    { score: 6.5, grade: '7th / 8th grade' },
    { score: 7.5, grade: '9th / 10th grade' },
    { score: 8.5, grade: '11th / 12th grade' },
    { score: 9.9, grade: 'college level reading' },
  ]

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i]
    test('dale-chall score ' + testCase.score + ' answers ' + testCase.grade, async (t) => {
      const site = makeFakeSite(t)
      mockSite(t, site)
      courseStatsFixture = { totalWords: 100 }
      siteHtmlFixture = 'Some fixture text for the readability metrics.'
      daleChallScore = testCase.score
      t.after(() => {
        courseStatsFixture = {}
        siteHtmlFixture = ''
        daleChallScore = 0
      })
      const res = stubRes()
      await stubbedReports.reportDetail(
        makeReq({
          originalUrl: '/_sites/demo/x/api/v1/reports/overview',
          params: { report: 'overview' },
        }),
        res,
      )
      assert.equal(res.statusCode, 200)
      const readability = res.body.data.data.readability
      assert.equal(readability.gradeLevel, testCase.grade)
      // the other metrics flow through from the (bound-safe) stub functions
      assert.equal(readability.difficultWords, 3)
      assert.equal(readability.syllableCount, 9)
      assert.equal(readability.lexiconCount, 12)
      assert.equal(readability.sentenceCount, 2)
    })
  }

  test('the real text-readability module answers zeroed metrics (unbound methods throw)', async (t) => {
    // Characterization documented by site-schemas-blocks-reports-routes
    // already at the handler level: the REAL module's instance methods are
    // invoked unbound so every metric throws and answers 0. Here the same
    // shape is asserted through the stubbed-reports seam with the REAL
    // module loaded fresh, proving the fallback contract again.
    delete require.cache[textReadabilityId]
    delete require.cache[reportsPath]
    const realReports = require(reportsPath)
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = {}
    siteHtmlFixture = 'Fixture body text.'
    t.after(() => {
      courseStatsFixture = {}
      siteHtmlFixture = ''
    })
    const res = stubRes()
    await realReports.reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/overview',
        params: { report: 'overview' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const readability = res.body.data.data.readability
    assert.equal(readability.gradeLevel, '4th grade or lower')
    assert.equal(readability.difficultWords, 0)
    assert.equal(readability.sentenceCount, 0)
  })
})

describe('reports routes — annotation loop skips', () => {
  test('linkData non-array usages and null usages are skipped, null mediaData items too', async (t) => {
    const site = makeFakeSite(t)
    mockSite(t, site)
    courseStatsFixture = {
      linkData: {
        'https://example.com/not-array': 'definitely-not-an-array',
        'https://example.com/mixed': [
          null,
          { itemId: 'item-1' },
          { itemId: 'ghost-item' },
        ],
      },
      mediaData: [
        null,
        { itemId: 'item-2', type: 'image' },
      ],
    }
    t.after(() => {
      courseStatsFixture = {}
    })
    const res = stubRes()
    await stubbedReports.reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/links',
        params: { report: 'links' },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const linkData = res.body.data.data.linkData
    // non-array usages pass through untouched
    assert.equal(linkData['https://example.com/not-array'], 'definitely-not-an-array')
    // null usage skipped; known item annotated; unknown item left empty
    const usages = linkData['https://example.com/mixed']
    assert.equal(usages[0], null)
    assert.equal(usages[1].link, '/demo/first-page')
    assert.equal(usages[1].pageTitle, 'First Page')
    assert.equal(usages[2].link, '')
    assert.equal(usages[2].pageTitle, '')
    const resMedia = stubRes()
    await stubbedReports.reportDetail(
      makeReq({
        originalUrl: '/_sites/demo/x/api/v1/reports/media',
        params: { report: 'media' },
      }),
      resMedia,
    )
    assert.equal(resMedia.statusCode, 200)
    const mediaData = resMedia.body.data.data.mediaData
    assert.equal(mediaData[0], null)
    assert.equal(mediaData[1].pageLink, '/demo/second-page')
    assert.equal(mediaData[1].pageSlug, 'second-page')
    assert.equal(mediaData[1].pageTitle, 'Second Page')
  })
})
