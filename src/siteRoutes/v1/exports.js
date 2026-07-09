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
const { convertHtmlToDocxBuffer, htmlToPdfBuffer } = require('../../lib/convertUtils.js')
const EPUB = require('epub-gen-memory')

const SITE_EXPORT_FORMATS = ['zip', 'markdown', 'pdf', 'docx', 'epub', 'skeleton']
const ITEM_EXPORT_FORMATS = ['pdf', 'docx']
const EXPORT_MEDIA_TYPES = {
  pdf: 'application/pdf',
  docx:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
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

async function convertHtmlToDownloadBuffer(format = 'pdf', html = '', base = '/') {
  const normalizedFormat = normalizeFormatValue(format)
  if (normalizedFormat === 'docx') {
    try {
      const docxBuffer = await convertHtmlToDocxBuffer(html)
      if (!docxBuffer || docxBuffer.length < 1) {
        const emptyError = new Error('Export conversion returned empty output')
        emptyError.status = 502
        throw emptyError
      }
      return docxBuffer
    }
    catch (e) {
      const conversionError = new Error(
        e && e.message ? e.message : 'Unable to complete DOCX export conversion',
      )
      conversionError.status = e && e.status ? e.status : 502
      throw conversionError
    }
  }
  if (normalizedFormat === 'pdf') {
    try {
      const pdfBuffer = await htmlToPdfBuffer(html, base)
      if (!pdfBuffer || pdfBuffer.length < 1) {
        const emptyError = new Error('Export conversion returned empty output')
        emptyError.status = 502
        throw emptyError
      }
      return pdfBuffer
    }
    catch (e) {
      const conversionError = new Error(
        e && e.message ? e.message : 'Unable to complete PDF export conversion',
      )
      conversionError.status = e && e.status ? e.status : 502
      throw conversionError
    }
  }
  throw new Error(`Unsupported conversion format "${normalizedFormat}"`)
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

async function buildSiteExportEpubBuffer(site, basePath = '/') {
  const orderedItems = getOrderedItems(site)
  const siteTitle = buildSiteExportDocumentTitle(site)
  const author =
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.author &&
    site.manifest.metadata.author.name
      ? String(site.manifest.metadata.author.name)
      : 'HAX The Web'
  const description =
    site && site.manifest && site.manifest.description
      ? String(site.manifest.description)
      : ''
  const cover =
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.logo
      ? String(site.manifest.metadata.site.logo)
      : ''

  const content = []
  for (let i = 0; i < orderedItems.length; i++) {
    const item = orderedItems[i]
    if (!item) {
      continue
    }
    const itemTitle = buildItemExportDocumentTitle(item)
    const itemContent = await getItemContent(site, item)
    content.push({
      title: itemTitle,
      author: author,
      data: String(itemContent || ''),
    })
  }

  const options = {
    title: siteTitle,
    author: author,
    publisher: 'HAX The Web',
    description: description,
    cover: cover ? `${basePath}${cover}` : '',
    tocTitle: 'Table of Contents',
    css: `body { font-family: serif; line-height: 1.6; margin: 0; padding: 1em; }
h1, h2, h3, h4, h5, h6 { font-family: sans-serif; margin-top: 1.5em; margin-bottom: 0.5em; }
p { margin: 0.5em 0; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ccc; padding: 0.5em; }
blockquote { margin: 1em; padding: 0.5em 1em; border-left: 3px solid #ccc; }
pre { background: #f4f4f4; padding: 1em; overflow-x: auto; }`,
    content: content,
  }

  const epubGenerator = EPUB.default || EPUB.default.default || EPUB
  return await epubGenerator(options)
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
      rel: 'download',
      mediaType: 'application/epub+zip',
      href: `${apiBasePath}/v1/site/export/epub`,
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
  if (format === 'pdf' || format === 'docx' || format === 'epub') {
    let outputBuffer = null
    try {
      if (format === 'epub') {
        outputBuffer = await buildSiteExportEpubBuffer(site, getSiteBasePath(site))
      } else {
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
        outputBuffer = await convertHtmlToDownloadBuffer(format, html, getSiteBasePath(site))
      }
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