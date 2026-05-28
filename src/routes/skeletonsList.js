const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  normalizeBoolean,
  discoverSkeletons,
  readEnabledSkeletonMap,
  writeEnabledSkeletonMap,
  applyDetectedSkeletonDefaults,
  isSkeletonEnabled,
} = require('../lib/skeletonSettings.js');

function shouldIncludeDisabled(req) {
  const fromQuery = (
    req &&
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, 'includeDisabled')
  ) ? normalizeBoolean(req.query.includeDisabled, false) : false;
  const fromBody = (
    req &&
    req.body &&
    Object.prototype.hasOwnProperty.call(req.body, 'includeDisabled')
  ) ? normalizeBoolean(req.body.includeDisabled, false) : false;
  return fromQuery || fromBody;
}

/**
 * Discover available site skeletons from core and user config directories.
 * Returns metadata list compatible with app-hax v2 dashboard.
 * Requires a valid user_token and JWT.
 *
 * @OA\Get(
 *    path="/skeletonsList",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="List available site skeletons"
 *   )
 * )
 */
async function skeletonsList(req, res) {
  // Validate user_token like listSites
  if (!req.query.user_token || !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }

  const includeDisabled = shouldIncludeDisabled(req);
  const userToken = req.query.user_token;
  const discovered = await discoverSkeletons(HAXCMS, userToken);
  const detectedNames = discovered.map((item) => item.machineName);
  let enabledSkeletons = await readEnabledSkeletonMap(HAXCMS);
  const withDefaults = applyDetectedSkeletonDefaults(
    HAXCMS,
    enabledSkeletons,
    detectedNames,
  );
  enabledSkeletons = withDefaults.enabledSkeletons;
  if (withDefaults.changed) {
    await writeEnabledSkeletonMap(HAXCMS, enabledSkeletons);
  }

  const items = [];
  for (let i = 0; i < discovered.length; i++) {
    const item = discovered[i];
    const enabled = isSkeletonEnabled(
      HAXCMS,
      item.machineName,
      enabledSkeletons,
    );
    if (!includeDisabled && !enabled) {
      continue;
    }
    items.push({
      ...item,
      enabled,
    });
  }

  return res.json({
    status: 200,
    data: items
  });
}

module.exports = skeletonsList;
