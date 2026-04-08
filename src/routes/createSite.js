const { HAXCMS } = require('../lib/HAXCMS.js');
const GitPlus = require('../lib/GitPlus.js');
const JSONOutlineSchemaItem = require('../lib/JSONOutlineSchemaItem.js');
const HAXCMSFile = require('../lib/HAXCMSFile.js');
const fs = require('fs-extra');
const path = require('path');

const SAFE_BULK_IMPORT_EXTENSION_REGEX = /\.(jpg|jpeg|png|gif|webm|webp|mp4|mp3|mov|csv|ppt|pptx|xlsx|doc|xls|docx|pdf|rtf|txt|vtt|html|md)$/i;

function normalizeBulkImportName(locationName) {
  if (typeof locationName !== 'string') {
    return null;
  }
  let normalized = locationName.trim().replace(/\\/g, '/').replace(/^files\//, '');
  if (
    normalized === '' ||
    normalized.indexOf('\0') !== -1 ||
    normalized.startsWith('/') ||
    normalized.includes('..')
  ) {
    return null;
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      return null;
    }
  }
  return normalized;
}

function isSafeBulkImportSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string') {
    return false;
  }
  const normalizedSource = sourcePath.trim();
  if (normalizedSource === '' || normalizedSource.indexOf('\0') !== -1) {
    return false;
  }
  if (/^https?:\/\//i.test(normalizedSource)) {
    return true;
  }
  return path.isAbsolute(normalizedSource);
}

function normalizeSkeletonMachineName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\.json$/i, '').trim().toLowerCase();
}

async function resolveSkeletonBuildByMachineName(machineName) {
  const normalizedTarget = normalizeSkeletonMachineName(machineName);
  if (normalizedTarget === '') {
    return null;
  }
  const dirs = [
    path.join(HAXCMS.configDirectory, 'user', 'skeletons'),
    path.join(HAXCMS.configDirectory, 'skeletons'),
    path.join(HAXCMS.coreConfigPath, 'skeletons')
  ];
  for (const dir of dirs) {
    if (!(await fs.pathExists(dir))) {
      continue;
    }
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (path.extname(file).toLowerCase() !== '.json') {
        continue;
      }
      const filePath = path.join(dir, file);
      let skeleton;
      try {
        skeleton = JSON.parse(await fs.readFile(filePath, 'utf8'));
      }
      catch (e) {
        continue;
      }
      const normalizedFileName = normalizeSkeletonMachineName(
        path.basename(file, '.json')
      );
      const normalizedMetaMachineName = normalizeSkeletonMachineName(
        skeleton && skeleton.meta && typeof skeleton.meta.machineName === 'string'
          ? skeleton.meta.machineName
          : ''
      );
      const normalizedMetaName = normalizeSkeletonMachineName(
        skeleton && skeleton.meta && typeof skeleton.meta.name === 'string'
          ? skeleton.meta.name
          : ''
      );
      if (
        normalizedTarget === normalizedFileName ||
        normalizedTarget === normalizedMetaMachineName ||
        normalizedTarget === normalizedMetaName
      ) {
        return {
          filePath,
          skeleton,
        };
      }
    }
  }
  return null;
}

