const { parse } = require('node-html-parser');
const { HAXCMS } = require('../../../lib/HAXCMS.js');
const { sanitizeHTMLForStorage } = require('../../../lib/sanitizeContent.js');

const SITE_SEARCH_DEFAULT_FIELDS = ['title', 'slug', 'description', 'tags', 'content'];
const SITE_SEARCH_ALLOWED_FIELDS = ['id', 'title', 'slug', 'description', 'tags', 'content', 'location', 'parent'];
const SITE_SEARCH_DEFAULT_LIMIT = 25;
const SITE_SEARCH_MAX_LIMIT = 200;
const SITE_SEARCH_MAX_QUERY_LENGTH = 256;
const SITE_SEARCH_OPERATION_SEARCH = 'search';
const SITE_SEARCH_OPERATION_REPLACE = 'replace';
const SITE_SEARCH_ALLOWED_OPERATIONS = [
  SITE_SEARCH_OPERATION_SEARCH,
  SITE_SEARCH_OPERATION_REPLACE,
];

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

function countTextMatches(value, searchTerm, caseSensitive = false) {
  if (typeof value !== 'string' || value.length === 0) {
    return 0;
  }
  if (typeof searchTerm !== 'string' || searchTerm.length === 0) {
    return 0;
  }
  const comparisonValue = caseSensitive ? value : value.toLowerCase();
  const comparisonSearch = caseSensitive ? searchTerm : searchTerm.toLowerCase();
  let total = 0;
  let startAt = 0;
  let foundAt = comparisonValue.indexOf(comparisonSearch, startAt);
  while (foundAt !== -1) {
    total++;
    startAt = foundAt + comparisonSearch.length;
    foundAt = comparisonValue.indexOf(comparisonSearch, startAt);
  }
  return total;
}

