const { loadYamlBounded, YamlLimitError } = require('../../../lib/safeYaml.js');
const { safeFetch } = require('../../../lib/safeFetch.js');

/**
 * POST /system/api/v1/actions/yaml-to-json
 * Convert YAML string to JSON.
 *
 * Expects JSON body with { yaml: string, type?: 'link' }.
 * Returns { status: 200, data: { contents: jsonString } }.
 */
async function convertYamlToJson(req, res) {
  try {
    let body = {};
    if (req && req.query && req.query.yaml) {
      body = req.query;
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    if (!body || body.yaml === undefined || body.yaml === null || String(body.yaml).trim() === '') {
      return res.status(400).json({
        status: 400,
        data: { error: 'missing `yaml` param', contents: '' },
      });
    }

    let yamlData = String(body.yaml || '');
    if (body.type === 'link' && yamlData) {
      try {
        yamlData = await safeFetch(yamlData.trim()).then((d) => (d.ok ? d.text() : ''));
      } catch (e) {
        return res.status(400).json({
          status: 400,
          data: { error: 'Failed to fetch YAML from link', contents: '' },
        });
      }
    }

    if (typeof yamlData !== 'string' || yamlData.trim() === '') {
      return res.status(400).json({
        status: 400,
        data: { error: 'Invalid or empty YAML content', contents: '' },
      });
    }

    // Security (review 2026-10): 256 KB input cap + expanded-node budget so an
    // alias bomb cannot make JSON.stringify allocate gigabytes (296 bytes of
    // YAML previously produced 69 MB of JSON; ~380 bytes OOM'd the process).
    let jsonOutput;
    try {
      jsonOutput = loadYamlBounded(yamlData);
    } catch (e) {
      if (e instanceof YamlLimitError) {
        return res.status(400).json({
          status: 400,
          data: { error: e.message, contents: '' },
        });
      }
      throw e;
    }
    const jsonString = JSON.stringify(jsonOutput, null, 2);
    return res.json({
      status: 200,
      data: {
        contents: jsonString,
      },
    });
  } catch (error) {
    console.error('yamlToJson route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `YAML to JSON conversion failed: ${error.message}`, contents: '' },
    });
  }
}

module.exports = { convertYamlToJson };