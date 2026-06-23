const { HAXCMS } = require('../../../lib/HAXCMS.js')
const filter_var = require('../../../lib/filter_var.js')
const { sanitizeURLValue } = require('../../../lib/sanitizeContent.js')
const {
  platformAllows,
  featureDisabledResponse,
} = require('../../../lib/platformFeatures.js')
const { getRequestHeaderValue, isPlainObject, hasOnlyAllowedKeys } = require('../siteRouteUtils.js')

const ALLOWED_TOP_LEVEL_KEYS = new Set(['site', 'manifest'])
const ALLOWED_SITE_KEYS = new Set(['name'])
const ALLOWED_MANIFEST_KEYS = new Set(['theme'])
const REGION_FIELD_MAP = {
  'manifest-metadata-theme-regions-header': 'header',
  'manifest-metadata-theme-regions-sidebarFirst': 'sidebarFirst',
  'manifest-metadata-theme-regions-sidebarSecond': 'sidebarSecond',
  'manifest-metadata-theme-regions-contentTop': 'contentTop',
  'manifest-metadata-theme-regions-contentBottom': 'contentBottom',
  'manifest-metadata-theme-regions-footerPrimary': 'footerPrimary',
  'manifest-metadata-theme-regions-footerSecondary': 'footerSecondary',
}
const ALLOWED_THEME_KEYS = new Set([
  'manifest-metadata-theme-element',
  'manifest-metadata-theme-variables-image',
  'manifest-metadata-theme-variables-imageAlt',
  'manifest-metadata-theme-variables-imageLink',
  'manifest-metadata-theme-variables-cssVariable',
  'manifest-metadata-theme-variables-palette',
  'manifest-metadata-theme-variables-icon',
  ...Object.keys(REGION_FIELD_MAP),
])

function normalizeCssVariable(value) {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = filter_var(value, 'FILTER_SANITIZE_STRING')
    .replace('--simple-colors-default-theme-', '')
    .replace(/-7$/g, '')
    .trim()
    .toLowerCase()
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    return null
  }
  return normalized
}

function sanitizeRegionIds(value) {
  if (!Array.isArray(value)) {
    return null
  }
  const cleanIds = []
  for (const rawId of value) {
    if (typeof rawId !== 'string') {
      return null
    }
    const cleanId = filter_var(rawId, 'FILTER_SANITIZE_STRING').trim()
    if (!cleanId) {
      return null
    }
    cleanIds.push(cleanId)
  }
  return [...new Set(cleanIds)]
}

/**
 * @OA\Post(
 *    path="/saveAppearanceSettings",
 *    tags={"cms","authenticated"},
 *    @OA\Parameter(
 *         name="site_token",
 *         description="Site-specific validation token",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Save appearance settings into site.json manifest metadata.theme"
 *   )
 * )
 */
