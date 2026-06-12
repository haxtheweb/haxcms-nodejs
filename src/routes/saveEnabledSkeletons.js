const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  normalizeMachineNameList,
  normalizeEnabledSkeletonMap,
  discoverSkeletons,
  writeEnabledSkeletonMap,
} = require('../lib/skeletonSettings.js');

function getEnabledSkeletonPayload(req) {
  if (!req || !req.body) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'enabledSkeletons')) {
    return req.body.enabledSkeletons;
  }
  return req.body;
}

function enabledListFromPayload(payload) {
  if (Array.isArray(payload)) {
    return normalizeMachineNameList(HAXCMS, payload);
  }
  if (payload && typeof payload === 'object') {
    const map = normalizeEnabledSkeletonMap(HAXCMS, payload);
    const keys = Object.keys(map);
    const list = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (map[key] !== false) {
        list.push(key);
      }
    }
    return normalizeMachineNameList(HAXCMS, list);
  }
  return null;
}

/**
 * @OA\Post(
 *    path="/saveEnabledSkeletons",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Persist enabled skeleton settings"
 *   )
 * )
 */
async function saveEnabledSkeletons(req, res) {
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())
  ) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }
  const payload = getEnabledSkeletonPayload(req);
  if (typeof payload === 'undefined') {
    return res.status(400).json({
      status: 400,
      message: 'Missing enabledSkeletons payload',
    });
  }
  const enabledSkeletons = enabledListFromPayload(payload);
  if (!enabledSkeletons) {
    return res.status(400).json({
      status: 400,
      message: 'Invalid enabledSkeletons payload',
    });
  }
  try {
    const discovered = await discoverSkeletons(HAXCMS);
    const enabledSet = new Set(enabledSkeletons);
    const enabledMap = {};
    for (let i = 0; i < discovered.length; i++) {
      const machineName = discovered[i].machineName;
      enabledMap[machineName] = enabledSet.has(machineName);
    }
    const selectedKeys = enabledSkeletons;
    for (let i = 0; i < selectedKeys.length; i++) {
      const key = selectedKeys[i];
      if (!Object.prototype.hasOwnProperty.call(enabledMap, key)) {
        enabledMap[key] = true;
      }
    }
    const savedMap = await writeEnabledSkeletonMap(HAXCMS, enabledMap);
    const savedEnabled = Object.keys(savedMap).filter(
      (key) => savedMap[key] !== false,
    );
    savedEnabled.sort();
    return res.json({
      status: 200,
      data: {
        enabledSkeletons: savedEnabled,
        settings: savedMap,
      },
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      message: 'Unable to save enabled skeleton settings',
    });
  }
}

module.exports = saveEnabledSkeletons;
