'use strict'

// Unit tests for the config.json safeguard loader (haxtheweb/issues#2967).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.
//
// CRITICAL invariant under test: the loader must NEVER write, copy, or
// overwrite anything on disk. Missing / empty / corrupt config.json are all
// just different triggers for the exact same in-memory-only fallback.

process.env.haxcms_middleware = 'node-cli'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { loadConfigJson } = require('../../src/lib/HAXCMS.js')

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function assertValidFallbackShape(config) {
  assert.equal(typeof config, 'object')
  assert.notEqual(config, null)
  assert.equal(typeof config.themes, 'object')
  assert.equal(typeof config.security, 'object')
  assert.equal(typeof config.site, 'object')
  assert.equal(typeof config.mcp, 'object')
  assert.equal(typeof config.deploymentProfile, 'string')
}

describe('loadConfigJson — missing config.json', () => {
  test('missing file yields a valid in-memory fallback and creates nothing on disk', () => {
    const tmpDir = mkTmpDir('haxcms-cfg-missing-')
    try {
      const configPath = path.join(tmpDir, 'config.json')
      assert.equal(fs.existsSync(configPath), false)

      const config = loadConfigJson(tmpDir)

      assertValidFallbackShape(config)

      // the most important assertion: no file was created as a side effect
      assert.equal(fs.existsSync(configPath), false)
      assert.deepEqual(fs.readdirSync(tmpDir), [])
    } finally {
      fs.removeSync(tmpDir)
    }
  })
})

describe('loadConfigJson — corrupt/malformed config.json', () => {
  test('corrupt JSON does not throw, yields a valid fallback, and leaves the file byte-for-byte unchanged', (t) => {
    const tmpDir = mkTmpDir('haxcms-cfg-corrupt-')
    try {
      const configPath = path.join(tmpDir, 'config.json')
      const corruptContent = '{ "themes": { totally not valid json !!! '
      fs.writeFileSync(configPath, corruptContent)

      const originalStat = fs.statSync(configPath)

      // capture console.error output to confirm the real parse error is logged
      const originalConsoleError = console.error
      const loggedMessages = []
      console.error = (msg) => { loggedMessages.push(msg) }

      let config
      try {
        config = loadConfigJson(tmpDir)
      } finally {
        console.error = originalConsoleError
      }

      assertValidFallbackShape(config)

      // content on disk must be byte-for-byte unchanged
      const afterContent = fs.readFileSync(configPath, { encoding: 'utf8' })
      assert.equal(afterContent, corruptContent)
      const afterStat = fs.statSync(configPath)
      assert.equal(afterStat.size, originalStat.size)
      assert.equal(afterStat.mtimeMs, originalStat.mtimeMs)

      // the real parse error was logged server-side
      assert.ok(loggedMessages.length > 0, 'expected console.error to be called')
      const joined = loggedMessages.join(' ')
      assert.ok(
        joined.indexOf('failed to parse') !== -1,
        'expected log message to mention parse failure: ' + joined,
      )
    } finally {
      fs.removeSync(tmpDir)
    }
  })
})

describe('loadConfigJson — empty config.json', () => {
  test('empty file does not throw, yields a valid fallback, and leaves the file unchanged', () => {
    const tmpDir = mkTmpDir('haxcms-cfg-empty-')
    try {
      const configPath = path.join(tmpDir, 'config.json')
      fs.writeFileSync(configPath, '')

      const originalConsoleError = console.error
      const loggedMessages = []
      console.error = (msg) => { loggedMessages.push(msg) }

      let config
      try {
        config = loadConfigJson(tmpDir)
      } finally {
        console.error = originalConsoleError
      }

      assertValidFallbackShape(config)

      const afterContent = fs.readFileSync(configPath, { encoding: 'utf8' })
      assert.equal(afterContent, '')

      assert.ok(loggedMessages.length > 0, 'expected console.error to be called')
    } finally {
      fs.removeSync(tmpDir)
    }
  })
})

describe('loadConfigJson — valid config.json passes through', () => {
  test('a valid config.json is parsed and returned as-is, with no writes', () => {
    const tmpDir = mkTmpDir('haxcms-cfg-valid-')
    try {
      const configPath = path.join(tmpDir, 'config.json')
      const validContent = JSON.stringify({ themes: { foo: {} }, deploymentProfile: 'single-site' })
      fs.writeFileSync(configPath, validContent)

      const config = loadConfigJson(tmpDir)

      assert.equal(config.deploymentProfile, 'single-site')
      assert.deepEqual(config.themes, { foo: {} })

      const afterContent = fs.readFileSync(configPath, { encoding: 'utf8' })
      assert.equal(afterContent, validContent)
    } finally {
      fs.removeSync(tmpDir)
    }
  })
})
