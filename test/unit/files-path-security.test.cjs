'use strict'

// Security/scoping unit tests for the files API's path-resolution gate
// (resolveSiteFilePath) and its sole mutation entrypoint
// (performFileOperation), both in src/siteRoutes/v1/files.js.
//
// Goal: prove that any file operation (delete/rename/duplicate/scale/
// compress/rotate/transform) can ONLY ever touch the single file it was
// asked to target, and can NEVER touch anything outside that site's
// files/ directory -- not via '..' traversal, not via a path that never
// entered files/ at all, and not via a symlink planted inside files/ that
// points somewhere else on disk. This directly targets the "don't
// accidentally delete the wrong file" requirement.
//
// Fixture layout (all under a temp root):
//   <root>/site/files/keep.txt        -- sibling file that must survive
//                                         every test untouched
//   <root>/site/files/target.txt      -- the file operations are run
//                                         against
//   <root>/site/secret.txt            -- inside the site directory, but
//                                         OUTSIDE files/ -- must never be
//                                         reachable via the files API
//   <root>/outside/escape-target.txt  -- fully outside the site tree --
//                                         a symlink inside files/ will
//                                         point here
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const {
  performFileOperation,
  resolveSiteFilePath,
} = require('../../src/siteRoutes/v1/files.js')

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haxfiles-pathsec-'))
  const siteRoot = path.join(root, 'site')
  const outsideDir = path.join(root, 'outside')
  fs.ensureDirSync(path.join(siteRoot, 'files'))
  fs.ensureDirSync(outsideDir)
  fs.writeFileSync(path.join(siteRoot, 'files', 'keep.txt'), 'keep me')
  fs.writeFileSync(path.join(siteRoot, 'files', 'target.txt'), 'delete or rename me')
  fs.writeFileSync(path.join(siteRoot, 'secret.txt'), 'site-root secret, not in files/')
  fs.writeFileSync(path.join(outsideDir, 'escape-target.txt'), 'fully outside the site tree')
  return { root, siteRoot, outsideDir }
}

function siteFor(siteRoot) {
  return { siteDirectory: siteRoot }
}

describe('resolveSiteFilePath — path resolution never leaves files/', () => {
  let fixture = null

  test.before(() => {
    fixture = buildFixture()
  })

  test.after(() => {
    if (fixture) {
      fs.removeSync(fixture.root)
    }
  })

  test('resolves a valid files/ path to the real on-disk file, inside filesRootPath', () => {
    const site = siteFor(fixture.siteRoot)
    const result = resolveSiteFilePath(site, 'files/target.txt')
    assert.equal(result.normalizedPath, 'files/target.txt')
    assert.equal(
      fs.realpathSync(result.resolvedPath),
      fs.realpathSync(path.join(fixture.siteRoot, 'files', 'target.txt')),
    )
    assert.ok(
      result.resolvedPath.indexOf(result.filesRootPath) === 0,
      'resolvedPath is inside filesRootPath',
    )
  })

  test('rejects "../" traversal that tries to reach the site root secret file', () => {
    const site = siteFor(fixture.siteRoot)
    assert.throws(
      function () {
        resolveSiteFilePath(site, 'files/../secret.txt')
      },
      function (err) {
        return err && err.status === 400 && err.message === 'Invalid file path'
      },
    )
  })

  test('rejects "../" traversal that tries to reach outside the site tree entirely', () => {
    const site = siteFor(fixture.siteRoot)
    assert.throws(
      function () {
        resolveSiteFilePath(site, 'files/../../outside/escape-target.txt')
      },
      function (err) {
        return err && err.status === 400 && err.message === 'Invalid file path'
      },
    )
  })

  test('rejects a path that never enters files/ at all', () => {
    const site = siteFor(fixture.siteRoot)
    assert.throws(
      function () {
        resolveSiteFilePath(site, 'secret.txt')
      },
      function (err) {
        return err && err.status === 400 && err.message === 'Invalid file path'
      },
    )
  })

  test('rejects an absolute path that is not scoped under files/', () => {
    const site = siteFor(fixture.siteRoot)
    assert.throws(
      function () {
        resolveSiteFilePath(site, '/etc/passwd')
      },
      function (err) {
        return err && err.status === 400 && err.message === 'Invalid file path'
      },
    )
  })

  test('rejects a path containing a null byte', () => {
    const site = siteFor(fixture.siteRoot)
    assert.throws(
      function () {
        resolveSiteFilePath(site, 'files/target.txt\0.png')
      },
      function (err) {
        return err && err.status === 400 && err.message === 'Invalid file path'
      },
    )
  })

  test('rejects an empty path', () => {
    const site = siteFor(fixture.siteRoot)
    assert.throws(
      function () {
        resolveSiteFilePath(site, '')
      },
      function (err) {
        return err && err.status === 400 && err.message === 'Invalid file path'
      },
    )
  })
})

