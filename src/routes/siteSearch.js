const { parse } = require('node-html-parser');
const { HAXCMS } = require('../lib/HAXCMS.js');

const SITE_SEARCH_DEFAULT_FIELDS = ['title', 'slug', 'description', 'tags', 'content'];
const SITE_SEARCH_ALLOWED_FIELDS = ['id', 'title', 'slug', 'description', 'tags', 'content', 'location', 'parent'];
const SITE_SEARCH_DEFAULT_LIMIT = 25;
const SITE_SEARCH_MAX_LIMIT = 200;
const SITE_SEARCH_MAX_QUERY_LENGTH = 256;

function parseBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

function parseLimitValue(value, fallback = SITE_SEARCH_DEFAULT_LIMIT) {
  if (typeof value === 'undefined' || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  if (parsed < 0) {
    return 0;
  }
  if (parsed > SITE_SEARCH_MAX_LIMIT) {
    return SITE_SEARCH_MAX_LIMIT;
  }
  return parsed;
}

function normalizeSearchFields(searchFieldValue) {
  if (!searchFieldValue) {
    return [...SITE_SEARCH_DEFAULT_FIELDS];
  }
  let values = [];
  if (Array.isArray(searchFieldValue)) {
    values = searchFieldValue;
  }
  else {
    values = String(searchFieldValue).split(',');
  }
  const normalized = [];
  for (const value of values) {
    const field = String(value).trim().toLowerCase();
    if (!field) {
      continue;
    }
    if (field === 'all') {
      return [...SITE_SEARCH_DEFAULT_FIELDS];
    }
    if (SITE_SEARCH_ALLOWED_FIELDS.includes(field)) {
      normalized.push(field);
    }
  }
  if (normalized.length === 0) {
    return [...SITE_SEARCH_DEFAULT_FIELDS];
  }
  return [...new Set(normalized)];
}

function normalizeTagsValue(item) {
  if (!item || !item.metadata || typeof item.metadata.tags === 'undefined' || item.metadata.tags === null) {
    return '';
  }
  if (Array.isArray(item.metadata.tags)) {
    return item.metadata.tags.join(', ');
  }
  if (typeof item.metadata.tags === 'string') {
    return item.metadata.tags;
  }
  try {
    return JSON.stringify(item.metadata.tags);
  }
  catch (e) {
    return String(item.metadata.tags);
  }
}

function normalizeFieldValue(field, item, content = '') {
  switch (field) {
    case 'id':
      return item && item.id ? String(item.id) : '';
    case 'title':
      return item && item.title ? String(item.title) : '';
    case 'slug':
      return item && item.slug ? String(item.slug) : '';
    case 'description':
      return item && item.description ? String(item.description) : '';
    case 'location':
      return item && item.location ? String(item.location) : '';
    case 'parent':
      return item && item.parent ? String(item.parent) : '';
    case 'tags':
      return normalizeTagsValue(item);
    case 'content':
      return typeof content === 'string' ? content : '';
    default:
      return '';
  }
}

function buildTextMatcher(searchTerm, caseSensitive = false) {
  const normalizedTerm = caseSensitive ? searchTerm : String(searchTerm).toLowerCase();
  return (value) => {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    const comparisonValue = caseSensitive ? value : value.toLowerCase();
    const index = comparisonValue.indexOf(normalizedTerm);
    if (index === -1) {
      return null;
    }
    return {
      index,
      length: searchTerm.length,
      snippet: value.slice(Math.max(index - 60, 0), Math.min(index + searchTerm.length + 60, value.length)).replace(/\s+/g, ' ').trim(),
    };
  };
}

function parseSimpleSelector(selectorString) {
  const selector = String(selectorString || '').trim();
  if (!selector) {
    return {
      valid: false,
      reason: 'Selector query is required',
    };
  }
  if (
    selector.includes(',') ||
    selector.includes(' ') ||
    selector.includes('>') ||
    selector.includes('+') ||
    selector.includes('~') ||
    selector.includes(':')
  ) {
    return {
      valid: false,
      reason: 'Only simple selectors are supported (tag, tag[attr], tag[attr="value"], [attr])',
    };
  }
  const matched = selector.match(/^([a-zA-Z][a-zA-Z0-9-]*)?(?:\[\s*([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+)))?\s*\])?$/);
  if (!matched) {
    return {
      valid: false,
      reason: 'Invalid selector syntax',
    };
  }
  const tagName = matched[1] ? matched[1].toLowerCase() : null;
  const attributeName = matched[2] ? matched[2].toLowerCase() : null;
  let attributeValue = null;
  if (typeof matched[3] !== 'undefined') {
    attributeValue = matched[3];
  }
  else if (typeof matched[4] !== 'undefined') {
    attributeValue = matched[4];
  }
  else if (typeof matched[5] !== 'undefined') {
    attributeValue = matched[5];
  }
  if (!tagName && !attributeName) {
    return {
      valid: false,
      reason: 'Selector must include at least a tag or attribute',
    };
  }
  let normalizedSelector = '';
  if (tagName) {
    normalizedSelector += tagName;
  }
  if (attributeName) {
    normalizedSelector += `[${attributeName}`;
    if (attributeValue !== null) {
      normalizedSelector += `="${attributeValue}"]`;
    }
    else {
      normalizedSelector += ']';
    }
  }
  return {
    valid: true,
    selector: normalizedSelector,
  };
}

