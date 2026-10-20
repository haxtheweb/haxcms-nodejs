'use strict'

// Translatable API messages (haxtheweb/issues#3157): responses keep their
// English message and gain a `code` (+ `params`) the editor and CLI translate.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const catalog = require('../../src/lib/haxcmsApiCodes.json')
const {
  matchApiMessage,
  annotateApiResponse,
  apiMessageCodesMiddleware,
  apiMessageText,
} = require('../../src/lib/apiMessageCodes.js')

test('catalog codes are unique UPPER_SNAKE names with English text and patterns', () => {
  const seen = new Set()
  for (const entry of catalog.codes) {
    assert.match(entry.code, /^[A-Z][A-Z0-9_]*$/)
    assert.ok(!seen.has(entry.code), 'duplicate ' + entry.code)
    seen.add(entry.code)
    assert.ok(typeof entry.en === 'string' && entry.en.length > 0)
    assert.ok(Array.isArray(entry.match) && entry.match.length > 0)
    for (const source of entry.match) {
      assert.doesNotThrow(() => new RegExp(source, 'i'), entry.code + ': ' + source)
      // the PHP backend wraps patterns in ~ delimiters
      assert.ok(source.indexOf('~') === -1, entry.code + ' pattern uses ~')
    }
  }
})

test('the catalog matches the copy bundled with haxcms-elements when present', () => {
  const bundled = path.join(
    __dirname,
    '../../src/public/build/es6/node_modules/@haxtheweb/haxcms-elements/lib/haxcms-api-codes.json',
  )
  if (!fs.existsSync(bundled)) {
    return
  }
  const other = JSON.parse(fs.readFileSync(bundled, 'utf8'))
  if (other.version !== catalog.version) {
    return
  }
  assert.deepEqual(
    other.codes.map((entry) => entry.code),
    catalog.codes.map((entry) => entry.code),
    'src/lib/haxcmsApiCodes.json is out of sync with @haxtheweb/haxcms-elements',
  )
})

const EXAMPLES = [
  ['invalid request token', 'USER_TOKEN_INVALID', {}],
  ['Invalid request', 'INVALID_REQUEST', {}],
  ['Item not found for idOrSlug "my-page"', 'ITEM_NOT_FOUND', { idOrSlug: 'my-page' }],
  ['Invalid file type. Expected .docx, got: notes.txt', 'UPLOAD_WRONG_TYPE', { expected: '.docx', filename: 'notes.txt' }],
  ['File exceeds the maximum upload size of 25MB', 'UPLOAD_TOO_LARGE', { maxMb: '25' }],
  ['Unable to resolve site context for /x/api/v1/files', 'SITE_CONTEXT_UNRESOLVED', { route: '/x/api/v1/files' }],
  ['Outline operations are disabled for this site', 'FEATURE_DISABLED_OUTLINE', {}],
  ['Site does not exist', 'SITE_NOT_FOUND', {}],
  ['contact-form does not exist', 'FORM_NOT_FOUND', { form: 'contact-form' }],
  ['missing `repoUrl` param', 'PARAM_REQUIRED', { param: 'repoUrl' }],
  ['Error processing PDF import: bad xref', 'IMPORT_FAILED', { format: 'PDF', detail: 'bad xref' }],
  ['Unsupported site export format "rtf"', 'EXPORT_FORMAT_UNSUPPORTED', { format: 'rtf' }],
  ['Too many failed login attempts. Please try again later.', 'AUTH_RATE_LIMITED', {}],
  ['Style guide saved successfully', 'STYLE_GUIDE_SAVED', {}],
  ['`repoUrl` must be an openstax.org URL, got: evil.example', 'URL_NOT_ALLOWED', { host: 'evil.example' }],
  ['OpenStax has no book with the slug "nope"', 'IMPORT_SOURCE_INVALID', {}],
  ['OpenStax returned 503 for the book "physics"', 'IMPORT_FETCH_FAILED', {}],
  ['OpenStax returned an empty table of contents for "physics"', 'IMPORT_EMPTY', {}],
]

test('known messages get the expected code and params', () => {
  for (const [message, code, params] of EXAMPLES) {
    const found = matchApiMessage(message)
    assert.ok(found, 'no code for ' + message)
    assert.equal(found.code, code, message)
    assert.deepEqual(found.params, params, message)
  }
})

test('unknown or oversized text gets no code', () => {
  assert.equal(matchApiMessage('Everything worked out great today'), null)
  assert.equal(matchApiMessage(''), null)
  assert.equal(matchApiMessage(null), null)
  assert.equal(matchApiMessage('Access denied' + ' '.repeat(2000)), null)
})

