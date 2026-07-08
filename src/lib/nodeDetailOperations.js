const stripTagsImport = require('locutus/php/strings/strip_tags');
const strip_tags = stripTagsImport.strip_tags || stripTagsImport;
const { HAXCMS } = require('./HAXCMS.js');
const {
  sanitizeURLValue,
  sanitizeMetadataValue
} = require('./sanitizeContent.js');
const {
  platformAllows,
} = require('./platformFeatures.js');

const PAGE_DETAIL_OPERATIONS = new Set([
  'setTitle',
  'setDescription',
  'setTags',
  'setIcon',
  'setMedia',
  'setImage',
  'setRelatedItems',
  'setLocked',
  'setPublished',
  'setHideInMenu',
]);

function createStatusError(status = 500, message = 'Unable to complete node operation', options = {}) {
  const statusError = new Error(message);
  statusError.status = status;
  if (options.featureDisabled === true) {
    statusError.featureDisabled = true;
  }
  return statusError;
}

function sameParent(a, b) {
  const parentA = a.parent !== undefined ? a.parent : null;
  const parentB = b.parent !== undefined ? b.parent : null;
  return parentA === parentB;
}

function findSiblingByOrder(siblings = [], order = null) {
  if (order === null || typeof order === 'undefined') {
    return null;
  }
  return (
    siblings.find(
      (sibling) =>
        sibling &&
        sibling.order !== undefined &&
        parseInt(sibling.order) === parseInt(order),
    ) || null
  );
}

function getLastChildOrder(items = [], parentId = null) {
  let max = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const parentValue = item.parent !== undefined ? item.parent : null;
    if (parentValue === parentId && item.order !== undefined) {
      const orderValue = parseInt(item.order);
      if (orderValue > max) {
        max = orderValue;
      }
    }
  }
  return max;
}

function normalizeOperation(operationValue) {
  if (typeof operationValue === 'string') {
    const cleanOperation = operationValue.trim();
    if (cleanOperation !== '') {
      return cleanOperation;
    }
  }
  return null;
}

function ensureMetadataObject(page) {
  if (!page.metadata || typeof page.metadata !== 'object') {
    page.metadata = {};
  }
}

function isPathautoEnabled(site) {
  return (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.settings &&
    site.manifest.metadata.site.settings.pathauto === true
  );
}

function isOverridePathauto(page) {
  return page && page.metadata && page.metadata.overridePathauto === true;
}

function cascadeSlugUpdates(site, items, changedIds) {
  let keepGoing = true;
  while (keepGoing) {
    keepGoing = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (
        item &&
        item.parent &&
        changedIds.indexOf(item.parent) !== -1 &&
        changedIds.indexOf(item.id) === -1
      ) {
        const childOverride = isOverridePathauto(item);
        if (!childOverride) {
          const childCleanTitle = HAXCMS.cleanTitle(item.title);
          item.slug = site.getUniqueSlugName(childCleanTitle, item, true);
          changedIds.push(item.id);
          keepGoing = true;
        }
      }
    }
  }
}

