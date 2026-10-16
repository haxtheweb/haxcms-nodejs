'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')

const {
  SUPPORTED_API_KEY_PROVIDERS,
  normalizeApiKeys,
  hasSupportedApiKeyPayload,
  readApiKeys,
  readConfigApiKeys,
  readEffectiveApiKeys,
  writeApiKeys,
  getApiKeysFilePath,
} = require('../../src/lib/apiKeys.js')

function mkTempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-apikeys-'))
}

const EMPTY_KEYS = {
  youtube: '',
  vimeo: '',
  giphy: '',
  unsplash: '',
  flickr: '',
  anthropic: '',
}

test('SUPPORTED_API_KEY_PROVIDERS lists the six known providers', () => {
  assert.deepEqual(SUPPORTED_API_KEY_PROVIDERS, [
    'youtube',
    'vimeo',
    'giphy',
    'unsplash',
    'flickr',
    'anthropic',
  ])
})

test('normalizeApiKeys fills every supported provider and trims string values', () => {
  const result = normalizeApiKeys({
    youtube: '  yt-key  ',
    vimeo: 'vm-key',
    giphy: null,
    unsplash: 12345,
    flickr: undefined,
    anthropic: 'ant-key  ',
    notAProvider: 'dropped',
  })
  assert.equal(result.youtube, 'yt-key')
  assert.equal(result.vimeo, 'vm-key')
  assert.equal(result.giphy, '')
  assert.equal(result.unsplash, '12345')
  assert.equal(result.flickr, '')
  assert.equal(result.anthropic, 'ant-key')
  assert.equal(result.notAProvider, undefined)
  for (const p of SUPPORTED_API_KEY_PROVIDERS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(result, p),
      'expected key ' + p + ' to be present',
    )
  }
})

test('normalizeApiKeys returns empty defaults for non-object input', () => {
  assert.deepEqual(normalizeApiKeys(), { ...EMPTY_KEYS })
  assert.deepEqual(normalizeApiKeys(null), { ...EMPTY_KEYS })
  assert.deepEqual(normalizeApiKeys([]), { ...EMPTY_KEYS })
  assert.deepEqual(normalizeApiKeys('string'), { ...EMPTY_KEYS })
})

test('hasSupportedApiKeyPayload is true when any supported provider key is present', () => {
  assert.equal(hasSupportedApiKeyPayload({ youtube: 'key' }), true)
  assert.equal(hasSupportedApiKeyPayload({ anthropic: '' }), true)
  assert.equal(hasSupportedApiKeyPayload({ anthropic: undefined }), true)
})

test('hasSupportedApiKeyPayload is false when no supported provider key is present', () => {
  assert.equal(hasSupportedApiKeyPayload({ unknownProvider: 'key' }), false)
  assert.equal(hasSupportedApiKeyPayload({}), false)
  assert.equal(hasSupportedApiKeyPayload(), false)
  assert.equal(hasSupportedApiKeyPayload(null), false)
  assert.equal(hasSupportedApiKeyPayload([]), false)
})

test('getApiKeysFilePath joins configDirectory with settings/apiKeys.json', () => {
  const tmpDir = mkTempConfigDir()
  try {
    assert.equal(
      getApiKeysFilePath({ configDirectory: tmpDir }),
      path.join(tmpDir, 'settings', 'apiKeys.json'),
    )
  } finally {
    fs.removeSync(tmpDir)
  }
})

test('getApiKeysFilePath falls back to cwd/_config when configDirectory is missing', () => {
  assert.equal(
    getApiKeysFilePath({}),
    path.join(process.cwd(), '_config', 'settings', 'apiKeys.json'),
  )
  assert.equal(
    getApiKeysFilePath(null),
    path.join(process.cwd(), '_config', 'settings', 'apiKeys.json'),
  )
  assert.equal(
    getApiKeysFilePath({ configDirectory: 42 }),
    path.join(process.cwd(), '_config', 'settings', 'apiKeys.json'),
  )
})

test('writeApiKeys then readApiKeys round-trips supported keys', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const haxcms = { configDirectory: tmpDir }
    const written = await writeApiKeys(haxcms, {
      youtube: 'yt-secret',
      vimeo: 'vm-secret',
      anthropic: 'ant-secret',
      bogus: 'ignored',
    })
    assert.equal(written.youtube, 'yt-secret')
    assert.equal(written.vimeo, 'vm-secret')
    assert.equal(written.anthropic, 'ant-secret')
    assert.equal(written.bogus, undefined)

    const read = await readApiKeys(haxcms)
    assert.equal(read.youtube, 'yt-secret')
    assert.equal(read.vimeo, 'vm-secret')
    assert.equal(read.anthropic, 'ant-secret')
    assert.equal(read.giphy, '')
    assert.equal(read.unsplash, '')
    assert.equal(read.flickr, '')
  } finally {
    fs.removeSync(tmpDir)
  }
})

test('writeApiKeys writes pretty-printed JSON with trailing newline', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const haxcms = { configDirectory: tmpDir }
    await writeApiKeys(haxcms, { youtube: 'k1', vimeo: 'k2' })
    const raw = fs.readFileSync(getApiKeysFilePath(haxcms), 'utf8')
    assert.equal(
      raw,
      [
        '{',
        '  "youtube": "k1",',
        '  "vimeo": "k2",',
        '  "giphy": "",',
        '  "unsplash": "",',
        '  "flickr": "",',
        '  "anthropic": ""',
        '}',
        '',
      ].join('\n'),
    )
  } finally {
    fs.removeSync(tmpDir)
  }
})

