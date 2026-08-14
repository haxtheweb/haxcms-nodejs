'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const media = require('../../src/lib/mediaSettings.js')
const theme = require('../../src/lib/themeSettings.js')
const skeleton = require('../../src/lib/skeletonSettings.js')

// Faithful mirror of HAXCMS.generateMachineName so the settings helpers see the
// real machine-name convention without pulling the entire HAXCMS class into the
// unit test. The haxcms object here is test data (an injected config object),
// not a mocked lib module.
function makeGenerateMachineName() {
  return function generateMachineName(name) {
    if (name === undefined || name === null) {
      return 'default'
    }
    let n = String(name)
    n = n.replace(/\0/g, '')
    try {
      n = decodeURIComponent(n)
    }
    catch (e) {
      // mirror decode failure fallback
    }
    n = n.replace(/\.{2,}/g, '')
    n = n.replace(/[\\\/]/g, '')
    n = n.replace(/[^a-zA-Z0-9_-]+/g, '-')
    n = n.replace(/[-_]{2,}/g, '-')
    n = n.replace(/^[-_]+|[-_]+$/g, '')
    n = n.toLowerCase()
    if (!n) {
      n = 'default'
    }
    return n
  }
}

function makeHaxcms(overrides) {
  return Object.assign(
    {
      generateMachineName: makeGenerateMachineName(),
      configDirectory: '',
      coreConfigPath: '',
      basePath: '/',
      systemRequestBase: 'x/api/',
    },
    overrides || {},
  )
}

function tmpConfigDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ---------------------------------------------------------------------------
// mediaSettings
// ---------------------------------------------------------------------------
describe('mediaSettings.normalizeJpegQuality', () => {
  test('returns null for null, undefined, and empty string', () => {
    assert.equal(media.normalizeJpegQuality(null), null)
    assert.equal(media.normalizeJpegQuality(undefined), null)
    assert.equal(media.normalizeJpegQuality(''), null)
  })

  test('returns null for non-numeric strings', () => {
    assert.equal(media.normalizeJpegQuality('abc'), null)
    assert.equal(media.normalizeJpegQuality('high'), null)
  })

  test('clamps below the minimum of 1 up to the floor', () => {
    assert.equal(media.normalizeJpegQuality(0), 1)
    assert.equal(media.normalizeJpegQuality(-5), 1)
  })

  test('clamps above the maximum of 100 down to the ceiling', () => {
    assert.equal(media.normalizeJpegQuality(150), 100)
    assert.equal(media.normalizeJpegQuality(9999), 100)
  })

  test('passes through in-range integers, including numeric strings', () => {
    assert.equal(media.normalizeJpegQuality(50), 50)
    assert.equal(media.normalizeJpegQuality(100), 100)
    assert.equal(media.normalizeJpegQuality(1), 1)
    assert.equal(media.normalizeJpegQuality('75'), 75)
  })
})

describe('mediaSettings.normalizeMaxUploadSizeMb', () => {
  test('returns null for null, undefined, and empty string', () => {
    assert.equal(media.normalizeMaxUploadSizeMb(null), null)
    assert.equal(media.normalizeMaxUploadSizeMb(undefined), null)
    assert.equal(media.normalizeMaxUploadSizeMb(''), null)
  })

  test('returns null for non-numeric strings', () => {
    assert.equal(media.normalizeMaxUploadSizeMb('big'), null)
  })

  test('clamps below the minimum of 1 up to the floor', () => {
    assert.equal(media.normalizeMaxUploadSizeMb(0), 1)
    assert.equal(media.normalizeMaxUploadSizeMb(-100), 1)
  })

  test('clamps above the maximum of 10240 down to the ceiling', () => {
    assert.equal(media.normalizeMaxUploadSizeMb(99999), 10240)
    assert.equal(media.normalizeMaxUploadSizeMb(50000), 10240)
  })

  test('passes through in-range integers', () => {
    assert.equal(media.normalizeMaxUploadSizeMb(512), 512)
    assert.equal(media.normalizeMaxUploadSizeMb(1), 1)
    assert.equal(media.normalizeMaxUploadSizeMb(10240), 10240)
  })
})

