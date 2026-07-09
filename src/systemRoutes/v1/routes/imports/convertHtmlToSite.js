const { sanitizeUntrustedHtml } = require('../../../../lib/convertUtils.js')
const { importHtmlToItems } = require('../../../../siteRoutes/v1/importUtils.js')

/**
 * POST /system/api/v1/site/import/:platform
 * Convert HTML content (fetched from URL or uploaded file) into a HAXcms site schema.
 *
 * Accepts multipart/form-data with an .html file, or JSON with { repoUrl: string }.
 * Also accepts optional form/body fields: method, type, parentId.
 * Returns { status: 200, data: { items: [...], filename: string } }.
 */
async function convertHtmlToSite(req, res) {
  let html = ''
  let filename = null
  const contentType =
    req && req.headers && req.headers['content-type']
      ? req.headers['content-type']
      : ''

  if (contentType.indexOf('multipart/form-data') !== -1) {
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
  } else {
    let body = {}
    if (
      req &&
      req.body &&
      typeof req.body === 'object' &&
      !Array.isArray(req.body)
    ) {
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
    try {
      const response = await fetch(body.repoUrl)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      html = await response.text()
      filename = body.repoUrl.split('/').pop() || 'import.html'
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unable to fetch URL: ${e.message}`,
          items: [],
          filename: null,
        },
      })
    }
  }

  if (!html || html.trim() === '') {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Empty HTML content',
        items: [],
        filename: filename,
      },
    })
  }

  html = sanitizeUntrustedHtml(html)

  const method = req.body && req.body.method ? req.body.method : 'site'
  const type = req.body && req.body.type ? req.body.type : ''
  const parentId =
    req.body && req.body.parentId && req.body.parentId !== 'null'
      ? req.body.parentId
      : null

  const items = await importHtmlToItems(html, {
    titleValue: filename
      ? filename.replace(/\.(html|htm)$/i, '')
      : 'import',
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

module.exports = { convertHtmlToSite }
