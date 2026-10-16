'use strict'

// Security (SEC-SSRF) regression tests:
//   - isPrivateOrReservedIP: every range added by SEC-SSRF + existing ranges
//   - safeFetch / safeFetchToFile byte cap against a real local HTTP server
//   - HAXCMSFile.downloadAndSaveFile via safeFetchToFile
//   - export image resolver (DOCX / EPUB / PDF inputs)
//   - PDF request filter (puppeteer interception) as a pure function + fake page
//   - YAML size cap and anchor/alias rejection
//
// Network boundary handling: the local test server listens on 127.0.0.1,
// which safeFetch would (correctly) refuse. Tests that need a "public" server
// stub dns.promises.lookup to answer a public address for *.test hostnames
// and rewrite the pinned connect host back to 127.0.0.1 in http.request. The
// SSRF decision itself (isPrivateOrReservedIP over the resolver output) is
// never mocked.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const dns = require('dns')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const JSZip = require('jszip')

const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const {
  safeFetch,
  safeFetchToFile,
  SAFE_FETCH_DEFAULT_MAX_BYTES,
  isPrivateOrReservedIP,
} = require('../../src/lib/safeFetch.js')
const {
  resolveExportImages,
  resolveLocalImageFile,
  classifyImageSource,
  sniffImageMime,
  isAllowedPdfRequestUrl,
  installPdfRequestFilter,
} = require('../../src/lib/exportImageResolver.js')
const { convertHtmlToDocxBuffer } = require('../../src/lib/convertUtils.js')
const {
  loadYamlSafely,
  YAML_MAX_INPUT_BYTES,
  YAML_ALIAS_ERROR_MESSAGE,
} = require('../../src/lib/safeYaml.js')
const { convertYamlToJson } = require('../../src/systemRoutes/v1/routes/convertYamlToJson.js')

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const PUBLIC_TEST_IP = '93.184.216.34'

// --- helpers ----------------------------------------------------------------

async function startServer(handler) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    hits,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
      server.close(() => resolve())
    }),
  }
}

// *.test hostnames resolve to a public address (so the SSRF predicate passes);
// the connect is then redirected to the local server. Anything else goes to
// the real resolver (IP literals resolve to themselves).
function usePublicTestHost(t, port) {
  const prevLookup = dns.promises.lookup
  dns.promises.lookup = async function (hostname, options) {
    if (/\.test$/.test(hostname)) {
      return [{ address: PUBLIC_TEST_IP, family: 4 }]
    }
    return prevLookup.call(dns.promises, hostname, options)
  }
  const prevRequest = http.request
  http.request = function (options, cb) {
    if (options && options.host === PUBLIC_TEST_IP) {
      options = Object.assign({}, options, { host: '127.0.0.1', port: port })
    }
    return prevRequest.call(http, options, cb)
  }
  t.after(function () {
    dns.promises.lookup = prevLookup
    http.request = prevRequest
  })
}

function useLookupAnswer(t, address) {
  const prevLookup = dns.promises.lookup
  dns.promises.lookup = async function () {
    return [{ address: address, family: address.indexOf(':') !== -1 ? 6 : 4 }]
  }
  t.after(function () { dns.promises.lookup = prevLookup })
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, function (err) {
    assert.equal(err.code, code)
    return true
  })
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// --- IP predicate -----------------------------------------------------------