async function resolveSkeletonBuildByThemeMachineName(machineName) {
  const normalizedTarget = normalizeSkeletonMachineName(machineName);
  if (normalizedTarget === '') {
    return null;
  }
  const themesAry = HAXCMS.getThemes();
  if (!isObjectLike(themesAry)) {
    return null;
  }
  let matchedThemeKey = null;
  for (const key of Object.keys(themesAry)) {
    const themeObj = themesAry[key];
    const normalizedKey = normalizeSkeletonMachineName(key);
    const normalizedElement = normalizeSkeletonMachineName(
      isObjectLike(themeObj) && typeof themeObj.element === 'string'
        ? themeObj.element
        : ''
    );
    if (
      normalizedTarget === normalizedKey ||
      (normalizedElement !== '' && normalizedTarget === normalizedElement)
    ) {
      matchedThemeKey = key;
      break;
    }
  }
  if (!matchedThemeKey) {
    return null;
  }
  const fallbackSkeleton = await resolveSkeletonBuildByMachineName('default-starter');
  let trustedSkeleton = null;
  let trustedSkeletonFilePath = null;
  if (fallbackSkeleton && isObjectLike(fallbackSkeleton.skeleton)) {
    trustedSkeleton = cloneJsonValue(fallbackSkeleton.skeleton, {});
    trustedSkeletonFilePath = fallbackSkeleton.filePath;
  }
  if (!isObjectLike(trustedSkeleton)) {
    trustedSkeleton = {
      meta: {},
      site: {},
      build: {
        type: 'skeleton',
        structure: 'from-skeleton',
        items: [],
        files: [],
      },
    };
    trustedSkeletonFilePath = 'generated:theme-fallback';
  }
  if (!isObjectLike(trustedSkeleton.meta)) {
    trustedSkeleton.meta = {};
  }
  trustedSkeleton.meta.machineName = matchedThemeKey;
  trustedSkeleton.meta.name = matchedThemeKey;
  if (!isObjectLike(trustedSkeleton.site)) {
    trustedSkeleton.site = {};
  }
  trustedSkeleton.site.theme = matchedThemeKey;
  if (
    isObjectLike(trustedSkeleton._skeleton) &&
    Object.prototype.hasOwnProperty.call(trustedSkeleton._skeleton, 'fullThemeConfig')
  ) {
    delete trustedSkeleton._skeleton.fullThemeConfig;
  }
  return {
    filePath: trustedSkeletonFilePath,
    skeleton: trustedSkeleton,
  };
}

function isObjectLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value, fallback = null) {
  if (typeof value === 'undefined' || value === null) {
    return fallback;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  }
  catch (e) {
    return fallback;
  }
}

function getTrustedSkeletonSettings(skeleton) {
  if (!isObjectLike(skeleton)) {
    return null;
  }
  if (isObjectLike(skeleton.site) && isObjectLike(skeleton.site.settings)) {
    return cloneJsonValue(skeleton.site.settings, null);
  }
  if (isObjectLike(skeleton._skeleton) && isObjectLike(skeleton._skeleton.originalSettings)) {
    return cloneJsonValue(skeleton._skeleton.originalSettings, null);
  }
  if (
    isObjectLike(skeleton._skeleton) &&
    isObjectLike(skeleton._skeleton.originalMetadata) &&
    isObjectLike(skeleton._skeleton.originalMetadata.site) &&
    isObjectLike(skeleton._skeleton.originalMetadata.site.settings)
  ) {
    return cloneJsonValue(skeleton._skeleton.originalMetadata.site.settings, null);
  }
  return null;
}

function getTrustedSkeletonPlatform(skeleton) {
  if (!isObjectLike(skeleton)) {
    return null;
  }
  if (isObjectLike(skeleton.site) && isObjectLike(skeleton.site.platform)) {
    return cloneJsonValue(skeleton.site.platform, null);
  }
  if (
    isObjectLike(skeleton._skeleton) &&
    isObjectLike(skeleton._skeleton.originalMetadata) &&
    isObjectLike(skeleton._skeleton.originalMetadata.platform)
  ) {
    return cloneJsonValue(skeleton._skeleton.originalMetadata.platform, null);
  }
  return null;
}

