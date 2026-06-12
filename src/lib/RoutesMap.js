// object containing all routes and their required imports to manage
// helps standardize across app entrypoints whether HAXcms, HAXsite or CLI based
const RoutesMap = {
  post: {
    login: require('../routes/login.js'),
    logout: require('../routes/logout.js'),

    siteUpdateAlternateFormats: require('../routes/siteUpdateAlternateFormats.js'),
    downloadSiteSkeleton: require('../routes/downloadSiteSkeleton.js'),
    saveNodeDetails: require('../routes/saveNodeDetails.js'),
    getNodeRevisions: require('../routes/getNodeRevisions.js'),
    getNodeRevision: require('../routes/getNodeRevision.js'),
    restoreNodeRevision: require('../routes/restoreNodeRevision.js'),
    insights: require('../routes/insights.js'),
    linkChecker: require('../routes/linkChecker.js'),
    contentBrowser: require('../routes/contentBrowser.js'),
    mediaBrowser: require('../routes/mediaBrowser.js'),
    // allow AppHax API (which defaults to POST) to call connectionSettings
    // and refreshAccessToken while still supporting GET
    // for other clients; systemStatus is intentionally POST-only
    connectionSettings: require('../routes/connectionSettings.js'),
    connectionTest: require('../routes/connectionTest.js'),
    refreshAccessToken: require('../routes/refreshAccessToken.js'),
    systemStatus: require('../routes/systemStatus.js'),
    getApiKeys: require('../routes/getApiKeys.js'),
    saveApiKeys: require('../routes/saveApiKeys.js'),
    getMediaSettings: require('../routes/getMediaSettings.js'),
    saveMediaSettings: require('../routes/saveMediaSettings.js'),
    saveEnabledSkeletons: require('../routes/saveEnabledSkeletons.js'),
    schemaFileOperation: require('../routes/schemaFileOperation.js'),
    saveEnabledThemes: require('../routes/saveEnabledThemes.js'),
    saveEnabledBlocks: require('../routes/saveEnabledBlocks.js'),
    systemBlocksList: require('../routes/systemBlocksList.js'),
    themesList: require('../routes/themesList.js'),
    // meta endpoints mirroring PHP Operations::options and ::api
    options: require('../routes/options.js'),
    api: require('../routes/api.js'),
  },
  get: {
    logout: require('../routes/logout.js'),
    openapi: require('../routes/openapi.js'),
    connectionSettings: require('../routes/connectionSettings.js'),
    connectionTest: require('../routes/connectionTest.js'),
    systemBlocksList: require('../routes/systemBlocksList.js'),
    refreshAccessToken: require('../routes/refreshAccessToken.js'),
    themesList: require('../routes/themesList.js'),
  },
};

// these routes need to return a response without a JWT validation
const OpenRoutes = [
  'connectionSettings',
  'connectionTest',
  'login',
  'logout',
  'api',
  'options',
  'openapi',
  'refreshAccessToken'
];
// haxcms system-admin routes should only be available from system dashboard context
// future system-admin endpoints should be added here
const SystemAdminRoutes = [
  'downloadSiteSkeleton',
  'systemStatus',
  'getApiKeys',
  'saveApiKeys',
  'getMediaSettings',
  'saveMediaSettings',
  'saveEnabledBlocks',
  'systemBlocksList',
  'saveEnabledThemes',
  'saveEnabledSkeletons',
  'schemaFileOperation',
  'themesList',
];

module.exports = {RoutesMap, OpenRoutes, SystemAdminRoutes};