describe('isPrivateOrReservedIP (SEC-SSRF ranges)', () => {
  test('new IPv4 ranges are blocked at their boundaries', () => {
    const blocked = [
      '0.0.0.0', '0.1.2.3', '0.255.255.255', // 0.0.0.0/8
      '192.0.0.0', '192.0.0.8', '192.0.0.255', // 192.0.0.0/24
      '198.18.0.0', '198.19.255.255', // 198.18.0.0/15
      '224.0.0.1', '239.255.255.255', // 224.0.0.0/4
      '240.0.0.1', '250.1.2.3', '255.255.255.255', // 240.0.0.0/4 + broadcast
      '192.0.2.1', '192.0.2.255', // TEST-NET-1
      '198.51.100.0', '198.51.100.200', // TEST-NET-2
      '203.0.113.1', '203.0.113.255', // TEST-NET-3
    ]
    for (const ip of blocked) {
      assert.equal(isPrivateOrReservedIP(ip), true, ip)
    }
    const allowed = [
      '1.0.0.1', '192.0.1.1', '192.0.3.1', '198.17.255.255', '198.20.0.0',
      '198.51.99.1', '198.51.101.1', '203.0.112.1', '203.0.114.1',
      '223.255.255.255', '8.8.8.8', '93.184.216.34',
    ]
    for (const ip of allowed) {
      assert.equal(isPrivateOrReservedIP(ip), false, ip)
    }
  })

  test('existing IPv4 ranges still blocked (regression)', () => {
    const blocked = [
      '127.0.0.1', '127.255.255.255', '10.0.0.1', '10.255.255.255',
      '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
      '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255',
    ]
    for (const ip of blocked) {
      assert.equal(isPrivateOrReservedIP(ip), true, ip)
    }
    for (const ip of ['172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '169.255.0.1']) {
      assert.equal(isPrivateOrReservedIP(ip), false, ip)
    }
  })

  test('malformed dotted-quads fail closed; hostnames are not addresses', () => {
    assert.equal(isPrivateOrReservedIP('1.2.3'), true)
    assert.equal(isPrivateOrReservedIP('1.2.3.256'), true)
    assert.equal(isPrivateOrReservedIP('01.2.3.4'), true)
    assert.equal(isPrivateOrReservedIP('garbage'), false)
  })

  test('NAT64 64:ff9b::/96 decodes the embedded IPv4', () => {
    assert.equal(isPrivateOrReservedIP('64:ff9b::7f00:1'), true) // 127.0.0.1
    assert.equal(isPrivateOrReservedIP('64:ff9b::169.254.169.254'), true)
    assert.equal(isPrivateOrReservedIP('64:ff9b::a00:1'), true) // 10.0.0.1
    assert.equal(isPrivateOrReservedIP('64:ff9b::808:808'), false) // 8.8.8.8
    assert.equal(isPrivateOrReservedIP('64:ff9b::8.8.8.8'), false)
  })

  test('local-use NAT64 64:ff9b:1::/48 is blocked entirely', () => {
    assert.equal(isPrivateOrReservedIP('64:ff9b:1::1'), true)
    assert.equal(isPrivateOrReservedIP('64:ff9b:1:ffff::808:808'), true)
    assert.equal(isPrivateOrReservedIP('64:ff9b:2::808:808'), false)
  })

  test('6to4 2002::/16 decodes the embedded IPv4 (bytes 2-5)', () => {
    assert.equal(isPrivateOrReservedIP('2002:7f00:1::1'), true) // 127.0.0.1
    assert.equal(isPrivateOrReservedIP('2002:a9fe:a9fe::'), true) // metadata
    assert.equal(isPrivateOrReservedIP('2002:c0a8:101::1'), true) // 192.168.1.1
    assert.equal(isPrivateOrReservedIP('2002:808:808::1'), false) // 8.8.8.8
  })

  test('fe80::/10 is a real /10 (not a literal fe80 prefix)', () => {
    for (const ip of ['fe80::1', 'fe9f::1', 'fea0::1', 'febf:ffff::1', 'FE80::1', 'fe80::1%eth0']) {
      assert.equal(isPrivateOrReservedIP(ip), true, ip)
    }
    assert.equal(isPrivateOrReservedIP('fec0::1'), false)
    assert.equal(isPrivateOrReservedIP('fe7f::1'), false)
  })

  test('ff00::/8 multicast and 100::/64 discard are blocked', () => {
    for (const ip of ['ff02::1', 'ff05::1:3', 'ffff::1', '100::', '100::1', '100::ffff:ffff:ffff:ffff']) {
      assert.equal(isPrivateOrReservedIP(ip), true, ip)
    }
    assert.equal(isPrivateOrReservedIP('100:0:0:1::1'), false)
    assert.equal(isPrivateOrReservedIP('feff::1'), false)
  })

  test('existing IPv6 rules still hold (regression)', () => {
    for (const ip of ['::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::7f00:1', '::ffff:192.0.2.1']) {
      assert.equal(isPrivateOrReservedIP(ip), true, ip)
    }
    for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111', '2001:db8::1.2.3.4', '::ffff:8.8.8.8']) {
      assert.equal(isPrivateOrReservedIP(ip), false, ip)
    }
  })
})

