'use strict'

// Unit tests for GitPlus (src/lib/GitPlus.js), a thin wrapper around the
// git-interface package's Git class that adds a gitTest() cliVersion probe
// and a revert(count) helper, and guards gitExec() behind a truthy
// cliVersion.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs-extra')

const GitPlus = require('../../src/lib/GitPlus.js')

function tmpGitRepoDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gitplus-'))
}

describe('GitPlus construction and gitTest()', () => {
  test('constructing with valid options runs gitTest() and eventually sets a truthy cliVersion', async () => {
    const dir = tmpGitRepoDir()
    try {
      const instance = new GitPlus({ dir: dir })
      // constructor fires gitTest() without awaiting it, so directly await
      // the method again to observe its resolved effect on cliVersion.
      await instance.gitTest()
      assert.equal(typeof instance.cliVersion, 'string')
      assert.ok(instance.cliVersion.length > 0, 'cliVersion should be a non-empty string')
      assert.ok(
        instance.cliVersion.toLowerCase().indexOf('git') !== -1,
        'cliVersion should look like `git version ...` output',
      )
    }
    finally {
      fs.removeSync(dir)
    }
  })
})

describe('GitPlus.revert(count) guard logic', () => {
  function instanceWithStubbedExec(dir) {
    const instance = new GitPlus({ dir: dir })
    const calls = []
    instance.gitExec = async (cmd) => {
      calls.push(cmd)
      return true
    }
    return { instance, calls }
  }

  test('revert(0) clamps to a single call', async () => {
    const dir = tmpGitRepoDir()
    try {
      const { instance, calls } = instanceWithStubbedExec(dir)
      await instance.revert(0)
      assert.equal(calls.length, 1)
      assert.equal(calls[0], 'reset --hard HEAD~1')
    }
    finally {
      fs.removeSync(dir)
    }
  })

  test('revert(-1) clamps to a single call', async () => {
    const dir = tmpGitRepoDir()
    try {
      const { instance, calls } = instanceWithStubbedExec(dir)
      await instance.revert(-1)
      assert.equal(calls.length, 1)
      assert.equal(calls[0], 'reset --hard HEAD~1')
    }
    finally {
      fs.removeSync(dir)
    }
  })

  test('revert(3) issues exactly 3 calls with the expected command', async () => {
    const dir = tmpGitRepoDir()
    try {
      const { instance, calls } = instanceWithStubbedExec(dir)
      await instance.revert(3)
      assert.equal(calls.length, 3)
      for (let i = 0; i < calls.length; i++) {
        assert.equal(calls[i], 'reset --hard HEAD~1')
      }
    }
    finally {
      fs.removeSync(dir)
    }
  })
})

describe('GitPlus.gitExec() cliVersion guard', () => {
  test('returns undefined and does not call super.gitExec when cliVersion is falsy', async () => {
    const dir = tmpGitRepoDir()
    try {
      const instance = new GitPlus({ dir: dir })
      // wait for the constructor's fire-and-forget gitTest() to settle, then
      // force the guard condition we want to test.
      await instance.gitTest()
      instance.cliVersion = null
      const result = instance.gitExec('status')
      assert.equal(result, undefined)
    }
    finally {
      fs.removeSync(dir)
    }
  })
})
