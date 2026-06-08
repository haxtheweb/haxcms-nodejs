const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { HAXCMS, systemStructureContext } = require('../../lib/HAXCMS.js');

const FORMAT_ALIASES = {
  json: 'json',
  'application/json': 'json',
  'application/vnd.oai.openapi+json': 'json',
  'application/vnd.oai.openapi+json;version=3.0': 'json',
  md: 'md',
  markdown: 'md',
  'text/markdown': 'md',
  yaml: 'yaml',
  yml: 'yaml',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
  xml: 'xml',
  'application/xml': 'xml',
  'text/xml': 'xml',
  html: 'html',
  'text/html': 'html',
};

const FORMAT_TO_EXTENSION = {
  json: 'json',
  md: 'md',
  yaml: 'yaml',
  xml: 'xml',
  html: 'html',
};

const FORMAT_TO_MIME = {
  json: 'application/json',
  md: 'text/markdown',
  yaml: 'application/yaml',
  xml: 'application/xml',
  html: 'text/html',
};

const DEFAULT_QUERY_GRAMMAR = [
  'filter.*',
  'page.limit',
  'page.offset',
  'sort',
  'fields',
  'include',
  'format',
  'mode',
];

const DEFAULT_FORMATS = [
  'application/json',
  'text/markdown',
  'application/yaml',
  'application/xml',
  'text/html',
];

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  if (
    req &&
    req.route &&
    typeof req.route.path === 'string' &&
    req.route.path !== ''
  ) {
    return req.route.path;
  }
  return '';
}

function getApiBasePathFromRequestPath(requestPath = '') {
  const matched = String(requestPath || '').match(/^(.*\/x\/api)(?:\/.*)?$/);
  if (matched && matched[1]) {
    return matched[1];
  }
  return '/x/api';
}

function getApiBasePath(req) {
  return getApiBasePathFromRequestPath(getRequestPath(req));
}

function getMultisiteSiteNameFromPath(requestPath = '') {
  const parts = String(requestPath || '')
    .split('/')
    .filter((part) => part !== '');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === HAXCMS.sitesDirectory && parts[i + 1]) {
      return decodeURIComponent(parts[i + 1]);
    }
  }
  return '';
}

async function resolveSiteForRequest(req) {
  const requestPath = getRequestPath(req);
  const siteName = getMultisiteSiteNameFromPath(requestPath);
  if (siteName !== '') {
    return await HAXCMS.loadSite(siteName);
  }
  return await systemStructureContext();
}

function normalizeManifestItems(site) {
  if (!site || !site.manifest || !site.manifest.items) {
    return [];
  }
  if (Array.isArray(site.manifest.items)) {
    return site.manifest.items.filter((item) => item);
  }
  const items = [];
  for (const key in site.manifest.items) {
    if (site.manifest.items[key]) {
      items.push(site.manifest.items[key]);
    }
  }
  return items;
}

function getOrderedItems(site) {
  const items = normalizeManifestItems(site);
  if (
    site &&
    site.manifest &&
    typeof site.manifest.orderTree === 'function'
  ) {
    try {
      return site.manifest.orderTree(items);
    }
    catch (e) {
      return items;
    }
  }
  return items;
}

function normalizeTagList(tags) {
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => String(tag || '').trim())
      .filter((tag) => tag !== '');
  }
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }
  return [];
}

function toIsoDateFromUnixTime(value) {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return new Date(parsed * 1000).toISOString();
}

function getSiteLanguage(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.settings &&
    site.manifest.metadata.site.settings.lang
  ) {
    return String(site.manifest.metadata.site.settings.lang);
  }
  if (site && site.language) {
    return String(site.language);
  }
  return 'en';
}

function getSiteTheme(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.theme &&
    site.manifest.metadata.theme.element
  ) {
    return String(site.manifest.metadata.theme.element);
  }
  return null;
}

