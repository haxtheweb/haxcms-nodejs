const { parse } = require('node-html-parser')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { HAXCMS } = require('../../../../lib/HAXCMS.js')

// ---- inlined wordpressSiteHelpers ----

async function fetchJSON(url, fetchOptions = {}) {
  try {
    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      return null
    }
    return await response.json()
  }
  catch (e) {
    return null
  }
}

async function fetchText(url, fetchOptions = {}) {
  try {
    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      return null
    }
    return await response.text()
  }
  catch (e) {
    return null
  }
}

async function fetchJSONWithMeta(url, fetchOptions = {}) {
  try {
    const response = await fetch(url, fetchOptions)
    let data = null
    try {
      data = await response.json()
    }
    catch (e) {
      data = null
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      data: data
    }
  }
  catch (e) {
    return {
      ok: false,
      status: 0,
      headers: null,
      data: null
    }
  }
}

function absolutizeRootUrls(content, base) {
  let origin = ''
  try {
    const parsed = new URL(base)
    origin = `${parsed.protocol}//${parsed.host}`
  }
  catch (e) {
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

function buildWordPressBaseCandidates(inputUrl, stopSegments = []) {
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
  }
  catch (e) {
    return []
  }
  return candidates
}

function hasNamespace(payload, namespaceName) {
  if (!payload || !Array.isArray(payload.namespaces)) {
    return false
  }
  return payload.namespaces.includes(namespaceName)
}

async function discoverWordPressBase(inputUrl) {
  const candidates = buildWordPressBaseCandidates(inputUrl, [
    'wp-json',
    'wp-admin',
    'wp-login.php',
    'front-matter',
    'chapter',
    'back-matter',
    'part',
    'toc'
  ])
  for (const candidate of candidates) {
    const payload = await fetchJSON(`${candidate}/wp-json/`)
    if (hasNamespace(payload, 'wp/v2')) {
      return {
        base: candidate,
        root: payload
      }
    }
  }
  return null
}

async function fetchWordPressCollection(base, route, fields = [], maxPages = 25, perPage = 100) {
  let page = 1
  let items = []
  while (page <= maxPages) {
    let url = `${base}/wp-json/wp/v2/${route}?per_page=${perPage}&page=${page}`
    if (fields.length > 0) {
      url += `&_fields=${fields.join(',')}`
    }
    const response = await fetchJSONWithMeta(url)
    if (!response.ok) {
      return {
        items: items,
        status: response.status,
        error: response.data,
        complete: false
      }
    }
    if (!Array.isArray(response.data) || response.data.length === 0) {
      return {
        items: items,
        status: response.status,
        error: null,
        complete: true
      }
    }
    items = items.concat(response.data)
    let totalPages = 1
    if (response.headers && response.headers.get('x-wp-totalpages')) {
      totalPages = parseInt(response.headers.get('x-wp-totalpages'))
      if (Number.isNaN(totalPages) || totalPages < 1) {
        totalPages = 1
      }
    }
    if (page >= totalPages) {
      return {
        items: items,
        status: response.status,
        error: null,
        complete: true
      }
    }
    page += 1
  }
  return {
    items: items,
    status: 200,
    error: null,
    complete: false
  }
}

function renderedToText(value) {
  let text = ''
  if (typeof value === 'string') {
    text = value
  }
  else if (value && value.rendered) {
    text = value.rendered
  }
  else if (value && value.raw) {
    text = value.raw
  }
  if (text === '') {
    return ''
  }
  return parse(`<div>${text}</div>`).text.trim()
}

function valueToBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false
    }
  }
  return fallback
}

function valueToNumber(value, fallback = 0) {
  const normalized = parseInt(value)
  if (Number.isNaN(normalized)) {
    return fallback
  }
  return normalized
}

