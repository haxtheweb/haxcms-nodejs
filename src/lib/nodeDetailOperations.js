const stripTagsImport = require('locutus/php/strings/strip_tags');
const strip_tags = stripTagsImport.strip_tags || stripTagsImport;
const { HAXCMS } = require('./HAXCMS.js');
const { reserveSlugRoutes } = require('./slugRules.js');
const {
  sanitizeURLValue,
  sanitizeMetadataValue
} = require('./sanitizeContent.js');
const {
  platformAllows,
} = require('./platformFeatures.js');
const FileContentScanner = require('./FileContentScanner.js');

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

const {
  parentOf,
  orderOf,
  sortedSiblings,
  healSiblingOrder,
  makeRoomFor,
  lastSiblingOrder,
  syncIndentToDepth,
  isLocked,
} = require('./outlineUpkeep.js');

function createStatusError(status = 500, message = 'Unable to complete node operation', options = {}) {
  const statusError = new Error(message);
  statusError.status = status;
  if (options.featureDisabled === true) {
    statusError.featureDisabled = true;
  }
  if (typeof options.reason === 'string') {
    statusError.reason = options.reason;
  }
  return statusError;
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

/**
 * Re-slug every descendant of the pages in changedIds from its own title,
 * so a parent's new slug segment reaches the whole branch. A descendant with
 * overridePathauto keeps its slug, and so does its own branch. Shared by
 * saveNodeDetails (setTitle / setParent) and saveNode; mirrors the
 * $changedIds loop in haxcms-php saveNode.php / saveNodeDetails.php.
 */
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
    case 'setImage': {
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
    }
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
        // no segment may be the reserved "x" route
        page.slug = reserveSlugRoutes(HAXCMS.generateSlugName(details.slug));
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

const OUTLINE_OPERATIONS = new Set([
  'moveUp',
  'moveDown',
  'indent',
  'outdent',
  'setParent',
]);

/** Re-slug the page from its title under its current parent, then its branch. */
function reslugPageAndBranch(site, page, items) {
  if (isPathautoEnabled(site) && !isOverridePathauto(page)) {
    const cleanTitle = HAXCMS.cleanTitle(page.title);
    page.slug = site.getUniqueSlugName(cleanTitle, page, true);
    if (items) {
      site.manifest.items = items;
      cascadeSlugUpdates(site, items, [page.id]);
    }
  }
}

function applyOutlineMutation(
  site,
  page,
  items = [],
  details = {},
  operation = null,
) {
  if (!OUTLINE_OPERATIONS.has(operation)) {
    return;
  }
  // siblings that share an order value have no defined neighbour: settle the
  // page's group first so "the one above" and "the one below" mean something
  healSiblingOrder(items, parentOf(page));
  const siblings = sortedSiblings(items, parentOf(page));
  const position = siblings.indexOf(page);
  switch (operation) {
    case 'moveUp':
      if (position > 0) {
        const other = siblings[position - 1];
        const otherOrder = orderOf(other);
        other.order = orderOf(page);
        page.order = otherOrder;
      }
      break;
    case 'moveDown':
      if (position !== -1 && position < siblings.length - 1) {
        const other = siblings[position + 1];
        const otherOrder = orderOf(other);
        other.order = orderOf(page);
        page.order = otherOrder;
      }
      break;
    case 'indent':
      if (position > 0) {
        const previous = siblings[position - 1];
        page.parent = previous.id;
        page.order = getLastChildOrder(items, previous.id) + 1;
      }
      reslugPageAndBranch(site, page, items);
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
        page.order = insertAfterOrder;
      }
      reslugPageAndBranch(site, page, items);
      break;
    case 'setParent': {
      let newParent = Object.prototype.hasOwnProperty.call(details, 'parent')
        ? details.parent
        : null;
      if (!newParent || newParent === '') {
        newParent = null;
      }
      const requestedOrder = Object.prototype.hasOwnProperty.call(
        details,
        'order',
      )
        ? parseInt(details.order)
        : NaN;
      page.parent = newParent;
      if (Number.isFinite(requestedOrder)) {
        // the page takes the spot it asked for; whoever held it moves down
        page.order = requestedOrder;
        makeRoomFor(items, page);
      } else {
        // no order given: the page goes to the end of its new siblings
        page.order = lastSiblingOrder(items, newParent, page) + 1;
      }
      reslugPageAndBranch(site, page, items);
      break;
    }
    default:
      break;
  }
  // indent is the page's depth, for the moved page and the branch under it
  syncIndentToDepth(items);
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

  // a locked page is changed by nothing but unlocking it
  if (isLocked(page) && operation !== 'setLocked') {
    throw createStatusError(423, 'Page is locked', { reason: 'locked' });
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

  // #3043: rebuild page.metadata.files from a content path-scan so the
  // uuid set stays in sync (and legacy object-shape entries self-heal to
  // uuids on the next details save). Reads the current on-disk content.
  let pageContentForScan = '';
  if (site && typeof site.getPageContent === 'function') {
    try {
      pageContentForScan = String(await site.getPageContent(page) || '');
    } catch {
      pageContentForScan = '';
    }
  }
  await FileContentScanner.rebuildPageFilesUuids(site, page, pageContentForScan);

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
  isPathautoEnabled,
  cascadeSlugUpdates,
  reslugPageAndBranch,
};