function getSiteBasePath(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.name
  ) {
    let basePath = String(HAXCMS.basePath || '/');
    if (basePath.charAt(0) !== '/') {
      basePath = '/' + basePath;
    }
    if (basePath.charAt(basePath.length - 1) !== '/') {
      basePath += '/';
    }
    if (
      site.basePath &&
      String(site.basePath).indexOf('/' + HAXCMS.sitesDirectory + '/') !== -1
    ) {
      return `${basePath}${HAXCMS.sitesDirectory}/${site.manifest.metadata.site.name}/`;
    }
    return `${basePath}${site.manifest.metadata.site.name}/`;
  }
  return String(HAXCMS.basePath || '/');
}

function getQueryObject(req) {
  if (req && req.query && typeof req.query === 'object') {
    return req.query;
  }
  return {};
}

function getQueryValue(req, key, fallbackValue = '') {
  const query = getQueryObject(req);
  if (!Object.prototype.hasOwnProperty.call(query, key)) {
    return fallbackValue;
  }
  return query[key];
}

function getCsvQuery(req, key) {
  const value = getQueryValue(req, key, '');
  if (Array.isArray(value)) {
    const values = [];
    for (let i = 0; i < value.length; i++) {
      const part = String(value[i] || '').trim();
      if (part !== '') {
        values.push(part);
      }
    }
    return values;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function getNumberQuery(req, key, fallbackValue, min = null, max = null) {
  const value = getQueryValue(req, key, fallbackValue);
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallbackValue;
  }
  let output = parsed;
  if (typeof min === 'number' && output < min) {
    output = min;
  }
  if (typeof max === 'number' && output > max) {
    output = max;
  }
  return output;
}

function getBooleanQuery(req, key, fallbackValue = null) {
  const query = getQueryObject(req);
  if (!Object.prototype.hasOwnProperty.call(query, key)) {
    return fallbackValue;
  }
  const value = query[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === '1' ||
      normalized === 'true' ||
      normalized === 'yes' ||
      normalized === 'on'
    ) {
      return true;
    }
    if (
      normalized === '0' ||
      normalized === 'false' ||
      normalized === 'no' ||
      normalized === 'off'
    ) {
      return false;
    }
  }
  return fallbackValue;
}

function normalizeSortTokens(sortValue = '', defaultSort = '') {
  let source = String(sortValue || '').trim();
  if (source === '' && defaultSort) {
    source = String(defaultSort || '').trim();
  }
  if (source === '') {
    return [];
  }
  return source
    .split(',')
    .map((part) => String(part || '').trim())
    .filter((part) => part !== '')
    .map((part) => {
      let desc = false;
      let key = part;
      if (part.charAt(0) === '-') {
        desc = true;
        key = part.substring(1);
      }
      return {
        key,
        desc,
      };
    })
    .filter((part) => part.key !== '');
}

function getValueByPath(obj, pathExpression = '') {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const parts = String(pathExpression || '')
    .split('.')
    .filter((part) => part !== '');
  if (parts.length === 0) {
    return undefined;
  }
  let active = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (
      active &&
      typeof active === 'object' &&
      Object.prototype.hasOwnProperty.call(active, part)
    ) {
      active = active[part];
      continue;
    }
    return undefined;
  }
  return active;
}

function comparePrimitiveValues(a, b, desc = false) {
  if (a === b) {
    return 0;
  }
  const aUndefined = typeof a === 'undefined' || a === null;
  const bUndefined = typeof b === 'undefined' || b === null;
  if (aUndefined && bUndefined) {
    return 0;
  }
  if (aUndefined) {
    return desc ? 1 : -1;
  }
  if (bUndefined) {
    return desc ? -1 : 1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return desc ? b - a : a - b;
  }
  const aValue = String(a).toLowerCase();
  const bValue = String(b).toLowerCase();
  if (aValue === bValue) {
    return 0;
  }
  if (desc) {
    return aValue < bValue ? 1 : -1;
  }
  return aValue < bValue ? -1 : 1;
}

