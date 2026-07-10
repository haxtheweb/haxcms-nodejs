const { parse } = require('node-html-parser')
const MarkdownIt = require('markdown-it')
const JSONOutlineSchema = require('../../../../lib/JSONOutlineSchema.js')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')

const mdClass = new MarkdownIt()

/**
 * POST /system/api/v1/actions/convert-gitbook-to-site
 * Convert a Gitbook repository (or SUMMARY.md link) into a HAXcms site schema.
 *
 * Expects JSON body with `md` param (URL to SUMMARY.md or GitHub repo URL).
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
  if (!body || !body.md) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing `md` param',
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  try {
    const sourceLink = body.md
    let tmp = new URL(sourceLink)
    // ensure we go from github to raw git response for the md
    if (tmp.href.indexOf('github.com') !== -1) {
      tmp.href = tmp.href.replace('github.com', 'raw.githubusercontent.com')
    }
    // if we have /blob/ that's on the frontend so remove it from the path
    if (tmp.href.indexOf('/blob/') !== -1) {
      tmp.href = tmp.href.replace('/blob/', '/')
    }
    // if we lack summary, add it in
    if (tmp.href.indexOf('SUMMARY.md') === -1) {
      tmp.href += '/master/SUMMARY.md'
    }
    let url = sourceLink.trim()
    let pieces = url.replace('https://github.com/', '').split('/')
    const owner = pieces[0]
    const repo = pieces[1]
    let basePath = `https://api.github.com/repos/${owner}/${repo}`
    var branch = await fetch(`${basePath}`).then((d) => d.ok ? d.json() : {}).then((d) => d.default_branch || 'main')
    var filepathBase = ''
    var githubData = await fetch(`${basePath}/git/trees/${branch}?recursive=1`).then((d) => d.ok ? d.json() : {}).then((d) => d.tree || [])

    var downloads = {}
    var fileMap = {}

    // establish file map and base path for all files PRIOR to getting contents
    for (const ghFile of githubData) {
      if (ghFile.path.indexOf('.md') === -1) {
        // ignore folders
        if (ghFile.path.indexOf('.') !== -1) {
          downloads[encodeURI(`files/${ghFile.path}`)] = encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ghFile.path}`)
          fileMap[encodeURI(`files/${ghFile.path}`)] = encodeURI(ghFile.path.replace(`${filepathBase}/`, ''))
        }
      }
    }

    let md = await fetch(tmp.href.trim()).then((d) => d.ok ? d.text() : '')
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
      if (!a) {
        continue
      }
      let item = new JSONOutlineSchemaItem()
      item.title = a.text
      item.parent = ''
      item.order = index
      item.indent = 0
      item.slug = a.getAttribute('href')
      item.location = `content/${a.getAttribute('href')}`
      let mdContent = await fetch(sourceLink.replace('SUMMARY.md', a.getAttribute('href'))).then((d) => d.ok ? d.text() : '')
      item.contents = mdClass.render(mdContent)
      // replace all file references
      for (const file of Object.keys(fileMap)) {
        item.contents = item.contents.replaceAll(fileMap[file], file)
      }
      site.addItem(item)
      // see if we have items under here
      let nested = node.querySelector('ul')
      if (nested) {
        await recurseToJOS(site, item, nested, 1, sourceLink, downloads, fileMap)
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
      if (!a) {
        continue
      }
      let item = new JSONOutlineSchemaItem()
      item.title = a.text
      item.parent = parent.id
      item.order = index
      item.indent = depth
      item.slug = a.getAttribute('href')
      item.location = `content/${a.getAttribute('href')}`
      let mdContent = await fetch(sourceLink.replace('SUMMARY.md', a.getAttribute('href'))).then((d) => d.ok ? d.text() : '')
      item.contents = mdClass.render(mdContent)
      // replace all file references
      for (const file of Object.keys(fileMap)) {
        item.contents = item.contents.replaceAll(fileMap[file], file)
      }
      site.addItem(item)
      // see if we have items under here
      let nested = node.querySelector('ul')
      if (nested) {
        await recurseToJOS(site, item, nested, depth + 1, sourceLink, downloads, fileMap)
      }
    }
  }
}

module.exports = { convertGitbookToSite }
