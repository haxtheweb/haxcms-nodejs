const MarkdownIt = require('markdown-it');
const md = new MarkdownIt();

/**
 * POST /system/api/v1/actions/md-to-html
 * Convert Markdown string to HTML.
 *
 * Expects JSON body with { md: string, type?: 'link' }.
 * Returns { status: 200, data: { contents: html } }.
 */
async function convertMdToHtml(req, res) {
  try {
    let body = {};
    if (req && req.query && req.query.md) {
      body = req.query;
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    if (!body || !body.md) {
      return res.status(400).json({
        status: 400,
        data: { error: 'missing `md` param', contents: '' },
      });
    }

    let mdText = String(body.md || '');
    if (body.type === 'link' && mdText) {
      try {
        mdText = await fetch(mdText.trim()).then((d) => (d.ok ? d.text() : ''));
      } catch (e) {
        mdText = '';
      }
    }

    const html = md.render(mdText);
    return res.json({
      status: 200,
      data: {
        contents: html,
      },
    });
  } catch (error) {
    console.error('mdToHtml route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `Markdown to HTML conversion failed: ${error.message}`, contents: '' },
    });
  }
}

module.exports = { convertMdToHtml };
