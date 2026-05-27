const { HAXCMS } = require('../lib/HAXCMS.js');
const { courseStatsFromOutline } = require('../lib/JOSHelpers.js');


function normalizeActiveId(body = {}) {
  let itemId = null;
  if (typeof body.activeId !== 'undefined' && body.activeId !== null) {
    itemId = body.activeId;
  }
  if (itemId === 'null') {
    itemId = null;
  }
  return itemId;
}

/**
 * @OA\Post(
 *    path="/linkChecker",
 *    tags={"cms","authenticated","reports"},
 *    @OA\Response(
 *        response="200",
 *        description="Load link checker report data"
 *   )
 * )
 */
async function linkChecker(req, res) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const siteName =
    body && body.site && body.site.name ? String(body.site.name).trim() : '';
  if (
    req.query['site_token'] &&
    siteName &&
    HAXCMS.validateRequestToken(
      req.query['site_token'],
      HAXCMS.getActiveUserName() + ':' + siteName
    )
  ) {
    const site = await HAXCMS.loadSite(siteName);
    if (!site || !site.manifest) {
      return res.send({
        status: 200,
        data: {},
      });
    }
    const itemId = normalizeActiveId(body);
    const data = await courseStatsFromOutline('', site, itemId, [
      'linkData',
    ]);
    return res.send({
      status: 200,
      data: data,
    });
  }
  return res.sendStatus(403);
}

module.exports = linkChecker;
