const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  sortRecords,
  paginateRecords,
  projectCollection,
  resolveSiteForRequest,
  getOrderedItems,
  applyItemFilters,
  normalizeTagList,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function buildTagRecords(items = [], includeItems = false) {
  const byTag = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemTags = normalizeTagList(
      item && item.metadata ? item.metadata.tags : [],
    );
    for (let t = 0; t < itemTags.length; t++) {
      const tag = itemTags[t];
      if (!byTag[tag]) {
        byTag[tag] = {
          tag,
          count: 0,
          items: [],
        };
      }
      byTag[tag].count += 1;
      if (includeItems && item && item.id) {
        byTag[tag].items.push(item.id);
      }
    }
  }
  const records = Object.keys(byTag).map((key) => byTag[key]);
  return records;
}

async function tags(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/tags',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const includeItems = getCsvQuery(req, 'include').indexOf('items') !== -1;
  const tagFilter = getCsvQuery(req, 'filter.tags').map((tag) =>
    String(tag || '').toLowerCase(),
  );
  const filteredItems = applyItemFilters(getOrderedItems(site), req, site);
  let records = buildTagRecords(filteredItems, includeItems);
  if (tagFilter.length > 0) {
    records = records.filter(
      (record) => tagFilter.indexOf(String(record.tag || '').toLowerCase()) !== -1,
    );
  }
  records = sortRecords(records, getQueryValue(req, 'sort', ''), '-count');
  const paged = paginateRecords(records, req, 100, 1000);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      tags: outputRecords,
      links: {
        self: `${apiBasePath}/v1/tags`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = tags;
