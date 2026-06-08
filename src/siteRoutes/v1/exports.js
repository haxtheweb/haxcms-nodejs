const {
  getApiBasePath,
  resolveSiteForRequest,
  getSiteBasePath,
  sendFormattedResponse,
  findItemByIdOrSlug,
  getOrderedItems,
  getItemContent,
} = require('./siteRouteUtils.js')
const { HAXCMS } = require('../../lib/HAXCMS.js')

const SITE_EXPORT_FORMATS = ['zip', 'markdown', 'pdf', 'docx', 'epub', 'skeleton']
const ITEM_EXPORT_FORMATS = ['pdf', 'docx']
const OPEN_APIS_BASE = 'https://open-apis.hax.cloud'
const EXPORT_SERVICE_PATHS = {
  pdf: '/api/services/media/format/htmlToPdf',
  docx: '/api/services/media/format/htmlToDocx',
}
const EXPORT_MEDIA_TYPES = {
  pdf: 'application/pdf',
  docx:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function normalizeFormatValue(value = '') {
  return String(value || '').trim().toLowerCase()
}

function getSystemApiBasePath(apiBasePath = '/x/api') {
  const normalizedSystemRequestBase = String(HAXCMS.systemRequestBase || 'system/api/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  return String(apiBasePath || '/x/api').replace(
    /\/x\/api$/,
    `/${normalizedSystemRequestBase}`,
  )
}

function escapeHtmlValue(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeDownloadFileName(value = '', fallback = 'export') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  if (sanitized !== '') {
    return sanitized
  }
  return fallback
}

function getSiteExportFileBaseName(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.name
  ) {
    return sanitizeDownloadFileName(site.manifest.metadata.site.name, 'site')
  }
  if (site && site.manifest && site.manifest.title) {
    return sanitizeDownloadFileName(site.manifest.title, 'site')
  }
  if (site && site.name) {
    return sanitizeDownloadFileName(site.name, 'site')
  }
  return 'site'
}

function getItemExportFileBaseName(item) {
  if (item && item.slug) {
    return sanitizeDownloadFileName(item.slug, 'item')
  }
  if (item && item.title) {
    return sanitizeDownloadFileName(item.title, 'item')
  }
  if (item && item.id) {
    return sanitizeDownloadFileName(item.id, 'item')
  }
  return 'item'
}

function buildSiteExportDocumentTitle(site) {
  if (site && site.manifest && site.manifest.title) {
    return String(site.manifest.title)
  }
  if (site && site.name) {
    return String(site.name)
  }
  return 'Site export'
}

function buildItemExportDocumentTitle(item) {
  if (item && item.title) {
    return String(item.title)
  }
  if (item && item.slug) {
    return String(item.slug)
  }
  if (item && item.id) {
    return String(item.id)
  }
  return 'Item export'
}

function getExportMediaType(format = 'pdf') {
  if (Object.prototype.hasOwnProperty.call(EXPORT_MEDIA_TYPES, format)) {
    return EXPORT_MEDIA_TYPES[format]
  }
  return 'application/octet-stream'
}

function extractBase64Payload(value = '') {
  let payload = String(value || '').trim()
  const dataPrefixIndex = payload.indexOf('base64,')
  if (dataPrefixIndex !== -1) {
    payload = payload.substring(dataPrefixIndex + 'base64,'.length)
  }
  return payload.replace(/\s+/g, '')
}

function decodeBase64Payload(value = '') {
  const payload = extractBase64Payload(value)
  if (payload === '') {
    return Buffer.from([])
  }
  return Buffer.from(payload, 'base64')
}

function getConversionErrorMessage(json = null, fallback = '') {
  if (
    json &&
    typeof json === 'object' &&
    typeof json.message === 'string' &&
    json.message.trim() !== ''
  ) {
    return json.message.trim()
  }
  if (
    json &&
    typeof json === 'object' &&
    typeof json.error === 'string' &&
    json.error.trim() !== ''
  ) {
    return json.error.trim()
  }
  return fallback
}

function extractBase64DataFromResponse(json = null) {
  if (!json) {
    return ''
  }
  if (typeof json === 'string') {
    return json
  }
  if (typeof json !== 'object') {
    return ''
  }
  if (typeof json.data === 'string') {
    return json.data
  }
  if (json.data && typeof json.data === 'object' && typeof json.data.contents === 'string') {
    return json.data.contents
  }
  if (typeof json.contents === 'string') {
    return json.contents
  }
  return ''
}

