const { HAXCMS } = require('../lib/HAXCMS.js');
const strip_tags = require("locutus/php/strings/strip_tags");
const filter_var = require('../lib/filter_var.js');
/**
   * @OA\\Post(\n   *    path=\"/saveNodeDetails\",
   *    tags={\"cms\",\"authenticated\",\"node\"},
   *    @OA\\Parameter(\n   *         name=\"jwt\",
   *         description=\"JSON Web token, obtain by using  /login\",
   *         in=\"query\",
   *         required=true,
   *         @OA\\Schema(type=\"string\")\n   *    ),
   *    @OA\\Response(\n   *        response=\"200\",
   *        description=\"Perform a singular node operation: moveUp, moveDown, indent, outdent, setParent, setTitle, setDescription, setTags, setIcon, setMedia, setImage, setRelatedItems, setLocked, setPublished, setHideInMenu, setSlug\"\n   *   )\n   * )\n   */
async function saveNodeDetails(req, res) {
  if (req.query['site_token'] && HAXCMS.validateRequestToken(req.query['site_token'], HAXCMS.getActiveUserName() + ':' + req.body['site']['name'])) {
    const site = await HAXCMS.loadSite(req.body['site']['name']);

    // Check platform configuration
    const platformConfig = site.manifest.metadata && site.manifest.metadata.platform;
    const outlineAllowed = !platformConfig || platformConfig.outlineDesigner !== false;
    
    if (!outlineAllowed) {
      return res.send({
        '__failed': {
          'status': 403,
          'message': 'Outline operations are disabled for this site',
        }
      });
    }

    if (!req.body['node'] || !req.body['node']['id']) {
      return res.send({
        '__failed': {
          'status': 400,
          'message': 'Missing node id',
        }
      });
    }

    const operation = req.body['node']['details'] && req.body['node']['details']['operation'] 
      ? req.body['node']['details']['operation'] 
      : null;
    
    let page = site.loadNode(req.body['node']['id']);
    
    if (!page) {
      return res.send({
        '__failed': {
          'status': 404,
          'message': 'Node not found',
        }
      });
    }

    // Store original count for safety check
    const originalItemCount = site.manifest.items.length;
    const items = site.manifest.items;

    // Helper: Check if two nodes have same parent
    const sameParent = (a, b) => {
      const pa = a.parent !== undefined ? a.parent : null;
      const pb = b.parent !== undefined ? b.parent : null;
      return (pa === pb);
    };

    // Get siblings (items with same parent)
    const siblings = items.filter(it => sameParent(it, page));

    // Helper: find sibling by order within same parent
    const findSiblingByOrder = (order) => {
      return siblings.find(s => s.order !== undefined && parseInt(s.order) === parseInt(order)) || null;
    };

    // Helper: get last child order for a given parent id
    const lastChildOrder = (parentId) => {
      let max = -1;
      for (let it of items) {
        const p = it.parent !== undefined ? it.parent : null;
        if (p === parentId && it.order !== undefined) {
          const o = parseInt(it.order);
          if (o > max) { max = o; }
        }
      }
      return max;
    };

    switch (operation) {
      case 'moveUp':
        if (page.order !== undefined && parseInt(page.order) > 0) {
          const other = findSiblingByOrder(parseInt(page.order) - 1);
          if (other && other.id !== page.id) {
            other.order = parseInt(other.order) + 1;
            page.order = parseInt(page.order) - 1;
          }
        }
        break;
      
      case 'moveDown':
        if (page.order !== undefined) {
          const other = findSiblingByOrder(parseInt(page.order) + 1);
          if (other && other.id !== page.id) {
            other.order = parseInt(other.order) - 1;
            page.order = parseInt(page.order) + 1;
          }
        }
        break;
      
      case 'indent':
        if (page.order !== undefined) {
          const prev = findSiblingByOrder(parseInt(page.order) - 1);
          if (prev) {
            page.parent = prev.id;
            page.indent = prev.indent !== undefined ? (parseInt(prev.indent) + 1) : 1;
            page.order = lastChildOrder(prev.id) + 1;
          }
        }
        break;
      
      case 'outdent':
        if (page.parent !== undefined && page.parent !== null) {
          const parentNode = site.loadNode(page.parent);
          const newParent = parentNode ? parentNode.parent : null;
          const insertAfterOrder = parentNode && parentNode.order !== undefined 
            ? (parseInt(parentNode.order) + 1) 
            : 0;
          // shift siblings in new parent group to make space
          for (let it of items) {
            const p = it.parent !== undefined ? it.parent : null;
            if (p === newParent && it.order !== undefined && parseInt(it.order) >= insertAfterOrder) {
              it.order = parseInt(it.order) + 1;
            }
          }
          page.parent = newParent;
          page.indent = page.indent !== undefined ? Math.max(parseInt(page.indent) - 1, 0) : 0;
          page.order = insertAfterOrder;
        }
        break;
      
      case 'setParent':
        // Move page under a specific parent
        let newParent = req.body['node']['details'].hasOwnProperty('parent') 
          ? req.body['node']['details']['parent'] 
          : null;
        const newOrder = req.body['node']['details'].hasOwnProperty('order') 
          ? parseInt(req.body['node']['details']['order']) 
          : 0;
        // account for this being set to empty string which means null
        if (!newParent || newParent === '') {
          newParent = null;
        }
        // Update the page's parent and order
        page.parent = newParent;
        page.order = newOrder;
        // Calculate indent based on new parent depth
        if (newParent === null) {
          page.indent = 0;
        } else {
          const parentNode = site.loadNode(newParent);
          page.indent = parentNode && parentNode.indent !== undefined 
            ? (parseInt(parentNode.indent) + 1) 
            : 1;
        }
        break;
      
      // Singular field modification operations
      case 'setTitle':
        if (req.body['node']['details'].hasOwnProperty('title') && req.body['node']['details']['title'] !== '') {
          page.title = strip_tags(req.body['node']['details']['title']);
        }
        break;
      
      case 'setDescription':
        if (req.body['node']['details'].hasOwnProperty('description')) {
          if (req.body['node']['details']['description'] !== '') {
            page.description = strip_tags(req.body['node']['details']['description']);
          } else {
            page.description = '';
          }
        }
        break;
      
      case 'setTags':
        if (!page.metadata) {
          page.metadata = {};
        }
        if (req.body['node']['details'].hasOwnProperty('tags')) {
          if (req.body['node']['details']['tags'] !== '' && req.body['node']['details']['tags'] !== null) {
            page.metadata.tags = filter_var(req.body['node']['details']['tags'], 'FILTER_SANITIZE_STRING');
          } else {
            delete page.metadata.tags;
          }
        }
        break;
      
      case 'setIcon':
        if (!page.metadata) {
          page.metadata = {};
        }
        if (req.body['node']['details'].hasOwnProperty('icon')) {
          if (req.body['node']['details']['icon'] !== '' && req.body['node']['details']['icon'] !== null) {
            page.metadata.icon = filter_var(req.body['node']['details']['icon'], 'FILTER_SANITIZE_STRING');
          } else {
            delete page.metadata.icon;
          }
        }
        break;
      
      case 'setMedia':
      case 'setImage':
        if (!page.metadata) {
          page.metadata = {};
        }
        if (req.body['node']['details'].hasOwnProperty('image')) {
          if (req.body['node']['details']['image'] !== '' && req.body['node']['details']['image'] !== null) {
            page.metadata.image = filter_var(req.body['node']['details']['image'], 'FILTER_SANITIZE_URL');
          } else {
            delete page.metadata.image;
          }
        }
        break;
      
      case 'setRelatedItems':
        if (!page.metadata) {
          page.metadata = {};
        }
        if (req.body['node']['details'].hasOwnProperty('relatedItems')) {
          if (req.body['node']['details']['relatedItems'] !== '' && req.body['node']['details']['relatedItems'] !== null) {
            page.metadata.relatedItems = filter_var(req.body['node']['details']['relatedItems'], 'FILTER_SANITIZE_STRING');
          } else {
            delete page.metadata.relatedItems;
          }
        }
        break;
      
      case 'setLocked':
        if (!page.metadata) {
          page.metadata = {};
        }
        if (req.body['node']['details'].hasOwnProperty('locked')) {
          page.metadata.locked = Boolean(req.body['node']['details']['locked']);
        }
        break;
      
      case 'setPublished':
        if (!page.metadata) {
          page.metadata = {};
        }
        if (req.body['node']['details'].hasOwnProperty('published')) {
          page.metadata.published = Boolean(req.body['node']['details']['published']);
        }
        break;
      
      case 'setHideInMenu':
        if (!page.metadata) {
          page.metadata = {};
        }
        if (req.body['node']['details'].hasOwnProperty('hideInMenu')) {
          page.metadata.hideInMenu = Boolean(req.body['node']['details']['hideInMenu']);
        }
        break;
      
      case 'setSlug':
        // Limited case - allow modifying slug but validate it's unique
        if (req.body['node']['details'].hasOwnProperty('slug') && req.body['node']['details']['slug'] !== '') {
          let newSlug = req.body['node']['details']['slug'];
          // account for x being the only front end reserved route
          if (newSlug === 'x') {
            newSlug = 'x-x';
          }
          // same but trying to force a sub-route; paths cannot conflict with front end
          if (newSlug.substring(0, 2) === 'x/') {
            newSlug = newSlug.replace('x/', 'x-x/');
          }
          page.slug = HAXCMS.generateSlugName(newSlug);
        }
        break;
      
      default:
        break;
    }

    // Since loadNode returns a reference, page modifications already update the manifest
    site.manifest.items = items;
    
    // Safety check: ensure item count hasn't changed
    if (site.manifest.items.length !== originalItemCount) {
      return res.send({
        '__failed': {
          'status': 500,
          'message': `Item count mismatch: expected ${originalItemCount} but got ${site.manifest.items.length}. Operation aborted to prevent data loss.`,
        }
      });
    }
    
    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
    await site.manifest.save(false);
    await site.updateAlternateFormats();
    await site.gitCommit(`Node operation: ${operation} on ${page.title} (${page.id})`);

    const updated = site.loadNode(page.id);
    res.send({
      status: 200,
      data: updated,
    });
  }
  else {
    res.sendStatus(403);
  }
}

module.exports = saveNodeDetails;
