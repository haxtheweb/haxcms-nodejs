const {
  isLocked,
  compactSiblingOrders,
  syncIndentToDepth,
  adoptChildren,
} = require("../../../lib/outlineUpkeep.js");
const { reslugPageAndBranch } = require("../../../lib/nodeDetailOperations.js");
const { HAXCMS } = require("../../../lib/HAXCMS.js");
const {
  getRequestHeaderValue,
  assertSiteFeature,
} = require("../siteRouteUtils.js");

/**
 * @OA\Post(
 *    path="/deleteNode",
 *    tags={"cms","authenticated","node"},
 *    @OA\Parameter(
 *         name="jwt",
 *         description="JSON Web token, obtain by using  /login",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Delete a node"
 *   )
 * )
 */
async function deleteNode(req, res) {
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
    let site = await HAXCMS.loadSite(req.body.site.name);
    if (
      !assertSiteFeature(
        site,
        res,
        "deletePage",
        "Delete is disabled for this site",
      )
    ) {
      return;
    }
    // update the page's content, using manifest to find it
    // this ensures that writing is always to what the file system
    // determines to be the correct page
    let page;
    if ((page = site.loadNode(req.body["node"]["id"]))) {
      // a locked page is changed by nothing but unlocking it
      if (isLocked(page)) {
        return res.status(423).json({
          status: 423,
          data: { message: "Page is locked", reason: "locked" },
        });
      }
      if ((await site.deleteNode(page)) === false) {
        res
          .status(500)
          .json({ status: 500, data: { message: "Server error" } });
      } else {
        const items = site.manifest.items;
        // the deleted page's children move up one level, into its place
        const moved = adoptChildren(items, {
          id: page.id,
          parent: page.parent,
          order: page.order,
        });
        // any other page whose parent is gone (left by an older save) goes
        // to the end of the top level, as before
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (
            item &&
            item.parent != null &&
            item.parent !== "" &&
            !site.loadNode(item.parent)
          ) {
            item.parent = null;
            item.order = parseInt(item.order) + items.length - 1;
            moved.push(item);
          }
        }
        // the moved pages' addresses (and their branches') drop the deleted
        // parent's slug, and indent follows the new depth. The deleted page
        // leaves no gap among its siblings: every group is numbered 0..n-1
        // again, in the order a reader sees them.
        for (let i = 0; i < moved.length; i++) {
          reslugPageAndBranch(site, moved[i], items);
        }
        const renumbered = compactSiblingOrders(items);
        if (moved.length > 0 || renumbered) {
          syncIndentToDepth(items);
          await site.manifest.save(false);
          await site.updateAlternateFormats();
        }
        await site.gitCommit(
          "Page deleted: " + page.title + " (" + page.id + ")",
        );
        res.send({
          status: 200,
          data: page,
        });
      }
    } else {
      res.status(500).json({ status: 500, data: { message: "Server error" } });
    }
  } else {
    res
      .status(403)
      .json({ status: 403, data: { message: "invalid site token" } });
  }
}
module.exports = deleteNode;
