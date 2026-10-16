'use strict'

// Security (review 2026-10) regression tests for the export SSRF fixes:
//   - DOCX (html-to-docx), EPUB (epub-gen-memory) and PDF (Puppeteer) export
//     paths never fetch an authored <img> URL themselves: images are resolved
//     through exportImageResolver (site-confined reads, safeFetch with the
//     private/reserved IP guard and a byte cap) and handed over as bytes.
//   - safeFetch enforces a response byte cap (Content-Length upfront and
//     while streaming) and can stream to disk, deleting partial files.
//   - the IP guard blocks the previously missing ranges (0.0.0.0/8,
//     192.0.0.0/24, 198.18.0.0/15, multicast, 240.0.0.0/4, NAT64, 6to4,
//     Teredo, the whole fe80::/10).
//   - HAXCMSFile.downloadAndSaveFile goes through safeFetch.
//   - stageRemoteFile filters the staged extension and sweeps stale files.
//
// A real loopback HTTP listener records every request; the exploit payloads
// point at it, and every test asserts it was never hit. Chrome is not
// available in CI, so the PDF path is covered through preparePdfHtml and the
// request-interception decision function.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const dns = require('dns')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const JSZip = require('jszip')

const safeFetchLib = require('../../src/lib/safeFetch.js')
const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const exportImageResolver = require('../../src/lib/exportImageResolver.js')
const convertUtils = require('../../src/lib/convertUtils.js')
const exportsRoutes = require('../../src/siteRoutes/v1/exports.js')
const stageRemoteFileLib = require('../../src/lib/stageRemoteFile.js')

const { isPrivateOrReservedIP } = safeFetchLib

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// --- helpers -----------------------------------------------------------------

// Loopback listener that records every request. Serves a real PNG so that a
// fetch that slipped through would visibly succeed (embed the image).
async function startRecordingListener(t) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG_BYTES)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { hits: hits, port: server.address().port }
}

// Resolve chosen test hostnames to fixed addresses; everything else uses the
// real resolver (literal IPs resolve to themselves).
function useHostMap(t, map) {
  const prev = dns.promises.lookup
  dns.promises.lookup = async function (hostname, opts) {
    if (Object.prototype.hasOwnProperty.call(map, hostname)) {
      return map[hostname]
    }
    return prev.call(dns.promises, hostname, opts)
  }
  t.after(() => { dns.promises.lookup = prev })
}

function ssrfPayloadHtml(port) {
  return [
    '<p>before</p>',
    '<img src="http://169.254.169.254/latest/meta-data/" alt="metadata">',
    `<img src="http://127.0.0.1:${port}/loopback.png" alt="loopback">`,
    `<img src="http://0.0.0.1:${port}/zero-net.png" alt="zero-net">`,
    `<img src="http://nat64.ssrf.test:${port}/nat64.png" alt="nat64">`,
    `<img src="http://[64:ff9b::7f00:1]:${port}/nat64-literal.png" alt="nat64-literal">`,
    `<img src="http://redirect.ssrf.test:${port}/redir.png" alt="rebind">`,
    '<img src="file:///etc/passwd" alt="file">',
    '<p>after</p>',
  ].join('')
}

function ssrfHostMap() {
  return {
    'nat64.ssrf.test': [{ address: '64:ff9b::7f00:1', family: 6 }],
    // round-robin: one public record plus loopback must be rejected
    'redirect.ssrf.test': [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
  }
}

function makeSiteDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-export-ssrf-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const siteDir = path.join(root, 'demo')
  fs.mkdirSync(path.join(siteDir, 'files'), { recursive: true })
  fs.writeFileSync(path.join(siteDir, 'files', 'local.png'), PNG_BYTES)
  // a sibling site's file must never be readable through ../ or absolute paths
  fs.mkdirSync(path.join(root, 'other', 'files'), { recursive: true })
  fs.writeFileSync(path.join(root, 'other', 'files', 'secret.png'), PNG_BYTES)
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP-SECRET')
  return { root: root, siteDir: siteDir }
}

async function docxMediaEntries(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  return Object.keys(zip.files).filter((name) => name.indexOf('word/media/') === 0 && !zip.files[name].dir)
}

// --- IP guard tables ---------------------------------------------------------

