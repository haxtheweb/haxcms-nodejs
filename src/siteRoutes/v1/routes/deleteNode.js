const { HAXCMS } = require("../../../lib/HAXCMS.js");
// DRAFT plugin platform: page.before.delete / page.after.delete around the delete
const pluginSystem = require("../../../lib/plugins/pluginSystem.js");
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
      const pluginRecord = JSON.parse(JSON.stringify(page));
      if (process.env.HAXCMS_PLUGINS !== "off") {
        const pre = await pluginSystem.before(site, "page", pluginRecord, null, { delete: true });
        if (pre.veto) {
          return res.status(pre.veto.status || 409).json({ status: pre.veto.status || 409, data: { message: pre.veto.message, plugin: pre.veto.plugin } });
        }
      }
      if ((await site.deleteNode(page)) === false) {
        res
          .status(500)
          .json({ status: 500, data: { message: "Server error" } });
      } else {
        // now, we need to look for orphans if we deleted anything
        for (var key in site.manifest.items) {
          // just to be safe..
          let pageUpdate;
          if ((pageUpdate = site.loadNode(site.manifest.items[key].id))) {
            // ensure that parent is valid to rescue orphan items
            if (
              pageUpdate.parent != null &&
              !site.loadNode(pageUpdate.parent)
            ) {
              pageUpdate.parent = null;
              // force to bottom of things while still being in old order if lots of things got axed
              pageUpdate.order =
                parseInt(pageUpdate.order) + site.manifest.items.length - 1;
              site.updateNode(pageUpdate);
            }
          }
        }
        await site.gitCommit(
          "Page deleted: " + page.title + " (" + page.id + ")",
        );
        if (process.env.HAXCMS_PLUGINS !== "off") {
          await pluginSystem.after(site, "page", pluginRecord, null, { delete: true });
        }
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
      .json({ status: 403, data: { message: "Authentication required" } });
  }
}
module.exports = deleteNode;
