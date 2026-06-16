const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  sortRecords,
  paginateRecords,
  projectRecord,
  projectCollection,
  resolveSiteForRequest,
  getOrderedItems,
  applyItemFilters,
  contentToRecord,
  sendFormattedResponse,
  findItemByIdOrSlug,
  getItemContent,
  getSiteBasePath,
  isItemVisibleToAnonymous,
  isAnonymousSiteApiRequest,
  ensureRequestBodyObject,
  getRequestHeaderValue,
  getSiteNameFromResolvedSite,
} = require('./siteRouteUtils.js');
const saveNodeRoute = require('./routes/saveNode.js');
const siteSearchRoute = require('./routes/siteSearch.js');
function ensureSiteTokenHeader(req) {
  const headerToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
  if (headerToken === '') {
    return null;
  }
  return headerToken;
}

function ensureSiteRequestBody(req, siteName = '') {
  const body = ensureRequestBodyObject(req);
  if (!body.site || typeof body.site !== 'object' || Array.isArray(body.site)) {
    body.site = {};
  }
  if ((!body.site.name || String(body.site.name).trim() === '') && siteName !== '') {
    body.site.name = siteName;
  }
  return body;
}

function buildConcatMarkdown(records = []) {
  const sections = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    sections.push(`# ${record.title || record.slug || record.id || 'Untitled'}`);
    sections.push('');
    sections.push(String(record.body || ''));
    sections.push('');
  }
  return sections.join('\n').trim();
}

function buildConcatHtml(records = []) {
  const sections = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    sections.push(
      `<article data-item-id="${record.id || ''}"><h2>${record.title || record.slug || record.id || 'Untitled'}</h2>${record.body || ''}</article>`,
    );
  }
  return sections.join('\n');
}

function getItemLookupValue(item) {
  if (item && item.slug) {
    return String(item.slug);
  }
  if (item && item.id) {
    return String(item.id);
  }
  return '';
}

function normalizeBasePath(basePath = '/') {
  let output = String(basePath || '/').trim();
  if (output === '') {
    output = '/';
  }
  if (output.charAt(0) !== '/') {
    output = '/' + output;
  }
  if (output.charAt(output.length - 1) !== '/') {
    output += '/';
  }
  return output;
}

function encodeSlugPath(slug = '') {
  return String(slug || '')
    .split('/')
    .map((segment) => String(segment || '').trim())
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildCanonicalPagePath(basePath = '/', slug = '') {
  const normalizedBasePath = normalizeBasePath(basePath).replace(/\/+$/, '');
  const encodedSlugPath = encodeSlugPath(slug);
  if (encodedSlugPath === '') {
    return normalizedBasePath === '' ? '/' : normalizedBasePath;
  }
  if (normalizedBasePath === '' || normalizedBasePath === '/') {
    return `/${encodedSlugPath}`;
  }
  return `${normalizedBasePath}/${encodedSlugPath}`;
}

function buildContentLinks(
  apiBasePath = '/x/api',
  itemLookupValue = '',
  siteBasePath = '/',
  itemSlug = '',
) {
  const encodedLookup = encodeURIComponent(String(itemLookupValue || ''));
  const selfLink = `${apiBasePath}/v1/content/${encodedLookup}`;
  const canonicalPagePath = buildCanonicalPagePath(siteBasePath, itemSlug);
  return {
    self: selfLink,
    item: `${apiBasePath}/v1/items/${encodedLookup}`,
    page: canonicalPagePath,
    json: `${canonicalPagePath}.json`,
    md: `${canonicalPagePath}.md`,
    yaml: `${canonicalPagePath}.yaml`,
    xml: `${canonicalPagePath}.xml`,
    html: `${canonicalPagePath}.html`,
  };
}

async function listContent(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/content',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const siteBasePath = getSiteBasePath(site);
  const fields = getCsvQuery(req, 'fields');
  const modeValue = String(getQueryValue(req, 'mode', 'bundle') || '').trim();
  const mode = modeValue === 'concat' ? 'concat' : 'bundle';
  const orderedItems = getOrderedItems(site);
  const filteredItems = applyItemFilters(orderedItems, req, site, {
    enforceAnonymousVisibility: true,
  });
  const records = [];
  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];
    const body = await getItemContent(site, item);
    const record = contentToRecord(item, body);
    const itemLookupValue = getItemLookupValue(item);
    const itemSlug = item && item.slug ? String(item.slug) : itemLookupValue;
    record.links = buildContentLinks(
      apiBasePath,
      itemLookupValue,
      siteBasePath,
      itemSlug,
    );
    records.push(record);
  }
  const sortedRecords = sortRecords(records, getQueryValue(req, 'sort', ''), 'title');
  const paged = paginateRecords(sortedRecords, req, 25, 200);
  const outputRecords = projectCollection(paged.records, fields);
  const responseData = {
    mode,
    count: outputRecords.length,
    total: paged.page.total,
    page: paged.page,
    content: mode === 'concat' ? buildConcatMarkdown(outputRecords) : outputRecords,
    links: {
      self: `${apiBasePath}/v1/content`,
    },
  };
  const rawByFormat = {};
  if (mode === 'concat') {
    rawByFormat.md = buildConcatMarkdown(outputRecords);
    rawByFormat.html = buildConcatHtml(outputRecords);
  }
  return sendFormattedResponse(req, res, responseData, {
    allowedFormats: ['json', 'md', 'yaml', 'xml', 'html'],
    defaultFormat: 'json',
    rawByFormat,
  });
}

