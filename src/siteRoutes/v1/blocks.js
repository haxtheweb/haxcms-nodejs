const fs = require('fs-extra');
const path = require('path');
const { parse } = require('node-html-parser');
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
  getItemContent,
  itemToSummary,
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
      properties: {},
      content: '',
    },
  };
}

function getBlockSchemaLinks(apiBasePath, tag) {
  const encodedTag = encodeURIComponent(tag);
  return {
    haxProperties: `${apiBasePath}/v1/schemas?filter.kind=haxProperties&filter.webcomponentName=${encodedTag}`,
    haxSchema: `${apiBasePath}/v1/schemas?filter.kind=haxSchema&filter.webcomponentName=${encodedTag}`,
    haxElementSchema: `${apiBasePath}/v1/schemas?filter.kind=haxElementSchema&filter.webcomponentName=${encodedTag}`,
  };
}

function escapeForRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countTagUsageInHtml(tag, html = '') {
  const cleanTag = String(tag || '').trim().toLowerCase();
  if (cleanTag === '') {
    return 0;
  }
  const source = String(html || '');
  if (source === '') {
    return 0;
  }
  const regex = new RegExp(`<${escapeForRegExp(cleanTag)}\\b`, 'gi');
  let count = 0;
  let matched = regex.exec(source);
  while (matched) {
    count += 1;
    matched = regex.exec(source);
  }
  return count;
}
function buildContextualHaxElementSchema(tag, element = null) {
  const properties = {};
  if (element && element.attributes && typeof element.attributes === 'object') {
    const attributeNames = Object.keys(element.attributes);
    for (let i = 0; i < attributeNames.length; i++) {
      const name = attributeNames[i];
      const value = element.getAttribute(name);
      properties[name] = value === null ? true : value;
    }
  }
  return {
    tag,
    properties,
    content: element && element.innerHTML ? String(element.innerHTML) : '',
  };
}

function extractTagUsageInstances(tag, html = '') {
  const cleanTag = String(tag || '').trim().toLowerCase();
  if (cleanTag === '') {
    return [];
  }
  const source = String(html || '');
  if (source === '') {
    return [];
  }
  const wrapper = parse(`<div data-block-usage-wrapper>${source}</div>`);
  const matches = wrapper.querySelectorAll(cleanTag);
  const instances = [];
  for (let i = 0; i < matches.length; i++) {
    const element = matches[i];
    instances.push({
      instance: i + 1,
      haxElementSchema: buildContextualHaxElementSchema(cleanTag, element),
    });
  }
  return instances;
}

function isKnownBlockTag(webcomponentName, wcMap, usage = {}) {
  return (
    Object.prototype.hasOwnProperty.call(wcMap, webcomponentName) ||
    Object.prototype.hasOwnProperty.call(usage, webcomponentName) ||
    getAutoloaderList().indexOf(webcomponentName) !== -1
  );
}

async function buildBlockUsageRecords(
  site,
  items,
  webcomponentName,
  apiBasePath,
) {
  const records = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const html = await getItemContent(site, item);
    const usageCount = countTagUsageInHtml(webcomponentName, html);
    if (usageCount < 1) {
      continue;
    }
    const record = itemToSummary(item, apiBasePath);
    record.usageCount = usageCount;
    record.links.block = `${apiBasePath}/v1/blocks/${encodeURIComponent(webcomponentName)}`;
    record.links.blockUsage = `${apiBasePath}/v1/blocks/${encodeURIComponent(webcomponentName)}/usage`;
    records.push(record);
  }
  return records;
}

async function buildBlockUsageDetails(
  site,
  items,
  webcomponentName,
  apiBasePath,
) {
  const details = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const html = await getItemContent(site, item);
    const instances = extractTagUsageInstances(webcomponentName, html);
    if (instances.length < 1) {
      continue;
    }
    const summary = itemToSummary(item, apiBasePath);
    details.push({
      id: summary.id,
      slug: summary.slug,
      title: summary.title,
      location: summary.location,
      usageCount: instances.length,
      instances,
      links: {
        self: summary.links.self,
        content: summary.links.content,
      },
    });
  }
  return details;
}

