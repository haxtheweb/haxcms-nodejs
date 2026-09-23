'use strict'

// Regression test for the service-worker.js Twig render (haxtheweb/issues#3064
// follow-on / SW twig leak). The boilerplate template uses
//   {{ swhash|json_encode(constant('JSON_PRETTY_PRINT'))|raw }}
// and
//   {% if cdnRegex %}toolbox.router.get(/{{ cdnRegex|raw }}/, toolbox.fastest, {});{% endif %}
// Twig.js has no built-in `constant` function (PHP Twig does), so without the
// extendFunction registration in HAXCMS.js, rebuildManagedFiles() throws while
// rendering service-worker.js and the catch swallows the error, leaving the
// raw boilerplate (unrendered {{ swhash... }} and {% if cdnRegex %}) on disk.
//
// This test requires HAXCMS.js (which registers `constant` at module load) and
// then renders the boilerplate through Twig, asserting:
//  - no Twig syntax ({{ / {% / {#) remains in the output,
//  - the precacheConfig line is valid JS (JSON.parse-able array),
//  - the {% if cdnRegex %} block is omitted when cdnRegex is undefined,
//  - the {% if cdnRegex %} block is emitted (with the regex) when cdnRegex is set.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')

// Requiring HAXCMS.js triggers the one-time Twig.extendFunction('constant')
// registration at module load. Use the cached Twig module afterwards.
require('../../src/lib/HAXCMS.js')
const Twig = require('twig')

const BOILERPLATE_SW = path.resolve(__dirname, '..', '..', 'src', 'boilerplate', 'site', 'service-worker.js')

function renderSw(templateVars) {
  const fileData = fs.readFileSync(BOILERPLATE_SW, 'utf8')
  const template = Twig.twig({ data: fileData, async: false })
  return template.render(templateVars)
}

function hasTwigSyntax(str) {
  return (
    String(str).indexOf('{{') !== -1 ||
    String(str).indexOf('{%') !== -1 ||
    String(str).indexOf('{#') !== -1
  )
}

describe('service-worker.js Twig render — constant() registration', () => {
  test('renders the precacheConfig line as valid JS (no {{ swhash... }} leak)', () => {
    const out = renderSw({ swhash: [['index.html', 'abc'], ['manifest.json', 'def']], cdnRegex: undefined })
    assert.equal(hasTwigSyntax(out), false, 'no Twig syntax remains anywhere in the rendered SW')
    const precacheLine = out.split('\n').filter(function (l) {
      return l.indexOf('var precacheConfig') !== -1
    })[0]
    assert.ok(precacheLine, 'precacheConfig line is present')
    // the value must be a JSON array literal, not the raw twig expression
    const valueMatch = precacheLine.match(/var precacheConfig = (.+);$/)
    assert.ok(valueMatch, 'precacheConfig line has the expected `var precacheConfig = ...;` shape')
    const parsed = JSON.parse(valueMatch[1])
    assert.deepEqual(parsed, [['index.html', 'abc'], ['manifest.json', 'def']])
  })

  test('omits the {% if cdnRegex %} runtime-cache block when cdnRegex is undefined', () => {
    const out = renderSw({ swhash: [], cdnRegex: undefined })
    assert.equal(hasTwigSyntax(out), false, 'no {% if cdnRegex %} / {{ cdnRegex }} leak')
    assert.equal(out.indexOf('toolbox.router.get'), -1, 'runtime-cache block omitted when cdnRegex is falsy')
  })

  test('emits the {% if cdnRegex %} runtime-cache block when cdnRegex is set', () => {
    const cdnRegex = 'cdn\\.hax\\.cloud'
    const out = renderSw({ swhash: [], cdnRegex: cdnRegex })
    assert.equal(hasTwigSyntax(out), false, 'no Twig syntax leak even with cdnRegex set')
    assert.notEqual(out.indexOf('toolbox.router.get'), -1, 'runtime-cache block emitted when cdnRegex is set')
    // the cdnRegex value is interpolated verbatim (|raw) into the regex literal,
    // so the rendered route is toolbox.router.get(/cdn\.hax\.cloud/, ...)
    assert.notEqual(out.indexOf('toolbox.router.get(/' + cdnRegex), -1, 'cdnRegex value is interpolated into the route regex')
  })

  test('constant() Twig function is registered and returns the PHP JSON_* bitmask values', () => {
    // Direct proof the extendFunction landed on the Twig module.
    const t = Twig.twig({ data: "{{ constant('JSON_PRETTY_PRINT') }}|{{ constant('JSON_UNESCAPED_SLASHES') }}", async: false })
    assert.equal(t.render({}), '128|64')
    // unknown constants return null (no env/global leak), not a throw
    const t2 = Twig.twig({ data: "{{ constant('NOT_A_REAL_CONSTANT') }}", async: false })
    assert.equal(t2.render({}), '')
  })
})