async function contentDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/content/:idOrSlug',
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? req.params.idOrSlug : '';
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      message: `Content not found for idOrSlug "${idOrSlug}"`,
    });
  }
  if (
    isAnonymousSiteApiRequest(req) &&
    !isItemVisibleToAnonymous(item)
  ) {
    return res.status(404).json({
      status: 404,
      message: `Content not found for idOrSlug "${idOrSlug}"`,
    });
  }
  const apiBasePath = getApiBasePath(req);
  const siteBasePath = getSiteBasePath(site);
  const fields = getCsvQuery(req, 'fields');
  const modeValue = String(getQueryValue(req, 'mode', 'bundle') || '').trim();
  const mode = modeValue === 'concat' ? 'concat' : 'bundle';
  const body = await getItemContent(site, item);
  let record = contentToRecord(item, body);
  record.mode = mode;
  record.links = buildContentLinks(
    apiBasePath,
    getItemLookupValue(item),
    siteBasePath,
    item && item.slug ? String(item.slug) : getItemLookupValue(item),
  );
  record = projectRecord(record, fields);
  const rawByFormat = {};
  if (mode === 'concat') {
    rawByFormat.md = String(record.body || '');
    rawByFormat.html = String(record.body || '');
  }
  return sendFormattedResponse(req, res, record, {
    allowedFormats: ['json', 'md', 'yaml', 'xml', 'html'],
    defaultFormat: 'json',
    rawByFormat,
  });
}

async function updateContent(req, res, next) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/content/:idOrSlug',
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : '';
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item || !item.id) {
    return res.status(404).json({
      status: 404,
      message: `Content not found for idOrSlug "${idOrSlug}"`,
    });
  }
  const siteName = getSiteNameFromResolvedSite(site);
  if (siteName === '') {
    return res.status(400).json({
      status: 400,
      message: 'Unable to resolve site name for content update operation',
    });
  }
  const siteToken = ensureSiteTokenHeader(req);
  if (!siteToken) {
    return res.status(403).json({
      status: 403,
      message: 'X-HAXCMS-Site-Token header is required for this endpoint',
    });
  }
  const body = ensureSiteRequestBody(req, siteName);
  let bodyContent = '';
  if (typeof body.body === 'string') {
    bodyContent = body.body;
  }
  else if (typeof body.content === 'string') {
    bodyContent = body.content;
  }
  else if (
    body.node &&
    typeof body.node === 'object' &&
    !Array.isArray(body.node) &&
    typeof body.node.body === 'string'
  ) {
    bodyContent = body.node.body;
  }
  if (bodyContent === '') {
    return res.status(400).json({
      status: 400,
      message: 'Content body is required',
    });
  }
  let schema = [];
  if (Array.isArray(body.schema)) {
    schema = body.schema;
  }
  else if (
    body.node &&
    typeof body.node === 'object' &&
    !Array.isArray(body.node) &&
    Array.isArray(body.node.schema)
  ) {
    schema = body.node.schema;
  }
  if (!body.node || typeof body.node !== 'object' || Array.isArray(body.node)) {
    body.node = {};
  }
  body.node.id = String(item.id);
  body.node.body = bodyContent;
  body.node.schema = schema;
  if (
    Object.prototype.hasOwnProperty.call(body, 'details') &&
    typeof body.details === 'object' &&
    body.details &&
    !Array.isArray(body.details)
  ) {
    body.node.details = body.details;
  }
  return saveNodeRoute(req, res, next);
}

async function replaceContent(req, res, next) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/content',
    });
  }
  const siteName = getSiteNameFromResolvedSite(site);
  if (siteName === '') {
    return res.status(400).json({
      status: 400,
      message: 'Unable to resolve site name for content replace operation',
    });
  }
  const siteToken = ensureSiteTokenHeader(req);
  if (!siteToken) {
    return res.status(403).json({
      status: 403,
      message: 'X-HAXCMS-Site-Token header is required for this endpoint',
    });
  }
  const body = ensureSiteRequestBody(req, siteName);
  if (!body.operation || String(body.operation).trim() === '') {
    body.operation = 'replace';
  }
  return siteSearchRoute(req, res, next);
}

module.exports = {
  listContent,
  contentDetail,
  updateContent,
  replaceContent,
};