test('IP guard blocks the whole 0.0.0.0/8 (0.0.0.1 reaches localhost on Linux)', () => {
  assert.equal(isPrivateOrReservedIP('0.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('0.255.255.255'), true)
  assert.equal(isPrivateOrReservedIP('1.0.0.0'), false)
})

test('IP guard blocks 192.0.0.0/24, 198.18.0.0/15, multicast, 240.0.0.0/4 and broadcast', () => {
  assert.equal(isPrivateOrReservedIP('192.0.0.8'), true)
  assert.equal(isPrivateOrReservedIP('192.0.1.1'), false)
  assert.equal(isPrivateOrReservedIP('198.18.0.1'), true)
  assert.equal(isPrivateOrReservedIP('198.19.255.255'), true)
  assert.equal(isPrivateOrReservedIP('198.20.0.1'), false)
  assert.equal(isPrivateOrReservedIP('198.17.255.255'), false)
  assert.equal(isPrivateOrReservedIP('224.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('239.255.255.250'), true)
  assert.equal(isPrivateOrReservedIP('240.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('255.255.255.255'), true)
  assert.equal(isPrivateOrReservedIP('223.255.255.255'), false)
})

test('IP guard decodes NAT64 64:ff9b::/96 and re-checks the embedded IPv4', () => {
  assert.equal(isPrivateOrReservedIP('64:ff9b::7f00:1'), true)
  assert.equal(isPrivateOrReservedIP('64:ff9b::127.0.0.1'), true)
  assert.equal(isPrivateOrReservedIP('64:ff9b::a9fe:a9fe'), true)
  assert.equal(isPrivateOrReservedIP('64:ff9b::808:808'), false)
  // local-use NAT64 prefix is blocked outright
  assert.equal(isPrivateOrReservedIP('64:ff9b:1::1'), true)
})

test('IP guard decodes 6to4 (2002::/16) and Teredo (2001::/32) embedded IPv4', () => {
  assert.equal(isPrivateOrReservedIP('2002:7f00:1::1'), true)
  assert.equal(isPrivateOrReservedIP('2002:a9fe:a9fe::'), true)
  assert.equal(isPrivateOrReservedIP('2002:808:808::1'), false)
  // Teredo client 127.0.0.1 is stored XOR 0xffffffff -> 80ff:fffe
  assert.equal(isPrivateOrReservedIP('2001:0:4136:e378:8000:63bf:80ff:fffe'), true)
  assert.equal(isPrivateOrReservedIP('2001:0:4136:e378:8000:63bf:f7f7:f7f7'), false)
})

test('IP guard matches fe80::/10 by mask, plus site-local and multicast v6', () => {
  assert.equal(isPrivateOrReservedIP('fe80::1'), true)
  assert.equal(isPrivateOrReservedIP('FE80::1'), true)
  assert.equal(isPrivateOrReservedIP('fe9f::1'), true)
  assert.equal(isPrivateOrReservedIP('febf:ffff::1'), true)
  assert.equal(isPrivateOrReservedIP('fec0::1'), true)
  assert.equal(isPrivateOrReservedIP('ff02::1'), true)
  assert.equal(isPrivateOrReservedIP('fe7f::1'), false)
})

test('IP guard keeps public addresses public', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:db8::1.2.3.4', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateOrReservedIP(ip), false, ip)
  }
})

test('safeFetch rejects a hostname resolving to NAT64-embedded loopback', async (t) => {
  useHostMap(t, ssrfHostMap())
  await assert.rejects(safeFetchLib.safeFetch('http://nat64.ssrf.test/'), (err) => {
    assert.equal(err.code, 'SSRF_PRIVATE')
    return true
  })
})

// --- safeFetch byte cap --------------------------------------------------------

function useHttpStub(t, handler) {
  const prev = http.request
  const calls = []
  http.request = function (options, cb) {
    const req = new EventEmitter()
    req.destroyed = false
    req.write = function () {}
    req.destroy = function () { req.destroyed = true }
    req.end = function () {
      process.nextTick(() => {
        const res = new EventEmitter()
        handler(res, req)
        cb(res)
        process.nextTick(() => {
          const chunks = res.__chunks || []
          let i = 0
          function next() {
            if (req.destroyed) { return }
            if (i < chunks.length) {
              res.emit('data', chunks[i++])
              setImmediate(next)
            } else {
              res.emit('end')
            }
          }
          next()
        })
      })
    }
    calls.push({ options: options, req: req })
    return req
  }
  t.after(() => { http.request = prev })
  return calls
}

test('safeFetch rejects a declared Content-Length over maxBytes before reading the body', async (t) => {
  useHostMap(t, { 'big.example.test': [{ address: '93.184.216.34', family: 4 }] })
  const calls = useHttpStub(t, (res) => {
    res.statusCode = 200
    res.headers = { 'content-length': String(50 * 1024 * 1024) }
    res.__chunks = [Buffer.alloc(10)]
  })
  await assert.rejects(
    safeFetchLib.safeFetch('http://big.example.test/huge.bin', { maxBytes: 1024 }),
    (err) => {
      assert.equal(err.code, 'SSRF_TOO_LARGE')
      return true
    },
  )
  assert.equal(calls[0].req.destroyed, true, 'request aborted')
})

test('safeFetch aborts a streamed body once it crosses maxBytes (no Content-Length)', async (t) => {
  useHostMap(t, { 'stream.example.test': [{ address: '93.184.216.34', family: 4 }] })
  const calls = useHttpStub(t, (res) => {
    res.statusCode = 200
    res.headers = {}
    res.__chunks = [Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)]
  })
  await assert.rejects(
    safeFetchLib.safeFetch('http://stream.example.test/endless', { maxBytes: 1000 }),
    (err) => {
      assert.equal(err.code, 'SSRF_TOO_LARGE')
      return true
    },
  )
  assert.equal(calls[0].req.destroyed, true, 'request aborted mid-stream')
})

test('safeFetch applies a 20 MB default cap when no maxBytes is given', async (t) => {
  useHostMap(t, { 'default.example.test': [{ address: '93.184.216.34', family: 4 }] })
  useHttpStub(t, (res) => {
    res.statusCode = 200
    res.headers = { 'content-length': String(safeFetchLib.SAFE_FETCH_DEFAULT_MAX_BYTES + 1) }
  })
  assert.equal(safeFetchLib.SAFE_FETCH_DEFAULT_MAX_BYTES, 20 * 1024 * 1024)
  await assert.rejects(safeFetchLib.safeFetch('http://default.example.test/x'), (err) => {
    assert.equal(err.code, 'SSRF_TOO_LARGE')
    return true
  })
})

test('safeFetch streams to filePath and deletes the partial file when the cap is crossed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-safefetch-file-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  useHostMap(t, { 'file.example.test': [{ address: '93.184.216.34', family: 4 }] })
  let body = [Buffer.from('hello '), Buffer.from('world')]
  useHttpStub(t, (res) => {
    res.statusCode = 200
    res.headers = {}
    res.__chunks = body
  })
  const okPath = path.join(dir, 'ok.bin')
  const ok = await safeFetchLib.safeFetch('http://file.example.test/ok', { filePath: okPath, maxBytes: 100 })
  assert.equal(ok.ok, true)
  assert.equal(ok.filePath, okPath)
  assert.equal(fs.readFileSync(okPath, 'utf8'), 'hello world')

  body = [Buffer.alloc(80), Buffer.alloc(80)]
  const bigPath = path.join(dir, 'big.bin')
  await assert.rejects(
    safeFetchLib.safeFetch('http://file.example.test/big', { filePath: bigPath, maxBytes: 100 }),
    (err) => err.code === 'SSRF_TOO_LARGE',
  )
  assert.equal(fs.existsSync(bigPath), false, 'partial file removed')
})

// --- HAXCMSFile.downloadAndSaveFile --------------------------------------------

test('downloadAndSaveFile never connects to a private target and leaves no file behind', async (t) => {
  const listener = await startRecordingListener(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-download-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  useHostMap(t, ssrfHostMap())
  const targets = [
    `http://127.0.0.1:${listener.port}/a.png`,
    `http://0.0.0.1:${listener.port}/a.png`,
    `http://nat64.ssrf.test:${listener.port}/a.png`,
    `http://redirect.ssrf.test:${listener.port}/a.png`,
  ]
  for (let i = 0; i < targets.length; i++) {
    const target = path.join(dir, 'dl-' + i)
    await assert.rejects(HAXCMSFile.downloadAndSaveFile(targets[i], target))
    assert.equal(fs.existsSync(target), false)
  }
  assert.deepEqual(listener.hits, [])
})

test('downloadAndSaveFile streams through safeFetch with a byte cap and removes the partial file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-download-cap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  t.mock.method(safeFetchLib, 'getUploadMaxBytes', async () => 1000)
  useHostMap(t, { 'files.example.test': [{ address: '93.184.216.34', family: 4 }] })
  useHttpStub(t, (res) => {
    res.statusCode = 200
    res.headers = {}
    res.__chunks = [Buffer.alloc(700), Buffer.alloc(700)]
  })
  const target = path.join(dir, 'upload.bin')
  await assert.rejects(
    HAXCMSFile.downloadAndSaveFile('http://files.example.test/big.png', target),
    (err) => err.code === 'SSRF_TOO_LARGE',
  )
  assert.equal(fs.existsSync(target), false)
})

// --- DOCX export -----------------------------------------------------------------

test('DOCX export never fetches SSRF image payloads (html-to-docx gets no URLs)', async (t) => {
  const listener = await startRecordingListener(t)
  useHostMap(t, ssrfHostMap())
  const buffer = await convertUtils.convertHtmlToDocxBuffer(ssrfPayloadHtml(listener.port))
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0)
  assert.deepEqual(listener.hits, [], 'no request reached the loopback listener')
  assert.deepEqual(await docxMediaEntries(buffer), [], 'no image was embedded')
})

test('DOCX export embeds site images from disk and data: images, but not files outside the site', async (t) => {
  const listener = await startRecordingListener(t)
  const dirs = makeSiteDir(t)
  const html = [
    '<img src="/sites/demo/files/local.png" alt="site file">',
    '<img src="data:image/png;base64,' + PNG_BYTES.toString('base64') + '" alt="inline">',
    '<img src="/sites/demo/../other/files/secret.png" alt="traversal">',
    '<img src="../other/files/secret.png" alt="relative traversal">',
    '<img src="' + path.join(dirs.root, 'other', 'files', 'secret.png') + '" alt="absolute path">',
    '<img src="data:text/html;base64,' + Buffer.from('<h1>x</h1>').toString('base64') + '" alt="not an image">',
    `<img src="http://127.0.0.1:${listener.port}/x.png">`,
  ].join('')
  const buffer = await convertUtils.convertHtmlToDocxBuffer(html, {
    siteDirectory: dirs.siteDir,
    basePaths: ['/sites/demo/'],
  })
  // html-to-docx writes a fixed number of media parts per embedded image, so
  // compare with a document holding only the two allowed images
  const expected = await convertUtils.convertHtmlToDocxBuffer(
    '<img src="data:image/png;base64,' + PNG_BYTES.toString('base64') + '">' +
      '<img src="data:image/png;base64,' + PNG_BYTES.toString('base64') + '">',
  )
  const mediaCount = (await docxMediaEntries(buffer)).length
  assert.ok(mediaCount > 0, 'site file and data: image embedded')
  assert.equal(mediaCount, (await docxMediaEntries(expected)).length, 'only the site file and the data: image')
  assert.deepEqual(listener.hits, [])
})

// --- exportImageResolver unit cases --------------------------------------------

test('inlineExportImages rewrites every img to a data: URI or removes it', async (t) => {
  const listener = await startRecordingListener(t)
  useHostMap(t, ssrfHostMap())
  const dirs = makeSiteDir(t)
  const out = await exportImageResolver.inlineExportImages(
    ssrfPayloadHtml(listener.port) +
      '<img src="files/local.png" srcset="http://127.0.0.1:' + listener.port + '/2x.png 2x">' +
      '<picture><source srcset="http://127.0.0.1:' + listener.port + '/s.png"><img src="local.png"></picture>',
    { siteDirectory: dirs.siteDir, basePaths: ['/sites/demo/'] },
  )
  assert.deepEqual(listener.hits, [])
  const srcs = out.match(/src="[^"]*"/g) || []
  assert.equal(srcs.length, 2, out)
  for (const src of srcs) {
    assert.ok(src.indexOf('src="data:image/png;base64,') === 0, src)
  }
  assert.equal(/srcset|<source/i.test(out), false)
})

test('resolveLocalExportImageFile confines reads to the site directory', (t) => {
  const dirs = makeSiteDir(t)
  const resolve = (src) => exportImageResolver.resolveLocalExportImageFile(src, ['/sites/demo/'], dirs.siteDir)
  assert.equal(resolve('/sites/demo/files/local.png'), fs.realpathSync(path.join(dirs.siteDir, 'files', 'local.png')))
  assert.equal(resolve('local.png'), fs.realpathSync(path.join(dirs.siteDir, 'files', 'local.png')))
  assert.equal(resolve('../secret.txt'), '')
  assert.equal(resolve('/sites/demo/%2e%2e/secret.txt'), '')
  assert.equal(resolve('files/local.png\0.txt'), '')
  // a symlink inside the site pointing outside is rejected by the realpath check
  fs.symlinkSync(path.join(dirs.root, 'secret.txt'), path.join(dirs.siteDir, 'files', 'link.png'))
  assert.equal(resolve('files/link.png'), '')
})

test('sniffImageMime trusts magic bytes, not names', () => {
  assert.equal(exportImageResolver.sniffImageMime(PNG_BYTES), 'image/png')
  assert.equal(exportImageResolver.sniffImageMime(Buffer.from('<html>login</html>')), null)
  assert.equal(exportImageResolver.sniffImageMime(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>')), 'image/svg+xml')
})

// --- EPUB export -----------------------------------------------------------------

function makeEpubSite(siteDir, html, logo) {
  const items = [
    {
      id: 'item-1',
      title: 'First Page',
      slug: 'first-page',
      parent: null,
      indent: 0,
      order: 0,
      location: 'pages/item-1/index.html',
      metadata: { published: true },
    },
  ]
  return {
    siteDirectory: siteDir,
    name: 'demo',
    manifest: {
      title: 'Demo Site',
      description: 'A demo site',
      metadata: {
        site: { name: 'demo', logo: logo, updated: 1700000000, lang: 'en' },
        author: { name: 'Test Author' },
      },
      items: items,
      findBranch() { return items },
    },
    loadNode(id) { return id === 'item-1' ? items[0] : null },
    async getPageContent() { return html },
  }
}

test('EPUB export never fetches SSRF image payloads or a remote/internal cover', async (t) => {
  const listener = await startRecordingListener(t)
  useHostMap(t, ssrfHostMap())
  const dirs = makeSiteDir(t)
  const site = makeEpubSite(
    dirs.siteDir,
    ssrfPayloadHtml(listener.port) + '<img src="files/local.png" alt="ok">',
    `http://127.0.0.1:${listener.port}/cover.png`,
  )
  const buffer = await exportsRoutes.buildSiteExportEpubBuffer(site, '/sites/demo/')
  assert.deepEqual(listener.hits, [], 'no request reached the loopback listener')
  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files)
  const images = names.filter((name) => name.indexOf('OEBPS/images/') === 0 && !zip.files[name].dir)
  assert.equal(images.length, 1, 'only the site-local image is packaged')
  assert.deepEqual(await zip.file(images[0]).async('nodebuffer'), PNG_BYTES)
  assert.equal(names.some((name) => /cover\./.test(name) && name.indexOf('OEBPS/cover.') === 0), false, 'remote cover not fetched')
  const chapter = await zip.file(names.find((name) => name.indexOf('first-page.xhtml') !== -1)).async('string')
  assert.equal(/169\.254|127\.0\.0\.1|file:\/\//.test(chapter), false)
})

test('EPUB export packages a site-local cover without fetching it', async (t) => {
  const dirs = makeSiteDir(t)
  const site = makeEpubSite(dirs.siteDir, '<p>text</p>', 'files/local.png')
  const buffer = await exportsRoutes.buildItemExportEpubBuffer(site, site.manifest.items[0], '/sites/demo/')
  const zip = await JSZip.loadAsync(buffer)
  const cover = zip.file('OEBPS/cover.png')
  assert.ok(cover, 'cover packaged')
  assert.deepEqual(await cover.async('nodebuffer'), PNG_BYTES)
})

test('SafeEPub never calls the library fetcher, even for srcs only its own parser sees', async (t) => {
  const listener = await startRecordingListener(t)
  const buffer = await new exportsRoutes.SafeEPub(
    { title: 't', verbose: false, ignoreFailedDownloads: true },
    [{ title: 'a', content: `<p>x</p><img src="http://127.0.0.1:${listener.port}/direct.png" alt="">` }],
  ).genEpub()
  assert.ok(buffer.length > 0)
  assert.deepEqual(listener.hits, [])
})

// --- PDF export (Chrome unavailable: pre-processing + interception policy) -----

test('preparePdfHtml resolves images without fetching SSRF payloads', async (t) => {
  const listener = await startRecordingListener(t)
  useHostMap(t, ssrfHostMap())
  const dirs = makeSiteDir(t)
  const base = 'http://cms.example.com/sites/demo/'
  const html = await convertUtils.preparePdfHtml(
    ssrfPayloadHtml(listener.port) + '<img src="http://cms.example.com/sites/demo/files/local.png">',
    base,
    { siteDirectory: dirs.siteDir, basePaths: ['/sites/demo/'] },
  )
  assert.deepEqual(listener.hits, [])
  const srcs = html.match(/src="[^"]*"/g) || []
  assert.equal(srcs.length, 1, html)
  assert.ok(srcs[0].indexOf('src="data:image/png;base64,') === 0)
})

test('preparePdfHtml with a user base URL only fetches relative images through the guard', async (t) => {
  const listener = await startRecordingListener(t)
  const html = await convertUtils.preparePdfHtml('<img src="x.png"><img src="/y.png">', `http://127.0.0.1:${listener.port}/`)
  assert.deepEqual(listener.hits, [])
  assert.equal(/<img/.test(html), false)
})

test('PDF request interception only allows data: and about: URLs', () => {
  const allow = convertUtils.isAllowedPdfRequestUrl
  assert.equal(allow('data:image/png;base64,AAAA'), true)
  assert.equal(allow('about:blank'), true)
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/',
    'https://example.com/style.css',
    'file:///etc/passwd',
    'ws://127.0.0.1/',
    '',
  ]) {
    assert.equal(allow(url), false, url)
  }
})

// --- stageRemoteFile -----------------------------------------------------------

test('stageRemoteFile keeps only allowlisted extensions on staged files', () => {
  assert.equal(stageRemoteFileLib.getStagedExtension('files/photo.PNG'), '.png')
  assert.equal(stageRemoteFileLib.getStagedExtension('files/x.php'), '')
  assert.equal(stageRemoteFileLib.getStagedExtension('files/x.phtml?y=.png'), '')
  assert.equal(stageRemoteFileLib.getStagedExtension('files/noext'), '')
})

test('stageRemoteFile sweeps its own stale staged files only', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-stage-sweep-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const old = path.join(dir, 'haximp-old.png')
  const fresh = path.join(dir, 'haximp-fresh.png')
  const foreign = path.join(dir, 'other-old.png')
  for (const file of [old, fresh, foreign]) {
    fs.writeFileSync(file, 'x')
  }
  const past = new Date(Date.now() - stageRemoteFileLib.STAGED_FILE_TTL_MS - 60000)
  fs.utimesSync(old, past, past)
  fs.utimesSync(foreign, past, past)
  assert.equal(stageRemoteFileLib.sweepStaleStagedFiles(dir), 1)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(fresh), true)
  assert.equal(fs.existsSync(foreign), true)
})

test('stageRemoteFile caps the download and filters the staged extension', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-stage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  t.mock.method(safeFetchLib, 'getUploadMaxBytes', async () => 4096)
  const seen = []
  t.mock.method(safeFetchLib, 'safeFetch', async (url, opts) => {
    seen.push(opts)
    return { ok: true, arrayBuffer: async () => Buffer.from('<?php echo 1;') }
  })
  const staged = await stageRemoteFileLib.stageRemoteFile('https://example.com/x.php', dir, 0, 'files/x.php')
  assert.ok(staged)
  assert.equal(path.extname(staged), '')
  assert.equal(seen[0].maxBytes, 4096)
})
