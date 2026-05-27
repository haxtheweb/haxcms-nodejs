const { HAXCMS } = require('../lib/HAXCMS.js');
const { buildNodeSystemStatusReport } = require('../lib/systemStatus.js');

/**
 * System status report for app-hax system settings.
 * Returns backend-agnostic summary and status rows.
 *
 * @OA\Post(
 *    path="/systemStatus",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="System status report"
 *   )
 * )
 */
async function systemStatus(req, res) {
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(
      req.query.user_token,
      HAXCMS.getActiveUserName(),
    )
  ) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }
  const report = await buildNodeSystemStatusReport(HAXCMS, req);
  return res.json({
    status: 200,
    data: report,
  });
}

module.exports = systemStatus;
