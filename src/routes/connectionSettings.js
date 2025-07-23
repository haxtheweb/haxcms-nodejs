const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');
const url = require('url');

/**
 * @OA\Get(
 *    path="/connectionSettings",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="Generate the connection settings dynamically for implying we have a backend"
 *   )
 * )
 */
async function connectionSettings(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  const themes = JSON.parse(await fs.readFileSync(path.join(HAXCMS.coreConfigPath, "themes.json"), 'utf8'));
  // this is the correct base if we're being called for connection from inside a site
  let baseAPIPath = HAXCMS.basePath + HAXCMS.systemRequestBase;
  // top level haxcms listing can't include basePath as it's the root already
  if (req.headers && req.headers.referer && !req.headers.referer.includes('/sites/')) {
    baseAPIPath = HAXCMS.systemRequestBase;
  }
  var sitename = '';
  // express gives this up on requests but doesn't know it ahead of time
  if (req.headers && req.headers.referer) {
    let details = new url.URL(req.headers.referer);
    HAXCMS.protocol = details.protocol.replace(':', '');
    HAXCMS.domain = details.host;
    HAXCMS.request_url = details;

    const sitepath = req.headers.referer.replace(`${HAXCMS.protocol}://${HAXCMS.domain}${HAXCMS.basePath}${HAXCMS.sitesDirectory}/`, '');
    const siteparts = sitepath.split('/');
    // should always be at the base here
    sitename = siteparts[0];
  }
  const siteToken = HAXCMS.getRequestToken(HAXCMS.getActiveUserName() + ':' + sitename);
  // user token is just the name of the logged in user
  const userToken = HAXCMS.getRequestToken(HAXCMS.getActiveUserName());
  const returnData = JSON.stringify({
    token: HAXCMS.getRequestToken(),
    login: `${baseAPIPath}login`,
    refreshUrl: `${baseAPIPath}refreshAccessToken`,
    logout: `${baseAPIPath}logout`,
    connectionSettings: `${baseAPIPath}connectionSettings`,
    // enables redirecting back to site root if JWT really is dead
    redirectUrl: HAXCMS.basePath,
    saveNodePath: `${baseAPIPath}saveNode?site_token=${siteToken}`,
    saveManifestPath: `${baseAPIPath}saveManifest?site_token=${siteToken}`,
    saveOutlinePath: `${baseAPIPath}saveOutline?site_token=${siteToken}`,
    getSiteFieldsPath: `${baseAPIPath}formLoad?haxcms_form_id=siteSettings`,
    // form token to validate form submissions as unique to the session
    getFormToken: HAXCMS.getRequestToken('form'),
    createNodePath: `${baseAPIPath}createNode?site_token=${siteToken}`,
    deleteNodePath: `${baseAPIPath}deleteNode?site_token=${siteToken}`,

    getUserDataPath: `${baseAPIPath}getUserData?user_token=${userToken}`,
    createSite: `${baseAPIPath}createSite?user_token=${userToken}`,
    downloadSite: `${baseAPIPath}downloadSite?user_token=${userToken}`,
    archiveSite: `${baseAPIPath}archiveSite?user_token=${userToken}`,
    copySite: `${baseAPIPath}cloneSite?user_token=${userToken}`,
    getSitesList: `${baseAPIPath}listSites?user_token=${userToken}`,
    appStore: {
      url: `${baseAPIPath}generateAppStore`,
      params: {
        'appstore_token': HAXCMS.getRequestToken('appstore'),
        'site_token': siteToken,
        'siteName': sitename,
      }
    },
    themes: themes,
  });
  let after='';
  if (HAXCMS.HAXCMS_DISABLE_JWT_CHECKS) {
    after = `window.appSettings.jwt = "${HAXCMS.getJWT(HAXCMS.superUser.name)}"`;
  }
  res.send(`// force vercel calls to go from production
    window.MicroFrontendRegistryConfig = window.MicroFrontendRegistryConfig || {};
    window.MicroFrontendRegistryConfig.base = "https://open-apis.hax.cloud";window.appSettings =${returnData};${after}`);
}

module.exports = connectionSettings;