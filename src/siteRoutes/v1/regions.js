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
  itemToSummary,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function getRegionName(item) {
  if (
    item &&
    item.metadata &&
    typeof item.metadata.region === 'string' &&
    item.metadata.region.trim() !== ''
  ) {
    return item.metadata.region.trim();
  }
  return 'default';
}

async function listRegions(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/regions',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const filteredItems = applyItemFilters(getOrderedItems(site), req, site);
  const regionMap = {};
  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];
    const regionName = getRegionName(item);
    regionMap[regionName] = (regionMap[regionName] || 0) + 1;
  }
  let records = Object.keys(regionMap).map((regionName) => ({
    name: regionName,
    count: regionMap[regionName],
    links: {
      self: `${apiBasePath}/v1/regions/${encodeURIComponent(regionName)}`,
    },
  }));
  records = sortRecords(records, getQueryValue(req, 'sort', ''), 'name');
  const paged = paginateRecords(records, req, 100, 1000);
  const outputRecords = projectCollection(paged.records, getCsvQuery(req, 'fields'));
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      regions: outputRecords,
      links: {
        self: `${apiBasePath}/v1/regions`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

async function regionDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/regions/:regionName',
    });
  }
  const regionName =
    req && req.params && req.params.regionName ? String(req.params.regionName) : '';
  if (regionName.trim() === '') {
    return res.status(404).json({
      status: 404,
      message: 'Region not found',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const filteredItems = applyItemFilters(getOrderedItems(site), req, site).filter(
    (item) => getRegionName(item) === regionName,
  );
  if (filteredItems.length === 0) {
    return res.status(404).json({
      status: 404,
      message: `Region "${regionName}" not found`,
    });
  }
  let itemRecords = filteredItems.map((item) => itemToSummary(item, apiBasePath));
  itemRecords = sortRecords(itemRecords, getQueryValue(req, 'sort', ''), 'order');
  const paged = paginateRecords(itemRecords, req, 25, 200);
  itemRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      region: {
        name: regionName,
        count: filteredItems.length,
      },
      page: paged.page,
      items: itemRecords,
      links: {
        self: `${apiBasePath}/v1/regions/${encodeURIComponent(regionName)}`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = {
  listRegions,
  regionDetail,
};
