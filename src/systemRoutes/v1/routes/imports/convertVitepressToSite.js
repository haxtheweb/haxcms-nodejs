const MarkdownIt = require('markdown-it')
const markdownItContainer = require('markdown-it-container')
const markdownItFootnote = require('markdown-it-footnote')
const yaml = require('js-yaml')
const { parse } = require('node-html-parser')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { HAXCMS } = require('../../../../lib/HAXCMS.js')
const { escapeHTMLAttribute } = require('../../../../lib/sanitizeContent.js')
// reached through the module object so the network boundary can be stubbed in tests
const safeFetchLib = require('../../../../lib/safeFetch.js')

const GITHUB_API = 'https://api.github.com'
const RAW_ORIGIN = 'https://raw.githubusercontent.com'
// The GitHub API 403s every call that arrives without a User-Agent, so the
// repository and tree reads carry one. convertGitbookToSite hit this and
// settled on HAXcms-Import/1.0, which haxcms-php sends too; same string here.
const GITHUB_API_HEADERS = {
  'User-Agent': 'HAXcms-Import/1.0',
  Accept: 'application/vnd.github.v3+json',
}
const RAW_HEADERS = { 'User-Agent': 'HAXcms-Import/1.0' }
// Safety valves: a VitePress book runs to hundreds of pages. Page bodies are
// fetched one at a time; assets travel to createSite as URLs, which downloads
// them behind its own SSRF guard (haxtheweb/issues#3060), so only their count
// is capped here. Exported so tests can exercise the limits.
const LIMITS = {
  maxPages: 500,
  maxFiles: 2000,
  fetchBudgetSeconds: 900,
  requestDelayMs: 100,
}
// VitePress keeps its config beside the content root it serves
const CONFIG_PATH_REGEX = /(^|\/)\.vitepress\/config\.(mjs|mts|js|ts)$/
// license codes site.license and license-element both understand; VitePress
// frontmatter writes them CC-first ("cc-by-sa"), which is the same code
const SUPPORTED_LICENSES = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd']
// createSite only accepts these extensions in build.files, so anything else
// (an .svg diagram, a .zip download) keeps its source URL instead
const IMPORTABLE_ASSET_REGEX = /\.(jpg|jpeg|png|gif|webm|webp|mp4|mp3|mov|csv|ppt|pptx|xlsx|doc|xls|docx|pdf|rtf|txt|vtt|xml)$/i
const IMAGE_EXTENSION_REGEX = /\.(jpg|jpeg|png|gif|webp)$/i
const VIDEO_EXTENSION_REGEX = /\.(webm|mp4|mov)$/i
// The OER containers the VitePress OER plugin defines (vitepress-plugin in the
// source repo). Each becomes an oer-schema element; the container's attributes
// become nested oer-schema properties under the same names the plugin emits as
// itemprops, so the imported page carries the same vocabulary.
const OER_CONTAINERS = {
  'learning-objective': {
    resource: 'LearningObjective',
    properties: { skill: 'skill', course: 'forCourse' },
  },
  assessment: {
    resource: 'Assessment',
    properties: { type: 'additionalType', points: 'gradingFormat', assessing: 'assessing' },
  },
  practice: {
    resource: 'Practice',
    properties: { action: 'typeOfAction', material: 'material' },
  },
  'learning-component': {
    resource: 'LearningComponent',
    properties: { action: 'typeOfAction', objective: 'hasLearningObjective' },
  },
  'instructional-pattern': {
    resource: 'InstructionalPattern',
    properties: { type: 'additionalType', title: 'name' },
  },
}

/**
 * POST /system/api/v1/site/import/vitepress
 * Convert a VitePress documentation site into a HAXcms site schema.
 *
 * Expects JSON body with a `repoUrl` param: a GitHub repository URL, with an
 * optional /tree/<branch>.
 *
 * VitePress declares its outline in JavaScript rather than in a markdown file
 * the way GitBook does, so the converter reads themeConfig.sidebar out of
 * .vitepress/config.* as data. The config is never executed: repoUrl is
 * caller-supplied, so running the repository's own JavaScript would be
 * arbitrary code execution. A config whose sidebar cannot be read as plain
 * data falls back to the markdown file tree, which is also what VitePress does
 * when no sidebar is configured.
 *
 * Returns { status: 200, data: { items, filename, files, site, truncated,
 * unmappedComponents } }.
 */
