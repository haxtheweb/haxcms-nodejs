const fs = require("fs-extra");
const { HAXCMS } = require("../../../lib/HAXCMS.js");
// DRAFT plugin platform: site.before.archive / site.after.archive (spec/06)
const pluginSystem = require("../../../lib/plugins/pluginSystem.js");

/**
 * @OA\Post(
 *    path="/archiveSite",
 *    tags={"cms","authenticated","site"},
 *    @OA\Parameter(
 *         name="jwt",
 *         description="JSON Web token, obtain by using  /login",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\RequestBody(
 *        @OA\MediaType(
 *             mediaType="application/json",
 *             @OA\Schema(
 *                 @OA\Property(
 *                     property="site",
 *                     type="object"
 *                 ),
 *                 required={"site"},
 *                 example={
 *                    "site": {
 *                      "name": "mynewsite"
 *                    },
 *                 }
 *             )
 *         )
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Archive a site by moving it on the file system"
 *   )
 * )
 */
async function archiveSite(req, res) {
  let site = await HAXCMS.loadSite(req.body["site"]["name"]);
  if (site.name) {
    const pluginOpts = {
      user: pluginSystem.userRecord(HAXCMS.getActiveUserName()),
    };
    const pluginSubject = pluginSystem.siteSummary(site);
    const pre = await pluginSystem.event(
      site,
      "site.before.archive",
      pluginSubject,
      pluginOpts,
    );
    if (pre.veto) {
      const status = pre.veto.status || 409;
      return res.status(status).json({
        status: status,
        data: { message: pre.veto.message, plugin: pre.veto.plugin },
      });
    }
    // create archived directory in this tree if it doesn't exist already
    if (!fs.existsSync(HAXCMS.HAXCMS_ROOT + HAXCMS.archivedDirectory)) {
      fs.mkdirSync(HAXCMS.HAXCMS_ROOT + HAXCMS.archivedDirectory);
    }
    // D5: uniquify collided archive names (name-1, name-2…) so a bare
    // rename doesn't fail when the destination already exists. Mirrors
    // PHP routes/archiveSite.php:49-71.
    const baseArchiveName = site.manifest.metadata.site.name;
    let archivedName = baseArchiveName;
    let counter = 1;
    while (
      fs.existsSync(
        HAXCMS.HAXCMS_ROOT + HAXCMS.archivedDirectory + "/" + archivedName,
      )
    ) {
      archivedName = baseArchiveName + "-" + counter;
      counter++;
    }
    await fs.rename(
      HAXCMS.HAXCMS_ROOT + HAXCMS.sitesDirectory + "/" + baseArchiveName,
      HAXCMS.HAXCMS_ROOT + HAXCMS.archivedDirectory + "/" + archivedName,
    );
    // the site's folder has moved: the system engine hears that it is archived
    await pluginSystem.event(
      null,
      "site.after.archive",
      Object.assign({}, pluginSubject, { archivedName: archivedName }),
      pluginOpts,
    );
    // PHP parity: say so when the archive had to be renamed
    const detail =
      archivedName === baseArchiveName
        ? "Site archived"
        : "Site archived as " +
          archivedName +
          " because an archived copy already existed";
    res.send({
      status: 200,
      data: {
        name: site.name,
        archivedName: archivedName,
        detail: detail,
      },
    });
  } else {
    // PHP parity: same status and message as archiveSite.php
    res
      .status(500)
      .json({ status: 500, data: { message: "Site does not exist" } });
  }
}
module.exports = archiveSite;
