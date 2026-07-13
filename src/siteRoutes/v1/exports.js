const {
  getApiBasePath,
  resolveSiteForRequest,
  getSiteBasePath,
  sendFormattedResponse,
  findItemByIdOrSlug,
  getOrderedItems,
  getItemContent,
  getQueryValue,
} = require('./siteRouteUtils.js')
const { HAXCMS } = require('../../lib/HAXCMS.js')
const { convertHtmlToDocxBuffer, htmlToPdfBuffer } = require('../../lib/convertUtils.js')
const EPUB = require('epub-gen-memory')
const { parse } = require('node-html-parser')

const SITE_EXPORT_FORMATS = ['zip', 'markdown', 'pdf', 'docx', 'epub', 'html', 'skeleton']
const ITEM_EXPORT_FORMATS = ['pdf', 'docx']
const EXPORT_MEDIA_TYPES = {
  pdf: 'application/pdf',
  docx:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  html: 'text/html',
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
  const safeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  res.status(200)
  res.setHeader('Content-Type', safeMediaType)
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
  res.setHeader('Content-Length', safeBuffer.length)
  return res.send(safeBuffer)
}

async function buildSiteExportHtmlContent(site, ancestor) {
  const orderedItems = getOrderedItems(site)
  const sections = []
  const siteTitle = buildSiteExportDocumentTitle(site)
  sections.push(`<h1>${escapeHtmlValue(siteTitle)}</h1>`)

  let itemsToExport = orderedItems
  if (ancestor && site.manifest && typeof site.manifest.findBranch === 'function') {
    try {
      const branch = site.manifest.findBranch(ancestor)
      if (Array.isArray(branch)) {
        const branchIds = new Set()
        for (let i = 0; i < branch.length; i++) {
          if (branch[i] && branch[i].id) {
            branchIds.add(branch[i].id)
          }
        }
        itemsToExport = orderedItems.filter((item) => item && item.id && branchIds.has(item.id))
      }
    }
    catch (e) {}
  }

  for (let i = 0; i < itemsToExport.length; i++) {
    const item = itemsToExport[i]
    if (!item) {
      continue
    }
    const itemContent = await getItemContent(site, item)
    sections.push(`<div data-jos-item-id="${escapeHtmlValue(item.id || '')}">`)
    sections.push(String(itemContent || ''))
    sections.push('</div>')
  }
  return sections.join('\n')
}

