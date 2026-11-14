const {
  parentOf,
  makeRoomFor,
  lastSiblingOrder,
  syncIndentToDepth,
} = require("../../../lib/outlineUpkeep.js");
const { HAXCMS } = require("../../../lib/HAXCMS.js");
const path = require("path");
const fs = require("fs-extra");
const { sanitizeHTMLForStorage } = require("../../../lib/sanitizeContent.js");
const {
  materializeInlineImages,
} = require("../../../lib/materializeInlineImages.js");
const {
  getRequestHeaderValue,
  assertSiteFeature,
} = require("../siteRouteUtils.js");
/**
 * @OA\Post(
 *     path="/createNode",
 *     tags={"cms","authenticated","node"},
 *     @OA\Parameter(
 *         name="jwt",
 *         description="JSON Web token, obtain by using  /login",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *     ),
 *     @OA\RequestBody(
 *        @OA\MediaType(
 *             mediaType="application/json",
 *             @OA\Schema(
 *                 @OA\Property(
 *                     property="site",
 *                     type="object"
 *                 ),
 *                 @OA\Property(
 *                     property="node",
 *                     type="object"
 *                 ),
 *                 @OA\Property(
 *                     property="indent",
 *                     type="number"
 *                 ),
 *                 @OA\Property(
 *                     property="order",
 *                     type="number"
 *                 ),
 *                 @OA\Property(
 *                     property="parent",
 *                     type="string"
 *                 ),
 *                 @OA\Property(
 *                     property="description",
 *                     type="string"
 *                 ),
 *                 @OA\Property(
 *                     property="metadata",
 *                     type="object"
 *                 ),
 *                 required={"site","node"},
 *                 example={
 *                    "site": {
 *                      "name": "mysite"
 *                    },
 *                    "node": {
 *                      "id": null,
 *                      "title": "Cool post",
 *                      "location": null
 *                    },
 *                    "indent": null,
 *                    "order": null,
 *                    "parent": null,
 *                    "description": "An example description for the post",
 *                    "metadata": {"tags": "metadata,can,be,whatever,you,want","other":"stuff"}
 *                 }
 *             )
 *         )
 *     ),
 *    @OA\Response(
 *        response="200",
 *        description="object with full properties returned"
 *   )
 * )
 */
