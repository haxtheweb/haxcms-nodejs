const { HAXCMS } = require('../lib/HAXCMS.js');
const fs = require('fs');
const YAML = require('yaml');

// API meta endpoint mirroring PHP Operations::api behavior
// Returns the OpenAPI definition in YAML with dynamic version and server URL
function isSystemV1Request(req) {
  if (!req || !req.route || typeof req.route.path !== 'string') {
    return false;
  }
  return (
    req.route.path === '/system/api/v1' ||
    req.route.path.indexOf('/system/api/v1/') !== -1
  );
}
async function apiRoute(req, res) {
  res.setHeader('Content-Type', 'application/yaml');
  let openapi = {};
  const isSystemV1 = isSystemV1Request(req);
  const specPath = isSystemV1
    ? `${__dirname}/../openapi/system-spec.yaml`
    : `${__dirname}/../openapi/spec.yaml`;
  try {
    const fileContents = await fs.readFileSync(specPath,
      { encoding: 'utf8', flag: 'r' }, 'utf8');
    openapi = YAML.parse(fileContents);
  }
  catch (e) {
    // if something went wrong, surface a minimal error structure
    return res.status(500).send('# failed to load OpenAPI spec');
  }
  // dynamically add the version and server URL as PHP does
  openapi.info = openapi.info || {};
  openapi.info.version = await HAXCMS.getHAXCMSVersion();
  openapi.servers = [];
  const systemApiBase = isSystemV1
    ? `${HAXCMS.systemRequestBase}v1/`
    : HAXCMS.systemRequestBase;
  openapi.servers[0] = {
    url: `${HAXCMS.protocol}://${HAXCMS.domain}${HAXCMS.basePath}${systemApiBase}`,
    description: isSystemV1
      ? 'System v1 control-plane API'
      : 'Site list / dashboard for administrator user',
  };
  res.send(YAML.stringify(openapi));
}

module.exports = apiRoute;
