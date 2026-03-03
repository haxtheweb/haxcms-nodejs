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
 *        description="Save platform settings into site.json metadata.platform"
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
    const allowedAudiences = ['novice', 'expert'];
    if (!platform.audience || !allowedAudiences.includes(platform.audience)) {
      res.sendStatus(400);
      return;
    }

    const validFeatureKeys = [
      'addPage',
      'deletePage',
      'outlineDesigner',
      'styleGuide',
      'insights',
      'manifest',
      'pageBreak',
      'addBlock',
      'contentMap',
      'viewSource',
      'onlineSearch',
    ];

    if (!platform.features || typeof platform.features !== 'object') {
      res.sendStatus(400);
      return;
    }

    for (const key of Object.keys(platform.features)) {
      if (!validFeatureKeys.includes(key) || typeof platform.features[key] !== 'boolean') {
        res.sendStatus(400);
        return;
      }
    }

    if (!Array.isArray(platform.allowedBlocks)) {
      res.sendStatus(400);
      return;
    }

    const wcMap = HAXCMS.getWCRegistryJson(site);

    const cleanAllowedBlocks = [];
    for (const tag of platform.allowedBlocks) {
      if (typeof tag !== 'string') {
        res.sendStatus(400);
        return;
      }

      // Allow basic HTML primitives (no dash) OR web components found in wc-registry
      const isHtmlTag = /^[a-z][a-z0-9]*$/.test(tag) && !tag.includes('-');
      const isRegisteredWc = !isHtmlTag && wcMap && typeof wcMap[tag] !== 'undefined';

      if (!isHtmlTag && !isRegisteredWc) {
        res.sendStatus(400);
        return;
      }

      cleanAllowedBlocks.push(tag);
    }

    const uniqueAllowedBlocks = [...new Set(cleanAllowedBlocks)].sort();

    // Write to manifest metadata.platform (overwrite the group)
    if (!site.manifest.metadata) {
      site.manifest.metadata = {};
    }
    if (!site.manifest.metadata.site) {
      site.manifest.metadata.site = {};
    }

    site.manifest.metadata.platform = {
      audience: platform.audience,
      features: {},
      allowedBlocks: uniqueAllowedBlocks,
    };

    // only store supported feature keys
    for (const k of validFeatureKeys) {
      if (typeof platform.features[k] === 'boolean') {
        site.manifest.metadata.platform.features[k] = platform.features[k];
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
