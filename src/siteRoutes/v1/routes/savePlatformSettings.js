const { HAXCMS } = require("../../../lib/HAXCMS.js");
const {
  getRequestHeaderValue,
  assertSiteFeature,
  ensureSiteMetadataContainers,
  coerceBooleanLike,
} = require("../siteRouteUtils.js");

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
  const siteToken = getRequestHeaderValue(req, "x-haxcms-site-token");
  // Security: use the per-request authenticated identity resolved by
  // validateSiteApiRouteAccess rather than a process-global username so a
  // token minted for one authenticated user cannot validate under another.
  const activeUserName =
    req.haxcmsSiteApiAuth && req.haxcmsSiteApiAuth.userName
      ? req.haxcmsSiteApiAuth.userName
      : "";
  if (
    siteToken &&
    activeUserName &&
    HAXCMS.validateRequestToken(
      siteToken,
      activeUserName + ":" + req.body["site"]["name"],
    )
  ) {
    // load the site from name
    let site = await HAXCMS.loadSite(req.body["site"]["name"]);
    if (
      !assertSiteFeature(
        site,
        res,
        "siteManifest",
        "Platform settings are disabled for this site",
      )
    ) {
      return;
    }

    // Same messages as haxcms-php savePlatformSettings
    if (
      !req.body ||
      req.body.platform === undefined ||
      req.body.platform === null
    ) {
      res
        .status(400)
        .json({ status: 400, data: { message: "missing platform settings" } });
      return;
    }

    const platform = req.body.platform;

    // Validate payload shape

    const validFeatureKeys = [
      "addPage",
      "saveAndEdit",
      "deletePage",
      "outlineDesigner",
      "insights",
      "siteManifest",
      "themeManifest",
      "authorManifest",
      "seoManifest",
      "pageBreak",
      "addBlock",
      "popularGizmos",
      "recentGizmos",
      "contentMap",
      "viewSource",
      "uploadMedia",
      "onlineMedia",
      "community",
      "pageTemplates",
      "blockTemplates",
    ];
    const legacyFeatureKeyMap = {
      manifest: [
        "siteManifest",
        "themeManifest",
        "authorManifest",
        "seoManifest",
      ],
      onlineSearch: ["onlineMedia"],
      delete: ["deletePage"],
    };
    // objects and arrays both count as a feature list, as in haxcms-php
    const featureSources = [];
    if (platform.features && typeof platform.features === "object") {
      featureSources.push(platform.features);
    }
    if (platform.cmsFeatures && typeof platform.cmsFeatures === "object") {
      featureSources.push(platform.cmsFeatures);
    }
    if (
      platform.editorFeatures &&
      typeof platform.editorFeatures === "object"
    ) {
      featureSources.push(platform.editorFeatures);
    }
    if (featureSources.length === 0) {
      res
        .status(400)
        .json({ status: 400, data: { message: "invalid features" } });
      return;
    }

    const normalizedFeatures = {};
    for (const source of featureSources) {
      for (const key of Object.keys(source)) {
        // boolean-like values ("true", 1, "on") are stored as booleans,
        // as haxcms-php does
        const coerced = coerceBooleanLike(source[key]);
        if (coerced === null) {
          res.status(400).json({
            status: 400,
            data: { message: "invalid feature value for " + key },
          });
          return;
        }
        if (validFeatureKeys.includes(key)) {
          normalizedFeatures[key] = coerced;
        } else if (legacyFeatureKeyMap[key]) {
          for (const mappedKey of legacyFeatureKeyMap[key]) {
            normalizedFeatures[mappedKey] = coerced;
          }
        } else {
          res
            .status(400)
            .json({ status: 400, data: { message: "invalid feature key" } });
          return;
        }
      }
    }

    // Write features only. Audience and allowed blocks are managed by their
    // dedicated endpoints (saveEditorSettings / saveAllowedBlocks).
    ensureSiteMetadataContainers(site);
    if (
      !site.manifest.metadata.platform ||
      typeof site.manifest.metadata.platform !== "object" ||
      Array.isArray(site.manifest.metadata.platform)
    ) {
      site.manifest.metadata.platform = {};
    }
    site.manifest.metadata.platform.features = {};

    // only store supported feature keys
    for (const k of validFeatureKeys) {
      if (typeof normalizedFeatures[k] === "boolean") {
        site.manifest.metadata.platform.features[k] = normalizedFeatures[k];
      }
    }

    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);

    // don't reorganize the structure
    await site.manifest.save(false);
    await site.gitCommit("Platform settings updated");

    res.json({ status: 200, data: site.manifest });
  } else {
    res
      .status(403)
      .json({ status: 403, data: { message: "invalid site token" } });
  }
}

module.exports = savePlatformSettings;
