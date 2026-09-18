const path = require('path')
const crypto = require('crypto')
const fs = require('fs-extra')
const { parse } = require('node-html-parser')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { HAXCMS } = require('../../../../lib/HAXCMS.js')
const { escapeHTMLAttribute } = require('../../../../lib/sanitizeContent.js')
// reached through the module object so the network boundary can be stubbed in tests
const safeFetchLib = require('../../../../lib/safeFetch.js')

const OPENSTAX_ORIGIN = 'https://openstax.org'
const RELEASE_URL = `${OPENSTAX_ORIGIN}/rex/release.json`
const BOOK_LOOKUP_URL = `${OPENSTAX_ORIGIN}/apps/cms/api/v2/pages/?type=books.Book&fields=title,cnx_id&slug=`
// Safety valves: a book runs to hundreds of pages and thousands of images.
// A 53 page book with 81 images took ~160s and 20MB, so the budget is set to
// carry the largest books (~260 pages) rather than truncate them. Exported so
// tests can exercise the limits without downloading a book.
const LIMITS = {
  maxPages: 500,
  maxImages: 1000,
  maxImageBytes: 250 * 1024 * 1024,
  fetchBudgetSeconds: 900,
  requestDelayMs: 200,
}
// image types HAXCMSFile accepts, keyed by the content type the archive serves
const EXTENSION_BY_CONTENT_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
// license codes site.license understands (mirrors convertPressbooksToSite)
const SUPPORTED_SITE_LICENSES = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd']
// attributes worth keeping, by tag. Everything else — os-* classes, fs-id ids,
// data-type hooks, inline styles — is dropped so HAX receives clean markup
const KEEP_ATTRIBUTES = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'type'],
  math: ['display'],
  'media-image': ['source', 'alt'],
}
// dropped outright: presentation and script material with no content value
const DROP_ELEMENTS = ['style', 'script', 'link', 'meta', 'noscript', 'head']

/**
 * POST /system/api/v1/site/import/openstax
 * Convert an OpenStax textbook into a HAXcms site schema.
 *
 * Expects JSON body with a `repoUrl` param: any OpenStax book URL, either
 * https://openstax.org/details/books/<slug> or
 * https://openstax.org/books/<slug>/pages/<page-slug>.
 *
 * Reads the book through OpenStax's public archive API (the web reader is a
 * client-rendered app whose table of contents is not in the served HTML):
 *   /rex/release.json                       -> archive version + book versions
 *   /apps/cms/api/v2/pages/?slug=<slug>     -> book slug to content id
 *   <archive>/contents/<id>@<ver>.json      -> title, license, page tree
 *   <archive>/contents/<id>@<ver>:<page>.json -> one page of XHTML
 *
 * Returns { status: 200, data: { items: [...], filename: string, files: {...}, site: {...} } }.
 */
async function convertOpenstaxToSite(req, res) {
  const body = readRequestBody(req)
  const repoUrl = body && typeof body.repoUrl === 'string' ? body.repoUrl.trim() : ''
  if (repoUrl === '') {
    return sendError(res, 400, 'missing `repoUrl` param')
  }
  let bookSlug = ''
  try {
    bookSlug = bookSlugFromUrl(repoUrl)
  }
  catch (error) {
    return sendError(res, 400, error.message)
  }
  try {
    const book = await resolveBook(bookSlug)
    const imported = await importBook(book)
    return res.json({
      status: 200,
      data: {
        items: imported.items,
        filename: bookSlug,
        files: imported.files,
        site: { license: book.licenseCode },
        // true when the page cap or time budget stopped the import early;
        // those pages carry a link to their source instead of the body
        truncated: imported.truncated,
      },
    })
  }
  catch (error) {
    const status = error && error.status ? error.status : 422
    const message =
      error && error.message ? error.message : 'Unable to import this OpenStax book'
    return sendError(res, status, message)
  }
}

/** Accept a parsed body or a JSON string, as the sibling importers do. */
function readRequestBody(req) {
  if (req && req.body && typeof req.body === 'object') {
    return req.body
  }
  if (req && req.body && typeof req.body === 'string') {
    try {
      return JSON.parse(req.body.trim())
    }
    catch (e) {
      return {}
    }
  }
  return {}
}

