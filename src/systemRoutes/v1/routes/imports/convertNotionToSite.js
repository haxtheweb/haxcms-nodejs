const { parse } = require('node-html-parser')
const MarkdownIt = require('markdown-it')
const JSONOutlineSchema = require('../../../../lib/JSONOutlineSchema.js')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')
const { HAXCMS } = require('../../../../lib/HAXCMS.js')

const mdClass = new MarkdownIt()

/**
 * POST /system/api/v1/actions/convert-notion-to-site
 * Convert a Notion-exported GitHub repository into a HAXcms site schema.
 *
 * Expects JSON body with `repoUrl` param (GitHub repository URL).
 * Returns { status: 200, data: { items: [...], filename: string, files: {...} } }.
 */
async function convertNotionToSite(req, res) {
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
    // pull head matter out of the notion MD files
    const reg1 = new RegExp(/#\s(.*?)\n\n?(.*?):\s(.*)\n(.*?):\s((.|\n)*?)\n\n/, 'igm')
    // pull title out of the head matter
    const reg2 = new RegExp(/(#\s)(.*?)\n/)
    // pull data out of the head matter into properties
    const reg3 = new RegExp(/(.*?)(:\s)(.*)/, 'igm')

    let url = body.repoUrl.trim()
    let pieces = url.replace('https://github.com/', '').split('/')
    const owner = pieces[0]
    const repo = pieces[1]
    let basePath = `https://api.github.com/repos/${owner}/${repo}`
    var branch = await fetch(`${basePath}`).then((d) => d.ok ? d.json() : {}).then((d) => d.default_branch || 'main')
    var downloads = {}
    var fileMap = {}
    var lessons = {}
    var filepathBase = ''
    var githubData = await fetch(`${basePath}/git/trees/${branch}?recursive=1`).then((d) => d.ok ? d.json() : {}).then((d) => d.tree || [])

    const site = new JSONOutlineSchema()

    // establish file map and base path for all files PRIOR to getting contents
    for (const ghFile of githubData) {
      if (ghFile.path.indexOf('.csv') !== -1) {
        filepathBase = ghFile.path.replace('.csv', '')
      }
      else if (ghFile.path.indexOf('.md') === -1) {
        // it's a file that we need to account for later on when we download the files
        // ignore folders
        if (ghFile.path.indexOf('.') !== -1) {
          downloads[encodeURI(ghFile.path.replace(`${filepathBase}/`, 'files/')).replaceAll('%20', '').replaceAll('%C', '').replaceAll('%', '')] = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURI(ghFile.path)}`
          fileMap[encodeURI(ghFile.path.replace(`${filepathBase}/`, 'files/')).replaceAll('%20', '').replaceAll('%C', '').replaceAll('%', '')] = encodeURI(ghFile.path.replace(`${filepathBase}/`, ''))
        }
      }
    }

    for (const ghFile of githubData) {
      if (ghFile.path.indexOf('.csv') !== -1) {
        // skip csv
      }
      else if (ghFile.path.indexOf('.md') === -1) {
        // skip non-md files
      }
      else {
        var md = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ghFile.path}`).then((d) => d.ok ? d.text() : '')
        let data = {
          title: null,
          content: null,
          values: {}
        }

        // pull head matter out into variables
        let headMatterMatch = md.match(reg1)
        let headMatter = headMatterMatch && headMatterMatch.length > 0 ? headMatterMatch[0] : ''
        if (headMatter !== '') {
          data.title = headMatter.match(reg2) ? headMatter.match(reg2)[2] : ''
          let reg3Matches = headMatter.match(reg3)
          if (reg3Matches && reg3Matches.map) {
            reg3Matches.map((line) => {
              let parts = line.split(':')
              if (parts.length >= 2) {
                data.values[parts[0].trim().toLowerCase()] = parts[1].trim()
              }
            })
          }
        }
        // test for lesson that we don't have yet
        if (data.values.lesson && !lessons[data.values.lesson]) {
          let lessonValue = data.values.lesson.split('. ')
          if (lessonValue.length === 1) {
            // no period
            lessonValue = [
              '0',
              lessonValue[0]
            ]
          }
          let lesson = new JSONOutlineSchemaItem()
          lesson.title = lessonValue[1]
          // blank page for now
          lesson.contents = ''
          lesson.slug = HAXCMS.cleanTitle(lessonValue[1].toLowerCase())
          // path clean up a bit in file name even
          lesson.location = `content/${HAXCMS.cleanTitle(lessonValue[1].toLowerCase())}.html`
          // order is like 10.1
          lesson.order = parseInt(lessonValue[0])
          // only 0 depth for lessons
          lesson.indent = 0
          lesson.parent = ''
          lesson.metadata.pageType = 'lesson'
          site.items.push(lesson)
          lessons[data.values.lesson] = lesson
        }
        // remove head matter from the md
        md = md.replace(headMatter, '')
        // replace all file references that we got matches on PRIOR to rendering to avoid encoding issues
        for (const file of Object.keys(fileMap)) {
          md = md.replaceAll(fileMap[file], file)
        }
        data.content = mdClass.render(md)
        let item = new JSONOutlineSchemaItem()
        item.title = data.title
        item.contents = data.content
        item.slug = HAXCMS.cleanTitle(ghFile.path.replace(`${filepathBase}/`, '').replace('.md', ''))
        // path clean up a bit in file name even
        item.location = `content/${HAXCMS.cleanTitle(ghFile.path.replace(`${filepathBase}/`, '').replace('.md', ''))}.html`
        // order is like 10.1
        item.order = data.values.id ? parseInt(data.values.id.split('.').pop()) : 0
        // only 1 depth
        item.indent = 1
        // sanity check on lesson for a matching ID
        if (lessons[data.values.lesson]) {
          item.parent = lessons[data.values.lesson].id
        }
        else {
          item.parent = ''
        }
        // @todo need to clean these up as far as what we allow for legit types after we get our ontology
        switch (data.values.type) {
          case '📙 Reading':
            item.metadata.pageType = 'reading'
            break
          case '💬 Canvas Discussion':
            item.metadata.pageType = 'discuss'
            break
          case '⚡️ Exercise':
            item.metadata.pageType = 'activity'
            break
          case '🔎 Case Study':
            item.metadata.pageType = 'connection'
            break
        }
        site.items.push(item)
      }
    }

    return res.json({
      status: 200,
      data: {
        items: site.items,
        filename: repo,
        files: downloads
      }
    })
  }
  catch (error) {
    console.error('convertNotionToSite error:', error.message)
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error converting Notion: ${error.message}`,
        items: [],
        filename: null,
        files: {}
      }
    })
  }
}

module.exports = { convertNotionToSite }
