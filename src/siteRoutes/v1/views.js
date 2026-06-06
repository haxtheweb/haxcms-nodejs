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
  itemToSummary,
  normalizeTagList,
  getItemContent,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function normalizeStoredViews(site, apiBasePath) {
  let source = [];
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    Array.isArray(site.manifest.metadata.site.views)
  ) {
    source = site.manifest.metadata.site.views;
  }
  else if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    Array.isArray(site.manifest.metadata.site.displays)
  ) {
    source = site.manifest.metadata.site.displays;
  }
  else {
    source = [
      {
        id: 'recent',
        title: 'Recent content',
        description: 'Latest updated pages',
        query: {
          source: 'items',
          sort: '-metadata.updated',
        },
        display: {
          type: 'list',
        },
      },
      {
        id: 'tags',
        title: 'Tags',
        description: 'Tag frequency summary',
        query: {
          source: 'tags',
        },
        display: {
          type: 'facet',
        },
      },
      {
        id: 'search',
        title: 'Search',
        description: 'Search results view',
        query: {
          source: 'search',
          q: '',
        },
        display: {
          type: 'list',
        },
      },
    ];
  }
  const records = [];
  for (let i = 0; i < source.length; i++) {
    const view = source[i];
    if (!view || typeof view !== 'object') {
      continue;
    }
    const id = String(
      view.id ||
        view.viewId ||
        view.machineName ||
        view.name ||
        `view-${i + 1}`,
    ).trim();
    if (id === '') {
      continue;
    }
    records.push({
      id,
      title: String(view.title || view.name || id),
      description: String(view.description || ''),
      query: view.query && typeof view.query === 'object' ? view.query : {},
      display:
        view.display && typeof view.display === 'object'
          ? view.display
          : { type: 'list' },
      links: {
        self: `${apiBasePath}/v1/views/${encodeURIComponent(id)}`,
        results: `${apiBasePath}/v1/views/${encodeURIComponent(id)}/results`,
        displayResults: `${apiBasePath}/v1/displays/${encodeURIComponent(id)}/results`,
      },
    });
  }
  return records;
}

function applyViewQueryFilters(items, viewQuery) {
  let records = [...items];
  if (!viewQuery || typeof viewQuery !== 'object') {
    return records;
  }
  if (typeof viewQuery.region === 'string' && viewQuery.region.trim() !== '') {
    records = records.filter((item) => {
      if (!item || !item.metadata || !item.metadata.region) {
        return false;
      }
      return String(item.metadata.region) === String(viewQuery.region);
    });
  }
  if (typeof viewQuery.tags === 'string' && viewQuery.tags.trim() !== '') {
    const tagList = viewQuery.tags
      .split(',')
      .map((tag) => String(tag || '').trim().toLowerCase())
      .filter((tag) => tag !== '');
    records = records.filter((item) => {
      const itemTags = normalizeTagList(
        item && item.metadata ? item.metadata.tags : [],
      ).map((tag) => tag.toLowerCase());
      for (let i = 0; i < tagList.length; i++) {
        if (itemTags.indexOf(tagList[i]) !== -1) {
          return true;
        }
      }
      return false;
    });
  }
  return records;
}

async function resolveViewResults(view, site, req, apiBasePath) {
  const source =
    view && view.query && typeof view.query.source === 'string'
      ? view.query.source
      : 'items';
  if (source === 'tags') {
    const tagMap = {};
    const items = getOrderedItems(site);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const tags = normalizeTagList(item && item.metadata ? item.metadata.tags : []);
      for (let t = 0; t < tags.length; t++) {
        tagMap[tags[t]] = (tagMap[tags[t]] || 0) + 1;
      }
    }
    return Object.keys(tagMap).map((tag) => ({
      tag,
      count: tagMap[tag],
    }));
  }
  if (source === 'search') {
    const query =
      String(getQueryValue(req, 'q', '') || '').trim() ||
      String(view.query && view.query.q ? view.query.q : '').trim();
    if (query === '') {
      return [];
    }
    const queryLower = query.toLowerCase();
    const items = getOrderedItems(site);
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const body = await getItemContent(site, item);
      const haystack = `${item.title || ''} ${item.description || ''} ${
        item.slug || ''
      } ${normalizeTagList(item.metadata && item.metadata.tags).join(' ')} ${body}`;
      if (String(haystack || '').toLowerCase().indexOf(queryLower) === -1) {
        continue;
      }
      results.push(itemToSummary(item, apiBasePath));
    }
    return results;
  }
  let items = getOrderedItems(site);
  items = applyViewQueryFilters(items, view.query);
  items = applyItemFilters(items, req, site);
  let records = items.map((item) => itemToSummary(item, apiBasePath));
  const viewSort =
    view && view.query && view.query.sort ? String(view.query.sort) : 'order';
  records = sortRecords(records, getQueryValue(req, 'sort', ''), viewSort);
  const paged = paginateRecords(records, req, 25, 200);
  return projectCollection(paged.records, getCsvQuery(req, 'fields'));
}

async function listViews(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/views',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  let records = normalizeStoredViews(site, apiBasePath);
  records = sortRecords(records, getQueryValue(req, 'sort', ''), 'id');
  const paged = paginateRecords(records, req, 50, 500);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      views: outputRecords,
      links: {
        self: `${apiBasePath}/v1/views`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

async function viewDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/views/:viewId',
    });
  }
  const viewId =
    req && req.params && req.params.viewId ? String(req.params.viewId) : '';
  if (viewId.trim() === '') {
    return res.status(404).json({
      status: 404,
      message: 'View not found',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const records = normalizeStoredViews(site, apiBasePath);
  const target = records.find((record) => String(record.id || '') === viewId);
  if (!target) {
    return res.status(404).json({
      status: 404,
      message: `View "${viewId}" not found`,
    });
  }
  const outputRecord = projectRecord(target, fields);
  return sendFormattedResponse(req, res, outputRecord, {
    allowedFormats: ['json'],
    defaultFormat: 'json',
  });
}

async function viewResults(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for view results endpoint',
    });
  }
  const viewId =
    req && req.params && req.params.viewId ? String(req.params.viewId) : '';
  if (viewId.trim() === '') {
    return res.status(404).json({
      status: 404,
      message: 'View not found',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const records = normalizeStoredViews(site, apiBasePath);
  const target = records.find((record) => String(record.id || '') === viewId);
  if (!target) {
    return res.status(404).json({
      status: 404,
      message: `View "${viewId}" not found`,
    });
  }
  const results = await resolveViewResults(target, site, req, apiBasePath);
  return sendFormattedResponse(
    req,
    res,
    {
      view: target,
      count: Array.isArray(results) ? results.length : 0,
      results,
    },
    {
      allowedFormats: ['json', 'md', 'yaml', 'xml'],
      defaultFormat: 'json',
    },
  );
}

async function listDisplays(req, res) {
  return await listViews(req, res);
}

async function displayResults(req, res) {
  return await viewResults(req, res);
}

module.exports = {
  listViews,
  viewDetail,
  viewResults,
  listDisplays,
  displayResults,
};
