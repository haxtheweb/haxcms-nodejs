const FEATURE_KEY_ALIASES = {
  uploadMedia: ['uploadMedia', 'upload'],
  onlineMedia: ['onlineMedia', 'onlineSearch'],
  deletePage: ['deletePage', 'delete'],
  delete: ['deletePage', 'delete'],
  siteManifest: ['siteManifest', 'manifest'],
  manifest: ['siteManifest', 'manifest'],
}

function isObjectLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function featureSourcesFromSite(site) {
  if (
    !site ||
    !site.manifest ||
    !site.manifest.metadata ||
    !site.manifest.metadata.platform ||
    !isObjectLike(site.manifest.metadata.platform)
  ) {
    return []
  }
  const platform = site.manifest.metadata.platform
  const sources = []
  if (isObjectLike(platform.features)) {
    sources.push(platform.features)
  }
  sources.push(platform)
  return sources
}

function platformAllows(site, capability) {
  const sources = featureSourcesFromSite(site)
  if (sources.length === 0) {
    return true
  }
  const keys = FEATURE_KEY_ALIASES[capability] || [capability]
  for (const source of sources) {
    for (const key of keys) {
      if (
        Object.prototype.hasOwnProperty.call(source, key) &&
        typeof source[key] === 'boolean'
      ) {
        return source[key] !== false
      }
    }
  }
  return true
}

function featureDisabledResponse(res, message) {
  return res.status(403).send({
    __failed: {
      status: 403,
      message: message || 'This operation is disabled for this site',
    },
  })
}

module.exports = { platformAllows, featureDisabledResponse }
