'use strict'

// discoverConfigPath() on a machine with no HAXcms config yet. It used to copy
// `systemsetup/user-files-htaccess`, but the boilerplate ships the file as
// `.user-files-htaccess`. The ENOENT dropped into the fallback branch, which
// pointed the config (and the seeded admin credentials) at the installed
// package's own boilerplate folder, so they were lost on every update.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const assert = require('node:assert/strict')

const DISCOVER = path.resolve(__dirname, '..', '..', 'src', 'lib', 'discoverConfigPath.js')
const BOILERPLATE_SITE = path.resolve(__dirname, '..', '..', 'src', 'boilerplate', 'site')

function discoverIn(home) {
  const res = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(DISCOVER)}).discoverConfigPath)`], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, VERCEL_ENV: '' },
    encoding: 'utf8',
    timeout: 15000,
  })
  assert.equal(res.status, 0, res.stderr)
  return res.stdout
}

test('a fresh home directory gets a complete ~/.haxcmsconfig', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-discover-'))
  try {
    const found = discoverIn(home)
    const expected = path.join(home, '.haxcmsconfig')
    assert.equal(found, expected, 'config must live in the home directory, not inside the package')
    for (const file of ['.isHAXcmsConfig', 'config.json', 'userData.json', 'config.php', '.htaccess', 'user/files/.htaccess']) {
      assert.ok(fs.existsSync(path.join(expected, file)), `${file} created`)
    }
    // a second run finds the same folder
    assert.equal(discoverIn(home), expected)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the site boilerplate no longer ships an empty file named "false"', () => {
  assert.equal(fs.existsSync(path.join(BOILERPLATE_SITE, 'false')), false)
})
