'use strict'

/**
 * PHP export-endpoints integration test.
 *
 * Targets a running HAXcms PHP instance (via DDEV: https://haxcms.ddev.site).
 * Mirrors the NodeJS export-endpoints.integration.test.cjs — verifies item +
 * site export endpoints produce real on-premises file downloads across all
 * 8 formats with correct Content-Type, Content-Disposition, and binary
 * signatures, plus the exports-block advertisement and 400-on-unsupported.
 *
 * Prerequisites:
 *   - ddev start (from haxcms-php) so https://haxcms.ddev.site is up
 *   - the target site (default: blog) exists in _sites/ with at least one item
 *
 * Run:
 *   node test/api-conformance/export-endpoints-php.integration.test.cjs
 *   # or via the test runner:
 *   node --test test/api-conformance/export-endpoints-php.integration.test.cjs
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const https = require('node:https')
const axios = require('axios')

const PHP_BASE_URL = process.env.HAXCMS_PHP_BASE_URL || 'https://haxcms.ddev.site'
const TARGET_SITE = process.env.HAXCMS_PHP_TEST_SITE || 'blog'

// DDEV serves PHP over a self-signed cert issued by the local mkcert root CA.
// Validate against that CA when available; fall back to disabling verification
// only if the CA cannot be located so the integration test still runs.
const DDEV_CA_CANDIDATES = [
  path.join(process.env.HOME || '', '.local', 'share', 'mkcert', 'rootCA.pem'),
  path.join(process.env.HOME || '', '.ddev', 'ca', 'rootCA.pem'),
]
const HTTPS_AGENT = (() => {
  for (const candidate of DDEV_CA_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      try {
        return new https.Agent({ ca: fs.readFileSync(candidate) })
      } catch (error) {
        // fall through to the insecure fallback below
      }
    }
  }
  return new https.Agent({ rejectUnauthorized: false })
})()

const ITEM_EXPORT_FORMATS = ['pdf', 'docx', 'html', 'md', 'json', 'yaml', 'xml', 'epub']
const SITE_EXPORT_FORMATS = ['pdf', 'docx', 'html', 'epub']

const EXPECTED_MEDIA_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  md: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  xml: 'application/xml',
  epub: 'application/epub+zip',
}

// The PHP OpenAPI spec and sites live in the sibling haxcms-php repo, not the
// NodeJS repo this test ships in. Resolve across the shared haxtheweb parent.
const HAXCMS_PHP_ROOT = path.resolve(__dirname, '..', '..', '..', 'haxcms-php')
const SITE_SPEC_PATH = path.resolve(
  HAXCMS_PHP_ROOT,
  'system',
  'backend',
  'php',
  'lib',
  'siteRoutes',
  'openapi',
  'site-spec.yaml',
)

function getBinarySignature(buffer, format) {
  const hex = Buffer.from(buffer).slice(0, 8).toString('hex').toUpperCase()
  switch (format) {
    case 'pdf':
      return hex.startsWith('25504446') // %PDF
    case 'docx':
    case 'epub':
      return hex.startsWith('504B0304') // PK zip
    default:
      return null
  }
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(String(value || ''))
  } catch (error) {
    return null
  }
}

async function sendHttpRequest(requestConfig) {
  const response = await axios({
    method: requestConfig.method,
    url: requestConfig.url,
    headers: requestConfig.headers,
    data: requestConfig.body,
    validateStatus: () => true,
    responseType: requestConfig.responseType || 'text',
    transformResponse: [(data) => data],
    maxRedirects: 0,
    httpsAgent: HTTPS_AGENT,
  })
  return {
    status: response.status,
    headers: response.headers || {},
    bodyText: typeof response.data === 'string' ? response.data : '',
    data: response.data,
  }
}

function resolveFirstItemSlug() {
  const siteJsonPath = path.resolve(HAXCMS_PHP_ROOT, '_sites', TARGET_SITE, 'site.json')
  assert.ok(
    fs.existsSync(siteJsonPath),
    `Target site site.json not found at ${siteJsonPath}. Ensure ddev is running and the "${TARGET_SITE}" site exists.`,
  )
  const site = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'))
  const items = Array.isArray(site.items) ? site.items : []
  assert.ok(items.length > 0, `Target site "${TARGET_SITE}" has no items to export`)
  const first = items[0]
  const slug = String(first.slug || first.id || '').trim()
  assert.ok(slug !== '', `First item in "${TARGET_SITE}" has no slug or id`)
  return slug
}

let firstItemSlug = null
let phpAvailable = false
const siteApiBase = `${PHP_BASE_URL}/_sites/${TARGET_SITE}/x/api`
const PHP_SKIP_REASON = 'PHP HAXcms instance not reachable — run "ddev start" from haxcms-php'

test.before(async () => {
  // Confirm the PHP instance is reachable and the site API is up. When ddev
  // is not running, mark the suite unavailable so HTTP-dependent tests skip
  // gracefully instead of failing the conformance run.
  try {
    const discovery = await sendHttpRequest({
      method: 'GET',
      url: siteApiBase,
      headers: { accept: 'application/json' },
    })
    if (discovery.status === 200) {
      phpAvailable = true
      firstItemSlug = resolveFirstItemSlug()
    }
  } catch (error) {
    phpAvailable = false
  }
})

test('PHP item export endpoints produce real file downloads across all 8 formats', async (t) => {
  if (!phpAvailable) {
    t.skip(PHP_SKIP_REASON)
    return
  }
  const itemBase = `${siteApiBase}/v1/items/${encodeURIComponent(firstItemSlug)}/export`
  for (let i = 0; i < ITEM_EXPORT_FORMATS.length; i++) {
    const format = ITEM_EXPORT_FORMATS[i]
    await t.test(`item export ${format} returns 200 with correct content-type and disposition`, async () => {
      const result = await sendHttpRequest({
        method: 'GET',
        url: `${itemBase}/${format}`,
        headers: { accept: '*/*' },
        responseType: 'arraybuffer',
      })
      assert.equal(result.status, 200, `item export ${format} expected 200, got ${result.status}`)
      const contentType = String(result.headers['content-type'] || '').toLowerCase()
      const expected = EXPECTED_MEDIA_TYPES[format]
      assert.ok(
        contentType.indexOf(expected.split(';')[0]) !== -1,
        `item export ${format} content-type "${contentType}" does not include "${expected}"`,
      )
      const disposition = String(result.headers['content-disposition'] || '')
      assert.ok(
        disposition.indexOf('attachment') !== -1 && disposition.indexOf(`.${format}`) !== -1,
        `item export ${format} missing attachment disposition with .${format} extension: "${disposition}"`,
      )
      const buffer = Buffer.from(result.data || '')
      assert.ok(buffer.length > 0, `item export ${format} returned empty body`)
      const sig = getBinarySignature(buffer, format)
      if (sig !== null) {
        assert.ok(sig, `item export ${format} binary signature mismatch (first bytes: ${buffer.slice(0, 8).toString('hex')})`)
      }
      if (format === 'html') {
        const text = buffer.toString('utf8')
        assert.ok(text.toLowerCase().indexOf('<!doctype html') !== -1 || text.toLowerCase().indexOf('<html') !== -1, `item export html is not an HTML document`)
      }
      if (format === 'md') {
        const text = buffer.toString('utf8')
        assert.ok(text.indexOf('# ') !== -1, `item export md missing title heading`)
      }
      if (format === 'json') {
        const parsed = parseJsonSafely(buffer.toString('utf8'))
        assert.ok(parsed && (parsed.id || parsed.title || parsed.slug), `item export json not a valid item record`)
      }
      if (format === 'yaml') {
        const text = buffer.toString('utf8')
        assert.ok(text.indexOf('id:') !== -1 || text.indexOf('title:') !== -1, `item export yaml missing expected keys`)
      }
      if (format === 'xml') {
        const text = buffer.toString('utf8')
        assert.ok(text.indexOf('<?xml') !== -1 || text.indexOf('<response') !== -1 || text.indexOf('<item') !== -1, `item export xml missing xml declaration/root`)
      }
    })
  }
})

