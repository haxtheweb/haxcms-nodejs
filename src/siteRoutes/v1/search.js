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
  getItemContent,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function normalizeSearchFields(fields = []) {
  const allowed = ['id', 'title', 'slug', 'description', 'tags', 'content', 'location'];
  if (!Array.isArray(fields) || fields.length === 0) {
    return ['title', 'slug', 'description', 'tags', 'content'];
  }
  const normalized = [];
  for (let i = 0; i < fields.length; i++) {
    const field = String(fields[i] || '').trim().toLowerCase();
    if (allowed.indexOf(field) !== -1 && normalized.indexOf(field) === -1) {
      normalized.push(field);
    }
  }
  if (normalized.length === 0) {
    return ['title', 'slug', 'description', 'tags', 'content'];
  }
  return normalized;
}

function getSearchFieldValue(field, item, content = '') {
  switch (field) {
    case 'id':
      return String(item && item.id ? item.id : '');
    case 'title':
      return String(item && item.title ? item.title : '');
    case 'slug':
      return String(item && item.slug ? item.slug : '');
    case 'description':
      return String(item && item.description ? item.description : '');
    case 'location':
      return String(item && item.location ? item.location : '');
    case 'tags':
      return normalizeTagList(item && item.metadata ? item.metadata.tags : []).join(' ');
    case 'content':
      return String(content || '');
    default:
      return '';
  }
}

function findMatches(value, queryLower) {
  const source = String(value || '');
  if (source === '') {
    return null;
  }
  const lower = source.toLowerCase();
  const index = lower.indexOf(queryLower);
  if (index === -1) {
    return null;
  }
  const snippetStart = Math.max(index - 60, 0);
  const snippetEnd = Math.min(index + queryLower.length + 60, source.length);
  return {
    index,
    length: queryLower.length,
    snippet: source
      .slice(snippetStart, snippetEnd)
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

async function search(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/search',
    });
  }
  const query = String(getQueryValue(req, 'q', '') || '').trim();
  if (query === '') {
    return res.status(400).json({
      status: 400,
      message: 'Query parameter "q" is required',
    });
  }
  if (query.length > 256) {
    return res.status(400).json({
      status: 400,
      message: 'Query parameter "q" exceeds 256 characters',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const queryLower = query.toLowerCase();
  const searchFields = normalizeSearchFields(getCsvQuery(req, 'fields'));
  const filteredItems = applyItemFilters(getOrderedItems(site), req, site);
  const results = [];
  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];
    const content = searchFields.indexOf('content') !== -1
      ? await getItemContent(site, item)
      : '';
    const matches = [];
    let score = 0;
    for (let f = 0; f < searchFields.length; f++) {
      const field = searchFields[f];
      const fieldValue = getSearchFieldValue(field, item, content);
      const match = findMatches(fieldValue, queryLower);
      if (!match) {
        continue;
      }
      matches.push({
        field,
        index: match.index,
        length: match.length,
        snippet: match.snippet,
      });
      score += 1;
    }
    if (matches.length === 0) {
      continue;
    }
    results.push({
      id: item && item.id ? item.id : null,
      title: item && item.title ? item.title : '',
      slug: item && item.slug ? item.slug : '',
      location: item && item.location ? item.location : '',
      score,
      snippet: matches[0].snippet,
      matches,
      links: {
        item: `${apiBasePath}/v1/items/${encodeURIComponent(item && item.slug ? item.slug : item && item.id ? item.id : '')}`,
        content: `${apiBasePath}/v1/content/${encodeURIComponent(item && item.slug ? item.slug : item && item.id ? item.id : '')}`,
      },
    });
  }
  const sortedResults = sortRecords(results, getQueryValue(req, 'sort', ''), '-score');
  const paged = paginateRecords(sortedResults, req, 25, 200);
  const outputFields = getCsvQuery(req, 'fields');
  const outputResults = projectCollection(paged.records, outputFields);
  return sendFormattedResponse(
    req,
    res,
    {
      query,
      fields: searchFields,
      count: outputResults.length,
      total: paged.page.total,
      page: paged.page,
      results: outputResults,
      links: {
        self: `${apiBasePath}/v1/search`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = search;