async function saveAppearanceSettings(req, res) {
  const siteNameForToken = req.body && req.body.site ? req.body.site.name : ''
  const siteToken = getRequestHeaderValue(req, 'x-haxcms-site-token')
  if (
    !(
      siteToken &&
      HAXCMS.validateRequestToken(
        siteToken,
        HAXCMS.getActiveUserName() + ':' + siteNameForToken,
      )
    )
  ) {
    res.sendStatus(403)
    return
  }

  if (!hasOnlyAllowedKeys(req.body, ALLOWED_TOP_LEVEL_KEYS)) {
    res.sendStatus(400)
    return
  }
  if (
    !hasOnlyAllowedKeys(req.body.site, ALLOWED_SITE_KEYS) ||
    typeof req.body.site.name !== 'string' ||
    req.body.site.name.trim() === ''
  ) {
    res.sendStatus(400)
    return
  }
  if (!hasOnlyAllowedKeys(req.body.manifest, ALLOWED_MANIFEST_KEYS)) {
    res.sendStatus(400)
    return
  }
  if (!hasOnlyAllowedKeys(req.body.manifest.theme, ALLOWED_THEME_KEYS)) {
    res.sendStatus(400)
    return
  }

  const themePayload = req.body.manifest.theme
  const site = await HAXCMS.loadSite(req.body.site.name)
  if (!platformAllows(site, 'themeManifest')) {
    return featureDisabledResponse(
      res,
      'Theme settings are disabled for this site',
    )
  }
  if (!site || !site.manifest) {
    res.sendStatus(400)
    return
  }
  if (!site.manifest.metadata || !isPlainObject(site.manifest.metadata)) {
    site.manifest.metadata = {}
  }
  if (!site.manifest.metadata.site || !isPlainObject(site.manifest.metadata.site)) {
    site.manifest.metadata.site = {}
  }
  if (!site.manifest.metadata.theme || !isPlainObject(site.manifest.metadata.theme)) {
    site.manifest.metadata.theme = {}
  }

  if (
    Object.prototype.hasOwnProperty.call(
      themePayload,
      'manifest-metadata-theme-element',
    )
  ) {
    const themeElementValue = themePayload['manifest-metadata-theme-element']
    if (typeof themeElementValue !== 'string') {
      res.sendStatus(400)
      return
    }
    const themeElement = filter_var(
      themeElementValue,
      'FILTER_SANITIZE_STRING',
    ).trim()
    const themes = await HAXCMS.getThemes()
    if (!themeElement || !themes || typeof themes[themeElement] === 'undefined') {
      res.sendStatus(400)
      return
    }
    site.manifest.metadata.theme = themes[themeElement]
  }

  if (
    !site.manifest.metadata.theme.variables ||
    !isPlainObject(site.manifest.metadata.theme.variables)
  ) {
    site.manifest.metadata.theme.variables = {}
  }
  if (
    !site.manifest.metadata.theme.regions ||
    !isPlainObject(site.manifest.metadata.theme.regions)
  ) {
    site.manifest.metadata.theme.regions = {}
  }

  if (
    Object.prototype.hasOwnProperty.call(
      themePayload,
      'manifest-metadata-theme-variables-image',
    )
  ) {
    const imageValue = themePayload['manifest-metadata-theme-variables-image']
    if (imageValue !== null && typeof imageValue !== 'string') {
      res.sendStatus(400)
      return
    }
    site.manifest.metadata.theme.variables.image = sanitizeURLValue(
      filter_var(imageValue, 'FILTER_SANITIZE_STRING'),
      '',
    )
  }
  if (
    Object.prototype.hasOwnProperty.call(
      themePayload,
      'manifest-metadata-theme-variables-imageAlt',
    )
  ) {
    const imageAltValue = themePayload['manifest-metadata-theme-variables-imageAlt']
    if (imageAltValue !== null && typeof imageAltValue !== 'string') {
      res.sendStatus(400)
      return
    }
    site.manifest.metadata.theme.variables.imageAlt = filter_var(
      imageAltValue,
      'FILTER_SANITIZE_STRING',
    )
  }
  if (
    Object.prototype.hasOwnProperty.call(
      themePayload,
      'manifest-metadata-theme-variables-imageLink',
    )
  ) {
    const imageLinkValue =
      themePayload['manifest-metadata-theme-variables-imageLink']
    if (imageLinkValue !== null && typeof imageLinkValue !== 'string') {
      res.sendStatus(400)
      return
    }
    site.manifest.metadata.theme.variables.imageLink = sanitizeURLValue(
      filter_var(imageLinkValue, 'FILTER_SANITIZE_STRING'),
      '',
    )
  }
  if (
    Object.prototype.hasOwnProperty.call(
      themePayload,
      'manifest-metadata-theme-variables-cssVariable',
    )
  ) {
    const cssVariableValue =
      themePayload['manifest-metadata-theme-variables-cssVariable']
    if (cssVariableValue === null || cssVariableValue === '') {
      delete site.manifest.metadata.theme.variables.cssVariable
    } else {
      const cssVariable = normalizeCssVariable(cssVariableValue)
      if (!cssVariable) {
        res.sendStatus(400)
        return
      }
      site.manifest.metadata.theme.variables.cssVariable =
        '--simple-colors-default-theme-' + cssVariable + '-7'
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(
      themePayload,
      'manifest-metadata-theme-variables-palette',
    )
  ) {
    const paletteValue = themePayload['manifest-metadata-theme-variables-palette']
    if (paletteValue !== null && typeof paletteValue !== 'string') {
      res.sendStatus(400)
      return
    }
    let palette = filter_var(paletteValue, 'FILTER_SANITIZE_STRING')
    if (typeof palette === 'string') {
      palette = palette.trim().toLowerCase()
      if (palette === '') {
        delete site.manifest.metadata.theme.variables.palette
      } else if (/^[a-z0-9-]+$/.test(palette)) {
        site.manifest.metadata.theme.variables.palette = palette
      } else {
        res.sendStatus(400)
        return
      }
    } else if (palette === null) {
      delete site.manifest.metadata.theme.variables.palette
    } else {
      res.sendStatus(400)
      return
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(
      themePayload,
      'manifest-metadata-theme-variables-icon',
    )
  ) {
    const iconValue = themePayload['manifest-metadata-theme-variables-icon']
    if (iconValue !== null && typeof iconValue !== 'string') {
      res.sendStatus(400)
      return
    }
    site.manifest.metadata.theme.variables.icon = filter_var(
      iconValue,
      'FILTER_SANITIZE_STRING',
    )
  }

  for (const regionField of Object.keys(REGION_FIELD_MAP)) {
    if (Object.prototype.hasOwnProperty.call(themePayload, regionField)) {
      const cleanRegionIds = sanitizeRegionIds(themePayload[regionField])
      if (cleanRegionIds === null) {
        res.sendStatus(400)
        return
      }
      site.manifest.metadata.theme.regions[REGION_FIELD_MAP[regionField]] =
        cleanRegionIds
    }
  }

  site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000)
  await site.manifest.save(false)
  await site.gitCommit('Appearance settings updated')
  await site.rebuildManagedFiles()
  site.updateAlternateFormats()
  await site.gitCommit('Managed files updated')

  res.send({
    status: 200,
    data: {
      saved: true,
      appearance: {
        theme: true,
      },
    },
  })
}

module.exports = saveAppearanceSettings
