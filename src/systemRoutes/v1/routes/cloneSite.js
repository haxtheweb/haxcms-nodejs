const { HAXCMS } = require('../../../lib/HAXCMS.js');
const path = require('path');
const fs = require('fs-extra');

function normalizeBasePath(basePath = '/') {
  let normalized = typeof basePath === 'string' ? basePath : '/';
  if (normalized == '') {
    normalized = '/';
  }
  if (normalized.substring(0, 1) != '/') {
    normalized = '/' + normalized;
  }
  if (normalized.substring(normalized.length - 1) != '/') {
    normalized += '/';
  }
  return normalized;
}

function buildSiteFilesUrlPrefix(siteName) {
  if (!siteName || typeof siteName !== 'string') {
    return '';
  }
  const cleanName = siteName.replace(/^\/+|\/+$/g, '');
  if (cleanName == '') {
    return '';
  }
  const cleanSitesDirectory = String(HAXCMS.sitesDirectory || 'sites').replace(
    /^\/+|\/+$/g,
    '',
  );
  const basePath = normalizeBasePath(HAXCMS.basePath || '/');
  return `${basePath}${cleanSitesDirectory}/${cleanName}/files/`;
}

function replaceWithKnownPrefix(value, sourcePrefixes = [], targetPrefix = '') {
  if (typeof value !== 'string' || value == '') {
    return value;
  }
  let updated = value.replace(/\\/g, '/');
  for (let i = 0; i < sourcePrefixes.length; i++) {
    const prefix = sourcePrefixes[i];
    if (prefix && updated.indexOf(prefix) !== -1) {
      updated = updated.replace(prefix, targetPrefix);
      break;
    }
  }
  return updated;
}

/**
   * @OA\Post(
   *    path="/cloneSite",
   *    tags={"cms","authenticated","site"},
   *    @OA\Parameter(
   *         name="jwt",
   *         description="JSON Web token, obtain by using  /login",
   *         in="query",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *    @OA\RequestBody(
   *        @OA\MediaType(
   *             mediaType="application/json",
   *             @OA\Schema(
   *                 @OA\Property(
   *                     property="site",
   *                     type="object"
   *                 ),
   *                 required={"site"},
   *                 example={
   *                    "site": {
   *                      "name": "mynewsite"
   *                    },
   *                 }
   *             )
   *         )
   *    ),
   *    @OA\Response(
   *        response="200",
   *        description="Clone a site by copying and renaming the folder on file system"
   *   )
   * )
   */
  async function cloneSite(req, res) {
    let site = await HAXCMS.loadSite(req.body['site']['name']);
      const originalSiteName = site.manifest.metadata.site.name;

      let cloneName = HAXCMS.getUniqueName(site.name);
      // ensure the path to the new folder is valid
      // recurseCopy preserves theme/ and custom/ directories automatically,
      // so user-customized files such as theme.css, theme.html, and custom.es6.js are retained
      await HAXCMS.recurseCopy(
          HAXCMS.HAXCMS_ROOT + HAXCMS.sitesDirectory + '/' + site.name,
          HAXCMS.HAXCMS_ROOT + HAXCMS.sitesDirectory + '/' + cloneName
      );
      // we need to then load and rewrite the site name var or it will conflict given the name change
      let newSite = await HAXCMS.loadSite(cloneName);
      newSite.manifest.metadata.site.name = cloneName;
      newSite.manifest.id =  HAXCMS.generateUUID();
      const cleanSitesDirectory = String(HAXCMS.sitesDirectory || 'sites').replace(
        /^\/+|\/+$/g,
        '',
      );
      const sourceUrlPrefixes = [
        buildSiteFilesUrlPrefix(originalSiteName),
        `/${cleanSitesDirectory}/${originalSiteName}/files/`,
        `/sites/${originalSiteName}/files/`,
        `${cleanSitesDirectory}/${originalSiteName}/files/`,
        `${HAXCMS.sitesDirectory}${originalSiteName}/files/`,
      ];
      const targetUrlPrefix = buildSiteFilesUrlPrefix(cloneName);
      const sourceFileSystemPrefix = `${path
        .join(site.siteDirectory, 'files')
        .replace(/\\/g, '/')}/`;
      const targetFileSystemPrefix = `${path
        .join(newSite.siteDirectory, 'files')
        .replace(/\\/g, '/')}/`;
      // #3043: page.metadata.files is now an array of uuid strings (stable,
      // no rewrite needed). The files.json datastore is copied into the clone
      // by recurseCopy and its path/fullUrl prefixes are rewritten inside it,
      // PRESERVING uuids (per #3043: "uuids for files don't get rewritten if
      // we clone the site"). Legacy object-shape page.metadata.files entries
      // on old source sites are left as-is and self-heal to uuids on the next
      // page save; the clone's files.json is lazily auto-built on first list.
      rewriteCloneFilesJson({
        cloneFilesJsonPath: path.join(newSite.siteDirectory, 'files', 'files.json'),
        cloneName: cloneName,
        sourceUrlPrefixes: sourceUrlPrefixes,
        targetUrlPrefix: targetUrlPrefix,
        sourceFileSystemPrefix: sourceFileSystemPrefix,
        targetFileSystemPrefix: targetFileSystemPrefix,
      });

      await newSite.save();
      res.send({
        status: 200,
        data: {
          detail:
            HAXCMS.basePath +
            HAXCMS.sitesDirectory +
            '/' +
            cloneName,
          name: cloneName,
        },
      });
  }