function sortRecords(records = [], sortValue = '', defaultSort = '') {
  const tokens = normalizeSortTokens(sortValue, defaultSort);
  if (tokens.length === 0) {
    return [...records];
  }
  const output = [...records];
  output.sort((a, b) => {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      let aValue = getValueByPath(a, token.key);
      let bValue = getValueByPath(b, token.key);
      if (typeof aValue === 'undefined' && token.key.indexOf('.') === -1) {
        aValue = getValueByPath(a, `metadata.${token.key}`);
      }
      if (typeof bValue === 'undefined' && token.key.indexOf('.') === -1) {
        bValue = getValueByPath(b, `metadata.${token.key}`);
      }
      const comparison = comparePrimitiveValues(aValue, bValue, token.desc);
      if (comparison !== 0) {
        return comparison;
      }
    }
    return 0;
  });
  return output;
}

function paginateRecords(records = [], req, defaultLimit = 25, maxLimit = 200) {
  const limit = getNumberQuery(req, 'page.limit', defaultLimit, 1, maxLimit);
  const offset = getNumberQuery(req, 'page.offset', 0, 0);
  return {
    page: {
      limit,
      offset,
      total: records.length,
    },
    records: records.slice(offset, offset + limit),
  };
}

function setValueByPath(target, pathExpression, value) {
  const parts = String(pathExpression || '')
    .split('.')
    .filter((part) => part !== '');
  if (parts.length === 0) {
    return;
  }
  let active = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!Object.prototype.hasOwnProperty.call(active, part)) {
      active[part] = {};
    }
    if (!active[part] || typeof active[part] !== 'object') {
      active[part] = {};
    }
    active = active[part];
  }
  active[parts[parts.length - 1]] = value;
}

function projectRecord(record, fields = []) {
  if (!record || typeof record !== 'object') {
    return record;
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    return record;
  }
  const output = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const value = getValueByPath(record, field);
    if (typeof value !== 'undefined') {
      setValueByPath(output, field, value);
    }
  }
  return output;
}

function projectCollection(records = [], fields = []) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return records;
  }
  return records.map((record) => projectRecord(record, fields));
}

function findItemByIdOrSlug(site, idOrSlug) {
  if (!site || !site.manifest || !idOrSlug) {
    return null;
  }
  const value = decodeURIComponent(String(idOrSlug || '').trim());
  if (value === '') {
    return null;
  }
  if (typeof site.manifest.getItemById === 'function') {
    const byId = site.manifest.getItemById(value);
    if (byId) {
      return byId;
    }
  }
  if (typeof site.manifest.getItemByProperty === 'function') {
    const bySlug = site.manifest.getItemByProperty('slug', value);
    if (bySlug) {
      return bySlug;
    }
  }
  const allItems = normalizeManifestItems(site);
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    if (!item) {
      continue;
    }
    if (String(item.id || '') === value || String(item.slug || '') === value) {
      return item;
    }
  }
  return null;
}

async function getItemContent(site, item) {
  if (!site || !item || !item.id || typeof site.loadNode !== 'function') {
    return '';
  }
  const page = site.loadNode(item.id);
  if (!page || typeof site.getPageContent !== 'function') {
    return '';
  }
  try {
    const content = await site.getPageContent(page);
    if (typeof content === 'string') {
      return content;
    }
  }
  catch (e) {}
  return '';
}

function extractCustomElementTagsFromHtml(html = '') {
  const usage = {};
  const source = String(html || '');
  const regex = /<([a-z][a-z0-9-]*-[a-z0-9-]*)\b/gi;
  let matched = regex.exec(source);
  while (matched) {
    const tag = String(matched[1] || '').toLowerCase();
    if (tag !== '') {
      usage[tag] = (usage[tag] || 0) + 1;
    }
    matched = regex.exec(source);
  }
  return usage;
}

async function collectCustomElementUsage(site, items = []) {
  const usage = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const html = await getItemContent(site, item);
    const matches = extractCustomElementTagsFromHtml(html);
    for (const key in matches) {
      usage[key] = (usage[key] || 0) + matches[key];
    }
  }
  return usage;
}