// --- safeFetch byte cap -----------------------------------------------------

describe('safeFetch byte cap', () => {
  test('default cap is 20 MB', () => {
    assert.equal(SAFE_FETCH_DEFAULT_MAX_BYTES, 20 * 1024 * 1024)
  })

  test('a Content-Length above the cap is refused before the body is read', async (t) => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5000' })
      res.end('x'.repeat(5000))
    })
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    await rejectsCode(safeFetch('http://big.test/file', { maxBytes: 1000 }), 'SSRF_TOO_LARGE')
  })

  test('a chunked body crossing the cap aborts the request', async (t) => {
    let serverSawClose = false
    let intervalHandle = null
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      // endless stream: only the client-side cap can stop it
      intervalHandle = setInterval(() => res.write(Buffer.alloc(1024, 120)), 1)
      res.on('close', () => {
        serverSawClose = true
        clearInterval(intervalHandle)
      })
    })
    t.after(() => {
      clearInterval(intervalHandle)
      return srv.close()
    })
    usePublicTestHost(t, srv.port)
    await rejectsCode(safeFetch('http://stream.test/x', { maxBytes: 64 * 1024 }), 'SSRF_TOO_LARGE')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(serverSawClose, true)
  })

  test('a body under the cap is returned intact', async (t) => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello world')
    })
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    const response = await safeFetch('http://ok.test/x', { maxBytes: 1000 })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'hello world')
  })

  test('redirect hops are capped too and maxRedirects 0 refuses any 3xx', async (t) => {
    const srv = await startServer((req, res) => {
      res.writeHead(302, { location: 'http://ok.test/final' })
      res.end()
    })
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    await rejectsCode(safeFetch('http://ok.test/start', { maxRedirects: 0 }), 'SSRF_REDIRECTS')
  })

  test('safeFetchToFile streams to disk and removes partial files on overflow', async (t) => {
    const srv = await startServer((req, res) => {
      if (req.url === '/small') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(PNG_1X1)
        return
      }
      if (req.url === '/missing') {
        res.writeHead(404)
        res.end('nope')
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      for (let i = 0; i < 100; i++) {
        res.write(Buffer.alloc(1024, 1))
      }
      res.end()
    })
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    const dir = makeTempDir('haxcms-safefetch-')
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

    const okPath = path.join(dir, 'ok.bin')
    await safeFetchToFile('http://files.test/small', okPath, { maxBytes: 1024 })
    assert.deepEqual(fs.readFileSync(okPath), PNG_1X1)

    const bigPath = path.join(dir, 'big.bin')
    await rejectsCode(safeFetchToFile('http://files.test/big', bigPath, { maxBytes: 10 * 1024 }), 'SSRF_TOO_LARGE')
    assert.equal(fs.existsSync(bigPath), false)

    const missingPath = path.join(dir, 'missing.bin')
    await rejectsCode(safeFetchToFile('http://files.test/missing', missingPath), 'SSRF_HTTP_STATUS')
    assert.equal(fs.existsSync(missingPath), false)
  })
})

// --- downloadAndSaveFile ----------------------------------------------------