describe('mediaSettings.normalizeAcceptedFormats', () => {
  test('returns null for null and undefined', () => {
    assert.equal(media.normalizeAcceptedFormats(null), null)
    assert.equal(media.normalizeAcceptedFormats(undefined), null)
  })

  test('returns null for non-array, non-string input', () => {
    assert.equal(media.normalizeAcceptedFormats(42), null)
    assert.equal(media.normalizeAcceptedFormats({}), null)
  })

  test('returns null when no valid formats remain', () => {
    assert.equal(media.normalizeAcceptedFormats([]), null)
    assert.equal(media.normalizeAcceptedFormats(''), null)
    assert.equal(media.normalizeAcceptedFormats(',,'), null)
  })

  test('lowercases, trims, strips leading dots, and deduplicates an array', () => {
    assert.equal(
      media.normalizeAcceptedFormats(['JPG', '.PNG', 'png', 'GIF', 'gif']),
      'jpg,png,gif',
    )
  })

  test('splits and normalizes a comma-separated string', () => {
    assert.equal(
      media.normalizeAcceptedFormats('JPG, jpeg , .webp'),
      'jpg,jpeg,webp',
    )
  })

  test('drops entries that are not purely alphanumeric', () => {
    assert.equal(
      media.normalizeAcceptedFormats(['png', 'svg+xml', 'webp']),
      'png,webp',
    )
  })
})

describe('mediaSettings.normalizeMediaSettings', () => {
  test('returns all-null fields for an empty object', () => {
    assert.deepEqual(media.normalizeMediaSettings({}), {
      jpegQuality: null,
      maxUploadSizeMb: null,
      acceptedFormats: null,
    })
  })

  test('returns all-null fields for non-object input', () => {
    assert.deepEqual(media.normalizeMediaSettings(null), {
      jpegQuality: null,
      maxUploadSizeMb: null,
      acceptedFormats: null,
    })
    assert.deepEqual(media.normalizeMediaSettings('nope'), {
      jpegQuality: null,
      maxUploadSizeMb: null,
      acceptedFormats: null,
    })
  })

  test('normalizes each field independently', () => {
    assert.deepEqual(
      media.normalizeMediaSettings({
        jpegQuality: 200,
        maxUploadSizeMb: 0,
        acceptedFormats: 'JPG,PNG',
      }),
      {
        jpegQuality: 100,
        maxUploadSizeMb: 1,
        acceptedFormats: 'jpg,png',
      },
    )
  })
})

describe('mediaSettings.getEffectiveMediaSettings', () => {
  test('fills defaults for null fields', () => {
    assert.deepEqual(media.getEffectiveMediaSettings({}), {
      jpegQuality: 80,
      maxUploadSizeMb: 1024,
      acceptedFormats: 'jpg,jpeg,png,gif,webp,svg',
    })
  })

  test('preserves provided non-null values', () => {
    assert.deepEqual(
      media.getEffectiveMediaSettings({
        jpegQuality: 50,
        maxUploadSizeMb: 100,
        acceptedFormats: 'png',
      }),
      {
        jpegQuality: 50,
        maxUploadSizeMb: 100,
        acceptedFormats: 'png',
      },
    )
  })

  test('DEFAULT_MEDIA_SETTINGS matches the documented defaults', () => {
    assert.deepEqual(media.DEFAULT_MEDIA_SETTINGS, {
      jpegQuality: 80,
      maxUploadSizeMb: 1024,
      acceptedFormats: 'jpg,jpeg,png,gif,webp,svg',
    })
  })
})

