const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  generateSiteSkeleton,
  normalizeMachineName,
} = require('./siteSkeletonHelpers.js');

/**
   * @OA\Post(
   *    path="/saveSiteAsTemplate",
   *    tags={"cms","authenticated","site","meta"},
   *    @OA\Parameter(
   *         name="user_token",
   *         description="User validation token",
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
   *        description="Generate and save a reusable site template skeleton"
   *   )
   * )
   */
async function saveSiteAsTemplate(req, res) {
  if (
    !req.body ||
    !req.body.site ||
    typeof req.body.site.name !== 'string' ||
    req.body.site.name.trim() === ''
  ) {
    return res.status(400).json({
      status: 400,
      data: { message: 'site.name is required' },
    });
  }
  const site = await HAXCMS.loadSite(req.body.site.name);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      data: { message: 'Site not found' },
    });
  }
  try {
    const skeleton = await generateSiteSkeleton(site);
    const machineName = normalizeMachineName(
      skeleton &&
        skeleton.meta &&
        typeof skeleton.meta.machineName === 'string'
        ? skeleton.meta.machineName
        : req.body.site.name,
    );
    skeleton.meta.machineName = machineName;
    skeleton.meta.name = machineName;
    const templateDir = path.join(HAXCMS.configDirectory, 'user', 'skeletons');
    await fs.ensureDir(templateDir);
    const fileName = `${machineName}.json`;
    const filePath = path.join(templateDir, fileName);
    await fs.writeFile(filePath, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8');
    const baseAPIPath = `${HAXCMS.basePath}${HAXCMS.systemRequestBase}/`;
    const templateLink = `${baseAPIPath}v1/skeletons/${encodeURIComponent(machineName)}`;
    return res.send({
      status: 200,
      data: {
        saved: true,
        name: machineName,
        filename: fileName,
        path: filePath,
        link: templateLink,
      },
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: { message: `Failed to save site template: ${e.message}` },
    });
  }
}

module.exports = saveSiteAsTemplate;
