const { HAXCMS } = require('../../../../lib/HAXCMS.js')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { parse } = require('node-html-parser')

async function convertDrupalBookToSite(req, res) {
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
  if (normalizeBoolean(body.allowHtmlFallback)) {
    settings.allowHtmlFallback = true
  }

  const importedData = await importDrupalBookSite(body.repoUrl, settings)
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

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

async function fetchJSON(url, fetchOptions = {}) {
  try {
    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      return null
    }
    return await response.json()
  } catch (e) {
    return null
  }
}

async function fetchText(url, fetchOptions = {}) {
  try {
    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      return ''
    }
    return await response.text()
  } catch (e) {
    return ''
  }
}

function normalizeNumeric(value, fallback = 0) {
  const normalized = parseInt(value)
  if (Number.isNaN(normalized)) {
    return fallback
  }
  return normalized
}

function dedupeArray(values) {
  const deduped = []
  const seen = {}
  values.forEach((value) => {
    const key = `${value}`
    if (!seen[key]) {
      deduped.push(value)
      seen[key] = true
    }
  })
  return deduped
}

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

function getDrupalNodeContent(record, base) {
  if (!record || !record.attributes) {
    return '<p></p>'
  }
  const attrs = record.attributes
  let value = ''
  if (attrs.body && typeof attrs.body === 'object' && typeof attrs.body.value === 'string') {
    value = attrs.body.value
  } else if (typeof attrs.body === 'string') {
    value = attrs.body
  }
  if (!value || value.trim() === '') {
    return '<p></p>'
  }
  return absolutizeRootUrls(value, base)
}

function nodeTextContentLength(record) {
  const html = getDrupalNodeContent(record, 'https://example.com')
  if (!html || html === '<p></p>') {
    return 0
  }
  let text = ''
  try {
    text = parse(`<div>${html}</div>`).innerText
  } catch (e) {
    text = ''
  }
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
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

function extractMenuLinkedNodeIds(menuLinkRecords) {
  const linked = {}
  if (!Array.isArray(menuLinkRecords)) {
    return linked
  }
  menuLinkRecords.forEach((record) => {
    if (!record || !record.attributes) {
      return
    }
    const attrs = record.attributes
    if (!(attrs.link && typeof attrs.link === 'object' && attrs.link.uri)) {
      return
    }
    const nid = parseNodeIdFromMenuUri(attrs.link.uri)
    if (nid > 0) {
      linked[nid] = true
    }
  })
  return linked
}

function extractTreeFromMenuLinks(bookNids, menuLinkRecords) {
  if (!Array.isArray(menuLinkRecords) || menuLinkRecords.length === 0) {
    return null
  }
  const bookSet = {}
  bookNids.forEach((nid) => {
    bookSet[nid] = true
  })

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
    let targetNid = 0
    if (attrs.link && typeof attrs.link === 'object' && attrs.link.uri) {
      targetNid = parseNodeIdFromMenuUri(attrs.link.uri)
    }
    if (!targetNid || !bookSet[targetNid]) {
      return
    }
    if (!groups[menuName]) {
      groups[menuName] = []
    }
    groups[menuName].push({
      record,
      targetNid,
      weight: normalizeNumeric(attrs.weight, 0),
      parentLinkId: parseParentLinkId(record)
    })
  })

  const menuNames = Object.keys(groups)
  if (menuNames.length === 0) {
    return null
  }
  menuNames.sort((a, b) => groups[b].length - groups[a].length)
  const selectedMenu = menuNames[0]
  const selectedLinks = groups[selectedMenu]
  if (!selectedLinks || selectedLinks.length === 0) {
    return null
  }

  const linkById = {}
  selectedLinks.forEach((entry) => {
    if (entry.record && entry.record.id) {
      linkById[entry.record.id] = entry
    }
  })

  const relationByNid = {}
  selectedLinks.forEach((entry) => {
    const nid = entry.targetNid
    if (!relationByNid[nid]) {
      relationByNid[nid] = {
        parentNid: 0,
        weight: entry.weight
      }
    }
    if (entry.weight < relationByNid[nid].weight) {
      relationByNid[nid].weight = entry.weight
    }
    if (entry.parentLinkId && linkById[entry.parentLinkId]) {
      const parentNid = linkById[entry.parentLinkId].targetNid
      if (parentNid && parentNid !== nid) {
        relationByNid[nid].parentNid = parentNid
      }
    }
  })

  const childBuckets = {}
  Object.keys(relationByNid).forEach((nidKey) => {
    const nid = normalizeNumeric(nidKey, 0)
    const parentNid = relationByNid[nid].parentNid
    if (!childBuckets[parentNid]) {
      childBuckets[parentNid] = []
    }
    childBuckets[parentNid].push({
      nid,
      weight: relationByNid[nid].weight
    })
  })

  const topNodes = childBuckets[0] ? childBuckets[0] : []
  if (topNodes.length === 0) {
    return null
  }

  function descendantsCount(startNid) {
    let count = 0
    const visited = {}
    function walk(parentNid) {
      const children = childBuckets[parentNid] ? childBuckets[parentNid] : []
      children.forEach((entry) => {
        if (visited[entry.nid]) {
          return
        }
        visited[entry.nid] = true
        count += 1
        walk(entry.nid)
      })
    }
    walk(startNid)
    return count
  }

  const sortedTopNodes = [...topNodes].sort((a, b) => {
    const aDesc = descendantsCount(a.nid)
    const bDesc = descendantsCount(b.nid)
    if (bDesc !== aDesc) {
      return bDesc - aDesc
    }
    if (a.weight !== b.weight) {
      return a.weight - b.weight
    }
    return a.nid - b.nid
  })
  const rootNid = sortedTopNodes[0].nid

  const childrenByParent = {}
  Object.keys(childBuckets).forEach((parentKey) => {
    const parentNid = normalizeNumeric(parentKey, 0)
    const ordered = [...childBuckets[parentNid]].sort((a, b) => {
      if (a.weight !== b.weight) {
        return a.weight - b.weight
      }
      return a.nid - b.nid
    })
    childrenByParent[parentNid] = ordered.map((entry) => entry.nid)
  })

  return {
    rootNid,
    childrenByParent,
    source: 'menu-link-content'
  }
}