async function createNode(req, res) {
  const siteToken = getRequestHeaderValue(req, "x-haxcms-site-token");
  // Security: use the per-request authenticated identity resolved by
  // validateSiteApiRouteAccess rather than a process-global username so a
  // token minted for one authenticated user cannot validate under another.
  const activeUserName =
    req.haxcmsSiteApiAuth && req.haxcmsSiteApiAuth.userName
      ? req.haxcmsSiteApiAuth.userName
      : "";
  if (
    siteToken &&
    req.body &&
    req.body.site &&
    req.body.site.name &&
    activeUserName &&
    HAXCMS.validateRequestToken(
      siteToken,
      activeUserName + ":" + req.body.site.name,
    )
  ) {
    let nodeParams = req.body;
    let item;
    let site = await HAXCMS.loadSite(req.body.site.name.toLowerCase());
    if (
      !assertSiteFeature(
        site,
        res,
        "addPage",
        "Adding pages is disabled for this site",
      )
    ) {
      return;
    }
    // implies we've been TOLD to create nodes
    // this is typically from a docx import
    // (same test as the items route: an empty items array is no bulk payload)
    const hasItems =
      Array.isArray(nodeParams["items"]) && nodeParams["items"].length > 0;
    if (
      !hasItems &&
      (!nodeParams["node"] ||
        typeof nodeParams["node"] !== "object" ||
        Array.isArray(nodeParams["node"]))
    ) {
      return res.status(400).json({
        status: 400,
        data: { message: "Node payload is required" },
      });
    }
    if (hasItems) {
      // create pages; site.json is written and the generated files rebuilt
      // once for the whole request, not once per page (haxtheweb/issues#3248)
      const bulk = { createdFolders: [] };
      let added = 0;
      try {
        for (let i = 0; i < nodeParams["items"].length; i++) {
          // outline-designer allows delete + confirmation but we don't have anything
          // so instead, just don't process the thing in question if asked to delete it
          if (
            nodeParams["items"][i]["delete"] &&
            nodeParams["items"][i]["delete"] == true
          ) {
            // do nothing
          } else {
            item = await site.addPage(
              nodeParams["items"][i]["parent"],
              nodeParams["items"][i]["title"],
              "html",
              nodeParams["items"][i]["slug"],
              nodeParams["items"][i]["id"],
              nodeParams["items"][i]["indent"],
              nodeParams["items"][i]["content"] ||
                nodeParams["items"][i]["contents"] ||
                "",
              nodeParams["items"][i]["order"],
              nodeParams["items"][i]["metadata"]
                ? nodeParams["items"][i]["metadata"]
                : null,
              bulk,
            );
            added++;
          }
        }
      } catch (e) {
        // a page failed part way: keep the pages added before it, as the
        // per-page writes did, then report the error
        if (added > 0 || bulk.createdFolders.length > 0) {
          await site.finishBulkAddPages(bulk);
        }
        throw e;
      }
      if (added > 0) {
        await site.finishBulkAddPages(bulk);
      }
      // every entry was marked delete: nothing was created or committed
      if (!item) {
        return res.status(400).json({
          status: 400,
          data: {
            message: "Invalid items payload (every item is marked delete)",
          },
        });
      }
      await site.gitCommit(nodeParams["items"].length + " pages added");
    } else {
      // generate a new item based on the site
      item = site.itemFromParams(nodeParams);
      item.metadata.images = [];
      item.metadata.videos = [];
      // generate the boilerplate to fill this page
      // Security (SEC-PATH), PHP parity: the copy must land inside this site's
      // directory; refuse rather than writing anywhere else.
      const pageFolder = path.join(
        site.siteDirectory,
        item.location.replace("/index.html", ""),
      );
      const folderExisted = fs.existsSync(pageFolder);
      const copied = await HAXCMS.recurseCopy(
        HAXCMS.boilerplatePath + "page/default",
        pageFolder,
        [],
        site.siteDirectory,
      );
      if (copied === false) {
        return res.status(400).json({
          status: 400,
          data: { message: "Invalid node location" },
        });
      }
      // add the item back into the outline schema
      site.manifest.addItem(item);
      // place it among its siblings: at the order asked for (whoever held
      // that spot moves down), or at the end when no order was sent, so no
      // two siblings share an order; indent is the page's depth
      const placed = site.loadNode(item.id);
      if (placed) {
        const requestedOrder = Object.prototype.hasOwnProperty.call(
          nodeParams,
          "order",
        )
          ? parseInt(nodeParams["order"])
          : NaN;
        if (Number.isFinite(requestedOrder)) {
          placed.order = requestedOrder;
          makeRoomFor(site.manifest.items, placed);
        } else {
          placed.order =
            lastSiblingOrder(site.manifest.items, parentOf(placed), placed) + 1;
        }
        syncIndentToDepth(site.manifest.items);
        item.order = placed.order;
        item.indent = placed.indent;
      }
      try {
        await site.manifest.save();
      } catch (e) {
        // no page folder without its outline entry
        if (!folderExisted) {
          site.removeCreatedPageFolder(pageFolder);
        }
        throw e;
      }
      let alternateContent = "";
      // support for duplicating the content of another item
      if (nodeParams["node"]["duplicate"]) {
        // verify we can load this id
        let nodeToDuplicate;
        if (
          (nodeToDuplicate = site.loadNode(nodeParams["node"]["duplicate"]))
        ) {
          let content = await site.getPageContent(nodeToDuplicate);
          let page;
          // verify we actually have the id of an item that we just created
          if ((page = site.loadNode(item.id))) {
            // write it to the file system
            // this all seems round about but it's more secure
            alternateContent = sanitizeHTMLForStorage(content);
            await page.writeLocation(alternateContent, site.siteDirectory);
          }
        }
      }
      // implies front end was told to generate a page with set content
      // this is possible when importing and processing a file to generate
      // html which becomes the boilerplated content in effect
      else if (nodeParams["node"]["contents"]) {
        let page;
        if ((page = site.loadNode(item.id))) {
          // write it to the file system
          const { html: rewritten, uuids } = await materializeInlineImages(
            nodeParams["node"]["contents"],
            site,
            {
              pageTitle:
                item.title ||
                (nodeParams["node"] && nodeParams["node"]["title"]),
            },
          );
          alternateContent = sanitizeHTMLForStorage(rewritten);
          await page.writeLocation(alternateContent, site.siteDirectory);
          // #3043: imported files are referenced by their FileEntity uuid
          // (the same source saveNode uses), returned directly by
          // materializeInlineImages from the Entity API. Set
          // page.metadata.files from those uuids rather than re-scanning:
          // mammoth docx output carries images as data URIs (which the
          // helper just saved), not pre-existing files/ refs.
          if (!page.metadata) {
            page.metadata = {};
          }
          page.metadata.files = uuids;
          if (uuids.length > 0) {
            await site.manifest.save();
          }
        }
      }
      let createdPage = site.loadNode(item.id);
      if (createdPage) {
        site.writePageAlternateFormats(createdPage, alternateContent);
      }
      await site.gitCommit("Page added:" + item.title + " (" + item.id + ")");
      // update the alternate formats as a new page exists
      await site.updateAlternateFormats();
    }
    res.send({
      status: 200,
      data: item,
    });
  } else {
    res
      .status(403)
      .json({ status: 403, data: { message: "Authentication required" } });
  }
}
module.exports = createNode;