describe('HAXCMSFile.downloadAndSaveFile', () => {
  test('refuses private targets without touching the network', async (t) => {
    const srv = await startServer((req, res) => res.end('secret'))
    t.after(srv.close)
    const dir = makeTempDir('haxcms-dl-')
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'dl.bin')
    await rejectsCode(
      HAXCMSFile.downloadAndSaveFile('http://127.0.0.1:' + srv.port + '/secret', target),
      'SSRF_PRIVATE',
    )
    assert.equal(srv.hits.length, 0)
    assert.equal(fs.existsSync(target), false)
  })

  test('streams within the cap and deletes the partial file when over it', async (t) => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(8192, 7))
    })
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    const dir = makeTempDir('haxcms-dl-')
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const okTarget = path.join(dir, 'nested', 'ok.bin')
    await HAXCMSFile.downloadAndSaveFile('http://dl.test/file', okTarget, { maxBytes: 16384 })
    assert.equal(fs.statSync(okTarget).size, 8192)
    const tooBig = path.join(dir, 'too-big.bin')
    await rejectsCode(HAXCMSFile.downloadAndSaveFile('http://dl.test/file', tooBig, { maxBytes: 4096 }), 'SSRF_TOO_LARGE')
    assert.equal(fs.existsSync(tooBig), false)
  })

  test('does not follow redirects (HAX-SEC-007 posture kept)', async (t) => {
    const srv = await startServer((req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
    })
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    const dir = makeTempDir('haxcms-dl-')
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    await rejectsCode(HAXCMSFile.downloadAndSaveFile('http://dl.test/r', path.join(dir, 'r.bin')), 'SSRF_REDIRECTS')
  })
})

// --- export image resolver --------------------------------------------------

function makeSiteFixture(t) {
  const root = makeTempDir('haxcms-export-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const siteDir = path.join(root, 'sites', 'demo')
  fs.mkdirSync(path.join(siteDir, 'files', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(siteDir, 'files', 'pic.png'), PNG_1X1)
  fs.writeFileSync(path.join(siteDir, 'files', 'sub', 'my pic.png'), PNG_1X1)
  fs.writeFileSync(path.join(siteDir, 'site.json'), '{"secret":"not an image"}')
  // a sibling site and a file outside every site
  fs.mkdirSync(path.join(root, 'sites', 'other', 'files'), { recursive: true })
  fs.writeFileSync(path.join(root, 'sites', 'other', 'files', 'theirs.png'), PNG_1X1)
  fs.writeFileSync(path.join(root, 'outside.png'), PNG_1X1)
  // symlink inside the site pointing outside of it
  try {
    fs.symlinkSync(path.join(root, 'outside.png'), path.join(siteDir, 'files', 'link.png'))
  }
  catch (e) {}
  return { root, siteDir }
}

function imgSrcs(html) {
  const out = []
  const re = /<img\b[^>]*\bsrc="([^"]*)"/gi
  let m = re.exec(html)
  while (m) {
    out.push(m[1])
    m = re.exec(html)
  }
  return out
}

