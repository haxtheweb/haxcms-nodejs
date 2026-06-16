const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  platformAllows,
  featureDisabledResponse,
} = require('../../../lib/platformFeatures.js');

/**
 * @OA\Post(
 *    path="/saveAllowedBlocks",
 *    tags={"cms","authenticated"},
 *    @OA\Parameter(
 *         name="site_token",
 *         description="Site-specific validation token",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Save allowed blocks into site.json metadata.platform.allowedBlocks"
 *   )
 * )
 */
async function saveAllowedBlocks(req, res) {
  if (
    req.query['site_token'] &&
    HAXCMS.validateRequestToken(
      req.query['site_token'],
      HAXCMS.getActiveUserName() + ':' + req.body['site']['name'],
    )
  ) {
    // load the site from name
    let site = await HAXCMS.loadSite(req.body['site']['name']);
    if (!platformAllows(site, 'siteManifest')) {
      return featureDisabledResponse(
        res,
        'Allowed blocks settings are disabled for this site'
      );
    }

    if (!req.body || typeof req.body.platform !== 'object' || !req.body.platform) {
      res.sendStatus(400);
      return;
    }

    if (
      req.body.platform.allowedBlocks !== null &&
      !Array.isArray(req.body.platform.allowedBlocks)
    ) {
      res.sendStatus(400);
      return;
    }

    let uniqueAllowedBlocks = null;
    if (Array.isArray(req.body.platform.allowedBlocks)) {
      const wcMap = HAXCMS.getWCRegistryJson(site);

      const cleanAllowedBlocks = [];
      for (const tag of req.body.platform.allowedBlocks) {
        if (typeof tag !== 'string') {
          res.sendStatus(400);
          return;
        }

        const cleanTag = tag.trim();
        if (!cleanTag) {
          res.sendStatus(400);
          return;
        }

        // Allow basic HTML primitives (no dash) OR web components found in wc-registry
        const isHtmlTag = /^[a-z][a-z0-9]*$/.test(cleanTag) && !cleanTag.includes('-');
        const isRegisteredWc = !isHtmlTag && wcMap && typeof wcMap[cleanTag] !== 'undefined';

        if (!isHtmlTag && !isRegisteredWc) {
          res.sendStatus(400);
          return;
        }

        cleanAllowedBlocks.push(cleanTag);
      }

      uniqueAllowedBlocks = [...new Set(cleanAllowedBlocks)].sort();
    }

    if (!site.manifest.metadata) {
      site.manifest.metadata = {};
    }
    if (!site.manifest.metadata.site) {
      site.manifest.metadata.site = {};
    }
    if (!site.manifest.metadata.platform || typeof site.manifest.metadata.platform !== 'object') {
      site.manifest.metadata.platform = {
        audience: 'expert',
        features: {},
        allowedBlocks: [],
      };
    }

    site.manifest.metadata.platform.allowedBlocks = uniqueAllowedBlocks;
    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);

    // don't reorganize the structure
    await site.manifest.save(false);
    await site.gitCommit('Allowed blocks updated');

    res.send(site.manifest);
  } else {
    res.sendStatus(403);
  }
}

module.exports = saveAllowedBlocks;
