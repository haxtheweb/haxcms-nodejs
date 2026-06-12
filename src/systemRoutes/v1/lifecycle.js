const listSitesRoute = require('../../routes/listSites.js');
const createSiteRoute = require('../../routes/createSite.js');
const cloneSiteRoute = require('../../routes/cloneSite.js');
const archiveSiteRoute = require('../../routes/archiveSite.js');
const downloadSiteRoute = require('../../routes/downloadSite.js');
const downloadSiteSkeletonRoute = require('../../routes/downloadSiteSkeleton.js');
const saveSiteAsTemplateRoute = require('../../routes/saveSiteAsTemplate.js');

async function listSites(req, res, next) {
  return listSitesRoute(req, res, next);
}

async function createSite(req, res, next) {
  return createSiteRoute(req, res, next);
}

async function cloneSite(req, res, next) {
  return cloneSiteRoute(req, res, next);
}

async function archiveSite(req, res, next) {
  return archiveSiteRoute(req, res, next);
}

async function downloadSite(req, res, next) {
  return downloadSiteRoute(req, res, next);
}

async function downloadSiteSkeleton(req, res, next) {
  return downloadSiteSkeletonRoute(req, res, next);
}

async function saveSiteAsTemplate(req, res, next) {
  return saveSiteAsTemplateRoute(req, res, next);
}

module.exports = {
  listSites,
  createSite,
  cloneSite,
  archiveSite,
  downloadSite,
  downloadSiteSkeleton,
  saveSiteAsTemplate,
};
