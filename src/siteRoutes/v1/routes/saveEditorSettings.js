const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  platformAllows,
  featureDisabledResponse,
} = require('../../../lib/platformFeatures.js');
const { getRequestHeaderValue } = require('../siteRouteUtils.js');

/**
 * @OA\Post(
 *    path="/saveEditorSettings",
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
 *        description="Save editor settings into site.json metadata.platform.audience"
 *   )
 * )
 */
async function saveEditorSettings(req, res) {
  const siteToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
  if (
    siteToken &&
    req.body &&
    req.body.site &&
    req.body.site.name &&
    HAXCMS.validateRequestToken(
      siteToken,
      HAXCMS.getActiveUserName() + ':' + req.body.site.name,
    )
  ) {
    const site = await HAXCMS.loadSite(req.body.site.name);
    if (!platformAllows(site, 'siteManifest')) {
      return featureDisabledResponse(
        res,
        'Editor settings are disabled for this site'
      );
    }

    if (!req.body || typeof req.body.platform !== 'object' || !req.body.platform) {
      res.sendStatus(400);
      return;
    }

    const audienceRaw =
      typeof req.body.platform.audience === 'string'
        ? req.body.platform.audience.trim().toLowerCase()
        : '';
    const allowedAudiences = ['novice', 'expert'];
    if (!allowedAudiences.includes(audienceRaw)) {
      res.sendStatus(400);
      return;
    }

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

    site.manifest.metadata.platform.audience = audienceRaw;
    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);

    await site.manifest.save(false);
    await site.gitCommit('Editor settings updated');

    res.send(site.manifest);
  } else {
    res.sendStatus(403);
  }
}

module.exports = saveEditorSettings;