function applyMetadataMutation(page, details = {}, operation = null, site = null, items = null) {
  switch (operation) {
    case 'setTitle':
      if (
        Object.prototype.hasOwnProperty.call(details, 'title') &&
        details.title !== ''
      ) {
        page.title = strip_tags(details.title);
        // If pathauto is on and overridePathauto is not set, regenerate the slug and cascade
        if (isPathautoEnabled(site) && !isOverridePathauto(page)) {
          const cleanTitle = HAXCMS.cleanTitle(page.title);
          page.slug = site.getUniqueSlugName(cleanTitle, page, true);
          if (items) {
            site.manifest.items = items;
            cascadeSlugUpdates(site, items, [page.id]);
          }
        }
      }
      break;
    case 'setDescription':
      if (Object.prototype.hasOwnProperty.call(details, 'description')) {
        if (details.description !== '') {
          page.description = strip_tags(details.description);
        }
        else {
          page.description = '';
        }
      }
      break;
    case 'setTags':
      ensureMetadataObject(page);
      if (Object.prototype.hasOwnProperty.call(details, 'tags')) {
        if (details.tags !== '' && details.tags !== null) {
          page.metadata.tags = sanitizeMetadataValue(details.tags);
        }
        else {
          delete page.metadata.tags;
        }
      }
      break;
    case 'setIcon':
      ensureMetadataObject(page);
      if (Object.prototype.hasOwnProperty.call(details, 'icon')) {
        if (details.icon !== '' && details.icon !== null) {
          page.metadata.icon = sanitizeMetadataValue(details.icon);
        }
        else {
          delete page.metadata.icon;
        }
      }
      break;
    case 'setMedia':
    case 'setImage':
      ensureMetadataObject(page);
      let imageValue = null;
      if (Object.prototype.hasOwnProperty.call(details, 'image')) {
        imageValue = details.image;
      }
      else if (Object.prototype.hasOwnProperty.call(details, 'media')) {
        imageValue = details.media;
      }
      if (imageValue !== null) {
        if (imageValue !== '' && imageValue !== undefined) {
          page.metadata.image = sanitizeURLValue(imageValue, '');
        }
        else {
          delete page.metadata.image;
        }
      }
      break;
    case 'setRelatedItems':
      ensureMetadataObject(page);
      if (Object.prototype.hasOwnProperty.call(details, 'relatedItems')) {
        if (details.relatedItems !== '' && details.relatedItems !== null) {
          page.metadata.relatedItems = sanitizeMetadataValue(details.relatedItems);
        }
        else {
          delete page.metadata.relatedItems;
        }
      }
      break;
    case 'setLocked':
      ensureMetadataObject(page);
      if (Object.prototype.hasOwnProperty.call(details, 'locked')) {
        page.metadata.locked = Boolean(details.locked);
      }
      break;
    case 'setPublished':
      ensureMetadataObject(page);
      if (Object.prototype.hasOwnProperty.call(details, 'published')) {
        page.metadata.published = Boolean(details.published);
      }
      break;
    case 'setHideInMenu':
      ensureMetadataObject(page);
      if (Object.prototype.hasOwnProperty.call(details, 'hideInMenu')) {
        page.metadata.hideInMenu = Boolean(details.hideInMenu);
      }
      break;
    case 'setSlug':
      if (
        Object.prototype.hasOwnProperty.call(details, 'slug') &&
        details.slug !== ''
      ) {
        let newSlug = details.slug;
        if (newSlug === 'x') {
          newSlug = 'x-x';
        }
        if (newSlug.substring(0, 2) === 'x/') {
          newSlug = newSlug.replace('x/', 'x-x/');
        }
        page.slug = HAXCMS.generateSlugName(newSlug);
        // When user manually sets a slug, mark it as overridden so pathauto won't overwrite it
        ensureMetadataObject(page);
        page.metadata.overridePathauto = true;
      }
      break;
    case 'setOverridePathauto':
      ensureMetadataObject(page);
      if (Object.prototype.hasOwnProperty.call(details, 'overridePathauto')) {
        page.metadata.overridePathauto = Boolean(details.overridePathauto);
      }
      break;
    default:
      break;
  }
}

