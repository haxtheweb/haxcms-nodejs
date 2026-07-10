const { convertPdfBufferToHtml } = require('../../../lib/pdfToSemanticHtml.js')
const { importHtmlToItems } = require('../../../siteRoutes/v1/importUtils.js')

/**
 * POST /system/api/v1/actions/import-pdf
 * Convert an uploaded .pdf file into a HAXcms site schema (items array).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Also accepts form fields: method (site|branch|page), type (course|portfolio|''), parentId.
 * Returns { status: 200, data: { items: [...], filename: string } }.
 */
async function importPdf(req, res) {
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
    if (!/\.pdf$/i.test(filename)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .pdf, got: ${filename}`,
          items: [],
          filename: filename,
        },
      })
    }

    const fs = require('fs-extra')
    let buffer
    try {
      buffer = fs.readFileSync(file.path)
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
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is empty',
          items: [],
          filename: filename,
        },
      })
    }

    if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== '%PDF') {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is not a valid PDF.',
          items: [],
          filename: filename,
        },
      })
    }

    const html = await convertPdfBufferToHtml(buffer)
    const items = await importHtmlToItems(html, {
      titleValue: filename.replace(/\.pdf$/i, ''),
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
    console.error('pdfToSite: Error processing file:', error.message)
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing PDF import: ${error.message}`,
        items: [],
        filename: filename,
      },
    })
  }
}

module.exports = { importPdf }
