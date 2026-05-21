const { HAXCMS } = require('../lib/HAXCMS.js');
const fs = require('fs');
const path = require('path');
const mime = require('mime');
function normalizePathForResponse(value = '') {
  return String(value).split(path.sep).join('/');
}
function isMultisiteContext(site) {
  if (HAXCMS.operatingContext === 'multisite') {
    return true;
  }
  if (
    typeof HAXCMS.getDeploymentProfile === 'function' &&
    HAXCMS.getDeploymentProfile() === 'self-hosted-multi-site'
  ) {
    return true;
  }
  if (site && typeof site.siteDirectory === 'string' && site.siteDirectory) {
    const normalizedSiteDirectory = normalizePathForResponse(site.siteDirectory);
    const multisitePathMarker = '/' + HAXCMS.sitesDirectory + '/';
    if (normalizedSiteDirectory.indexOf(multisitePathMarker) !== -1) {
      return true;
    }
  }
  return false;
}
function buildFilePublicUrl(site, relativeFilePath) {
  const normalizedRelativePath = normalizePathForResponse(relativeFilePath).replace(
    /^\/+/,
    '',
  );
  let fullUrl = '/' + normalizedRelativePath;
  if (isMultisiteContext(site)) {
    fullUrl =
      HAXCMS.basePath +
      HAXCMS.sitesDirectory +
      '/' +
      site.manifest.metadata.site.name +
      '/' +
      normalizedRelativePath;
  }
  return fullUrl;
}
function getDateCreatedValue(entryStats) {
  if (!entryStats || typeof entryStats !== 'object') {
    return 0;
  }
  let createdMs = 0;
  if (
    typeof entryStats.mtimeMs === 'number' &&
    Number.isFinite(entryStats.mtimeMs) &&
    entryStats.mtimeMs > 0
  ) {
    createdMs = entryStats.mtimeMs;
  } else if (
    typeof entryStats.ctimeMs === 'number' &&
    Number.isFinite(entryStats.ctimeMs) &&
    entryStats.ctimeMs > 0
  ) {
    createdMs = entryStats.ctimeMs;
  } else if (
    typeof entryStats.birthtimeMs === 'number' &&
    Number.isFinite(entryStats.birthtimeMs) &&
    entryStats.birthtimeMs > 0
  ) {
    createdMs = entryStats.birthtimeMs;
  }
  if (createdMs <= 0) {
    return 0;
  }
  return Math.round(createdMs);
}
function buildSiteFileRecord(site, absolutePath, entryStats, relativePath) {
  const stats = entryStats || fs.statSync(absolutePath);
  const apiPath = 'files/' + normalizePathForResponse(relativePath).replace(/^\/+/, '');
  const dateCreated = getDateCreatedValue(stats);
  const baseFileUrl = buildFilePublicUrl(site, apiPath);
  return {
    path: apiPath,
    fullUrl:
      baseFileUrl +
      (dateCreated
        ? (baseFileUrl.indexOf('?') === -1 ? '?t=' : '&t=') + dateCreated
        : ''),
    url: apiPath,
    mimetype: mime.getType(absolutePath) || '',
    name: path.basename(apiPath),
    size: stats && typeof stats.size === 'number' ? stats.size : 0,
    dateCreated: dateCreated,
  };
}
function isManagedDerivativePath(relativePath = '') {
  const normalizedRelativePath = normalizePathForResponse(relativePath).replace(
    /^\/+/,
    '',
  );
  return (
    normalizedRelativePath === 'haxcms-managed' ||
    normalizedRelativePath.indexOf('haxcms-managed/') === 0
  );
}
function collectSiteFiles(site, siteFilePath, search = '') {
  const files = [];
  if (!fs.existsSync(siteFilePath) || !fs.lstatSync(siteFilePath).isDirectory()) {
    return files;
  }
  const searchValue = String(search || '').toLowerCase().trim();
  const ignoredFiles = ['.', '..', '.gitkeep', '.DS_Store', '._.DS_Store'];
  const directories = [siteFilePath];
  while (directories.length) {
    const activeDirectory = directories.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(activeDirectory);
    } catch (e) {
      entries = [];
    }
    for (let i = 0; i < entries.length; i++) {
      const entryName = entries[i];
      if (ignoredFiles.includes(entryName)) {
        continue;
      }
      const absoluteEntryPath = path.join(activeDirectory, entryName);
      let entryStats = null;
      try {
        entryStats = fs.lstatSync(absoluteEntryPath);
      } catch (e) {
        entryStats = null;
      }
      if (!entryStats || entryStats.isSymbolicLink()) {
        continue;
      }
      if (entryStats.isDirectory()) {
        const relativeDirectoryPath = normalizePathForResponse(
          path.relative(siteFilePath, absoluteEntryPath),
        );
        if (isManagedDerivativePath(relativeDirectoryPath)) {
          continue;
        }
        directories.push(absoluteEntryPath);
        continue;
      }
      if (!entryStats.isFile()) {
        continue;
      }
      const relativePath = normalizePathForResponse(
        path.relative(siteFilePath, absoluteEntryPath),
      );
      if (relativePath === '') {
        continue;
      }
      if (isManagedDerivativePath(relativePath)) {
        continue;
      }
      if (
        searchValue !== '' &&
        relativePath.toLowerCase().indexOf(searchValue) === -1 &&
        entryName.toLowerCase().indexOf(searchValue) === -1
      ) {
        continue;
      }
      files.push(
        buildSiteFileRecord(site, absoluteEntryPath, entryStats, relativePath),
      );
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
function getSiteNameFromRequest(req) {
  if (
    req.body &&
    req.body.site &&
    typeof req.body.site.name === 'string' &&
    req.body.site.name
  ) {
    return req.body.site.name;
  }
  if (req.query && typeof req.query.siteName === 'string' && req.query.siteName) {
    return req.query.siteName;
  }
  return '';
}
/**
   * @OA\Post(
   *    path="/listFiles",
   *    tags={"hax","authenticated","file"},
   *    @OA\Parameter(
   *         name="jwt",
   *         description="JSON Web token, obtain by using  /login",
   *         in="query",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *    @OA\Response(
   *        response="200",
   *        description="Load existing files for presentation in HAX find area"
   *   )
   * )
   */
  async function listFiles(req, res) {
    let files = [];
    const siteName = getSiteNameFromRequest(req);
    if (
      req.query['site_token'] &&
      siteName &&
      HAXCMS.validateRequestToken(
        req.query['site_token'],
        HAXCMS.getActiveUserName() + ':' + siteName,
      )
    ) {
      let site = await HAXCMS.loadSite(siteName);
      if (site && site.siteDirectory) {
        let search =
          typeof req.query['filename'] !== 'undefined'
            ? req.query['filename']
            : '';
        if (
          search === '' &&
          req.body &&
          typeof req.body['filename'] !== 'undefined'
        ) {
          search = req.body['filename'];
        }
        // build files directory path
        let siteFilePath = path.join(site.siteDirectory, 'files');
        files = collectSiteFiles(site, siteFilePath, search);
      }
    }
    res.send(files);
  }
  module.exports = listFiles;