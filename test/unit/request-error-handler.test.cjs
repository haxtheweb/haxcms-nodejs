'use strict'

// Security (PR8-4): unit tests for the final express error handler.
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const http = require('http')

const {
  haxcmsErrorHandler,
  bodyParserErrorStatus,
} = require('../../src/lib/requestErrorHandler.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    ended: false,
    headersSent: false,
    status(code) { this.statusCode = code; return this },
    json(obj) { this.body = obj; return this },
    send(obj) { this.sent = obj; return this },
    end() { this.ended = true; return this },
  }
}

function captureConsole(t) {
  const lines = []
  const capture = function () {
    lines.push(Array.prototype.map.call(arguments, function (a) {
      return a && typeof a === 'object' ? JSON.stringify(a) : String(a)
    }).join(' '))
  }
  t.mock.method(console, 'error', capture)
  t.mock.method(console, 'warn', capture)
  return lines
}

test('bodyParserErrorStatus maps body-parser error types', () => {
  assert.equal(bodyParserErrorStatus({ type: 'entity.parse.failed' }), 400)
  assert.equal(bodyParserErrorStatus({ type: 'entity.too.large' }), 413)
  assert.equal(bodyParserErrorStatus({ type: 'parameters.too.many' }), 413)
  assert.equal(bodyParserErrorStatus({ type: 'encoding.unsupported' }), 415)
  assert.equal(bodyParserErrorStatus({ expose: true, status: 400, body: 'x' }), 400)
  assert.equal(bodyParserErrorStatus({ expose: true, status: 413, body: 'x' }), 413)
  assert.equal(bodyParserErrorStatus(new Error('boom')), 0)
  assert.equal(bodyParserErrorStatus({ status: 400 }), 0)
  assert.equal(bodyParserErrorStatus(null), 0)
})

test('parse failure: 400 envelope, logs type + truncated message only', (t) => {
  const lines = captureConsole(t)
  const err = new SyntaxError('Unexpected token b in JSON: "' + 'S'.repeat(1000) + '"')
  err.type = 'entity.parse.failed'
  err.status = 400
  err.expose = true
  err.body = '{"password":"hunter2-SECRET", broken'
  const res = stubRes()
  haxcmsErrorHandler(err, {}, res, function () {})
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.body, { status: 400, message: 'Malformed request body' })
  const all = lines.join('\n')
  assert.equal(all.indexOf('hunter2-SECRET'), -1)
  assert.ok(all.indexOf('entity.parse.failed') !== -1)
  assert.ok(all.length < 300, 'log line truncated: ' + all.length)
})

test('too large: 413 envelope', (t) => {
  captureConsole(t)
  const err = new Error('request entity too large')
  err.type = 'entity.too.large'
  err.status = 413
  const res = stubRes()
  haxcmsErrorHandler(err, {}, res, function () {})
  assert.equal(res.statusCode, 413)
  assert.deepEqual(res.body, { status: 413, message: 'Request body too large' })
})

test('existing behaviours preserved: ENOENT 404, multer 413, generic 500', (t) => {
  const lines = captureConsole(t)
  let res = stubRes()
  haxcmsErrorHandler({ code: 'ENOENT' }, {}, res, function () {})
  assert.equal(res.statusCode, 404)
  assert.equal(res.ended, true)
  res = stubRes()
  haxcmsErrorHandler({ code: 'LIMIT_FILE_SIZE' }, {}, res, function () {})
  assert.equal(res.statusCode, 413)
  assert.deepEqual(res.body, { status: 413, message: 'File too large or too many files' })
  res = stubRes()
  haxcmsErrorHandler(new Error('kaboom'), {}, res, function () {})
  assert.equal(res.statusCode, 500)
  assert.equal(res.sent, 'Server error')
  assert.ok(lines.join('\n').indexOf('kaboom') !== -1 || lines.length >= 1)
})

test('unknown error carrying a body is logged without the body', (t) => {
  const lines = captureConsole(t)
  const err = new Error('weird')
  err.body = 'SECRET-BODY-CONTENT'
  const res = stubRes()
  haxcmsErrorHandler(err, {}, res, function () {})
  assert.equal(res.statusCode, 500)
  assert.equal(lines.join('\n').indexOf('SECRET-BODY-CONTENT'), -1)
})

test('real express.json parser errors route through the handler', async (t) => {
  const lines = captureConsole(t)
  const app = express()
  app.post('/x', express.json({ limit: '1kb' }), function (req, res) { res.json({ ok: true }) })
  app.use(haxcmsErrorHandler)
  const server = http.createServer(app)
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
  t.after(function () { server.close() })
  const port = server.address().port
  async function post(body) {
    const r = await fetch('http://127.0.0.1:' + port + '/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
    })
    return { status: r.status, body: await r.json() }
  }
  const bad = await post('{"token":"TOPSECRET-TOKEN", nope')
  assert.equal(bad.status, 400)
  assert.deepEqual(bad.body, { status: 400, message: 'Malformed request body' })
  const big = await post(JSON.stringify({ blob: 'TOPSECRET-BIG' + 'a'.repeat(5000) }))
  assert.equal(big.status, 413)
  assert.deepEqual(big.body, { status: 413, message: 'Request body too large' })
  const all = lines.join('\n')
  assert.equal(all.indexOf('TOPSECRET-TOKEN'), -1)
  assert.equal(all.indexOf('TOPSECRET-BIG'), -1)
})