async function buildSiteExportHtml(site, ancestor, magic) {
  const orderedItems = getOrderedItems(site)
  const siteTitle = buildSiteExportDocumentTitle(site)

  let itemsToExport = orderedItems
  if (ancestor && site.manifest && typeof site.manifest.findBranch === 'function') {
    try {
      const branch = site.manifest.findBranch(ancestor)
      if (Array.isArray(branch)) {
        const branchIds = new Set()
        for (let i = 0; i < branch.length; i++) {
          if (branch[i] && branch[i].id) {
            branchIds.add(branch[i].id)
          }
        }
        itemsToExport = orderedItems.filter((item) => item && item.id && branchIds.has(item.id))
      }
    }
    catch (e) {}
  }

  if (magic) {
    const content = await buildSiteExportHtmlContent(site, ancestor)
    const sections = []
    sections.push('<!DOCTYPE html>')
    sections.push('<html lang="en">')
    sections.push('<head>')
    sections.push('<meta charset="utf-8">')
    sections.push(`<link rel="preconnect" crossorigin href="${escapeHtmlValue(magic)}">`)
    sections.push(`<link rel="preconnect" crossorigin href="https://fonts.googleapis.com">`)
    sections.push(`<link rel="preload" href="${escapeHtmlValue(magic)}build.js" as="script" />`)
    sections.push(`<link rel="preload" href="${escapeHtmlValue(magic)}wc-registry.json" as="fetch" crossorigin="anonymous" />`)
    sections.push(`<link rel="preload" href="${escapeHtmlValue(magic)}build/es6/node_modules/@haxtheweb/dynamic-import-registry/dynamic-import-registry.js" as="script" crossorigin="anonymous" />`)
    sections.push(`<link rel="modulepreload" href="${escapeHtmlValue(magic)}build/es6/node_modules/@haxtheweb/dynamic-import-registry/dynamic-import-registry.js" />`)
    sections.push(`<link rel="preload" href="${escapeHtmlValue(magic)}build/es6/node_modules/@haxtheweb/wc-autoload/wc-autoload.js" as="script" crossorigin="anonymous" />`)
    sections.push(`<link rel="modulepreload" href="${escapeHtmlValue(magic)}build/es6/node_modules/@haxtheweb/wc-autoload/wc-autoload.js" />`)
    sections.push(`<link rel="stylesheet" href="${escapeHtmlValue(magic)}build/es6/node_modules/@haxtheweb/haxcms-elements/lib/base.css" />`)
    sections.push('<meta name="viewport" content="width=device-width, minimum-scale=1, initial-scale=1, user-scalable=yes">')
    sections.push('</head>')
    sections.push('<body>')
    sections.push('<haxcms-print-theme>')
    sections.push(content)
    sections.push('</haxcms-print-theme>')
    sections.push('</body>')
    sections.push(`<script>window.__appCDN="${escapeHtmlValue(magic)}";</script>`)
    sections.push(`<script src="${escapeHtmlValue(magic)}build.js"></script>`)
    sections.push('</html>')
    return sections.join('\n')
  }

  const sections = []
  sections.push('<!doctype html>')
  sections.push('<html>')
  sections.push('<head>')
  sections.push('<meta charset="utf-8" />')
  sections.push(`<title>${escapeHtmlValue(siteTitle)}</title>`)
  sections.push('</head>')
  sections.push('<body>')
  sections.push(`<main data-haxcms-export="site" data-title="${escapeHtmlValue(siteTitle)}">`)
  sections.push(`<h1>${escapeHtmlValue(siteTitle)}</h1>`)
  for (let i = 0; i < itemsToExport.length; i++) {
    const item = itemsToExport[i]
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

function resolveUrlForEpub(attributeValue, basePath) {
  const value = String(attributeValue || '').trim()
  if (value === '') {
    return ''
  }
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value
  }
  if (value.startsWith('/')) {
    return value
  }
  return basePath + value
}

function processHtmlForEpub(html, basePath, items) {
  if (!html) {
    return ''
  }
  const doc = parse(`<div id="wrapper">${html}</div>`)

  // Process videos
  const videos = doc.querySelectorAll('video-player,iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"],iframe[src*="vimeo.com"],video[src],video source[src],a11y-media-player')
  for (let i = 0; i < videos.length; i++) {
    const el = videos[i]
    let videoUrl = ''
    const source = el.getAttribute('source')
    const src = el.getAttribute('src')

    if (source) {
      videoUrl = resolveUrlForEpub(source, basePath)
    } else if (src) {
      videoUrl = resolveUrlForEpub(src, basePath)
    }

    if (videoUrl) {
      let videoId = ''
      try {
        const urlData = new URL(videoUrl)
        if (urlData.hostname === 'www.youtube.com' || urlData.hostname === 'youtube.com' || urlData.hostname === 'www.youtube-nocookie.com') {
          if (urlData.searchParams.get('v')) {
            videoId = urlData.searchParams.get('v')
          } else if (urlData.pathname.startsWith('/embed/')) {
            videoId = urlData.pathname.replace('/embed/', '')
          }
          if (videoId) {
            videoId = `https://www.youtube-nocookie.com/embed/${videoId}`
          }
        } else if (urlData.hostname === 'youtu.be') {
          videoId = `https://www.youtube-nocookie.com/embed/${urlData.pathname.replace('/', '')}`
        } else {
          videoId = videoUrl
        }
      } catch (e) {
        videoId = videoUrl
      }

      if (videoId) {
        const embed = `<div class="responsive-iframe-container"><iframe class="responsive-iframe" width="100%" height="100%" frameborder="0" src="${escapeHtmlValue(videoId)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`
        el.replaceWith(embed)
      } else {
        el.remove()
      }
    } else {
      el.remove()
    }
  }

  // Process images
  const images = doc.querySelectorAll('media-image,img,simple-img')
  for (let i = 0; i < images.length; i++) {
    const el = images[i]
    let imageUrl = ''
    const source = el.getAttribute('source')
    const src = el.getAttribute('src')

    if (source) {
      imageUrl = resolveUrlForEpub(source, basePath)
    } else if (src) {
      imageUrl = resolveUrlForEpub(src, basePath)
    }

    if (imageUrl) {
      const alt = escapeHtmlValue(el.getAttribute('alt') || '')
      const img = `<img src="${escapeHtmlValue(imageUrl)}" alt="${alt}" />`
      el.replaceWith(img)
    } else {
      el.remove()
    }
  }

  // Process tables - strip inline styles
  const tables = doc.querySelectorAll('table,tr,td,th')
  for (let i = 0; i < tables.length; i++) {
    tables[i].removeAttribute('style')
  }

  // Process links
  const slugSet = new Set()
  for (let i = 0; i < items.length; i++) {
    if (items[i] && items[i].slug) {
      slugSet.add(items[i].slug)
    }
  }

  const links = doc.querySelectorAll('a')
  for (let i = 0; i < links.length; i++) {
    const el = links[i]
    let href = el.getAttribute('href') || ''
    if (!href) {
      el.remove()
      continue
    }

    try {
      let urlData
      try {
        urlData = new URL(href, basePath)
      } catch (e) {
        el.remove()
        continue
      }

      if (href.startsWith('/')) {
        const pathname = urlData.pathname.replace(/^\/+/, '')
        if (slugSet.has(pathname)) {
          href = pathname.replace(/\//g, '-') + '.xhtml'
        } else if (urlData.searchParams && urlData.searchParams.has('q')) {
          href = urlData.searchParams.get('q').replace(/\//g, '-') + '.xhtml'
        }
      } else {
        const pathname = urlData.pathname.replace(/^\/+/, '')
        if (slugSet.has(pathname)) {
          href = pathname.replace(/\//g, '-') + '.xhtml'
        }
      }

      if (href) {
        el.setAttribute('href', href)
      } else {
        el.remove()
      }
    } catch (e) {
      el.remove()
    }
  }

  const wrapper = doc.querySelector('#wrapper')
  return wrapper ? wrapper.innerHTML : html
}

async function buildSiteExportEpubBuffer(site, basePath = '/', ancestor) {
  const orderedItems = getOrderedItems(site)
  let itemsToExport = orderedItems

  // Apply ancestor filtering with unpublished parent/child checks
  if (ancestor && site.manifest && typeof site.manifest.findBranch === 'function') {
    try {
      const branch = site.manifest.findBranch(ancestor)
      if (Array.isArray(branch)) {
        const branchIds = new Set()
        for (let i = 0; i < branch.length; i++) {
          if (branch[i] && branch[i].id) {
            branchIds.add(branch[i].id)
          }
        }
        itemsToExport = orderedItems.filter((item) => {
          if (!item || !item.id || !branchIds.has(item.id)) {
            return false
          }
          // Skip unpublished items
          if (item.metadata && item.metadata.published === false) {
            return false
          }
          // Walk up tree to ensure no parent is unpublished
          if (item.parent) {
            let tmpEl = { ...item }
            while (tmpEl.parent) {
              tmpEl = findItemByIdOrSlug(site, tmpEl.parent)
              if (tmpEl && tmpEl.metadata && tmpEl.metadata.published === false) {
                return false
              }
            }
            if (tmpEl && tmpEl.metadata && tmpEl.metadata.published === false) {
              return false
            }
          }
          return true
        })
      }
    }
    catch (e) {}
  }

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
  for (let i = 0; i < itemsToExport.length; i++) {
    const item = itemsToExport[i]
    if (!item) {
      continue
    }
    const itemTitle = buildItemExportDocumentTitle(item)
    let itemContent = await getItemContent(site, item)
    if (itemContent) {
      itemContent = processHtmlForEpub(itemContent, basePath, itemsToExport)
    }
    content.push({
      title: itemTitle,
      content: String(itemContent || ''),
      filename: (item.slug ? item.slug.replace(/\//g, '-') : item.id) + '.xhtml',
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
pre { background: #f4f4f4; padding: 1em; overflow-x: auto; }
.responsive-iframe-container { position: relative; overflow: hidden; width: 100%; padding-top: 56.25%; }
.responsive-iframe { position: absolute; top: 0; left: 0; bottom: 0; right: 0; width: 100%; height: 100%; }`,
    date: site && site.manifest && site.manifest.metadata && site.manifest.metadata.site && site.manifest.metadata.site.updated ? new Date(site.manifest.metadata.site.updated * 1000).toISOString() : new Date().toISOString(),
    lang: site && site.manifest && site.manifest.metadata && site.manifest.metadata.site && site.manifest.metadata.site.lang ? String(site.manifest.metadata.site.lang) : 'en',
    fetchTimeout: 3000,
    ignoreFailedDownloads: true,
  }

  const epubGenerator = EPUB.default && EPUB.default.default ? EPUB.default.default : (EPUB.default || EPUB)
  return await epubGenerator(options, content)
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
    html: {
      rel: 'download',
      mediaType: 'text/html',
      href: `${apiBasePath}/v1/site/export/html`,
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
  const ancestor = getQueryValue(req, 'filter.ancestor', '')
  const magic = getQueryValue(req, 'magic', '')
  if (format === 'pdf' || format === 'docx' || format === 'epub') {
    let outputBuffer = null
    try {
      if (format === 'epub') {
        outputBuffer = await buildSiteExportEpubBuffer(site, getSiteBasePath(site), ancestor)
      } else {
        let html = ''
        try {
          html = await buildSiteExportHtml(site, ancestor, '')
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
  if (format === 'html') {
    try {
      const html = await buildSiteExportHtml(site, ancestor, magic)
      res.status(200)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.send(html)
    }
    catch (e) {
      return res.status(500).json({
        status: 500,
        message: `Unable to build site export HTML: ${e.message}`,
      })
    }
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