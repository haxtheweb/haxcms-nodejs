const { parse } = require('node-html-parser')
const MarkdownIt = require('markdown-it')
const JSONOutlineSchema = require('../../../../lib/JSONOutlineSchema.js')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { safeFetch } = require('../../../../lib/safeFetch.js')

const mdClass = new MarkdownIt()

// Escape regex metacharacters in a literal string so it can be safely
// embedded in a RegExp. Filenames in a gitbook repo can contain ., (), @, -, etc.,
// so . and () (and the rest) must be escaped before building the rewrite regex.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * POST /system/api/v1/actions/convert-gitbook-to-site
 * Convert a Gitbook repository (or SUMMARY.md link) into a HAXcms site schema.
 *
 * Expects JSON body with `repoUrl` param (URL to SUMMARY.md or GitHub repo URL).
 * Returns { status: 200, data: { items: [...], filename: string, files: {...} } }.
 */
async function convertGitbookToSite(req, res) {
  let body = {}
  if (req && req.body && typeof req.body === 'object') {
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

  try {
    const sourceLink = body.repoUrl
    let url = sourceLink.trim()
    let pieces = url.replace('https://github.com/', '').split('/')
    const owner = pieces[0]
    const repo = pieces[1]
    let basePath = `https://api.github.com/repos/${owner}/${repo}`
    // GitHub API requires a User-Agent header; without it every call 403s
    // and the .then((d) => d.ok ? d.json() : {}) swallows the 403 into {},
    // so default_branch becomes undefined -> 'main' fallback -> the tree fetch
    // also 403s -> zero files in the downloads map (images silently
    // dropped). PHP parity: haxcms-php convertGitbookToSite.php already sends
    // 'User-Agent: HAXcms-Import/1.0'. Mirrors that here.
    const githubApiHeaders = {
      'User-Agent': 'HAXcms-Import/1.0',
      'Accept': 'application/vnd.github.v3+json',
    }
    var branch = await safeFetch(`${basePath}`, { headers: githubApiHeaders })
      .then((d) => d.ok ? d.json() : {})
      .then((d) => d.default_branch || 'main')
    var filepathBase = ''
    var githubData = await safeFetch(`${basePath}/git/trees/${branch}?recursive=1`, { headers: githubApiHeaders })
      .then((d) => d.ok ? d.json() : {})
      .then((d) => d.tree || [])

    var downloads = {}
    var fileMap = {}


    // establish file map and base path for all files PRIOR to getting contents
    for (const ghFile of githubData) {
      if (ghFile.path.indexOf('.md') === -1) {
        // ignore folders
        if (ghFile.path.indexOf('.') !== -1) {
          downloads[encodeURI(`files/${ghFile.path}`)] = encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ghFile.path}`)
          // fileMap value is the repo-relative path as it appears in page content
          // (e.g. "assets/image.png"). Only strip a filepathBase PREFIX when one
          // was actually resolved; filepathBase is '' here, so the old
          // .replace(`${filepathBase}/`, '') became .replace('/', '') which
          // stripped the FIRST slash and corrupted "assets/image.png" ->
          // "assetsimage.png", so the content rewrite never matched.
          const strippedPath = filepathBase !== '' ? ghFile.path.replace(`${filepathBase}/`, '') : ghFile.path
          fileMap[encodeURI(`files/${ghFile.path}`)] = encodeURI(strippedPath)
        }
      }
    }

    // Build the SUMMARY.md fetch URL from the resolved branch (not hardcoded
    // 'master') so repos whose default branch is 'main' still resolve. The
    // tree fetch above already used ${branch}; the SUMMARY.md fetch must use
    // the same ref or it 404s on a 'main'-default repo.
    let tmp = new URL(sourceLink)
    // ensure we go from github to raw git response for the md
    if (tmp.href.indexOf('github.com') !== -1) {
      tmp.href = tmp.href.replace('github.com', 'raw.githubusercontent.com')
    }
    // if we have /blob/ that's on the frontend so remove it from the path
    if (tmp.href.indexOf('/blob/') !== -1) {
      tmp.href = tmp.href.replace('/blob/', '/')
    }
    // if we lack summary, add it in (using the resolved branch)
    if (tmp.href.indexOf('SUMMARY.md') === -1) {
      tmp.href += `/${branch}/SUMMARY.md`
    }
    let md = await safeFetch(tmp.href.trim()).then((d) => d.ok ? d.text() : '')
    let name = tmp.pathname.split('/')[1] || 'New site'
    const site = new JSONOutlineSchema()
    const JOS = await listToJOS(site, md, tmp.href.trim(), name, downloads, fileMap)

    return res.json({
      status: 200,
      data: {
        items: JOS.items,
        filename: name,
        files: downloads
      }
    })
  }
  catch (error) {
    console.error('convertGitbookToSite error:', error.message)
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error converting Gitbook: ${error.message}`,
        items: [],
        filename: null,
        files: {}
      }
    })
  }
}

