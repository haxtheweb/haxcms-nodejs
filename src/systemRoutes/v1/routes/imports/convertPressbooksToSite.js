const { parse } = require('node-html-parser')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { HAXCMS } = require('../../../../lib/HAXCMS.js')
const { importHtmlToItems } = require('../../../../siteRoutes/v1/importUtils.js')

const SUPPORTED_SITE_LICENSES = [
  'by-nc-nd',
  'by-nc-sa',
  'by-nc',
  'by-nd',
  'by-sa',
  'by',
]

/**
 * Fetch JSON from a URL.
 */
async function fetchJSON(url) {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }
    return await response.json()
  } catch (e) {
    return null
  }
}

/**
 * Build candidate base URLs from an input URL, stopping at known segments.
 */
function buildWordPressBaseCandidates(inputUrl, stopSegments) {
  const candidates = []
  try {
    const parsed = new URL(inputUrl)
    const origin = `${parsed.protocol}//${parsed.host}`
    let pathParts = parsed.pathname.split('/').filter(Boolean)
    for (let i = 0; i < pathParts.length; i += 1) {
      if (stopSegments.includes(pathParts[i])) {
        pathParts = pathParts.slice(0, i)
        break
      }
    }
    for (let i = pathParts.length; i >= 0; i -= 1) {
      const candidate = i > 0 ? `${origin}/${pathParts.slice(0, i).join('/')}` : origin
      if (!candidates.includes(candidate)) {
        candidates.push(candidate)
      }
    }
  } catch (e) {
    return []
  }
  return candidates
}

/**
 * Discover the Pressbooks API base URL from an input URL.
 */
async function discoverPressbooksBase(inputUrl) {
  const candidates = buildWordPressBaseCandidates(inputUrl, [
    'wp-json',
    'front-matter',
    'chapter',
    'back-matter',
    'part',
    'toc',
  ])
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const payload = await fetchJSON(`${candidate}/wp-json/`)
    if (payload && Array.isArray(payload.namespaces) && payload.namespaces.includes('pressbooks/v2')) {
      return candidate
    }
  }
  return null
}

/**
 * Convert root-relative URLs in content to absolute URLs using a base.
 */
function absolutizeRootUrls(content, base) {
  let origin = ''
  try {
    const parsed = new URL(base)
    origin = `${parsed.protocol}//${parsed.host}`
  } catch (e) {
    origin = ''
  }
  if (origin === '') {
    return content
  }
  return content
    .replace(/href="\//g, `href="${origin}/`)
    .replace(/src="\//g, `src="${origin}/`)
    .replace(/poster="\//g, `poster="${origin}/`)
    .replace(/srcset="\//g, `srcset="${origin}/`)
}

/**
 * POST /system/api/v1/site/import/:platform
 * Convert a Pressbooks site into a JSON Outline Schema items array.
 *
 * Accepts multipart/form-data with an .html file, or JSON with { repoUrl: string }.
 * Returns { status: 200, data: { items: [...], filename: string, files: {}, site?: {} } }.
 */
async function convertPressbooksToSite(req, res) {
  const contentType =
    req && req.headers && req.headers['content-type']
      ? req.headers['content-type']
      : ''

  if (contentType.indexOf('multipart/form-data') !== -1) {
    return handleHtmlFileImport(req, res)
  }

  let body = {}
  if (req && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    body = req.body
  }

  if (!body || !body.repoUrl) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing `repoUrl` param',
        items: [],
        filename: null,
      },
    })
  }

  let parentId = null
  if (body.parentId && body.parentId !== 'null') {
    parentId = body.parentId
  }

  const discoveredBase = await discoverPressbooksBase(body.repoUrl)
  if (!discoveredBase) {
    return res.status(422).json({
      status: 422,
      data: {
        error: 'Unable to discover Pressbooks API from `repoUrl`; expected `/wp-json/pressbooks/v2/*`',
        items: [],
        filename: null,
      },
    })
  }

  const importedData = await importPressbooksSite(discoveredBase, parentId)
  if (!importedData) {
    return res.status(422).json({
      status: 422,
      data: {
        error: 'Pressbooks API discovered but import failed to produce content',
        items: [],
        filename: null,
      },
    })
  }

  const responseData = {
    items: importedData.items,
    filename: importedData.filename,
    files: importedData.files,
  }
  if (importedData.site && typeof importedData.site === 'object') {
    responseData.site = importedData.site
  }

  return res.json({
    status: 200,
    data: responseData,
  })
}

