const pretty = require('pretty');

/**
 * POST /system/api/v1/actions/pretty-html
 * Pretty-print HTML string.
 *
 * Expects JSON body with { html: string, type?: 'link' }.
 * Returns { status: 200, data: { contents: prettyHtml } }.
 */
async function convertPrettyHtml(req, res) {
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

    const prettyHtml = await pretty(html, { ocd: true });
    return res.json({
      status: 200,
      data: {
        contents: prettyHtml,
      },
    });
  } catch (error) {
    console.error('prettyHtml route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `HTML pretty-print failed: ${error.message}`, contents: '' },
    });
  }
}

module.exports = { convertPrettyHtml };