'use strict'

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

// Set CLI mode before requiring HAXCMS so the constructor does not refuse
// to start over default credentials (the singleton is shared process-wide).
process.env.haxcms_middleware = 'node-cli'

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const {
  normalizePathForResponse,
  isMultisiteContext,
  buildFilePublicUrl,
} = require('../../src/lib/siteFileUrl.js')
const { discoverConfigPath } = require('../../src/lib/discoverConfigPath.js')
const {
  platformAllows,
  featureDisabledResponse,
} = require('../../src/lib/platformFeatures.js')

// ---------------------------------------------------------------------------
// siteFileUrl.js
// ---------------------------------------------------------------------------

describe('siteFileUrl — normalizePathForResponse', () => {
  test('forward-slash paths pass through unchanged', () => {
    assert.equal(normalizePathForResponse('files/headshot.jpg'), 'files/headshot.jpg')
    assert.equal(normalizePathForResponse('/files/headshot.jpg'), '/files/headshot.jpg')
    assert.equal(normalizePathForResponse('a/b/c'), 'a/b/c')
  })

  test('non-string inputs are coerced to string', () => {
    assert.equal(normalizePathForResponse(123), '123')
    assert.equal(normalizePathForResponse(null), 'null')
  })

  test('undefined and no-arg produce empty string', () => {
    assert.equal(normalizePathForResponse(undefined), '')
    assert.equal(normalizePathForResponse(), '')
  })
})

describe('siteFileUrl — isMultisiteContext', () => {
  let saved

  beforeEach(() => {
    saved = {
      runtimeServerMode: HAXCMS.runtimeServerMode,
      operatingContext: HAXCMS.operatingContext,
      basePath: HAXCMS.basePath,
      sitesDirectory: HAXCMS.sitesDirectory,
      deploymentProfile: HAXCMS.config && HAXCMS.config.deploymentProfile,
    }
  })

  afterEach(() => {
    HAXCMS.runtimeServerMode = saved.runtimeServerMode
    HAXCMS.operatingContext = saved.operatingContext
    HAXCMS.basePath = saved.basePath
    HAXCMS.sitesDirectory = saved.sitesDirectory
    if (HAXCMS.config) {
      HAXCMS.config.deploymentProfile = saved.deploymentProfile
    }
  })

  test('returns false when runtimeServerMode is single-site', () => {
    HAXCMS.runtimeServerMode = 'single-site'
    assert.equal(isMultisiteContext({}), false)
  })

  test('returns true when runtimeServerMode is multisite', () => {
    HAXCMS.runtimeServerMode = 'multisite'
    assert.equal(isMultisiteContext({}), true)
  })

  test('returns true when operatingContext is multisite', () => {
    HAXCMS.runtimeServerMode = undefined
    HAXCMS.operatingContext = 'multisite'
    assert.equal(isMultisiteContext({}), true)
  })

  test('returns true when deployment profile is self-hosted-multi-site', () => {
    HAXCMS.runtimeServerMode = undefined
    HAXCMS.operatingContext = 'single'
    if (!HAXCMS.config) {
      HAXCMS.config = {}
    }
    HAXCMS.config.deploymentProfile = 'self-hosted-multi-site'
    assert.equal(isMultisiteContext({}), true)
  })

  test('returns true when site.basePath contains the sites directory', () => {
    HAXCMS.runtimeServerMode = undefined
    HAXCMS.operatingContext = 'single'
    if (!HAXCMS.config) {
      HAXCMS.config = {}
    }
    HAXCMS.config.deploymentProfile = 'single-site'
    HAXCMS.sitesDirectory = '_sites'
    const site = { basePath: '/var/www/_sites/mysite' }
    assert.equal(isMultisiteContext(site), true)
  })

  test('returns false when nothing indicates multisite', () => {
    HAXCMS.runtimeServerMode = undefined
    HAXCMS.operatingContext = 'single'
    if (!HAXCMS.config) {
      HAXCMS.config = {}
    }
    HAXCMS.config.deploymentProfile = 'single-site'
    HAXCMS.sitesDirectory = '_sites'
    const site = { basePath: '/var/www/mysite' }
    assert.equal(isMultisiteContext(site), false)
    assert.equal(isMultisiteContext({}), false)
    assert.equal(isMultisiteContext(null), false)
  })
})