function renderedToHtml(value, settings = {}) {
  let rendered = ''
  let raw = ''
  if (typeof value === 'string') {
    rendered = value
    raw = value
  }
  else if (value && typeof value === 'object') {
    if (typeof value.rendered === 'string') {
      rendered = value.rendered
    }
    if (typeof value.raw === 'string') {
      raw = value.raw
    }
  }
  const contentMode = settings && settings.contentMode
    ? `${settings.contentMode}`.toLowerCase()
    : 'rendered'
  let html = ''
  let source = ''

  if (contentMode === 'raw') {
    if (raw !== '') {
      html = raw
      source = 'raw'
    }
    else if (rendered !== '') {
      html = rendered
      source = 'rendered'
    }
  }
  else if (contentMode === 'rendered-first') {
    if (rendered !== '') {
      html = rendered
      source = 'rendered'
    }
    else if (raw !== '') {
      html = raw
      source = 'raw'
    }
  }
  else {
    if (rendered !== '') {
      html = rendered
      source = 'rendered'
    }
  }

  const allowRawFallback = valueToBoolean(settings.allowRawFallback, false)
  if (html === '' && allowRawFallback && raw !== '') {
    html = raw
    source = 'raw'
  }

  return {
    html: html,
    source: source
  }
}

function analyzeWordPressTokens(content) {
  const html = typeof content === 'string' ? content : ''
  if (html === '') {
    return {
      tokenCount: 0,
      gutenbergCommentCount: 0,
      shortcodeCount: 0
    }
  }
  const gutenbergComments = html.match(/<!--\s*\/?wp:[\s\S]*?-->/g)
  const shortcodes = html.match(/\[(\/)?[a-zA-Z][\w-]*(?:[^\]]*)\]/g)
  const gutenbergCommentCount = gutenbergComments ? gutenbergComments.length : 0
  const shortcodeCount = shortcodes ? shortcodes.length : 0
  return {
    tokenCount: gutenbergCommentCount + shortcodeCount,
    gutenbergCommentCount: gutenbergCommentCount,
    shortcodeCount: shortcodeCount
  }
}

function stripGutenbergCommentTokens(content) {
  if (typeof content !== 'string' || content === '') {
    return ''
  }
  return content.replace(/<!--\s*\/?wp:[\s\S]*?-->/g, '')
}

function unwrapShortcodes(content) {
  if (typeof content !== 'string' || content === '') {
    return ''
  }
  let output = content
  let previous = null
  const wrappingShortcodePattern = /\[([a-zA-Z][\w-]*)([^\]]*)\]([\s\S]*?)\[\/\1\]/g
  while (output !== previous) {
    previous = output
    output = output.replace(wrappingShortcodePattern, '$3')
  }
  return output.replace(/\[(\/)?[a-zA-Z][\w-]*(?:[^\]]*)\]/g, '')
}

function extractLikelyPageContent(frontendHtml) {
  if (typeof frontendHtml !== 'string' || frontendHtml === '') {
    return ''
  }
  const doc = parse(frontendHtml)
  const selectors = [
    'main .entry-content',
    'article .entry-content',
    '.entry-content',
    'main article',
    'article',
    'main',
    '#primary',
    '#content',
    '.site-content'
  ]
  for (let i = 0; i < selectors.length; i += 1) {
    const match = doc.querySelector(selectors[i])
    if (match && typeof match.innerHTML === 'string' && match.innerHTML.trim() !== '') {
      return match.innerHTML.trim()
    }
  }
  const body = doc.querySelector('body')
  if (body && typeof body.innerHTML === 'string') {
    return body.innerHTML.trim()
  }
  return ''
}

function sanitizeExtractedContent(html) {
  if (typeof html !== 'string' || html === '') {
    return ''
  }
  const wrapper = parse(`<div id="wordpress-import-wrapper">${html}</div>`)
  const root = wrapper.querySelector('#wordpress-import-wrapper')
  if (!root) {
    return ''
  }
  ['script', 'style', 'noscript', 'template'].forEach((selector) => {
    const nodes = root.querySelectorAll(selector)
    nodes.forEach((node) => node.remove())
  })
  return root.innerHTML.trim()
}

