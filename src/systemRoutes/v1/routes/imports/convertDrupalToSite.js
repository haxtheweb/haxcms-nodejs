const { HAXCMS } = require('../../../../lib/HAXCMS.js')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { parse } = require('node-html-parser')
const { safeFetch } = require('../../../../lib/safeFetch.js')
const { escapeHTMLAttribute } = require('../../../../lib/sanitizeContent.js')

// Safety valves: createSite downloads every build.files entry, so only their
// count is capped here (matching the VitePress importer's LIMITS.maxFiles).
const LIMITS = {
  maxFiles: 2000
}
// createSite's build.files pipeline (importBuildFile) only accepts these
// extensions, so anything else is never handed over in the first place
// (mirrors SAFE_BULK_IMPORT_EXTENSION_REGEX in createSite.js).
const SAFE_BULK_IMPORT_EXTENSION_REGEX = /\.(jpg|jpeg|png|gif|webm|webp|mp4|mp3|mov|csv|ppt|pptx|xlsx|doc|xls|docx|pdf|rtf|txt|vtt|html|md|xml|ics|vcf)$/i
// Drupal public file URLs look like /sites/default/files/2024-06/x.jpg (or
// /sites/< multisite >/files/..., /files/...). The captured remainder becomes
// the files-relative key because HAXCMSFile.save preserves the bulk-import
// directory tree, so 2024-06/x.jpg lands at files/2024-06/x.jpg.
const DRUPAL_FILES_PATH_REGEX = /^\/(?:sites\/[^/]+\/)?files\/(.+)$/i
// Menu-item endpoint variants, in preference order (jsonapi_menu_items is the
// most common; jsonapi_frontend_menu nests children; jsonapi_menu last). All
// are cheap 404s when the module is not installed.
const MENU_ITEM_ENDPOINT_PATHS = [
  '/jsonapi/menu_items/',
  '/jsonapi/menu/',
  '/jsonapi/jsonapi_menu/'
]
// system menus never describe the site outline
const MENU_NAME_DENYLIST = { admin: true, tools: true, account: true, devel: true }
// media bundle -> element kind
const MEDIA_BUNDLE_KINDS = {
  image: 'image',
  document: 'document',
  video: 'video',
  audio: 'audio',
  remote_video: 'remote-video'
}
// per-kind preferred relationship fields carrying the file--file reference
const MEDIA_FILE_FIELDS = {
  image: ['field_media_image', 'thumbnail'],
  document: ['field_media_document'],
  video: ['field_media_video'],
  audio: ['field_media_audio']
}
const FILE_REFERENCE_ATTRIBUTES = ['src', 'href', 'poster', 'source']

/**
 * POST /system/api/v1/site/import/drupal
 * Convert a general Drupal site (JSON:API) into a HAXcms site schema.
 *
 * Expects `repoUrl` (body or query) pointing at any URL of a Drupal site with
 * JSON:API exposed. Pages come from node--page plus node--book when present,
 * files from file--file (handed to createSite's build.files pipeline), and
 * media embeds (<drupal-media> placeholders + field_media references) resolve
 * into HAX media elements. The outline follows the site's own menu structure:
 * a menu-items endpoint (jsonapi_menu_items / jsonapi_frontend_menu /
 * jsonapi_menu) when one of those modules is installed, otherwise
 * menu_link_content records, book fields, or a flat page list.
 *
 * Returns { status: 200, data: { items, filename, files, drupal } }.
 */
async function convertDrupalToSite(req, res) {
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

  const settings = {}
  if (body.parentId && body.parentId !== 'null') {
    settings.parentId = body.parentId
  }

  const importedData = await importDrupalSite(body.repoUrl, settings)
  if (!importedData) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Drupal import failed to produce content',
        items: [],
        filename: null,
        files: {}
      }
    })
  }
  if (importedData.error) {
    return res.status(400).json({
      status: 400,
      data: {
        error: importedData.error,
        items: [],
        filename: null,
        files: {}
      }
    })
  }
  if (!Array.isArray(importedData.items) || importedData.items.length === 0) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Drupal import produced no pages to import',
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  return res.json({
    status: 200,
    data: {
      items: importedData.items,
      filename: importedData.filename,
      files: importedData.files,
      drupal: importedData.drupal
    }
  })
}

async function fetchJSON(url, fetchOptions = {}) {
  try {
    const response = await safeFetch(url, fetchOptions)
    if (!response.ok) {
      return null
    }
    return await response.json()
  } catch (e) {
    return null
  }
}

function normalizeNumeric(value, fallback = 0) {
  const normalized = parseInt(value)
  if (Number.isNaN(normalized)) {
    return fallback
  }
  return normalized
}

// ---- JSON:API discovery and collection pagination ----

function buildDrupalBaseCandidates(inputUrl) {
  const candidates = []
  try {
    const parsed = new URL(inputUrl)
    const origin = `${parsed.protocol}//${parsed.host}`
    const pathParts = parsed.pathname.split('/').filter(Boolean)
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

async function discoverDrupalJsonApiBase(inputUrl) {
  const candidates = buildDrupalBaseCandidates(inputUrl)
  for await (const candidate of candidates) {
    const payload = await fetchJSON(`${candidate}/jsonapi`, {
      headers: {
        Accept: 'application/vnd.api+json,application/json'
      }
    })
    if (payload && payload.links && typeof payload.links === 'object') {
      return {
        base: candidate,
        discovery: payload
      }
    }
  }
  return null
}

function getDiscoveryLinks(discoveryPayload) {
  if (!discoveryPayload || !discoveryPayload.links || typeof discoveryPayload.links !== 'object') {
    return {}
  }
  return discoveryPayload.links
}

function withPageLimit(url, pageLimit = 50) {
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.get('page[limit]')) {
      parsed.searchParams.set('page[limit]', `${pageLimit}`)
    }
    return parsed.toString()
  } catch (e) {
    if (url.indexOf('?') === -1) {
      return `${url}?page[limit]=${pageLimit}`
    }
    if (
      url.indexOf('page%5Blimit%5D=') === -1 &&
      url.indexOf('page[limit]=') === -1
    ) {
      return `${url}&page[limit]=${pageLimit}`
    }
    return url
  }
}

