const { convertToHtml } = require('mammoth');
const { stripMSWord, processDocxHtml, htmlToPdfBuffer } = require('../../../lib/convertUtils.js');

/**
 * POST /system/api/v1/actions/docx-to-pdf
 * Convert an uploaded .docx or .doc file to a PDF document.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns the PDF as a binary download response.
 */
async function convertDocxToPdf(req, res) {
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
    const validExtensions = ['.docx', '.doc'];
    const hasValidExtension = validExtensions.some((ext) =>
      originalname.toLowerCase().endsWith(ext)
    );

    if (!hasValidExtension) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .docx or .doc, got: ${originalname}`,
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
      return res.status(400).json({
        status: 400,
        data: {
          error: `Error converting document to HTML: ${e.message}`,
          contents: '',
          filename: originalname,
        },
      });
    }

    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdfBuffer(html);
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Error converting HTML to PDF: ${e.message}`,
          contents: '',
          filename: originalname,
        },
      });
    }

    const pdfFilename = originalname.replace(/\.docx?$/i, '.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${pdfFilename}"`,
    );
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('docxToPdf: Error processing file:', error.message);
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

module.exports = { convertDocxToPdf };