test('PHP item record advertises all 8 export formats in the exports block', async (t) => {
  if (!phpAvailable) {
    t.skip(PHP_SKIP_REASON)
    return
  }
  const result = await sendHttpRequest({
    method: 'GET',
    url: `${siteApiBase}/v1/items/${encodeURIComponent(firstItemSlug)}`,
    headers: { accept: 'application/json' },
  })
  assert.equal(result.status, 200, `item detail expected 200, got ${result.status}`)
  const body = parseJsonSafely(result.bodyText)
  const exports = body && body.data && body.data.exports
  assert.ok(exports && typeof exports === 'object', 'item detail missing exports object')
  for (let i = 0; i < ITEM_EXPORT_FORMATS.length; i++) {
    const format = ITEM_EXPORT_FORMATS[i]
    assert.ok(
      Object.prototype.hasOwnProperty.call(exports, format),
      `exports block missing key "${format}" (has: ${Object.keys(exports).join(', ')})`,
    )
    assert.ok(
      String(exports[format]).indexOf(`/export/${format}`) !== -1,
      `exports.${format} does not point at the export endpoint: "${exports[format]}"`,
    )
  }
})

test('PHP site export endpoints produce real file downloads for pdf/docx/html/epub', async (t) => {
  if (!phpAvailable) {
    t.skip(PHP_SKIP_REASON)
    return
  }
  const siteExportBase = `${siteApiBase}/v1/site/export`
  for (let i = 0; i < SITE_EXPORT_FORMATS.length; i++) {
    const format = SITE_EXPORT_FORMATS[i]
    await t.test(`site export ${format} returns 200 with correct content-type`, async () => {
      const result = await sendHttpRequest({
        method: 'GET',
        url: `${siteExportBase}/${format}`,
        headers: { accept: '*/*' },
        responseType: 'arraybuffer',
      })
      assert.equal(result.status, 200, `site export ${format} expected 200, got ${result.status}`)
      const contentType = String(result.headers['content-type'] || '').toLowerCase()
      const expected = EXPECTED_MEDIA_TYPES[format]
      assert.ok(
        contentType.indexOf(expected.split(';')[0]) !== -1,
        `site export ${format} content-type "${contentType}" does not include "${expected}"`,
      )
      const buffer = Buffer.from(result.data || '')
      assert.ok(buffer.length > 0, `site export ${format} returned empty body`)
      const sig = getBinarySignature(buffer, format)
      if (sig !== null) {
        assert.ok(sig, `site export ${format} binary signature mismatch`)
      }
      if (format === 'html') {
        const text = buffer.toString('utf8')
        assert.ok(text.toLowerCase().indexOf('<!doctype html') !== -1 || text.toLowerCase().indexOf('<html') !== -1, `site export html is not an HTML document`)
      } else {
        // Binary formats must be served as attachment downloads.
        const disposition = String(result.headers['content-disposition'] || '')
        assert.ok(
          disposition.indexOf('attachment') !== -1 && disposition.indexOf(`.${format}`) !== -1,
          `site export ${format} missing attachment disposition with .${format} extension`,
        )
      }
    })
  }
})