function extractTreeFromBookFieldPayload(bookRecords) {
  const relationByNid = {}
  bookRecords.forEach((record) => {
    if (!record || !record.attributes) {
      return
    }
    const attrs = record.attributes
    const nid = getDrupalNodeNid(record)
    if (!nid) {
      return
    }

    if (attrs.book && typeof attrs.book === 'object') {
      const parentNid = normalizeNumeric(
        attrs.book.pid || attrs.book.parent || attrs.book.parent_nid,
        0
      )
      const weight = normalizeNumeric(attrs.book.weight || attrs.book.menu_order, 0)
      relationByNid[nid] = {
        parentNid,
        weight
      }
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
      relationByNid[nid] = {
        parentNid: directParent,
        weight: directWeight
      }
    }
  })

  const relationKeys = Object.keys(relationByNid)
  if (relationKeys.length === 0) {
    return null
  }

  const childBuckets = {}
  relationKeys.forEach((nidKey) => {
    const nid = normalizeNumeric(nidKey, 0)
    const parentNid = relationByNid[nid].parentNid
    if (!childBuckets[parentNid]) {
      childBuckets[parentNid] = []
    }
    childBuckets[parentNid].push({
      nid,
      weight: relationByNid[nid].weight
    })
  })

  const topNodes = childBuckets[0] ? childBuckets[0] : []
  if (topNodes.length === 0) {
    return null
  }

  const sortedTop = [...topNodes].sort((a, b) => {
    if (a.weight !== b.weight) {
      return a.weight - b.weight
    }
    return a.nid - b.nid
  })
  const rootNid = sortedTop[0].nid
  const childrenByParent = {}
  Object.keys(childBuckets).forEach((parentKey) => {
    const parentNid = normalizeNumeric(parentKey, 0)
    const ordered = [...childBuckets[parentNid]].sort((a, b) => {
      if (a.weight !== b.weight) {
        return a.weight - b.weight
      }
      return a.nid - b.nid
    })
    childrenByParent[parentNid] = ordered.map((entry) => entry.nid)
  })

  return {
    rootNid,
    childrenByParent,
    source: 'book-fields'
  }
}

function extractNodeIdFromHref(href) {
  if (!href || typeof href !== 'string') {
    return 0
  }
  const match = href.match(/\/node\/(\d+)/i)
  if (!match || !match[1]) {
    return 0
  }
  return normalizeNumeric(match[1], 0)
}