async function fetchDrupalCollectionByHref(href, pageLimit = 50, maxPages = 200) {
  if (!href) {
    return []
  }
  let requestUrl = withPageLimit(href, pageLimit)
  let page = 0
  const items = []
  while (requestUrl && page < maxPages) {
    page += 1
    const payload = await fetchJSON(requestUrl, {
      headers: {
        Accept: 'application/vnd.api+json,application/json'
      }
    })
    if (!payload || !Array.isArray(payload.data)) {
      break
    }
    items.push(...payload.data)
    let nextHref = null
    if (
      payload.links &&
      payload.links.next &&
      typeof payload.links.next === 'object' &&
      payload.links.next.href
    ) {
      nextHref = payload.links.next.href
    }
    requestUrl = nextHref
  }
  return items
}

function getNodeCollectionLinks(discoveryLinks) {
  const links = {}
  Object.keys(discoveryLinks).forEach((key) => {
    if (key.indexOf('node--') !== 0) {
      return
    }
    const linkDef = discoveryLinks[key]
    if (linkDef && typeof linkDef === 'object' && linkDef.href) {
      links[key] = linkDef.href
    }
  })
  return links
}

function getMenuLinkContentHref(discoveryLinks) {
  if (
    discoveryLinks &&
    discoveryLinks['menu_link_content--menu_link_content'] &&
    typeof discoveryLinks['menu_link_content--menu_link_content'] === 'object'
  ) {
    return discoveryLinks['menu_link_content--menu_link_content'].href
  }
  return null
}

// ---- node record helpers ----

function getDrupalNodeNid(record) {
  if (!record || !record.attributes) {
    return 0
  }
  return normalizeNumeric(record.attributes.drupal_internal__nid, 0)
}

function getDrupalNodeTitle(record) {
  if (!record || !record.attributes || !record.attributes.title) {
    const nid = getDrupalNodeNid(record)
    return nid > 0 ? `Node ${nid}` : 'Node'
  }
  const title = `${record.attributes.title}`.trim()
  if (title !== '') {
    return title
  }
  const nid = getDrupalNodeNid(record)
  return nid > 0 ? `Node ${nid}` : 'Node'
}

function sortNodeRecords(records) {
  const sorted = [...records]
  sorted.sort((a, b) => {
    const titleA = getDrupalNodeTitle(a).toLowerCase()
    const titleB = getDrupalNodeTitle(b).toLowerCase()
    if (titleA < titleB) {
      return -1
    }
    if (titleA > titleB) {
      return 1
    }
    return getDrupalNodeNid(a) - getDrupalNodeNid(b)
  })
  return sorted
}

function sortNodeRecordsByCreated(records) {
  const sorted = [...records]
  sorted.sort((a, b) => {
    const createdA = a && a.attributes && typeof a.attributes.created === 'string' ? a.attributes.created : ''
    const createdB = b && b.attributes && typeof b.attributes.created === 'string' ? b.attributes.created : ''
    if (createdA !== createdB) {
      return createdA < createdB ? -1 : 1
    }
    return getDrupalNodeNid(a) - getDrupalNodeNid(b)
  })
  return sorted
}

function getNodeSegment(record) {
  let segment = ''
  if (
    record &&
    record.attributes &&
    record.attributes.path &&
    typeof record.attributes.path === 'object' &&
    record.attributes.path.alias &&
    typeof record.attributes.path.alias === 'string'
  ) {
    const parts = record.attributes.path.alias.split('/').filter(Boolean)
    if (parts.length > 0) {
      segment = HAXCMS.cleanTitle(parts[parts.length - 1], false)
    }
  }
  if (!segment || segment === '') {
    segment = HAXCMS.cleanTitle(getDrupalNodeTitle(record), false)
  }
  if (!segment || segment === '') {
    const nid = getDrupalNodeNid(record)
    segment = nid > 0 ? `node-${nid}` : 'node'
  }
  return segment
}

function uniqueSegment(segment, siblingMap, nid) {
  let candidate = segment
  if (!siblingMap[candidate]) {
    siblingMap[candidate] = true
    return candidate
  }
  candidate = `${segment}-${nid}`
  if (!siblingMap[candidate]) {
    siblingMap[candidate] = true
    return candidate
  }
  let i = 2
  while (siblingMap[`${candidate}-${i}`]) {
    i += 1
  }
  candidate = `${candidate}-${i}`
  siblingMap[candidate] = true
  return candidate
}

function formatDrupalNodeMetadata(record, sourceType, base, extra = {}) {
  const attrs = record && record.attributes ? record.attributes : {}
  const nid = getDrupalNodeNid(record)
  const metadata = {
    sourceType,
    source: nid > 0 ? `${base}/node/${nid}` : null,
    published: attrs && attrs.status === false ? false : true,
    drupal: {
      nid: nid,
      uuid: record && record.id ? record.id : null,
      type: record && record.type ? record.type : null
    }
  }
  Object.keys(extra).forEach((key) => {
    metadata.drupal[key] = extra[key]
  })
  return metadata
}

function getFilenameFromUrl(repoUrl) {
  try {
    const parsed = new URL(repoUrl)
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    if (pathParts.length > 0) {
      let last = decodeURIComponent(pathParts[pathParts.length - 1])
      if (/^jsonapi$/i.test(last) && pathParts.length > 1) {
        last = decodeURIComponent(pathParts[pathParts.length - 2])
      } else {
        last = last.replace(/^jsonapi$/i, '')
      }
      if (last && last !== '') {
        const clean = HAXCMS.cleanTitle(last, false)
        if (clean && clean !== '' && clean !== 'blank') {
          return clean
        }
      }
    }
    const hostClean = HAXCMS.cleanTitle(parsed.host, false)
    if (hostClean && hostClean !== '' && hostClean !== 'blank') {
      return hostClean
    }
  } catch (e) {
    // fall through to the default
  }
  return 'drupal-import'
}

// ---- file map (file--file -> build.files entries) ----