describe('mediaSettings.hasSupportedMediaSettingsPayload', () => {
  test('is true when any supported key is present', () => {
    assert.equal(media.hasSupportedMediaSettingsPayload({ jpegQuality: 50 }), true)
    assert.equal(
      media.hasSupportedMediaSettingsPayload({ maxUploadSizeMb: 100 }),
      true,
    )
    assert.equal(
      media.hasSupportedMediaSettingsPayload({ acceptedFormats: 'png' }),
      true,
    )
  })

  test('is false when no supported key is present', () => {
    assert.equal(media.hasSupportedMediaSettingsPayload({}), false)
    assert.equal(
      media.hasSupportedMediaSettingsPayload({ unrelated: true }),
      false,
    )
  })
})

describe('mediaSettings.getMediaSettingsFilePath', () => {
  test('resolves under <configDirectory>/settings/media.json', () => {
    const haxcms = makeHaxcms({ configDirectory: '/tmp/fake-cfg' })
    assert.equal(
      media.getMediaSettingsFilePath(haxcms),
      path.join('/tmp/fake-cfg', 'settings', 'media.json'),
    )
  })

  test('falls back to <cwd>/_config when configDirectory is missing', () => {
    assert.equal(
      media.getMediaSettingsFilePath({}),
      path.join(process.cwd(), '_config', 'settings', 'media.json'),
    )
  })
})