function replaceTextMatches(value, searchTerm, replacement, caseSensitive = false) {
  if (typeof value !== 'string' || value.length === 0) {
    return {
      content: '',
      total: 0,
    };
  }
  if (typeof searchTerm !== 'string' || searchTerm.length === 0) {
    return {
      content: value,
      total: 0,
    };
  }
  if (caseSensitive) {
    const total = countTextMatches(value, searchTerm, true);
    return {
      content: value.split(searchTerm).join(replacement),
      total,
    };
  }
  const source = String(value);
  const sourceLower = source.toLowerCase();
  const searchLower = String(searchTerm).toLowerCase();
  let foundAt = sourceLower.indexOf(searchLower, 0);
  let cursor = 0;
  let total = 0;
  let output = '';
  while (foundAt !== -1) {
    output += source.slice(cursor, foundAt);
    output += replacement;
    cursor = foundAt + searchTerm.length;
    total++;
    foundAt = sourceLower.indexOf(searchLower, cursor);
  }
  output += source.slice(cursor);
  return {
    content: output,
    total,
  };
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


function normalizeOperationValue(value) {
  if (typeof value !== 'string') {
    return SITE_SEARCH_OPERATION_SEARCH;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || !SITE_SEARCH_ALLOWED_OPERATIONS.includes(normalized)) {
    return SITE_SEARCH_OPERATION_SEARCH;
  }
  return normalized;
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

function parseSimpleSelectorPart(selectorPart) {
  const selector = String(selectorPart || '').trim();
  if (!selector) {
    return {
      valid: false,
      reason: 'Selector query is required',
    };
  }
  if (
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

function parseSimpleSelector(selectorString) {
  const rawSelector = String(selectorString || '').trim();
  if (!rawSelector) {
    return {
      valid: false,
      reason: 'Selector query is required',
    };
  }
  const parts = rawSelector.split(',').map((part) => part.trim());
  const normalizedParts = [];
  for (const part of parts) {
    if (!part) {
      return {
        valid: false,
        reason: 'Selector groups cannot be empty',
      };
    }
    const parsed = parseSimpleSelectorPart(part);
    if (!parsed.valid) {
      return parsed;
    }
    normalizedParts.push(parsed.selector);
  }
  return {
    valid: true,
    selector: normalizedParts.join(', '),
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
  operation = SITE_SEARCH_OPERATION_SEARCH,
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
      operation,
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
  const operation = normalizeOperationValue(requestBody.operation);
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
  if (operation === SITE_SEARCH_OPERATION_REPLACE && searchTerm.length <= 1) {
    return res.status(400).send({
      status: 400,
      message: 'Search text must be more than 1 character for replacement operations',
    });
  }

  const selectorMode = operation !== SITE_SEARCH_OPERATION_REPLACE && (
    parseBooleanValue(requestBody.searchSelector) ||
    (typeof requestBody.searchMode === 'string' && requestBody.searchMode.toLowerCase() === 'selector')
  );
  const searchLimit = parseLimitValue(requestBody.searchLimit, SITE_SEARCH_DEFAULT_LIMIT);
  const caseSensitive = parseBooleanValue(requestBody.searchCaseSensitive);
  const searchFields = operation === SITE_SEARCH_OPERATION_REPLACE
    ? ['content']
    : (selectorMode ? ['content'] : normalizeSearchFields(requestBody.searchField));
  const mode = operation === SITE_SEARCH_OPERATION_REPLACE
    ? 'replace'
    : (selectorMode ? 'selector' : 'text');
  let replacement = '';
  if (operation === SITE_SEARCH_OPERATION_REPLACE) {
    replacement = typeof requestBody.replace === 'string'
      ? requestBody.replace.trim()
      : '';
    if (replacement.length === 1) {
      return res.status(400).send({
        status: 400,
        message: 'Replacement text must be empty or more than 1 character',
      });
    }
    if (!parseBooleanValue(requestBody.replaceConfirm)) {
      return res.status(400).send({
        status: 400,
        message: 'Replacement requires confirmation',
      });
    }
    if (replacement === '' && !parseBooleanValue(requestBody.replaceDestroyConfirm)) {
      return res.status(400).send({
        status: 400,
        message: 'Removing matched text requires a second confirmation',
      });
    }
  }

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
    operation,
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

  const orderedItems = site.manifest.orderTree(site.manifest.items);
  if (operation === SITE_SEARCH_OPERATION_REPLACE) {
    let totalMatches = 0;
    let updatedItems = 0;
    let totalReplacements = 0;
    const changedItems = [];
    for (const item of orderedItems) {
      if (!item || !item.id) {
        continue;
      }
      const page = site.loadNode(item.id);
      if (!page) {
        continue;
      }
      let content = await site.getPageContent(page);
      if (typeof content !== 'string') {
        content = '';
      }
      const replacementData = replaceTextMatches(
        content,
        searchTerm,
        replacement,
        caseSensitive,
      );
      if (replacementData.total < 1) {
        continue;
      }
      totalMatches += replacementData.total;
      const sanitizedContent = sanitizeHTMLForStorage(replacementData.content);
      const writeResult = await page.writeLocation(sanitizedContent, site.siteDirectory);
      if (!writeResult) {
        continue;
      }
      updatedItems++;
      totalReplacements += replacementData.total;
      page.metadata = page.metadata && typeof page.metadata === 'object'
        ? page.metadata
        : {};
      page.metadata.updated = Math.floor(Date.now() / 1000);
      changedItems.push({
        id: item.id,
        title: item.title || '',
        slug: item.slug || '',
        replacements: replacementData.total,
      });
      try {
        await site.writePageAlternateFormats(page, sanitizedContent);
      }
      catch (e) {}
    }
    if (totalMatches < 1) {
      return res.status(400).send({
        status: 400,
        message: 'Search term not found in site content',
      });
    }
    if (updatedItems < 1) {
      return res.status(500).send({
        status: 500,
        message: 'No pages could be updated',
      });
    }
    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
    await site.manifest.save();
    await site.updateAlternateFormats();
    const commitReplacement = replacement === '' ? '[removed]' : replacement;
    await site.gitCommit(
      `Bulk replace "${searchTerm}" -> "${commitReplacement}" across ${updatedItems} page${updatedItems === 1 ? '' : 's'}`,
    );
    return res.send({
      status: 200,
      data: {
        operation: SITE_SEARCH_OPERATION_REPLACE,
        query: searchTerm,
        replace: replacement,
        caseSensitive,
        total: totalMatches,
        updatedItems,
        totalReplacements,
        items: changedItems,
      },
    });
  }
  const textMatcher = buildTextMatcher(searchTerm, caseSensitive);
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
      operation,
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