async function handleHtmlFileImport(req, res) {
  let html = ''
  let filename = null
  let method = 'site'
  let type = ''
  let parentId = null

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'No file uploaded',
        items: [],
        filename: null,
      },
    })
  }

  const file = req.files[0]
  filename = file.originalname
  if (!/\.(html|htm)$/i.test(filename)) {
    return res.status(400).json({
      status: 400,
      data: {
        error: `Invalid file type. Expected .html or .htm, got: ${filename}`,
        items: [],
        filename: filename,
      },
    })
  }

  const fs = require('fs-extra')
  try {
    html = fs.readFileSync(file.path, 'utf8')
  } catch (e) {
    return res.status(400).json({
      status: 400,
      data: {
        error: `Unable to read uploaded file: ${e.message}`,
        items: [],
        filename: filename,
      },
    })
  }

  if (req.body && req.body.method) {
    method = req.body.method
  }
  if (req.body && req.body.type) {
    type = req.body.type
  }
  if (req.body && req.body.parentId && req.body.parentId !== 'null') {
    parentId = req.body.parentId
  }

  html = html || ''
  const items = await importHtmlToItems(html, {
    titleValue: filename ? filename.replace(/\.(html|htm)$/i, '') : 'import',
    method: method,
    type: type,
    parentId: parentId,
  })

  return res.json({
    status: 200,
    data: {
      items: items,
      filename: filename,
    },
  })
}

async function importPressbooksSite(base, parentId = null) {
  const toc = await fetchJSON(`${base}/wp-json/pressbooks/v2/toc`)
  if (
    !toc ||
    !Array.isArray(toc['front-matter']) ||
    !Array.isArray(toc.parts) ||
    !Array.isArray(toc['back-matter'])
  ) {
    return null
  }
  const siteMetadata = await fetchJSON(`${base}/wp-json/pressbooks/v2/metadata`)
  const normalizedSiteMetadata = getPressbooksSiteMetadata(siteMetadata)
  const topLevelOrder = {
    value: 0,
  }
  const items = []

  const frontMatterItems = await buildTopLevelSectionItems(
    base,
    toc['front-matter'],
    'front-matter',
    parentId,
    topLevelOrder,
  )
  for (let i = 0; i < frontMatterItems.length; i++) {
    items.push(frontMatterItems[i])
  }

  const partItems = await buildPartAndChapterItems(
    base,
    toc.parts,
    parentId,
    topLevelOrder,
  )
  for (let i = 0; i < partItems.length; i++) {
    items.push(partItems[i])
  }

  const backMatterItems = await buildTopLevelSectionItems(
    base,
    toc['back-matter'],
    'back-matter',
    parentId,
    topLevelOrder,
  )
  for (let i = 0; i < backMatterItems.length; i++) {
    items.push(backMatterItems[i])
  }

  const importedSite = {
    items: items,
    files: {},
    filename: getSiteFilename(siteMetadata, base),
  }
  if (Object.keys(normalizedSiteMetadata).length > 0) {
    importedSite.site = normalizedSiteMetadata
  }
  return importedSite
}

async function buildTopLevelSectionItems(base, sectionItems, endpointType, parentId, orderRef) {
  const items = []
  const sorted = sortPressbooksItems(sectionItems)
  for (let i = 0; i < sorted.length; i++) {
    const section = sorted[i]
    if (section && section.export === false) {
      continue
    }
    const fullData = await fetchPressbooksEntity(base, endpointType, section.id)
    const item = new JSONOutlineSchemaItem()
    item.title = getPressbooksItemTitle(section, fullData)
    item.slug = HAXCMS.cleanTitle(item.title)
    item.order = orderRef.value
    orderRef.value += 1
    item.parent = parentId
    item.contents = getPressbooksItemContent(fullData, section, base)
    item.metadata = getPressbooksMetadata(section, fullData, endpointType)
    items.push(item)
  }
  return items
}

