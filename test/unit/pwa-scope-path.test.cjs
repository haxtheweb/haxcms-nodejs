'use strict'

// Unit tests for HAXCMSSite.getPWAScopePath / getBaseTag /
// getServiceWorkerScript vanity-domain scope behavior.
//
// When manifest.metadata.site.domain is a non-empty string the site is served
// from the vanity domain root, so the PWA scope / start_url / SW registration
// scope / <base> href must all be '/'. When domain is empty the legacy
// internal multisite basePath + site.name is used.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

// Set CLI mode before requiring HAXCMS so the singleton constructor does not
// refuse to start over default credentials (the singleton is shared
// process-wide).
process.env.haxcms_middleware = 'node-cli'

const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')

// Build a minimal HAXCMSSite instance without touching disk.
function makeSite(opts) {
  opts = opts || {}
  const site = new HAXCMSSite()
  site.name = opts.name || 'testsite'
  site.basePath = opts.basePath || '/'
  site.manifest = {
    metadata: {
      site: {
        name: opts.name || 'testsite',
      },
    },
    items: [],
  }
  if (opts.domain !== undefined) {
    site.manifest.metadata.site.domain = opts.domain
  }
  if (opts.settings) {
    site.manifest.metadata.site.settings = opts.settings
  }
  return site
}

describe('getPWAScopePath — vanity domain trigger', () => {
  let savedDeveloperMode

  beforeEach(() => {
    savedDeveloperMode = HAXCMS.developerMode
    HAXCMS.developerMode = false
  })

  afterEach(() => {
    HAXCMS.developerMode = savedDeveloperMode
  })

  test('no domain set -> internal basePath + site.name', () => {
    const site = makeSite({ basePath: '/' })
    assert.equal(site.getPWAScopePath(), '/testsite/')
  })

  test('no domain set with non-root basePath -> normalized internal path', () => {
    const site = makeSite({ basePath: '/myapp', name: 'course1' })
    assert.equal(site.getPWAScopePath(), '/myapp/course1/')
  })

  test('domain set -> root slash', () => {
    const site = makeSite({ domain: 'https://flourish.hhd.psu.edu/' })
    assert.equal(site.getPWAScopePath(), '/')
  })

  test('domain set (no trailing slash) -> root slash', () => {
    const site = makeSite({ domain: 'https://haxtheweb.org' })
    assert.equal(site.getPWAScopePath(), '/')
  })

  test('domain is empty string -> internal basePath', () => {
    const site = makeSite({ domain: '' })
    assert.equal(site.getPWAScopePath(), '/testsite/')
  })

  test('domain is whitespace-only -> internal basePath', () => {
    const site = makeSite({ domain: '   ' })
    assert.equal(site.getPWAScopePath(), '/testsite/')
  })

  test('domain missing entirely (undefined) -> internal basePath', () => {
    const site = makeSite({})
    assert.equal(site.getPWAScopePath(), '/testsite/')
  })
})

describe('getBaseTag — vanity domain scope', () => {
  test('no domain -> base href is internal path', () => {
    const site = makeSite({ basePath: '/' })
    assert.equal(site.getBaseTag(), '<base href="/testsite/" />')
  })

  test('domain set -> base href is root', () => {
    const site = makeSite({ domain: 'https://flourish.hhd.psu.edu/' })
    assert.equal(site.getBaseTag(), '<base href="/" />')
  })
})

describe('getServiceWorkerScript — vanity domain scope', () => {
  let savedDeveloperMode

  beforeEach(() => {
    savedDeveloperMode = HAXCMS.developerMode
    HAXCMS.developerMode = false
  })

  afterEach(() => {
    HAXCMS.developerMode = savedDeveloperMode
  })

  test('no domain -> sitePath is internal path', () => {
    const site = makeSite({ basePath: '/' })
    // null basePath triggers the getPWAScopePath() default fallback.
    const script = site.getServiceWorkerScript(null, true, true)
    assert.ok(script.indexOf('var sitePath = "/testsite/";') !== -1)
  })

  test('domain set -> sitePath is root', () => {
    const site = makeSite({ domain: 'https://haxtheweb.org' })
    const script = site.getServiceWorkerScript(null, true, true)
    assert.ok(script.indexOf('var sitePath = "/";') !== -1)
  })

  test('explicit basePath argument overrides the default fallback', () => {
    const site = makeSite({ domain: 'https://haxtheweb.org' })
    const script = site.getServiceWorkerScript('/custom/scope/', true, true)
    assert.ok(script.indexOf('var sitePath = "/custom/scope/";') !== -1)
  })

  test('addSW false -> disabled comment, no scope', () => {
    const site = makeSite({ domain: 'https://haxtheweb.org' })
    const script = site.getServiceWorkerScript(null, true, false)
    assert.ok(script.indexOf('Service worker disabled') !== -1)
    assert.ok(script.indexOf('sitePath') === -1)
  })
})
