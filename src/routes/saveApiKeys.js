const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  hasSupportedApiKeyPayload,
  writeApiKeys,
} = require('../lib/apiKeys.js');

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
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())
  ) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
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
      message: 'Missing API key payload',
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
      message: 'Unable to save API key settings',
    });
  }
}

module.exports = saveApiKeys;
