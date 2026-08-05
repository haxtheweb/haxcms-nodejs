const { convertHtmlToDocxBuffer } = require('../../../lib/convertUtils.js');

/**
 * POST /system/api/v1/actions/html-to-docx
 * Convert an uploaded HTML file to a DOCX document (returned as base64).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * The uploaded file must have a .html or .htm extension.
 * Returns { status: 200, data: { contents: base64String, filename: string } }.
 */
async function convertHtmlToDocx(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: { error: 'No file uploaded', contents: null, filename: null },
      });
    }

    const file = req.files[0];
    filename = file.originalname;
    if (!/\.(html|htm)$/i.test(filename)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Invalid file type. Expected .html or .htm, got: ' + filename,
          contents: null,
          filename: filename,
        },
      });
    }

    const fs = require('fs-extra');
    let html;
    try {
      html = fs.readFileSync(file.path, 'utf8');
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Unable to read uploaded file: ' + e.message,
          contents: null,
          filename: filename,
        },
      });
    }

    if (!html || String(html).trim() === '') {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is empty or unreadable',
          contents: null,
          filename: filename,
        },
      });
    }

    const docx = await convertHtmlToDocxBuffer(String(html));
    const docxFilename = filename.replace(/\.(html|htm)$/i, '.docx');
    return res.json({
      status: 200,
      data: {
        contents: docx.toString('base64'),
        filename: docxFilename,
      },
    });
  } catch (error) {
    console.error('HTMLtoDOCX route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Error converting HTML to DOCX: ' + error.message,
        contents: null,
        filename: filename,
      },
    });
  }
}

module.exports = { convertHtmlToDocx };