function stripUrlExtras(value) {
  let v = String(value).trim()
  const hashIndex = v.indexOf('#')
  if (hashIndex !== -1) {
    v = v.substring(0, hashIndex)
  }
  const queryIndex = v.indexOf('?')
  if (queryIndex !== -1) {
    v = v.substring(0, queryIndex)
  }
  return v
}

function pathnameFromFileUrl(urlValue) {
  const v = stripUrlExtras(urlValue)
  if (v === '') {
    return null
  }
  if (v.indexOf('//') === 0) {
    return null
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      return new URL(v).pathname
    } catch (e) {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    return null
  }
  if (v.charAt(0) !== '/') {
    return null
  }
  return v
}

function drupalFileKeyFromPath(pathname) {
  const match = pathname.match(DRUPAL_FILES_PATH_REGEX)
  let key = match && match[1] ? match[1] : pathname.replace(/^\//, '')
  if (key === null || key === undefined) {
    return null
  }
  key = String(key)
  if (key === '' || key.indexOf('..') !== -1 || key.indexOf('\0') !== -1) {
    return null
  }
  return key
}

function absolutizeFileUrl(urlValue, base) {
  const v = String(urlValue)
  if (/^https?:\/\//i.test(v)) {
    return v
  }
  try {
    const parsed = new URL(base)
    const origin = `${parsed.protocol}//${parsed.host}`
    return `${origin}${v.charAt(0) === '/' ? '' : '/'}${v}`
  } catch (e) {
    return v
  }
}

function buildDrupalFileMap(fileRecords, base) {
  const files = {}
  const filesByUuid = {}
  const filesByPath = {}
  const skipped = {}
  let truncated = false
  const bump = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1
  }
  if (!Array.isArray(fileRecords)) {
    return { files, filesByUuid, filesByPath, skipped, truncated }
  }
  fileRecords.forEach((record) => {
    if (!record || !record.attributes) {
      return
    }
    const attrs = record.attributes
    if (attrs.status !== true) {
      bump('temporary')
      return
    }
    const uri = attrs.uri && typeof attrs.uri === 'object' ? attrs.uri : null
    const urlValue = uri && typeof uri.url === 'string' && uri.url !== '' ? uri.url : ''
    if (urlValue === '') {
      // private streams and unserved files expose no url
      bump('no-url')
      return
    }
    const pathname = pathnameFromFileUrl(urlValue)
    if (pathname === null) {
      bump('no-url')
      return
    }
    const key = drupalFileKeyFromPath(pathname)
    if (key === null) {
      bump('invalid-path')
      return
    }
    if (!SAFE_BULK_IMPORT_EXTENSION_REGEX.test(key)) {
      bump('extension')
      return
    }
    if (files[key]) {
      bump('duplicate')
      return
    }
    if (Object.keys(files).length >= LIMITS.maxFiles) {
      truncated = true
      return
    }
    const absoluteUrl = absolutizeFileUrl(urlValue, base)
    files[key] = absoluteUrl
    filesByPath[pathname] = `files/${key}`
    if (record.id) {
      filesByUuid[record.id] = {
        key: key,
        ref: `files/${key}`,
        url: absoluteUrl,
        filename: typeof attrs.filename === 'string' ? attrs.filename : ''
      }
    }
  })
  return { files, filesByUuid, filesByPath, skipped, truncated }
}

// ---- media resolution (media--* -> HAX media elements) ----

function mediaTitleFromAttrs(attrs) {
  return typeof attrs.name === 'string' && attrs.name !== '' ? attrs.name : ''
}

function firstRelationshipData(rel) {
  if (!rel || typeof rel !== 'object') {
    return null
  }
  if (rel.data && typeof rel.data === 'object' && rel.data.id) {
    return rel.data
  }
  if (Array.isArray(rel.data) && rel.data.length > 0 && rel.data[0] && rel.data[0].id) {
    return rel.data[0]
  }
  return null
}

function renderMediaElement(kind, ref, alt, title) {
  if (kind === 'image') {
    return `<media-image source="${escapeHTMLAttribute(ref)}" alt="${escapeHTMLAttribute(alt)}"></media-image>`
  }
  if (kind === 'video') {
    return `<video-player source="${escapeHTMLAttribute(ref)}" media-title="${escapeHTMLAttribute(title)}"></video-player>`
  }
  if (kind === 'audio') {
    return `<media-playlist><audio-player source="${escapeHTMLAttribute(ref)}" media-title="${escapeHTMLAttribute(title)}"></audio-player></media-playlist>`
  }
  // document (and unknown file-bearing bundles) resolve to a link
  return `<a href="${escapeHTMLAttribute(ref)}">${escapeHTMLAttribute(title)}</a>`
}

function resolveMediaRecord(record, fileMap) {
  const type = typeof record.type === 'string' ? record.type : ''
  const bundle = type.indexOf('--') !== -1 ? type.split('--').pop() : ''
  const kind = MEDIA_BUNDLE_KINDS[bundle] || 'file'
  const attrs = record.attributes && typeof record.attributes === 'object' ? record.attributes : {}
  const rels = record.relationships && typeof record.relationships === 'object' ? record.relationships : {}

  if (kind === 'remote-video') {
    const oembed = attrs.field_media_oembed_video
    const url = typeof oembed === 'string' ? oembed : (oembed && typeof oembed.value === 'string' ? oembed.value : '')
    if (url !== '' && /^https?:\/\//i.test(url)) {
      const title = mediaTitleFromAttrs(attrs) || url
      return {
        kind: kind,
        ref: url,
        external: true,
        title: title,
        alt: '',
        element: renderMediaElement('video', url, '', title)
      }
    }
    return null
  }

  let fileData = null
  const preferred = MEDIA_FILE_FIELDS[kind] || []
  for (let i = 0; i < preferred.length && !fileData; i += 1) {
    const data = firstRelationshipData(rels[preferred[i]])
    if (data && data.type === 'file--file') {
      fileData = data
    }
  }
  if (!fileData) {
    const relKeys = Object.keys(rels)
    for (let i = 0; i < relKeys.length && !fileData; i += 1) {
      const data = firstRelationshipData(rels[relKeys[i]])
      if (data && data.type === 'file--file') {
        fileData = data
      }
    }
  }
  if (!fileData || !fileData.id) {
    return null
  }
  const fileEntry = fileMap.filesByUuid[fileData.id]
  if (!fileEntry) {
    // file was skipped (temporary, disallowed extension, private stream)
    return null
  }
  const meta = fileData.meta && typeof fileData.meta === 'object' ? fileData.meta : {}
  const title =
    (typeof meta.title === 'string' && meta.title !== '' ? meta.title : '') ||
    mediaTitleFromAttrs(attrs) ||
    fileEntry.filename ||
    fileEntry.key
  const alt = typeof meta.alt === 'string' ? meta.alt : ''
  return {
    kind: kind,
    ref: fileEntry.ref,
    title: title,
    alt: alt,
    element: renderMediaElement(kind, fileEntry.ref, alt, title)
  }
}

