'use strict'

// Unit tests for the language registry helpers and the /languages routes
// (languagesList, getLanguage, languageTranslations). Translations are read
// from a temp packages folder shaped like build/es6/node_modules/@haxtheweb.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const registry = require('../../src/lib/languageRegistry.js')
const translations = require('../../src/lib/languageTranslations.js')
const languagesList = require('../../src/systemRoutes/v1/routes/languagesList.js')
const getLanguage = require('../../src/systemRoutes/v1/routes/getLanguage.js')
const languageTranslations = require('../../src/systemRoutes/v1/routes/languageTranslations.js')
const { SystemV1AdminRoutes } = require('../../src/lib/SystemRoutesMap.js')

function stubRes() {
  return {
    statusCode: 200,
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

describe('languageRegistry', () => {
  test('matches codes, aliases and underscore forms', () => {
    assert.equal(registry.matchLanguageCode('en'), 'en')
    assert.equal(registry.matchLanguageCode('EN_us'), 'en-US')
    assert.equal(registry.matchLanguageCode('zh_CN'), 'zh-CN')
    assert.equal(registry.matchLanguageCode('zh'), 'zh-CN')
    assert.equal(registry.matchLanguageCode('no'), 'nb')
    assert.equal(registry.matchLanguageCode('fil'), 'tl')
    assert.equal(registry.matchLanguageCode('iw'), 'he')
  })

  test('never drops a region and returns null for unknown values', () => {
    assert.equal(registry.matchLanguageCode('fr-CA'), null)
    assert.equal(registry.matchLanguageCode('xx'), null)
    assert.equal(registry.matchLanguageCode(''), null)
    assert.equal(registry.matchLanguageCode(null), null)
    assert.equal(registry.matchLanguageCode(5), null)
  })

  test('getLanguage returns the entry with its canonical code', () => {
    const zh = registry.getLanguage('zh_CN')
    assert.equal(zh.code, 'zh-CN')
    assert.equal(zh.locale, 'zh')
    assert.equal(registry.getLanguage('nope'), null)
  })

  test('listLanguages filters regional variants and sorts by name', () => {
    const all = registry.listLanguages('all')
    const featured = registry.listLanguages('featured')
    const none = registry.listLanguages('none')
    assert.ok(none.length > 100)
    assert.ok(none.every((l) => !l.parent))
    assert.ok(featured.length >= none.length && featured.length <= all.length)
    assert.ok(all.some((l) => l.code === 'en-GB'))
    assert.ok(!none.some((l) => l.code === 'en-GB'))
    const names = none.map((l) => l.name)
    assert.deepEqual(
      names,
      names.slice().sort((a, b) => a.localeCompare(b, 'en')),
    )
  })

  test('the 10 most common languages are ranked', () => {
    const ranked = registry
      .listLanguages('none')
      .filter((l) => typeof l.popular === 'number')
      .sort((a, b) => a.popular - b.popular)
      .map((l) => l.code)
    assert.deepEqual(ranked, [
      'en', 'zh-CN', 'hi', 'es', 'fr', 'ar', 'pt', 'bn', 'ru', 'ja',
    ])
  })
})

describe('languages routes', () => {
  test('routes are registered as authenticated', () => {
    assert.ok(SystemV1AdminRoutes.includes('languages'))
    assert.ok(SystemV1AdminRoutes.includes('languages/:code'))
    assert.ok(SystemV1AdminRoutes.includes('languages/:code/translations'))
  })

  test('GET /languages lists and honors ?regions=', async () => {
    const res = stubRes()
    await languagesList({ query: {} }, res)
    assert.equal(res.body.status, 200)
    assert.ok(res.body.data.some((l) => l.code === 'pt-BR'))
    const none = stubRes()
    await languagesList({ query: { regions: 'none' } }, none)
    assert.ok(!none.body.data.some((l) => l.code === 'pt-BR'))
    const bad = stubRes()
    await languagesList({ query: { regions: 'bogus' } }, bad)
    assert.equal(bad.body.data.length, res.body.data.length)
  })

  test('GET /languages/:code resolves aliases and 404s unknown', async () => {
    const res = stubRes()
    await getLanguage({ params: { code: 'iw' } }, res)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.code, 'he')
    assert.equal(res.body.data.dir, 'rtl')
    const missing = stubRes()
    await getLanguage({ params: { code: 'xx' } }, missing)
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.body.data.message, 'Language not found')
  })
})

