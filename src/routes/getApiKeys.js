const { HAXCMS } = require('../lib/HAXCMS.js');
const { readApiKeys } = require('../lib/apiKeys.js');

/**
 * @OA\Post(
 *    path="/getApiKeys",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Load saved integration API keys"
 *   )
 * )
 */
async function getApiKeys(req, res) {
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
    const apiKeys = await readApiKeys(HAXCMS);
    return res.json({
      status: 200,
      data: apiKeys,
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      message: 'Unable to load API key settings',
    });
  }
}

module.exports = getApiKeys;
