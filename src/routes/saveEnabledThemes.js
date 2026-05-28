const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  normalizeMachineNameList,
  normalizeEnabledThemeMap,
  discoverThemes,
  readEnabledThemeMap,
  applyDetectedThemeDefaults,
  isThemeHidden,
  isThemeTerrible,
  writeEnabledThemeMap,
} = require('../lib/themeSettings.js');

function getEnabledThemesPayload(req) {
  if (!req || !req.body) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'enabledThemes')) {
    return req.body.enabledThemes;
  }
  return req.body;
}

function enabledListFromPayload(payload) {
  if (Array.isArray(payload)) {
    return normalizeMachineNameList(HAXCMS, payload);
  }
  if (payload && typeof payload === 'object') {
    const map = normalizeEnabledThemeMap(HAXCMS, payload);
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
 *    path="/saveEnabledThemes",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Persist enabled theme settings"
 *   )
 * )
 */
async function saveEnabledThemes(req, res) {
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())
  ) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }
  const payload = getEnabledThemesPayload(req);
  if (typeof payload === 'undefined') {
    return res.status(400).json({
      status: 400,
      message: 'Missing enabledThemes payload',
    });
  }
  const enabledThemes = enabledListFromPayload(payload);
  if (!enabledThemes) {
    return res.status(400).json({
      status: 400,
      message: 'Invalid enabledThemes payload',
    });
  }
  try {
    const discovered = await discoverThemes(HAXCMS);
    const enabledSet = new Set(enabledThemes);
    const detectedNames = discovered.map((item) => item.machineName);
    let existingMap = await readEnabledThemeMap(HAXCMS);
    existingMap = applyDetectedThemeDefaults(
      HAXCMS,
      existingMap,
      detectedNames,
    ).enabledThemes;
    const enabledMap = { ...existingMap };
    for (let i = 0; i < discovered.length; i++) {
      const machineName = discovered[i].machineName;
      if (!machineName) {
        continue;
      }
      if (isThemeHidden(discovered[i]) || isThemeTerrible(discovered[i])) {
        if (!Object.prototype.hasOwnProperty.call(enabledMap, machineName)) {
          enabledMap[machineName] = true;
        }
        continue;
      }
      enabledMap[machineName] = enabledSet.has(machineName);
    }
    const selectedKeys = enabledThemes;
    for (let i = 0; i < selectedKeys.length; i++) {
      const key = selectedKeys[i];
      if (!Object.prototype.hasOwnProperty.call(enabledMap, key)) {
        enabledMap[key] = true;
      }
    }
    const savedMap = await writeEnabledThemeMap(HAXCMS, enabledMap);
    const savedEnabled = Object.keys(savedMap).filter(
      (key) => savedMap[key] !== false,
    );
    savedEnabled.sort();
    return res.json({
      status: 200,
      data: {
        enabledThemes: savedEnabled,
        settings: savedMap,
      },
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      message: 'Unable to save enabled theme settings',
    });
  }
}

module.exports = saveEnabledThemes;