async function buildWordPressPageContent(page, context) {
  const settings = context && context.settings ? context.settings : {}
  const renderedContent = renderedToHtml(page && page.content ? page.content : '', settings)
  let html = renderedContent.html
  let source = renderedContent.source !== '' ? renderedContent.source : 'empty'
  const originalTokenStats = analyzeWordPressTokens(html)

  if (valueToBoolean(settings.stripGutenbergComments, true)) {
    html = stripGutenbergCommentTokens(html)
  }
  if (valueToBoolean(settings.stripShortcodes, false)) {
    html = unwrapShortcodes(html)
  }
  if (html !== '') {
    html = absolutizeRootUrls(html, context.base)
  }

  let finalTokenStats = analyzeWordPressTokens(html)
  let fallbackUsed = false
  const fallbackToPageHtml = valueToBoolean(settings.fallbackToPageHtml, false)
  const tokenThreshold = valueToNumber(settings.tokenThreshold, 8)
  const shouldFallback =
    fallbackToPageHtml &&
    page &&
    page.link &&
    (html === '' || finalTokenStats.tokenCount >= tokenThreshold)

  if (shouldFallback) {
    const frontendHtml = await fetchText(page.link)
    const extracted = sanitizeExtractedContent(extractLikelyPageContent(frontendHtml))
    if (extracted !== '') {
      html = absolutizeRootUrls(extracted, context.base)
      source = 'front-end-fallback'
      fallbackUsed = true
      if (valueToBoolean(settings.stripGutenbergComments, true)) {
        html = stripGutenbergCommentTokens(html)
      }
      if (valueToBoolean(settings.stripShortcodes, false)) {
        html = unwrapShortcodes(html)
      }
      finalTokenStats = analyzeWordPressTokens(html)
    }
  }

  if (html === '') {
    html = '<p></p>'
  }

  return {
    html: html,
    source: source,
    fallbackUsed: fallbackUsed,
    tokenStats: finalTokenStats,
    originalTokenStats: originalTokenStats
  }
}

function normalizeNumeric(value, fallback = 0) {
  const normalized = parseInt(value)
  if (Number.isNaN(normalized)) {
    return fallback
  }
  return normalized
}

function buildMenuPageOrderMap(menuItems) {
  const pageOrderMap = {}
  if (!Array.isArray(menuItems)) {
    return pageOrderMap
  }
  const sorted = [...menuItems]
  sorted.sort((a, b) => normalizeNumeric(a.menu_order, 0) - normalizeNumeric(b.menu_order, 0))
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i]
    if (!item) {
      continue
    }
    const objectType = item.object ? item.object : ''
    const itemType = item.type ? item.type : ''
    if (objectType === 'page' || itemType === 'post_type') {
      const objectId = normalizeNumeric(item.object_id, 0)
      if (objectId > 0 && pageOrderMap[objectId] === undefined) {
        pageOrderMap[objectId] = i
      }
    }
  }
  return pageOrderMap
}

function buildPageSegment(page) {
  if (page && page.slug && page.slug !== '') {
    return HAXCMS.cleanTitle(page.slug)
  }
  const title = renderedToText(page && page.title ? page.title : '')
  return HAXCMS.cleanTitle(title !== '' ? title : 'page')
}

function sortPagesForTree(pages, menuPageOrderMap = {}) {
  const sorted = [...pages]
  sorted.sort((a, b) => {
    const aId = normalizeNumeric(a.id, 0)
    const bId = normalizeNumeric(b.id, 0)
    const aMenu = menuPageOrderMap[aId] !== undefined ? menuPageOrderMap[aId] : Number.MAX_SAFE_INTEGER
    const bMenu = menuPageOrderMap[bId] !== undefined ? menuPageOrderMap[bId] : Number.MAX_SAFE_INTEGER
    if (aMenu !== bMenu) {
      return aMenu - bMenu
    }
    const aOrder = normalizeNumeric(a.menu_order, 0)
    const bOrder = normalizeNumeric(b.menu_order, 0)
    if (aOrder !== bOrder) {
      return aOrder - bOrder
    }
    return renderedToText(a.title).localeCompare(renderedToText(b.title))
  })
  return sorted
}

