'use strict'

// Coverage + characterization tests for src/cli.js — the headless CLI bridge.
//
// Mechanic: plain Node cannot load src/cli.js because it mixes require() with
// ES module export statements (that mix is exactly what the dist babel build
// compiles). @babel/register is an installed devDependency and the repo
// babel.config.js compiles the file correctly, so this suite loads the babel
// hook FIRST and then requires src/cli.js through it. c8 attributes the
// executed, sourcemap-remapped lines back to src/cli.js (verified: the
// uncovered DA lines of a scratch run mapped 1:1 onto real cli.js lines).
//
// Route handlers are stubbed by replacing entries in the shared
// SystemRoutesMap / SiteRoutesMap objects BEFORE src/cli.js is required.
// cli.js captures those same objects (allRoutes.system.map /
// allRoutes.site.map) at require time, and cliBridge reads the entries at
// call time, so the stubs are exactly what cliBridge resolves — no real
// system/site handler side effects run.
//
// Requiring the module also executes the require-time route-registration
// loop (cliOp is null at module scope, so no route callback is ever
// registered there); the listCalls console branch and the registration
// callback body are unreachable without module-scope state changes, so they
// are residue for this suite.
//
// Server-boot discipline honored: nothing boots here (no server, no port).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

// cli.js sets this itself on its first line; set it before anything from
// src/ loads so the HAXCMS singleton constructor sees the same CLI state
// the real CLI boot sees (isCLI() gates constructor side effects).
process.env.haxcms_middleware = 'node-cli'

// load the babel hook before any src/ module is required — scoped to ONLY
// src/cli.js. babel-register compiles everything it hooks, and cli.js pulls
// lib/allRoutes.js (the whole route registry) plus lib/HAXCMS.js through it,
// so an unscoped hook re-compiles those shared modules in this one process
// and their sourcemapped coverage then corrupts the merged lcov across the
// other test processes (doubled function counts, undercounted lines).
// Only cli.js needs the hook — everything else loads as normal CJS.
require('@babel/register')({ only: [/[/\\]src[/\\]cli\.js$/] })

const { SystemRoutesMap, SiteRoutesMap } = require('../../src/lib/allRoutes.js')

// stub handlers placed into the shared route maps before cli.js binds them
const systemCalls = []
SystemRoutesMap.get['system/version'] = async (req, res) => {
  systemCalls.push({ route: req.route.path, query: req.query, method: req.method })
  res.status(200).json({ status: 200, data: { stub: 'system-version' } })
}
const resMethodsCalls = []
SystemRoutesMap.get['status'] = async (req, res) => {
  // exercise every fake-Res method the bridge hands to handlers
  resMethodsCalls.push(res.setHeader('x-custom', 'yes'))
  resMethodsCalls.push(res.send('plain-send'))
  resMethodsCalls.push(res.data)
  resMethodsCalls.push(res.sendStatus(204))
  resMethodsCalls.push(res.statusCode)
  resMethodsCalls.push(res.data)
  res.status(201)
  res.json({ status: 201, data: { stub: 'res-methods' } })
}
const siteCalls = []
SiteRoutesMap.get['v1/files'] = async (req, res) => {
  siteCalls.push({ params: req.params, auth: req.haxcmsSiteApiAuth })
  res.status(200).json({ status: 200, data: { stub: 'site-exact' } })
}
SiteRoutesMap.get['v1/files/:fileUuid'] = async (req, res) => {
  siteCalls.push({ params: req.params, auth: req.haxcmsSiteApiAuth })
  res.status(200).json({ status: 200, data: { stub: 'site-pattern' } })
}
SiteRoutesMap.post['v1/items'] = async (req, res) => {
  siteCalls.push({ body: req.body })
  res.status(200).json({ status: 200, data: { stub: 'site-post' } })
}

// requiring the module runs the require-time registration loop; the
// exported surface is the babel-compiled exports object
const cliModule = require('../../src/cli.js')
const cliBridge = cliModule.cliBridge

