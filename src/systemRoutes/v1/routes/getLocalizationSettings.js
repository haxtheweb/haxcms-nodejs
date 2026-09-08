const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  readLocalizationSettings,
  getEffectiveLocalizationSettings,
} = require('../../../lib/localizationSettings.js');

/**
 * @OA\Post(
 *    path="/getLocalizationSettings",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Load saved localization settings"
 *   )
 * )
 */
async function getLocalizationSettings(req, res) {
  try {
    const localizationSettings = await readLocalizationSettings(HAXCMS);
    return res.json({
      status: 200,
      data: getEffectiveLocalizationSettings(localizationSettings),
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to load localization settings',
      },
    });
  }
}

module.exports = getLocalizationSettings;
