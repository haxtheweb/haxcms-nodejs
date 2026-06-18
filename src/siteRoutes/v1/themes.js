const { HAXCMS } = require('../../lib/HAXCMS.js');
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
} = require('../../lib/themeSettings.js');
const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  sortRecords,
  paginateRecords,
  projectCollection,
  projectRecord,
  resolveSiteForRequest,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function getActiveThemeName(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.theme
  ) {
    if (
      typeof site.manifest.metadata.theme.element === 'string' &&
      site.manifest.metadata.theme.element.trim() !== ''
    ) {
      return site.manifest.metadata.theme.element.trim();
    }
    if (
      typeof site.manifest.metadata.theme.machineName === 'string' &&
      site.manifest.metadata.theme.machineName.trim() !== ''
    ) {
      return site.manifest.metadata.theme.machineName.trim();
    }
    if (
      typeof site.manifest.metadata.theme.name === 'string' &&
      site.manifest.metadata.theme.name.trim() !== ''
    ) {
      return site.manifest.metadata.theme.name.trim();
    }
  }
  return '';
}

function shouldIncludeDisabled(req) {
  const includeDisabled = normalizeBoolean(
    getQueryValue(req, 'includeDisabled', false),
    false,
  );
  return includeDisabled;
}

function normalizeThemeRecord(theme, enabled, active, apiBasePath) {
  const record = {
    machineName: theme.machineName || '',
    name: theme.name || theme.machineName || '',
    description: theme.description || '',
    enabled: enabled !== false,
    active: active === true,
    hidden: !enabled,
    screenshot: getThemeScreenshot(theme),
    path: theme.path || '',
    element: theme.element || theme.machineName || '',
    links: {
      self: `${apiBasePath}/v1/themes/${encodeURIComponent(theme.machineName || '')}`,
    },
  };
  if (Array.isArray(theme.supportedPalettes) && theme.supportedPalettes.length > 0) {
    record.supportedPalettes = theme.supportedPalettes;
  }
  return record;
}

async function getThemeRecords(site, req, apiBasePath) {
  const includeDisabled = shouldIncludeDisabled(req);
  const activeThemeName = getActiveThemeName(site).toLowerCase();
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
  const records = [];
  for (let i = 0; i < discovered.length; i++) {
    const theme = discovered[i];
    if (isThemeHidden(theme) || isThemeTerrible(theme)) {
      continue;
    }
    const enabled = isThemeEnabled(HAXCMS, theme.machineName, enabledThemes);
    if (!includeDisabled && !enabled) {
      continue;
    }
    const active = String(theme.machineName || '').toLowerCase() === activeThemeName;
    records.push(normalizeThemeRecord(theme, enabled, active, apiBasePath));
  }
  return records;
}

async function listThemes(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/themes',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  let records = await getThemeRecords(site, req, apiBasePath);
  records = sortRecords(records, getQueryValue(req, 'sort', ''), 'machineName');
  const paged = paginateRecords(records, req, 50, 500);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      themes: outputRecords,
      links: {
        self: `${apiBasePath}/v1/themes`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

async function themeDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/themes/:themeName',
    });
  }
  const themeName =
    req && req.params && req.params.themeName ? String(req.params.themeName) : '';
  if (themeName.trim() === '') {
    return res.status(404).json({
      status: 404,
      message: 'Theme not found',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const records = await getThemeRecords(site, req, apiBasePath);
  const target = records.find(
    (record) => String(record.machineName || '') === themeName,
  );
  if (!target) {
    return res.status(404).json({
      status: 404,
      message: `Theme "${themeName}" not found`,
    });
  }
  const outputRecord = projectRecord(target, fields);
  return sendFormattedResponse(req, res, outputRecord, {
    allowedFormats: ['json'],
    defaultFormat: 'json',
  });
}

async function activeTheme(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/themes/active',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const records = await getThemeRecords(site, req, apiBasePath);
  const target = records.find((record) => record.active);
  if (!target) {
    return res.status(404).json({
      status: 404,
      message: 'Active theme not found',
    });
  }
  const outputRecord = projectRecord(target, fields);
  return sendFormattedResponse(req, res, outputRecord, {
    allowedFormats: ['json'],
    defaultFormat: 'json',
  });
}

module.exports = {
  listThemes,
  themeDetail,
  activeTheme,
};