function normalizePathForResponse(value = '') {
  return String(value).split(path.sep).join('/');
}

function isManagedDerivativePath(relativePath = '') {
  const normalizedRelativePath = normalizePathForResponse(relativePath).replace(
    /^\/+/,
    '',
  );
  return (
    normalizedRelativePath === 'haxcms-managed' ||
    normalizedRelativePath.indexOf('haxcms-managed/') === 0
  );
}

function collectSiteFiles(site, siteFilePath, search = '') {
  const files = [];
  if (!fs.existsSync(siteFilePath) || !fs.lstatSync(siteFilePath).isDirectory()) {
    return files;
  }
  const searchValue = String(search || '').toLowerCase().trim();
  const ignoredFiles = [
    '.',
    '..',
    '.gitkeep',
    '.DS_Store',
    '._.DS_Store',
    '.htaccess',
    '._htaccess',
  ];
  const directories = [siteFilePath];
  while (directories.length) {
    const activeDirectory = directories.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(activeDirectory);
    }
    catch (e) {
      entries = [];
    }
    for (let i = 0; i < entries.length; i++) {
      const entryName = entries[i];
      if (ignoredFiles.indexOf(entryName) !== -1) {
        continue;
      }
      const absoluteEntryPath = path.join(activeDirectory, entryName);
      let entryStats = null;
      try {
        entryStats = fs.lstatSync(absoluteEntryPath);
      }
      catch (e) {
        entryStats = null;
      }
      if (!entryStats || entryStats.isSymbolicLink()) {
        continue;
      }
      if (entryStats.isDirectory()) {
        const relativeDirectoryPath = normalizePathForResponse(
          path.relative(siteFilePath, absoluteEntryPath),
        );
        if (isManagedDerivativePath(relativeDirectoryPath)) {
          continue;
        }
        directories.push(absoluteEntryPath);
        continue;
      }
      if (!entryStats.isFile()) {
        continue;
      }
      const relativePath = normalizePathForResponse(
        path.relative(siteFilePath, absoluteEntryPath),
      );
      if (relativePath === '' || isManagedDerivativePath(relativePath)) {
        continue;
      }
      if (
        searchValue !== '' &&
        relativePath.toLowerCase().indexOf(searchValue) === -1 &&
        entryName.toLowerCase().indexOf(searchValue) === -1
      ) {
        continue;
      }
      files.push({
        relativePath,
        absolutePath: absoluteEntryPath,
        stats: entryStats,
      });
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

function normalizeFormatValue(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '') {
    return '';
  }
  if (Object.prototype.hasOwnProperty.call(FORMAT_ALIASES, normalized)) {
    return FORMAT_ALIASES[normalized];
  }
  return '';
}

function normalizeAllowedFormats(allowedFormats = ['json']) {
  const normalized = [];
  for (let i = 0; i < allowedFormats.length; i++) {
    const format = normalizeFormatValue(allowedFormats[i]);
    if (format && normalized.indexOf(format) === -1) {
      normalized.push(format);
    }
  }
  if (normalized.length === 0) {
    normalized.push('json');
  }
  return normalized;
}

function parseAcceptHeader(acceptHeader = '') {
  if (typeof acceptHeader !== 'string' || acceptHeader.trim() === '') {
    return [];
  }
  return acceptHeader
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const parts = entry.split(';').map((part) => part.trim());
      const mediaType = parts[0].toLowerCase();
      let quality = 1;
      for (let i = 1; i < parts.length; i++) {
        const section = parts[i];
        if (section.indexOf('q=') === 0) {
          const parsedQuality = Number(section.substring(2));
          if (!Number.isNaN(parsedQuality)) {
            quality = parsedQuality;
          }
        }
      }
      return {
        mediaType,
        quality,
      };
    })
    .sort((a, b) => b.quality - a.quality);
}