function buildMediaMap(mediaRecords, fileMap) {
  const mediaByUuid = {}
  const stats = { total: 0, resolved: 0, unresolved: 0 }
  if (!Array.isArray(mediaRecords)) {
    return { mediaByUuid, stats }
  }
  mediaRecords.forEach((record) => {
    if (!record || !record.id) {
      return
    }
    stats.total += 1
    const resolved = resolveMediaRecord(record, fileMap)
    if (resolved) {
      stats.resolved += 1
      mediaByUuid[record.id] = resolved
    } else {
      stats.unresolved += 1
      mediaByUuid[record.id] = null
    }
  })
  return { mediaByUuid, stats }
}

// ---- page content assembly ----

function getDrupalNodeBodyValue(record) {
  if (!record || !record.attributes) {
    return ''
  }
  const attrs = record.attributes
  if (attrs.body && typeof attrs.body === 'object' && typeof attrs.body.value === 'string') {
    return attrs.body.value
  }
  if (typeof attrs.body === 'string') {
    return attrs.body
  }
  return ''
}

function extractUuidFromAttrs(attrs) {
  const match = String(attrs).match(/data-entity-uuid\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
  if (!match) {
    return ''
  }
  return match[1] !== undefined ? match[1] : (match[2] || '')
}

// Replace <drupal-media data-entity-uuid="..."> placeholders with the
// resolved HAX media element (or nothing when the media cannot be resolved).
function replaceDrupalMediaEmbeds(content, mediaByUuid) {
  if (!content || content === '') {
    return content
  }
  if (content.indexOf('<drupal-media') === -1) {
    return content
  }
  return content.replace(
    /<drupal-media\b([^>]*)>([\s\S]*?)<\/drupal-media\s*>|<drupal-media\b([^>]*)\/>/gi,
    (match, pairedAttrs, inner, selfClosingAttrs) => {
      const attrs = pairedAttrs !== undefined ? pairedAttrs : selfClosingAttrs
      const uuid = extractUuidFromAttrs(attrs || '')
      const media = uuid !== '' && mediaByUuid ? mediaByUuid[uuid] : null
      if (media && media.element) {
        return media.element
      }
      return ''
    }
  )
}

function fileReferenceFor(value, fileMap) {
  const v = stripUrlExtras(value)
  if (v === '') {
    return null
  }
  if (v.indexOf('//') === 0) {
    return null
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const parsed = new URL(v)
      return fileMap.filesByPath[parsed.pathname] || null
    } catch (e) {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    return null
  }
  let pathname = v
  while (pathname.charAt(0) === '/') {
    pathname = pathname.substring(1)
  }
  if (pathname === '') {
    return null
  }
  return fileMap.filesByPath[`/${pathname}`] || null
}

function rewriteSrcsetValue(srcset, fileMap) {
  const parts = String(srcset).split(',')
  const rewritten = []
  parts.forEach((part) => {
    const trimmed = part.trim()
    if (trimmed === '') {
      return
    }
    const pieces = trimmed.split(/\s+/)
    const ref = fileReferenceFor(pieces[0], fileMap)
    if (ref) {
      pieces[0] = ref
    }
    rewritten.push(pieces.join(' '))
  })
  return rewritten.join(', ')
}

// Rewrite src/href/poster/source (and srcset candidates) that point at known
// file--file URLs into their files/... site-relative references, so the
// imported pages link at the downloaded assets and FileContentScanner can
// resolve page.metadata.files after the build.files ingest.
function rewriteFileReferences(content, fileMap) {
  if (!content || content === '') {
    return ''
  }
  if (Object.keys(fileMap.filesByPath).length === 0) {
    return content
  }
  let container = null
  try {
    // node-html-parser returns a virtual root for fragments, so parsing the
    // body directly and reading root.innerHTML round-trips the fragment
    // without a wrapper element leaking into the stored page content
    container = parse(content)
  } catch (e) {
    return content
  }
  const elements = container.querySelectorAll('*')
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i]
    for (let j = 0; j < FILE_REFERENCE_ATTRIBUTES.length; j += 1) {
      const attr = FILE_REFERENCE_ATTRIBUTES[j]
      const value = el.getAttribute(attr)
      if (!value || value === '') {
        continue
      }
      const ref = fileReferenceFor(value, fileMap)
      if (ref) {
        el.setAttribute(attr, ref)
      }
    }
    const srcset = el.getAttribute('srcset')
    if (srcset && srcset !== '') {
      const rewritten = rewriteSrcsetValue(srcset, fileMap)
      if (rewritten !== srcset) {
        el.setAttribute('srcset', rewritten)
      }
    }
  }
  return container.innerHTML
}

