'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  loadSystemConfig,
  minimalConfig,
} = require('../../src/lib/loadSystemConfig.js')

const BOILERPLATE = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'boilerplate',
  'systemsetup',
  'config.json',
)

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-config-'))
}

// collect log output instead of writing to stderr during the run
function collector() {
  const lines = []
  const log = (msg) => lines.push(String(msg))
  return { lines, log }
}

function writeConfig(dir, contents) {
  fs.writeFileSync(path.join(dir, 'config.json'), contents)
}

describe('loadSystemConfig', () => {
  test('reads a valid config from disk', () => {
    const dir = tmpDir()
    writeConfig(dir, JSON.stringify({ themes: { a: 1 }, custom: 'kept' }))
    const { log, lines } = collector()

    const result = loadSystemConfig(dir, { log })

    assert.equal(result.source, 'file')
    assert.equal(result.reason, null)
    assert.equal(result.config.custom, 'kept')
    assert.deepEqual(lines, [], 'a healthy load should log nothing')
  })

  test('restores boilerplate onto disk when config.json is missing', () => {
    const dir = tmpDir()
    const { log } = collector()

    const result = loadSystemConfig(dir, { log })

    assert.equal(result.source, 'file')
    assert.ok(
      fs.existsSync(path.join(dir, 'config.json')),
      'missing config should be written back to disk',
    )
    assert.ok(result.config.themes, 'restored config should have real shape')
  })

  test('does not throw or crash on a corrupt config.json', () => {
    const dir = tmpDir()
    writeConfig(dir, '{ "site": { "settings": ')
    const { log, lines } = collector()

    const result = loadSystemConfig(dir, { log })

    assert.equal(result.reason, 'corrupt')
    assert.equal(result.source, 'boilerplate')
    assert.ok(result.config && typeof result.config === 'object')
    assert.match(lines.join('\n'), /could not be parsed/)
  })

  test('leaves a corrupt config.json untouched so hand edits survive', () => {
    const dir = tmpDir()
    const original = '{ "site": { "apiKey": "do-not-clobber" '
    writeConfig(dir, original)
    const { log } = collector()

    loadSystemConfig(dir, { log })

    assert.equal(
      fs.readFileSync(path.join(dir, 'config.json'), 'utf8'),
      original,
      'a present-but-corrupt file must never be overwritten',
    )
  })

  test('falls back in memory on an empty config.json', () => {
    const dir = tmpDir()
    writeConfig(dir, '')
    const { log, lines } = collector()

    const result = loadSystemConfig(dir, { log })

    assert.equal(result.reason, 'empty')
    assert.equal(result.source, 'boilerplate')
    assert.match(lines.join('\n'), /is empty/)
  })

  test('falls back when config.json holds JSON that is not an object', () => {
    const dir = tmpDir()
    writeConfig(dir, '[1, 2, 3]')
    const { log, lines } = collector()

    const result = loadSystemConfig(dir, { log })

    assert.equal(result.reason, 'not-an-object')
    assert.equal(result.source, 'boilerplate')
    assert.match(lines.join('\n'), /did not contain a JSON object/)
  })

  test('does not carry the boilerplate deploymentProfile into a degraded boot', () => {
    const dir = tmpDir()
    writeConfig(dir, 'not json at all')
    const { log } = collector()

    const boilerplate = JSON.parse(fs.readFileSync(BOILERPLATE, 'utf8'))
    assert.ok(
      boilerplate.deploymentProfile,
      'boilerplate is expected to ship a deploymentProfile',
    )

    const result = loadSystemConfig(dir, { log })

    // carrying self-hosted-multi-site into a degraded boot would enable MCP and
    // relax IAM tenant checks; the constructor must derive it from context
    assert.equal(result.config.deploymentProfile, undefined)
  })

  test('survives an unwritable config directory', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('running as root, permissions are not enforced')
      return
    }
    const dir = tmpDir()
    fs.chmodSync(dir, 0o500) // read + execute, no write
    const { log, lines } = collector()

    try {
      const result = loadSystemConfig(dir, { log })
      assert.equal(result.reason, 'missing')
      assert.equal(result.source, 'boilerplate')
      assert.ok(result.config && typeof result.config === 'object')
      assert.match(lines.join('\n'), /could not be restored/)
    }
    finally {
      fs.chmodSync(dir, 0o700)
    }
  })

  test('falls back to minimal defaults if the boilerplate is unusable', () => {
    const dir = tmpDir()
    writeConfig(dir, '{{{')
    const { log, lines } = collector()

    const result = loadSystemConfig(dir, {
      log,
      boilerplatePath: path.join(dir, 'does-not-exist.json'),
    })

    assert.equal(result.source, 'minimal')
    assert.ok(result.config.site, 'minimal config still carries a site block')
    assert.match(lines.join('\n'), /boilerplate config.json is unusable/)
  })

  test('minimal defaults keep mcp closed', () => {
    const c = minimalConfig()
    assert.equal(c.mcp.enabled, false)
    assert.equal(c.mcp.readOnly, true)
  })

  test('never returns a null or non-object config', () => {
    const dir = tmpDir()
    const cases = ['', '   ', 'null', '[]', '"str"', '{{{', '{"ok":true}']
    for (const contents of cases) {
      writeConfig(dir, contents)
      const { log } = collector()
      const { config } = loadSystemConfig(dir, { log })
      assert.ok(
        config !== null && typeof config === 'object' && !Array.isArray(config),
        `config must stay a usable object for input: ${JSON.stringify(contents)}`,
      )
    }
  })
})