function sendError(res, status, message) {
  return res.status(status).json({
    status: status,
    data: { error: message, items: [], filename: null, files: {} },
  })
}

/** An error carrying the HTTP status the route should answer with. */
function importError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** Pull the book slug out of a details or reader URL, rejecting other hosts. */
function bookSlugFromUrl(sourceUrl) {
  let parsed = null
  try {
    parsed = new URL(sourceUrl)
  }
  catch (e) {
    throw importError(400, `\`repoUrl\` is not a valid URL: ${sourceUrl}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== 'openstax.org' && host !== 'www.openstax.org') {
    throw importError(400, `\`repoUrl\` must be an openstax.org URL, got: ${parsed.hostname}`)
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  // /details/books/<slug> and /books/<slug>/pages/<page-slug>
  const booksIndex = segments.indexOf('books')
  if (booksIndex === -1 || !segments[booksIndex + 1]) {
    throw importError(
      400,
      'unable to read a book slug from `repoUrl`; expected /details/books/<slug> or /books/<slug>/pages/<page>',
    )
  }
  return segments[booksIndex + 1]
}

/** GET JSON through safeFetch, which applies the SSRF guard. */
async function fetchJson(url, description) {
  let response = null
  try {
    response = await safeFetchLib.safeFetch(url)
  }
  catch (e) {
    throw importError(422, `unable to reach OpenStax for ${description}: ${e.message}`)
  }
  if (!response.ok) {
    throw importError(422, `OpenStax returned ${response.status} for ${description}`)
  }
  try {
    return JSON.parse(await response.text())
  }
  catch (e) {
    throw importError(422, `OpenStax returned unreadable data for ${description}`)
  }
}

/**
 * Resolve a book slug to everything needed to read it: content id, version,
 * archive base, title, license and the page tree.
 */
async function resolveBook(bookSlug) {
  const release = await fetchJson(RELEASE_URL, 'the OpenStax release manifest')
  const archivePath = release && release.archiveUrl ? String(release.archiveUrl) : ''
  if (archivePath === '') {
    throw importError(422, 'the OpenStax release manifest did not name an archive')
  }
  const lookup = await fetchJson(
    BOOK_LOOKUP_URL + encodeURIComponent(bookSlug),
    `the book "${bookSlug}"`,
  )
  const entries = lookup && Array.isArray(lookup.items) ? lookup.items : []
  if (entries.length === 0 || !entries[0].cnx_id) {
    throw importError(422, `OpenStax has no book with the slug "${bookSlug}"`)
  }
  const contentId = String(entries[0].cnx_id)
  const books = release && release.books ? release.books : {}
  const bookRelease = books[contentId]
  if (!bookRelease || !bookRelease.defaultVersion) {
    throw importError(422, `OpenStax is not currently publishing "${bookSlug}"`)
  }
  const archiveUrl = `${OPENSTAX_ORIGIN}${archivePath}`
  const version = String(bookRelease.defaultVersion)
  const contents = await fetchJson(
    `${archiveUrl}/contents/${contentId}@${version}.json`,
    `the contents of "${bookSlug}"`,
  )
  if (!contents || !contents.tree || !Array.isArray(contents.tree.contents)) {
    throw importError(422, `OpenStax returned no table of contents for "${bookSlug}"`)
  }
  const license = contents.license && typeof contents.license === 'object' ? contents.license : {}
  return {
    slug: bookSlug,
    contentId: contentId,
    version: version,
    archiveUrl: archiveUrl,
    title: plainText(contents.title || bookSlug),
    license: license,
    licenseCode: licenseCode(license),
    tree: contents.tree,
  }
}

/** Map an OpenStax license record onto a site.license code, defaulting to by. */
function licenseCode(license) {
  const value = `${license.url || ''} ${license.name || ''}`.toLowerCase()
  for (let i = 0; i < SUPPORTED_SITE_LICENSES.length; i++) {
    const code = SUPPORTED_SITE_LICENSES[i]
    if (value.indexOf(`/licenses/${code}/`) !== -1) {
      return code
    }
  }
  const compact = value.replace(/[^a-z]/g, '')
  const nonCommercial = compact.indexOf('noncommercial') !== -1
  const noDerivatives = compact.indexOf('noderivatives') !== -1
  const shareAlike = compact.indexOf('sharealike') !== -1
  if (nonCommercial && noDerivatives) {
    return 'by-nc-nd'
  }
  if (nonCommercial && shareAlike) {
    return 'by-nc-sa'
  }
  if (nonCommercial) {
    return 'by-nc'
  }
  if (noDerivatives) {
    return 'by-nd'
  }
  if (shareAlike) {
    return 'by-sa'
  }
  return 'by'
}

/**
 * Slug for one page title. Section titles end in punctuation often enough
 * ("What Is Finance?") that cleanTitle leaves a trailing separator, so trim
 * the edges; keep cleanTitle's output if trimming would empty the slug.
 */
function titleSlug(title) {
  const cleaned = HAXCMS.cleanTitle(title)
  const trimmed = cleaned.replace(/^-+|-+$/g, '')
  return trimmed === '' ? cleaned : trimmed
}

/** Strip markup and collapse whitespace; tree titles carry os-* span markup. */
function plainText(value) {
  const raw = String(value === null || value === undefined ? '' : value)
  // tags become spaces first: OpenStax titles are adjacent spans ("1.1",
  // "What Is Finance?") that would otherwise run together
  return parse(raw.replace(/<[^>]+>/g, ' '))
    .text.replace(/\s+/g, ' ')
    .trim()
}

/**
 * Walk the tree into a flat, ordered list of nodes. Units and chapters keep
 * their children, so the JOS parent/indent relationship follows the book.
 */
function flattenTree(tree) {
  const nodes = []
  const walk = (branch, depth, parentIndex) => {
    const children = branch && Array.isArray(branch.contents) ? branch.contents : []
    let order = 0
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const title = plainText(child.title)
      if (title === '') {
        continue
      }
      const hasChildren = Array.isArray(child.contents) && child.contents.length > 0
      const index = nodes.length
      nodes.push({
        title: title,
        depth: depth,
        order: order,
        parentIndex: parentIndex,
        // leaf nodes are pages; "<uuid>@<version>" needs the version trimmed
        pageId: hasChildren ? null : String(child.id || '').split('@')[0],
        sourceSlug: child.slug ? String(child.slug) : '',
      })
      order++
      if (hasChildren) {
        walk(child, depth + 1, index)
      }
    }
  }
  walk(tree, 0, null)
  return nodes
}

