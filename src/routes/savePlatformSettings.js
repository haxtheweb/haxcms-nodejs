const { HAXCMS } = require('../lib/HAXCMS.js');

/**
 * @OA\Post(
 *    path="/savePlatformSettings",
 *    tags={"cms","authenticated"},
 *    @OA\Parameter(
 *         name="jwt",
 *         description="JSON Web token, obtain by using  /login",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Save platform feature settings into site.json metadata.platform.features"
 *   )
 * )
 */
async function savePlatformSettings(req, res) {
  if (
    req.query['site_token'] &&
    HAXCMS.validateRequestToken(
      req.query['site_token'],
      HAXCMS.getActiveUserName() + ':' + req.body['site']['name'],
    )
  ) {
    // load the site from name
    let site = await HAXCMS.loadSite(req.body['site']['name']);

    if (!req.body || typeof req.body.platform !== 'object' || !req.body.platform) {
      res.sendStatus(400);
      return;
    }

    const platform = req.body.platform;

    // Validate payload shape

    const validFeatureKeys = [
      'addPage',
      'saveAndEdit',
      'deletePage',
      'outlineDesigner',
      'styleGuide',
      'insights',
      'siteManifest',
      'themeManifest',
      'authorManifest',
      'seoManifest',
      'pageBreak',
      'addBlock',
      'popularGizmos',
      'recentGizmos',
      'contentMap',
      'viewSource',
      'uploadMedia',
      'onlineMedia',
      'community',
      'pageTemplates',
      'blockTemplates',
    ];
    const legacyFeatureKeyMap = {
      manifest: ['siteManifest', 'themeManifest', 'authorManifest', 'seoManifest'],
      onlineSearch: ['onlineMedia'],
      delete: ['deletePage'],
    };
    const featureSources = [];
    if (
      platform.features &&
      typeof platform.features === 'object' &&
      !Array.isArray(platform.features)
    ) {
      featureSources.push(platform.features);
    }
    if (
      platform.cmsFeatures &&
      typeof platform.cmsFeatures === 'object' &&
      !Array.isArray(platform.cmsFeatures)
    ) {
      featureSources.push(platform.cmsFeatures);
    }
    if (
      platform.editorFeatures &&
      typeof platform.editorFeatures === 'object' &&
      !Array.isArray(platform.editorFeatures)
    ) {
      featureSources.push(platform.editorFeatures);
    }
    if (featureSources.length === 0) {
      res.sendStatus(400);
      return;
    }

    const normalizedFeatures = {};
    for (const source of featureSources) {
      for (const key of Object.keys(source)) {
        if (typeof source[key] !== 'boolean') {
          res.sendStatus(400);
          return;
        }
        if (validFeatureKeys.includes(key)) {
          normalizedFeatures[key] = source[key];
        } else if (legacyFeatureKeyMap[key]) {
          for (const mappedKey of legacyFeatureKeyMap[key]) {
            normalizedFeatures[mappedKey] = source[key];
          }
        } else {
          res.sendStatus(400);
          return;
        }
      }
    }

    // Write features only. Audience and allowed blocks are managed by their
    // dedicated endpoints (saveEditorSettings / saveAllowedBlocks).
    if (!site.manifest.metadata) {
      site.manifest.metadata = {};
    }
    if (!site.manifest.metadata.site) {
      site.manifest.metadata.site = {};
    }
    if (
      !site.manifest.metadata.platform ||
      typeof site.manifest.metadata.platform !== 'object' ||
      Array.isArray(site.manifest.metadata.platform)
    ) {
      site.manifest.metadata.platform = {};
    }
    site.manifest.metadata.platform.features = {};

    // only store supported feature keys
    for (const k of validFeatureKeys) {
      if (typeof normalizedFeatures[k] === 'boolean') {
        site.manifest.metadata.platform.features[k] = normalizedFeatures[k];
      }
    }

    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);

    // don't reorganize the structure
    await site.manifest.save(false);
    await site.gitCommit('Platform settings updated');

    res.send(site.manifest);
  } else {
    res.sendStatus(403);
  }
}

module.exports = savePlatformSettings;
