const { parse } = require('node-html-parser');
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
  getSiteBasePath,
  getSiteLanguage,
  toIsoDateFromUnixTime,
  isItemVisibleToAnonymous,
  isAnonymousSiteApiRequest,
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
    if (typeof nav.previous === 'string' && nav.previous !== '') {
      links.previous = nav.previous;
    }
    else if (Object.prototype.hasOwnProperty.call(links, 'previous')) {
      delete links.previous;
    }
    if (typeof nav.next === 'string' && nav.next !== '') {
      links.next = nav.next;
    }
    else if (Object.prototype.hasOwnProperty.call(links, 'next')) {
      delete links.next;
    }
    if (typeof nav.parent === 'string' && nav.parent !== '') {
      links.parent = nav.parent;
    }
    else if (Object.prototype.hasOwnProperty.call(links, 'parent')) {
      delete links.parent;
    }
    if (typeof nav.children === 'string' && nav.children !== '') {
      links.children = nav.children;
    }
    else if (Object.prototype.hasOwnProperty.call(links, 'children')) {
      delete links.children;
    }
    return {
      ...record,
      links,
    };
  });
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

function buildItemEndpointLinks(apiBasePath = '/x/api', itemLookupValue = '') {
  const encodedLookupValue = encodeURIComponent(String(itemLookupValue || ''));
  return {
    exportDocx: `${apiBasePath}/v1/items/${encodedLookupValue}/export/docx`,
    exportPdf: `${apiBasePath}/v1/items/${encodedLookupValue}/export/pdf`,
    haxElementSchema: `${apiBasePath}/v1/items/${encodedLookupValue}?include=haxElementSchema`,
    jsonld: `${apiBasePath}/v1/items/${encodedLookupValue}?include=jsonld`,
  };
}

function buildItemJsonLd(record, siteBasePath = '/', siteLanguage = 'en') {
  const itemSlug = record && record.slug ? String(record.slug) : '';
  const itemId = record && record.id ? String(record.id) : '';
  const canonicalPagePath = buildCanonicalPagePath(siteBasePath, itemSlug || itemId);
  const metadata =
    record && record.metadata && typeof record.metadata === 'object'
      ? record.metadata
      : {};
  const createdIso = toIsoDateFromUnixTime(metadata.created);
  const updatedIso = toIsoDateFromUnixTime(metadata.updated);
  const itemTitle =
    record && record.title
      ? String(record.title)
      : itemSlug !== ''
        ? itemSlug
        : itemId;
  const itemDescription =
    record && record.description ? String(record.description) : '';
  const itemSelfLink =
    record && record.links && record.links.self
      ? String(record.links.self)
      : canonicalPagePath;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${itemSelfLink}#webpage`,
    url: itemSelfLink,
    mainEntityOfPage: canonicalPagePath,
    name: itemTitle,
    description: itemDescription,
    inLanguage: siteLanguage,
  };
  if (itemId !== '') {
    jsonLd.identifier = itemId;
  }
  if (Array.isArray(record && record.tags ? record.tags : [])) {
    jsonLd.keywords = record.tags;
  }
  if (createdIso !== null) {
    jsonLd.datePublished = createdIso;
  }
  if (updatedIso !== null) {
    jsonLd.dateModified = updatedIso;
  }
  return jsonLd;
}

function buildHaxElementSchemaNode(node) {
  const tagName = String(node && node.tagName ? node.tagName : '')
    .trim()
    .toLowerCase();
  const properties = {};
  if (node && node.attributes && typeof node.attributes === 'object') {
    const attributeNames = Object.keys(node.attributes);
    for (let i = 0; i < attributeNames.length; i++) {
      const attributeName = attributeNames[i];
      const attributeValue = node.getAttribute(attributeName);
      properties[attributeName] = attributeValue === null ? true : attributeValue;
    }
  }
  return {
    tag: tagName,
    properties,
    content: node && node.innerHTML ? String(node.innerHTML) : '',
  };
}