function buildBlockRecord(
  tag,
  usageCount,
  usageItemIds,
  include,
  enabledBlockSet,
  wcMap,
  apiBasePath,
  options = {},
) {
  const importPath = parseImportPath(wcMap[tag]);
  const normalizedUsageItemIds = Array.isArray(usageItemIds)
    ? [...new Set(usageItemIds.filter((id) => typeof id === 'string' && id !== ''))]
    : [];
  const hasExplicitEnabledList = enabledBlockSet && enabledBlockSet.size > 0;
  const enabled = hasExplicitEnabledList ? enabledBlockSet.has(tag) : true;
  const schemaLinks = getBlockSchemaLinks(apiBasePath, tag);
  const record = {
    tag,
    enabled,
    usageCount: Number(usageCount || 0),
    used: Number(usageCount || 0) > 0,
    usedIn: normalizedUsageItemIds,
    import: importPath,
    package: parsePackageName(importPath),
    links: {
      self: `${apiBasePath}/v1/blocks/${encodeURIComponent(tag)}`,
      customElement: `${apiBasePath}/v1/custom-elements/${encodeURIComponent(tag)}`,
      usage: `${apiBasePath}/v1/blocks/${encodeURIComponent(tag)}/usage`,
    },
    related: [
      {
        rel: 'entity',
        type: 'block',
        href: `${apiBasePath}/v1/entities#block`,
      },
      {
        rel: 'schema',
        type: 'haxProperties',
        href: schemaLinks.haxProperties,
      },
      {
        rel: 'schema',
        type: 'haxSchema',
        href: schemaLinks.haxSchema,
      },
      {
        rel: 'schema',
        type: 'haxElementSchema',
        href: schemaLinks.haxElementSchema,
      },
    ],
  };
  const schemaFragments = buildSchemaFragments(tag, importPath);
  if (include.indexOf('haxProperties') !== -1) {
    record.haxProperties = schemaFragments.haxProperties;
  }
  if (include.indexOf('haxSchema') !== -1) {
    record.haxSchema = schemaFragments.haxSchema;
  }
  if (Array.isArray(options.usedInDetails)) {
    record.usedInDetails = options.usedInDetails;
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
      buildBlockRecord(
        tag,
        usage[tag] || 0,
        [],
        include,
        enabledBlockSet,
        wcMap,
        apiBasePath,
      ),
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
  const orderedItems = getOrderedItems(site);
  const wcMap = HAXCMS.getWCRegistryJson(site);
  const enabledBlocks = await readEnabledBlocksSetting();
  const enabledBlockSet = new Set(Array.isArray(enabledBlocks) ? enabledBlocks : []);
  const usageDetails = await buildBlockUsageDetails(
    site,
    orderedItems,
    webcomponentName,
    apiBasePath,
  );
  const known =
    isKnownBlockTag(webcomponentName, wcMap, {}) || usageDetails.length > 0;
  if (!known) {
    return res.status(404).json({
      status: 404,
      message: `Block "${webcomponentName}" not found`,
    });
  }
  const usageItemIds = usageDetails
    .map((detail) => String(detail.id || '').trim())
    .filter((id) => id !== '');
  const usageCount = usageDetails.reduce((total, detail) => {
    return total + Number(detail.usageCount || 0);
  }, 0);
  const record = buildBlockRecord(
    webcomponentName,
    usageCount,
    usageItemIds,
    include,
    enabledBlockSet,
    wcMap,
    apiBasePath,
    {
      usedInDetails: usageDetails,
    },
  );
  const outputRecord = projectRecord(record, fields);
  return sendFormattedResponse(req, res, outputRecord, {
    allowedFormats: ['json'],
    defaultFormat: 'json',
  });
}

async function blockUsage(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message:
        'Unable to resolve site context for /x/api/v1/blocks/:webcomponentName/usage',
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
  const fields = getCsvQuery(req, 'fields');
  const filteredItems = applyItemFilters(getOrderedItems(site), req, site);
  const usageTotals = await collectCustomElementUsage(site, filteredItems);
  const wcMap = HAXCMS.getWCRegistryJson(site);
  if (!isKnownBlockTag(webcomponentName, wcMap, usageTotals)) {
    return res.status(404).json({
      status: 404,
      message: `Block \"${webcomponentName}\" not found`,
    });
  }
  let records = await buildBlockUsageRecords(
    site,
    filteredItems,
    webcomponentName,
    apiBasePath,
  );
  records = sortRecords(records, getQueryValue(req, 'sort', ''), '-usageCount');
  const paged = paginateRecords(records, req, 25, 500);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      block: webcomponentName,
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      items: outputRecords,
      links: {
        self: `${apiBasePath}/v1/blocks/${encodeURIComponent(webcomponentName)}/usage`,
        block: `${apiBasePath}/v1/blocks/${encodeURIComponent(webcomponentName)}`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = {
  listBlocks,
  blockDetail,
  blockUsage,
};
