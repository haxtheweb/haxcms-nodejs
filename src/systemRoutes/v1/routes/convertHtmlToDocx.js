const { convertHtmlToDocxBuffer } = require('../../../lib/convertUtils.js');

/**
 * POST /system/api/v1/actions/html-to-docx
 * Convert HTML string to a DOCX document (returned as base64).
 *
 * Expects JSON body with { html: string }.
 * Returns { status: 200, data: base64String }.
 */
async function convertHtmlToDocx(req, res) {
  try {
    if (!req.body || typeof req.body !== 'object' || !req.body.html) {
      return res.status(400).json({
        status: 400,
        data: { error: 'missing `html` param' },
      });
    }

    const html = String(req.body.html || '');
    if (!html) {
      return res.status(400).json({
        status: 400,
        data: { error: 'missing `html` param' },
      });
    }

    const docx = await convertHtmlToDocxBuffer(html);
    return res.json({
      status: 200,
      data: docx.toString('base64'),
    });
  } catch (error) {
    console.error('HTMLtoDOCX route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `HTML to DOCX conversion failed: ${error.message}` },
    });
  }
}

module.exports = { convertHtmlToDocx };