async function buildPartAndChapterItems(base, parts, parentId, orderRef) {
  const items = []
  const sortedParts = sortPressbooksItems(parts)
  for (let i = 0; i < sortedParts.length; i++) {
    const part = sortedParts[i]
    if (part && part.export === false) {
      continue
    }
    const partData = await fetchPressbooksEntity(base, 'parts', part.id)
    const partItem = new JSONOutlineSchemaItem()
    partItem.title = getPressbooksItemTitle(part, partData)
    partItem.slug = HAXCMS.cleanTitle(partItem.title)
    partItem.order = orderRef.value
    orderRef.value += 1
    partItem.parent = parentId
    partItem.contents = getPressbooksItemContent(partData, part, base)
    partItem.metadata = getPressbooksMetadata(part, partData, 'part')
    items.push(partItem)

    if (part && Array.isArray(part.chapters)) {
      let chapterOrder = 0
      const sortedChapters = sortPressbooksItems(part.chapters)
      for (let j = 0; j < sortedChapters.length; j++) {
        const chapter = sortedChapters[j]
        if (chapter && chapter.export === false) {
          continue
        }
        const chapterData = await fetchPressbooksEntity(base, 'chapters', chapter.id)
        const chapterItem = new JSONOutlineSchemaItem()
        chapterItem.title = getPressbooksItemTitle(chapter, chapterData)
        chapterItem.slug = `${partItem.slug}/${HAXCMS.cleanTitle(chapterItem.title)}`
        chapterItem.order = chapterOrder
        chapterOrder += 1
        chapterItem.indent = 1
        chapterItem.parent = partItem.id
        chapterItem.contents = getPressbooksItemContent(chapterData, chapter, base)
        chapterItem.metadata = getPressbooksMetadata(chapter, chapterData, 'chapter')
        items.push(chapterItem)
      }
    }
  }
  return items
}

async function fetchPressbooksEntity(base, endpointType, id) {
  if (!id) {
    return null
  }
  return fetchJSON(`${base}/wp-json/pressbooks/v2/${endpointType}/${id}`)
}

function sortPressbooksItems(items) {
  const sorted = Array.isArray(items) ? [...items] : []
  sorted.sort((a, b) => {
    const aOrder = a && a.menu_order !== undefined ? parseInt(a.menu_order) : 0
    const bOrder = b && b.menu_order !== undefined ? parseInt(b.menu_order) : 0
    return aOrder - bOrder
  })
  return sorted
}

function getPressbooksItemTitle(item, fullData) {
  let title = ''
  if (fullData && fullData.title) {
    if (typeof fullData.title === 'string') {
      title = fullData.title
    } else if (fullData.title.rendered) {
      title = fullData.title.rendered
    } else if (fullData.title.raw) {
      title = fullData.title.raw
    }
  }
  if (title === '' && item && item.title) {
    if (typeof item.title === 'string') {
      title = item.title
    } else if (item.title.rendered) {
      title = item.title.rendered
    } else if (item.title.raw) {
      title = item.title.raw
    }
  }
  if (title === '' && item && item.slug) {
    title = item.slug
  }
  return parse(`<div>${title}</div>`).innerText.trim()
}

function getPressbooksItemContent(fullData, fallbackItem, base) {
  let content = ''
  if (fullData && fullData.content) {
    if (typeof fullData.content === 'string') {
      content = fullData.content
    } else if (fullData.content.rendered) {
      content = fullData.content.rendered
    } else if (fullData.content.raw) {
      content = fullData.content.raw
    }
  }
  if (content === '') {
    if (fallbackItem && fallbackItem.has_post_content) {
      return '<p></p>'
    }
    return '<p></p>'
  }
  return absolutizeRootUrls(content, base)
}

