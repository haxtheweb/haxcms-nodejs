const generateAppStoreRoute = require('../../routes/generateAppStore.js');
const systemStatusRoute = require('../../routes/systemStatus.js');
const getApiKeysRoute = require('../../routes/getApiKeys.js');
const saveApiKeysRoute = require('../../routes/saveApiKeys.js');
const getMediaSettingsRoute = require('../../routes/getMediaSettings.js');
const saveMediaSettingsRoute = require('../../routes/saveMediaSettings.js');
const saveEnabledSkeletonsRoute = require('../../routes/saveEnabledSkeletons.js');
const schemaFileOperationRoute = require('../../routes/schemaFileOperation.js');
const saveEnabledThemesRoute = require('../../routes/saveEnabledThemes.js');
const saveEnabledBlocksRoute = require('../../routes/saveEnabledBlocks.js');
const systemBlocksListRoute = require('../../routes/systemBlocksList.js');
const skeletonsListRoute = require('../../routes/skeletonsList.js');
const getSkeletonRoute = require('../../routes/getSkeleton.js');
const themesListRoute = require('../../routes/themesList.js');

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

async function saveApiKeys(req, res, next) {
  return saveApiKeysRoute(req, res, next);
}

async function getMediaSettings(req, res, next) {
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

async function skeletonsList(req, res, next) {
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
  return getSkeletonRoute(req, res, next);
}

async function themesList(req, res, next) {
  return themesListRoute(req, res, next);
}

module.exports = {
  generateAppStore,
  systemStatus,
  getApiKeys,
  saveApiKeys,
  getMediaSettings,
  saveMediaSettings,
  saveEnabledSkeletons,
  schemaFileOperation,
  saveEnabledThemes,
  saveEnabledBlocks,
  systemBlocksList,
  skeletonsList,
  getSkeleton,
  themesList,
};