describe('performFileOperation — mutations are confined to the single requested file', () => {
  let fixture = null

  test.before(() => {
    fixture = buildFixture()
  })

  test.after(() => {
    if (fixture) {
      fs.removeSync(fixture.root)
    }
  })

  test('delete removes ONLY the requested file; sibling files/ content is untouched', async () => {
    const site = siteFor(fixture.siteRoot)
    const targetPath = path.join(fixture.siteRoot, 'files', 'target.txt')
    const keepPath = path.join(fixture.siteRoot, 'files', 'keep.txt')
    assert.equal(fs.pathExistsSync(targetPath), true)
    assert.equal(fs.pathExistsSync(keepPath), true)

    const result = await performFileOperation(
      site,
      'files/target.txt',
      { operation: 'delete' },
      90,
    )

    assert.equal(result.data.deleted, true)
    assert.equal(fs.pathExistsSync(targetPath), false, 'target file removed')
    assert.equal(fs.pathExistsSync(keepPath), true, 'sibling file survives untouched')
    assert.equal(
      fs.readFileSync(keepPath, 'utf8'),
      'keep me',
      'sibling file content unchanged',
    )
  })

  test('delete via "../" traversal is rejected before touching the filesystem', async () => {
    const site = siteFor(fixture.siteRoot)
    const secretPath = path.join(fixture.siteRoot, 'secret.txt')
    assert.equal(fs.pathExistsSync(secretPath), true)

    await assert.rejects(
      function () {
        return performFileOperation(
          site,
          'files/../secret.txt',
          { operation: 'delete' },
          90,
        )
      },
      function (err) {
        return err && err.status === 400
      },
    )

    assert.equal(fs.pathExistsSync(secretPath), true, 'secret.txt outside files/ survives')
  })

  test('unsupported operation is rejected and performs no filesystem mutation', async () => {
    const site = siteFor(fixture.siteRoot)
    const keepPath = path.join(fixture.siteRoot, 'files', 'keep.txt')
    const before = fs.readFileSync(keepPath, 'utf8')

    await assert.rejects(
      function () {
        return performFileOperation(
          site,
          'files/keep.txt',
          { operation: 'frobnicate' },
          90,
        )
      },
      function (err) {
        return err && err.status === 400 && err.message === 'Unsupported file operation'
      },
    )

    assert.equal(fs.readFileSync(keepPath, 'utf8'), before, 'file left untouched')
  })

  test('operation on a nonexistent file returns 404 and touches nothing else', async () => {
    const site = siteFor(fixture.siteRoot)
    const keepPath = path.join(fixture.siteRoot, 'files', 'keep.txt')
    const before = fs.readFileSync(keepPath, 'utf8')

    await assert.rejects(
      function () {
        return performFileOperation(
          site,
          'files/does-not-exist.txt',
          { operation: 'delete' },
          90,
        )
      },
      function (err) {
        return err && err.status === 404
      },
    )

    assert.equal(fs.readFileSync(keepPath, 'utf8'), before, 'unrelated file left untouched')
  })

  test('a symlink planted inside files/ pointing outside the site is rejected, not deleted, and its target survives', async () => {
    const site = siteFor(fixture.siteRoot)
    const symlinkPath = path.join(fixture.siteRoot, 'files', 'escape-link.txt')
    const outsideTarget = path.join(fixture.outsideDir, 'escape-target.txt')
    fs.symlinkSync(outsideTarget, symlinkPath)
    assert.equal(fs.pathExistsSync(outsideTarget), true)

    try {
      await assert.rejects(
        function () {
          return performFileOperation(
            site,
            'files/escape-link.txt',
            { operation: 'delete' },
            90,
          )
        },
        function (err) {
          // ensureExistingRegularFile rejects symlinks outright (404), so
          // the operation never reaches fs.removeSync on the real target.
          return err && (err.status === 404 || err.status === 403)
        },
      )
      assert.equal(
        fs.pathExistsSync(outsideTarget),
        true,
        'symlink target outside the site tree was never touched',
      )
    } finally {
      fs.removeSync(symlinkPath)
    }
  })

  test('rename cannot be used to relocate the file outside files/ even with a traversal-laden newName', async () => {
    const site = siteFor(fixture.siteRoot)
    fs.writeFileSync(path.join(fixture.siteRoot, 'files', 'rename-me.txt'), 'rename target')

    // No '.' in the requested name -- a literal '..' contains dots and would
    // instead hit the separate "only one extension" guard (covered below).
    // This exercises sanitizeFileRenameBaseName, which strips every
    // character outside [a-z0-9-] (including '/'), so a slash-laden,
    // absolute-looking name can never survive into the output path.
    const result = await performFileOperation(
      site,
      'files/rename-me.txt',
      { operation: 'rename', newName: '/etc/escaped-name' },
      90,
    )

    assert.ok(
      result.data.path.indexOf('files/') === 0,
      'renamed path still starts with files/',
    )
    assert.ok(
      result.data.path.indexOf('..') === -1,
      'renamed path contains no traversal segments',
    )
    assert.equal(result.data.path, 'files/etc-escaped-name.txt')
    const renamedAbsolute = path.join(fixture.siteRoot, result.data.path)
    assert.ok(
      fs.realpathSync(path.dirname(renamedAbsolute)).indexOf(
        fs.realpathSync(path.join(fixture.siteRoot, 'files')),
      ) === 0,
      'renamed file physically lives inside files/',
    )
    assert.equal(
      fs.pathExistsSync(path.join(fixture.siteRoot, 'escaped-name.txt')),
      false,
      'no file was created at the site root via traversal',
    )
  })

  test('rename request with multiple dots (traversal disguised as an extension) is rejected outright', async () => {
    const site = siteFor(fixture.siteRoot)
    fs.writeFileSync(path.join(fixture.siteRoot, 'files', 'rename-me-2.txt'), 'rename target 2')

    await assert.rejects(
      function () {
        return performFileOperation(
          site,
          'files/rename-me-2.txt',
          { operation: 'rename', newName: '../../../escaped-name.txt' },
          90,
        )
      },
      function (err) {
        return err && err.status === 400
      },
    )
    assert.equal(
      fs.pathExistsSync(path.join(fixture.siteRoot, 'files', 'rename-me-2.txt')),
      true,
      'original file left untouched after rejected rename',
    )
  })

  test('duplicate output always lands inside files/, never at the site root', async () => {
    const site = siteFor(fixture.siteRoot)
    fs.writeFileSync(path.join(fixture.siteRoot, 'files', 'dup-me.txt'), 'dup target')

    const result = await performFileOperation(
      site,
      'files/dup-me.txt',
      { operation: 'duplicate' },
      90,
    )

    assert.equal(result.data.path, 'files/dup-me-copy.txt')
    assert.equal(
      fs.pathExistsSync(path.join(fixture.siteRoot, 'files', 'dup-me-copy.txt')),
      true,
    )
    assert.equal(
      fs.pathExistsSync(path.join(fixture.siteRoot, 'dup-me-copy.txt')),
      false,
      'duplicate was not created at the site root',
    )
  })
})
