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
  itemToSummary,
  sendFormattedResponse,
  findItemByIdOrSlug,
  getItemContent,
} = require('./siteRouteUtils.js');

async function appendRequestedItemIncludes(site, items, includes = []) {
  const includeContent = includes.indexOf('content') !== -1;
  if (!includeContent) {
    return items;
  }
  const hydrated = [];
  for (let i = 0; i < items.length; i++) {
    const record = items[i];
    const hydratedRecord = { ...record };
    const item = findItemByIdOrSlug(site, record.id || record.slug);
    hydratedRecord.content = await getItemContent(site, item);
    hydrated.push(hydratedRecord);
  }
  return hydrated;
}

async function listItems(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/items',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const includes = getCsvQuery(req, 'include');
  const fields = getCsvQuery(req, 'fields');
  const orderedItems = getOrderedItems(site);
  const filteredItems = applyItemFilters(orderedItems, req, site);
  let records = filteredItems.map((item) => itemToSummary(item, apiBasePath));
  records = await appendRequestedItemIncludes(site, records, includes);
  records = sortRecords(records, getQueryValue(req, 'sort', ''), 'order');
  const paged = paginateRecords(records, req, 25, 200);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      items: outputRecords,
      links: {
        self: `${apiBasePath}/v1/items`,
      },
    },
    {
      allowedFormats: ['json', 'md', 'yaml', 'xml', 'html'],
      defaultFormat: 'json',
    },
  );
}

async function itemDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/items/:idOrSlug',
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? req.params.idOrSlug : '';
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      message: `Item not found for idOrSlug "${idOrSlug}"`,
    });
  }
  const apiBasePath = getApiBasePath(req);
  const includes = getCsvQuery(req, 'include');
  const fields = getCsvQuery(req, 'fields');
  let record = itemToSummary(item, apiBasePath);
  if (includes.indexOf('content') !== -1) {
    record.content = await getItemContent(site, item);
  }
  record = projectRecord(record, fields);
  return sendFormattedResponse(req, res, record, {
    allowedFormats: ['json', 'md', 'yaml', 'xml', 'html'],
    defaultFormat: 'json',
  });
}

module.exports = {
  listItems,
  itemDetail,
};