function buildHaxElementSchemaFromHtml(html = '') {
  const source = String(html || '').trim();
  if (source === '') {
    return [];
  }
  const root = parse(`<div data-hax-element-schema-root>${source}</div>`);
  const wrapper = root.querySelector('div[data-hax-element-schema-root]');
  if (!wrapper || !Array.isArray(wrapper.childNodes)) {
    return [];
  }
  const schema = [];
  for (let i = 0; i < wrapper.childNodes.length; i++) {
    const node = wrapper.childNodes[i];
    if (!node || !node.tagName) {
      continue;
    }
    const nodeSchema = buildHaxElementSchemaNode(node);
    if (nodeSchema.tag !== '') {
      schema.push(nodeSchema);
    }
  }
  return schema;
}

function appendItemEndpointLinks(
  record,
  apiBasePath = '/x/api',
  siteBasePath = '/',
  siteLanguage = 'en',
  includeJsonLd = false,
) {
  if (!record || typeof record !== 'object') {
    return record;
  }
  const itemLookupValue = getItemLookupValue(record);
  if (itemLookupValue === '') {
    return record;
  }
  const endpointLinks = buildItemEndpointLinks(apiBasePath, itemLookupValue);
  const links =
    record.links && typeof record.links === 'object' ? { ...record.links } : {};
  links.exportDocx = endpointLinks.exportDocx;
  links.exportPdf = endpointLinks.exportPdf;
  links.haxElementSchema = endpointLinks.haxElementSchema;
  links.jsonld = endpointLinks.jsonld;
  const hydratedRecord = {
    ...record,
    links,
    exports: {
      docx: endpointLinks.exportDocx,
      pdf: endpointLinks.exportPdf,
    },
  };
  if (includeJsonLd) {
    hydratedRecord.jsonld = buildItemJsonLd(
      hydratedRecord,
      siteBasePath,
      siteLanguage,
    );
  }
  return hydratedRecord;
}

async function appendRequestedItemIncludes(
  site,
  items,
  includes = [],
  apiBasePath = '/x/api',
) {
  const includeContent = includes.indexOf('content') !== -1;
  const includeHaxElementSchema = includes.indexOf('haxElementSchema') !== -1;
  const includeJsonLd = includes.indexOf('jsonld') !== -1;
  const siteBasePath = getSiteBasePath(site);
  const siteLanguage = getSiteLanguage(site);
  const hydrated = [];
  for (let i = 0; i < items.length; i++) {
    const record = items[i];
    let hydratedRecord = appendItemEndpointLinks(
      record,
      apiBasePath,
      siteBasePath,
      siteLanguage,
      includeJsonLd,
    );
    if (includeContent || includeHaxElementSchema) {
      const item = findItemByIdOrSlug(site, record.id || record.slug);
      const content = await getItemContent(site, item);
      if (includeContent) {
        hydratedRecord.content = content;
      }
      if (includeHaxElementSchema) {
        hydratedRecord.haxElementSchema = buildHaxElementSchemaFromHtml(content);
      }
    }
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
  const filteredItems = applyItemFilters(orderedItems, req, site, {
    enforceAnonymousVisibility: true,
  });
  let records = filteredItems.map((item) => itemToSummary(item, apiBasePath));
  records = appendItemNavigationLinks(records, navigationMap);
  records = await appendRequestedItemIncludes(site, records, includes, apiBasePath);
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
  if (
    isAnonymousSiteApiRequest(req) &&
    !isItemVisibleToAnonymous(item)
  ) {
    return res.status(404).json({
      status: 404,
      message: `Item not found for idOrSlug "${idOrSlug}"`,
    });
  }
  const apiBasePath = getApiBasePath(req);
  const includes = getCsvQuery(req, 'include');
  const includesWithJsonLd = [...includes];
  if (includesWithJsonLd.indexOf('jsonld') === -1) {
    includesWithJsonLd.push('jsonld');
  }
  const fields = getCsvQuery(req, 'fields');
  const navigationMap = buildItemNavigationMap(getOrderedItems(site), apiBasePath);
  let record = itemToSummary(item, apiBasePath);
  record = appendItemNavigationLinks([record], navigationMap)[0];
  record = (
    await appendRequestedItemIncludes(
      site,
      [record],
      includesWithJsonLd,
      apiBasePath,
    )
  )[0];
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
