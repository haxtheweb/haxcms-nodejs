const { importHtmlToItems } = require('../../../siteRoutes/v1/importUtils.js');

/**
 * POST /system/api/v1/actions/import-pptx
 * Convert an uploaded .pptx file into a HAXcms site schema (items array).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Also accepts form fields: method (site|branch|page), type (course|portfolio|''), parentId.
 * Returns { status: 200, data: { items: [...], filename: string } }.
 */
async function importPptx(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'No file uploaded',
          items: [],
          filename: null,
        },
      });
    }

    const file = req.files[0];
    filename = file.originalname;
    if (!/\.pptx$/i.test(filename)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .pptx, got: ${filename}`,
          items: [],
          filename: filename,
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
          items: [],
          filename: filename,
        },
      });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is empty',
          items: [],
          filename: filename,
        },
      });
    }

    // Validate ZIP magic number (PPTX files are ZIP archives)
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is not a valid .pptx file (missing ZIP signature).',
          items: [],
          filename: filename,
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

    const items = await importHtmlToItems(html, {
      titleValue: filename.replace(/\.pptx$/i, ''),
      method: req.body && req.body.method ? req.body.method : 'site',
      type: req.body && req.body.type ? req.body.type : '',
      parentId: req.body && req.body.parentId && req.body.parentId !== 'null' ? req.body.parentId : null,
    });

    return res.json({
      status: 200,
      data: {
        items: items,
        filename: filename,
      },
    });
  } catch (error) {
    console.error('pptxToSite: Error processing file:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing PPTX import: ${error.message}`,
        items: [],
        filename: filename,
      },
    });
  }
}

module.exports = { importPptx };