describe('export image resolver', () => {
  test('sniffImageMime recognises allowlisted types only', () => {
    assert.equal(sniffImageMime(PNG_1X1), 'image/png')
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg')
    assert.equal(sniffImageMime(Buffer.from('GIF89a......')), 'image/gif')
    assert.equal(sniffImageMime(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>')), 'image/svg+xml')
    assert.equal(sniffImageMime(Buffer.from('{"secret":1}')), null)
    assert.equal(sniffImageMime(Buffer.from('<html><body>login</body></html>')), null)
  })

  test('classifyImageSource routes schemes', () => {
    const opts = { siteDir: '/x', selfBaseUrl: 'https://cms.example.com/sites/demo/' }
    assert.equal(classifyImageSource('files/a.png', opts).kind, 'local')
    assert.equal(classifyImageSource('https://cdn.example.org/a.png', opts).kind, 'remote')
    assert.equal(classifyImageSource('//cdn.example.org/a.png', opts).kind, 'remote')
    assert.equal(classifyImageSource('https://cms.example.com/sites/demo/files/a.png', opts).kind, 'local')
    assert.equal(classifyImageSource('file:///etc/passwd', opts).kind, 'drop')
    assert.equal(classifyImageSource('java\tscript:alert(1)', opts).kind, 'drop')
    assert.equal(classifyImageSource('ftp://x/a.png', opts).kind, 'drop')
    assert.equal(classifyImageSource('', opts).kind, 'drop')
    // no site context and no base: relative paths are dropped
    assert.equal(classifyImageSource('files/a.png', {}).kind, 'drop')
    assert.equal(classifyImageSource('a.png', { remoteBaseUrl: 'https://ex.org/p/' }).value, 'https://ex.org/p/a.png')
  })

  test('resolveLocalImageFile mirrors PHP containment rules', (t) => {
    const { siteDir } = makeSiteFixture(t)
    const real = fs.realpathSync(siteDir)
    assert.equal(resolveLocalImageFile('files/pic.png', '/sites/demo/', real), path.join(real, 'files', 'pic.png'))
    assert.equal(resolveLocalImageFile('/sites/demo/files/pic.png', '/sites/demo/', real), path.join(real, 'files', 'pic.png'))
    assert.equal(resolveLocalImageFile('pic.png', '/sites/demo/', real), path.join(real, 'files', 'pic.png'))
    assert.equal(resolveLocalImageFile('files/sub/my%20pic.png?v=1#x', '/', real), path.join(real, 'files', 'sub', 'my pic.png'))
    assert.equal(resolveLocalImageFile('../other/files/theirs.png', '/', real), '')
    assert.equal(resolveLocalImageFile('files/%2e%2e/%2e%2e/outside.png', '/', real), '')
    assert.equal(resolveLocalImageFile('files/pic.png\0.jpg', '/', real), '')
    assert.equal(resolveLocalImageFile('files/link.png', '/', real), '')
    assert.equal(resolveLocalImageFile('files', '/', real), '')
  })

  test('relative path -> embedded; outside-site path -> dropped; non-image -> dropped', async (t) => {
    const { siteDir } = makeSiteFixture(t)
    const html = [
      '<p>a</p>',
      '<img src="files/pic.png" alt="ok" srcset="http://10.0.0.1/a.png 2x" sizes="10px">',
      '<img src="/sites/demo/files/pic.png" alt="abs">',
      '<img src="../other/files/theirs.png" alt="sibling">',
      '<img src="/sites/other/files/theirs.png" alt="other-site">',
      '<img src="files/link.png" alt="symlink">',
      '<img src="site.json" alt="json">',
      '<img src="file:///etc/passwd" alt="file">',
    ].join('')
    const out = await resolveExportImages(html, { siteDir, siteBasePath: '/sites/demo/' })
    const srcs = imgSrcs(out)
    assert.equal(srcs.length, 2, out)
    const expected = 'data:image/png;base64,' + PNG_1X1.toString('base64')
    assert.equal(srcs[0], expected)
    assert.equal(srcs[1], expected)
    assert.ok(out.indexOf('srcset') === -1)
    assert.ok(out.indexOf('sizes=') === -1)
    assert.ok(out.indexOf('<p>a</p>') !== -1)
  })

  test('remote image on a private IP is dropped without any request', async (t) => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_1X1)
    })
    t.after(srv.close)
    const html =
      '<img src="http://127.0.0.1:' + srv.port + '/a.png">' +
      '<img src="http://169.254.169.254/latest/meta-data/">' +
      '<img src="http://[::1]:' + srv.port + '/b.png">'
    const out = await resolveExportImages(html, {})
    assert.equal(imgSrcs(out).length, 0)
    assert.equal(srv.hits.length, 0)
  })

  test('remote image whose hostname resolves to a private IP is dropped', async (t) => {
    useLookupAnswer(t, '10.1.2.3')
    const out = await resolveExportImages('<img src="https://intranet.example.com/a.png">', {})
    assert.equal(imgSrcs(out).length, 0)
  })

  test('public remote image is fetched via safeFetch and embedded; non-images dropped', async (t) => {
    const srv = await startServer((req, res) => {
      if (req.url === '/pic.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(PNG_1X1)
        return
      }
      if (req.url === '/huge.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(64 * 1024) })
        res.end(Buffer.alloc(64 * 1024))
        return
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end('<html>login page</html>')
    })
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    const out = await resolveExportImages(
      '<img src="http://cdn.test/pic.png"><img src="http://cdn.test/login"><img src="http://cdn.test/huge.png">',
      { maxBytes: 16 * 1024 },
    )
    const srcs = imgSrcs(out)
    assert.deepEqual(srcs, ['data:image/png;base64,' + PNG_1X1.toString('base64')])
  })

  test('site-origin absolute URLs (PDF base) resolve locally, never over the network', async (t) => {
    const { siteDir } = makeSiteFixture(t)
    const srv = await startServer((req, res) => res.end('should not be hit'))
    t.after(srv.close)
    usePublicTestHost(t, srv.port)
    const out = await resolveExportImages(
      '<img src="http://cms.test/sites/demo/files/pic.png"><img src="http://cms.test/sites/demo/files/nope.png">',
      { siteDir, siteBasePath: '/sites/demo/', selfBaseUrl: 'http://cms.test/sites/demo/' },
    )
    assert.equal(imgSrcs(out).length, 1)
    assert.equal(srv.hits.length, 0)
  })

  test('data URIs: valid images kept, non-image payloads dropped', async () => {
    const good = 'data:image/png;base64,' + PNG_1X1.toString('base64')
    const bad = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64')
    const html = '<img src="' + good + '"><img src="' + bad + '"><img src="data:text/html,<b>x</b>">'
    const out = await resolveExportImages(html, {})
    assert.deepEqual(imgSrcs(out), [good])
  })

  test('output "file" writes copies into tempDir and returns file:// URLs', async (t) => {
    const { siteDir, root } = makeSiteFixture(t)
    const tempDir = fs.mkdtempSync(path.join(root, 'tmp-'))
    const out = await resolveExportImages('<img src="files/pic.png"><img src="files/pic.png">', {
      siteDir,
      siteBasePath: '/',
      output: 'file',
      tempDir,
    })
    const srcs = imgSrcs(out)
    assert.equal(srcs.length, 2)
    assert.notEqual(srcs[0], srcs[1])
    for (const src of srcs) {
      assert.ok(src.indexOf('file://') === 0, src)
      const filePath = require('url').fileURLToPath(src)
      assert.equal(path.dirname(filePath), tempDir)
      assert.deepEqual(fs.readFileSync(filePath), PNG_1X1)
    }
  })

  test('per-document total byte cap drops images past the budget', async (t) => {
    const { siteDir } = makeSiteFixture(t)
    const out = await resolveExportImages('<img src="files/pic.png"><img src="files/pic.png">', {
      siteDir,
      maxTotalBytes: PNG_1X1.length + 1,
    })
    assert.equal(imgSrcs(out).length, 1)
  })
})