function extractNodeIdsFromFragment(fragment) {
  if (!fragment || typeof fragment !== 'string') {
    return []
  }
  const matches = fragment.match(/href="[^"]*\/node\/\d+[^"]*"/gi) || []
  const ids = matches
    .map((line) => extractNodeIdFromHref(line))
    .filter((id) => id > 0)
  return dedupeArray(ids)
}

function extractNavBlockByClass(html, className) {
  if (!html || typeof html !== 'string') {
    return ''
  }
  const navRegex = new RegExp(`<nav\\b[^>]*class="[^"]*${className}[^"]*"[^>]*>`, 'i')
  const openMatch = navRegex.exec(html)
  if (!openMatch) {
    return ''
  }
  const startIndex = openMatch.index
  const sub = html.substring(startIndex)
  const tagRegex = /<(\/?)nav\b[^>]*>/gi
  let level = 0
  let match = tagRegex.exec(sub)
  while (match) {
    if (match[1] === '/') {
      level -= 1
      if (level === 0) {
        return sub.substring(0, match.index + match[0].length)
      }
    } else {
      level += 1
    }
    match = tagRegex.exec(sub)
  }
  return sub
}

async function getDrupalBookNavigation(base, nid) {
  const html = await fetchText(`${base}/node/${nid}`, {
    headers: {
      Accept: 'text/html'
    }
  })
  let rootNid = 0
  let upNid = 0
  let menuChildren = []

  let rootMatch = html.match(/id="book-navigation-(\d+)"/i)
  if (!rootMatch || !rootMatch[1]) {
    rootMatch = html.match(/id="book-block-menu-(\d+)"/i)
  }
  if (rootMatch && rootMatch[1]) {
    rootNid = normalizeNumeric(rootMatch[1], 0)
  }

  const traversalNav = extractNavBlockByClass(html, 'book-navigation')
  if (traversalNav !== '') {
    const upMatch = traversalNav.match(
      /book-pager__item--center[^>]*>\s*<a[^>]+href="([^"]+)"/i
    )
    if (upMatch && upMatch[1]) {
      upNid = extractNodeIdFromHref(upMatch[1])
    }
    const menuMatch = traversalNav.match(/<ul class="menu">([\s\S]*?)<\/ul>/i)
    if (menuMatch && menuMatch[1]) {
      menuChildren = extractNodeIdsFromFragment(menuMatch[1])
    }
  }

  return {
    rootNid,
    upNid,
    menuChildren
  }
}

function selectHtmlFallbackRoot(bookNids, navByNid) {
  const rootCounts = {}
  bookNids.forEach((nid) => {
    const nav = navByNid[nid] ? navByNid[nid] : null
    const rootNid = nav && nav.rootNid ? nav.rootNid : 0
    if (rootNid > 0) {
      if (!rootCounts[rootNid]) {
        rootCounts[rootNid] = 0
      }
      rootCounts[rootNid] += 1
    }
  })
  const roots = Object.keys(rootCounts).map((value) => normalizeNumeric(value, 0))
  if (roots.length === 0) {
    return bookNids.length > 0 ? bookNids[0] : 0
  }
  roots.sort((a, b) => {
    if (rootCounts[b] !== rootCounts[a]) {
      return rootCounts[b] - rootCounts[a]
    }
    return a - b
  })
  return roots[0]
}

async function extractTreeFromHtmlNavigation(base, bookNids) {
  const navByNid = {}
  for await (const nid of bookNids) {
    navByNid[nid] = await getDrupalBookNavigation(base, nid)
  }
  const rootNid = selectHtmlFallbackRoot(bookNids, navByNid)
  if (!rootNid) {
    return null
  }
  const selectedBookNids = dedupeArray(
    bookNids.filter((nid) => {
      const nav = navByNid[nid] ? navByNid[nid] : null
      return (nav && nav.rootNid === rootNid) || nid === rootNid
    })
  )

  const childrenByParent = {}
  const upByNid = {}
  selectedBookNids.forEach((nid) => {
    const nav = navByNid[nid] ? navByNid[nid] : null
    if (nav && nav.upNid && selectedBookNids.includes(nav.upNid)) {
      upByNid[nid] = nav.upNid
    }
  })
  Object.keys(upByNid).forEach((childKey) => {
    const childNid = normalizeNumeric(childKey, 0)
    const parentNid = upByNid[childNid]
    if (!childrenByParent[parentNid]) {
      childrenByParent[parentNid] = []
    }
    childrenByParent[parentNid].push(childNid)
  })
  selectedBookNids.forEach((parentNid) => {
    const nav = navByNid[parentNid] ? navByNid[parentNid] : null
    const menuChildren = nav && Array.isArray(nav.menuChildren) ? nav.menuChildren : []
    if (!childrenByParent[parentNid]) {
      childrenByParent[parentNid] = []
    }
    menuChildren.forEach((nid) => {
      if (
        selectedBookNids.includes(nid) &&
        nid !== parentNid &&
        !childrenByParent[parentNid].includes(nid)
      ) {
        childrenByParent[parentNid].push(nid)
      }
    })
  })

  return {
    rootNid,
    childrenByParent,
    source: 'html-navigation'
  }
}