// Pages that carry their content as a field_media reference instead of a body
// (common on modern Drupal sites) render the referenced media as content.
function renderFieldMediaElements(record, mediaByUuid) {
  const rels = record && record.relationships && typeof record.relationships === 'object' ? record.relationships : {}
  const rel = rels.field_media
  const data = firstRelationshipData(rel)
  if (!data || !data.id) {
    return []
  }
  const media = mediaByUuid ? mediaByUuid[data.id] : null
  if (media && media.element) {
    return [media.element]
  }
  return []
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

function buildPageContent(record, base, mediaByUuid, fileMap) {
  let content = ''
  const raw = getDrupalNodeBodyValue(record)
  if (raw !== '') {
    const withoutEmbeds = replaceDrupalMediaEmbeds(raw, mediaByUuid)
    content = rewriteFileReferences(withoutEmbeds, fileMap)
  }
  if (content === '') {
    const elements = renderFieldMediaElements(record, mediaByUuid)
    if (elements.length > 0) {
      content = elements.join('\n')
    }
  }
  if (content === '') {
    return '<p></p>'
  }
  return absolutizeRootUrls(content, base)
}

// ---- menu uri / plugin id parsing ----

function parseNodeIdFromMenuUri(uriValue) {
  if (!uriValue || typeof uriValue !== 'string') {
    return 0
  }
  const uri = uriValue.trim()
  let match = uri.match(/^entity:node\/(\d+)$/i)
  if (match && match[1]) {
    return normalizeNumeric(match[1], 0)
  }
  match = uri.match(/^internal:\/node\/(\d+)$/i)
  if (match && match[1]) {
    return normalizeNumeric(match[1], 0)
  }
  match = uri.match(/\/node\/(\d+)/i)
  if (match && match[1]) {
    return normalizeNumeric(match[1], 0)
  }
  return 0
}

function parseParentLinkId(record) {
  if (!record) {
    return ''
  }
  const attrs = record.attributes ? record.attributes : {}
  const rels = record.relationships ? record.relationships : {}
  if (typeof attrs.parent === 'string' && attrs.parent.trim() !== '') {
    const parentValue = attrs.parent.trim()
    if (parentValue.indexOf(':') !== -1) {
      return parentValue.split(':').pop()
    }
    return parentValue
  }
  if (
    rels.parent &&
    rels.parent.data &&
    typeof rels.parent.data === 'object' &&
    rels.parent.data.id
  ) {
    return `${rels.parent.data.id}`
  }
  return ''
}

function parsePluginIdValue(value) {
  if (!value || typeof value !== 'string') {
    return ''
  }
  const v = value.trim()
  if (v === '') {
    return ''
  }
  if (v.indexOf(':') !== -1) {
    return v.split(':').pop()
  }
  return v
}

// ---- outline forests ----

function addRelation(relationByNid, nid, parentNid, weight) {
  if (!relationByNid[nid]) {
    relationByNid[nid] = {
      parentNid: parentNid,
      weight: weight
    }
  } else if (weight < relationByNid[nid].weight) {
    relationByNid[nid].weight = weight
  }
}

function childrenByParentFromRelations(relationByNid) {
  const buckets = {}
  Object.keys(relationByNid).forEach((nidKey) => {
    const nid = normalizeNumeric(nidKey, 0)
    const rel = relationByNid[nidKey]
    if (!buckets[rel.parentNid]) {
      buckets[rel.parentNid] = []
    }
    buckets[rel.parentNid].push({ nid: nid, weight: rel.weight })
  })
  const childrenByParent = {}
  Object.keys(buckets).forEach((parentKey) => {
    const parentNid = normalizeNumeric(parentKey, 0)
    const ordered = buckets[parentKey].sort((a, b) => {
      if (a.weight !== b.weight) {
        return a.weight - b.weight
      }
      return a.nid - b.nid
    })
    childrenByParent[parentNid] = ordered.map((entry) => entry.nid)
  })
  return childrenByParent
}

// Walk a parent plugin-id chain upward until a link that resolves to a page in
// the pages set is found; views/system/external parents (no nid) are skipped
// so their children promote to the nearest resolvable ancestor.
function resolveAncestorNid(parentPluginId, itemByPluginId, pageSet, maxHops = 20) {
  let hops = 0
  let current = parentPluginId
  while (current && current !== '' && hops < maxHops) {
    hops += 1
    const parentItem = itemByPluginId[current]
    if (!parentItem) {
      return 0
    }
    if (parentItem.nid > 0 && pageSet[parentItem.nid]) {
      return parentItem.nid
    }
    current = parentItem.parentPluginId
  }
  return 0
}

// menu link plugin ids like `menu_link_content:<uuid>` reduce to `<uuid>` so
// parent references and item ids share one id space
function normalizeMenuItem(raw, aliasMap) {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const attrs = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : raw
  const pluginId = parsePluginIdValue(
    typeof raw.id === 'string' ? raw.id : (typeof attrs.id === 'string' ? attrs.id : '')
  )
  const parentPluginId = parsePluginIdValue(typeof attrs.parent === 'string' ? attrs.parent : '')
  const weight = normalizeNumeric(attrs.weight, 0)
  const url = typeof attrs.url === 'string' ? attrs.url : ''
  const route = attrs.route && typeof attrs.route === 'object' ? attrs.route : null
  let nid = 0
  if (
    route &&
    route.name === 'entity.node.canonical' &&
    route.parameters &&
    typeof route.parameters === 'object'
  ) {
    nid = normalizeNumeric(route.parameters.node, 0)
  }
  if (!nid && url !== '') {
    nid = parseNodeIdFromMenuUri(url)
  }
  if (!nid && url !== '' && aliasMap[url]) {
    nid = aliasMap[url]
  }
  let children = null
  if (Array.isArray(attrs.children)) {
    children = attrs.children
  } else if (Array.isArray(raw.children)) {
    children = raw.children
  }
  const normalized = {
    pluginId: pluginId,
    parentPluginId: parentPluginId,
    weight: weight,
    title: typeof attrs.title === 'string' ? attrs.title : '',
    url: url,
    nid: nid,
    children: null
  }
  if (children !== null) {
    normalized.children = children
      .map((child) => normalizeMenuItem(child, aliasMap))
      .filter((child) => child !== null)
  }
  return normalized
}

function walkMenuItemTree(items, parentNid, pageSet, relationByNid) {
  items.forEach((item) => {
    if (item.nid > 0 && pageSet[item.nid]) {
      addRelation(relationByNid, item.nid, parentNid, item.weight)
    }
    const nextParentNid = item.nid > 0 && pageSet[item.nid] ? item.nid : parentNid
    if (item.children !== null && item.children.length > 0) {
      walkMenuItemTree(item.children, nextParentNid, pageSet, relationByNid)
    }
  })
}

// Accepts jsonapi_menu_items-style flat collections (parent plugin ids) and
// jsonapi_frontend_menu-style nested children payloads alike.
function forestFromMenuItems(rawItems, pageSet, aliasMap) {
  const items = rawItems
    .map((raw) => normalizeMenuItem(raw, aliasMap))
    .filter((item) => item !== null)
  if (items.length === 0) {
    return null
  }
  const itemByPluginId = {}
  items.forEach((item) => {
    if (item.pluginId !== '') {
      itemByPluginId[item.pluginId] = item
    }
  })
  const relationByNid = {}
  const hasChildren = items.some((item) => item.children !== null && item.children.length > 0)
  if (hasChildren) {
    walkMenuItemTree(items, 0, pageSet, relationByNid)
  } else {
    items.forEach((item) => {
      if (!(item.nid > 0) || !pageSet[item.nid]) {
        return
      }
      const parentNid = resolveAncestorNid(item.parentPluginId, itemByPluginId, pageSet)
      addRelation(relationByNid, item.nid, parentNid, item.weight)
    })
  }
  if (Object.keys(relationByNid).length === 0) {
    return null
  }
  return {
    childrenByParent: childrenByParentFromRelations(relationByNid),
    source: 'menu-items'
  }
}

function extractMenuItemsList(payload) {
  if (Array.isArray(payload)) {
    return payload
  }
  if (payload && Array.isArray(payload.data)) {
    return payload.data
  }
  if (payload && Array.isArray(payload.items)) {
    return payload.items
  }
  return null
}

function buildMenuNameCandidates(menuRecords) {
  const names = ['main']
  const seen = { main: true }
  if (Array.isArray(menuRecords)) {
    menuRecords.forEach((record) => {
      if (!record || !record.attributes) {
        return
      }
      let name = record.attributes.drupal_internal__id
      if (typeof name !== 'string' || name === '') {
        name = typeof record.id === 'string' ? record.id : ''
      }
      if (typeof name !== 'string' || name === '') {
        return
      }
      name = name.trim()
      if (seen[name] || MENU_NAME_DENYLIST[name]) {
        return
      }
      seen[name] = true
      names.push(name)
    })
  }
  return names
}

// Probe the menu-item endpoint variants per candidate menu; the first menu
// that yields page-linked items wins. Probes 404 cheaply when the module is
// not installed (grovecenter-style sites) and fall through to
// menu_link_content records.
async function fetchMenuItemsForest(base, menuRecords, pageSet, aliasMap) {
  const menuNames = buildMenuNameCandidates(menuRecords)
  for (const menuName of menuNames) {
    for (const endpointPath of MENU_ITEM_ENDPOINT_PATHS) {
      const payload = await fetchJSON(`${base}${endpointPath}${encodeURIComponent(menuName)}`)
      const rawItems = extractMenuItemsList(payload)
      if (rawItems === null) {
        continue
      }
      const forest = forestFromMenuItems(rawItems, pageSet, aliasMap)
      // a valid payload means this module serves this menu; other endpoint
      // patterns for the same menu are pointless even when nothing linked
      if (forest) {
        return forest
      }
      break
    }
  }
  return null
}

// menu_link_content records -> forest. All top-level links of the preferred
// menu become top-level outline items; pages linked only in other menus are
// appended after them so no menu-linked page drops out of the outline.
function extractForestFromMenuLinks(pageSet, menuLinkRecords) {
  if (!Array.isArray(menuLinkRecords) || menuLinkRecords.length === 0) {
    return null
  }
  const groups = {}
  menuLinkRecords.forEach((record) => {
    if (!record || !record.attributes) {
      return
    }
    const attrs = record.attributes
    const menuName =
      typeof attrs.menu_name === 'string' && attrs.menu_name.trim() !== ''
        ? attrs.menu_name.trim()
        : '__default__'
    const targetNid =
      attrs.link && typeof attrs.link === 'object' && attrs.link.uri
        ? parseNodeIdFromMenuUri(attrs.link.uri)
        : 0
    if (!groups[menuName]) {
      groups[menuName] = []
    }
    groups[menuName].push({
      record: record,
      nid: targetNid,
      weight: normalizeNumeric(attrs.weight, 0),
      parentPluginId: parseParentLinkId(record)
    })
  })
  const menuNames = Object.keys(groups)
  if (menuNames.length === 0) {
    return null
  }
  let selected = null
  if (groups.main && groups.main.some((entry) => entry.nid > 0 && pageSet[entry.nid])) {
    selected = 'main'
  } else {
    let bestCount = 0
    menuNames.forEach((name) => {
      const count = groups[name].filter((entry) => entry.nid > 0 && pageSet[entry.nid]).length
      if (count > bestCount) {
        bestCount = count
        selected = name
      }
    })
  }
  if (!selected) {
    return null
  }
  const selectedEntries = groups[selected]
  const entryByPluginId = {}
  selectedEntries.forEach((entry) => {
    if (entry.record && entry.record.id) {
      entryByPluginId[`${entry.record.id}`] = entry
    }
  })
  const relationByNid = {}
  selectedEntries.forEach((entry) => {
    if (!(entry.nid > 0) || !pageSet[entry.nid]) {
      return
    }
    const parentNid = resolveAncestorNid(entry.parentPluginId, entryByPluginId, pageSet)
    addRelation(relationByNid, entry.nid, parentNid, entry.weight)
  })
  if (Object.keys(relationByNid).length === 0) {
    return null
  }
  const childrenByParent = childrenByParentFromRelations(relationByNid)
  // pages linked in non-selected menus, not already in the forest, append as
  // top-level items ordered by their own menu weight
  const otherMenuEntries = []
  const seen = {}
  menuNames.forEach((name) => {
    if (name === selected) {
      return
    }
    groups[name].forEach((entry) => {
      if (
        !(entry.nid > 0) ||
        !pageSet[entry.nid] ||
        relationByNid[entry.nid] ||
        seen[entry.nid]
      ) {
        return
      }
      seen[entry.nid] = true
      otherMenuEntries.push(entry)
    })
  })
  if (otherMenuEntries.length > 0) {
    const ordered = otherMenuEntries
      .sort((a, b) => {
        if (a.weight !== b.weight) {
          return a.weight - b.weight
        }
        return a.nid - b.nid
      })
      .map((entry) => entry.nid)
    if (!childrenByParent[0]) {
      childrenByParent[0] = []
    }
    childrenByParent[0] = childrenByParent[0].concat(ordered)
  }
  return {
    childrenByParent: childrenByParent,
    source: 'menu-link-content'
  }
}

// node--book book fields -> forest (book sites without menu links)
function extractForestFromBookFields(bookRecords, pageSet) {
  if (!Array.isArray(bookRecords) || bookRecords.length === 0) {
    return null
  }
  const relationByNid = {}
  bookRecords.forEach((record) => {
    if (!record || !record.attributes) {
      return
    }
    const attrs = record.attributes
    const nid = getDrupalNodeNid(record)
    if (!nid || !pageSet[nid]) {
      return
    }
    if (attrs.book && typeof attrs.book === 'object') {
      const parentNid = normalizeNumeric(attrs.book.pid || attrs.book.parent || attrs.book.parent_nid, 0)
      const weight = normalizeNumeric(attrs.book.weight || attrs.book.menu_order, 0)
      addRelation(relationByNid, nid, pageSet[parentNid] ? parentNid : 0, weight)
      return
    }
    const directParent = normalizeNumeric(
      attrs.book_parent ||
        attrs.book_parent_id ||
        attrs.book_parent_nid ||
        attrs.field_book_parent ||
        attrs.field_book_parent_nid,
      0
    )
    const directWeight = normalizeNumeric(attrs.book_weight || attrs.book_order, 0)
    if (directParent || attrs.book_parent === 0 || attrs.book_parent_id === 0) {
      addRelation(relationByNid, nid, pageSet[directParent] ? directParent : 0, directWeight)
    }
  })
  if (Object.keys(relationByNid).length === 0) {
    return null
  }
  return {
    childrenByParent: childrenByParentFromRelations(relationByNid),
    source: 'book-fields'
  }
}

function flatForest(recordsByNid) {
  const sorted = sortNodeRecordsByCreated(
    Object.keys(recordsByNid).map((nidKey) => recordsByNid[nidKey])
  )
  return {
    childrenByParent: { 0: sorted.map((record) => getDrupalNodeNid(record)) },
    source: 'flat'
  }
}

// ---- outline assembly ----

// A top-level node with completely empty content (no body, no media) that has
// children is structural: its children are promoted instead.
function expandTopNids(topNids, childrenByParent, getContent, dropped) {
  const expanded = []
  topNids.forEach((nid) => {
    const childNids = childrenByParent[nid] ? childrenByParent[nid] : []
    if (getContent(nid) === '<p></p>' && childNids.length > 0) {
      dropped[nid] = true
      expandTopNids(childNids, childrenByParent, getContent, dropped).forEach((childNid) => {
        expanded.push(childNid)
      })
      return
    }
    expanded.push(nid)
  })
  return expanded
}

function walkOutlineLevel(nids, parentItem, slugPrefix, indent, ctx) {
  const siblingMap = {}
  let order = 0
  nids.forEach((nid) => {
    const record = ctx.recordsByNid[nid]
    if (!record) {
      return
    }
    const segment = uniqueSegment(getNodeSegment(record), siblingMap, nid)
    const item = new JSONOutlineSchemaItem()
    item.title = getDrupalNodeTitle(record)
    item.slug = slugPrefix !== '' ? `${slugPrefix}/${segment}` : segment
    item.order = order
    item.indent = indent
    item.parent = parentItem ? parentItem.id : ctx.configuredParent
    item.contents = ctx.getContent(nid)
    item.metadata = formatDrupalNodeMetadata(record, 'drupal-node', ctx.base, { inOutline: true })
    ctx.items.push(item)
    ctx.consumed[nid] = true
    order += 1
    const childNids = ctx.childrenByParent[nid] ? ctx.childrenByParent[nid] : []
    walkOutlineLevel(childNids, item, item.slug, indent + 1, ctx)
  })
}

// ---- main import flow ----

async function importDrupalSite(repoUrl, settings = {}) {
  const discovered = await discoverDrupalJsonApiBase(repoUrl)
  if (!discovered || !discovered.base) {
    return {
      error:
        'Unable to discover Drupal JSON:API from `repoUrl`; expected `<base>/jsonapi`'
    }
  }
  const links = getDiscoveryLinks(discovered.discovery)
  const nodeLinks = getNodeCollectionLinks(links)
  const pageHref = nodeLinks['node--page'] ? nodeLinks['node--page'] : null
  const bookHref = nodeLinks['node--book'] ? nodeLinks['node--book'] : null
  if (!pageHref && !bookHref) {
    const exposed = Object.keys(nodeLinks)
    return {
      error:
        'Drupal JSON:API discovered but neither `node--page` nor `node--book` collections were exposed' +
        (exposed.length > 0 ? ` (found: ${exposed.join(', ')})` : '')
    }
  }

  const pageRecords = pageHref ? await fetchDrupalCollectionByHref(pageHref, 50, 200) : []
  const bookRecords = bookHref ? await fetchDrupalCollectionByHref(bookHref, 50, 200) : []

  // pages set: node--page plus node--book, first record wins per nid
  const recordsByNid = {}
  let pagesTotal = 0
  let booksTotal = 0
  const addRecords = (records) => {
    if (!Array.isArray(records)) {
      return
    }
    records.forEach((record) => {
      const nid = getDrupalNodeNid(record)
      if (!(nid > 0) || recordsByNid[nid]) {
        return
      }
      recordsByNid[nid] = record
      if (record.type === 'node--book') {
        booksTotal += 1
      } else {
        pagesTotal += 1
      }
    })
  }
  addRecords(pageRecords)
  addRecords(bookRecords)

  const pageNids = Object.keys(recordsByNid).map((nidKey) => normalizeNumeric(nidKey, 0))
  if (pageNids.length === 0) {
    return {
      error:
        'Drupal JSON:API is available but neither `node--page` nor `node--book` has accessible records'
    }
  }
  const pageSet = {}
  pageNids.forEach((nid) => {
    pageSet[nid] = true
  })

  // files
  const fileHref =
    links['file--file'] && links['file--file'].href ? links['file--file'].href : null
  const fileRecords = fileHref ? await fetchDrupalCollectionByHref(fileHref, 50, 400) : []
  const fileMap = buildDrupalFileMap(fileRecords, discovered.base)

  // media (every exposed media bundle)
  const mediaRecords = []
  for (const linkKey of Object.keys(links)) {
    if (linkKey.indexOf('media--') !== 0) {
      continue
    }
    const linkDef = links[linkKey]
    if (!linkDef || typeof linkDef !== 'object' || !linkDef.href) {
      continue
    }
    const records = await fetchDrupalCollectionByHref(linkDef.href, 50, 200)
    if (Array.isArray(records)) {
      records.forEach((record) => {
        mediaRecords.push(record)
      })
    }
  }
  const mediaMap = buildMediaMap(mediaRecords, fileMap)

  // menu link content records + menu machine names
  const menuLinkHref = getMenuLinkContentHref(links)
  const menuLinkRecords = menuLinkHref ? await fetchDrupalCollectionByHref(menuLinkHref, 100, 200) : []
  const menuRecords =
    links['menu--menu'] && links['menu--menu'].href
      ? await fetchDrupalCollectionByHref(links['menu--menu'].href, 50, 20)
      : []

  // page path aliases -> nid for menu item url fallback resolution
  const aliasMap = {}
  pageNids.forEach((nid) => {
    const record = recordsByNid[nid]
    const alias =
      record &&
      record.attributes &&
      record.attributes.path &&
      typeof record.attributes.path === 'object' &&
      typeof record.attributes.path.alias === 'string'
        ? record.attributes.path.alias
        : ''
    if (alias !== '' && !aliasMap[alias]) {
      aliasMap[alias] = nid
    }
  })

  // content cache so structural checks and outline building share work
  const contentByNid = {}
  const getContent = (nid) => {
    if (contentByNid[nid] === undefined) {
      const record = recordsByNid[nid]
      contentByNid[nid] = record
        ? buildPageContent(record, discovered.base, mediaMap.mediaByUuid, fileMap)
        : '<p></p>'
    }
    return contentByNid[nid]
  }

  // hierarchy: menu-items endpoint -> menu_link_content forest -> book fields -> flat
  let forest = await fetchMenuItemsForest(discovered.base, menuRecords, pageSet, aliasMap)
  if (!forest) {
    forest = extractForestFromMenuLinks(pageSet, menuLinkRecords)
  }
  if (!forest) {
    forest = extractForestFromBookFields(bookRecords, pageSet)
  }
  if (!forest) {
    forest = flatForest(recordsByNid)
  }

  const configuredParent =
    settings.parentId && settings.parentId !== 'null' ? settings.parentId : null
  const items = []
  const consumed = {}
  const dropped = {}
  const ctx = {
    recordsByNid,
    childrenByParent: forest.childrenByParent,
    configuredParent,
    base: discovered.base,
    items,
    consumed,
    getContent
  }

  const topNids = expandTopNids(
    forest.childrenByParent[0] ? forest.childrenByParent[0] : [],
    forest.childrenByParent,
    getContent,
    dropped
  )
  walkOutlineLevel(topNids, null, '', 0, ctx)
  const outlineNodes = items.length

  // pages that made no outline land under a hidden additional-pages group
  const additionalRecords = sortNodeRecords(
    Object.keys(recordsByNid)
      .map((nidKey) => recordsByNid[nidKey])
      .filter((record) => {
        const nid = getDrupalNodeNid(record)
        if (!(nid > 0) || consumed[nid] || dropped[nid]) {
          return false
        }
        return true
      })
  )

  if (additionalRecords.length > 0) {
    const topLevelCount = items.filter((item) => item.parent === configuredParent).length
    const topLevelSlugMap = {}
    items
      .filter((item) => item.parent === configuredParent)
      .forEach((item) => {
        topLevelSlugMap[item.slug] = true
      })
    const additionalSlug = uniqueSegment('additional-pages', topLevelSlugMap, 'group')
    const additionalParent = new JSONOutlineSchemaItem()
    additionalParent.title = 'additional pages'
    additionalParent.slug = additionalSlug
    additionalParent.order = topLevelCount
    additionalParent.indent = 0
    additionalParent.parent = configuredParent
    additionalParent.contents = '<p></p>'
    additionalParent.metadata = {
      hideInMenu: true,
      sourceType: 'drupal-additional-pages'
    }
    items.push(additionalParent)

    const siblingMap = {}
    additionalRecords.forEach((record, index) => {
      const nid = getDrupalNodeNid(record)
      const segment = uniqueSegment(getNodeSegment(record), siblingMap, nid)
      const item = new JSONOutlineSchemaItem()
      item.title = getDrupalNodeTitle(record)
      item.slug = `${additionalParent.slug}/${segment}`
      item.order = index
      item.indent = 1
      item.parent = additionalParent.id
      item.contents = getContent(nid)
      item.metadata = formatDrupalNodeMetadata(record, 'drupal-node', discovered.base, {
        inOutline: false
      })
      items.push(item)
      consumed[nid] = true
    })
  }

  return {
    items,
    files: fileMap.files,
    filename: getFilenameFromUrl(repoUrl),
    drupal: {
      base: discovered.base,
      pagesTotal: pagesTotal,
      booksTotal: booksTotal,
      outlineSource: forest.source,
      outlineNodes: outlineNodes,
      additionalNodes: additionalRecords.length,
      filesTotal: fileRecords.length,
      filesImported: Object.keys(fileMap.files).length,
      filesSkipped: fileMap.skipped,
      mediaTotal: mediaMap.stats.total,
      mediaResolved: mediaMap.stats.resolved,
      mediaUnresolved: mediaMap.stats.unresolved,
      truncated: fileMap.truncated
    }
  }
}

module.exports = { convertDrupalToSite, LIMITS }
