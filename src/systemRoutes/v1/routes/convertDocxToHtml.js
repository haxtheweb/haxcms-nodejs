const { convertToHtml } = require('mammoth');
const { stripMSWord, processDocxHtml } = require('../../../lib/convertUtils.js');

/**
 * POST /system/api/v1/actions/docx-to-html
 * Convert an uploaded .docx file to clean HTML.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns { status: 200, data: { contents: html, filename: string } }.
 */
async function convertDocxToHtml(req, res) {
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
    if (!/\.docx$/i.test(originalname)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .docx, got: ${originalname}`,
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

    // Validate ZIP magic number (DOCX files are ZIP archives)
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is not a valid .docx file (missing ZIP signature). If this is a .doc file, convert it to .docx first.',
          contents: '',
          filename: originalname,
        },
      });
    }

    const mammothOptions = {
      styleMap: [
        'u => em',
        'strike => del',
      ],
    };

    let html = '';
    try {
      const result = await convertToHtml({ buffer: buffer }, mammothOptions);
      html = result.value;
      html = processDocxHtml(html);
      html = stripMSWord(html);
    } catch (e) {
      html = `Error converting document: ${e.message}`;
    }

    return res.json({
      status: 200,
      data: {
        contents: html,
        filename: originalname,
      },
    });
  } catch (error) {
    console.error('docxToHtml: Error processing file:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing Word document: ${error.message}`,
        contents: '',
        filename: originalname,
      },
    });
  }
}

module.exports = { convertDocxToHtml };
