const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  normalizeBoolean,
  discoverSkeletons,
  readEnabledSkeletonMap,
  writeEnabledSkeletonMap,
  applyDetectedSkeletonDefaults,
  isSkeletonEnabled,
} = require('../../../lib/skeletonSettings.js');

function resolveEnabledFilter(req) {
  const hasEnabledQuery = (
    req &&
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, 'enabled')
  );
  const hasEnabledBody = (
    req &&
    req.body &&
    Object.prototype.hasOwnProperty.call(req.body, 'enabled')
  );
  if (hasEnabledQuery || hasEnabledBody) {
    const rawEnabled = hasEnabledQuery ? req.query.enabled : req.body.enabled;
    return normalizeBoolean(rawEnabled, true) ? 'enabled' : 'disabled';
  }
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
  if (fromQuery || fromBody) {
    return 'all';
  }
  return 'enabled';
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

async function skeletonsList(req, res) {
  const userToken = getUserTokenFromHeader(req);
  if (!userToken || !HAXCMS.validateRequestToken(userToken, HAXCMS.getActiveUserName())) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }
  const enabledFilter = resolveEnabledFilter(req);
  const discovered = await discoverSkeletons(HAXCMS);
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
    if (enabledFilter === 'enabled' && !enabled) {
      continue;
    }
    if (enabledFilter === 'disabled' && enabled) {
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