function detectResponseFormat(req, allowedFormats = ['json'], defaultFormat = 'json') {
  const normalizedAllowed = normalizeAllowedFormats(allowedFormats);
  const queryFormat = normalizeFormatValue(getQueryValue(req, 'format', ''));
  if (queryFormat && normalizedAllowed.indexOf(queryFormat) !== -1) {
    return queryFormat;
  }
  const normalizedDefault = normalizeFormatValue(defaultFormat);
  if (
    normalizedDefault &&
    normalizedAllowed.indexOf(normalizedDefault) !== -1
  ) {
    return normalizedDefault;
  }
  const requestedAccept = parseAcceptHeader(
    req && req.headers && typeof req.headers.accept === 'string'
      ? req.headers.accept
      : '',
  );
  for (let i = 0; i < requestedAccept.length; i++) {
    const acceptEntry = requestedAccept[i];
    if (acceptEntry.mediaType === '*/*') {
      break;
    }
    const normalizedAccept = normalizeFormatValue(acceptEntry.mediaType);
    if (normalizedAccept && normalizedAllowed.indexOf(normalizedAccept) !== -1) {
      return normalizedAccept;
    }
  }
  return normalizedAllowed[0];
}

function getRepresentationPath(resourcePath, format) {
  const ext = FORMAT_TO_EXTENSION[format] || 'json';
  const cleanPath = String(resourcePath || '')
    .split('?')[0]
    .replace(/\.(json|md|markdown|yaml|yml|xml|html)$/i, '');
  return `${cleanPath}.${ext}`;
}

function setRepresentationHeaders(res, resourcePath, allowedFormats, selectedFormat) {
  if (!res || typeof res.setHeader !== 'function') {
    return;
  }
  const normalizedAllowed = normalizeAllowedFormats(allowedFormats);
  res.setHeader('Vary', 'Accept');
  res.setHeader(
    'Content-Location',
    getRepresentationPath(resourcePath, selectedFormat),
  );
  const alternates = [];
  for (let i = 0; i < normalizedAllowed.length; i++) {
    const format = normalizedAllowed[i];
    const href = getRepresentationPath(resourcePath, format);
    const mimeType = FORMAT_TO_MIME[format] || 'application/octet-stream';
    alternates.push(`<${href}>; rel="alternate"; type="${mimeType}"`);
  }
  if (alternates.length > 0) {
    res.setHeader('Link', alternates.join(', '));
  }
}