describe('siteFileUrl — buildFilePublicUrl', () => {
  let saved

  beforeEach(() => {
    saved = {
      runtimeServerMode: HAXCMS.runtimeServerMode,
      operatingContext: HAXCMS.operatingContext,
      basePath: HAXCMS.basePath,
      sitesDirectory: HAXCMS.sitesDirectory,
      deploymentProfile: HAXCMS.config && HAXCMS.config.deploymentProfile,
    }
  })

  afterEach(() => {
    HAXCMS.runtimeServerMode = saved.runtimeServerMode
    HAXCMS.operatingContext = saved.operatingContext
    HAXCMS.basePath = saved.basePath
    HAXCMS.sitesDirectory = saved.sitesDirectory
    if (HAXCMS.config) {
      HAXCMS.config.deploymentProfile = saved.deploymentProfile
    }
  })

  test('single-site mode produces root-relative URL', () => {
    HAXCMS.runtimeServerMode = 'single-site'
    assert.equal(
      buildFilePublicUrl({}, 'files/headshot.jpg'),
      '/files/headshot.jpg',
    )
  })

  test('single-site mode strips leading slashes from the relative path', () => {
    HAXCMS.runtimeServerMode = 'single-site'
    assert.equal(
      buildFilePublicUrl({}, '/files/headshot.jpg'),
      '/files/headshot.jpg',
    )
    assert.equal(
      buildFilePublicUrl({}, '//files/headshot.jpg'),
      '/files/headshot.jpg',
    )
  })

  test('multisite mode produces basePath/sitesDir/siteName/path URL', () => {
    HAXCMS.runtimeServerMode = 'multisite'
    HAXCMS.basePath = '/'
    HAXCMS.sitesDirectory = '_sites'
    const site = {
      manifest: { metadata: { site: { name: 'mysite' } } },
    }
    assert.equal(
      buildFilePublicUrl(site, 'files/headshot.jpg'),
      '/_sites/mysite/files/headshot.jpg',
    )
  })

  test('multisite mode with non-root basePath', () => {
    HAXCMS.runtimeServerMode = 'multisite'
    HAXCMS.basePath = '/myapp/'
    HAXCMS.sitesDirectory = '_sites'
    const site = {
      manifest: { metadata: { site: { name: 'course1' } } },
    }
    assert.equal(
      buildFilePublicUrl(site, 'files/report.pdf'),
      '/myapp/_sites/course1/files/report.pdf',
    )
  })

  test('multisite mode strips leading slashes from the relative path', () => {
    HAXCMS.runtimeServerMode = 'multisite'
    HAXCMS.basePath = '/'
    HAXCMS.sitesDirectory = '_sites'
    const site = {
      manifest: { metadata: { site: { name: 'mysite' } } },
    }
    assert.equal(
      buildFilePublicUrl(site, '/files/headshot.jpg'),
      '/_sites/mysite/files/headshot.jpg',
    )
  })
})

// ---------------------------------------------------------------------------
// discoverConfigPath.js
// ---------------------------------------------------------------------------

describe('discoverConfigPath — basic export', () => {
  test('exports a non-empty string path', () => {
    assert.equal(typeof discoverConfigPath, 'string')
    assert.ok(discoverConfigPath.length > 0)
  })

  test('the discovered directory exists on disk', () => {
    assert.ok(
      fs.pathExistsSync(discoverConfigPath),
      'expected ' + discoverConfigPath + ' to exist',
    )
  })

  test('the discovered directory has a tmp/ subdirectory', () => {
    assert.ok(fs.pathExistsSync(path.join(discoverConfigPath, 'tmp')))
  })

  test('the discovered directory has a settings/ subdirectory', () => {
    assert.ok(fs.pathExistsSync(path.join(discoverConfigPath, 'settings')))
  })
})

describe('discoverConfigPath — cwd walk-up discovery', () => {
  test('finds _config with .isHAXcmsConfig marker by walking up from cwd', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-dc-'))
    try {
      const configDir = path.join(tmpBase, 'myproject', '_config')
      const workingDir = path.join(tmpBase, 'myproject', 'subdir')
      fs.mkdirSync(configDir, { recursive: true })
      fs.mkdirSync(workingDir, { recursive: true })
      fs.writeFileSync(path.join(configDir, '.isHAXcmsConfig'), '')

      const modulePath = path.resolve(__dirname, '../../src/lib/discoverConfigPath.js')
      const script = [
        'process.chdir(' + JSON.stringify(workingDir) + ');',
        'var m = require(' + JSON.stringify(modulePath) + ');',
        'process.stdout.write(m.discoverConfigPath);',
      ].join('\n')

      const result = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
      })

      assert.equal(result.status, 0, 'child process failed: ' + result.stderr)
      assert.equal(result.stdout, configDir)
    } finally {
      fs.removeSync(tmpBase)
    }
  })
})

