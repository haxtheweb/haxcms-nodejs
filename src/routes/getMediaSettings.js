const { HAXCMS } = require('../lib/HAXCMS.js');
const { readMediaSettings } = require('../lib/mediaSettings.js');

/**
 * @OA\Post(
 *    path="/getMediaSettings",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Load saved media settings"
 *   )
 * )
 */
async function getMediaSettings(req, res) {
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())
  ) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }
  try {
    const mediaSettings = await readMediaSettings(HAXCMS);
    return res.json({
      status: 200,
      data: mediaSettings,
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      message: 'Unable to load media settings',
    });
  }
}

module.exports = getMediaSettings;