async function convertVitepressToSite(req, res) {
  const body = readRequestBody(req)
  const repoUrl = body && typeof body.repoUrl === 'string' ? body.repoUrl.trim() : ''
  if (repoUrl === '') {
    return sendError(res, 400, 'missing `repoUrl` param')
  }
  let repo = null
  try {
    repo = parseRepoUrl(repoUrl)
  }
  catch (e) {
    return sendError(res, 400, e.message)
  }
  try {
    const source = await resolveRepository(repo)
    const imported = await importSite(source)
    return res.json({
      status: 200,
      data: {
        items: imported.items,
        filename: source.title,
        files: imported.files,
        site: { license: source.license },
        truncated: imported.truncated,
        unmappedComponents: imported.unmappedComponents,
      },
    })
  }
  catch (error) {
    const status = error && error.status ? error.status : 400
    return sendError(res, status, error && error.message ? error.message : 'Unable to import the VitePress site')
  }
}

function readRequestBody(req) {
  if (!req || !req.body) {
    return {}
  }
  if (typeof req.body === 'object') {
    return req.body
  }
  if (typeof req.body === 'string') {
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

function importError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** owner, repo and optional branch out of a GitHub repository URL. */
function parseRepoUrl(sourceUrl) {
  let parsed = null
  try {
    parsed = new URL(sourceUrl)
  }
  catch (e) {
    throw importError(400, `Invalid repoUrl: ${sourceUrl}`)
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw importError(400, 'repoUrl must be a github.com repository URL')
  }
  const segments = parsed.pathname.split('/').filter((piece) => piece !== '')
  if (segments.length < 2) {
    throw importError(400, `repoUrl is missing the owner/repo path: ${sourceUrl}`)
  }
  const owner = segments[0]
  const name = segments[1].replace(/\.git$/i, '')
  // /tree/<branch> names a branch; deeper path segments are ignored because
  // the config discovery walks the whole tree anyway
  let branch = null
  if (segments[2] === 'tree' && segments[3]) {
    branch = segments[3]
  }
  return { owner: owner, name: name, branch: branch }
}

async function fetchJson(url, description) {
  let response = null
  try {
    response = await safeFetchLib.safeFetch(url, { headers: GITHUB_API_HEADERS })
  }
  catch (e) {
    throw importError(400, `Unable to reach ${description}: ${e.message}`)
  }
  if (!response.ok) {
    throw importError(response.status === 404 ? 422 : 400, `Unable to read ${description} (HTTP ${response.status})`)
  }
  try {
    return await response.json()
  }
  catch (e) {
    throw importError(400, `Unable to parse ${description}`)
  }
}

/** Fetch text, or null when it cannot be read; page bodies are optional. */
async function fetchText(url) {
  try {
    const response = await safeFetchLib.safeFetch(url, { headers: RAW_HEADERS })
    if (!response.ok) {
      return null
    }
    return await response.text()
  }
  catch (e) {
    return null
  }
}

/**
 * Resolve the repository: default branch, file tree, VitePress config and the
 * site level metadata the config carries.
 */
async function resolveRepository(repo) {
  const repoData = await fetchJson(`${GITHUB_API}/repos/${repo.owner}/${repo.name}`, `the repository ${repo.owner}/${repo.name}`)
  const branch = repo.branch || repoData.default_branch || 'main'
  const treeData = await fetchJson(
    `${GITHUB_API}/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    `the file tree of ${repo.owner}/${repo.name}`,
  )
  const tree = Array.isArray(treeData.tree) ? treeData.tree : []
  const paths = {}
  for (let i = 0; i < tree.length; i++) {
    if (tree[i] && tree[i].type === 'blob' && typeof tree[i].path === 'string') {
      paths[tree[i].path] = true
    }
  }
  const configPath = findConfigPath(paths)
  if (configPath === null) {
    throw importError(422, `No .vitepress/config file found in ${repo.owner}/${repo.name}`)
  }
  const docsRoot = configPath.slice(0, configPath.indexOf('.vitepress/')).replace(/\/$/, '')
  const rawBase = `${RAW_ORIGIN}/${repo.owner}/${repo.name}/${branch}`
  const configSource = await fetchText(`${rawBase}/${encodeURI(configPath)}`)
  if (configSource === null) {
    throw importError(422, `Unable to read ${configPath}`)
  }
  const config = readConfig(configSource)
  return {
    owner: repo.owner,
    name: repo.name,
    branch: branch,
    paths: paths,
    docsRoot: docsRoot,
    rawBase: rawBase,
    config: config,
    title: config.title || repo.name,
    license: config.license,
    accessed: new Date().toISOString(),
  }
}

/**
 * The config that describes the site: docs/.vitepress first, then a config at
 * the repository root, then the shallowest one left. A repository can carry
 * more than one (an example site, a plugin fixture), so the order matters.
 */
function findConfigPath(paths) {
  const candidates = Object.keys(paths).filter((candidate) => CONFIG_PATH_REGEX.test(candidate))
  if (candidates.length === 0) {
    return null
  }
  candidates.sort((a, b) => {
    const rank = configRank(a) - configRank(b)
    if (rank !== 0) {
      return rank
    }
    const depth = a.split('/').length - b.split('/').length
    if (depth !== 0) {
      return depth
    }
    return a.localeCompare(b)
  })
  return candidates[0]
}

function configRank(path) {
  if (path.indexOf('docs/.vitepress/') === 0) {
    return 0
  }
  if (path.indexOf('.vitepress/') === 0) {
    return 1
  }
  return 2
}

/**
 * Read the parts of a VitePress config that describe the site: the sidebar
 * outline, the themeConfig metadata, and the site title/description/base.
 * Values that are not plain data (a function call, a variable) are skipped
 * rather than executed, so an unreadable sidebar just means the file tree is
 * used instead.
 */
function readConfig(source) {
  const config = {
    sidebar: null,
    title: readStringValue(source, 'title'),
    description: readStringValue(source, 'description'),
    base: readStringValue(source, 'base'),
    license: normalizeLicense(readStringValue(source, 'license')),
    defaultAuthor: readStringValue(source, 'defaultAuthor'),
    workTitle: readStringValue(source, 'workTitle'),
    siteUrl: readStringValue(source, 'siteUrl'),
  }
  const literal = readLiteralValue(source, 'sidebar')
  if (literal !== null) {
    try {
      const sidebar = parseJsLiteral(literal)
      config.sidebar = normalizeSidebar(sidebar)
    }
    catch (e) {
      config.sidebar = null
    }
  }
  return config
}

/** VitePress allows one sidebar array or a map of path prefix to array. */
function normalizeSidebar(sidebar) {
  if (Array.isArray(sidebar)) {
    return sidebar
  }
  if (sidebar && typeof sidebar === 'object') {
    const merged = []
    Object.keys(sidebar).forEach((key) => {
      if (Array.isArray(sidebar[key])) {
        sidebar[key].forEach((entry) => merged.push(entry))
      }
    })
    return merged.length > 0 ? merged : null
  }
  return null
}

/** The position just after `key:`, ignoring matches inside strings/comments. */
function findKeyPosition(source, key) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$.'"\`])${key}\\s*:`, 'g')
  let match = pattern.exec(source)
  while (match !== null) {
    const colon = source.indexOf(':', match.index + match[1].length)
    if (colon !== -1 && !isInsideStringOrComment(source, match.index + match[1].length)) {
      return colon + 1
    }
    match = pattern.exec(source)
  }
  return -1
}

/** Whether an offset sits inside a string literal or a comment. */
function isInsideStringOrComment(source, offset) {
  let index = 0
  let quote = ''
  let comment = ''
  while (index < offset && index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (comment === 'line') {
      if (character === '\n') {
        comment = ''
      }
    }
    else if (comment === 'block') {
      if (character === '*' && next === '/') {
        comment = ''
        index++
      }
    }
    else if (quote !== '') {
      if (character === '\\') {
        index++
      }
      else if (character === quote) {
        quote = ''
      }
    }
    else if (character === '/' && next === '/') {
      comment = 'line'
      index++
    }
    else if (character === '/' && next === '*') {
      comment = 'block'
      index++
    }
    else if (character === '"' || character === "'" || character === '`') {
      quote = character
    }
    index++
  }
  return quote !== '' || comment !== ''
}

/** The balanced [..] or {..} literal assigned to a key, as text. */
function readLiteralValue(source, key) {
  const start = findKeyPosition(source, key)
  if (start === -1) {
    return null
  }
  let index = start
  while (index < source.length && /\s/.test(source[index])) {
    index++
  }
  const opener = source[index]
  if (opener !== '[' && opener !== '{') {
    return null
  }
  const closer = opener === '[' ? ']' : '}'
  let depth = 0
  let quote = ''
  let cursor = index
  while (cursor < source.length) {
    const character = source[cursor]
    if (quote !== '') {
      if (character === '\\') {
        cursor++
      }
      else if (character === quote) {
        quote = ''
      }
    }
    else if (character === '"' || character === "'" || character === '`') {
      quote = character
    }
    else if (character === opener) {
      depth++
    }
    else if (character === closer) {
      depth--
      if (depth === 0) {
        return source.slice(index, cursor + 1)
      }
    }
    cursor++
  }
  return null
}

/** The string assigned to a key, or null when it is not a plain string. */
function readStringValue(source, key) {
  const start = findKeyPosition(source, key)
  if (start === -1) {
    return null
  }
  const rest = source.slice(start)
  const match = rest.match(/^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/)
  if (!match) {
    return null
  }
  return match[2].replace(/\\(['"`\\])/g, '$1')
}

/**
 * Read a JavaScript data literal (arrays, objects, strings, numbers, booleans,
 * null) without evaluating it. Anything else - a function, an identifier, a
 * spread, a template with an expression - throws, and the caller falls back to
 * the file tree.
 */
function parseJsLiteral(source) {
  const state = { text: String(source), index: 0 }
  skipTrivia(state)
  const value = readValue(state)
  skipTrivia(state)
  if (state.index !== state.text.length) {
    throw new Error('unexpected content after the literal')
  }
  return value
}

function skipTrivia(state) {
  while (state.index < state.text.length) {
    const character = state.text[state.index]
    const next = state.text[state.index + 1]
    if (/\s/.test(character)) {
      state.index++
    }
    else if (character === '/' && next === '/') {
      while (state.index < state.text.length && state.text[state.index] !== '\n') {
        state.index++
      }
    }
    else if (character === '/' && next === '*') {
      state.index += 2
      while (state.index < state.text.length && !(state.text[state.index] === '*' && state.text[state.index + 1] === '/')) {
        state.index++
      }
      state.index += 2
    }
    else {
      return
    }
  }
}

function readValue(state) {
  skipTrivia(state)
  const character = state.text[state.index]
  if (character === '[') {
    return readArray(state)
  }
  if (character === '{') {
    return readObject(state)
  }
  if (character === '"' || character === "'" || character === '`') {
    return readString(state)
  }
  const literal = state.text.slice(state.index)
  const keyword = literal.match(/^(true|false|null)\b/)
  if (keyword) {
    state.index += keyword[1].length
    return keyword[1] === 'true' ? true : keyword[1] === 'false' ? false : null
  }
  const number = literal.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)
  if (number) {
    state.index += number[0].length
    return Number(number[0])
  }
  throw new Error(`unsupported value at ${state.index}`)
}

function readArray(state) {
  const values = []
  state.index++
  for (;;) {
    skipTrivia(state)
    if (state.text[state.index] === ']') {
      state.index++
      return values
    }
    values.push(readValue(state))
    skipTrivia(state)
    if (state.text[state.index] === ',') {
      state.index++
    }
    else if (state.text[state.index] !== ']') {
      throw new Error(`expected , or ] at ${state.index}`)
    }
  }
}

function readObject(state) {
  const value = {}
  state.index++
  for (;;) {
    skipTrivia(state)
    if (state.text[state.index] === '}') {
      state.index++
      return value
    }
    let key = ''
    const character = state.text[state.index]
    if (character === '"' || character === "'" || character === '`') {
      key = readString(state)
    }
    else {
      const identifier = state.text.slice(state.index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)
      if (!identifier) {
        throw new Error(`expected a key at ${state.index}`)
      }
      key = identifier[0]
      state.index += key.length
    }
    skipTrivia(state)
    if (state.text[state.index] !== ':') {
      throw new Error(`expected : after ${key}`)
    }
    state.index++
    value[key] = readValue(state)
    skipTrivia(state)
    if (state.text[state.index] === ',') {
      state.index++
    }
    else if (state.text[state.index] !== '}') {
      throw new Error(`expected , or } at ${state.index}`)
    }
  }
}

function readString(state) {
  const quote = state.text[state.index]
  let value = ''
  state.index++
  while (state.index < state.text.length) {
    const character = state.text[state.index]
    if (character === '\\') {
      const escaped = state.text[state.index + 1]
      value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
      state.index += 2
      continue
    }
    if (character === quote) {
      state.index++
      return value
    }
    if (quote === '`' && character === '$' && state.text[state.index + 1] === '{') {
      throw new Error('template expressions are not plain data')
    }
    value += character
    state.index++
  }
  throw new Error('unterminated string')
}

/** cc-by-sa, CC-BY-SA and by-sa all mean the same license code. */
function normalizeLicense(value) {
  if (typeof value !== 'string') {
    return null
  }
  const code = value.trim().toLowerCase().replace(/^cc-/, '')
  return SUPPORTED_LICENSES.indexOf(code) === -1 ? null : code
}

/** Slug for one page title, trimmed the way convertOpenstaxToSite trims. */
function titleSlug(title) {
  const cleaned = HAXCMS.cleanTitle(title)
  const trimmed = cleaned.replace(/^-+|-+$/g, '')
  return trimmed === '' ? cleaned : trimmed
}

/**
 * Sidebar entries into flat, ordered nodes. A group carrying both a link and
 * items becomes a page with children; a group with only items becomes a
 * landing page, the way convertOpenstaxToSite treats chapter headings.
 */
function outlineFromSidebar(sidebar, source) {
  const nodes = []
  const walk = (entries, depth, parentIndex) => {
    let order = 0
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string') {
        continue
      }
      const node = {
        title: entry.text,
        path: typeof entry.link === 'string' ? resolveDocPath(entry.link, source) : null,
        link: typeof entry.link === 'string' ? entry.link : null,
        depth: depth,
        order: order,
        parentIndex: parentIndex,
      }
      nodes.push(node)
      const index = nodes.length - 1
      order++
      if (Array.isArray(entry.items)) {
        walk(entry.items, depth + 1, index)
      }
    }
  }
  walk(sidebar, 0, null)
  return nodes
}

/**
 * Every markdown page in the docs root, in tree order, when no sidebar can be
 * read. Mirrors VitePress's own behavior of serving whatever is on disk.
 */
function outlineFromTree(source) {
  const prefix = source.docsRoot === '' ? '' : `${source.docsRoot}/`
  const pages = Object.keys(source.paths)
    .filter((candidate) => candidate.indexOf(prefix) === 0 && /\.md$/i.test(candidate))
    .filter((candidate) => candidate.indexOf('/.vitepress/') === -1 && candidate.indexOf('node_modules/') === -1)
    .sort((a, b) => {
      const indexA = /(^|\/)index\.md$/i.test(a) ? 0 : 1
      const indexB = /(^|\/)index\.md$/i.test(b) ? 0 : 1
      if (a.split('/').length !== b.split('/').length) {
        return a.split('/').length - b.split('/').length
      }
      if (indexA !== indexB) {
        return indexA - indexB
      }
      return a.localeCompare(b)
    })
  return pages.map((path, order) => ({
    title: titleFromPath(path),
    path: path,
    link: `/${path.slice(prefix.length).replace(/\.md$/i, '')}`,
    depth: 0,
    order: order,
    parentIndex: null,
  }))
}

function titleFromPath(path) {
  const name = path.split('/').pop().replace(/\.md$/i, '')
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words === '' || words === 'index' ? 'Home' : words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A link to the markdown file that backs it. Sidebar links are site-absolute;
 * links inside a page may also be relative, so they resolve against the page
 * that carries them.
 */
function resolveDocPath(link, source, node) {
  let target = String(link).split('#')[0].split('?')[0]
  if (source.config.base && target.indexOf(source.config.base) === 0) {
    target = `/${target.slice(source.config.base.length)}`
  }
  target = target.replace(/\.(md|html)$/i, '').replace(/\/$/, '')
  const prefix = source.docsRoot === '' ? '' : `${source.docsRoot}/`
  let base = ''
  if (target.indexOf('/') === 0) {
    base = `${prefix}${target.replace(/^\//, '')}`
  }
  else if (node && node.path) {
    const directory = node.path.split('/').slice(0, -1).join('/')
    base = normalizePath(`${directory}/${target}`)
  }
  else {
    base = `${prefix}${target}`
  }
  base = base.replace(/\/+$/, '')
  if (base === '' || base === prefix.replace(/\/$/, '')) {
    return `${prefix}index.md`
  }
  const direct = `${base}.md`
  if (source.paths[direct]) {
    return direct
  }
  const nested = `${base}/index.md`
  if (source.paths[nested]) {
    return nested
  }
  return direct
}

function budgetExhausted(context) {
  return (Date.now() - context.startedAt) / 1000 > LIMITS.fetchBudgetSeconds
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/** Build the items, page bodies and file map for one repository. */
async function importSite(source) {
  const outline = source.config.sidebar
    ? outlineFromSidebar(source.config.sidebar, source)
    : outlineFromTree(source)
  if (outline.length === 0) {
    throw importError(422, 'The VitePress site has no pages to import')
  }
  const context = {
    source: source,
    files: {},
    fileNames: {},
    filesByPath: {},
    slugByPath: {},
    unmapped: {},
    startedAt: Date.now(),
    truncated: false,
  }
  const items = []
  // first pass: items and slugs, so page bodies can link to siblings by slug
  for (let i = 0; i < outline.length; i++) {
    const node = outline[i]
    const item = new JSONOutlineSchemaItem()
    item.title = node.title
    item.indent = node.depth
    item.order = node.order
    const parentItem = node.parentIndex === null ? null : items[node.parentIndex]
    item.parent = parentItem ? parentItem.id : null
    item.slug = parentItem ? `${parentItem.slug}/${titleSlug(node.title)}` : titleSlug(node.title)
    item.metadata = {
      sourceType: 'vitepress',
      vitepress: {
        repo: `${source.owner}/${source.name}`,
        branch: source.branch,
        path: node.path,
        license: source.license,
        author: source.config.defaultAuthor,
        workTitle: source.config.workTitle,
        accessed: source.accessed,
      },
    }
    const sourceUrl = pageSourceUrl(node, source)
    if (sourceUrl) {
      item.metadata.source = sourceUrl
    }
    items.push(item)
    node.item = item
    if (node.path) {
      context.slugByPath[node.path] = item.slug
    }
  }
  // second pass: page bodies, bounded by the page cap and the time budget
  let fetched = 0
  for (let i = 0; i < outline.length; i++) {
    const node = outline[i]
    if (!node.path) {
      // a sidebar group with no link of its own: a landing page for children
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
    const markdown = await fetchText(`${source.rawBase}/${encodeURI(node.path)}`)
    fetched++
    if (markdown === null) {
      node.item.contents = sourceFallback(node.item.metadata.source)
      continue
    }
    node.item.contents = renderPage(markdown, node, context)
  }
  return {
    items: items,
    files: context.files,
    truncated: context.truncated,
    unmappedComponents: Object.keys(context.unmapped).sort(),
  }
}

/** Where the page lives on the published VitePress site, when it says. */
function pageSourceUrl(node, source) {
  if (!node.link || !source.config.siteUrl) {
    return null
  }
  const base = source.config.base ? source.config.base.replace(/\/$/, '') : ''
  return `${source.config.siteUrl.replace(/\/$/, '')}${base}${node.link}`
}

function sourceFallback(source) {
  if (!source) {
    return '<p></p>'
  }
  const href = escapeHTMLAttribute(source)
  return `<p>Read this page on <a href="${href}">the source site</a>.</p>`
}

/** Split YAML frontmatter from the markdown body. */
function splitFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!match) {
    return { data: {}, body: markdown }
  }
  let data = {}
  try {
    const parsed = yaml.load(match[1])
    if (parsed && typeof parsed === 'object') {
      data = parsed
    }
  }
  catch (e) {
    data = {}
  }
  return { data: data, body: markdown.slice(match[0].length) }
}

/** A markdown-it that renders VitePress's footnotes and OER containers. */
function createRenderer() {
  const renderer = new MarkdownIt({ html: true, linkify: false })
  renderer.use(markdownItFootnote)
  Object.keys(OER_CONTAINERS).forEach((name) => {
    const container = OER_CONTAINERS[name]
    renderer.use(markdownItContainer, name, {
      render: (tokens, index) => {
        if (tokens[index].nesting !== 1) {
          return '</oer-schema>\n'
        }
        const info = tokens[index].info.trim().slice(name.length).trim()
        const attributes = parseAttributes(info)
        let open = `<oer-schema typeof="${escapeHTMLAttribute(container.resource)}">\n`
        Object.keys(attributes).forEach((key) => {
          const property = container.properties[key]
          if (property) {
            open +=
              `<oer-schema oer-property="${escapeHTMLAttribute(property)}"` +
              ` text="${escapeHTMLAttribute(attributes[key])}"></oer-schema>\n`
          }
        })
        return open
      },
    })
  })
  return renderer
}

/** name="value" pairs and bare flags out of a tag or container info string. */
function parseAttributes(source) {
  const attributes = {}
  const pattern = /([A-Za-z][A-Za-z0-9_:-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g
  let match = pattern.exec(source)
  while (match !== null) {
    const name = match[1]
    if (match[2] === undefined) {
      attributes[name] = 'true'
    }
    else {
      const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5]
      attributes[name] = String(value === undefined ? '' : value).trim().replace(/^['"]|['"]$/g, '')
    }
    match = pattern.exec(source)
  }
  return attributes
}

/**
 * One markdown page into HAX-ready HTML: Vue components are mapped or
 * unwrapped before rendering, then assets, links and images are rewritten
 * against the imported site.
 */
function renderPage(markdown, node, context) {
  const split = splitFrontmatter(markdown)
  if (typeof split.data.title === 'string' && split.data.title.trim() !== '') {
    node.item.title = split.data.title.trim()
  }
  const pageLicense = normalizeLicense(split.data.license) || context.source.license
  const author = typeof split.data.author === 'string' ? split.data.author : context.source.config.defaultAuthor
  if (pageLicense) {
    node.item.metadata.vitepress.license = pageLicense
  }
  if (author) {
    node.item.metadata.vitepress.author = author
  }
  const body = mapVueComponents(split.body, node, context)
  const html = createRenderer().render(body)
  const container = parse(`<div>${html}</div>`, { comment: false })
  rewriteMedia(container, node, context)
  rewriteLinks(container, node, context)
  let contents = container.innerHTML.replace(/^<div>/, '').replace(/<\/div>$/, '').trim()
  if (pageLicense) {
    contents += `\n${licenseElement(pageLicense, node, context, author)}`
  }
  return contents === '' ? '<p></p>' : contents
}

/**
 * VitePress pages embed Vue components. VideoEmbed is the one with a HAX
 * equivalent, so it becomes a video-player; anything else is unwrapped to its
 * content and reported in unmappedComponents rather than left as a tag the
 * site cannot render.
 */
function mapVueComponents(markdown, node, context) {
  let body = markdown.replace(/<VideoEmbed\b([\s\S]*?)\/?>(?:\s*<\/VideoEmbed>)?/g, (match, rawAttributes) => {
    const attributes = parseAttributes(rawAttributes)
    const source = typeof attributes.src === 'string' ? attributes.src : ''
    if (source === '') {
      return ''
    }
    const resolved = registerAsset(source, node, context) || absoluteSourceUrl(source, node, context)
    let tag = `<video-player source="${escapeHTMLAttribute(resolved)}"`
    if (attributes.title) {
      tag += ` media-title="${escapeHTMLAttribute(attributes.title)}"`
    }
    else if (attributes.caption) {
      tag += ` media-title="${escapeHTMLAttribute(attributes.caption)}"`
    }
    tag += '>'
    if (attributes.caption) {
      tag += `<div slot="caption">${escapeHTML(attributes.caption)}</div>`
    }
    return `${tag}</video-player>`
  })
  // any other PascalCase component: keep the content, drop the wrapper
  body = body.replace(/<\/?([A-Z][A-Za-z0-9]*)\b[^>]*>/g, (match, name) => {
    context.unmapped[name] = true
    return ''
  })
  return body
}

function escapeHTML(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Images become media-image; local videos become video-player. */
function rewriteMedia(container, node, context) {
  const images = container.querySelectorAll('img')
  for (let i = 0; i < images.length; i++) {
    const image = images[i]
    const source = image.getAttribute('src')
    if (!source) {
      continue
    }
    const resolved = registerAsset(source, node, context) || absoluteSourceUrl(source, node, context)
    const alt = escapeHTMLAttribute(image.getAttribute('alt') || '')
    if (IMAGE_EXTENSION_REGEX.test(resolved) || resolved.indexOf('files/') === 0) {
      image.replaceWith(`<media-image source="${escapeHTMLAttribute(resolved)}" alt="${alt}"></media-image>`)
    }
    else {
      image.setAttribute('src', resolved)
    }
  }
  const players = container.querySelectorAll('video-player')
  for (let i = 0; i < players.length; i++) {
    const player = players[i]
    const source = player.getAttribute('source')
    if (source && source.indexOf('files/') !== 0 && source.indexOf('http') !== 0) {
      const resolved = registerAsset(source, node, context) || absoluteSourceUrl(source, node, context)
      player.setAttribute('source', resolved)
    }
  }
}

/**
 * In-book links point at the imported slugs; links to importable files join
 * the file map; everything else is absolutized against the source repository.
 */
function rewriteLinks(container, node, context) {
  const links = container.querySelectorAll('a')
  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    const href = link.getAttribute('href')
    if (!href || href.indexOf('#') === 0 || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      continue
    }
    const docPath = resolveDocPath(href.split('#')[0], context.source, node)
    if (context.slugByPath[docPath]) {
      const hash = href.indexOf('#') === -1 ? '' : href.slice(href.indexOf('#'))
      link.setAttribute('href', `${context.slugByPath[docPath]}${hash}`)
      continue
    }
    const asset = registerAsset(href, node, context)
    link.setAttribute('href', asset || absoluteSourceUrl(href, node, context))
  }
}

/**
 * Resolve a page reference to a repository file and add it to the file map.
 * VitePress serves <docs>/public at the site root, so an absolute reference is
 * looked up there first and then under the docs root itself. Returns the
 * site-relative path, or null when the file is not importable.
 */
function registerAsset(reference, node, context) {
  if (typeof reference !== 'string' || reference === '' || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    return null
  }
  const clean = reference.split('#')[0].split('?')[0]
  if (clean === '' || !IMPORTABLE_ASSET_REGEX.test(clean)) {
    return null
  }
  const repoPath = resolveAssetPath(clean, node, context)
  if (repoPath === null) {
    return null
  }
  if (context.filesByPath[repoPath]) {
    return context.filesByPath[repoPath]
  }
  if (Object.keys(context.files).length >= LIMITS.maxFiles) {
    context.truncated = true
    return null
  }
  const name = uniqueFileName(repoPath, context)
  const sitePath = `files/${name}`
  context.files[sitePath] = encodeURI(`${context.source.rawBase}/${repoPath}`)
  context.filesByPath[repoPath] = sitePath
  return sitePath
}

/** An asset reference to a path inside the repository, or null. */
function resolveAssetPath(reference, node, context) {
  const prefix = context.source.docsRoot === '' ? '' : `${context.source.docsRoot}/`
  let candidates = []
  if (reference.indexOf('/') === 0) {
    let target = reference.replace(/^\//, '')
    if (context.source.config.base) {
      const base = context.source.config.base.replace(/^\//, '')
      if (target.indexOf(base) === 0) {
        target = target.slice(base.length)
      }
    }
    // public/ is served at the site root, so it wins over the docs root
    candidates = [`${prefix}public/${target}`, `${prefix}${target}`, target]
  }
  else {
    const directory = node.path ? node.path.split('/').slice(0, -1).join('/') : prefix.replace(/\/$/, '')
    candidates = [normalizePath(`${directory}/${reference}`)]
  }
  for (let i = 0; i < candidates.length; i++) {
    if (context.source.paths[candidates[i]]) {
      return candidates[i]
    }
  }
  return null
}

function normalizePath(path) {
  const parts = []
  path.split('/').forEach((piece) => {
    if (piece === '' || piece === '.') {
      return
    }
    if (piece === '..') {
      parts.pop()
      return
    }
    parts.push(piece)
  })
  return parts.join('/')
}

/** files/ is flat, so keep basenames unique across the import. */
function uniqueFileName(repoPath, context) {
  const base = repoPath.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!context.fileNames[base]) {
    context.fileNames[base] = true
    return base
  }
  const dot = base.lastIndexOf('.')
  const stem = dot === -1 ? base : base.slice(0, dot)
  const extension = dot === -1 ? '' : base.slice(dot)
  let counter = 1
  let candidate = `${stem}-${counter}${extension}`
  while (context.fileNames[candidate]) {
    counter++
    candidate = `${stem}-${counter}${extension}`
  }
  context.fileNames[candidate] = true
  return candidate
}

/**
 * A reference that stays remote - an extension createSite will not import, or
 * a file the repository does not actually carry - pointed at the source
 * repository so the page still resolves.
 */
function absoluteSourceUrl(reference, node, context) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    return reference
  }
  const clean = reference.split('#')[0].split('?')[0]
  const repoPath = resolveAssetPath(clean, node, context)
  if (repoPath !== null) {
    return encodeURI(`${context.source.rawBase}/${repoPath}`)
  }
  const prefix = context.source.docsRoot === '' ? '' : `${context.source.docsRoot}/`
  if (clean.indexOf('/') === 0) {
    return encodeURI(`${context.source.rawBase}/${prefix}${clean.replace(/^\//, '')}`)
  }
  const directory = node.path ? node.path.split('/').slice(0, -1).join('/') : prefix.replace(/\/$/, '')
  return encodeURI(`${context.source.rawBase}/${normalizePath(`${directory}/${clean}`)}`)
}

/** Attribution for one page, using the license code the source declared. */
function licenseElement(license, node, context, author) {
  const title = node.item.title || context.source.config.workTitle || context.source.title
  let element = `<license-element license="${escapeHTMLAttribute(license)}" title="${escapeHTMLAttribute(title)}"`
  if (author) {
    element += ` creator="${escapeHTMLAttribute(author)}"`
  }
  if (node.item.metadata && node.item.metadata.source) {
    element += ` source="${escapeHTMLAttribute(node.item.metadata.source)}"`
  }
  return `${element}></license-element>`
}

module.exports = { convertVitepressToSite, LIMITS }