describe('cli.js bridge (loaded through @babel/register)', () => {
  test('loads the mixed require/export module and exports cliBridge + cli', () => {
    assert.equal(typeof cliBridge, 'function')
    assert.equal(typeof cliModule.cli, 'object')
    assert.equal(typeof cliModule.cli.get, 'function')
    assert.equal(typeof cliModule.cli.post, 'function')
  })

  test('a system-route exact match runs the handler with the bridge request', async () => {
    const result = await cliBridge('system/version', {}, 'get')
    assert.ok(result)
    assert.equal(result.res.statusCode, 200)
    assert.deepEqual(result.res.data.data, { stub: 'system-version' })
    // the bridge request carries the fake token + the resolved route path
    assert.ok(result.req.query.user_token)
    assert.ok(result.req.route.path.indexOf('system/version') !== -1)
    assert.equal(systemCalls[0].method, 'get')
    assert.equal(typeof systemCalls[0].query.user_token, 'string')
  })

  test('a site-route exact match sets the site auth context from body.site', async () => {
    // body.site as a string
    const byString = await cliBridge('v1/files', { site: 'demo' }, 'get')
    assert.equal(byString.res.data.data.stub, 'site-exact')
    assert.deepEqual(byString.req.haxcmsSiteApiAuth, {
      siteName: 'demo',
      authenticated: true,
      securityLevel: 'authenticated-site',
    })
    // body.site as an object with a name
    const byObject = await cliBridge('v1/files', { site: { name: 'demo-object' } }, 'get')
    assert.equal(byObject.res.data.data.stub, 'site-exact')
    assert.equal(byObject.req.haxcmsSiteApiAuth.siteName, 'demo-object')
    // a body without a site leaves the auth context unset
    const withoutSite = await cliBridge('v1/files', { node: { id: 'x' } }, 'get')
    assert.equal(withoutSite.res.data.data.stub, 'site-exact')
    assert.equal(withoutSite.req.haxcmsSiteApiAuth, undefined)
    assert.equal(siteCalls.length, 3)
  })

  test('a site-route pattern match extracts :params', async () => {
    const fileUuid = '11111111-2222-3333-4444-555555555555'
    const result = await cliBridge('v1/files/' + fileUuid, {}, 'get')
    assert.equal(result.res.data.data.stub, 'site-pattern')
    assert.deepEqual(result.req.params, { fileUuid: fileUuid })
  })

  test('a POST site-route exact match passes the body through', async () => {
    const result = await cliBridge('v1/items', { node: { id: 'node-1' } }, 'post')
    assert.equal(result.res.data.data.stub, 'site-post')
    assert.deepEqual(result.req.body, { node: { id: 'node-1' } })
    assert.equal(result.req.method, 'post')
  })

  test('an unknown route prints the merlin error and answers undefined', async (t) => {
    const errorMock = t.mock.method(console, 'error', () => {})
    const result = await cliBridge('v1/no-such-route', {}, 'get')
    assert.equal(result, undefined)
    assert.ok(errorMock.mock.calls.length > 0)
    const text = String(errorMock.mock.calls[0].arguments[0])
    assert.ok(
      text.indexOf('Route not found: get v1/no-such-route') !== -1,
      'unexpected error text: ' + text,
    )
  })

  test('a validateJWT failure prints the route connection merlin error', async (t) => {
    // cli.js sets haxcms_middleware=node-cli at require time which makes
    // HAXCMS.validateJWT pass; without it (and without the
    // HAXCMS_DISABLE_JWT_CHECKS instance flag that app.js/local.js set) the
    // bridge has no bearer material, so validation fails.
    delete process.env.haxcms_middleware
    t.after(() => {
      process.env.haxcms_middleware = 'node-cli'
    })
    const errorMock = t.mock.method(console, 'error', () => {})
    const result = await cliBridge('system/version', {}, 'get')
    assert.equal(result, undefined)
    assert.ok(errorMock.mock.calls.length > 0)
    const text = String(errorMock.mock.calls[0].arguments[0])
    assert.ok(
      text.indexOf('route connection issue') !== -1,
      'unexpected error text: ' + text,
    )
  })

  test('the fake Res object exposes status/json/send/sendStatus/setHeader', async () => {
    const result = await cliBridge('status', {}, 'get')
    assert.equal(result.res.statusCode, 201)
    assert.deepEqual(result.res.data, { status: 201, data: { stub: 'res-methods' } })
    // setHeader/send/sendStatus chain (return this), send stores .data,
    // sendStatus stores both the code and .data
    assert.equal(resMethodsCalls[0], result.res)
    assert.equal(resMethodsCalls[1], result.res)
    assert.equal(resMethodsCalls[2], 'plain-send')
    assert.equal(resMethodsCalls[3], result.res)
    assert.equal(resMethodsCalls[4], 204)
    assert.equal(resMethodsCalls[5], 204)
  })

  test('the exported cli object invokes callbacks immediately for get and post', (t) => {
    const logged = []
    t.mock.method(console, 'log', (data) => { logged.push(data) })
    let capturedGet = null
    cliModule.cli.get('/x/api/v1/some-get-route', (req, res) => {
      capturedGet = { path: req.route.path, method: req.method, body: req.body }
      res.send('get-send-data')
    })
    assert.equal(capturedGet.path, '/x/api/v1/some-get-route')
    assert.equal(capturedGet.method, 'get')
    assert.deepEqual(capturedGet.body, {})
    assert.deepEqual(logged, ['get-send-data'])
    let capturedPost = null
    cliModule.cli.post('/x/api/v1/some-post-route', (req, res) => {
      capturedPost = { path: req.route.path, method: req.method, query: res.query }
      res.send('post-send-data')
    })
    assert.equal(capturedPost.path, '/x/api/v1/some-post-route')
    assert.equal(capturedPost.method, 'post')
    assert.deepEqual(capturedPost.query, {})
    assert.deepEqual(logged, ['get-send-data', 'post-send-data'])
  })
})