test('error envelopes get code and params next to data.message', () => {
  const body = { status: 404, data: { message: 'Item not found for idOrSlug "intro"' } }
  annotateApiResponse(body, 404)
  assert.equal(body.data.message, 'Item not found for idOrSlug "intro"')
  assert.equal(body.data.code, 'ITEM_NOT_FOUND')
  assert.deepEqual(body.data.params, { idOrSlug: 'intro' })
})

test('top-level messages and data.error are annotated too', () => {
  const top = { status: 413, message: 'File too large or too many files' }
  annotateApiResponse(top, 413)
  assert.equal(top.code, 'REQUEST_TOO_LARGE')
  assert.equal(Object.prototype.hasOwnProperty.call(top, 'params'), false)
  const err = { status: 400, data: { error: 'Markdown to HTML conversion failed: oops' } }
  annotateApiResponse(err, 400)
  assert.equal(err.data.code, 'CONVERSION_FAILED')
  assert.deepEqual(err.data.params, { detail: 'oops' })
})

test('codes a handler already set are kept', () => {
  const body = { status: 400, data: { message: 'Invalid request', code: 'CUSTOM_CODE' } }
  annotateApiResponse(body, 400)
  assert.equal(body.data.code, 'CUSTOM_CODE')
})

test('successful responses only get codes for informational messages', () => {
  const ok = { status: 200, data: { message: 'Access denied' } }
  annotateApiResponse(ok, 200)
  assert.equal(Object.prototype.hasOwnProperty.call(ok.data, 'code'), false)
  const saved = { status: 200, data: { message: 'Style guide saved successfully' } }
  annotateApiResponse(saved, 200)
  assert.equal(saved.data.code, 'STYLE_GUIDE_SAVED')
})

test('non-object bodies pass through untouched', () => {
  assert.equal(annotateApiResponse('Server error', 500), 'Server error')
  assert.deepEqual(annotateApiResponse([1, 2], 400), [1, 2])
  assert.equal(annotateApiResponse(null, 400), null)
})

test('middleware annotates res.json bodies with the response status', () => {
  let sent = null
  const res = {
    statusCode: 403,
    json(body) {
      sent = body
      return this
    },
  }
  let calledNext = false
  apiMessageCodesMiddleware({}, res, () => {
    calledNext = true
  })
  assert.equal(calledNext, true)
  res.json({ status: 403, data: { message: 'Access denied' } })
  assert.equal(sent.data.code, 'ACCESS_DENIED')
})

test('apiMessageText fills params into the English text', () => {
  assert.equal(apiMessageText('UPLOAD_TOO_LARGE', { maxMb: '25' }), 'The file is larger than the 25 MB upload limit.')
  assert.equal(apiMessageText('NOT_A_CODE', {}), null)
})

// every message literal a route sends should have a code, so new messages
// don't silently stay English-only. Add a pattern to haxcmsApiCodes.json
// (and the copy in @haxtheweb/haxcms-elements) when this fails.
test('message literals in routes all have a code', () => {
  // @babel/core is already a dev dependency (it builds dist/)
  const babel = require('@babel/core')
  const root = path.join(__dirname, '../../src')
  const files = [path.join(root, 'app.js')]
  const collect = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (name === 'vendor' || name === 'public' || name === 'boilerplate') continue
      if (fs.statSync(full).isDirectory()) collect(full)
      else if (name.endsWith('.js')) files.push(full)
    }
  }
  collect(path.join(root, 'siteRoutes'))
  collect(path.join(root, 'systemRoutes'))
  collect(path.join(root, 'lib'))
  const text = (node) => {
    if (!node) return null
    if (node.type === 'StringLiteral') return node.value
    if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked || '').join('1')
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = text(node.left)
      const right = text(node.right)
      if (left === null && right === null) return null
      return (left === null ? '1' : left) + (right === null ? '1' : right)
    }
    return null
  }
  const missing = []
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const ast = babel.parseSync(source, {
      configFile: false,
      babelrc: false,
      sourceType: 'unambiguous',
      parserOpts: { allowReturnOutsideFunction: true },
    })
    babel.traverse(ast, {
      ObjectProperty(nodePath) {
        const node = nodePath.node
        if (node.computed || !node.key) return
        const key = node.key.name || node.key.value
        if (key !== 'message' && key !== 'error') return
        const value = text(node.value)
        if (value === null || !/[a-z]{3}/i.test(value)) return
        if (!matchApiMessage(value)) {
          missing.push(path.relative(root, file) + ':' + node.loc.start.line + ' ' + JSON.stringify(value).slice(0, 90))
        }
      },
    })
  }
  assert.deepEqual(missing, [], 'messages without a code:\n' + missing.join('\n'))
})
