const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../../../lib/HAXCMS.js');
const JSONOutlineSchemaItem = require('../../../lib/JSONOutlineSchemaItem.js');
const { sanitizeHTMLForStorage } = require('../../../lib/sanitizeContent.js');
const { getRequestHeaderValue, assertSiteFeature } = require('../siteRouteUtils.js');
/**
   * @OA\Post(
   *    path="/saveOutline",
   *    tags={"cms","authenticated","site"},
   *    @OA\Parameter(
   *         name="jwt",
   *         description="JSON Web token, obtain by using  /login",
   *         in="query",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *    @OA\Response(
   *        response="200",
   *        description="Save an entire site outline"
   *   )
   * )
   */
  async function saveOutline(req, res) {
    const siteToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
    if (
      siteToken &&
      req.body &&
      req.body.site &&
      req.body.site.name &&
      HAXCMS.validateRequestToken(siteToken, HAXCMS.getActiveUserName() + ':' + req.body.site.name)
    ) {
      // items from the POST
      let site = await HAXCMS.loadSite(req.body['site']['name']);
      if (!assertSiteFeature(site, res, 'outlineDesigner', 'Outline operations are disabled for this site')) {
        return;
      }
      let original = [...site.manifest.items];
      let originalLocationMap = {};
      for (let originalKey in original) {
        let originalItem = original[originalKey];
        originalLocationMap[originalItem.id] = normalizeOutlineLocation(originalItem.location);
      }
      let safeLocationMap = {};
      let items = [...req.body['items']];
      let itemMap = {};
      let pageAlternateContentMap = {};
      var page, bytes, cleanTitle;
      // items from the POST
      for (var key in items) {
        let item = items[key];
        page = site.loadNode(item.id);
        // get a fake item of the existing
        if (!page) {
          page = HAXCMS.outlineSchema.newItem();
          // we don't trust the front end UUID if it wasn't existing already
          itemMap[item.id] = page.id;
        }
        // set a title if we have one
        if (item.title != '' && item.title) {
          page.title = item.title;
        }
        cleanTitle = HAXCMS.cleanTitle(page.title);
        if (item.parent == null) {
          page.parent = null;
          page.indent = 0;
        } else {
          // check the item map as backend dictates unique ID
          if (typeof itemMap[item.parent] !== 'undefined') {
            page.parent = itemMap[item.parent];
          } else {
            // set to the parent id
            page.parent = item.parent;
          }
          // move it one indentation below the parent; this can be changed later if desired
          page.indent = item.indent;
        }
        if (typeof item.order !== 'undefined') {
          page.order = parseInt(item.order);
        } else {
          page.order = parseInt(key);
        }
        // location is backend-controlled to prevent arbitrary writes
        if (originalLocationMap[page.id]) {
          page.location = originalLocationMap[page.id];
        } else {
          // generate a logical page slug
          page.location = 'pages/' + page.id + '/index.html';
        }
        // keep slug if we get one already, but sanitize/normalize it
        if (typeof item.slug !== 'undefined' && item.slug != '') {
          page.slug = normalizeOutlineSlug(site, item.slug, page, false);
        } else {
            // generate a logical page slug
            page.slug = normalizeOutlineSlug(site, cleanTitle, page, true);
        }
        // verify this exists, front end could have set what they wanted
        // or it could have just been renamed
        // if it doesn't exist currently make sure the name is unique
        let tmpLoad = site.loadNode(page.id);
        if (!tmpLoad) {
          await HAXCMS.recurseCopy(
              HAXCMS.boilerplatePath + 'page/default',
              site.siteDirectory + '/' + page.location.replace('/index.html', '')
          );
          pageAlternateContentMap[page.id] = '';
        }
        // this would imply existing item, lets see if it moved or needs moved
        else {
            let moved = false;
            for( var moveKey in original) {
              let tmpItem = original[moveKey];
                // see if this is something moving as opposed to brand new
                if (
                    tmpItem.id == page.id &&
                    tmpItem.slug != ''
                ) {
                    // core support for automatically managing paths to make them nice
                    if (typeof site.manifest.metadata.site.settings.pathauto !== 'undefined' && site.manifest.metadata.site.settings.pathauto) {
                        moved = true;
                        page.slug = normalizeOutlineSlug(
                          site,
                          HAXCMS.cleanTitle(page.title),
                          page,
                          true,
                        );
                    }
                    else if (tmpItem.slug != page.slug) {
                        moved = true;
                        page.slug = normalizeOutlineSlug(site, page.slug, page, false);
                    }
                }
            }
            // it wasn't moved and it doesn't exist... let's fix that
            // this is beyond an edge case
            if (
              !moved &&
              !fs.existsSync(site.siteDirectory + '/' + page.location)
          ) {
                let pAuto = false;
                if (typeof site.manifest.metadata.site.settings.pathauto !== 'undefined' && site.manifest.metadata.site.settings.pathauto) {
                  pAuto = true;
                }
                let tmpTitle = normalizeOutlineSlug(site, cleanTitle, page, pAuto);
                page.location = 'pages/' + page.id + '/index.html';
                page.slug = tmpTitle;
                await HAXCMS.recurseCopy(
                    HAXCMS.boilerplatePath + 'page/default',
                    site.siteDirectory + '/' + page.location.replace('/index.html', '')
                );
                pageAlternateContentMap[page.id] = '';
            }
        }
        if (typeof page.slug !== 'string' || page.slug == '') {
          page.slug = normalizeOutlineSlug(site, cleanTitle, page, true);
        }
        safeLocationMap[page.id] = page.location;
        // check for any metadata keys that did come over
        for (let pageKey in item.metadata) {
            page.metadata[pageKey] = item.metadata[pageKey];
        }
        // safety check for new things
        if (typeof page.metadata.created === 'undefined') {
            page.metadata.created = Math.floor(Date.now() / 1000);
            page.metadata.images = [];
            page.metadata.videos = [];
        }
        // always update at this time
        page.metadata.updated = Math.floor(Date.now() / 1000);
        let tmp = site.loadNode(page.id);
        if (tmp) {
          await site.updateNode(page);
        } else {
          site.manifest.addItem(page);
          await site.manifest.save(false);
        }
      }
      // process any duplicate / contents requests we had now that structure is sane
      // including potentially duplication of material from something
      // we are about to act on and now that we have the map
      items = [...req.body['items']];
      for (let dupKey in items) {
        let item = items[dupKey];
        // load the item, or the item as built out of the itemMap
        // since we reset the UUID on creation
        page = site.loadNode(item.id);
        if (!page) {
          page = site.loadNode(itemMap[item.id]);
        }
        if (!page) {
          return saveOutlineError(res, 400, 'invalid page reference');
        }
        let expectedLocation = safeLocationMap[page.id];
        if (!expectedLocation) {
          expectedLocation = normalizeOutlineLocation(page.location);
        }
        if (!expectedLocation) {
          return saveOutlineError(res, 400, 'invalid page location');
        }
        // location is backend-controlled based on page id, ignore client input
        if (!getValidatedWritePath(site.siteDirectory, expectedLocation)) {
          return saveOutlineError(res, 400, 'invalid write target');
        }
        page.location = expectedLocation;
        let alternateContent = '';
        let shouldWriteAlternate = false;
        if (typeof pageAlternateContentMap[page.id] !== 'undefined') {
          shouldWriteAlternate = true;
        }
        if (typeof item.duplicate !== 'undefined') {
          let nodeToDuplicate = site.loadNode(item.duplicate);
          // load the node we are duplicating with support for the same map needed for page loading
          if (!nodeToDuplicate) {
            nodeToDuplicate = site.loadNode(itemMap[item.duplicate]);
          }
          if (!nodeToDuplicate) {
            return saveOutlineError(res, 400, 'invalid duplicate source');
          }
          let content = await site.getPageContent(nodeToDuplicate);
          if (!isLikelyHtmlContent(content)) {
            return saveOutlineError(res, 400, 'invalid duplicate content');
          }
          // write it to the file system
          alternateContent = sanitizeHTMLForStorage(content);
          bytes = await page.writeLocation(
            alternateContent,
            site.siteDirectory
          );
          if (bytes === false) {
            return saveOutlineError(res, 500, 'failed to write');
          }
          shouldWriteAlternate = true;
        }
        // contents that were shipped across, and not null, take priority over a dup request
        if (typeof item.contents !== 'undefined' && item.contents && item.contents != '') {
          if (!isLikelyHtmlContent(item.contents)) {
            return saveOutlineError(res, 400, 'invalid page contents');
          }
          // write it to the file system
          alternateContent = sanitizeHTMLForStorage(item.contents);
          bytes = await page.writeLocation(
            alternateContent,
            site.siteDirectory
          );
          if (bytes === false) {
            return saveOutlineError(res, 500, 'failed to write');
          }
          shouldWriteAlternate = true;
        }
        if (shouldWriteAlternate) {
          site.writePageAlternateFormats(page, alternateContent);
        }
      }
      items = [...req.body['items']];
      // now, we can finally delete as content operations have finished
      for (let delKey in items) {
        let item = items[delKey];
        // verify if we were told to delete this item via flag not in the real spec
        if (typeof item.delete !== 'undefined' && item.delete === true) {
          // load the item, or the item as built out of the itemMap
          // since we reset the UUID on creation
          page = site.loadNode(item.id);
          if (!page) {
            page = site.loadNode(itemMap[item.id]);
          }
          await site.deleteNode(page);
          await site.gitCommit(
            'Page deleted: ' + page.title + ' (' + page.id + ')'
          );
        }
      }
      await site.manifest.save();
      // now, we need to look for orphans if we deleted anything
      let orphanCheck = [...site.manifest.items];
      for (let orKey in orphanCheck) {
        let item = orphanCheck[orKey];
        // just to be safe..
        page = site.loadNode(item.id)
        if (page && page.parent != null) {
          let parentPage = site.loadNode(page.parent);
          // ensure that parent is valid to rescue orphan items
          if (!parentPage) {
            page.parent = null;
            // force to bottom of things while still being in old order if lots of things got axed
            page.order = parseInt(page.order) + site.manifest.items.length - 1;
            await site.updateNode(page);
          }
        }
      }
      site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
      await site.manifest.save();
      // update alt formats like rss as we did massive changes
      await site.updateAlternateFormats();
      await site.gitCommit('Outline updated in bulk');
      res.send(site.manifest.items);
    } else {
      res.sendStatus(403);
    }
  }
  function normalizeOutlineLocation(location) {
    if (typeof location !== 'string') {
      return false;
    }
    let normalized = location.replace(/\\/g, '/').trim();
    if (normalized == '' || normalized.indexOf('\u0000') !== -1) {
      return false;
    }
    if (normalized.substring(0, 1) == '/') {
      return false;
    }
    let parts = normalized.split('/');
    for (let partKey in parts) {
      let part = parts[partKey];
      if (part == '' || part == '.' || part == '..') {
        return false;
      }
    }
    if (parts[0] != 'pages' && parts[0] != 'content') {
      return false;
    }
    return parts.join('/');
  }
  function normalizeOutlineSlug(site, slug, page = null, pathAuto = false) {
    let normalizedSlug = HAXCMS.generateSlugName(slug);
    if (normalizedSlug == 'x') {
      normalizedSlug = 'x-x';
    }
    if (normalizedSlug.substring(0, 2) == 'x/') {
      normalizedSlug = normalizedSlug.replace('x/', 'x-x/');
    }
    if (normalizedSlug == '') {
      normalizedSlug = 'blank';
    }
    return site.getUniqueSlugName(normalizedSlug, page, pathAuto);
  }
  function getValidatedWritePath(siteDirectory, location) {
    let normalizedLocation = normalizeOutlineLocation(location);
    if (!normalizedLocation) {
      return false;
    }
    let siteRoot = path.resolve(siteDirectory);
    let targetPath = path.resolve(siteDirectory, normalizedLocation);
    if (targetPath != siteRoot && targetPath.indexOf(siteRoot + path.sep) !== 0) {
      return false;
    }
    if (!fs.existsSync(targetPath)) {
      return false;
    }
    try {
      if (!fs.lstatSync(targetPath).isFile()) {
        return false;
      }
    }
    catch (e) {
      return false;
    }
    return targetPath;
  }
  function isLikelyHtmlContent(content) {
    if (typeof content !== 'string') {
      return false;
    }
    let trimmed = content.trim();
    if (trimmed == '') {
      return false;
    }
    return /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/.test(trimmed);
  }
  function saveOutlineError(res, status, message) {
    return res.send({
      '__failed' : {
        'status' : status,
        'message' : message,
      }
    });
  }
  module.exports = saveOutline;