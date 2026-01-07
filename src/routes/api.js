const { HAXCMS } = require('../lib/HAXCMS.js');
const fs = require('fs');
const YAML = require('yaml');

// API meta endpoint mirroring PHP Operations::api behavior
// Returns the OpenAPI definition in YAML with dynamic version and server URL
async function apiRoute(req, res) {
  res.setHeader('Content-Type', 'application/yaml');
  let openapi = {};
  try {
    const fileContents = await fs.readFileSync(`${__dirname}/../openapi/spec.yaml`,
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
  openapi.servers[0] = {
    url: `${HAXCMS.protocol}://${HAXCMS.domain}${HAXCMS.basePath}${HAXCMS.systemRequestBase}`,
    description: 'Site list / dashboard for administrator user',
  };
  res.send(YAML.stringify(openapi));
}

module.exports = apiRoute;
