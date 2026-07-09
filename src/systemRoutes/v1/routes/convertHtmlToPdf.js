const { htmlToPdfBuffer } = require('../../../lib/convertUtils.js');

/**
 * POST /system/api/v1/actions/html-to-pdf
 * Convert HTML string to a PDF document (returned as base64).
 *
 * Expects JSON body with { html: string, base?: string }.
 * Returns { status: 200, data: base64String }.
 */
async function convertHtmlToPdf(req, res) {
  try {
    let body = {};
    if (req && req.query && req.query.html) {
      body = req.query;
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    if (!body || !body.html) {
      return res.status(400).json({
        status: 400,
        data: { error: 'missing `html` param' },
      });
    }

    const html = String(body.html || '');
    const base = String(body.base || '/');

    const pdfBuffer = await htmlToPdfBuffer(html, base);
    return res.json({
      status: 200,
      data: pdfBuffer.toString('base64'),
    });
  } catch (error) {
    console.error('htmlToPdf route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `HTML to PDF conversion failed: ${error.message}` },
    });
  }
}

module.exports = { convertHtmlToPdf };
