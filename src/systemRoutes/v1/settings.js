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
const systemVersionRoute = require('../../routes/systemVersion.js');
const systemEntitiesRoute = require('../../routes/systemEntities.js');
const systemSchemasRoute = require('../../routes/systemSchemas.js');

function ensureRequestQuery(req) {
  if (!req.query || typeof req.query !== 'object') {
    req.query = {};
  }
  return req.query;
}
function readRequestValue(req, key = '') {
  if (
    req &&
    req.params &&
    Object.prototype.hasOwnProperty.call(req.params, key) &&
    typeof req.params[key] === 'string' &&
    req.params[key].trim() !== ''
  ) {
    return req.params[key].trim();
  }
  if (
    req &&
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, key) &&
    typeof req.query[key] === 'string' &&
    req.query[key].trim() !== ''
  ) {
    return req.query[key].trim();
  }
  if (
    req &&
    req.body &&
    !Array.isArray(req.body) &&
    Object.prototype.hasOwnProperty.call(req.body, key) &&
    typeof req.body[key] === 'string' &&
    req.body[key].trim() !== ''
  ) {
    return req.body[key].trim();
  }
  return '';
}

function hasPayloadProperty(req, propertyName = '') {
  if (!req || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(req.body, propertyName);
}
function hasMeaningfulBodyPayload(req, ignoredKeys = []) {
  if (!req || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return false;
  }
  const keys = Object.keys(req.body);
  if (keys.length === 0) {
    return false;
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (ignoredKeys.indexOf(key) !== -1) {
      continue;
    }
    return true;
  }
  return false;
}

function isBooleanMapObject(input = null, ignoredKeys = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return false;
  }
  let hasCandidate = false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (ignoredKeys.indexOf(key) !== -1) {
      continue;
    }
    hasCandidate = true;
    if (typeof input[key] !== 'boolean') {
      return false;
    }
  }
  return hasCandidate;
}

function isEnabledCollectionMutationRequest(req, payloadProperty = '') {
  if (!req) {
    return false;
  }
  const method = String(req.method || '').toUpperCase();
  if (method === 'PATCH') {
    return true;
  }
  if (method !== 'POST') {
    return false;
  }
  if (Array.isArray(req.body)) {
    return true;
  }
  if (payloadProperty && hasPayloadProperty(req, payloadProperty)) {
    return true;
  }
  if (hasPayloadProperty(req, 'enabled')) {
    return true;
  }
  return isBooleanMapObject(req.body, ['includeDisabled', 'enabled']);
}
function isSchemaFileOperationRequest(req) {
  if (!req) {
    return false;
  }
  const method = String(req.method || '').toUpperCase();
  if (method !== 'POST') {
    return false;
  }
  if (req.file) {
    return true;
  }
  if (Array.isArray(req.files) && req.files.length > 0) {
    return true;
  }
  if (readRequestValue(req, 'schema') !== '') {
    return true;
  }
  if (readRequestValue(req, 'action') !== '') {
    return true;
  }
  return false;
}
function isSkeletonDetailLookupRequest(req) {
  if (readRequestValue(req, 'skeletonName') !== '') {
    return true;
  }
  if (readRequestValue(req, 'name') !== '') {
    return true;
  }
  return false;
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
  if (method === 'GET') {
    return getApiKeysRoute(req, res, next);
  }
  if (method === 'PATCH') {
    return saveApiKeysRoute(req, res, next);
  }
  if (
    method === 'POST' &&
    hasMeaningfulBodyPayload(req, [
      'jwt',
      'token',
      'user_token',
      'site_token',
    ])
  ) {
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
  if (method === 'GET') {
    return getMediaSettingsRoute(req, res, next);
  }
  if (method === 'PATCH') {
    return saveMediaSettingsRoute(req, res, next);
  }
  if (
    method === 'POST' &&
    hasMeaningfulBodyPayload(req, [
      'jwt',
      'token',
      'user_token',
      'site_token',
    ])
  ) {
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
  if (isEnabledCollectionMutationRequest(req, 'enabledBlocks')) {
    return saveEnabledBlocksRoute(req, res, next);
  }
  return systemBlocksListRoute(req, res, next);
}

async function skeletonsList(req, res, next) {
  return skeletonsListRoute(req, res, next);
}

async function configurationSkeletons(req, res, next) {
  if (isSchemaFileOperationRequest(req)) {
    return schemaFileOperationRoute(req, res, next);
  }
  if (isEnabledCollectionMutationRequest(req, 'enabledSkeletons')) {
    return saveEnabledSkeletonsRoute(req, res, next);
  }
  if (isSkeletonDetailLookupRequest(req)) {
    return getSkeleton(req, res, next);
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
  if (isEnabledCollectionMutationRequest(req, 'enabledThemes')) {
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
