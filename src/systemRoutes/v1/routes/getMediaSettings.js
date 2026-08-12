const { HAXCMS } = require('../../../lib/HAXCMS.js');
const { readMediaSettings, getEffectiveMediaSettings } = require('../../../lib/mediaSettings.js');

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
  try {
    const mediaSettings = await readMediaSettings(HAXCMS);
    return res.json({
      status: 200,
      data: getEffectiveMediaSettings(mediaSettings),
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to load media settings',
      },
    });
  }
}

module.exports = getMediaSettings;
