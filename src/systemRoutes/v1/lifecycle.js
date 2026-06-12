const listSitesRoute = require('../../routes/listSites.js');
const createSiteRoute = require('../../routes/createSite.js');
const cloneSiteRoute = require('../../routes/cloneSite.js');
const archiveSiteRoute = require('../../routes/archiveSite.js');
const downloadSiteRoute = require('../../routes/downloadSite.js');
const downloadSiteSkeletonRoute = require('../../routes/downloadSiteSkeleton.js');
const saveSiteAsTemplateRoute = require('../../routes/saveSiteAsTemplate.js');
const siteInfoRoute = require('../../routes/siteInfo.js');
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
  return archiveSiteRoute(req, res, next);
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
