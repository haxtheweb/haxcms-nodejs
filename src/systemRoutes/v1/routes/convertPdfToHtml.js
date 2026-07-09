const { convertPdfBufferToHtml } = require('../../../lib/pdfToSemanticHtml.js');

/**
 * POST /system/api/v1/actions/pdf-to-html
 * Convert an uploaded PDF file to semantic HTML.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns { status: 200, data: { contents: html, filename: string } }.
 */
async function convertPdfToHtml(req, res) {
  let originalname = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: { error: 'No file uploaded', contents: '', filename: null },
      });
    }

    const file = req.files[0];
    originalname = file.originalname;
    if (!/\.pdf$/i.test(originalname)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .pdf, got: ${originalname}`,
          contents: '',
          filename: originalname,
        },
      });
    }

    const fs = require('fs-extra');
    let buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unable to read uploaded file: ${e.message}`,
          contents: '',
          filename: originalname,
        },
      });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is empty',
          contents: '',
          filename: originalname,
        },
      });
    }

    // Validate PDF magic number
    if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== '%PDF') {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is not a valid PDF (missing %PDF signature).',
          contents: '',
          filename: originalname,
        },
      });
    }

    const html = await convertPdfBufferToHtml(buffer);
    return res.json({
      status: 200,
      data: {
        contents: html,
        filename: originalname,
      },
    });
  } catch (error) {
    console.error('pdfToHtml: Error processing file:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing PDF: ${error.message}`,
        contents: '',
        filename: originalname,
      },
    });
  }
}

module.exports = { convertPdfToHtml };