describe('translations', () => {
  function makeRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-trans-'))
    t.after(() => fs.removeSync(root))
    const put = (pkg, file, data) => {
      fs.outputFileSync(path.join(root, pkg, 'locales', file), data)
    }
    put('video-player', 'video-player.es.json', JSON.stringify({ play: 'Reproducir' }))
    put('video-player', 'video-player.haxProperties.es.json', JSON.stringify({ title: 'Video' }))
    put('video-player', 'video-player.fr.json', JSON.stringify({ play: 'Lire' }))
    put('a11y-tabs', 'a11y-tabs.es.json', JSON.stringify({ tab: 'Pestaña' }))
    put('a11y-tabs', 'broken.es.json', '{not json')
    put('a11y-tabs', 'list.es.json', '[1,2]')
    return root
  }

  test('collects every namespace for a locale and skips bad files', async (t) => {
    const root = makeRoot(t)
    const out = await translations.collectTranslations({ locale: 'es', packagesRoot: root })
    assert.equal(out.count, 3)
    assert.deepEqual(Object.keys(out.namespaces).sort(), [
      'a11y-tabs', 'video-player', 'video-player.haxProperties',
    ])
    const vp = out.namespaces['video-player']
    assert.equal(vp.type, 'ui')
    assert.equal(vp.package, '@haxtheweb/video-player')
    assert.equal(vp.strings.play, 'Reproducir')
    assert.equal(out.namespaces['video-player.haxProperties'].type, 'schema')
  })

  test('filters by namespace and type', async (t) => {
    const root = makeRoot(t)
    const one = await translations.collectTranslations({
      locale: 'es', namespace: 'video-player', packagesRoot: root,
    })
    assert.deepEqual(Object.keys(one.namespaces).sort(), [
      'video-player', 'video-player.haxProperties',
    ])
    const ui = await translations.collectTranslations({
      locale: 'es', type: 'ui', packagesRoot: root,
    })
    assert.equal(ui.count, 2)
    const schema = await translations.collectTranslations({
      locale: 'es', type: 'schema', packagesRoot: root,
    })
    assert.deepEqual(Object.keys(schema.namespaces), ['video-player.haxProperties'])
  })

  test('unsafe locale or missing root yields nothing', async () => {
    const a = await translations.collectTranslations({ locale: '../x' })
    assert.equal(a.count, 0)
    const b = await translations.collectTranslations({
      locale: 'es', packagesRoot: path.join(os.tmpdir(), 'does-not-exist-xyz'),
    })
    assert.equal(b.count, 0)
    assert.equal(translations.isSafeName('video-player'), true)
    assert.equal(translations.isSafeName('../etc'), false)
    assert.equal(translations.isSafeName('a/b'), false)
  })

  test('route validates inputs', async () => {
    const missing = stubRes()
    await languageTranslations({ params: { code: 'xx' }, query: {} }, missing)
    assert.equal(missing.statusCode, 404)
    const badNs = stubRes()
    await languageTranslations({ params: { code: 'es' }, query: { namespace: '../x' } }, badNs)
    assert.equal(badNs.statusCode, 400)
    const badType = stubRes()
    await languageTranslations({ params: { code: 'es' }, query: { type: 'zzz' } }, badType)
    assert.equal(badType.statusCode, 400)
  })

  test('route returns the language, locale and namespaces', async () => {
    const res = stubRes()
    await languageTranslations(
      { params: { code: 'zh_CN' }, query: { namespace: 'video-player' } },
      res,
    )
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.language.code, 'zh-CN')
    assert.equal(res.body.data.locale, 'zh')
    assert.equal(typeof res.body.data.count, 'number')
    assert.ok(res.body.data.count >= 1)
    assert.ok(res.body.data.namespaces['video-player'])
  })
})
