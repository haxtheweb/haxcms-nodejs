// object containing all routes and their required imports to manage
// helps standardize across app entrypoints whether HAXcms, HAXsite or CLI based
const RoutesMap = {
  post: {
    login: require('../routes/login.js'),
    logout: require('../routes/logout.js'),
    formLoad: require('../routes/formLoad.js'),
    formProcess: require('../routes/formProcess.js'),
    getUserData: require('../routes/getUserData.js'),
    listSites: require('../routes/listSites.js'),

    siteUpdateAlternateFormats: require('../routes/siteUpdateAlternateFormats.js'),
    createSite: require('../routes/createSite.js'),
    cloneSite: require('../routes/cloneSite.js'),
    archiveSite: require('../routes/archiveSite.js'),
    downloadSite: require('../routes/downloadSite.js'),
    saveManifest: require('../routes/saveManifest.js'),
    saveOutline: require('../routes/saveOutline.js'),

    createNode: require('../routes/createNode.js'),
    saveNode: require('../routes/saveNode.js'),
    deleteNode: require('../routes/deleteNode.js'),
    saveFile: require('../routes/saveFile.js'),
  },
  get: {
    logout: require('../routes/logout.js'),
    listFiles: require('../routes/listFiles.js'),
    openapi: require('../routes/openapi.js'),
    "openapi/json": require('../routes/openapi.js'),
    connectionSettings: require('../routes/connectionSettings.js'),
    generateAppStore: require('../routes/generateAppStore.js'),
    refreshAccessToken: require('../routes/refreshAccessToken.js'),
  },
};

// these routes need to return a response without a JWT validation
const OpenRoutes = [
  'generateAppStore',
  'connectionSettings',
  'getSitesList',
  'login',
  'logout',
  'api',
  'options',
  'openapi',
  'openapi/json',
  'refreshAccessToken'
];

module.exports = {RoutesMap, OpenRoutes};