function getSiteFilenameFromRoot(root, base) {
  if (root && root.name) {
    return HAXCMS.cleanTitle(root.name)
  }
  let pathname = ''
  try {
    pathname = new URL(base).pathname
  }
  catch (e) {
    pathname = ''
  }
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length > 0) {
    return HAXCMS.cleanTitle(parts[parts.length - 1])
  }
  return 'wordpress-import'
}

async function buildWordPressAdapterContext(repoUrl, settings = {}) {
  const discovered = await discoverWordPressBase(repoUrl)
  if (!discovered || !discovered.base) {
    return {
      error: 'Unable to discover WordPress API from `repoUrl`; expected `/wp-json/wp/v2/*`'
    }
  }
  const pagesResponse = await fetchWordPressCollection(
    discovered.base,
    'pages',
    ['id', 'slug', 'title', 'content', 'parent', 'menu_order', 'link', 'status', 'date', 'modified'],
    settings.maxPages ? settings.maxPages : 25,
    settings.perPage ? settings.perPage : 100
  )
  const menusResponse = await fetchWordPressCollection(
    discovered.base,
    'menus',
    ['id', 'name', 'slug'],
    10,
    100
  )
  const menuItemsResponse = await fetchWordPressCollection(
    discovered.base,
    'menu-items',
    ['id', 'menu_order', 'parent', 'object', 'object_id', 'type', 'title', 'url', 'menu'],
    10,
    100
  )
  const postsResponse = await fetchWordPressCollection(
    discovered.base,
    'posts',
    ['id', 'slug', 'title', 'link', 'status', 'date'],
    10,
    100
  )
  return {
    base: discovered.base,
    root: discovered.root,
    repoUrl: repoUrl,
    settings: settings,
    pagesResponse: pagesResponse,
    menusResponse: menusResponse,
    menuItemsResponse: menuItemsResponse,
    postsResponse: postsResponse
  }
}

