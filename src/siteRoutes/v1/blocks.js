const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../../lib/HAXCMS.js');
const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  sortRecords,
  paginateRecords,
  projectCollection,
  projectRecord,
  resolveSiteForRequest,
  getOrderedItems,
  applyItemFilters,
  collectCustomElementUsage,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function normalizeEnabledBlocks(input = []) {
  if (!Array.isArray(input)) {
    return null;
  }
  const output = [];
  for (let i = 0; i < input.length; i++) {
    if (typeof input[i] !== 'string') {
      return null;
    }
    const tag = input[i].trim().toLowerCase();
    if (tag === '') {
      return null;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
      return null;
    }
    output.push(tag);
  }
  return [...new Set(output)].sort();
}

async function readEnabledBlocksSetting() {
  const filePath = path.join(
    HAXCMS.configDirectory,
    'settings',
    'enabledBlocks.json',
  );
  if (!(await fs.pathExists(filePath))) {
    return null;
  }
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return normalizeEnabledBlocks(parsed);
}

function getAutoloaderList() {
  if (
    HAXCMS.config &&
    HAXCMS.config.appStore &&
    Array.isArray(HAXCMS.config.appStore.autoloader)
  ) {
    return HAXCMS.config.appStore.autoloader
      .map((tag) => String(tag || '').trim().toLowerCase())
      .filter((tag) => tag !== '');
  }
  return ['grid-plate'];
}

function parseImportPath(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    if (typeof value.path === 'string' && value.path !== '') {
      return value.path;
    }
    if (typeof value.import === 'string' && value.import !== '') {
      return value.import;
    }
  }
  return '';
}

function parsePackageName(importPath = '') {
  const cleanImport = String(importPath || '').trim();
  if (cleanImport === '') {
    return '';
  }
  const parts = cleanImport.split('/').filter((part) => part !== '');
  if (parts.length === 0) {
    return '';
  }
  if (parts[0].indexOf('@') === 0 && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function buildSchemaFragments(tag, importPath) {
  return {
    haxProperties: {
      gizmo: {
        title: tag,
        tag,
        icon: 'icons:extension',
      },
      settings: {
        configure: [],
        advanced: [],
        developer: [],
      },
      source: importPath,
    },
    haxSchema: {
      api: '1',
      canScale: true,
      canPosition: true,
      canEditSource: true,
    },
    haxElementSchema: {
      tag,
      properties: [],
      slots: [],
    },
  };
}

function buildBlockRecord(
  tag,
  usageCount,
  include,
  enabledBlockSet,
  wcMap,
  apiBasePath,
) {
  const importPath = parseImportPath(wcMap[tag]);
  const hasExplicitEnabledList = enabledBlockSet && enabledBlockSet.size > 0;
  const enabled = hasExplicitEnabledList ? enabledBlockSet.has(tag) : true;
  const record = {
    tag,
    enabled,
    usageCount: Number(usageCount || 0),
    import: importPath,
    package: parsePackageName(importPath),
    links: {
      self: `${apiBasePath}/v1/blocks/${encodeURIComponent(tag)}`,
      customElement: `${apiBasePath}/v1/custom-elements/${encodeURIComponent(tag)}`,
    },
  };
  const schemaFragments = buildSchemaFragments(tag, importPath);
  if (include.indexOf('haxProperties') !== -1) {
    record.haxProperties = schemaFragments.haxProperties;
  }
  if (include.indexOf('haxSchema') !== -1) {
    record.haxSchema = schemaFragments.haxSchema;
  }
  if (include.indexOf('haxElementSchema') !== -1) {
    record.haxElementSchema = schemaFragments.haxElementSchema;
  }
  return record;
}

async function listBlocks(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/blocks',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const include = getCsvQuery(req, 'include');
  const fields = getCsvQuery(req, 'fields');
  const filterTag = String(getQueryValue(req, 'filter.tag', '') || '')
    .trim()
    .toLowerCase();
  const filteredItems = applyItemFilters(getOrderedItems(site), req, site);
  const usage = await collectCustomElementUsage(site, filteredItems);
  const wcMap = HAXCMS.getWCRegistryJson(site);
  const autoloader = getAutoloaderList();
  const enabledBlocks = await readEnabledBlocksSetting();
  const enabledBlockSet = new Set(Array.isArray(enabledBlocks) ? enabledBlocks : []);
  const tagSet = new Set();
  Object.keys(usage).forEach((tag) => {
    tagSet.add(String(tag || '').toLowerCase());
  });
  for (let i = 0; i < autoloader.length; i++) {
    tagSet.add(autoloader[i]);
  }
  if (filterTag !== '') {
    tagSet.add(filterTag);
  }
  let records = Array.from(tagSet)
    .filter((tag) => tag !== '')
    .map((tag) =>
      buildBlockRecord(tag, usage[tag] || 0, include, enabledBlockSet, wcMap, apiBasePath),
    );
  if (filterTag !== '') {
    records = records.filter((record) => record.tag.indexOf(filterTag) !== -1);
  }
  records = sortRecords(records, getQueryValue(req, 'sort', ''), '-usageCount');
  const paged = paginateRecords(records, req, 100, 2000);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      blocks: outputRecords,
      links: {
        self: `${apiBasePath}/v1/blocks`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

async function blockDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/blocks/:webcomponentName',
    });
  }
  const webcomponentName =
    req && req.params && req.params.webcomponentName
      ? String(req.params.webcomponentName).trim().toLowerCase()
      : '';
  if (webcomponentName === '') {
    return res.status(404).json({
      status: 404,
      message: 'Block not found',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const include = getCsvQuery(req, 'include');
  const fields = getCsvQuery(req, 'fields');
  const usage = await collectCustomElementUsage(site, getOrderedItems(site));
  const wcMap = HAXCMS.getWCRegistryJson(site);
  const enabledBlocks = await readEnabledBlocksSetting();
  const enabledBlockSet = new Set(Array.isArray(enabledBlocks) ? enabledBlocks : []);
  const known =
    Object.prototype.hasOwnProperty.call(wcMap, webcomponentName) ||
    Object.prototype.hasOwnProperty.call(usage, webcomponentName) ||
    getAutoloaderList().indexOf(webcomponentName) !== -1;
  if (!known) {
    return res.status(404).json({
      status: 404,
      message: `Block "${webcomponentName}" not found`,
    });
  }
  const record = buildBlockRecord(
    webcomponentName,
    usage[webcomponentName] || 0,
    include,
    enabledBlockSet,
    wcMap,
    apiBasePath,
  );
  const outputRecord = projectRecord(record, fields);
  return sendFormattedResponse(req, res, outputRecord, {
    allowedFormats: ['json'],
    defaultFormat: 'json',
  });
}

module.exports = {
  listBlocks,
  blockDetail,
};