test('PHP unsupported item export format returns 400', async (t) => {
  if (!phpAvailable) {
    t.skip(PHP_SKIP_REASON)
    return
  }
  const result = await sendHttpRequest({
    method: 'GET',
    url: `${siteApiBase}/v1/items/${encodeURIComponent(firstItemSlug)}/export/txt`,
    headers: { accept: 'application/json' },
  })
  assert.equal(result.status, 400, `unsupported format expected 400, got ${result.status}`)
  const body = parseJsonSafely(result.bodyText)
  assert.ok(body && Array.isArray(body.supportedFormats), '400 response missing supportedFormats array')
})

test('PHP site-spec.yaml ItemExportFormat enum includes all 8 formats', async () => {
  assert.ok(fs.existsSync(SITE_SPEC_PATH), `PHP site-spec.yaml not found at ${SITE_SPEC_PATH}`)
  const specRaw = fs.readFileSync(SITE_SPEC_PATH, 'utf8')
  // Lightweight parse: find the ItemExportFormat enum block and check the listed values.
  const enumMatch = specRaw.match(/ItemExportFormat:\s*\n(?:\s+name:.*\n)*\s+in: path\s*\n\s+required: true\s*\n\s+schema:\s*\n\s+type: string\s*\n\s+enum:\s*\n((?:\s+- \S+\n)+)/)
  assert.ok(enumMatch, 'ItemExportFormat enum block not found in PHP site-spec.yaml')
  const enumValues = enumMatch[1]
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((v) => v !== '')
  for (let i = 0; i < ITEM_EXPORT_FORMATS.length; i++) {
    const format = ITEM_EXPORT_FORMATS[i]
    assert.ok(
      enumValues.indexOf(format) !== -1,
      `PHP site-spec ItemExportFormat enum missing "${format}" (has: ${enumValues.join(', ')})`,
    )
  }
})
