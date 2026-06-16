const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../../lib/HAXCMS.js');
const listSitesRoute = require('./routes/listSites.js');
const createSiteRoute = require('./routes/createSite.js');
const cloneSiteRoute = require('./routes/cloneSite.js');
const archiveSiteRoute = require('./routes/archiveSite.js');
const downloadSiteRoute = require('./routes/downloadSite.js');
const downloadSiteSkeletonRoute = require('./routes/downloadSiteSkeleton.js');
const saveSiteAsTemplateRoute = require('./routes/saveSiteAsTemplate.js');
const siteInfoRoute = require('./routes/siteInfo.js');
function ensureRequestBody(req) {
  if (!req.body || typeof req.body !== 'object') {
    req.body = {};
  }
  return req.body;
}
function getSiteNameFromPayload(req) {
  if (
    req &&
    req.body &&
    req.body.site &&
    typeof req.body.site === 'object' &&
    typeof req.body.site.name === 'string'
  ) {
    return req.body.site.name.trim();
  }
  if (
    req &&
    req.body &&
    typeof req.body.siteName === 'string'
  ) {
    return req.body.siteName.trim();
  }
  return '';
}
function buildSitePath(directory = '', siteName = '') {
  return `${HAXCMS.HAXCMS_ROOT}${directory}/${siteName}`;
}
function isArchiveDestinationCollision(error = null) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return error.code === 'ENOTEMPTY' || error.code === 'EEXIST';
}
async function getNextArchivedSitePath(siteName = '') {
  const archivedRoot = `${HAXCMS.HAXCMS_ROOT}${HAXCMS.archivedDirectory}`;
  const basePath = `${archivedRoot}/${siteName}`;
  if (!(await fs.pathExists(basePath))) {
    return basePath;
  }
  let index = 1;
  let candidatePath = `${basePath}-${index}`;
  while (await fs.pathExists(candidatePath)) {
    index += 1;
    candidatePath = `${basePath}-${index}`;
  }
  return candidatePath;
}
async function archiveSiteWithCollisionResolution(req, res, error) {
  if (!isArchiveDestinationCollision(error)) {
    throw error;
  }
  const siteName = getSiteNameFromPayload(req);
  if (siteName === '') {
    throw error;
  }
  const archivedRoot = `${HAXCMS.HAXCMS_ROOT}${HAXCMS.archivedDirectory}`;
  const sourcePath = buildSitePath(HAXCMS.sitesDirectory, siteName);
  const destinationPath = await getNextArchivedSitePath(siteName);
  await fs.ensureDir(archivedRoot);
  await fs.rename(sourcePath, destinationPath);
  const archivedName = path.basename(destinationPath);
  const detail =
    archivedName === siteName
      ? 'Site archived'
      : `Site archived as ${archivedName} because an archived copy already existed`;
  return res.send({
    status: 200,
    data: {
      name: siteName,
      detail,
      archivedName,
    },
  });
}

function applySiteNameFromParams(req) {
  const payloadSiteName = getSiteNameFromPayload(req);
  if (
    !req ||
    !req.params ||
    !Object.prototype.hasOwnProperty.call(req.params, 'siteName')
  ) {
    if (payloadSiteName === '') {
      return;
    }
    const bodyFromPayloadOnly = ensureRequestBody(req);
    if (
      !bodyFromPayloadOnly.site ||
      typeof bodyFromPayloadOnly.site !== 'object'
    ) {
      bodyFromPayloadOnly.site = {};
    }
    bodyFromPayloadOnly.site.name = payloadSiteName;
    return;
  }
  let siteName =
    typeof req.params.siteName === 'string' ? req.params.siteName.trim() : '';
  if (
    payloadSiteName !== '' &&
    (
      siteName === '' ||
      siteName.indexOf('{') !== -1 ||
      siteName.indexOf('}') !== -1
    )
  ) {
    siteName = payloadSiteName;
  }
  if (siteName === '') {
    return;
  }
  const body = ensureRequestBody(req);
  if (!body.site || typeof body.site !== 'object') {
    body.site = {};
  }
  body.site.name = siteName;
}

async function listSites(req, res, next) {
  return listSitesRoute(req, res, next);
}

async function createSite(req, res, next) {
  return createSiteRoute(req, res, next);
}

async function cloneSite(req, res, next) {
  applySiteNameFromParams(req);
  return cloneSiteRoute(req, res, next);
}

async function archiveSite(req, res, next) {
  applySiteNameFromParams(req);
  try {
    return await archiveSiteRoute(req, res, next);
  }
  catch (error) {
    return archiveSiteWithCollisionResolution(req, res, error);
  }
}

async function downloadSite(req, res, next) {
  applySiteNameFromParams(req);
  return downloadSiteRoute(req, res, next);
}

async function downloadSiteSkeleton(req, res, next) {
  applySiteNameFromParams(req);
  return downloadSiteSkeletonRoute(req, res, next);
}

async function saveSiteAsTemplate(req, res, next) {
  applySiteNameFromParams(req);
  return saveSiteAsTemplateRoute(req, res, next);
}

async function siteInfo(req, res, next) {
  applySiteNameFromParams(req);
  return siteInfoRoute(req, res, next);
}

module.exports = {
  listSites,
  siteInfo,
  createSite,
  cloneSite,
  archiveSite,
  downloadSite,
  downloadSiteSkeleton,
  saveSiteAsTemplate,
};
