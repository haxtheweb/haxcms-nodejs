const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  discoverThemes,
  readEnabledThemeMap,
  writeEnabledThemeMap,
  applyDetectedThemeDefaults,
  isThemeEnabled,
  themesToMap,
} = require('../lib/themeSettings.js');
const url = require('url');

async function loadThemeMapFromSettings() {
  const discovered = await discoverThemes(HAXCMS);
  const detectedNames = discovered.map((item) => item.machineName);
  let enabledThemes = await readEnabledThemeMap(HAXCMS);
  const withDefaults = applyDetectedThemeDefaults(
    HAXCMS,
    enabledThemes,
    detectedNames,
  );
  enabledThemes = withDefaults.enabledThemes;
  if (withDefaults.changed) {
    await writeEnabledThemeMap(HAXCMS, enabledThemes);
  }
  const themes = [];
  for (let i = 0; i < discovered.length; i++) {
    const item = discovered[i];
    const enabled = isThemeEnabled(
      HAXCMS,
      item.machineName,
      enabledThemes,
    );
    themes.push({
      ...item,
      enabled,
      hidden: item.hidden === true || !enabled,
    });
  }
  return themesToMap(themes);
}

/**
 * @OA\Get(
 *    path="/connectionSettings",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="Generate the connection settings dynamically for implying we have a backend"
 *   )
 * )
 * @OA\Post(
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
  let themes = {};
  try {
    themes = await loadThemeMapFromSettings();
  }
  catch (e) {
    const fallbackThemes = (
      HAXCMS &&
      typeof HAXCMS.getThemes === 'function'
    ) ? HAXCMS.getThemes() : {};
    themes = (
      fallbackThemes &&
      typeof fallbackThemes === 'object' &&
      !Array.isArray(fallbackThemes)
    ) ? fallbackThemes : {};
  }
  const isDashboardRequest = (
    HAXCMS &&
    HAXCMS.operatingContext !== 'single' &&
    req.headers &&
    req.headers.referer &&
    !req.headers.referer.includes(`/${HAXCMS.sitesDirectory}/`)
  );
  // default to relative API paths so calls in site context resolve correctly
  // and mirror PHP behavior for appStore-generated endpoint paths.
  let baseAPIPath = HAXCMS.systemRequestBase;
  // in non-root installs, preserve basePath for site-context API routing.
  if (!isDashboardRequest && HAXCMS.basePath && HAXCMS.basePath !== '/') {
    baseAPIPath = `${HAXCMS.basePath}${HAXCMS.systemRequestBase}`;
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
  let normalizedBasePath = String(HAXCMS.basePath || '/');
  if (normalizedBasePath.charAt(0) !== '/') {
    normalizedBasePath = '/' + normalizedBasePath;
  }
  if (normalizedBasePath.charAt(normalizedBasePath.length - 1) !== '/') {
    normalizedBasePath += '/';
  }
  let siteApiBasePath = `${normalizedBasePath}x/api`;
  if (sitename) {
    siteApiBasePath = `${normalizedBasePath}${HAXCMS.sitesDirectory}/${sitename}/x/api`;
  }
  const returnDataObj = {
    token: HAXCMS.getRequestToken(),
    siteToken: siteToken,
    userToken: userToken,
    siteApiBasePath: siteApiBasePath,
    siteOpenApiPath: `${siteApiBasePath}/openapi.json`,
    login: `${baseAPIPath}login`,
    refreshUrl: `${baseAPIPath}refreshAccessToken`,
    logout: `${baseAPIPath}logout`,
    connectionSettings: `${baseAPIPath}connectionSettings`,
    connectionTest: `${baseAPIPath}connectionTest`,
    // enables redirecting back to site root if JWT really is dead
    redirectUrl: HAXCMS.basePath,
    saveNodePath: `${baseAPIPath}saveNode?site_token=${siteToken}`,
    // Singular node operations (moveUp, setTitle, etc.)
    saveNodeDetailsPath: `${baseAPIPath}saveNodeDetails?site_token=${siteToken}`,
    saveManifestPath: `${baseAPIPath}saveManifest?site_token=${siteToken}`,
    saveAppearanceSettingsPath: `${baseAPIPath}saveAppearanceSettings?site_token=${siteToken}`,
    savePlatformSettingsPath: `${baseAPIPath}savePlatformSettings?site_token=${siteToken}`,
    saveAllowedBlocksPath: `${baseAPIPath}saveAllowedBlocks?site_token=${siteToken}`,
    saveEditorSettingsPath: `${baseAPIPath}saveEditorSettings?site_token=${siteToken}`,
    saveSeoSettingsPath: `${baseAPIPath}saveSeoSettings?site_token=${siteToken}`,
    saveOutlinePath: `${baseAPIPath}saveOutline?site_token=${siteToken}`,
    getSiteFieldsPath: `${baseAPIPath}formLoad?haxcms_form_id=siteSettings`,
    contentSearchPath: `${baseAPIPath}siteSearch?site_token=${siteToken}`,
    searchContentPath: `${baseAPIPath}siteSearch?site_token=${siteToken}`,
    insightsPath: `${baseAPIPath}insights?site_token=${siteToken}`,
    linkCheckerPath: `${baseAPIPath}linkChecker?site_token=${siteToken}`,
    contentBrowserPath: `${baseAPIPath}contentBrowser?site_token=${siteToken}`,
    mediaBrowserPath: `${baseAPIPath}mediaBrowser?site_token=${siteToken}`,
    // form token to validate form submissions as unique to the session
    getFormToken: HAXCMS.getRequestToken('form'),
    createNodePath: `${baseAPIPath}createNode?site_token=${siteToken}`,
    deleteNodePath: `${baseAPIPath}deleteNode?site_token=${siteToken}`,
    getNodeRevisionsPath: `${baseAPIPath}getNodeRevisions?site_token=${siteToken}`,
    getNodeRevisionPath: `${baseAPIPath}getNodeRevision?site_token=${siteToken}`,
    restoreNodeRevisionPath: `${baseAPIPath}restoreNodeRevision?site_token=${siteToken}`,
    listFilesPath: `${siteApiBasePath}/v1/files`,
    saveFilePath: `${baseAPIPath}saveFile?site_token=${siteToken}`,
    fileOperationPath: `${baseAPIPath}fileOperation?site_token=${siteToken}`,
    appStore: {
      url: `${baseAPIPath}generateAppStore`,
      params: {
        'appstore_token': HAXCMS.getRequestToken('appstore'),
        'site_token': siteToken,
        'siteName': sitename,
      }
    },
    themes: themes,
  };
  returnDataObj.getUserDataPath = `${baseAPIPath}getUserData?user_token=${userToken}`;
  returnDataObj.createSite = `${baseAPIPath}createSite?user_token=${userToken}`;
  returnDataObj.downloadSite = `${baseAPIPath}downloadSite?user_token=${userToken}`;
  returnDataObj.downloadSiteSkeleton = `${baseAPIPath}downloadSiteSkeleton?user_token=${userToken}`;
  returnDataObj.saveSiteAsTemplate = `${baseAPIPath}saveSiteAsTemplate?user_token=${userToken}`;
  returnDataObj.archiveSite = `${baseAPIPath}archiveSite?user_token=${userToken}`;
  returnDataObj.copySite = `${baseAPIPath}cloneSite?user_token=${userToken}`;
  returnDataObj.getSitesList = `${baseAPIPath}listSites?user_token=${userToken}`;
  returnDataObj.skeletonsList = `${baseAPIPath}skeletonsList?user_token=${userToken}`;
  returnDataObj.themesList = `${baseAPIPath}themesList?user_token=${userToken}`;
  if (HAXCMS.getDeploymentProfile() !== 'haxiam-managed') {
    returnDataObj.systemStatus = `${baseAPIPath}systemStatus?user_token=${userToken}`;
    returnDataObj.getApiKeys = `${baseAPIPath}getApiKeys?user_token=${userToken}`;
    returnDataObj.saveApiKeys = `${baseAPIPath}saveApiKeys?user_token=${userToken}`;
    returnDataObj.getMediaSettings = `${baseAPIPath}getMediaSettings?user_token=${userToken}`;
    returnDataObj.saveMediaSettings = `${baseAPIPath}saveMediaSettings?user_token=${userToken}`;
    returnDataObj.systemBlocksList = `${baseAPIPath}systemBlocksList?user_token=${userToken}`;
    returnDataObj.schemaFileOperation = `${baseAPIPath}schemaFileOperation?user_token=${userToken}`;
    returnDataObj.saveEnabledSkeletons = `${baseAPIPath}saveEnabledSkeletons?user_token=${userToken}`;
    returnDataObj.saveEnabledThemes = `${baseAPIPath}saveEnabledThemes?user_token=${userToken}`;
    returnDataObj.saveEnabledBlocks = `${baseAPIPath}saveEnabledBlocks?user_token=${userToken}`;
  }
  const returnData = JSON.stringify(returnDataObj);
  let after='';
  if (HAXCMS.HAXCMS_DISABLE_JWT_CHECKS) {
    after = `window.appSettings.jwt = "${HAXCMS.getJWT(HAXCMS.superUser.name)}"`;
  }
  res.send(`// force vercel calls to go from production
    window.MicroFrontendRegistryConfig = window.MicroFrontendRegistryConfig || {};
    window.MicroFrontendRegistryConfig.base = "https://open-apis.hax.cloud";window.appSettings =${returnData};${after}`);
}

module.exports = connectionSettings;