function escapeHtmlValue(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXmlValue(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getSafeXmlTag(tag = '') {
  let normalized = String(tag || '').replace(/[^a-zA-Z0-9_-]/g, '-');
  if (normalized === '' || /^[0-9]/.test(normalized)) {
    normalized = `item-${normalized}`;
  }
  return normalized;
}

function toXmlNode(name, value) {
  const tag = getSafeXmlTag(name);
  if (value === null || typeof value === 'undefined') {
    return `<${tag}></${tag}>`;
  }
  if (Array.isArray(value)) {
    const children = value.map((item) => toXmlNode('item', item)).join('');
    return `<${tag}>${children}</${tag}>`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const children = keys
      .map((key) => toXmlNode(key, value[key]))
      .join('');
    return `<${tag}>${children}</${tag}>`;
  }
  return `<${tag}>${escapeXmlValue(value)}</${tag}>`;
}

function serializeMarkdown(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  return JSON.stringify(payload, null, 2);
}

function serializePayload(payload, format) {
  switch (format) {
    case 'yaml':
      return YAML.stringify(payload);
    case 'xml':
      return `<?xml version="1.0" encoding="UTF-8"?>\n${toXmlNode('response', payload)}`;
    case 'md':
      return serializeMarkdown(payload);
    case 'html':
      if (typeof payload === 'string') {
        return payload;
      }
      return `<pre>${escapeHtmlValue(JSON.stringify(payload, null, 2))}</pre>`;
    case 'json':
    default:
      return JSON.stringify(payload, null, 2);
  }
}

function sendFormattedResponse(req, res, data, options = {}) {
  const statusCode = typeof options.statusCode === 'number' ? options.statusCode : 200;
  const allowedFormats = normalizeAllowedFormats(options.allowedFormats || ['json']);
  const defaultFormat = options.defaultFormat || 'json';
  const envelope = options.envelope === false ? false : true;
  const resourcePath = options.resourcePath || getRequestPath(req);
  const selectedFormat = detectResponseFormat(req, allowedFormats, defaultFormat);
  const payload = envelope ? { status: statusCode, data } : data;
  const rawByFormat = options.rawByFormat && typeof options.rawByFormat === 'object'
    ? options.rawByFormat
    : {};
  setRepresentationHeaders(res, resourcePath, allowedFormats, selectedFormat);
  if (selectedFormat === 'json') {
    return res.status(statusCode).json(payload);
  }
  res.status(statusCode);
  res.setHeader(
    'Content-Type',
    `${FORMAT_TO_MIME[selectedFormat] || 'text/plain'}; charset=utf-8`,
  );
  if (Object.prototype.hasOwnProperty.call(rawByFormat, selectedFormat)) {
    const rawValue = rawByFormat[selectedFormat];
    if (typeof rawValue === 'string') {
      return res.send(rawValue);
    }
    return res.send(serializePayload(rawValue, selectedFormat));
  }
  return res.send(serializePayload(payload, selectedFormat));
}

function itemToSummary(item, apiBasePath = '/x/api') {
  const metadata = item && item.metadata && typeof item.metadata === 'object'
    ? item.metadata
    : {};
  const itemLookupValue =
    item && item.slug ? String(item.slug) : item && item.id ? String(item.id) : '';
  const parentLookupValue = item && item.parent ? String(item.parent) : '';
  const itemIdValue = item && item.id ? String(item.id) : '';
  return {
    id: item && item.id ? item.id : null,
    title: item && item.title ? item.title : '',
    slug: item && item.slug ? item.slug : '',
    parent: item && item.parent ? item.parent : null,
    indent: item && typeof item.indent !== 'undefined' ? Number(item.indent) : 0,
    order: item && typeof item.order !== 'undefined' ? Number(item.order) : 0,
    location: item && item.location ? item.location : '',
    description: item && item.description ? item.description : '',
    metadata,
    region: metadata.region ? String(metadata.region) : null,
    tags: normalizeTagList(metadata.tags),
    published: metadata.published !== false,
    links: {
      self: `${apiBasePath}/v1/items/${encodeURIComponent(itemLookupValue)}`,
      content: `${apiBasePath}/v1/content/${encodeURIComponent(itemLookupValue)}`,
      parent:
        parentLookupValue !== ''
          ? `${apiBasePath}/v1/items/${encodeURIComponent(parentLookupValue)}`
          : null,
      children:
        itemIdValue !== ''
          ? `${apiBasePath}/v1/items?filter.parent=${encodeURIComponent(itemIdValue)}`
          : null,
    },
    related: [
      {
        rel: 'entity',
        type: 'item',
        href: `${apiBasePath}/v1/entities#item`,
      },
      {
        rel: 'schema',
        type: 'jsonOutlineSchema',
        href: `${apiBasePath}/v1/schemas?filter.kind=jsonOutlineSchema`,
      },
      {
        rel: 'schema',
        type: 'jsonOutlineSchemaItem',
        href: `${apiBasePath}/v1/schemas?filter.kind=jsonOutlineSchemaItem`,
      },
    ],
  };
}

function contentToRecord(item, body = '') {
  return {
    id: item && item.id ? item.id : null,
    slug: item && item.slug ? item.slug : '',
    title: item && item.title ? item.title : '',
    format: 'html',
    mode: 'bundle',
    body: typeof body === 'string' ? body : '',
  };
}

function applyItemFilters(items = [], req, site = null) {
  let output = [...items];
  const filterParent = getQueryValue(req, 'filter.parent', '');
  const filterAncestor = getQueryValue(req, 'filter.ancestor', '');
  const filterDepth = getNumberQuery(req, 'filter.depth', null, 0);
  const filterTags = getCsvQuery(req, 'filter.tags').map((tag) => tag.toLowerCase());
  const filterPublished = getBooleanQuery(req, 'filter.published', null);
  const filterPageType = String(getQueryValue(req, 'filter.pageType', '') || '').trim();
  const filterRegion = String(getQueryValue(req, 'filter.region', '') || '').trim();
  if (filterAncestor !== '' && site && site.manifest && typeof site.manifest.findBranch === 'function') {
    try {
      const branch = site.manifest.findBranch(filterAncestor);
      if (Array.isArray(branch)) {
        const branchIds = new Set();
        for (let i = 0; i < branch.length; i++) {
          if (branch[i] && branch[i].id) {
            branchIds.add(branch[i].id);
          }
        }
        output = output.filter((item) => item && item.id && branchIds.has(item.id));
      }
    }
    catch (e) {}
  }
  if (filterParent !== '') {
    output = output.filter((item) => {
      if (!item) {
        return false;
      }
      return String(item.parent || '') === String(filterParent);
    });
  }
  if (filterDepth !== null && filterAncestor !== '' && site && site.manifest) {
    const ancestorItem = findItemByIdOrSlug(site, filterAncestor);
    if (ancestorItem) {
      const baseIndent = Number(ancestorItem.indent || 0);
      output = output.filter((item) => {
        if (!item) {
          return false;
        }
        const indent = Number(item.indent || 0);
        return indent <= baseIndent + filterDepth;
      });
    }
  }
  if (filterTags.length > 0) {
    output = output.filter((item) => {
      const itemTags = normalizeTagList(
        item && item.metadata ? item.metadata.tags : [],
      ).map((tag) => tag.toLowerCase());
      for (let i = 0; i < filterTags.length; i++) {
        if (itemTags.indexOf(filterTags[i]) !== -1) {
          return true;
        }
      }
      return false;
    });
  }
  if (filterPublished !== null) {
    output = output.filter((item) => {
      const itemPublished = !(
        item &&
        item.metadata &&
        Object.prototype.hasOwnProperty.call(item.metadata, 'published') &&
        item.metadata.published === false
      );
      return itemPublished === filterPublished;
    });
  }
  if (filterPageType !== '') {
    output = output.filter((item) => {
      if (!item || !item.metadata || !item.metadata.pageType) {
        return false;
      }
      return String(item.metadata.pageType) === filterPageType;
    });
  }
  if (filterRegion !== '') {
    output = output.filter((item) => {
      if (!item || !item.metadata || !item.metadata.region) {
        return false;
      }
      return String(item.metadata.region) === filterRegion;
    });
  }
  return output;
}

module.exports = {
  DEFAULT_QUERY_GRAMMAR,
  DEFAULT_FORMATS,
  FORMAT_TO_MIME,
  getRequestPath,
  getApiBasePathFromRequestPath,
  getApiBasePath,
  getMultisiteSiteNameFromPath,
  resolveSiteForRequest,
  normalizeManifestItems,
  getOrderedItems,
  normalizeTagList,
  toIsoDateFromUnixTime,
  getSiteLanguage,
  getSiteTheme,
  getSiteBasePath,
  getQueryValue,
  getCsvQuery,
  getNumberQuery,
  getBooleanQuery,
  normalizeSortTokens,
  sortRecords,
  paginateRecords,
  projectRecord,
  projectCollection,
  findItemByIdOrSlug,
  getItemContent,
  extractCustomElementTagsFromHtml,
  collectCustomElementUsage,
  collectSiteFiles,
  normalizePathForResponse,
  normalizeFormatValue,
  detectResponseFormat,
  setRepresentationHeaders,
  serializePayload,
  sendFormattedResponse,
  itemToSummary,
  contentToRecord,
  applyItemFilters,
};