function getTrustedSkeletonTheme(skeleton, themesAry = {}) {
  if (!isObjectLike(skeleton)) {
    return null;
  }
  let theme = null;
  if (
    isObjectLike(skeleton._skeleton) &&
    isObjectLike(skeleton._skeleton.fullThemeConfig)
  ) {
    const fullThemeConfig = skeleton._skeleton.fullThemeConfig;
    let themeBase = {};
    if (isObjectLike(fullThemeConfig.settings)) {
      themeBase = cloneJsonValue(fullThemeConfig.settings, {});
    }
    if (
      typeof fullThemeConfig.element === 'string' &&
      fullThemeConfig.element !== ''
    ) {
      themeBase.element = fullThemeConfig.element;
    }
    if (isObjectLike(fullThemeConfig.variables)) {
      themeBase.variables = cloneJsonValue(fullThemeConfig.variables, {});
    }
    theme = themeBase;
  }
  const skeletonThemeElement =
    isObjectLike(skeleton.site) &&
    typeof skeleton.site.theme === 'string' &&
    skeleton.site.theme !== ''
      ? skeleton.site.theme
      : '';
  if (
    (!isObjectLike(theme) || Object.keys(theme).length === 0) &&
    skeletonThemeElement &&
    isObjectLike(themesAry[skeletonThemeElement])
  ) {
    theme = cloneJsonValue(themesAry[skeletonThemeElement], {});
  }
  if ((!isObjectLike(theme) || Object.keys(theme).length === 0) && isObjectLike(skeleton.theme)) {
    theme = cloneJsonValue(skeleton.theme, {});
  }
  if (!isObjectLike(theme) || Object.keys(theme).length === 0) {
    return null;
  }
  if (!theme.element && skeletonThemeElement) {
    theme.element = skeletonThemeElement;
  }
  if (
    !theme.element &&
    typeof theme.path === 'string' &&
    theme.path !== ''
  ) {
    const inferredElement = path.basename(theme.path, '.js');
    if (inferredElement) {
      theme.element = inferredElement;
    }
  }
  if (!isObjectLike(theme.variables)) {
    theme.variables = {};
  }
  return theme;
}

/**
   * @OA\Post(
   *    path="/createSite",
   *    tags={"cms","authenticated","site"},
   *    @OA\Parameter(
   *         name="jwt",
   *         description="JSON Web token, obtain by using  /login",
   *         in="query",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *     @OA\RequestBody(
   *        @OA\MediaType(
   *             mediaType="application/json",
   *             @OA\Schema(
   *                 @OA\Property(
   *                     property="site",
   *                     type="object"
   *                 ),
   *                 @OA\Property(
   *                     property="theme",
   *                     type="object"
   *                 ),
   *                 required={"site","node"},
   *                 example={
   *                    "site": {
   *                      "name": "mynewsite",
   *                      "domain": ""
   *                    },
   *                    "theme": {
   *                      "name": "learn-two-theme",
   *                      "variables": {
   *                        "image":"",
   *                        "icon":"",
   *                        "hexCode":"",
   *                        "cssVariable":"",
   *                        }                   
   *                    }
   *                 }
   *             )
   *         )
   *    ),
   *    @OA\Response(
   *        response="200",
   *        description="Create a new site"
   *   )
   * )
   */
