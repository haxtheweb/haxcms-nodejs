const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  hasSupportedMediaSettingsPayload,
  normalizeJpegQuality,
  normalizeMaxUploadSizeMb,
  normalizeAcceptedFormats,
  writeMediaSettings,
} = require('../../../lib/mediaSettings.js');

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
 *    path="/saveMediaSettings",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Persist media settings"
 *   )
 * )
 */
async function saveMediaSettings(req, res) {
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
    req.body.mediaSettings &&
    typeof req.body.mediaSettings === 'object' &&
    !Array.isArray(req.body.mediaSettings)
  ) ? req.body.mediaSettings : req.body;
  if (!hasSupportedMediaSettingsPayload(payload)) {
    return res.status(400).json({
      status: 400,
      data: {
        message: 'Missing media settings payload',
      },
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, 'jpegQuality') &&
    payload.jpegQuality !== null &&
    typeof payload.jpegQuality !== 'undefined' &&
    payload.jpegQuality !== '' &&
    normalizeJpegQuality(payload.jpegQuality) === null
  ) {
    return res.status(400).json({
      status: 400,
      data: {
        message: 'Invalid jpegQuality value',
      },
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, 'maxUploadSizeMb') &&
    payload.maxUploadSizeMb !== null &&
    typeof payload.maxUploadSizeMb !== 'undefined' &&
    payload.maxUploadSizeMb !== '' &&
    normalizeMaxUploadSizeMb(payload.maxUploadSizeMb) === null
  ) {
    return res.status(400).json({
      status: 400,
      data: {
        message: 'Invalid maxUploadSizeMb value',
      },
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, 'acceptedFormats') &&
    payload.acceptedFormats !== null &&
    typeof payload.acceptedFormats !== 'undefined' &&
    payload.acceptedFormats !== '' &&
    normalizeAcceptedFormats(payload.acceptedFormats) === null
  ) {
    return res.status(400).json({
      status: 400,
      data: {
        message: 'Invalid acceptedFormats value',
      },
    });
  }
  try {
    const mediaSettings = await writeMediaSettings(HAXCMS, payload);
    return res.json({
      status: 200,
      data: mediaSettings,
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to save media settings',
      },
    });
  }
}

module.exports = saveMediaSettings;
