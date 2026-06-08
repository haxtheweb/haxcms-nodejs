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

function getItemLookupValue(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }
  if (item.slug) {
    return String(item.slug);
  }
  if (item.id) {
    return String(item.id);
  }
  return '';
}

function buildItemNavigationMap(orderedItems = [], apiBasePath = '/x/api') {
  const itemById = {};
  for (let i = 0; i < orderedItems.length; i++) {
    const item = orderedItems[i];
    if (!item || !item.id) {
      continue;
    }
    itemById[String(item.id)] = item;
  }
  const navigationMap = {};
  for (let i = 0; i < orderedItems.length; i++) {
    const item = orderedItems[i];
    if (!item || !item.id) {
      continue;
    }
    const id = String(item.id);
    const previousItem = i > 0 ? orderedItems[i - 1] : null;
    const nextItem = i + 1 < orderedItems.length ? orderedItems[i + 1] : null;
    const previousLookupValue = getItemLookupValue(previousItem);
    const nextLookupValue = getItemLookupValue(nextItem);
    let parentLookupValue = '';
    if (item.parent) {
      const parentId = String(item.parent);
      if (Object.prototype.hasOwnProperty.call(itemById, parentId)) {
        parentLookupValue = getItemLookupValue(itemById[parentId]);
      }
      else {
        parentLookupValue = parentId;
      }
    }
    navigationMap[id] = {
      previous:
        previousLookupValue !== ''
          ? `${apiBasePath}/v1/items/${encodeURIComponent(previousLookupValue)}`
          : null,
      next:
        nextLookupValue !== ''
          ? `${apiBasePath}/v1/items/${encodeURIComponent(nextLookupValue)}`
          : null,
      parent:
        parentLookupValue !== ''
          ? `${apiBasePath}/v1/items/${encodeURIComponent(parentLookupValue)}`
          : null,
      children: `${apiBasePath}/v1/items?filter.parent=${encodeURIComponent(id)}`,
    };
  }
  return navigationMap;
}

function appendItemNavigationLinks(records = [], navigationMap = {}) {
  return records.map((record) => {
    if (!record || !record.id) {
      return record;
    }
    const id = String(record.id);
    if (!Object.prototype.hasOwnProperty.call(navigationMap, id)) {
      return record;
    }
    const links =
      record.links && typeof record.links === 'object' ? { ...record.links } : {};
    const nav = navigationMap[id];
    links.previous = nav.previous;
    links.next = nav.next;
    links.parent = nav.parent;
    links.children = nav.children;
    return {
      ...record,
      links,
    };
  });
}

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
  const navigationMap = buildItemNavigationMap(orderedItems, apiBasePath);
  const filteredItems = applyItemFilters(orderedItems, req, site);
  let records = filteredItems.map((item) => itemToSummary(item, apiBasePath));
  records = appendItemNavigationLinks(records, navigationMap);
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
  const navigationMap = buildItemNavigationMap(getOrderedItems(site), apiBasePath);
  let record = itemToSummary(item, apiBasePath);
  record = appendItemNavigationLinks([record], navigationMap)[0];
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