async function listToJOS(site, md, sourceLink, name, downloads, fileMap) {
  const html = mdClass.render(md)
  const doc = parse(`<div>${html}</div>`)
  let top = doc.querySelector('ul')
  if (!top) {
    return site
  }
  for (const index in top.childNodes) {
    let node = top.childNodes[index]
    if (node.tagName === 'LI') {
      let a = node.querySelector('a')
      let item = null
      if (a) {
        item = new JSONOutlineSchemaItem()
        item.title = a.text
        item.parent = ''
        item.order = index
        item.indent = 0
        item.slug = a.getAttribute('href')
        item.location = `content/${a.getAttribute('href')}`
        let mdContent = await safeFetch(sourceLink.replace('SUMMARY.md', a.getAttribute('href'))).then((d) => d.ok ? d.text() : '')
        item.contents = mdClass.render(mdContent)
        // Rewrite all file references. Gitbook markdown renders image srcs as
        // absolute paths (e.g. "/assets/x.png"), so both the bare relative
        // form ("assets/x.png") and the leading-slash form ("/assets/x.png")
        // must be rewritten to the files/-prefixed key ("files/assets/x.png") so
        // the on-disk file location matches the page reference. Do it in ONE
        // regex pass per file with a negative lookbehind for files/ so the bare
        // form (a substring of the leading-slash form) can't double-rewrite
        // /assets/x.png -> files/assets/x.png -> files/files/assets/x.png.
        for (const file of Object.keys(fileMap)) {
          const stripped = fileMap[file]
          const re = new RegExp('(?<!files/)/?' + escapeRegExp(stripped), 'g')
          item.contents = item.contents.replace(re, file)
        }
        site.items.push(item)
      }
      // see if we have items under here
      let nested = node.querySelector('ul')
      if (nested) {
        let parentItem = item
        if (!parentItem) {
          parentItem = { id: '' }
        }
        await recurseToJOS(site, parentItem, nested, 1, sourceLink, downloads, fileMap)
      }
    }
  }
  return site
}

async function recurseToJOS(site, parent, top, depth, sourceLink, downloads, fileMap) {
  for (const index in top.childNodes) {
    let node = top.childNodes[index]
    if (node.tagName === 'LI') {
      let a = node.querySelector('a')
      let item = null
      if (a) {
        item = new JSONOutlineSchemaItem()
        item.title = a.text
        item.parent = parent.id
        item.order = index
        item.indent = depth
        item.slug = a.getAttribute('href')
        item.location = `content/${a.getAttribute('href')}`
        let mdContent = await safeFetch(sourceLink.replace('SUMMARY.md', a.getAttribute('href'))).then((d) => d.ok ? d.text() : '')
        item.contents = mdClass.render(mdContent)
        // rewrite all file references (single regex pass per file, see above)
        for (const file of Object.keys(fileMap)) {
          const stripped = fileMap[file]
          const re = new RegExp('(?<!files/)/?' + escapeRegExp(stripped), 'g')
          item.contents = item.contents.replace(re, file)
        }
        site.items.push(item)
      }
      // see if we have items under here
      let nested = node.querySelector('ul')
      if (nested) {
        let parentItem = item
        if (!parentItem) {
          parentItem = { id: parent.id }
        }
        await recurseToJOS(site, parentItem, nested, depth + 1, sourceLink, downloads, fileMap)
      }
    }
  }
}

module.exports = { convertGitbookToSite }