function getFilenameFromUrl(repoUrl, rootRecord) {
  let filename = ''
  try {
    const parsed = new URL(repoUrl)
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    if (pathParts.length > 0) {
      filename = HAXCMS.cleanTitle(pathParts[pathParts.length - 1], false)
    }
  } catch (e) {
    filename = ''
  }
  if (!filename || filename === '') {
    filename = HAXCMS.cleanTitle(getDrupalNodeTitle(rootRecord), false)
  }
  if (!filename || filename === '') {
    filename = 'drupal-book-import'
  }
  return filename
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

function reachableTreeNids(rootNid, childrenByParent) {
  const ordered = []
  const visited = {}
  if (!rootNid) {
    return ordered
  }
  ordered.push(rootNid)
  visited[rootNid] = true
  function walk(parentNid) {
    const children = childrenByParent[parentNid] ? childrenByParent[parentNid] : []
    children.forEach((childNid) => {
      if (visited[childNid]) {
        return
      }
      visited[childNid] = true
      ordered.push(childNid)
      walk(childNid)
    })
  }
  walk(rootNid)
  return ordered
}

async function importDrupalBookSite(repoUrl, settings = {}) {
  const discovered = await discoverDrupalJsonApiBase(repoUrl)
  if (!discovered || !discovered.base) {
    return {
      error:
        'Unable to discover Drupal JSON:API from `repoUrl`; expected `<base>/jsonapi`'
    }
  }
  const links = getDiscoveryLinks(discovered.discovery)
  const nodeLinks = getNodeCollectionLinks(links)
  const nodeTypeKeys = Object.keys(nodeLinks)
  if (nodeTypeKeys.length === 0) {
    return {
      error: 'Drupal JSON:API discovered but no public `node--*` collections were exposed'
    }
  }

  const allNodeRecordsByNid = {}
  const recordsByType = {}
  for await (const typeKey of nodeTypeKeys) {
    const records = await fetchDrupalCollectionByHref(nodeLinks[typeKey], 50, 200)
    recordsByType[typeKey] = records
    records.forEach((record) => {
      const nid = getDrupalNodeNid(record)
      if (nid > 0 && !allNodeRecordsByNid[nid]) {
        allNodeRecordsByNid[nid] = record
      }
    })
  }

  const bookRecords = recordsByType['node--book'] ? recordsByType['node--book'] : []
  const bookNids = dedupeArray(
    bookRecords.map((record) => getDrupalNodeNid(record)).filter((nid) => nid > 0)
  )
  if (bookNids.length === 0) {
    return {
      error: 'Drupal JSON:API is available but `node--book` has no accessible records'
    }
  }

  let tree = null
  let menuLinkRecords = []
  let menuLinkedNids = {}
  const menuLinkHref = getMenuLinkContentHref(links)
  if (menuLinkHref) {
    menuLinkRecords = await fetchDrupalCollectionByHref(menuLinkHref, 100, 200)
    menuLinkedNids = extractMenuLinkedNodeIds(menuLinkRecords)
    tree = extractTreeFromMenuLinks(bookNids, menuLinkRecords)
  }
  if (!tree) {
    tree = extractTreeFromBookFieldPayload(bookRecords)
  }
  if (!tree && normalizeBoolean(settings.allowHtmlFallback)) {
    tree = await extractTreeFromHtmlNavigation(discovered.base, bookNids)
  }
  if (!tree || !tree.rootNid) {
    return {
      error:
        'Unable to derive a Drupal book tree from public endpoints. Enable menu link JSON exposure (for example `menu_link_content`) or rerun with `allowHtmlFallback=true`.'
    }
  }

  const rootRecord = allNodeRecordsByNid[tree.rootNid]
  if (!rootRecord) {
    return {
      error: 'Resolved Drupal book root is not accessible as a public node record'
    }
  }

  const configuredParent =
    settings.parentId && settings.parentId !== 'null' ? settings.parentId : null
  const rootIsStructural = nodeTextContentLength(rootRecord) <= 24
  const treeNids = reachableTreeNids(tree.rootNid, tree.childrenByParent)
  const treeSet = {}
  treeNids.forEach((nid) => {
    treeSet[nid] = true
  })
  const consumedNids = {}
  consumedNids[tree.rootNid] = true

  const items = []

  function createTreeItem(record, parentItemId, order, indent, parentSlug, siblingMap, extraMetadata = {}) {
    const nid = getDrupalNodeNid(record)
    const segment = uniqueSegment(getNodeSegment(record), siblingMap, nid)
    const item = new JSONOutlineSchemaItem()
    item.title = getDrupalNodeTitle(record)
    item.slug = parentSlug !== '' ? `${parentSlug}/${segment}` : segment
    item.order = order
    item.indent = indent
    item.parent = parentItemId
    item.contents = getDrupalNodeContent(record, discovered.base)
    item.metadata = formatDrupalNodeMetadata(record, 'drupal-node', discovered.base, extraMetadata)
    items.push(item)
    consumedNids[nid] = true
    return item
  }

  function buildChildren(parentNid, parentItem, parentSlug) {
    const childNids = tree.childrenByParent[parentNid]
      ? tree.childrenByParent[parentNid]
      : []
    const siblingMap = {}
    let order = 0
    childNids.forEach((childNid) => {
      if (!treeSet[childNid]) {
        return
      }
      const childRecord = allNodeRecordsByNid[childNid]
      if (!childRecord) {
        return
      }
      const childItem = createTreeItem(
        childRecord,
        parentItem ? parentItem.id : configuredParent,
        order,
        parentItem ? parentItem.indent + 1 : 0,
        parentSlug,
        siblingMap,
        { rootNid: tree.rootNid, inOutline: true }
      )
      order += 1
      buildChildren(childNid, childItem, childItem.slug)
    })
  }

  if (!rootIsStructural) {
    const topLevelMap = {}
    const rootItem = createTreeItem(
      rootRecord,
      configuredParent,
      0,
      0,
      '',
      topLevelMap,
      { rootNid: tree.rootNid, inOutline: true, isBookRoot: true }
    )
    buildChildren(tree.rootNid, rootItem, rootItem.slug)
  } else {
    const topChildNids = tree.childrenByParent[tree.rootNid]
      ? tree.childrenByParent[tree.rootNid]
      : []
    const topLevelMap = {}
    let order = 0
    topChildNids.forEach((childNid) => {
      if (!treeSet[childNid]) {
        return
      }
      const childRecord = allNodeRecordsByNid[childNid]
      if (!childRecord) {
        return
      }
      const childItem = createTreeItem(
        childRecord,
        configuredParent,
        order,
        0,
        '',
        topLevelMap,
        { rootNid: tree.rootNid, inOutline: true }
      )
      order += 1
      buildChildren(childNid, childItem, childItem.slug)
    })
  }

  const additionalRecords = sortNodeRecords(
    Object.keys(allNodeRecordsByNid)
      .map((nidKey) => allNodeRecordsByNid[nidKey])
      .filter((record) => {
        const nid = getDrupalNodeNid(record)
        if (!(nid > 0) || consumedNids[nid]) {
          return false
        }
        if (menuLinkRecords.length > 0 && menuLinkedNids[nid]) {
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
      item.contents = getDrupalNodeContent(record, discovered.base)
      item.metadata = formatDrupalNodeMetadata(record, 'drupal-node', discovered.base, {
        rootNid: tree.rootNid,
        inOutline: false
      })
      items.push(item)
      consumedNids[nid] = true
    })
  }

  return {
    items,
    files: {},
    filename: getFilenameFromUrl(repoUrl, rootRecord),
    drupal: {
      base: discovered.base,
      rootNid: tree.rootNid,
      rootStructural: rootIsStructural,
      treeSource: tree.source,
      totalNodes: Object.keys(allNodeRecordsByNid).length,
      bookNodes: bookNids.length,
      outlineNodes: treeNids.length,
      additionalNodes: additionalRecords.length,
      htmlFallbackUsed: tree.source === 'html-navigation'
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

module.exports = { convertDrupalBookToSite }
