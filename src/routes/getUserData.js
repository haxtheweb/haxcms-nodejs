const { HAXCMS } = require('../lib/HAXCMS.js');
/**
 * @OA\Post(
 *    path="/getUserData",
 *    tags={"cms","authenticated","user","settings"},
 *    @OA\Parameter(
 *         name="jwt",
 *         description="JSON Web token, obtain by using  /login",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Load data about the logged in user"
 *   )
 * )
 */
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

function getUserTokenFromRequest(req) {
  const headerToken = getUserTokenFromHeader(req);
  if (headerToken !== '') {
    return headerToken;
  }
  if (
    req &&
    req.query &&
    typeof req.query === 'object' &&
    req.query['user_token']
  ) {
    return String(req.query['user_token']).trim();
  }
  return '';
}

function getUserData(req, res) {
  const userToken = getUserTokenFromRequest(req);
  if (
    userToken !== '' &&
    HAXCMS.validateRequestToken(userToken, HAXCMS.getActiveUserName())
  ) {
    const returnData = {
      status: 200,
      data: HAXCMS.userData,
    };
    res.send(returnData);
  } else {
    res.sendStatus(403);
  }
}

module.exports = getUserData;