// --- DOCX end to end --------------------------------------------------------

describe('convertHtmlToDocxBuffer image handling', () => {
  test('never lets html-to-docx fetch a private-network image', async (t) => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_1X1)
    })
    t.after(srv.close)
    const docx = await convertHtmlToDocxBuffer(
      '<p>hello</p><img src="http://127.0.0.1:' + srv.port + '/secret.png">',
    )
    assert.ok(Buffer.isBuffer(docx) || docx instanceof Uint8Array)
    assert.equal(srv.hits.length, 0)
    const zip = await JSZip.loadAsync(docx)
    assert.equal(Object.keys(zip.files).filter((n) => n.indexOf('word/media/') === 0).length, 0)
  })

  test('embeds a local site image as media', async (t) => {
    const { siteDir } = makeSiteFixture(t)
    const docx = await convertHtmlToDocxBuffer('<p>hello</p><img src="files/pic.png">', {
      siteDir,
      siteBasePath: '/sites/demo/',
    })
    const zip = await JSZip.loadAsync(docx)
    // html-to-docx writes the media part more than once; at least one is ours
    const media = Object.keys(zip.files).filter((n) => n.indexOf('word/media/') === 0 && !zip.files[n].dir)
    assert.ok(media.length >= 1)
    assert.deepEqual(await zip.file(media[0]).async('nodebuffer'), PNG_1X1)
  })
})

