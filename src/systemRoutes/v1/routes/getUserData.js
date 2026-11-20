const { HAXCMS } = require("../../../lib/HAXCMS.js");
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
function getUserData(req, res) {
  // userData.json is shared by the install and its boilerplate has no
  // userName, so the signed-in name fills it in. The dashboard and the site
  // label the user menu with it and key the saved character to it (parity
  // with haxcms-php OperationsRouteGetUserData).
  const data = Object.assign({}, HAXCMS.userData);
  if (typeof data.userName !== "string" || data.userName === "") {
    data.userName = HAXCMS.getRequestTokenUserName(req) || "";
  }
  const returnData = {
    status: 200,
    data: data,
  };
  res.send(returnData);
}

module.exports = getUserData;