// #3043: Rewrite the clone's files.json datastore: rewrite path/fullUrl
// prefixes for the new site name, PRESERVING uuids. Reads the files.json at
// cloneFilesJsonPath, rewrites each record's path/fullUrl/url, updates the
// envelope site name, and writes it back. Best-effort — silently no-ops if
// the file is missing or corrupt (the clone still works; files.json is
// lazily auto-built on first list).
function rewriteCloneFilesJson(opts) {
  const cloneFilesJsonPath = opts.cloneFilesJsonPath;
  if (!cloneFilesJsonPath || !fs.pathExistsSync(cloneFilesJsonPath)) {
    return false;
  }
  try {
    const filesJsonContents = fs.readFileSync(cloneFilesJsonPath, 'utf8');
    if (!filesJsonContents || filesJsonContents === '') {
      return false;
    }
    const decoded = JSON.parse(filesJsonContents);
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      !decoded.data ||
      !Array.isArray(decoded.data.files)
    ) {
      return false;
    }
    const sourceUrlPrefixes = opts.sourceUrlPrefixes || [];
    const targetUrlPrefix = opts.targetUrlPrefix || '';
    const sourceFileSystemPrefix = opts.sourceFileSystemPrefix || '';
    const targetFileSystemPrefix = opts.targetFileSystemPrefix || '';
    for (let fIdx = 0; fIdx < decoded.data.files.length; fIdx++) {
      const record = decoded.data.files[fIdx];
      if (!record || typeof record !== 'object') {
        continue;
      }
      const recordPath = record.path ? String(record.path) : '';
      const fullUrl = record.fullUrl ? String(record.fullUrl) : '';
      if (recordPath !== '') {
        // Rewrite the files/ path prefix — the path stays relative
        // (files/...) so only the fullUrl prefix actually changes.
        let newPath = replaceWithKnownPrefix(
          recordPath,
          [sourceFileSystemPrefix],
          targetFileSystemPrefix,
        );
        newPath = replaceWithKnownPrefix(
          newPath,
          sourceUrlPrefixes,
          targetUrlPrefix,
        );
        // Normalize back to files/... if the prefix rewrite produced
        // an absolute path (the canonical form is relative).
        const filesPos = newPath.indexOf('files/');
        if (filesPos > 0) {
          newPath = newPath.substring(filesPos);
        }
        decoded.data.files[fIdx].path = newPath;
      }
      if (fullUrl !== '') {
        let newFullUrl = replaceWithKnownPrefix(
          fullUrl,
          [sourceFileSystemPrefix],
          targetFileSystemPrefix,
        );
        newFullUrl = replaceWithKnownPrefix(
          newFullUrl,
          sourceUrlPrefixes,
          targetUrlPrefix,
        );
        decoded.data.files[fIdx].fullUrl = newFullUrl;
      }
      // url mirrors path
      if (decoded.data.files[fIdx].url && recordPath !== '') {
        decoded.data.files[fIdx].url = decoded.data.files[fIdx].path;
      }
    }
    // site name in the envelope
    if (opts.cloneName) {
      decoded.site = opts.cloneName;
    }
    fs.writeFileSync(
      cloneFilesJsonPath,
      JSON.stringify(decoded, null, 2),
      'utf8',
    );
    return true;
  } catch (e) {
    // best-effort; clone still works if files.json rewrite fails
    return false;
  }
}

cloneSite.rewriteCloneFilesJson = rewriteCloneFilesJson;
cloneSite.replaceWithKnownPrefix = replaceWithKnownPrefix;
module.exports = cloneSite;