describe('mediaSettings read/write round-trip', () => {
  test('write then read returns the same normalized values', async () => {
    const dir = tmpConfigDir('media-rt-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      const written = await media.writeMediaSettings(haxcms, {
        jpegQuality: 75,
        maxUploadSizeMb: 512,
        acceptedFormats: 'png,jpg',
      })
      assert.deepEqual(written, {
        jpegQuality: 75,
        maxUploadSizeMb: 512,
        acceptedFormats: 'png,jpg',
      })
      const read = await media.readMediaSettings(haxcms)
      assert.deepEqual(read, {
        jpegQuality: 75,
        maxUploadSizeMb: 512,
        acceptedFormats: 'png,jpg',
      })
      const filePath = media.getMediaSettingsFilePath(haxcms)
      const raw = fs.readFileSync(filePath, 'utf8')
      assert.ok(raw.indexOf('"jpegQuality": 75') !== -1)
      assert.ok(raw.indexOf('"maxUploadSizeMb": 512') !== -1)
      assert.ok(raw.indexOf('"acceptedFormats": "png,jpg"') !== -1)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('write clamps out-of-range values before persisting', async () => {
    const dir = tmpConfigDir('media-clamp-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      await media.writeMediaSettings(haxcms, {
        jpegQuality: 200,
        maxUploadSizeMb: 99999,
      })
      const read = await media.readMediaSettings(haxcms)
      assert.equal(read.jpegQuality, 100)
      assert.equal(read.maxUploadSizeMb, 10240)
      assert.equal(read.acceptedFormats, null)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('partial write leaves unmentioned fields as null', async () => {
    const dir = tmpConfigDir('media-partial-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      await media.writeMediaSettings(haxcms, { jpegQuality: 90 })
      const read = await media.readMediaSettings(haxcms)
      assert.deepEqual(read, {
        jpegQuality: 90,
        maxUploadSizeMb: null,
        acceptedFormats: null,
      })
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('read returns all-null defaults when the settings file does not exist', async () => {
    const dir = tmpConfigDir('media-missing-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      const read = await media.readMediaSettings(haxcms)
      assert.deepEqual(read, {
        jpegQuality: null,
        maxUploadSizeMb: null,
        acceptedFormats: null,
      })
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// themeSettings
// ---------------------------------------------------------------------------
describe('themeSettings.normalizeBoolean', () => {
  test('passes through boolean values', () => {
    assert.equal(theme.normalizeBoolean(true), true)
    assert.equal(theme.normalizeBoolean(false), false)
  })

  test('treats non-zero numbers as true and zero as false', () => {
    assert.equal(theme.normalizeBoolean(1), true)
    assert.equal(theme.normalizeBoolean(2), true)
    assert.equal(theme.normalizeBoolean(0), false)
  })

  test('recognizes falsey strings', () => {
    assert.equal(theme.normalizeBoolean('false'), false)
    assert.equal(theme.normalizeBoolean('0'), false)
    assert.equal(theme.normalizeBoolean('off'), false)
    assert.equal(theme.normalizeBoolean('no'), false)
    assert.equal(theme.normalizeBoolean('disabled'), false)
  })

  test('recognizes truthy strings', () => {
    assert.equal(theme.normalizeBoolean('true'), true)
    assert.equal(theme.normalizeBoolean('1'), true)
    assert.equal(theme.normalizeBoolean('on'), true)
    assert.equal(theme.normalizeBoolean('yes'), true)
    assert.equal(theme.normalizeBoolean('enabled'), true)
  })

  test('falls back to the default for unrecognized values', () => {
    assert.equal(theme.normalizeBoolean('maybe'), true)
    assert.equal(theme.normalizeBoolean('maybe', false), false)
    assert.equal(theme.normalizeBoolean(undefined), true)
    assert.equal(theme.normalizeBoolean(undefined, false), false)
  })
})

describe('themeSettings.normalizeMachineNameList', () => {
  test('deduplicates machine names produced by haxcms.generateMachineName', () => {
    const haxcms = makeHaxcms()
    assert.deepEqual(
      theme.normalizeMachineNameList(haxcms, ['My Theme', 'my-theme', 'My Theme!']),
      ['my-theme'],
    )
  })

  test('returns an empty array when haxcms has no generateMachineName', () => {
    assert.deepEqual(theme.normalizeMachineNameList(null, ['x']), [])
  })
})

describe('themeSettings.normalizeEnabledThemeMap', () => {
  test('maps an array of names to a map of <name>: true', () => {
    const haxcms = makeHaxcms()
    assert.deepEqual(
      theme.normalizeEnabledThemeMap(haxcms, ['Theme One', 'theme-two']),
      { 'theme-one': true, 'theme-two': true },
    )
  })

  test('preserves boolean values from an object map', () => {
    const haxcms = makeHaxcms()
    assert.deepEqual(
      theme.normalizeEnabledThemeMap(haxcms, {
        'My Theme': false,
        'Other Theme': true,
      }),
      { 'my-theme': false, 'other-theme': true },
    )
  })

  test('unwraps a nested { enabledThemes: [...] } envelope', () => {
    const haxcms = makeHaxcms()
    assert.deepEqual(
      theme.normalizeEnabledThemeMap(haxcms, { enabledThemes: ['Nested Theme'] }),
      { 'nested-theme': true },
    )
  })
})

describe('themeSettings.isThemeEnabled', () => {
  test('defaults to true when the theme is absent from the map', () => {
    const haxcms = makeHaxcms()
    assert.equal(theme.isThemeEnabled(haxcms, 'absent-theme', {}), true)
  })

  test('is false when the theme is explicitly disabled', () => {
    const haxcms = makeHaxcms()
    assert.equal(
      theme.isThemeEnabled(haxcms, 'my-theme', { 'my-theme': false }),
      false,
    )
  })

  test('is true when the theme is explicitly enabled', () => {
    const haxcms = makeHaxcms()
    assert.equal(
      theme.isThemeEnabled(haxcms, 'my-theme', { 'my-theme': true }),
      true,
    )
  })

  test('defaults to true for an empty machine name', () => {
    const haxcms = makeHaxcms()
    assert.equal(theme.isThemeEnabled(haxcms, '', {}), true)
  })
})

describe('themeSettings.applyDetectedThemeDefaults', () => {
  test('adds missing detected themes and reports changed=true', () => {
    const haxcms = makeHaxcms()
    const result = theme.applyDetectedThemeDefaults(
      haxcms,
      { 'existing-theme': true },
      ['Existing Theme', 'New Theme'],
    )
    assert.deepEqual(result, {
      enabledThemes: { 'existing-theme': true, 'new-theme': true },
      changed: true,
    })
  })

  test('reports changed=false when all detected themes are already present', () => {
    const haxcms = makeHaxcms()
    const result = theme.applyDetectedThemeDefaults(
      haxcms,
      { 'existing-theme': true, 'new-theme': true },
      ['Existing Theme', 'New Theme'],
    )
    assert.equal(result.changed, false)
  })
})

describe('themeSettings theme record helpers', () => {
  test('isThemeHidden reads the hidden flag', () => {
    assert.equal(theme.isThemeHidden({ hidden: true }), true)
    assert.equal(theme.isThemeHidden({ hidden: 'no' }), false)
    assert.equal(theme.isThemeHidden({}), false)
  })

  test('isThemeTerrible is true for the terrible flag or terrible-prefixed names', () => {
    assert.equal(theme.isThemeTerrible({ terrible: true }), true)
    assert.equal(theme.isThemeTerrible({ machineName: 'terrible-thing' }), true)
    assert.equal(theme.isThemeTerrible({ machineName: 'clean-theme' }), false)
  })

  test('getThemeScreenshot prefers screenshot, then thumbnail, then preview', () => {
    assert.equal(theme.getThemeScreenshot({ screenshot: 'a.png' }), 'a.png')
    assert.equal(theme.getThemeScreenshot({ thumbnail: 'b.png' }), 'b.png')
    assert.equal(theme.getThemeScreenshot({}), '')
  })
})

describe('themeSettings.themesToMap', () => {
  test('sorts themes by machineName ascending', () => {
    const map = theme.themesToMap([
      { machineName: 'zeta' },
      { machineName: 'alpha' },
      { machineName: 'mid' },
    ])
    assert.deepEqual(Object.keys(map), ['alpha', 'mid', 'zeta'])
  })

  test('skips entries without a machineName', () => {
    const map = theme.themesToMap([{ machineName: 'only' }, { nope: true }])
    assert.deepEqual(Object.keys(map), ['only'])
  })
})

describe('themeSettings.discoverThemes', () => {
  test('returns registry themes normalized with scope=registry when no path is set', async () => {
    const haxcms = makeHaxcms()
    haxcms.getThemes = function () {
      return {
        'clean-theme': { name: 'Clean Theme', element: 'clean-theme' },
        'terrible-thing': { name: 'Terrible Thing', element: 'terrible-thing' },
      }
    }
    const found = await theme.discoverThemes(haxcms)
    assert.equal(found.length, 2)
    const byName = {}
    for (let i = 0; i < found.length; i++) {
      byName[found[i].machineName] = found[i]
    }
    assert.equal(byName['clean-theme'].scope, 'registry')
    assert.equal(byName['clean-theme'].element, 'clean-theme')
    assert.equal(byName['clean-theme'].name, 'Clean Theme')
    assert.equal(byName['clean-theme'].hidden, false)
    assert.equal(byName['clean-theme'].terrible, false)
    assert.equal(byName['terrible-thing'].terrible, true)
  })

  test('propagates the hidden flag from the source theme', async () => {
    const haxcms = makeHaxcms()
    haxcms.getThemes = function () {
      return { 'secret-theme': { name: 'Secret', hidden: true } }
    }
    const found = await theme.discoverThemes(haxcms)
    assert.equal(found.length, 1)
    assert.equal(found[0].hidden, true)
  })
})

describe('themeSettings read/write round-trip', () => {
  test('write then read returns the same enabled map', async () => {
    const dir = tmpConfigDir('theme-rt-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      const written = await theme.writeEnabledThemeMap(haxcms, [
        'Theme One',
        'Theme Two',
      ])
      assert.deepEqual(written, {
        'theme-one': true,
        'theme-two': true,
      })
      const read = await theme.readEnabledThemeMap(haxcms)
      assert.deepEqual(read, {
        'theme-one': true,
        'theme-two': true,
      })
      const filePath = theme.getEnabledThemesFilePath(haxcms)
      const raw = fs.readFileSync(filePath, 'utf8')
      assert.ok(raw.indexOf('"enabledThemes"') !== -1)
      assert.ok(raw.indexOf('"theme-one": true') !== -1)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('persists and reads back explicitly disabled themes', async () => {
    const dir = tmpConfigDir('theme-false-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      await theme.writeEnabledThemeMap(haxcms, {
        'enabled-theme': true,
        'disabled-theme': false,
      })
      const read = await theme.readEnabledThemeMap(haxcms)
      assert.deepEqual(read, {
        'disabled-theme': false,
        'enabled-theme': true,
      })
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('read returns an empty map when the file does not exist', async () => {
    const dir = tmpConfigDir('theme-missing-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      const read = await theme.readEnabledThemeMap(haxcms)
      assert.deepEqual(read, {})
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// skeletonSettings
// ---------------------------------------------------------------------------
describe('skeletonSettings.normalizeEnabledSkeletonMap', () => {
  test('maps an array of names to a map of <name>: true', () => {
    const haxcms = makeHaxcms()
    assert.deepEqual(
      skeleton.normalizeEnabledSkeletonMap(haxcms, [
        'Course Skeleton',
        'blog-skeleton',
      ]),
      { 'course-skeleton': true, 'blog-skeleton': true },
    )
  })

  test('preserves boolean values from an object map', () => {
    const haxcms = makeHaxcms()
    assert.deepEqual(
      skeleton.normalizeEnabledSkeletonMap(haxcms, {
        'active-skel': true,
        'inactive-skel': false,
      }),
      { 'active-skel': true, 'inactive-skel': false },
    )
  })
})

describe('skeletonSettings.isSkeletonEnabled', () => {
  test('defaults to true when absent from the map', () => {
    const haxcms = makeHaxcms()
    assert.equal(skeleton.isSkeletonEnabled(haxcms, 'absent', {}), true)
  })

  test('is false when explicitly disabled', () => {
    const haxcms = makeHaxcms()
    assert.equal(
      skeleton.isSkeletonEnabled(haxcms, 'course-skeleton', {
        'course-skeleton': false,
      }),
      false,
    )
  })
})

describe('skeletonSettings.applyDetectedSkeletonDefaults', () => {
  test('adds missing detected skeletons and reports changed=true', () => {
    const haxcms = makeHaxcms()
    const result = skeleton.applyDetectedSkeletonDefaults(
      haxcms,
      { 'existing-skel': true },
      ['Existing Skel', 'Fresh Skel'],
    )
    assert.deepEqual(result, {
      enabledSkeletons: { 'existing-skel': true, 'fresh-skel': true },
      changed: true,
    })
  })
})

describe('skeletonSettings.getEnabledSkeletonsFilePath', () => {
  test('resolves under <configDirectory>/settings/enabledSkeletons.json', () => {
    const haxcms = makeHaxcms({ configDirectory: '/tmp/fake-cfg' })
    assert.equal(
      skeleton.getEnabledSkeletonsFilePath(haxcms),
      path.join('/tmp/fake-cfg', 'settings', 'enabledSkeletons.json'),
    )
  })
})

describe('skeletonSettings discoverSkeletons', () => {
  test('discovers json skeletons with metadata from config and core scopes', async () => {
    const configDir = tmpConfigDir('skel-disc-cfg-')
    const coreDir = tmpConfigDir('skel-disc-core-')
    const haxcms = makeHaxcms({
      configDirectory: configDir,
      coreConfigPath: coreDir,
    })
    try {
      const configSkelDir = path.join(configDir, 'skeletons')
      const coreSkelDir = path.join(coreDir, 'skeletons')
      fs.mkdirSync(configSkelDir, { recursive: true })
      fs.mkdirSync(coreSkelDir, { recursive: true })

      fs.writeFileSync(
        path.join(configSkelDir, 'course-template.json'),
        JSON.stringify({
          meta: {
            useCaseTitle: 'Course Template',
            useCaseDescription: 'A course skeleton',
            useCaseImage: 'course.png',
            priority: 5,
            category: ['course', 'higher-ed'],
            attributes: ['has-syllabus'],
            sourceUrl: 'https://demo.example',
          },
        }),
      )
      fs.writeFileSync(
        path.join(configSkelDir, 'blog-starter.json'),
        JSON.stringify({ meta: { name: 'Blog Starter' } }),
      )
      // should be skipped: reserved name
      fs.writeFileSync(
        path.join(coreSkelDir, 'default-starter.json'),
        JSON.stringify({ meta: { name: 'Default' } }),
      )
      // should be skipped: invalid json
      fs.writeFileSync(path.join(configSkelDir, 'broken.json'), '{ not json')
      // should be skipped: wrong extension
      fs.writeFileSync(path.join(configSkelDir, 'notes.txt'), 'nope')

      const found = await skeleton.discoverSkeletons(haxcms)
      const byName = {}
      for (let i = 0; i < found.length; i++) {
        byName[found[i].machineName] = found[i]
      }
      assert.deepEqual(Object.keys(byName).sort(), [
        'blog-starter',
        'course-template',
      ])

      const course = byName['course-template']
      assert.equal(course.title, 'Course Template')
      assert.equal(course.description, 'A course skeleton')
      assert.equal(course.image, 'course.png')
      assert.equal(course.priority, 5)
      assert.deepEqual(course.category, ['course', 'higher-ed'])
      assert.deepEqual(course.attributes, ['has-syllabus'])
      assert.equal(course['demo-url'], 'https://demo.example')
      assert.equal(course.scope, 'config')
      assert.equal(course.machineName, 'course-template')
      assert.equal(course['machine-name'], 'course-template')
      assert.equal(
        course['skeleton-url'],
        '/x/api/v1/skeletons/course-template',
      )

      const blog = byName['blog-starter']
      assert.equal(blog.title, 'Blog Starter')
      assert.equal(blog.description, '')
      assert.equal(blog.image, '')
      assert.equal(blog.priority, 0)
      assert.deepEqual(blog.category, [])
      assert.deepEqual(blog.attributes, [])
      assert.equal(blog['demo-url'], '#')
      assert.equal(blog.scope, 'config')
    }
    finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(coreDir, { recursive: true, force: true })
    }
  })
})

describe('skeletonSettings read/write round-trip', () => {
  test('write then read returns the same enabled map', async () => {
    const dir = tmpConfigDir('skel-rt-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      const written = await skeleton.writeEnabledSkeletonMap(haxcms, [
        'Course Skeleton',
        'Blog Skeleton',
      ])
      assert.deepEqual(written, {
        'course-skeleton': true,
        'blog-skeleton': true,
      })
      const read = await skeleton.readEnabledSkeletonMap(haxcms)
      assert.deepEqual(read, {
        'course-skeleton': true,
        'blog-skeleton': true,
      })
      const filePath = skeleton.getEnabledSkeletonsFilePath(haxcms)
      const raw = fs.readFileSync(filePath, 'utf8')
      assert.ok(raw.indexOf('"enabledSkeletons"') !== -1)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('persists and reads back explicitly disabled skeletons', async () => {
    const dir = tmpConfigDir('skel-false-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      await skeleton.writeEnabledSkeletonMap(haxcms, {
        'on-skel': true,
        'off-skel': false,
      })
      const read = await skeleton.readEnabledSkeletonMap(haxcms)
      assert.deepEqual(read, { 'off-skel': false, 'on-skel': true })
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('read returns an empty map when the file does not exist', async () => {
    const dir = tmpConfigDir('skel-missing-')
    const haxcms = makeHaxcms({ configDirectory: dir })
    try {
      const read = await skeleton.readEnabledSkeletonMap(haxcms)
      assert.deepEqual(read, {})
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