// ---------------------------------------------------------------------------
// platformFeatures.js
// ---------------------------------------------------------------------------

describe('platformFeatures — platformAllows', () => {
  test('returns true (allow) when site has no platform metadata', () => {
    assert.equal(platformAllows(null, 'uploadMedia'), true)
    assert.equal(platformAllows({}, 'uploadMedia'), true)
    assert.equal(platformAllows({ manifest: {} }, 'uploadMedia'), true)
    assert.equal(
      platformAllows({ manifest: { metadata: {} } }, 'uploadMedia'),
      true,
    )
    assert.equal(
      platformAllows({ manifest: { metadata: { platform: null } } }, 'uploadMedia'),
      true,
    )
  })

  test('returns true when platform exists but the capability is not set', () => {
    const site = {
      manifest: { metadata: { platform: { uploadMedia: true } } },
    }
    assert.equal(platformAllows(site, 'deletePage'), true)
  })

  test('returns false when the capability is explicitly false', () => {
    const site = {
      manifest: { metadata: { platform: { uploadMedia: false } } },
    }
    assert.equal(platformAllows(site, 'uploadMedia'), false)
  })

  test('returns true when the capability is explicitly true', () => {
    const site = {
      manifest: { metadata: { platform: { uploadMedia: true } } },
    }
    assert.equal(platformAllows(site, 'uploadMedia'), true)
  })

  test('resolves aliases — upload maps to uploadMedia', () => {
    const site = {
      manifest: { metadata: { platform: { upload: false } } },
    }
    assert.equal(platformAllows(site, 'uploadMedia'), false)
  })

  test('resolves aliases — delete maps to deletePage', () => {
    const site = {
      manifest: { metadata: { platform: { delete: false } } },
    }
    assert.equal(platformAllows(site, 'deletePage'), false)
  })

  test('resolves aliases — manifest maps to siteManifest', () => {
    const site = {
      manifest: { metadata: { platform: { manifest: false } } },
    }
    assert.equal(platformAllows(site, 'siteManifest'), false)
  })

  test('non-boolean values are ignored and default to allow', () => {
    const site = {
      manifest: {
        metadata: {
          platform: { uploadMedia: 'false-string' },
        },
      },
    }
    assert.equal(platformAllows(site, 'uploadMedia'), true)
  })

  test('platform.features takes priority over platform root', () => {
    const site = {
      manifest: {
        metadata: {
          platform: {
            features: { uploadMedia: false },
            uploadMedia: true,
          },
        },
      },
    }
    assert.equal(platformAllows(site, 'uploadMedia'), false)
  })

  test('falls through to platform root when features does not set the key', () => {
    const site = {
      manifest: {
        metadata: {
          platform: {
            features: { deletePage: true },
            uploadMedia: false,
          },
        },
      },
    }
    assert.equal(platformAllows(site, 'uploadMedia'), false)
  })

  test('unknown capability with no matching key defaults to allow', () => {
    const site = {
      manifest: { metadata: { platform: { uploadMedia: true } } },
    }
    assert.equal(platformAllows(site, 'totallyUnknownCapability'), true)
  })
})

describe('platformFeatures — featureDisabledResponse', () => {
  function mockRes() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(data) {
        this.body = data
        return data
      },
    }
  }

  test('sends 403 status with a custom message', () => {
    const res = mockRes()
    const result = featureDisabledResponse(res, 'Custom disabled message')
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.status, 403)
    assert.equal(res.body.data.message, 'Custom disabled message')
    // the return value is the JSON payload
    assert.equal(result.status, 403)
    assert.equal(result.data.message, 'Custom disabled message')
  })

  test('sends 403 status with default message when none provided', () => {
    const res = mockRes()
    featureDisabledResponse(res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.status, 403)
    assert.equal(
      res.body.data.message,
      'This operation is disabled for this site',
    )
  })

  test('sends 403 status with default message when message is empty', () => {
    const res = mockRes()
    featureDisabledResponse(res, '')
    assert.equal(
      res.body.data.message,
      'This operation is disabled for this site',
    )
  })
})