async function convertHtmlToDownloadBuffer(format = 'pdf', html = '', base = '/') {
  const normalizedFormat = normalizeFormatValue(format)
  if (!Object.prototype.hasOwnProperty.call(EXPORT_SERVICE_PATHS, normalizedFormat)) {
    throw new Error(`Unsupported conversion format "${normalizedFormat}"`)
  }
  const endpoint = `${OPEN_APIS_BASE}${EXPORT_SERVICE_PATHS[normalizedFormat]}`
  const payload =
    normalizedFormat === 'pdf' ? { base: String(base || '/'), html } : { html }
  let upstreamResponse = null
  try {
    upstreamResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  }
  catch (e) {
    const connectionError = new Error('Unable to reach export conversion service')
    connectionError.status = 502
    throw connectionError
  }
  const responseType = String(
    (upstreamResponse.headers && upstreamResponse.headers.get
      ? upstreamResponse.headers.get('content-type')
      : '') || '',
  ).toLowerCase()
  if (
    responseType.indexOf(getExportMediaType(normalizedFormat)) !== -1 ||
    responseType.indexOf('application/octet-stream') !== -1
  ) {
    const binaryBuffer = Buffer.from(await upstreamResponse.arrayBuffer())
    if (!upstreamResponse.ok || binaryBuffer.length < 1) {
      const binaryError = new Error('Export conversion service returned empty output')
      binaryError.status = upstreamResponse.status || 502
      throw binaryError
    }
    return binaryBuffer
  }
  let responseText = ''
  try {
    responseText = await upstreamResponse.text()
  }
  catch (e) {
    responseText = ''
  }
  let responseJson = null
  if (responseText.trim() !== '') {
    try {
      responseJson = JSON.parse(responseText)
    }
    catch (e) {
      responseJson = null
    }
  }
  if (!upstreamResponse.ok) {
    const errorMessage = getConversionErrorMessage(
      responseJson,
      `Export conversion failed (${upstreamResponse.status})`,
    )
    const upstreamError = new Error(errorMessage)
    upstreamError.status = upstreamResponse.status || 502
    throw upstreamError
  }
  if (!responseJson) {
    const jsonError = new Error('Export conversion returned an invalid response')
    jsonError.status = 502
    throw jsonError
  }
  if (responseJson.status && Number(responseJson.status) !== 200) {
    const statusError = new Error(
      getConversionErrorMessage(responseJson, 'Export conversion failed'),
    )
    statusError.status = Number(responseJson.status) || 502
    throw statusError
  }
  const binaryBuffer = decodeBase64Payload(extractBase64DataFromResponse(responseJson))
  if (binaryBuffer.length < 1) {
    const emptyError = new Error('Export conversion returned empty output')
    emptyError.status = 502
    throw emptyError
  }
  return binaryBuffer
}