function applyOutlineMutation(site, page, items = [], details = {}, operation = null) {
  const siblings = items.filter((item) => sameParent(item, page));
  switch (operation) {
    case 'moveUp':
      if (page.order !== undefined && parseInt(page.order) > 0) {
        const other = findSiblingByOrder(siblings, parseInt(page.order) - 1);
        if (other && other.id !== page.id) {
          other.order = parseInt(other.order) + 1;
          page.order = parseInt(page.order) - 1;
        }
      }
      break;
    case 'moveDown':
      if (page.order !== undefined) {
        const other = findSiblingByOrder(siblings, parseInt(page.order) + 1);
        if (other && other.id !== page.id) {
          other.order = parseInt(other.order) - 1;
          page.order = parseInt(page.order) + 1;
        }
      }
      break;
    case 'indent':
      if (page.order !== undefined) {
        const previous = findSiblingByOrder(siblings, parseInt(page.order) - 1);
        if (previous) {
          page.parent = previous.id;
          page.indent =
            previous.indent !== undefined ? parseInt(previous.indent) + 1 : 1;
          page.order = getLastChildOrder(items, previous.id) + 1;
        }
      }
      break;
    case 'outdent':
      if (page.parent !== undefined && page.parent !== null) {
        const parentNode = site.loadNode(page.parent);
        const newParent = parentNode ? parentNode.parent : null;
        const insertAfterOrder =
          parentNode && parentNode.order !== undefined
            ? parseInt(parentNode.order) + 1
            : 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const parentValue = item.parent !== undefined ? item.parent : null;
          if (
            parentValue === newParent &&
            item.order !== undefined &&
            parseInt(item.order) >= insertAfterOrder
          ) {
            item.order = parseInt(item.order) + 1;
          }
        }
        page.parent = newParent;
        page.indent =
          page.indent !== undefined ? Math.max(parseInt(page.indent) - 1, 0) : 0;
        page.order = insertAfterOrder;
      }
      break;
    case 'setParent':
      let newParent = Object.prototype.hasOwnProperty.call(details, 'parent')
        ? details.parent
        : null;
      const newOrder = Object.prototype.hasOwnProperty.call(details, 'order')
        ? parseInt(details.order)
        : 0;
      if (!newParent || newParent === '') {
        newParent = null;
      }
      page.parent = newParent;
      page.order = newOrder;
      if (newParent === null) {
        page.indent = 0;
      }
      else {
        const parentNode = site.loadNode(newParent);
        page.indent =
          parentNode && parentNode.indent !== undefined
            ? parseInt(parentNode.indent) + 1
            : 1;
      }
      // If pathauto is on and overridePathauto is not set, regenerate the slug and cascade
      if (isPathautoEnabled(site) && !isOverridePathauto(page)) {
        const cleanTitle = HAXCMS.cleanTitle(page.title);
        page.slug = site.getUniqueSlugName(cleanTitle, page, true);
        if (items) {
          site.manifest.items = items;
          cascadeSlugUpdates(site, items, [page.id]);
        }
      }
      break;
    default:
      break;
  }
}

async function applyNodeDetailOperation(site, nodeId, details = {}) {
  if (!site || !site.manifest || !Array.isArray(site.manifest.items)) {
    throw createStatusError(404, 'Unable to resolve site context');
  }

  const normalizedNodeId = String(nodeId || '').trim();
  if (normalizedNodeId === '') {
    throw createStatusError(400, 'Missing node id');
  }

  const operation = normalizeOperation(details.operation);

  if (!platformAllows(site, 'outlineDesigner')) {
    throw createStatusError(
      403,
      'Outline operations are disabled for this site',
      { featureDisabled: true },
    );
  }

  if (PAGE_DETAIL_OPERATIONS.has(operation) && !platformAllows(site, 'pageBreak')) {
    throw createStatusError(
      403,
      'Page details editing is disabled for this site',
      { featureDisabled: true },
    );
  }

  const page = site.loadNode(normalizedNodeId);
  if (!page) {
    throw createStatusError(404, 'Node not found');
  }

  const originalItemCount = site.manifest.items.length;
  const items = site.manifest.items;

  applyOutlineMutation(site, page, items, details, operation);
  applyMetadataMutation(page, details, operation, site, items);

  site.manifest.items = items;
  if (site.manifest.items.length !== originalItemCount) {
    throw createStatusError(
      500,
      `Item count mismatch: expected ${originalItemCount} but got ${site.manifest.items.length}. Operation aborted to prevent data loss.`,
    );
  }

  site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
  await site.manifest.save(false);
  await site.updateAlternateFormats();
  await site.gitCommit(`Node operation: ${operation} on ${page.title} (${page.id})`);

  const updatedNode = site.loadNode(page.id);
  return {
    operation,
    item: updatedNode,
  };
}

module.exports = {
  applyNodeDetailOperation,
  PAGE_DETAIL_OPERATIONS,
  createStatusError,
};
