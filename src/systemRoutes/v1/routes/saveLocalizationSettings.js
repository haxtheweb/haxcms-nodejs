const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  hasSupportedLocalizationSettingsPayload,
  isValidDefaultLanguagePayloadValue,
  writeLocalizationSettings,
} = require('../../../lib/localizationSettings.js');

function getUserTokenFromHeader(req) {
  if (!req || !req.headers || typeof req.headers !== 'object') {
    return '';
  }
  const rawValue = req.headers['x-haxcms-user-token'];
  if (Array.isArray(rawValue)) {
    return rawValue.length > 0 ? String(rawValue[0] || '').trim() : '';
  }
  if (typeof rawValue === 'string') {
    return rawValue.trim();
  }
  return '';
}

/**
 * @OA\Post(
 *    path="/saveLocalizationSettings",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Persist localization settings"
 *   )
 * )
 */
async function saveLocalizationSettings(req, res) {
  const userToken = getUserTokenFromHeader(req);
  if (
    !userToken ||
    !HAXCMS.validateRequestToken(userToken, HAXCMS.getActiveUserName())
  ) {
    return res.status(403).json({
      status: 403,
      data: {
        message: 'invalid request token',
      },
    });
  }
  const payload = (
    req.body &&
    req.body.localizationSettings &&
    typeof req.body.localizationSettings === 'object' &&
    !Array.isArray(req.body.localizationSettings)
  ) ? req.body.localizationSettings : req.body;
  if (!hasSupportedLocalizationSettingsPayload(payload)) {
    return res.status(400).json({
      status: 400,
      data: {
        message: 'Missing localization settings payload',
      },
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, 'defaultLanguage') &&
    payload.defaultLanguage !== null &&
    typeof payload.defaultLanguage !== 'undefined' &&
    payload.defaultLanguage !== '' &&
    !isValidDefaultLanguagePayloadValue(payload.defaultLanguage)
  ) {
    return res.status(400).json({
      status: 400,
      data: {
        message: 'Invalid defaultLanguage value',
      },
    });
  }
  try {
    const localizationSettings = await writeLocalizationSettings(HAXCMS, payload);
    return res.json({
      status: 200,
      data: localizationSettings,
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to save localization settings',
      },
    });
  }
}

module.exports = saveLocalizationSettings;
