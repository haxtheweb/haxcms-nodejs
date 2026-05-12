const { HAXCMS } = require('../lib/HAXCMS.js');
const path = require('path');

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
    if (req.query['user_token'] && HAXCMS.validateRequestToken(req.query['user_token'], HAXCMS.getActiveUserName())) {
      let site = await HAXCMS.loadSite(req.body['site']['name']);
      const originalSiteName = site.manifest.metadata.site.name;

      let cloneName = HAXCMS.getUniqueName(site.name);
      // ensure the path to the new folder is valid
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
      // loop through all items and rewrite the path to files as we cloned it
      for (var delta in newSite.manifest.items) {
        let item = newSite.manifest.items[delta];
        if (item.metadata.files) {
          for (var delta2 in item.metadata.files) {
            if (newSite.manifest.items[delta].metadata.files[delta2].path) {
              let migratedPath =
                newSite.manifest.items[delta].metadata.files[delta2].path;
              migratedPath = replaceWithKnownPrefix(
                migratedPath,
                [sourceFileSystemPrefix],
                targetFileSystemPrefix,
              );
              migratedPath = replaceWithKnownPrefix(
                migratedPath,
                sourceUrlPrefixes,
                targetUrlPrefix,
              );
              newSite.manifest.items[delta].metadata.files[delta2].path = migratedPath;
            }
            if (newSite.manifest.items[delta].metadata.files[delta2].fullUrl) {
              let migratedFullUrl =
                newSite.manifest.items[delta].metadata.files[delta2].fullUrl;
              migratedFullUrl = replaceWithKnownPrefix(
                migratedFullUrl,
                [sourceFileSystemPrefix],
                targetFileSystemPrefix,
              );
              migratedFullUrl = replaceWithKnownPrefix(
                migratedFullUrl,
                sourceUrlPrefixes,
                targetUrlPrefix,
              );
              newSite.manifest.items[delta].metadata.files[delta2].fullUrl =
                migratedFullUrl;
            }
          }
        }
      }

      await newSite.save();
      res.send({
        status: 200,
        data: {
          link:
            HAXCMS.basePath +
            HAXCMS.sitesDirectory +
            '/' +
            cloneName,
          name: cloneName,
        },
      });
    } else {
      res.sendStatus(403);
    }
  }
module.exports = cloneSite;