async function createSite(req, res) {
  if (HAXCMS.validateRequestToken(req.body.token) && req.query['user_token'] && HAXCMS.validateRequestToken(req.query['user_token'], HAXCMS.getActiveUserName())){
    let domain = null;
    // woohoo we can edit this thing!
    if (req.body['site']['domain'] && req.body['site']['domain'] != null && req.body['site']['domain'] != '') {
      domain = req.body['site']['domain'];
    }
    // null in the event we get hits that don't have this
    let build = null;
    let filesToDownload = null;
    let trustedSkeleton = null;
    let trustedSkeletonFilePath = null;
    // support for build info. the details used to actually create this site originally
    if (req.body['build']) {
      build = {};
      // version of the platform used when originally created
      build.version = await HAXCMS.getHAXCMSVersion();
      // course, website, portfolio, etc
      build.structure = req.body['build']['structure'];
      // TYPE of structure we are creating
      build.type = req.body['build']['type'];
      if (build.type == 'docx import' || build.structure == "import" || build.structure == "from-skeleton") {
        // JSONOutlineSchemaItem Array
        build.items = req.body['build']['items'];
      }
      if (req.body['build']['files']) {
        filesToDownload = req.body['build']['files'];
      }
      const isFromSkeleton =
        build.structure === 'from-skeleton' &&
        req.body['build']['skeletonMachineName'] &&
        typeof req.body['build']['skeletonMachineName'] === 'string';
      if (isFromSkeleton) {
        let resolvedSkeleton = await resolveSkeletonBuildByMachineName(
          req.body['build']['skeletonMachineName']
        );
        if (!resolvedSkeleton || !resolvedSkeleton.skeleton) {
          resolvedSkeleton = await resolveSkeletonBuildByThemeMachineName(
            req.body['build']['skeletonMachineName']
          );
        }
        if (!resolvedSkeleton || !resolvedSkeleton.skeleton) {
          return res.status(400).send({
            status: 400,
            __failed: {
              status: 400,
              message: 'Unable to resolve skeletonMachineName for from-skeleton build',
              skeletonMachineName: req.body['build']['skeletonMachineName'],
            }
          });
        }
        trustedSkeleton = resolvedSkeleton.skeleton;
        trustedSkeletonFilePath = resolvedSkeleton.filePath;
        const trustedBuild = isObjectLike(trustedSkeleton.build)
          ? trustedSkeleton.build
          : {};
        if (typeof trustedBuild.structure === 'string' && trustedBuild.structure !== '') {
          build.structure = trustedBuild.structure;
        }
        if (typeof trustedBuild.type === 'string' && trustedBuild.type !== '') {
          build.type = trustedBuild.type;
        }
        build.items = Array.isArray(trustedBuild.items) ? trustedBuild.items : [];
        if (trustedBuild.files && typeof trustedBuild.files === 'object') {
          filesToDownload = trustedBuild.files;
        }
      }
    }
    const buildDebug = {
      structure: build && build.structure ? build.structure : null,
      type: build && build.type ? build.type : null,
      skeletonMachineName: req.body && req.body['build'] && req.body['build']['skeletonMachineName'] ? req.body['build']['skeletonMachineName'] : null,
      hasItems: !!(build && Array.isArray(build.items) && build.items.length > 0),
      itemCount: build && Array.isArray(build.items) ? build.items.length : 0,
      hasFiles: !!(filesToDownload && typeof filesToDownload === 'object' && Object.keys(filesToDownload).length > 0),
      fileCount: filesToDownload && typeof filesToDownload === 'object' ? Object.keys(filesToDownload).length : 0
    };
    const useTrustedSkeleton =
      build &&
      build.structure === 'from-skeleton' &&
      isObjectLike(trustedSkeleton);
    // sanitize name
    let name = HAXCMS.generateMachineName(req.body['site']['name']);
    let site = await HAXCMS.loadSite(
        name.toLowerCase(),
        true,
        domain,
        build
    );
    // now get a new item to reference this into the top level sites listing
    let schema = new JSONOutlineSchemaItem();
    schema.id = site.manifest.id;
    schema.title = name;
    schema.location =
        HAXCMS.basePath +
        HAXCMS.sitesDirectory +
        '/' +
        site.manifest.metadata.site.name +
        '/index.html';
    schema.slug = schema.location;
    schema.metadata = {
      site: {},
      theme: {},
    };
    if (useTrustedSkeleton) {
      const trustedPlatform = getTrustedSkeletonPlatform(trustedSkeleton);
      if (isObjectLike(trustedPlatform)) {
        schema.metadata.platform = trustedPlatform;
      }
    }
    if (!isObjectLike(schema.metadata.platform)) {
      // platform settings scaffold (prevents front-end null handling)
      schema.metadata.platform = {
        audience: 'expert',
        features: {},
        allowedBlocks: []
      };
    }
    // store build data in case we need it down the road
    if (build && !useTrustedSkeleton) {
      schema.metadata.build = build;
    }
    schema.metadata.site.name = site.manifest.metadata.site.name;
    let theme = HAXCMS.HAXCMS_DEFAULT_THEME;
    if (
      useTrustedSkeleton &&
      trustedSkeleton &&
      trustedSkeleton.site &&
      typeof trustedSkeleton.site.theme === 'string' &&
      trustedSkeleton.site.theme !== ''
    ) {
      theme = trustedSkeleton.site.theme;
    }
    else if (req.body['site']['theme'] && typeof req.body['site']['theme'] === "string") {
      theme = req.body['site']['theme'];
    }
    let themesAry = HAXCMS.getThemes();
    if (useTrustedSkeleton) {
      const trustedTheme = getTrustedSkeletonTheme(trustedSkeleton, themesAry);
      if (isObjectLike(trustedTheme)) {
        schema.metadata.theme = trustedTheme;
      }
    }
    // look for a match so we can set the correct data
    if (!isObjectLike(schema.metadata.theme) || Object.keys(schema.metadata.theme).length === 0) {
      for (var key in themesAry) {
        if (theme == key) {
          schema.metadata.theme = cloneJsonValue(themesAry[key], themesAry[key]);
        }
      }
    }
    if (!isObjectLike(schema.metadata.theme)) {
      schema.metadata.theme = {};
    }
    if (!isObjectLike(schema.metadata.theme.variables)) {
      schema.metadata.theme.variables = {};
    }
    // description for an overview if desired
    if (req.body['site']['description'] && req.body['site']['description'] != '' && req.body['site']['description'] != null) {
        schema.description = req.body['site']['description'].replace(/<\/?[^>]+(>|$)/g, "");
    }
    else if (
      useTrustedSkeleton &&
      trustedSkeleton &&
      trustedSkeleton.site &&
      trustedSkeleton.site.description &&
      typeof trustedSkeleton.site.description === 'string'
    ) {
      schema.description = trustedSkeleton.site.description.replace(/<\/?[^>]+(>|$)/g, "");
    }
    const incomingTheme =
      req.body &&
      req.body['theme'] &&
      typeof req.body['theme'] === 'object'
        ? req.body['theme']
        : {};
    // background image / banner
    if (incomingTheme['image'] && incomingTheme['image'] != '' && incomingTheme['image'] != null) {
      schema.metadata.site.logo = incomingTheme['image'];
    }
    else if (
      useTrustedSkeleton &&
      trustedSkeleton &&
      trustedSkeleton.site &&
      trustedSkeleton.site.logo &&
      typeof trustedSkeleton.site.logo === 'string'
    ) {
      schema.metadata.site.logo = trustedSkeleton.site.logo;
    }
    else {
      schema.metadata.site.logo = 'assets/banner.jpg';
    }
    // icon to express the concept / visually identify site
    if ((incomingTheme['icon']) && incomingTheme['icon'] != '' && incomingTheme['icon'] != null) {
      schema.metadata.theme.variables.icon = incomingTheme['icon'];
    }
    let hex = HAXCMS.HAXCMS_FALLBACK_HEX;
    if (
      schema.metadata.theme.variables.hexCode &&
      typeof schema.metadata.theme.variables.hexCode === 'string' &&
      schema.metadata.theme.variables.hexCode !== ''
    ) {
      hex = schema.metadata.theme.variables.hexCode;
    }
    // slightly style the site based on css vars and hexcode
    if ((incomingTheme['hexCode']) && incomingTheme['hexCode'] != '' && incomingTheme['hexCode'] != null) {
       hex = incomingTheme['hexCode'];
    }
    schema.metadata.theme.variables.hexCode = hex;
    let cssvar = '--simple-colors-default-theme-light-blue-7';
    if (
      schema.metadata.theme.variables.cssVariable &&
      typeof schema.metadata.theme.variables.cssVariable === 'string' &&
      schema.metadata.theme.variables.cssVariable !== ''
    ) {
      cssvar = schema.metadata.theme.variables.cssVariable;
    }
    if ((incomingTheme['cssVariable']) && incomingTheme['cssVariable'] != '' && incomingTheme['cssVariable'] != null) {
        cssvar = incomingTheme['cssVariable'];
    }
    schema.metadata.theme.variables.cssVariable = cssvar;
    let trustedSettings = null;
    if (useTrustedSkeleton) {
      trustedSettings = getTrustedSkeletonSettings(trustedSkeleton);
    }
    if (isObjectLike(trustedSettings)) {
      schema.metadata.site.settings = trustedSettings;
    }
    else {
      schema.metadata.site.settings = {};
    }
    if (!schema.metadata.site.settings.lang) {
      schema.metadata.site.settings.lang = 'en-US';
    }
    if (typeof schema.metadata.site.settings.publishPagesOn === 'undefined') {
      schema.metadata.site.settings.publishPagesOn = true;
    }
    if (typeof schema.metadata.site.settings.canonical === 'undefined') {
      schema.metadata.site.settings.canonical = true;
    }
    schema.metadata.site.created = Math.floor(Date.now() / 1000);
    schema.metadata.site.updated = Math.floor(Date.now() / 1000);
    // check for publishing settings being set globally in HAXCMS
    // this would allow them to fork off to different locations down stream
    schema.metadata.site.git = {};
    if (HAXCMS.config.site.git.vendor) {
        schema.metadata.site.git = HAXCMS.config.site.git;
        delete schema.metadata.site.git.keySet;
        delete schema.metadata.site.git.email;
        delete schema.metadata.site.git.user;
    }
    // mirror the metadata information into the site's info
    // this means that this info is available to the full site listing
    // as well as this individual site. saves on performance / calls
    // later on if we only need to hit 1 file each time to get all the
    // data we need.
    for (var key in schema.metadata) {
        site.manifest.metadata[key] = schema.metadata[key];
    }
    site.manifest.metadata.node = {};
    site.manifest.metadata.node.fields = {};
    site.manifest.description = schema.description;
    // save the outline into the new site
    await site.manifest.save(false);
    // walk through files if any came across and save each of them
    if (filesToDownload && typeof filesToDownload === 'object') {
      for (var locationName in filesToDownload) {
        let downloadLocation = filesToDownload[locationName];
        const normalizedImportName = normalizeBulkImportName(locationName);
        if (
          !normalizedImportName ||
          !SAFE_BULK_IMPORT_EXTENSION_REGEX.test(normalizedImportName) ||
          !isSafeBulkImportSourcePath(downloadLocation)
        ) {
          return res.status(400).send({
            status: 400,
            __failed: {
              status: 400,
              message: 'Invalid file import payload in build.files',
              file: locationName
            }
          });
        }
        let file = new HAXCMSFile();
        // check for a file upload; we block a few formats by design
        await file.save({
          "name": normalizedImportName,
          "tmp_name": downloadLocation,
          "path": downloadLocation,
          "bulk-import": true
        }, site);
      }
    }
    // main site schema doesn't care about publishing settings
    delete schema.metadata.site.git;

    try {
      const git = new GitPlus({
        dir: site.siteDirectory,
        cliVersion: await HAXCMS.gitTest()
      });
      git.setDir(site.siteDirectory);
      await git.init();
      await git.add();
      await git.commit('A new journey begins: ' + site.manifest.title + ' (' + site.manifest.id + ')');
      // make a branch but dont use it
      if (site.manifest.metadata.site.git && site.manifest.metadata.site.git.staticBranch) {
        await git.createBranch(
          site.manifest.metadata.site.git.staticBranch
        );
      }
      if (site.manifest.metadata.site.git && site.manifest.metadata.site.git.branch) {
        await git.createBranch(
          site.manifest.metadata.site.git.branch
        );
      }
    }
    catch(e) {}
    res.send({
      "status": 200,
      "data": schema
    });
  }
  else {
    res.sendStatus(403);
  }
}
module.exports = createSite;