/** Fetch and convert every page in the tree into JOS items plus staged files. */
async function importBook(book) {
  const nodes = flattenTree(book.tree)
  if (nodes.length === 0) {
    throw importError(422, `OpenStax returned an empty table of contents for "${book.slug}"`)
  }
  const context = {
    book: book,
    accessed: new Date().toISOString(),
    // slugs by page id, so in-book links can point at the imported pages
    slugByPageId: {},
    // staged image downloads, keyed by the archive resource path
    imagesByResource: {},
    files: {},
    imageCount: 0,
    imageBytes: 0,
    stagingDirectory: null,
    // keeps this import's staged names apart from any other import's
    importId: crypto.randomUUID(),
    startedAt: Date.now(),
    truncated: false,
  }
  const items = []
  // first pass: items and slugs, so page bodies can link to siblings by slug
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const item = new JSONOutlineSchemaItem()
    item.title = node.title
    item.indent = node.depth
    item.order = node.order
    const parentItem = node.parentIndex === null ? null : items[node.parentIndex]
    item.parent = parentItem ? parentItem.id : null
    // nested slugs carry the parent path, matching convertPressbooksToSite
    item.slug = parentItem
      ? `${parentItem.slug}/${titleSlug(node.title)}`
      : titleSlug(node.title)
    item.metadata = {
      sourceType: 'openstax',
      openstax: {
        bookSlug: book.slug,
        bookTitle: book.title,
        pageSlug: node.sourceSlug,
        license: book.license,
        publisher: 'OpenStax / Rice University',
        accessed: context.accessed,
      },
    }
    if (node.pageId) {
      item.metadata.source = `${OPENSTAX_ORIGIN}/books/${book.slug}/pages/${node.sourceSlug}`
      context.slugByPageId[node.pageId] = item.slug
    }
    items.push(item)
    node.item = item
  }
  // second pass: page bodies, bounded by the page cap and the time budget
  let fetched = 0
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!node.pageId) {
      // a unit or chapter heading: a landing page with no body of its own
      node.item.contents = '<p></p>'
      continue
    }
    if (fetched >= LIMITS.maxPages || budgetExhausted(context)) {
      context.truncated = true
      node.item.contents = sourceFallback(node.item.metadata.source)
      continue
    }
    if (fetched > 0) {
      await delay(LIMITS.requestDelayMs)
    }
    const page = await fetchJson(
      `${book.archiveUrl}/contents/${book.contentId}@${book.version}:${node.pageId}.json`,
      `the page "${node.title}"`,
    )
    fetched++
    node.item.contents = await cleanPage(page && page.content ? page.content : '', context)
    if (page && page.abstract) {
      node.item.description = plainText(page.abstract).slice(0, 280)
    }
  }
  return { items: items, files: context.files, truncated: context.truncated }
}

