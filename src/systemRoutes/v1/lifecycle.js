const fs = require("fs-extra");
const path = require("path");
const { HAXCMS } = require("../../lib/HAXCMS.js");
const { resolveContainedPath } = require("../../lib/pathConfinement.js");
const listSitesRoute = require("./routes/listSites.js");
const createSiteRoute = require("./routes/createSite.js");
const cloneSiteRoute = require("./routes/cloneSite.js");
const archiveSiteRoute = require("./routes/archiveSite.js");
const downloadSiteRoute = require("./routes/downloadSite.js");
const downloadSiteSkeletonRoute = require("./routes/downloadSiteSkeleton.js");
const saveSiteAsTemplateRoute = require("./routes/saveSiteAsTemplate.js");
const siteInfoRoute = require("./routes/siteInfo.js");
function ensureRequestBody(req) {
  if (!req.body || typeof req.body !== "object") {
    req.body = {};
  }
  return req.body;
}
function getSiteNameFromPayload(req) {
  if (
    req &&
    req.body &&
    req.body.site &&
    typeof req.body.site === "object" &&
    typeof req.body.site.name === "string"
  ) {
    return req.body.site.name.trim();
  }
  if (req && req.body && typeof req.body.siteName === "string") {
    return req.body.siteName.trim();
  }
  return "";
}
function isArchiveDestinationCollision(error = null) {
  if (!error || typeof error !== "object") {
    return false;
  }
  return error.code === "ENOTEMPTY" || error.code === "EEXIST";
}
async function getNextArchivedSitePath(siteName = "") {
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
// Security (L3, 2026-10-19 audit): normalize a request-supplied site name the
// same way HAXCMS.loadSite() does (decode + cleanTitle) and require a single
// path segment, so the fallback below can only ever act on the directory the
// primary archive route already resolved. Returns '' when unusable.
function normalizeArchiveSiteName(rawName = "") {
  let name = String(rawName || "");
  try {
    name = decodeURIComponent(name);
  } catch (e) {
    return "";
  }
  name = HAXCMS.cleanTitle(name, false);
  if (
    typeof name !== "string" ||
    name === "" ||
    name === "." ||
    name.indexOf("/") !== -1 ||
    name.indexOf("\\") !== -1
  ) {
    return "";
  }
  return name;
}
async function archiveSiteWithCollisionResolution(req, res, error) {
  if (!isArchiveDestinationCollision(error)) {
    throw error;
  }
  const siteName = normalizeArchiveSiteName(getSiteNameFromPayload(req));
  if (siteName === "") {
    throw error;
  }
  const sitesRoot = `${HAXCMS.HAXCMS_ROOT}${HAXCMS.sitesDirectory}`;
  const archivedRoot = `${HAXCMS.HAXCMS_ROOT}${HAXCMS.archivedDirectory}`;
  await fs.ensureDir(archivedRoot);
  // Security (L3): both rename endpoints must resolve inside their roots
  // (realpath-checked, so symlinks cannot redirect the move either).
  const sourcePath = resolveContainedPath(sitesRoot, siteName);
  const destinationPath = await getNextArchivedSitePath(siteName);
  if (
    sourcePath === false ||
    !(await fs.pathExists(sourcePath)) ||
    resolveContainedPath(archivedRoot, path.basename(destinationPath)) === false
  ) {
    throw error;
  }
  await fs.rename(sourcePath, destinationPath);
  const archivedName = path.basename(destinationPath);
  const detail =
    archivedName === siteName
      ? "Site archived"
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
    !Object.prototype.hasOwnProperty.call(req.params, "siteName")
  ) {
    if (payloadSiteName === "") {
      return;
    }
    const bodyFromPayloadOnly = ensureRequestBody(req);
    if (
      !bodyFromPayloadOnly.site ||
      typeof bodyFromPayloadOnly.site !== "object"
    ) {
      bodyFromPayloadOnly.site = {};
    }
    bodyFromPayloadOnly.site.name = payloadSiteName;
    return;
  }
  let siteName =
    typeof req.params.siteName === "string" ? req.params.siteName.trim() : "";
  if (
    payloadSiteName !== "" &&
    (siteName === "" ||
      siteName.indexOf("{") !== -1 ||
      siteName.indexOf("}") !== -1)
  ) {
    siteName = payloadSiteName;
  }
  if (siteName === "") {
    return;
  }
  const body = ensureRequestBody(req);
  if (!body.site || typeof body.site !== "object") {
    body.site = {};
  }
  body.site.name = siteName;
}

// Security (SEC-SESSION, PHP F2/IDOR-001 parity): object-level authorization
// on the named site before clone / archive / download / download-skeleton /
// save-as-template. Port of PHP lifecycle.php userCanAccessSite gating. Only
// enforced in HAXiam (config.iam) mode: in self-hosted / single-site mode any
// authenticated user may act on any site (PHP userCanAccessSite returns true
// there too), so default behaviour (including existing 404s for unknown
// sites) is unchanged.
async function enforceSiteAccess(req, res) {
  if (typeof HAXCMS.isIAMEnabled !== "function" || !HAXCMS.isIAMEnabled()) {
    return true;
  }
  const siteName = getSiteNameFromPayload(req);
  let allowed = false;
  if (siteName !== "") {
    try {
      allowed = await HAXCMS.userCanAccessSite(siteName, req);
    } catch (e) {
      allowed = false;
    }
  }
  if (!allowed) {
    res.status(403).json({
      status: 403,
      data: { message: "Access denied to site" },
    });
    return false;
  }
  return true;
}

async function listSites(req, res, next) {
  return listSitesRoute(req, res, next);
}

async function createSite(req, res, next) {
  return createSiteRoute(req, res, next);
}

async function cloneSite(req, res, next) {
  applySiteNameFromParams(req);
  if (!(await enforceSiteAccess(req, res))) {
    return;
  }
  return cloneSiteRoute(req, res, next);
}

async function archiveSite(req, res, next) {
  applySiteNameFromParams(req);
  if (!(await enforceSiteAccess(req, res))) {
    return;
  }
  try {
    return await archiveSiteRoute(req, res, next);
  } catch (error) {
    return archiveSiteWithCollisionResolution(req, res, error);
  }
}

async function downloadSite(req, res, next) {
  applySiteNameFromParams(req);
  if (!(await enforceSiteAccess(req, res))) {
    return;
  }
  return downloadSiteRoute(req, res, next);
}

async function downloadSiteSkeleton(req, res, next) {
  applySiteNameFromParams(req);
  if (!(await enforceSiteAccess(req, res))) {
    return;
  }
  return downloadSiteSkeletonRoute(req, res, next);
}

async function saveSiteAsTemplate(req, res, next) {
  applySiteNameFromParams(req);
  if (!(await enforceSiteAccess(req, res))) {
    return;
  }
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
