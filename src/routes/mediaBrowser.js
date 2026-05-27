const { HAXCMS } = require('../lib/HAXCMS.js');
const { courseStatsFromOutline } = require('../lib/JOSHelpers.js');

function normalizeSiteLocation(body = {}) {
  let siteLocation = '';
  if (body && typeof body.link === 'string' && body.link !== '') {
    siteLocation = body.link;
  }
  else if (
    body &&
    body.site &&
    typeof body.site === 'object' &&
    typeof body.site.file === 'string'
  ) {
    siteLocation = body.site.file;
  }
  if (siteLocation.indexOf('/site.json') !== -1) {
    siteLocation = siteLocation.replace('/site.json', '');
  }
  if (siteLocation.endsWith('/')) {
    siteLocation = siteLocation.slice(0, -1);
  }
  return siteLocation;
}

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
 *    path="/mediaBrowser",
 *    tags={"cms","authenticated","reports"},
 *    @OA\Response(
 *        response="200",
 *        description="Load media browser report data"
 *   )
 * )
 */
async function mediaBrowser(req, res) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  if (
    req.query['site_token'] &&
    body.site &&
    body.site.name &&
    HAXCMS.validateRequestToken(
      req.query['site_token'],
      HAXCMS.getActiveUserName() + ':' + body.site.name
    )
  ) {
    const site = await HAXCMS.loadSite(body.site.name);
    if (!site || !site.manifest) {
      return res.send({
        status: 200,
        data: {},
      });
    }
    const siteLocation = normalizeSiteLocation(body);
    const itemId = normalizeActiveId(body);
    const data = await courseStatsFromOutline(siteLocation, site, itemId, [
      'mediaData',
    ]);
    return res.send({
      status: 200,
      data: data,
    });
  }
  return res.sendStatus(403);
}

module.exports = mediaBrowser;
