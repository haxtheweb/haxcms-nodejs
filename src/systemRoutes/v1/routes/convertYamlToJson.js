const { safeFetch } = require('../../../lib/safeFetch.js');
const {
  loadYamlSafely,
  YAML_MAX_INPUT_BYTES,
  YAML_TOO_LARGE_ERROR_MESSAGE,
} = require('../../../lib/safeYaml.js');

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
        // Security (SEC-SSRF): cap the remote body at the YAML input limit.
        yamlData = await safeFetch(yamlData.trim(), { maxBytes: YAML_MAX_INPUT_BYTES }).then((d) => (d.ok ? d.text() : ''));
      } catch (e) {
        if (e && e.code === 'SSRF_TOO_LARGE') {
          return res.status(400).json({
            status: 400,
            data: { error: YAML_TOO_LARGE_ERROR_MESSAGE, contents: '' },
          });
        }
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

    // Security (SEC-SSRF): 256 KB input cap + anchors/aliases rejected
    // (alias amplification); both answer 400 with a stable message.
    let jsonOutput;
    try {
      jsonOutput = loadYamlSafely(yamlData);
    } catch (policyError) {
      if (policyError && (policyError.code === 'YAML_TOO_LARGE' || policyError.code === 'YAML_ALIAS')) {
        return res.status(400).json({
          status: 400,
          data: { error: policyError.message, contents: '' },
        });
      }
      throw policyError;
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