function getPressbooksMetadata(item, fullData, sourceType) {
  const metadata = {
    sourceType: sourceType,
    pressbooks: {},
  }
  const source = fullData && fullData.link ? fullData.link : item && item.link ? item.link : null
  if (source) {
    metadata.source = source
  }
  const id = fullData && fullData.id ? fullData.id : item && item.id ? item.id : null
  if (id) {
    metadata.pressbooks.id = id
  }
  if (item && item.slug) {
    metadata.pressbooks.slug = item.slug
  }
  if (item && item.menu_order !== undefined) {
    metadata.pressbooks.menuOrder = item.menu_order
  }
  if (item && item.status) {
    metadata.pressbooks.status = item.status
  }
  return metadata
}

function getSiteFilename(siteMetadata, base) {
  if (siteMetadata && siteMetadata.name) {
    return HAXCMS.cleanTitle(siteMetadata.name)
  }
  let pathname = ''
  try {
    pathname = new URL(base).pathname
  } catch (e) {
    pathname = ''
  }
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length > 0) {
    return HAXCMS.cleanTitle(parts[parts.length - 1])
  }
  return 'pressbooks-import'
}

function normalizeSiteLicenseValue(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return null
  }
  const value = rawValue
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (value === '') {
    return null
  }
  if (SUPPORTED_SITE_LICENSES.includes(value)) {
    return value
  }
  for (let i = 0; i < SUPPORTED_SITE_LICENSES.length; i++) {
    const code = SUPPORTED_SITE_LICENSES[i]
    if (
      value.indexOf(`/licenses/${code}`) !== -1 ||
      value.indexOf(`cc ${code}`) !== -1 ||
      value.indexOf(`cc-${code}`) !== -1 ||
      value.indexOf(`cc:${code}`) !== -1
    ) {
      return code
    }
  }
  const compactValue = value.replace(/[^a-z]/g, '')
  const hasNonCommercial = compactValue.indexOf('noncommercial') !== -1
  const hasNoDerivatives = compactValue.indexOf('noderivatives') !== -1
  const hasShareAlike = compactValue.indexOf('sharealike') !== -1
  const hasAttribution =
    compactValue.indexOf('attribution') !== -1 ||
    value.indexOf('/licenses/by/') !== -1 ||
    value.indexOf('cc by') !== -1
  if (hasNonCommercial && hasNoDerivatives) {
    return 'by-nc-nd'
  }
  if (hasNonCommercial && hasShareAlike) {
    return 'by-nc-sa'
  }
  if (hasNonCommercial) {
    return 'by-nc'
  }
  if (hasNoDerivatives) {
    return 'by-nd'
  }
  if (hasShareAlike) {
    return 'by-sa'
  }
  if (hasAttribution) {
    return 'by'
  }
  return null
}

function collectLicenseCandidatesFromMetadata(metadata, candidates) {
  if (!candidates) {
    candidates = []
  }
  if (!metadata || typeof metadata !== 'object') {
    return candidates
  }
  if (Array.isArray(metadata)) {
    for (let i = 0; i < metadata.length; i++) {
      collectLicenseCandidatesFromMetadata(metadata[i], candidates)
    }
    return candidates
  }
  const keys = Object.keys(metadata)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const value = metadata[key]
    const normalizedKey = key.toLowerCase()
    if (typeof value === 'string') {
      if (
        normalizedKey.indexOf('license') !== -1 ||
        normalizedKey.indexOf('rights') !== -1 ||
        normalizedKey.indexOf('copyright') !== -1
      ) {
        candidates.push(value)
      }
    } else if (value && typeof value === 'object') {
      collectLicenseCandidatesFromMetadata(value, candidates)
    }
  }
  return candidates
}

function getPressbooksSiteMetadata(siteMetadata) {
  const metadata = {}
  const licenseCandidates = collectLicenseCandidatesFromMetadata(siteMetadata)
  for (let i = 0; i < licenseCandidates.length; i++) {
    const candidate = licenseCandidates[i]
    const normalizedLicense = normalizeSiteLicenseValue(candidate)
    if (normalizedLicense) {
      metadata.license = normalizedLicense
      break
    }
  }
  return metadata
}

module.exports = { convertPressbooksToSite }