async function wordpressPagesAdapter(context) {
  const pagesResponse = context.pagesResponse
  if (!pagesResponse || pagesResponse.status >= 400) {
    return {
      error:
        'WordPress pages endpoint is not publicly accessible (authentication required or blocked)',
      status: pagesResponse ? pagesResponse.status : 0
    }
  }
  const allPages = Array.isArray(pagesResponse.items) ? pagesResponse.items : []
  const pages = allPages.filter((page) => {
    if (!page || !page.id) {
      return false
    }
    if (page.status === 'trash') {
      return false
    }
    return true
  })

  const menuItems = context.menuItemsResponse && Array.isArray(context.menuItemsResponse.items)
    ? context.menuItemsResponse.items
    : []
  const menuPageOrderMap = buildMenuPageOrderMap(menuItems)

  const pageLookup = {}
  pages.forEach((page) => {
    pageLookup[normalizeNumeric(page.id, 0)] = page
  })
  const pagesByParent = {}
  pages.forEach((page) => {
    let parentId = normalizeNumeric(page.parent, 0)
    if (!pageLookup[parentId]) {
      parentId = 0
    }
    if (!pagesByParent[parentId]) {
      pagesByParent[parentId] = []
    }
    pagesByParent[parentId].push(page)
  })
  Object.keys(pagesByParent).forEach((parentKey) => {
    pagesByParent[parentKey] = sortPagesForTree(pagesByParent[parentKey], menuPageOrderMap)
  })

  const items = []
  const wpToJosMap = {}
  const visited = {}
  const configuredParent = context.settings && context.settings.parentId ? context.settings.parentId : null
  const contentSummary = {
    pagesWithTokens: 0,
    pagesUsingFallback: 0,
    tokenCount: 0,
    gutenbergCommentCount: 0,
    shortcodeCount: 0
  }

  async function walkTree(parentWpId, josParentId, depth) {
    const siblings = pagesByParent[parentWpId] ? pagesByParent[parentWpId] : []
    for (let i = 0; i < siblings.length; i += 1) {
      const page = siblings[i]
      const wpId = normalizeNumeric(page.id, 0)
      if (wpId === 0 || visited[wpId]) {
        continue
      }
      visited[wpId] = true
      const item = new JSONOutlineSchemaItem()
      const title = renderedToText(page.title)
      const segment = buildPageSegment(page)
      item.title = title !== '' ? title : segment
      if (josParentId !== null && wpToJosMap[parentWpId]) {
        item.slug = `${wpToJosMap[parentWpId].slug}/${segment}`
      }
      else {
        item.slug = segment
      }
      item.order = i
      item.indent = depth
      item.parent = josParentId !== null ? josParentId : configuredParent
      const pageContent = await buildWordPressPageContent(page, context)
      item.contents = pageContent.html
      if (pageContent.tokenStats.tokenCount > 0) {
        contentSummary.pagesWithTokens += 1
      }
      contentSummary.tokenCount += pageContent.tokenStats.tokenCount
      contentSummary.gutenbergCommentCount += pageContent.tokenStats.gutenbergCommentCount
      contentSummary.shortcodeCount += pageContent.tokenStats.shortcodeCount
      if (pageContent.fallbackUsed) {
        contentSummary.pagesUsingFallback += 1
      }
      item.metadata = {
        sourceType: 'wordpress-page',
        source: page.link ? page.link : null,
        wordpress: {
          id: wpId,
          parent: normalizeNumeric(page.parent, 0),
          menuOrder: normalizeNumeric(page.menu_order, 0),
          status: page.status ? page.status : '',
          date: page.date ? page.date : '',
          modified: page.modified ? page.modified : '',
          content: {
            source: pageContent.source,
            fallbackUsed: pageContent.fallbackUsed,
            tokenCount: pageContent.tokenStats.tokenCount,
            gutenbergCommentCount: pageContent.tokenStats.gutenbergCommentCount,
            shortcodeCount: pageContent.tokenStats.shortcodeCount,
            originalTokenCount: pageContent.originalTokenStats.tokenCount,
            originalGutenbergCommentCount: pageContent.originalTokenStats.gutenbergCommentCount,
            originalShortcodeCount: pageContent.originalTokenStats.shortcodeCount
          }
        }
      }
      items.push(item)
      wpToJosMap[wpId] = item
      await walkTree(wpId, item.id, depth + 1)
    }
  }
  await walkTree(0, null, 0)
  const unvisited = pages.filter((page) => !visited[normalizeNumeric(page.id, 0)])
  const sortedUnvisited = sortPagesForTree(unvisited, menuPageOrderMap)
  if (sortedUnvisited.length > 0) {
    if (!pagesByParent[0]) {
      pagesByParent[0] = []
    }
    sortedUnvisited.forEach((page) => {
      pagesByParent[0].push(page)
    })
    pagesByParent[0] = sortPagesForTree(pagesByParent[0], menuPageOrderMap)
    await walkTree(0, null, 0)
  }

  return {
    items: items,
    files: {},
    filename: getSiteFilenameFromRoot(context.root, context.base),
    wordpress: {
      pages: {
        status: pagesResponse.status,
        count: pages.length
      },
      menus: {
        status: context.menusResponse ? context.menusResponse.status : 0,
        count: context.menusResponse && Array.isArray(context.menusResponse.items)
          ? context.menusResponse.items.length
          : 0
      },
      menuItems: {
        status: context.menuItemsResponse ? context.menuItemsResponse.status : 0,
        count: menuItems.length
      },
      posts: {
        status: context.postsResponse ? context.postsResponse.status : 0,
        count: context.postsResponse && Array.isArray(context.postsResponse.items)
          ? context.postsResponse.items.length
          : 0,
        imported: false
      },
      content: {
        settings: {
          contentMode: context.settings && context.settings.contentMode ? context.settings.contentMode : 'rendered',
          allowRawFallback: context.settings ? valueToBoolean(context.settings.allowRawFallback, false) : false,
          stripGutenbergComments: context.settings ? valueToBoolean(context.settings.stripGutenbergComments, true) : true,
          stripShortcodes: context.settings ? valueToBoolean(context.settings.stripShortcodes, false) : false,
          fallbackToPageHtml: context.settings ? valueToBoolean(context.settings.fallbackToPageHtml, false) : false,
          tokenThreshold: context.settings ? valueToNumber(context.settings.tokenThreshold, 8) : 8
        },
        pagesWithTokens: contentSummary.pagesWithTokens,
        pagesUsingFallback: contentSummary.pagesUsingFallback,
        tokenCount: contentSummary.tokenCount,
        gutenbergCommentCount: contentSummary.gutenbergCommentCount,
        shortcodeCount: contentSummary.shortcodeCount
      }
    }
  }
}

