const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  normalizeBoolean,
  discoverThemes,
  readEnabledThemeMap,
  writeEnabledThemeMap,
  applyDetectedThemeDefaults,
  isThemeEnabled,
  isThemeHidden,
  isThemeTerrible,
  getThemeScreenshot,
} = require('../../../lib/themeSettings.js');

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
 * Discover available themes from registered theme config and filesystem.
 * Requires a valid user_token and JWT.
 *
 * @OA\Get(
 *    path="/themesList",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="List available themes"
 *   )
 * )
 */
async function themesList(req, res) {
  const enabledFilter = resolveEnabledFilter(req);
  try {
    const discovered = await discoverThemes(HAXCMS);
    const detectedNames = discovered.map((item) => item.machineName);
    let enabledThemes = await readEnabledThemeMap(HAXCMS);
    const withDefaults = applyDetectedThemeDefaults(
      HAXCMS,
      enabledThemes,
      detectedNames,
    );
    enabledThemes = withDefaults.enabledThemes;
    if (withDefaults.changed) {
      await writeEnabledThemeMap(HAXCMS, enabledThemes);
    }

    const items = [];
    for (let i = 0; i < discovered.length; i++) {
      const item = discovered[i];
      if (isThemeHidden(item) || isThemeTerrible(item)) {
        continue;
      }
      const enabled = isThemeEnabled(
        HAXCMS,
        item.machineName,
        enabledThemes,
      );
      if (enabledFilter === 'enabled' && !enabled) {
        continue;
      }
      if (enabledFilter === 'disabled' && enabled) {
        continue;
      }
      items.push({
        ...item,
        screenshot: getThemeScreenshot(item),
        enabled,
        hidden: !enabled,
      });
    }

    return res.json({
      status: 200,
      data: items,
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      message: 'Unable to load theme settings',
    });
  }
}

module.exports = themesList;
