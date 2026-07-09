const TurndownService = require('turndown');
const turndownService = new TurndownService();

/**
 * POST /system/api/v1/actions/html-to-md
 * Convert HTML string to Markdown.
 *
 * Expects JSON body with { html: string, type?: 'link' }.
 * Returns { status: 200, data: { contents: markdown } }.
 */
async function convertHtmlToMd(req, res) {
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
        data: { error: 'missing `html` param', contents: '' },
      });
    }

    let html = String(body.html || '');
    if (body.type === 'link' && html) {
      try {
        html = await fetch(html.trim()).then((d) => (d.ok ? d.text() : ''));
      } catch (e) {
        html = '';
      }
    }

    if (typeof html !== 'string') {
      html = String(html || '');
    }

    const markdown = turndownService.turndown(html);
    return res.json({
      status: 200,
      data: {
        contents: markdown,
      },
    });
  } catch (error) {
    console.error('htmlToMd route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `HTML to Markdown conversion failed: ${error.message}`, contents: '' },
    });
  }
}

module.exports = { convertHtmlToMd };
