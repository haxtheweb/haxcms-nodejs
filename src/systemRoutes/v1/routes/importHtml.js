const { sanitizeUntrustedHtml } = require('../../../lib/convertUtils.js')
const { importHtmlToItems } = require('../../../siteRoutes/v1/importUtils.js')

/**
 * POST /system/api/v1/actions/import-html
 * Convert an uploaded .html or .htm file into a HAXcms site schema (items array).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Also accepts form fields: method (site|branch|page), type (course|portfolio|''), parentId.
 * Returns { status: 200, data: { items: [...], filename: string } }.
 */
async function importHtml(req, res) {
  let filename = null
  try {
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
    let html
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
    if (!html || html.trim() === '') {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is empty',
          items: [],
          filename: filename,
        },
      })
    }

    html = sanitizeUntrustedHtml(html)

    const items = await importHtmlToItems(html, {
      titleValue: filename.replace(/\.(html|htm)$/i, ''),
      method: req.body && req.body.method ? req.body.method : 'site',
      type: req.body && req.body.type ? req.body.type : '',
      parentId: req.body && req.body.parentId && req.body.parentId !== 'null' ? req.body.parentId : null,
    })

    return res.json({
      status: 200,
      data: {
        items: items,
        filename: filename,
      },
    })
  } catch (error) {
    console.error('htmlToSite: Error processing file:', error.message)
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing HTML import: ${error.message}`,
        items: [],
        filename: filename,
      },
    })
  }
}

module.exports = { importHtml }
