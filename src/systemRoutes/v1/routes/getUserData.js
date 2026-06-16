const { HAXCMS } = require('../../../lib/HAXCMS.js');
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

function getUserData(req, res) {
  const returnData = {
    status: 200,
    data: HAXCMS.userData,
  };
  res.send(returnData);
}

module.exports = getUserData;
