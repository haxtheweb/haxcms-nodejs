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
} = require('./siteRouteUtils.js');

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

async function listContent(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/content',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const modeValue = String(getQueryValue(req, 'mode', 'bundle') || '').trim();
  const mode = modeValue === 'concat' ? 'concat' : 'bundle';
  const orderedItems = getOrderedItems(site);
  const filteredItems = applyItemFilters(orderedItems, req, site);
  const records = [];
  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];
    const body = await getItemContent(site, item);
    const record = contentToRecord(item, body);
    record.links = {
      self: `${apiBasePath}/v1/content/${encodeURIComponent(item && item.slug ? item.slug : item && item.id ? item.id : '')}`,
      item: `${apiBasePath}/v1/items/${encodeURIComponent(item && item.slug ? item.slug : item && item.id ? item.id : '')}`,
    };
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
  const fields = getCsvQuery(req, 'fields');
  const modeValue = String(getQueryValue(req, 'mode', 'bundle') || '').trim();
  const mode = modeValue === 'concat' ? 'concat' : 'bundle';
  const body = await getItemContent(site, item);
  let record = contentToRecord(item, body);
  record.mode = mode;
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

module.exports = {
  listContent,
  contentDetail,
};
