'use strict'

// Unit tests for src/lib/stageRemoteFile.js (#3060): the bulk-import staging
// helpers shared by the site importers and createSite.
//
// The network is stubbed at safeFetch except where the real SSRF guard is
// under test, and HAXCMS.configDirectory points at a temp dir so nothing is
// staged in the real config tree.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const safeFetchMod = require('../../src/lib/safeFetch.js')
const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const { getBulkImportStagingRoot, stageRemoteFile } = require('../../src/lib/stageRemoteFile.js')

describe('stageRemoteFile — #3060', () => {
  const realSafeFetch = safeFetchMod.safeFetch
  const realConfigDirectory = HAXCMS.configDirectory
  let tmpRoot
  let fetched

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-test-'))
    HAXCMS.configDirectory = path.join(tmpRoot, 'config')
    fetched = []
  })

  afterEach(async () => {
    safeFetchMod.safeFetch = realSafeFetch
    HAXCMS.configDirectory = realConfigDirectory
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  // answer every request with { status, body }, or throw the given Error
  function stubNetwork(answer) {
    safeFetchMod.safeFetch = async function (url) {
      fetched.push(url)
      if (answer instanceof Error) {
        throw answer
      }
      const status = answer.status || 200
      return {
        ok: status >= 200 && status < 300,
        status: status,
        headers: {
          get: function () {
            return null
          },
        },
        arrayBuffer: async function () {
          return answer.body || Buffer.alloc(0)
        },
      }
    }
  }

  test('getBulkImportStagingRoot creates the import directory under the config tree', () => {
    const expected = path.join(HAXCMS.configDirectory, 'tmp', 'imports')
    assert.equal(fs.existsSync(expected), false)
    assert.equal(getBulkImportStagingRoot(), expected)
    assert.ok(fs.statSync(expected).isDirectory())
    // and hands back the same directory once it exists
    assert.equal(getBulkImportStagingRoot(), expected)
  })

  test('a fetched file is staged under the root with the extension of its key', async () => {
    stubNetwork({ body: Buffer.from('PNGBYTES') })
    const root = getBulkImportStagingRoot()
    const staged = await stageRemoteFile('https://example.org/img/chart.png?v=2', root, 7, 'files/chart.png')
    assert.deepEqual(fetched, ['https://example.org/img/chart.png?v=2'], 'the URL is fetched as given')
    assert.equal(path.dirname(staged), root)
    assert.match(path.basename(staged), /^haximp-\d+-7-\d+\.png$/)
    assert.equal(fs.readFileSync(staged, 'utf8'), 'PNGBYTES')
  })

  test('each download gets its own staged file', async () => {
    stubNetwork({ body: Buffer.from('X') })
    const root = getBulkImportStagingRoot()
    const first = await stageRemoteFile('https://example.org/a.png', root, 0, 'a.png')
    const second = await stageRemoteFile('https://example.org/b.png', root, 1, 'b.png')
    assert.notEqual(first, second)
    assert.equal(fs.readdirSync(root).length, 2)
  })

  test('getBulkImportStagingRoot still names the directory when it cannot be created', async () => {
    // a file where the config tree should be makes the directory impossible
    await fs.writeFile(path.join(tmpRoot, 'blocker'), '')
    HAXCMS.configDirectory = path.join(tmpRoot, 'blocker', 'config')
    const root = getBulkImportStagingRoot()
    assert.equal(root, path.join(tmpRoot, 'blocker', 'config', 'tmp', 'imports'))
    assert.equal(fs.existsSync(root), false)
    // and a download into it declines rather than throwing
    stubNetwork({ body: Buffer.from('X') })
    assert.equal(await stageRemoteFile('https://example.org/x.png', root, 0, 'x.png'), null)
  })

  test('a key without an extension is staged without one', async () => {
    stubNetwork({ body: Buffer.from('TEXT') })
    const root = getBulkImportStagingRoot()
    assert.equal(path.extname(await stageRemoteFile('https://example.org/README', root, 0, 'files/README')), '')
    assert.equal(path.extname(await stageRemoteFile('https://example.org/README', root, 1)), '', 'or no key at all')
  })

  test('declines error responses, empty bodies and network failures', async () => {
    const root = getBulkImportStagingRoot()
    const answers = [{ status: 404 }, { status: 500 }, { body: Buffer.alloc(0) }, new Error('socket hang up')]
    for (let i = 0; i < answers.length; i++) {
      stubNetwork(answers[i])
      assert.equal(await stageRemoteFile('https://example.org/x.png', root, i, 'x.png'), null, 'answer ' + i)
    }
    assert.equal(fetched.length, 4)
    assert.deepEqual(fs.readdirSync(root), [], 'nothing was staged')
  })

  test('declines when the staging root cannot be written', async () => {
    stubNetwork({ body: Buffer.from('X') })
    const missing = path.join(tmpRoot, 'no-such-dir')
    assert.equal(await stageRemoteFile('https://example.org/x.png', missing, 0, 'x.png'), null)
    assert.equal(fs.existsSync(missing), false)
  })

  test('private, loopback and metadata addresses are refused without being contacted', async () => {
    // the real safeFetch: its SSRF guard must stop these before any connection
    let hits = 0
    const server = http.createServer(function (req, res) {
      hits++
      res.end('secret')
    })
    await new Promise(function (resolve) {
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    const root = getBulkImportStagingRoot()
    try {
      const targets = [
        `http://127.0.0.1:${port}/s.png`,
        `http://localhost:${port}/s.png`,
        'http://169.254.169.254/latest/meta-data/s.png',
      ]
      for (let i = 0; i < targets.length; i++) {
        assert.equal(await stageRemoteFile(targets[i], root, i, 's.png'), null, targets[i])
      }
      assert.equal(hits, 0, 'the local server was never contacted')
      assert.deepEqual(fs.readdirSync(root), [])
    } finally {
      await new Promise(function (resolve) {
        server.close(resolve)
      })
    }
  })
})
