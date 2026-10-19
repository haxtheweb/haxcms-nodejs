'use strict'

// Security (PR8-3): git hardening in HAXCMSSite.
// - the initial newSite() commit message is sanitized like gitCommit()
// - autoPush branch names must start alphanumeric
// - gitSetRemote() actually works (it referenced an undefined `repo`) and
//   only accepts https:// / git@ URLs without whitespace, quotes or ext::.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hardening-'))
process.env.HAXCMS_ROOT = testRoot + '/'

const GitPlus = require('../../src/lib/GitPlus.js')
const {
  HAXCMSSite,
  sanitizeGitCommitMessage,
  isSafeGitRemoteUrl,
  GIT_BRANCH_PATTERN,
} = require('../../src/lib/HAXCMS.js')

test.after(() => {
  fs.removeSync(testRoot)
})

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

describe('sanitizeGitCommitMessage', () => {
  test('strips quotes, backslashes and control characters and caps length', () => {
    assert.equal(
      sanitizeGitCommitMessage("A new journey begins: x' --author='evil <e@e>\"\n\\r (id)"),
      'A new journey begins: x --author=evil <e@e>r (id)',
    )
    assert.equal(sanitizeGitCommitMessage('a'.repeat(500)).length, 200)
    assert.equal(sanitizeGitCommitMessage(''), 'Committed changes')
    assert.equal(sanitizeGitCommitMessage("'\"\\\n"), 'Committed changes')
  })
})

describe('GIT_BRANCH_PATTERN', () => {
  test('accepts normal branch names', () => {
    for (const b of ['main', 'master', 'gh-pages', 'feature/x.y_z', 'v1.2.3', '1-fix']) {
      assert.ok(GIT_BRANCH_PATTERN.test(b), b)
    }
  })
  test('rejects option-like and metachar branch names', () => {
    for (const b of ['-f', '--upload-pack=x', '.hidden', '/abs', 'a b', 'a;b', '', 'a$(x)', "a'b"]) {
      assert.equal(GIT_BRANCH_PATTERN.test(b), false, b)
    }
  })
})

describe('isSafeGitRemoteUrl', () => {
  test('accepts https and git@ urls', () => {
    assert.ok(isSafeGitRemoteUrl('https://github.com/haxtheweb/site.git'))
    assert.ok(isSafeGitRemoteUrl('git@github.com:haxtheweb/site.git'))
  })
  test('rejects other schemes, ext::, option injection, whitespace and quotes', () => {
    const bad = [
      'ext::sh -c touch% /tmp/pwned',
      'ext::sh',
      '--upload-pack=touch /tmp/x',
      'http://github.com/x.git',
      'file:///etc',
      'ssh://git@github.com/x.git',
      'https://github.com/x.git --upload-pack=evil',
      "https://github.com/x'.git",
      'https://github.com/x".git',
      'https://github.com/x\\y',
      'https://github.com/x\n.git',
      'https://github.com/ext::sh',
      '',
      null,
      undefined,
      42,
    ]
    for (const u of bad) {
      assert.equal(isSafeGitRemoteUrl(u), false, String(u))
    }
  })
})

describe('HAXCMSSite.gitSetRemote', { skip: !hasGit() }, () => {
  test('adds origin for a valid URL (previously always threw on undefined repo)', async () => {
    const dir = fs.mkdtempSync(path.join(testRoot, 'remote-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const site = new HAXCMSSite()
    site.siteDirectory = dir
    const ok = await site.gitSetRemote({ url: 'https://git.example.test/haxtheweb/example.git' })
    assert.equal(ok, true)
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir }).toString().trim()
    assert.equal(url, 'https://git.example.test/haxtheweb/example.git')
    // a second call updates the existing origin
    const ok2 = await site.gitSetRemote({ url: 'git@git.example.test:haxtheweb/other.git' })
    assert.equal(ok2, true)
    const url2 = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir }).toString().trim()
    assert.equal(url2, 'git@git.example.test:haxtheweb/other.git')
  })

  test('refuses unsafe URLs without touching the repo', async (t) => {
    t.mock.method(console, 'warn', () => {})
    const dir = fs.mkdtempSync(path.join(testRoot, 'remote-bad-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const site = new HAXCMSSite()
    site.siteDirectory = dir
    for (const url of ['ext::sh -c id', '--upload-pack=id', 'https://x.test/a b']) {
      assert.equal(await site.gitSetRemote({ url: url }), false, url)
    }
    assert.equal(await site.gitSetRemote(null), false)
    const remotes = execFileSync('git', ['remote'], { cwd: dir }).toString().trim()
    assert.equal(remotes, '')
  })
})

describe('HAXCMSSite.newSite initial commit', () => {
  test('initial commit message is sanitized', async (t) => {
    const messages = []
    t.mock.method(GitPlus.prototype, 'init', async function () { return '' })
    t.mock.method(GitPlus.prototype, 'add', async function () { return '' })
    t.mock.method(GitPlus.prototype, 'commit', async function (msg) {
      messages.push(msg)
      return ''
    })
    t.mock.method(console, 'warn', () => {})
    const sitesDir = fs.mkdtempSync(path.join(testRoot, 'sites-'))
    const site = new HAXCMSSite()
    const evil = "evil' --author='x <x@x>\"\nline2\\"
    await site.newSite(sitesDir, '/', evil)
    assert.ok(messages.length >= 1, 'initial commit attempted')
    const initial = messages[0]
    assert.ok(initial.indexOf('A new journey begins: ') === 0, initial)
    assert.equal(/['"\\\x00-\x1f\x7f]/.test(initial), false, 'no quotes/backslashes/control chars: ' + JSON.stringify(initial))
  })
})