function selectorMatchesInContent(content, selector) {
  if (!content || !selector) {
    return null;
  }
  const root = parse(`<div id="hax-search-wrapper">${content}</div>`);
  const nodes = root.querySelectorAll(selector);
  if (!nodes || nodes.length === 0) {
    return null;
  }
  const snippets = [];
  for (let i = 0; i < nodes.length && i < 3; i++) {
    let snippet = '';
    if (typeof nodes[i].toString === 'function') {
      snippet = nodes[i].toString();
    }
    snippet = String(snippet || '').replace(/\s+/g, ' ').trim();
    if (snippet.length > 180) {
      snippet = `${snippet.slice(0, 177)}...`;
    }
    snippets.push(snippet);
  }
  return {
    count: nodes.length,
    snippets,
  };
}

function buildSearchResponse({
  searchTerm = '',
  searchFields = [],
  mode = 'text',
  caseSensitive = false,
  searchLimit = SITE_SEARCH_DEFAULT_LIMIT,
  matches = [],
} = {}) {
  return {
    status: 200,
    data: {
      query: searchTerm,
      fields: searchFields,
      mode,
      caseSensitive,
      limit: searchLimit,
      total: matches.length,
      matches,
    },
  };
}

/**
 * @OA\Get(
 *    path="/siteSearch",
 *    tags={"hax","authenticated","site"},
 *    @OA\Parameter(
 *         name="site_token",
 *         description="Site-specific validation token",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Parameter(
 *         name="siteName",
 *         description="Name of the site to search",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Parameter(
 *         name="search",
 *         description="Search query string",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Search site content and metadata fields"
 *   )
 * )
 */
async function siteSearch(req, res) {
  const requestBody = req && req.body && typeof req.body === 'object'
    ? req.body
    : {};
  const siteName = requestBody.site &&
    typeof requestBody.site === 'object' &&
    typeof requestBody.site.name === 'string'
    ? requestBody.site.name.trim()
    : '';
  if (
    !req.query.site_token ||
    !siteName ||
    !HAXCMS.validateRequestToken(req.query.site_token, `${HAXCMS.getActiveUserName()}:${siteName}`)
  ) {
    return res.sendStatus(403);
  }
  const searchTerm = typeof requestBody.search === 'string'
    ? requestBody.search.trim()
    : '';
  if (!searchTerm) {
    return res.status(400).send({
      status: 400,
      message: 'Search query is required',
    });
  }
  if (searchTerm.length > SITE_SEARCH_MAX_QUERY_LENGTH) {
    return res.status(400).send({
      status: 400,
      message: `Search query is too long (max ${SITE_SEARCH_MAX_QUERY_LENGTH} characters)`,
    });
  }

  const selectorMode = parseBooleanValue(requestBody.searchSelector) ||
    (typeof requestBody.searchMode === 'string' && requestBody.searchMode.toLowerCase() === 'selector');
  const searchLimit = parseLimitValue(requestBody.searchLimit, SITE_SEARCH_DEFAULT_LIMIT);
  const caseSensitive = parseBooleanValue(requestBody.searchCaseSensitive);
  const searchFields = selectorMode ? ['content'] : normalizeSearchFields(requestBody.searchField);
  const mode = selectorMode ? 'selector' : 'text';

  let selectorData = null;
  if (selectorMode) {
    selectorData = parseSimpleSelector(searchTerm);
    if (!selectorData.valid) {
      return res.status(400).send({
        status: 400,
        message: selectorData.reason,
      });
    }
  }

  const site = await HAXCMS.loadSite(siteName);
  const defaultResponse = buildSearchResponse({
    searchTerm,
    searchFields,
    mode,
    caseSensitive,
    searchLimit,
    matches: [],
  });
  if (
    !site ||
    !site.manifest ||
    !site.manifest.items ||
    typeof site.manifest.orderTree !== 'function'
  ) {
    return res.send(defaultResponse);
  }

  const textMatcher = buildTextMatcher(searchTerm, caseSensitive);
  const orderedItems = site.manifest.orderTree(site.manifest.items);
  const contentCache = {};
  const matches = [];
  for (const item of orderedItems) {
    if (searchLimit > 0 && matches.length >= searchLimit) {
      break;
    }
    const fieldMatches = [];
    for (const field of searchFields) {
      let content = '';
      if (field === 'content') {
        if (item && item.id && typeof contentCache[item.id] !== 'undefined') {
          content = contentCache[item.id];
        }
        else if (item && item.id) {
          const page = site.loadNode(item.id);
          if (page) {
            content = await site.getPageContent(page);
          }
          if (typeof content !== 'string') {
            content = '';
          }
          contentCache[item.id] = content;
        }
      }
      const fieldValue = normalizeFieldValue(field, item, content);
      if (selectorMode) {
        try {
          const selectorMatch = selectorMatchesInContent(fieldValue, selectorData.selector);
          if (selectorMatch) {
            fieldMatches.push({
              field: 'content',
              type: 'selector',
              selector: selectorData.selector,
              count: selectorMatch.count,
              snippets: selectorMatch.snippets,
            });
          }
        }
        catch (e) {
          return res.status(400).send({
            status: 400,
            message: 'Invalid selector query',
          });
        }
      }
      else {
        const textMatch = textMatcher(fieldValue);
        if (textMatch) {
          fieldMatches.push({
            field,
            type: 'text',
            index: textMatch.index,
            length: textMatch.length,
            snippet: textMatch.snippet,
          });
        }
      }
    }
    if (fieldMatches.length > 0) {
      matches.push({
        id: item && item.id ? item.id : null,
        title: item && item.title ? item.title : '',
        slug: item && item.slug ? item.slug : '',
        location: item && item.location ? item.location : '',
        parent: item && item.parent ? item.parent : null,
        description: item && item.description ? item.description : '',
        tags: normalizeTagsValue(item),
        matches: fieldMatches,
      });
    }
  }

  return res.send(
    buildSearchResponse({
      searchTerm,
      searchFields,
      mode,
      caseSensitive,
      searchLimit,
      matches,
    }),
  );
}

module.exports = siteSearch;