const wordpressSiteAdapters = {
  pages: wordpressPagesAdapter
}

// ---- handler ----

/**
 * POST /system/api/v1/actions/convert-wordpress-to-site
 * Convert a WordPress site into a HAXcms site schema via its REST API.
 *
 * Expects JSON body with `repoUrl` (WordPress site URL).
 * Optional: parentId, contentMode, adapter, allowRawFallback,
 *   stripGutenbergComments, stripShortcodes, fallbackToPageHtml, tokenThreshold.
 * Returns { status: 200, data: { items: [...], filename: string, files: {...}, wordpress: {...} } }.
 */
async function convertWordpressToSite(req, res) {
  let body = {}
  if (req && req.query && req.query.repoUrl) {
    body = req.query
  }
  else if (req && req.body && typeof req.body === 'object') {
    body = req.body
  }
  else if (req && req.body && typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body.trim())
    }
    catch (e) {
      body = {}
    }
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

  let parentId = null
  if (body.parentId && body.parentId !== 'null') {
    parentId = body.parentId
  }
  const contentMode = body.contentMode
    ? body.contentMode
    : body.renderMode
      ? body.renderMode
      : 'rendered'

  const adapterName = body.adapter ? body.adapter : 'pages'
  if (!wordpressSiteAdapters[adapterName]) {
    return res.status(400).json({
      status: 400,
      data: {
        error: `unknown adapter \`${adapterName}\`; valid adapters: ${Object.keys(wordpressSiteAdapters).join(', ')}`,
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  const context = await buildWordPressAdapterContext(body.repoUrl, {
    parentId: parentId,
    contentMode: contentMode,
    allowRawFallback: valueToBoolean(body.allowRawFallback, false),
    stripGutenbergComments: valueToBoolean(body.stripGutenbergComments, true),
    stripShortcodes: valueToBoolean(body.stripShortcodes, false),
    fallbackToPageHtml: valueToBoolean(body.fallbackToPageHtml, false),
    tokenThreshold: valueToNumber(body.tokenThreshold, 8)
  })
  if (context.error) {
    return res.status(422).json({
      status: 422,
      data: {
        error: context.error,
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  const adapterResult = await wordpressSiteAdapters[adapterName](context)
  if (adapterResult && adapterResult.error) {
    return res.status(422).json({
      status: 422,
      data: {
        error: adapterResult.error,
        items: [],
        filename: null,
        files: {}
      }
    })
  }
  if (!adapterResult || !Array.isArray(adapterResult.items) || adapterResult.items.length === 0) {
    return res.status(422).json({
      status: 422,
      data: {
        error: 'WordPress import produced no pages to import',
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  return res.json({
    status: 200,
    data: {
      items: adapterResult.items,
      filename: adapterResult.filename,
      files: adapterResult.files,
      wordpress: adapterResult.wordpress
    }
  })
}

module.exports = { convertWordpressToSite }