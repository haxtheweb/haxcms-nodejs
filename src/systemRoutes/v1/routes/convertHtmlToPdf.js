const { htmlToPdfBuffer, validURL } = require('../../../lib/convertUtils.js');

/**
 * POST /system/api/v1/actions/html-to-pdf
 * Convert an uploaded HTML file to a PDF document (returned as base64).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * The uploaded file must have a .html or .htm extension.
 * An optional `base` form field may be provided for resolving relative URLs.
 * Returns { status: 200, data: { contents: base64String, filename: string } }.
 */
async function convertHtmlToPdf(req, res) {
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

    const rawBase = req.body && req.body.base ? String(req.body.base) : '/';
    // Security (EXPRESS-XSS-001 / L4): validate the base field as an http(s)
    // URL before injecting it into the PDF's <base> tag so a crafted value
    // cannot break the attribute quoting. Falls back to '/' for empty or
    // non-http(s) values rather than 400ing, so existing callers that pass a
    // relative path still work.
    const base = rawBase && rawBase !== '/' && validURL(rawBase) ? rawBase : '/';
    const pdfBuffer = await htmlToPdfBuffer(String(html), base);
    const pdfFilename = filename.replace(/\.(html|htm)$/i, '.pdf');
    return res.json({
      status: 200,
      data: {
        contents: pdfBuffer.toString('base64'),
        filename: pdfFilename,
      },
    });
  } catch (error) {
    console.error('htmlToPdf route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Error converting HTML to PDF: ' + error.message,
        contents: null,
        filename: filename,
      },
    });
  }
}

module.exports = { convertHtmlToPdf };
