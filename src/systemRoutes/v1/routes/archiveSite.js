const fs = require('fs-extra');
const { HAXCMS } = require('../../../lib/HAXCMS.js');

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
    let site = await HAXCMS.loadSite(req.body['site']['name']);
      if (site.name) {
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
            HAXCMS.HAXCMS_ROOT + HAXCMS.archivedDirectory + '/' + archivedName,
          )
        ) {
          archivedName = baseArchiveName + '-' + counter;
          counter++;
        }
        await fs.rename(
          HAXCMS.HAXCMS_ROOT + HAXCMS.sitesDirectory + '/' + baseArchiveName,
          HAXCMS.HAXCMS_ROOT + HAXCMS.archivedDirectory + '/' + archivedName);
        res.send({
          status: 200,
          data: {
            name: site.name,
            archivedName: archivedName,
            detail: 'Site archived',
          },
        });
      }
    else {
      res.status(500).json({ status: 500, data: { message: 'Server error' } });
    }
  }
  module.exports = archiveSite;
