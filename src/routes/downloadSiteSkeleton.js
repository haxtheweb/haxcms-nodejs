const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  generateSiteSkeleton,
  normalizeMachineName,
} = require('./siteSkeletonHelpers.js');

/**
   * @OA\Post(
   *    path="/downloadSiteSkeleton",
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
   *        description="Generate and return the site skeleton JSON"
   *   )
   * )
   */
async function downloadSiteSkeleton(req, res) {
  if (!req.query['user_token'] || !HAXCMS.validateRequestToken(req.query['user_token'], HAXCMS.getActiveUserName())) {
    return res.sendStatus(403);
  }
  if (
    !req.body ||
    !req.body.site ||
    typeof req.body.site.name !== 'string' ||
    req.body.site.name.trim() === ''
  ) {
    return res.status(400).send({
      status: 400,
      message: 'site.name is required',
    });
  }
  const site = await HAXCMS.loadSite(req.body.site.name);
  if (!site || !site.manifest) {
    return res.status(404).send({
      status: 404,
      message: 'Site not found',
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
    if (!skeleton.meta || typeof skeleton.meta !== 'object') {
      skeleton.meta = {};
    }
    skeleton.meta.machineName = machineName;
    skeleton.meta.name = machineName;
    return res.send({
      status: 200,
      data: {
        skeleton,
        filename: `${machineName}.json`,
      },
    });
  }
  catch (e) {
    return res.status(500).send({
      status: 500,
      message: `Failed to generate site skeleton: ${e.message}`,
    });
  }
}

module.exports = downloadSiteSkeleton;