function budgetExhausted(context) {
  return (Date.now() - context.startedAt) / 1000 > LIMITS.fetchBudgetSeconds
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/** Pages that could not be fetched still link out to their source. */
function sourceFallback(source) {
  if (!source) {
    return '<p></p>'
  }
  return `<p>Read this page on <a href="${source}">OpenStax</a>.</p>`
}

/**
 * Turn one page of OpenStax XHTML into clean semantic HTML: drop the styling
 * layer, keep the structure, stage images into the site and point in-book
 * links at the imported pages.
 */
async function cleanPage(content, context) {
  if (typeof content !== 'string' || content.trim() === '') {
    return '<p></p>'
  }
  const root = parse(content)
  // the body of the page, minus the xhtml wrapper the archive serves
  const container = root.querySelector('[data-type="page"]') || root.querySelector('body') || root
  const dropSelector = DROP_ELEMENTS.join(',')
  const dropped = container.querySelectorAll(dropSelector)
  for (let i = 0; i < dropped.length; i++) {
    dropped[i].remove()
  }
  // the page title becomes the item title, so it does not repeat in the body
  const documentTitle = container.querySelector('[data-type="document-title"]')
  if (documentTitle) {
    documentTitle.remove()
  }
  await stageImages(container, context)
  rewriteLinks(container, context)
  stripPresentationAttributes(container)
  // collapse only the archive's pretty-printing between tags: a blanket
  // whitespace collapse would rewrite the inside of pre/code blocks
  const html = container.innerHTML.replace(/>\s*\n\s*</g, '><').trim()
  return html === '' ? '<p></p>' : html
}

/**
 * Download each image into the bulk-import staging directory and render it as
 * media-image at its site path, the same markup the docx import produces.
 * createSite only accepts staged local paths in build.files (see
 * haxtheweb/issues#3060), ingests them as file entities, and then links each
 * page to their uuids. Images that cannot be staged keep an absolute source.
 */
async function stageImages(container, context) {
  const images = container.querySelectorAll('img')
  for (let i = 0; i < images.length; i++) {
    const image = images[i]
    const source = image.getAttribute('src')
    if (!source) {
      continue
    }
    const resource = resourcePath(source)
    if (resource === '') {
      continue
    }
    const absolute = `${context.book.archiveUrl}/${resource}`
    if (!Object.prototype.hasOwnProperty.call(context.imagesByResource, resource)) {
      context.imagesByResource[resource] = await downloadImage(absolute, resource, context)
    }
    const staged = context.imagesByResource[resource]
    if (staged) {
      const alt = escapeHTMLAttribute(image.getAttribute('alt') || '')
      image.replaceWith(`<media-image source="${staged.sitePath}" alt="${alt}"></media-image>`)
    }
    else {
      image.setAttribute('src', absolute)
    }
  }
}

/** Normalize an archive-relative image src ("../resources/<name>") to a path. */
function resourcePath(source) {
  const value = String(source).trim()
  if (value === '' || /^(https?:)?\/\//i.test(value) || value.indexOf('data:') === 0) {
    return ''
  }
  const match = value.match(/resources\/([A-Za-z0-9._-]+)$/)
  return match ? `resources/${match[1]}` : ''
}

/**
 * Fetch one image into <configDirectory>/tmp/imports and record it
 * in the files map. Returns null when it cannot be stored, so the caller can
 * fall back to the source URL.
 */
async function downloadImage(url, resource, context) {
  if (context.imageCount >= LIMITS.maxImages) {
    return null
  }
  let response = null
  try {
    response = await safeFetchLib.safeFetch(url)
  }
  catch (e) {
    return null
  }
  if (!response.ok) {
    return null
  }
  const contentType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType]
  // archive resources are extension-less hashes, so the type names the file
  if (!extension) {
    return null
  }
  try {
    const buffer = Buffer.from(await response.arrayBuffer())
    // stop before writing anything that would push the import past the budget
    if (context.imageBytes + buffer.length > LIMITS.maxImageBytes) {
      return null
    }
    // staged flat in the bulk-import root, like convertHaxcmsToSite, so the
    // moves createSite makes on ingest leave nothing behind
    if (!context.stagingDirectory) {
      context.stagingDirectory = path.join(HAXCMS.configDirectory, 'tmp', 'imports')
      fs.ensureDirSync(context.stagingDirectory)
    }
    const name = `${path.basename(resource)}.${extension}`
    const stagedPath = path.join(context.stagingDirectory, `openstax-${context.importId}-${name}`)
    fs.writeFileSync(stagedPath, buffer)
    const sitePath = `files/${name}`
    context.files[sitePath] = stagedPath
    context.imageCount++
    context.imageBytes += buffer.length
    return { sitePath: sitePath, stagedPath: stagedPath }
  }
  catch (e) {
    return null
  }
}

