/**
 * POST /system/api/v1/actions/pptx-to-html
 * Convert an uploaded PPTX file to HTML.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns { status: 200, data: { contents: html, filename: string, files?: object } }.
 */
async function convertPptxToHtml(req, res) {
  let originalname = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: { error: 'No file uploaded', contents: '', filename: null, files: {} },
      });
    }

    const file = req.files[0];
    originalname = file.originalname;
    if (!/\.pptx$/i.test(originalname)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .pptx, got: ${originalname}`,
          contents: '',
          filename: originalname,
          files: {},
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
          files: {},
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
          files: {},
        },
      });
    }

    // Validate ZIP magic number (PPTX files are ZIP archives)
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is not a valid .pptx file (missing ZIP signature).',
          contents: '',
          filename: originalname,
          files: {},
        },
      });
    }

    const { PPTXInHTMLOut } = await import('../../../lib/vendor/pptx-in-html-out/src/index.js');
    const converter = new PPTXInHTMLOut(buffer);
    const html = await converter.toHTML({
      includeStyles: false,
      inlineImages: false,
      fullDocument: false,
    });
    const files = await converter.getExtractedFiles() || {};

    return res.json({
      status: 200,
      data: {
        contents: html,
        filename: originalname,
        files: files,
      },
    });
  } catch (error) {
    console.error('pptxToHtml: Error processing file:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing PPTX: ${error.message}`,
        contents: '',
        filename: originalname,
        files: {},
      },
    });
  }
}

module.exports = { convertPptxToHtml };
