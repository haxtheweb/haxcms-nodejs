const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');
const HAXCMSFile = require('../lib/HAXCMSFile.js');
/**
   * @OA\Post(
   *    path="/saveFile",
   *    tags={"hax","authenticated","file"},
   *    @OA\Parameter(
   *         name="jwt",
   *         description="JSON Web token, obtain by using  /login",
   *         in="query",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *    @OA\Parameter(
   *         name="file-upload",
   *         description="File to upload",
   *         in="header",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *    @OA\RequestQuery(
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
   *                 required={"site"},
   *                 example={
   *                    "site": {
   *                      "name": "mynewsite"
   *                    },
   *                    "node": {
   *                      "id": ""
   *                    }
   *                 }
   *             )
   *         )
   *    ),
   *    @OA\Response(
   *        response="200",
   *        description="User is uploading a file to present in a site"
   *   )
   * )
   */
  async function saveFile(req, res, next) {
    let sendResult = 500;
    // resolve front-end parsing issue with saveFiles based on how that was structured
    // this is a bit of a hack but site token will have the ?siteName in it as opposed to stand alone params
    if (req.query['site_token'] && !req.query['site']) {
      let tmp = req.query['site_token'].split('?siteName=');
      if (tmp.length == 2) {
        req.query['site_token'] = tmp[0];
        req.query['siteName'] = tmp[1];
      }
    }
    if (
      req.query['site_token'] && 
      HAXCMS.validateRequestToken(req.query['site_token'], HAXCMS.getActiveUserName() + ':' + req.query['siteName']) &&
      req.file &&
      req.file.fieldname == 'file-upload' && 
      req.query && 
      req.query['siteName'] && 
      req.query['nodeId']
    ) {
      let site = await HAXCMS.loadSite(req.query['siteName']);
      if (site) {
        // update the page's content, using manifest to find it
        // this ensures that writing is always to what the file system
        // determines to be the correct page
        let page = site.loadNode(req.query['nodeId']);
        let upload = req.file;
        upload.name = upload.originalname;
        upload.tmp_name = path.join("./", upload.path);
        let file = new HAXCMSFile();
        let fileResult = await file.save(upload, site, page);
        if (!fileResult || fileResult['status'] == 500) {
          // do nothing so we can 500
        }
        else {
          await site.gitCommit('File added: ' + upload['name']);
          sendResult = fileResult;
        }
      }
    }
    res.send(sendResult);
  }
  module.exports = saveFile;