const { HAXCMS } = require('../../../../lib/HAXCMS.js')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')

const DEFAULT_PAGE_TYPES = [
  'Document',
  'News Item',
  'Event',
  'Folder',
  'Collection',
  'Link',
  'Topic',
  'Listing'
]
const BINARY_TYPES = ['Image', 'File']

async function convertPloneToSite(req, res) {
  let body = {}
  if (req && req.query && req.query.repoUrl) {
    body = req.query
  } else if (req && req.body && typeof req.body === 'object') {
    body = req.body
  }

  if (!body || !body.repoUrl) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing `repoUrl` param',
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  const normalizedRepoUrl = normalizeRepoUrl(body.repoUrl)
  if (!normalizedRepoUrl) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'invalid `repoUrl` param; expected a valid http(s) URL',
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  let parentId = null
  if (body.parentId && body.parentId !== 'null') {
    parentId = body.parentId
  }

  const discovered = await discoverPloneRestBase(normalizedRepoUrl)
  if (discovered.error) {
    return res.status(400).json({
      status: 400,
      data: {
        error: discovered.error,
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  const maxItems = normalizePositiveInt(body.maxItems, 5000)
  const searchResult = await fetchAllPloneSearchItems(discovered.base, maxItems)
  if (searchResult.error) {
    return res.status(400).json({
      status: 400,
      data: {
        error: searchResult.error,
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  const transformed = await ploneItemsToSiteItems(
    searchResult.items,
    discovered.base,
    parentId,
    searchResult.usedFullObjects
  )
  if (!transformed.items || transformed.items.length === 0) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Plone REST API is reachable but import produced no page-like content items',
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  return res.json({
    status: 200,
    data: {
      items: transformed.items,
      filename: getSiteFilename(discovered.site, discovered.base),
      files: transformed.files,
      plone: {
        base: discovered.base,
        importedItems: transformed.items.length,
        discoveredItems: searchResult.itemsTotal,
        binaryFiles: Object.keys(transformed.files).length,
        usedFullObjects: searchResult.usedFullObjects,
        truncated: searchResult.truncated
      }
    }
  })
}

function normalizeRepoUrl(value) {
  let tmp = ''
  if (typeof value === 'string') {
    tmp = value.trim()
  }
  if (!tmp) {
    return null
  }
  if (!tmp.startsWith('http://') && !tmp.startsWith('https://')) {
    tmp = `https://${tmp}`
  }
  try {
    return new URL(tmp).toString()
  } catch (e) {
    return null
  }
}

function normalizePositiveInt(value, fallback = 0) {
  const normalized = parseInt(value)
  if (Number.isNaN(normalized) || normalized < 1) {
    return fallback
  }
  return normalized
}

function stripTrailingSlash(value) {
  if (value.endsWith('/')) {
    return value.slice(0, -1)
  }
  return value
}

function buildPloneBaseCandidates(inputUrl) {
  const candidates = []
  let parsed = null
  try {
    parsed = new URL(inputUrl)
  } catch (e) {
    return candidates
  }
  const origin = `${parsed.protocol}//${parsed.host}`
  const stopSegments = ['@site', '@search', '@types', '++api++']
  let pathParts = parsed.pathname.split('/').filter(Boolean)
  while (pathParts.length > 0 && stopSegments.includes(pathParts[pathParts.length - 1])) {
    pathParts = pathParts.slice(0, pathParts.length - 1)
  }
  for (let i = pathParts.length; i >= 0; i -= 1) {
    const base = i > 0 ? `${origin}/${pathParts.slice(0, i).join('/')}` : origin
    const normalized = stripTrailingSlash(base)
    if (!candidates.includes(normalized)) {
      candidates.push(normalized)
    }
  }
  return candidates
}

function getResponseReason(responseMeta, fallback = '') {
  if (!responseMeta) {
    return fallback
  }
  if (responseMeta.data && typeof responseMeta.data === 'object') {
    if (typeof responseMeta.data.reason === 'string' && responseMeta.data.reason !== '') {
      return responseMeta.data.reason
    }
    if (typeof responseMeta.data.message === 'string' && responseMeta.data.message !== '') {
      return responseMeta.data.message
    }
    if (typeof responseMeta.data.error === 'string' && responseMeta.data.error !== '') {
      return responseMeta.data.error
    }
    if (typeof responseMeta.data.error_type === 'string' && responseMeta.data.error_type !== '') {
      return responseMeta.data.error_type
    }
    if (typeof responseMeta.data.type === 'string' && responseMeta.data.type !== '') {
      return responseMeta.data.type
    }
  }
  if (fallback) {
    return fallback
  }
  return 'Unknown error'
}

async function discoverPloneRestBase(inputUrl) {
  const candidates = buildPloneBaseCandidates(inputUrl)
  if (candidates.length === 0) {
    return {
      error: 'Unable to resolve candidate Plone base URLs from `repoUrl`',
      status: 422
    }
  }

  let permissionBlocked = null
  for await (const candidate of candidates) {
    const siteEndpoint = `${candidate}/@site`
    const siteResponse = await fetchJSONWithMeta(siteEndpoint, {
      headers: {
        Accept: 'application/json'
      }
    })
    if (siteResponse.ok && siteResponse.data && typeof siteResponse.data === 'object') {
      return {
        base: candidate,
        site: siteResponse.data
      }
    }

    const siteReason = getResponseReason(siteResponse, '')
    if ((siteResponse.status === 401 || siteResponse.status === 403) && siteReason.toLowerCase().includes('plone.restapi')) {
      permissionBlocked = {
        base: candidate,
        status: siteResponse.status,
        reason: siteReason
      }
    }

    const apiResponse = await fetchJSONWithMeta(`${candidate}/++api++`, {
      headers: {
        Accept: 'application/json'
      }
    })
    const apiReason = getResponseReason(apiResponse, '')
    if ((apiResponse.status === 401 || apiResponse.status === 403) && apiReason.toLowerCase().includes('plone.restapi')) {
      permissionBlocked = {
        base: candidate,
        status: apiResponse.status,
        reason: apiReason
      }
    }
  }

  if (permissionBlocked) {
    return {
      error:
        'Plone REST API detected at ' +
        permissionBlocked.base +
        ' but access is denied (' +
        permissionBlocked.status +
        '). Enable `plone.restapi: Use REST API` permission for authenticated/anonymous access and retry.',
      status: 422
    }
  }

  return {
    error:
      'Unable to discover Plone REST endpoints from `repoUrl`. Expected endpoints like `/@site` and `/@search`. Install/enable the `plone.restapi` add-on and expose REST access before importing.',
    status: 422
  }
}

async function fetchAllPloneSearchItems(base, maxItems = 5000) {
  const bSize = 100
  let bStart = 0
  let pageCount = 0
  const maxPages = 500
  let itemsTotal = null
  let useFullObjects = true
  const allItems = []

  while (pageCount < maxPages && allItems.length < maxItems) {
    let pageResponse = await fetchPloneSearchPage(base, bStart, bSize, useFullObjects)
    if (!pageResponse.ok && useFullObjects) {
      const fallback = await fetchPloneSearchPage(base, bStart, bSize, false)
      if (fallback.ok) {
        pageResponse = fallback
        useFullObjects = false
      }
    }

    if (!pageResponse.ok) {
      const reason = getResponseReason(pageResponse, 'search request failed')
      if ((pageResponse.status === 401 || pageResponse.status === 403) && reason.toLowerCase().includes('plone.restapi')) {
        return {
          error:
            'Plone REST search endpoint is not accessible. Enable `plone.restapi: Use REST API` permission and retry.',
          status: 422
        }
      }
      if (pageResponse.status === 404) {
        return {
          error:
            'Plone REST search endpoint `/@search` was not found. Enable/install `plone.restapi` and retry.',
          status: 422
        }
      }
      return {
        error: `Plone search failed at ${base}/@search (${pageResponse.status}): ${reason}`,
        status: 422
      }
    }

    const payload = pageResponse.data && typeof pageResponse.data === 'object' ? pageResponse.data : {}
    const pageItems = Array.isArray(payload.items) ? payload.items : []
    if (typeof payload.items_total === 'number') {
      itemsTotal = payload.items_total
    }

    if (pageItems.length === 0) {
      break
    }

    for (let i = 0; i < pageItems.length; i += 1) {
      allItems.push(pageItems[i])
      if (allItems.length >= maxItems) {
        break
      }
    }

    bStart += pageItems.length
    pageCount += 1
    if (itemsTotal !== null && bStart >= itemsTotal) {
      break
    }
    if (pageItems.length < bSize) {
      break
    }
  }

  return {
    items: allItems,
    itemsTotal: itemsTotal !== null ? itemsTotal : allItems.length,
    usedFullObjects: useFullObjects,
    truncated: itemsTotal !== null ? allItems.length < itemsTotal : false
  }
}

async function fetchPloneSearchPage(base, bStart, bSize, fullobjects = true) {
  const url = new URL(`${base}/@search`)
  url.searchParams.set('b_start', String(bStart))
  url.searchParams.set('b_size', String(bSize))
  url.searchParams.set('sort_on', 'path')
  url.searchParams.set('sort_order', 'ascending')
  url.searchParams.append('metadata_fields', 'UID')
  url.searchParams.append('metadata_fields', 'portal_type')
  url.searchParams.append('metadata_fields', 'path')
  url.searchParams.append('metadata_fields', 'is_folderish')
  url.searchParams.append('metadata_fields', 'created')
  url.searchParams.append('metadata_fields', 'modified')
  url.searchParams.append('metadata_fields', 'review_state')
  url.searchParams.append('metadata_fields', 'getObjPositionInParent')
  if (fullobjects) {
    url.searchParams.set('fullobjects', '1')
  }
  return fetchJSONWithMeta(url.toString(), {
    headers: {
      Accept: 'application/json'
    }
  })
}

async function hydratePloneObject(item) {
  if (!item || !item['@id']) {
    return item
  }
  const objectResponse = await fetchJSONWithMeta(item['@id'], {
    headers: {
      Accept: 'application/json'
    }
  })
  if (objectResponse.ok && objectResponse.data && typeof objectResponse.data === 'object') {
    return Object.assign({}, item, objectResponse.data)
  }
  return item
}

async function ploneItemsToSiteItems(items, base, configuredParent, usedFullObjects = true) {
  const baseUrl = new URL(base)
  const byRelativePath = {}
  const files = {}

  for (let i = 0; i < items.length; i += 1) {
    let item = items[i]
    if (!usedFullObjects) {
      item = await hydratePloneObject(item)
    }
    if (!item || !item['@id']) {
      continue
    }

    const itemType = item['@type'] ? item['@type'] : item.portal_type
    if (BINARY_TYPES.includes(itemType)) {
      registerBinaryFile(item, files)
      continue
    }
    if (!shouldImportAsPage(item, itemType)) {
      continue
    }

    const relativePath = getRelativePath(item['@id'], baseUrl)
    if (!relativePath) {
      continue
    }
    const record = buildRecordFromPloneItem(item, itemType, relativePath, base)
    if (!record) {
      continue
    }
    if (!byRelativePath[relativePath] || shouldReplaceRecord(byRelativePath[relativePath], record)) {
      byRelativePath[relativePath] = record
    }
  }

  const records = Object.values(byRelativePath)
  const josItems = recordsToJOSItems(records, configuredParent)
  return {
    items: josItems,
    files: files
  }
}

function getRelativePath(itemUrl, baseUrl) {
  let parsedItem = null
  try {
    parsedItem = new URL(itemUrl)
  } catch (e) {
    return ''
  }
  let itemPath = parsedItem.pathname
  let basePath = baseUrl.pathname
  if (basePath === '/') {
    basePath = ''
  }
  basePath = stripTrailingSlash(basePath)
  if (basePath !== '' && itemPath === basePath) {
    return ''
  }
  if (basePath !== '' && itemPath.startsWith(`${basePath}/`)) {
    itemPath = itemPath.substring(basePath.length + 1)
  } else {
    itemPath = itemPath.replace(/^\/+/, '')
  }
  itemPath = itemPath.replace(/\/+$/, '')
  try {
    itemPath = decodeURIComponent(itemPath)
  } catch (e) {
    // ignore decode errors
  }
  return itemPath
}

function shouldImportAsPage(item, itemType) {
  if (!item || !itemType) {
    return false
  }
  if (BINARY_TYPES.includes(itemType)) {
    return false
  }
  if (DEFAULT_PAGE_TYPES.includes(itemType)) {
    return true
  }
  if (item.is_folderish === true) {
    return true
  }
  if (item.text && typeof item.text === 'object' && typeof item.text.data === 'string' && item.text.data.trim() !== '') {
    return true
  }
  if (typeof item.description === 'string' && item.description.trim() !== '') {
    return true
  }
  return false
}

function buildRecordFromPloneItem(item, itemType, relativePath, base) {
  const pathParts = relativePath.split('/').filter(Boolean)
  if (pathParts.length === 0) {
    return null
  }
  const slug = pathParts.map((part) => HAXCMS.cleanTitle(part, false)).join('/')
  const parentPath = pathParts.length > 1 ? pathParts.slice(0, pathParts.length - 1).join('/') : ''
  const title = typeof item.title === 'string' && item.title.trim() !== ''
    ? item.title.trim()
    : pathParts[pathParts.length - 1]
  const description = typeof item.description === 'string' ? item.description : ''
  const orderHint = normalizePositiveInt(item.getObjPositionInParent, -1)

  return {
    relativePath: relativePath,
    parentPath: parentPath,
    slug: slug,
    title: title,
    description: description,
    orderHint: orderHint >= 0 ? orderHint : null,
    contents: extractPloneContents(item, itemType, base),
    metadata: {
      sourceType: 'plone',
      source: item['@id'],
      plone: {
        uid: item.UID ? item.UID : '',
        type: itemType,
        reviewState: item.review_state ? item.review_state : '',
        created: item.created ? item.created : '',
        modified: item.modified ? item.modified : ''
      }
    }
  }
}

function extractPloneContents(item, itemType, base) {
  if (item && item.text && typeof item.text === 'object' && typeof item.text.data === 'string' && item.text.data.trim() !== '') {
    return absolutizeRootUrls(item.text.data, base)
  }
  if (itemType === 'Link' && item.remoteUrl) {
    return `<p><a href="${item.remoteUrl}" target="_blank" rel="noopener noreferrer">${item.remoteUrl}</a></p>`
  }
  if (item && item.blocks && item.blocks_layout && Array.isArray(item.blocks_layout.items) && item.blocks_layout.items.length > 0) {
    return '<p>This Plone item stores body content in blocks and requires a blocks-to-HTML transform for full fidelity import.</p>'
  }
  if (typeof item.description === 'string' && item.description.trim() !== '') {
    return `<p>${item.description.trim()}</p>`
  }
  return '<p></p>'
}

function shouldReplaceRecord(existing, incoming) {
  return scoreRecord(incoming) > scoreRecord(existing)
}

function scoreRecord(record) {
  let score = 0
  if (record && typeof record.contents === 'string' && record.contents !== '<p></p>') {
    score += 2
  }
  if (record && record.description) {
    score += 1
  }
  if (record && record.orderHint !== null) {
    score += 1
  }
  return score
}

function recordsToJOSItems(records, configuredParent) {
  const recordsByPath = {}
  const childrenByParent = {}
  for (let i = 0; i < records.length; i += 1) {
    recordsByPath[records[i].relativePath] = records[i]
  }
  for (let i = 0; i < records.length; i += 1) {
    let parentPath = records[i].parentPath
    if (parentPath !== '' && !recordsByPath[parentPath]) {
      parentPath = ''
    }
    if (!childrenByParent[parentPath]) {
      childrenByParent[parentPath] = []
    }
    childrenByParent[parentPath].push(records[i])
  }
  Object.keys(childrenByParent).forEach((key) => {
    childrenByParent[key].sort(compareRecords)
  })

  const items = []
  const visited = {}
  function walk(parentPath, josParentId, depth) {
    const siblings = childrenByParent[parentPath] ? childrenByParent[parentPath] : []
    for (let i = 0; i < siblings.length; i += 1) {
      const record = siblings[i]
      if (visited[record.relativePath]) {
        continue
      }
      visited[record.relativePath] = true
      const item = new JSONOutlineSchemaItem()
      item.title = record.title
      item.slug = record.slug
      item.parent = josParentId !== null ? josParentId : configuredParent
      item.indent = depth
      item.order = i
      item.description = record.description
      item.contents = record.contents
      item.metadata = record.metadata
      items.push(item)
      walk(record.relativePath, item.id, depth + 1)
    }
  }
  walk('', null, 0)
  return items
}

function compareRecords(a, b) {
  const aHasHint = a.orderHint !== null
  const bHasHint = b.orderHint !== null
  if (aHasHint && bHasHint && a.orderHint !== b.orderHint) {
    return a.orderHint - b.orderHint
  }
  if (aHasHint && !bHasHint) {
    return -1
  }
  if (!aHasHint && bHasHint) {
    return 1
  }
  return a.title.localeCompare(b.title)
}

function getSiteFilename(siteData, base) {
  if (siteData && typeof siteData.title === 'string' && siteData.title.trim() !== '') {
    return HAXCMS.cleanTitle(siteData.title, false)
  }
  try {
    const parsed = new URL(base)
    const bits = parsed.pathname.split('/').filter(Boolean)
    if (bits.length > 0) {
      return HAXCMS.cleanTitle(bits[bits.length - 1], false)
    }
  } catch (e) {
    // ignore
  }
  return 'plone-import'
}

function registerBinaryFile(item, files) {
  let filename = ''
  let download = ''
  if (item.file && typeof item.file === 'object') {
    if (typeof item.file.filename === 'string') {
      filename = item.file.filename
    }
    if (typeof item.file.download === 'string') {
      download = absolutizeFromItem(item.file.download, item['@id'])
    }
  }
  if (item.image && typeof item.image === 'object') {
    if (!filename && typeof item.image.filename === 'string') {
      filename = item.image.filename
    }
    if (!download && typeof item.image.download === 'string') {
      download = absolutizeFromItem(item.image.download, item['@id'])
    }
  }
  if (!download && item['@id'] && item['@type'] === 'File') {
    download = `${stripTrailingSlash(item['@id'])}/@@download/file`
  }
  if (!download && item['@id'] && item['@type'] === 'Image') {
    download = `${stripTrailingSlash(item['@id'])}/@@images/image`
  }
  if (!filename && item['@id']) {
    filename = item['@id'].split('/').pop()
  }
  if (!filename || !download) {
    return
  }
  const uniqueKey = ensureUniqueFileKey(files, `files/${sanitizeFilename(filename)}`)
  files[uniqueKey] = download
}

function absolutizeFromItem(value, itemId) {
  try {
    return new URL(value, itemId).toString()
  } catch (e) {
    return value
  }
}

function sanitizeFilename(value) {
  let filename = value.toLowerCase().trim()
  filename = filename.replace(/\s+/g, '-')
  filename = filename.replace(/[^a-z0-9\-._/]+/g, '-')
  filename = filename.replace(/--+/g, '-')
  if (filename === '') {
    filename = 'file'
  }
  return filename
}

function ensureUniqueFileKey(files, desiredKey) {
  if (!files[desiredKey]) {
    return desiredKey
  }
  const parts = desiredKey.split('/')
  const filename = parts.pop()
  const folder = parts.join('/')
  const extensionIndex = filename.lastIndexOf('.')
  let namePart = filename
  let extPart = ''
  if (extensionIndex > 0) {
    namePart = filename.substring(0, extensionIndex)
    extPart = filename.substring(extensionIndex)
  }
  let index = 2
  while (files[`${folder}/${namePart}-${index}${extPart}`]) {
    index += 1
  }
  return `${folder}/${namePart}-${index}${extPart}`
}

async function fetchJSONWithMeta(url, fetchOptions = {}) {
  try {
    const response = await fetch(url, fetchOptions)
    let data = null
    try {
      data = await response.json()
    } catch (e) {
      data = null
    }
    return {
      ok: response.ok,
      status: response.status,
      data: data
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null
    }
  }
}

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

module.exports = { convertPloneToSite }
