'use strict'

// Unit tests for the public export surface of src/index.js (the package
// entrypoint). The HAXCMS singleton is constructed through the require chain,
// which reads/writes the on-disk config directory at load time, so a temp
// runtime with a seeded _config (marked with .isHAXcmsConfig) is created and
// cwd moved into it BEFORE the first require (same isolation header as the
// other unit suites).
//
// src/cli.js and src/local.js are intentionally not covered here:
// - src/cli.js is ESM-source with CJS require() calls that Node cannot load
//   without the babel dist build (module detection rejects it both as CJS and
//   as ESM), and its argv-driven entry has no non-interactive flag surface
// - src/local.js boots the server then opens a browser window via the `open`
//   package, which is inherently interactive
// Both remain accepted coverage residue (~0.5% of scope).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

process.env.VERCEL_ENV = '1'
process.env.haxcms_middleware = 'node-cli'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-index-exports-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')

fs.ensureDirSync(configRoot)
fs.writeFileSync(path.join(configRoot, '.isHAXcmsConfig'), '')
const seedFiles = [
  'config.json',
  'my-custom-elements.js',
  'userData.json',
  'config.php',
  '.htaccess',
  '.user-files-htaccess',
]
for (let i = 0; i < seedFiles.length; i++) {
  fs.copySync(
    path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
    path.join(configRoot, seedFiles[i]),
  )
}
fs.ensureDirSync(path.join(configRoot, 'tmp'))
fs.ensureDirSync(path.join(configRoot, 'settings'))
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: 'index-exports-user', password: 'index-exports-pass' }, null, 2),
)

process.chdir(runtimeRoot)

const haxcmsExports = require('../../src/index.js')

test.after(() => {
  process.chdir(originalCwd)
  fs.removeSync(tempRoot)
})

test('index.js re-exports the HAXcms core surfaces', () => {
  const expectedKeys = [
    'HAXCMS',
    'HAXCMSClass',
    'HAXCMSSite',
    'systemStructureContext',
    'JSONOutlineSchema',
    'JSONOutlineSchemaItem',
    'allRoutes',
    'SiteRoutesMap',
    'SystemRoutesMap',
    'SystemV1OpenRoutes',
    'SystemV1AdminRoutes',
  ]
  for (let i = 0; i < expectedKeys.length; i++) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(haxcmsExports, expectedKeys[i]),
      expectedKeys[i],
    )
  }
})

test('the re-exported HAXCMS instance is the core singleton', () => {
  assert.ok(haxcmsExports.HAXCMS)
  assert.equal(typeof haxcmsExports.HAXCMS.getActiveUserName, 'function')
  assert.equal(haxcmsExports.HAXCMS.operatingContext, 'single')
})

test('the re-exported classes and route maps keep their real shapes', () => {
  assert.equal(typeof haxcmsExports.HAXCMSClass, 'function')
  assert.equal(typeof haxcmsExports.HAXCMSSite, 'function')
  assert.ok(
    haxcmsExports.JSONOutlineSchema &&
    typeof haxcmsExports.JSONOutlineSchema === 'function',
  )
  assert.ok(
    haxcmsExports.JSONOutlineSchemaItem &&
    typeof haxcmsExports.JSONOutlineSchemaItem === 'function',
  )
  assert.equal(typeof haxcmsExports.systemStructureContext, 'function')
  assert.ok(haxcmsExports.allRoutes && typeof haxcmsExports.allRoutes === 'object')
  assert.ok(haxcmsExports.allRoutes.site && haxcmsExports.allRoutes.system)
  assert.ok(haxcmsExports.SiteRoutesMap && typeof haxcmsExports.SiteRoutesMap === 'object')
  assert.ok(haxcmsExports.SystemRoutesMap && typeof haxcmsExports.SystemRoutesMap === 'object')
  assert.ok(Array.isArray(haxcmsExports.SystemV1OpenRoutes))
  assert.ok(Array.isArray(haxcmsExports.SystemV1AdminRoutes))
})