/**
 * Point in-book links at the imported pages and make every other relative
 * link absolute, so nothing resolves against the new site by accident.
 */
function rewriteLinks(container, context) {
  const links = container.querySelectorAll('a')
  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    const href = link.getAttribute('href')
    if (!href) {
      continue
    }
    const value = href.trim()
    if (value === '' || value.indexOf('#') === 0 || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
      continue
    }
    // in-book links carry the target page id, with an optional fragment
    const target = value.match(/\/contents\/([0-9a-f-]{36})/i)
    const pageSlug = target ? context.slugByPageId[target[1].toLowerCase()] : null
    if (pageSlug) {
      const fragment = value.indexOf('#') === -1 ? '' : value.slice(value.indexOf('#'))
      link.setAttribute('href', `${pageSlug}${fragment}`)
      continue
    }
    try {
      link.setAttribute('href', new URL(value, `${context.book.archiveUrl}/`).href)
    }
    catch (e) {
      link.removeAttribute('href')
    }
  }
}

/**
 * Drop the OpenStax styling layer (os-* classes, fs-id ids, data-type hooks,
 * inline styles) while keeping the attributes that carry meaning. MathML is
 * left untouched: its attributes are part of the notation.
 */
function stripPresentationAttributes(container) {
  const elements = container.querySelectorAll('*')
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]
    const tag = String(element.rawTagName || '').toLowerCase()
    if (tag === '' || insideMath(element)) {
      continue
    }
    const keep = KEEP_ATTRIBUTES[tag] || []
    const names = Object.keys(element.attributes || {})
    for (let j = 0; j < names.length; j++) {
      if (keep.indexOf(names[j].toLowerCase()) === -1) {
        element.removeAttribute(names[j])
      }
    }
  }
}

function insideMath(node) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (String(parent.rawTagName || '').toLowerCase() === 'math') {
      return true
    }
  }
  return false
}

module.exports = { convertOpenstaxToSite, LIMITS }