test('readApiKeys returns empty defaults when file does not exist', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const read = await readApiKeys({ configDirectory: tmpDir })
    assert.deepEqual(read, { ...EMPTY_KEYS })
  } finally {
    fs.removeSync(tmpDir)
  }
})

test('readApiKeys returns empty defaults when JSON is corrupt', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const haxcms = { configDirectory: tmpDir }
    const filePath = getApiKeysFilePath(haxcms)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'not valid json {{{')
    const read = await readApiKeys(haxcms)
    assert.deepEqual(read, { ...EMPTY_KEYS })
  } finally {
    fs.removeSync(tmpDir)
  }
})

test('readConfigApiKeys normalizes keys from haxcms.config.appStore.apiKeys', () => {
  const haxcms = {
    config: {
      appStore: {
        apiKeys: { youtube: 'cfg-yt', vimeo: '  cfg-vm  ' },
      },
    },
  }
  const result = readConfigApiKeys(haxcms)
  assert.equal(result.youtube, 'cfg-yt')
  assert.equal(result.vimeo, 'cfg-vm')
  assert.equal(result.giphy, '')
})

test('readConfigApiKeys returns empty defaults when config path is missing', () => {
  assert.deepEqual(readConfigApiKeys({}), { ...EMPTY_KEYS })
  assert.deepEqual(readConfigApiKeys(null), { ...EMPTY_KEYS })
  assert.deepEqual(
    readConfigApiKeys({ config: {} }),
    { ...EMPTY_KEYS },
  )
  assert.deepEqual(
    readConfigApiKeys({ config: { appStore: {} } }),
    { ...EMPTY_KEYS },
  )
})

test('readEffectiveApiKeys merges config and file — file wins when non-empty', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const haxcms = {
      configDirectory: tmpDir,
      config: {
        appStore: {
          apiKeys: {
            youtube: 'cfg-yt',
            vimeo: 'cfg-vm',
            giphy: 'cfg-gp',
          },
        },
      },
    }
    await writeApiKeys(haxcms, { youtube: 'file-yt', vimeo: '' })
    const effective = await readEffectiveApiKeys(haxcms)
    assert.equal(effective.youtube, 'file-yt')
    assert.equal(effective.vimeo, 'cfg-vm')
    assert.equal(effective.giphy, 'cfg-gp')
  } finally {
    fs.removeSync(tmpDir)
  }
})

test('readEffectiveApiKeys returns config keys when file is missing', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const haxcms = {
      configDirectory: tmpDir,
      config: {
        appStore: {
          apiKeys: { youtube: 'cfg-yt', vimeo: 'cfg-vm' },
        },
      },
    }
    const effective = await readEffectiveApiKeys(haxcms)
    assert.equal(effective.youtube, 'cfg-yt')
    assert.equal(effective.vimeo, 'cfg-vm')
    assert.equal(effective.anthropic, '')
  } finally {
    fs.removeSync(tmpDir)
  }
})

test('readEffectiveApiKeys returns empty defaults when neither config nor file exists', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const effective = await readEffectiveApiKeys({ configDirectory: tmpDir })
    assert.deepEqual(effective, { ...EMPTY_KEYS })
  } finally {
    fs.removeSync(tmpDir)
  }
})

// Security (review 2026-10): apiKeys.json must be written 0600 (mirrors PHP
// APIKeysService SEC-10), including tightening a pre-existing 0644 file.
test('writeApiKeys writes apiKeys.json with mode 0600', { skip: process.platform === 'win32' }, async () => {
  const tmpDir = mkTempConfigDir()
  const oldUmask = process.umask(0o022)
  try {
    const haxcms = { configDirectory: tmpDir }
    const filePath = getApiKeysFilePath(haxcms)
    fs.ensureDirSync(path.dirname(filePath))
    fs.writeFileSync(filePath, '{}\n', { mode: 0o644 })
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o644)
    await writeApiKeys(haxcms, { youtube: 'secret' })
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
    fs.removeSync(filePath)
    await writeApiKeys(haxcms, { youtube: 'secret' })
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  } finally {
    process.umask(oldUmask)
    fs.removeSync(tmpDir)
  }
})

test('writeApiKeys uses the HAXCMS secret-file helpers when available', async () => {
  const tmpDir = mkTempConfigDir()
  try {
    const calls = []
    const haxcms = {
      configDirectory: tmpDir,
      writeSecretFile(p, d) { calls.push(['write', p]); fs.writeFileSync(p, d, { mode: 0o600 }) },
      chmodSecretFile(p) { calls.push(['chmod', p]) },
    }
    await writeApiKeys(haxcms, { vimeo: 'v' })
    const filePath = getApiKeysFilePath(haxcms)
    assert.deepEqual(calls, [['write', filePath], ['chmod', filePath]])
    assert.equal((await readApiKeys(haxcms)).vimeo, 'v')
  } finally {
    fs.removeSync(tmpDir)
  }
})
