const yaml = require('js-yaml');

/**
 * POST /system/api/v1/actions/json-to-yaml
 * Convert JSON to YAML string.
 *
 * Expects JSON body with { json: object|string, type?: 'link' }.
 * Returns { status: 200, data: { contents: yaml } }.
 */
async function convertJsonToYaml(req, res) {
  try {
    let body = {};
    if (req && req.query && req.query.json) {
      body = req.query;
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    if (!body || body.json === undefined || body.json === null) {
      return res.status(400).json({
        status: 400,
        data: { error: 'missing `json` param', contents: '' },
      });
    }

    let jsonData = body.json;
    if (body.type === 'link' && jsonData) {
      try {
        jsonData = await fetch(String(jsonData).trim()).then((d) => (d.ok ? d.text() : ''));
        jsonData = JSON.parse(jsonData);
      } catch (e) {
        return res.status(400).json({
          status: 400,
          data: { error: 'Failed to fetch or parse JSON from link', contents: '' },
        });
      }
    }

    if (typeof jsonData === 'string') {
      try {
        jsonData = JSON.parse(jsonData);
      } catch (e) {
        return res.status(400).json({
          status: 400,
          data: { error: 'Invalid JSON string provided', contents: '' },
        });
      }
    }

    const yamlOutput = yaml.dump(jsonData);
    return res.json({
      status: 200,
      data: {
        contents: yamlOutput,
      },
    });
  } catch (error) {
    console.error('jsonToYaml route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `JSON to YAML conversion failed: ${error.message}`, contents: '' },
    });
  }
}

module.exports = { convertJsonToYaml };