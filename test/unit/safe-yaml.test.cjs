'use strict'

// Security (review 2026-10): YAML alias amplification in yaml-to-json and the
// VitePress front-matter import. A few hundred bytes of nested anchors used to
// expand to tens of MB (or OOM) inside JSON.stringify.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  loadYamlBounded,
  withinNodeBudget,
  YamlLimitError,
  MAX_YAML_BYTES,
  MAX_YAML_NODES,
} = require('../../src/lib/safeYaml.js')
const { convertYamlToJson } = require('../../src/systemRoutes/v1/routes/convertYamlToJson.js')

// classic "billion laughs": 9 levels x 9 references (~380 bytes)
function aliasBomb() {
  let doc = 'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n'
  const names = 'abcdefghi'
  for (let i = 1; i < names.length; i++) {
    const prev = names[i - 1]
    doc += `${names[i]}: &${names[i]} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]\n`
  }
  return doc
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

test('loadYamlBounded rejects an alias bomb quickly', () => {
  const started = Date.now()
  assert.throws(() => loadYamlBounded(aliasBomb()), YamlLimitError)
  assert.ok(Date.now() - started < 2000, 'bounded walk must stop early')
})

test('loadYamlBounded rejects input over 256 KB', () => {
  assert.equal(MAX_YAML_BYTES, 256 * 1024)
  const big = 'k: "' + 'x'.repeat(MAX_YAML_BYTES) + '"\n'
  assert.throws(() => loadYamlBounded(big), /256 KB/)
})

test('loadYamlBounded allows ordinary documents, small aliases and & inside strings', () => {
  assert.deepEqual(loadYamlBounded('title: "Tom & Jerry *stars*"\nlist: [1, 2]'), {
    title: 'Tom & Jerry *stars*',
    list: [1, 2],
  })
  const withAlias = loadYamlBounded('base: &b {x: 1}\nother: *b\n')
  assert.deepEqual(withAlias.other, { x: 1 })
})

test('withinNodeBudget counts repeated shared references, not just unique objects', () => {
  const shared = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const parent = []
  for (let i = 0; i < 20; i++) parent.push(shared)
  // 1 + 20 * (1 + 10) = 221 visits, only 2 unique objects
  assert.equal(withinNodeBudget(parent, 221), true)
  assert.equal(withinNodeBudget(parent, 220), false)
  assert.ok(MAX_YAML_NODES >= 10000)
})

test('withinNodeBudget terminates on a recursive structure', () => {
  const cyc = []
  cyc.push(cyc)
  assert.equal(withinNodeBudget(cyc, 1000), false)
})

test('yaml-to-json returns 400 with a clear message for an alias bomb', async () => {
  const res = fakeRes()
  await convertYamlToJson({ body: { yaml: aliasBomb() }, query: {} }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.status, 400)
  assert.match(res.body.data.error, /expands beyond/)
  assert.equal(res.body.data.contents, '')
})

test('yaml-to-json returns 400 for oversized input and still converts normal YAML', async () => {
  const big = fakeRes()
  await convertYamlToJson({ body: { yaml: 'a: ' + 'b'.repeat(MAX_YAML_BYTES + 1) }, query: {} }, big)
  assert.equal(big.statusCode, 400)
  assert.match(big.body.data.error, /256 KB/)
  const ok = fakeRes()
  await convertYamlToJson({ body: { yaml: 'name: test\nitems: [1, 2]' }, query: {} }, ok)
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(JSON.parse(ok.body.data.contents), { name: 'test', items: [1, 2] })
})