function sendDownloadResponse(res, buffer, mediaType, filename) {
  const safeMediaType = String(mediaType || 'application/octet-stream')
  const safeFilename = String(filename || 'export.bin').replace(/"/g, '')
  res.status(200)
  res.setHeader('Content-Type', safeMediaType)
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
  res.setHeader('Content-Length', buffer.length)
  return res.send(buffer)
}

async function buildSiteExportHtml(site) {
  const orderedItems = getOrderedItems(site)
  const sections = []
  const siteTitle = buildSiteExportDocumentTitle(site)
  sections.push('<!doctype html>')
  sections.push('<html>')
  sections.push('<head>')
  sections.push('<meta charset="utf-8" />')
  sections.push(`<title>${escapeHtmlValue(siteTitle)}</title>`)
  sections.push('</head>')
  sections.push('<body>')
  sections.push(`<main data-haxcms-export="site" data-title="${escapeHtmlValue(siteTitle)}">`)
  sections.push(`<h1>${escapeHtmlValue(siteTitle)}</h1>`)
  for (let i = 0; i < orderedItems.length; i++) {
    const item = orderedItems[i]
    if (!item) {
      continue
    }
    const itemTitle = buildItemExportDocumentTitle(item)
    const itemContent = await getItemContent(site, item)
    sections.push(
      `<article data-item-id="${escapeHtmlValue(item.id || '')}" data-item-slug="${escapeHtmlValue(item.slug || '')}">`,
    )
    sections.push(`<h2>${escapeHtmlValue(itemTitle)}</h2>`)
    sections.push(String(itemContent || ''))
    sections.push('</article>')
  }
  sections.push('</main>')
  sections.push('</body>')
  sections.push('</html>')
  return sections.join('\n')
}

async function buildItemExportHtml(site, item) {
  const itemTitle = buildItemExportDocumentTitle(item)
  const itemContent = await getItemContent(site, item)
  const sections = []
  sections.push('<!doctype html>')
  sections.push('<html>')
  sections.push('<head>')
  sections.push('<meta charset="utf-8" />')
  sections.push(`<title>${escapeHtmlValue(itemTitle)}</title>`)
  sections.push('</head>')
  sections.push('<body>')
  sections.push(
    `<article data-haxcms-export="item" data-item-id="${escapeHtmlValue(item && item.id ? item.id : '')}" data-item-slug="${escapeHtmlValue(item && item.slug ? item.slug : '')}">`,
  )
  sections.push(`<h1>${escapeHtmlValue(itemTitle)}</h1>`)
  sections.push(String(itemContent || ''))
  sections.push('</article>')
  sections.push('</body>')
  sections.push('</html>')
  return sections.join('\n')
}

function buildSiteExportDetails(site, apiBasePath = '/x/api', format = '') {
  const siteBasePath = getSiteBasePath(site)
  const systemApiBasePath = getSystemApiBasePath(apiBasePath)
  const normalizedFormat = normalizeFormatValue(format)
  const exportDescriptors = {
    markdown: {
      rel: 'download',
      mediaType: 'text/markdown',
      href: `${apiBasePath}/v1/content?mode=concat&format=md`,
    },
    zip: {
      rel: 'download',
      mediaType: 'application/zip',
      href: `${siteBasePath}?download-site=true`,
      authenticatedEndpoint: `${systemApiBasePath}/downloadSite`,
    },
    pdf: {
      rel: 'download',
      mediaType: 'application/pdf',
      href: `${apiBasePath}/v1/site/export/pdf`,
    },
    docx: {
      rel: 'download',
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      href: `${apiBasePath}/v1/site/export/docx`,
    },
    epub: {
      rel: 'service',
      mediaType: 'application/epub+zip',
      href: '/api/apps/haxcms/siteToEpub',
      source: `${siteBasePath}site.json`,
      method: 'POST',
    },
    skeleton: {
      rel: 'download',
      mediaType: 'application/json',
      href: `${systemApiBasePath}/downloadSiteSkeleton`,
      authenticatedEndpoint: `${systemApiBasePath}/downloadSiteSkeleton`,
      method: 'POST',
    },
  }
  if (Object.prototype.hasOwnProperty.call(exportDescriptors, normalizedFormat)) {
    return exportDescriptors[normalizedFormat]
  }
  return null
}

async function siteExport(req, res) {
  const site = await resolveSiteForRequest(req)
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/site/export/:format',
    })
  }
  const apiBasePath = getApiBasePath(req)
  const format = normalizeFormatValue(
    req && req.params && req.params.format ? req.params.format : '',
  )
  if (SITE_EXPORT_FORMATS.indexOf(format) === -1) {
    return res.status(400).json({
      status: 400,
      message: `Unsupported site export format "${format}"`,
      supportedFormats: SITE_EXPORT_FORMATS,
    })
  }
  if (format === 'pdf' || format === 'docx') {
    let html = ''
    try {
      html = await buildSiteExportHtml(site)
    }
    catch (e) {
      return res.status(500).json({
        status: 500,
        message: `Unable to build site export HTML: ${e.message}`,
      })
    }
    let outputBuffer = null
    try {
      outputBuffer = await convertHtmlToDownloadBuffer(format, html, getSiteBasePath(site))
    }
    catch (e) {
      return res.status(e && e.status ? e.status : 502).json({
        status: e && e.status ? e.status : 502,
        message: e && e.message ? e.message : 'Unable to complete export conversion',
      })
    }
    return sendDownloadResponse(
      res,
      outputBuffer,
      getExportMediaType(format),
      `${getSiteExportFileBaseName(site)}.${format}`,
    )
  }
  const exportDetails = buildSiteExportDetails(site, apiBasePath, format)
  return sendFormattedResponse(
    req,
    res,
    {
      format,
      supportedFormats: SITE_EXPORT_FORMATS,
      export: exportDetails,
      links: {
        self: `${apiBasePath}/v1/site/export/${format}`,
        site: `${apiBasePath}/v1/site`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  )
}

async function itemExport(req, res) {
  const site = await resolveSiteForRequest(req)
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message:
        'Unable to resolve site context for /x/api/v1/items/:idOrSlug/export/:format',
    })
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? req.params.idOrSlug : ''
  const item = findItemByIdOrSlug(site, idOrSlug)
  if (!item) {
    return res.status(404).json({
      status: 404,
      message: `Item not found for idOrSlug "${idOrSlug}"`,
    })
  }
  const format = normalizeFormatValue(
    req && req.params && req.params.format ? req.params.format : '',
  )
  if (ITEM_EXPORT_FORMATS.indexOf(format) === -1) {
    return res.status(400).json({
      status: 400,
      message: `Unsupported item export format "${format}"`,
      supportedFormats: ITEM_EXPORT_FORMATS,
    })
  }
  let html = ''
  try {
    html = await buildItemExportHtml(site, item)
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      message: `Unable to build item export HTML: ${e.message}`,
    })
  }
  let outputBuffer = null
  try {
    outputBuffer = await convertHtmlToDownloadBuffer(format, html, getSiteBasePath(site))
  }
  catch (e) {
    return res.status(e && e.status ? e.status : 502).json({
      status: e && e.status ? e.status : 502,
      message: e && e.message ? e.message : 'Unable to complete export conversion',
    })
  }
  return sendDownloadResponse(
    res,
    outputBuffer,
    getExportMediaType(format),
    `${getItemExportFileBaseName(item)}.${format}`,
  )
}

module.exports = {
  siteExport,
  itemExport,
}