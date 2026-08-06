const generateAppStoreRoute = require('./routes/generateAppStore.js');
const systemStatusRoute = require('./routes/systemStatus.js');
const getApiKeysRoute = require('./routes/getApiKeys.js');
const saveApiKeysRoute = require('./routes/saveApiKeys.js');
const getMediaSettingsRoute = require('./routes/getMediaSettings.js');
const saveMediaSettingsRoute = require('./routes/saveMediaSettings.js');
const saveEnabledSkeletonsRoute = require('./routes/saveEnabledSkeletons.js');
const schemaFileOperationRoute = require('./routes/schemaFileOperation.js');
const saveEnabledThemesRoute = require('./routes/saveEnabledThemes.js');
const saveEnabledBlocksRoute = require('./routes/saveEnabledBlocks.js');
const systemBlocksListRoute = require('./routes/systemBlocksList.js');
const skeletonsListRoute = require('./routes/skeletonsList.js');
const getSkeletonRoute = require('./routes/getSkeleton.js');
const themesListRoute = require('./routes/themesList.js');
const systemVersionRoute = require('./routes/systemVersion.js');
const systemEntitiesRoute = require('./routes/systemEntities.js');
const systemSchemasRoute = require('./routes/systemSchemas.js');

function ensureRequestQuery(req) {
  if (!req.query || typeof req.query !== 'object') {
    req.query = {};
  }
  return req.query;
}
async function generateAppStore(req, res, next) {
  return generateAppStoreRoute(req, res, next);
}

async function systemStatus(req, res, next) {
  return systemStatusRoute(req, res, next);
}

async function getApiKeys(req, res, next) {
  return getApiKeysRoute(req, res, next);
}
async function configurationApiKeys(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'PATCH') {
    return saveApiKeysRoute(req, res, next);
  }
  return getApiKeysRoute(req, res, next);
}

async function saveApiKeys(req, res, next) {
  return saveApiKeysRoute(req, res, next);
}

async function getMediaSettings(req, res, next) {
  return getMediaSettingsRoute(req, res, next);
}
async function configurationMedia(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'PATCH') {
    return saveMediaSettingsRoute(req, res, next);
  }
  return getMediaSettingsRoute(req, res, next);
}

async function saveMediaSettings(req, res, next) {
  return saveMediaSettingsRoute(req, res, next);
}

async function saveEnabledSkeletons(req, res, next) {
  return saveEnabledSkeletonsRoute(req, res, next);
}

async function schemaFileOperation(req, res, next) {
  return schemaFileOperationRoute(req, res, next);
}

async function saveEnabledThemes(req, res, next) {
  return saveEnabledThemesRoute(req, res, next);
}

async function saveEnabledBlocks(req, res, next) {
  return saveEnabledBlocksRoute(req, res, next);
}

async function systemBlocksList(req, res, next) {
  return systemBlocksListRoute(req, res, next);
}

async function configurationBlocks(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'PATCH') {
    return saveEnabledBlocksRoute(req, res, next);
  }
  return systemBlocksListRoute(req, res, next);
}

async function skeletonsList(req, res, next) {
  return skeletonsListRoute(req, res, next);
}

async function configurationSkeletons(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'PATCH') {
    return saveEnabledSkeletonsRoute(req, res, next);
  }
  return skeletonsListRoute(req, res, next);
}

async function getSkeleton(req, res, next) {
  if (
    req &&
    req.params &&
    Object.prototype.hasOwnProperty.call(req.params, 'name') &&
    req.params.name
  ) {
    const query = ensureRequestQuery(req);
    if (!query.name) {
      query.name = req.params.name;
    }
  }
  if (
    req &&
    req.params &&
    Object.prototype.hasOwnProperty.call(req.params, 'skeletonName') &&
    req.params.skeletonName
  ) {
    const query = ensureRequestQuery(req);
    if (!query.name) {
      query.name = req.params.skeletonName;
    }
  }
  if (req && req.query && req.query.skeletonName) {
    const query = ensureRequestQuery(req);
    if (!query.name) {
      query.name = req.query.skeletonName;
    }
  }
  if (req && req.body && req.body.skeletonName) {
    const query = ensureRequestQuery(req);
    if (!query.name) {
      query.name = req.body.skeletonName;
    }
  }
  return getSkeletonRoute(req, res, next);
}

async function themesList(req, res, next) {
  return themesListRoute(req, res, next);
}

async function configurationThemes(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'PATCH') {
    return saveEnabledThemesRoute(req, res, next);
  }
  return themesListRoute(req, res, next);
}

async function systemVersion(req, res, next) {
  return systemVersionRoute(req, res, next);
}

async function systemEntities(req, res, next) {
  return systemEntitiesRoute(req, res, next);
}

async function systemSchemas(req, res, next) {
  return systemSchemasRoute(req, res, next);
}

module.exports = {
  generateAppStore,
  systemStatus,
  systemVersion,
  systemEntities,
  systemSchemas,
  getApiKeys,
  configurationApiKeys,
  saveApiKeys,
  getMediaSettings,
  configurationMedia,
  saveMediaSettings,
  saveEnabledSkeletons,
  schemaFileOperation,
  saveEnabledThemes,
  saveEnabledBlocks,
  systemBlocksList,
  configurationBlocks,
  skeletonsList,
  configurationSkeletons,
  getSkeleton,
  themesList,
  configurationThemes,
};
