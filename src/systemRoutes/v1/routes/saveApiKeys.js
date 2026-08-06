const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  hasSupportedApiKeyPayload,
  writeApiKeys,
} = require('../../../lib/apiKeys.js');

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
 *    path="/saveApiKeys",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Persist integration API keys"
 *   )
 * )
 */
async function saveApiKeys(req, res) {
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
    req.body.apiKeys &&
    typeof req.body.apiKeys === 'object' &&
    !Array.isArray(req.body.apiKeys)
  ) ? req.body.apiKeys : req.body;
  if (!hasSupportedApiKeyPayload(payload)) {
    return res.status(400).json({
      status: 400,
      data: {
        message: 'Missing API key payload',
      },
    });
  }
  try {
    const apiKeys = await writeApiKeys(HAXCMS, payload);
    return res.json({
      status: 200,
      data: apiKeys,
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to save API key settings',
      },
    });
  }
}

module.exports = saveApiKeys;