// --- EPUB end to end --------------------------------------------------------

describe('EPUB export image handling', () => {
  test('embeds local images, drops private remote ones, never fetches them', async (t) => {
    const { siteDir } = makeSiteFixture(t)
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_1X1)
    })
    t.after(srv.close)
    const { HAXCMS } = require('../../src/lib/HAXCMS.js')
    const { itemExport } = require('../../src/siteRoutes/v1/exports.js')
    const item = {
      id: 'item-1', title: 'Page', slug: 'page', parent: null, indent: 0, order: 0,
      location: 'pages/item-1/index.html', metadata: { published: true },
    }
    const site = {
      siteDirectory: siteDir,
      name: 'demo',
      manifest: {
        title: 'Demo',
        metadata: { site: { name: 'demo', logo: 'http://127.0.0.1:' + srv.port + '/logo.png' } },
        items: [item],
      },
      loadNode() { return item },
      async getPageContent() {
        return '<p>x</p><img src="files/pic.png" alt="local">' +
          '<img src="http://127.0.0.1:' + srv.port + '/secret.png" alt="remote">' +
          '<img src="file:///etc/passwd" alt="file">'
      },
    }
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    const res = {
      statusCode: null, headers: {}, sent: null, body: null,
      status(c) { this.statusCode = c; return this },
      json(o) { this.body = o; return this },
      send(v) { this.sent = v; return this },
      set(n, v) { this.headers[n] = v; return this },
      setHeader(n, v) { this.headers[n] = v; return this },
    }
    await itemExport({
      headers: { host: 'cms.example.com' },
      query: {},
      params: { idOrSlug: 'page', format: 'epub' },
      body: {},
      haxcmsSiteApiAuth: { authenticated: true, securityLevel: 'authenticated-site', userName: 'tester', siteName: 'demo' },
    }, res)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(srv.hits.length, 0)
    const zip = await JSZip.loadAsync(res.sent)
    const images = Object.keys(zip.files).filter((n) => /OEBPS\/images\//.test(n) && !zip.files[n].dir)
    assert.equal(images.length, 1)
    assert.deepEqual(await zip.file(images[0]).async('nodebuffer'), PNG_1X1)
    const chapterNames = Object.keys(zip.files).filter((n) => /\.xhtml$/.test(n))
    let allChapters = ''
    for (const name of chapterNames) {
      allChapters += await zip.file(name).async('string')
    }
    assert.ok(allChapters.indexOf('127.0.0.1') === -1)
    assert.ok(allChapters.indexOf('file://') === -1)
    assert.ok(allChapters.indexOf('/etc/passwd') === -1)
  })
})

// --- PDF request filter -----------------------------------------------------

describe('PDF request interception', () => {
  test('isAllowedPdfRequestUrl allows only data: and about:blank/srcdoc', () => {
    assert.equal(isAllowedPdfRequestUrl('data:image/png;base64,AAAA'), true)
    assert.equal(isAllowedPdfRequestUrl('DATA:text/css,body{}'), true)
    assert.equal(isAllowedPdfRequestUrl('about:blank'), true)
    assert.equal(isAllowedPdfRequestUrl('about:srcdoc'), true)
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'https://example.com/a.css',
      'file:///etc/passwd',
      'ws://127.0.0.1:9222/',
      'blob:https://x/1',
      'chrome://settings',
      'about:config',
      '',
    ]) {
      assert.equal(isAllowedPdfRequestUrl(url), false, url)
    }
  })

  test('installPdfRequestFilter enables interception and aborts disallowed requests', async () => {
    const calls = []
    let handler = null
    const page = {
      async setRequestInterception(v) { calls.push(['intercept', v]) },
      on(event, fn) { if (event === 'request') { handler = fn } },
    }
    await installPdfRequestFilter(page)
    assert.deepEqual(calls, [['intercept', true]])
    function fakeRequest(url) {
      const r = { url: () => url, outcome: null }
      r.continue = () => { r.outcome = 'continue' }
      r.abort = () => { r.outcome = 'abort' }
      return r
    }
    const allowed = fakeRequest('data:image/png;base64,AAAA')
    const blocked = fakeRequest('http://10.0.0.1/x.png')
    const blockedFile = fakeRequest('file:///etc/passwd')
    handler(allowed)
    handler(blocked)
    handler(blockedFile)
    assert.equal(allowed.outcome, 'continue')
    assert.equal(blocked.outcome, 'abort')
    assert.equal(blockedFile.outcome, 'abort')
  })
})

// --- YAML -------------------------------------------------------------------

function yamlRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this },
    json(o) { this.body = o; return this },
  }
}

describe('YAML anchors/aliases and size cap', () => {
  test('loadYamlSafely parses ordinary YAML including & and * in plain text', () => {
    assert.deepEqual(loadYamlSafely('a: 1\nb: [x, y]'), { a: 1, b: ['x', 'y'] })
    assert.deepEqual(loadYamlSafely('t: Tom & Jerry\nd: some *bold* text\nq: "&x *y"'), {
      t: 'Tom & Jerry',
      d: 'some *bold* text',
      q: '&x *y',
    })
  })

  test('loadYamlSafely rejects anchors, aliases and merge keys', () => {
    const docs = [
      'a: &x 1\nb: *x',
      'base: &b {x: 1}\nc:\n  <<: *b',
      '- &a [1, 2]\n- *a',
      '? &k key\n: v',
      'a: &x\nb: 2',
    ]
    for (const doc of docs) {
      assert.throws(() => loadYamlSafely(doc), (err) => {
        assert.equal(err.code, 'YAML_ALIAS')
        assert.equal(err.message, YAML_ALIAS_ERROR_MESSAGE)
        return true
      }, doc)
    }
  })

  test('billion-laughs document is rejected before expansion', () => {
    let doc = 'l0: &l0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n'
    for (let i = 1; i < 10; i++) {
      doc += 'l' + i + ': &l' + i + ' [' + new Array(9).fill('*l' + (i - 1)).join(',') + ']\n'
    }
    const started = Date.now()
    assert.throws(() => loadYamlSafely(doc), (err) => err.code === 'YAML_ALIAS')
    assert.ok(Date.now() - started < 1000)
  })

  test('input over 256 KB is rejected', () => {
    assert.equal(YAML_MAX_INPUT_BYTES, 262144)
    const atLimit = 'a: "' + 'x'.repeat(YAML_MAX_INPUT_BYTES - 6) + '"'
    assert.equal(Buffer.byteLength(atLimit), YAML_MAX_INPUT_BYTES - 1)
    assert.equal(loadYamlSafely(atLimit).a.length, YAML_MAX_INPUT_BYTES - 6)
    assert.throws(() => loadYamlSafely('a: ' + 'x'.repeat(YAML_MAX_INPUT_BYTES)), (err) => err.code === 'YAML_TOO_LARGE')
    // multi-byte characters count as bytes, not code units
    assert.throws(() => loadYamlSafely('a: ' + 'é'.repeat(YAML_MAX_INPUT_BYTES / 2)), (err) => err.code === 'YAML_TOO_LARGE')
  })

  test('yaml-to-json route answers 400 with the parity message for aliases', async () => {
    const res = yamlRes()
    await convertYamlToJson({ body: { yaml: 'a: &x 1\nb: *x' } }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.status, 400)
    assert.equal(res.body.data.error, 'YAML anchors and aliases are not supported')
  })

  test('yaml-to-json route answers 400 for oversized input and 200 for normal input', async () => {
    const big = yamlRes()
    await convertYamlToJson({ body: { yaml: 'a: ' + 'x'.repeat(YAML_MAX_INPUT_BYTES) } }, big)
    assert.equal(big.statusCode, 400)
    assert.equal(big.body.data.error, 'YAML input exceeds the maximum size of 262144 bytes')
    const ok = yamlRes()
    await convertYamlToJson({ body: { yaml: 'a: 1' } }, ok)
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(JSON.parse(ok.body.data.contents), { a: 1 })
  })
})
