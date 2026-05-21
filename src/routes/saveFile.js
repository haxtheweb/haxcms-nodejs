const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');
const HAXCMSFile = require('../lib/HAXCMSFile.js');
const {
  platformAllows,
  featureDisabledResponse,
} = require('../lib/platformFeatures.js');

function resolveUploadedFile(req) {
  if (req && req.file && req.file.path) {
    return req.file;
  }
  if (req && Array.isArray(req.files) && req.files.length > 0) {
    const preferredFields = ['file-upload', 'upload', 'file', 'files[]'];
    for (let i = 0; i < preferredFields.length; i++) {
      const matched = req.files.find(
        (item) => item && item.path && item.fieldname === preferredFields[i],
      );
      if (matched) {
        return matched;
      }
    }
    for (let i = 0; i < req.files.length; i++) {
      const item = req.files[i];
      if (item && item.path) {
        return item;
      }
    }
  }
  return null;
}
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
    const siteName =
      req.body &&
      req.body.site &&
      typeof req.body.site.name === 'string' &&
      req.body.site.name
        ? req.body.site.name
        : req.body &&
            typeof req.body['site[name]'] === 'string' &&
            req.body['site[name]']
          ? req.body['site[name]']
          : req.body &&
              typeof req.body.siteName === 'string' &&
              req.body.siteName
            ? req.body.siteName
            : req.query && typeof req.query.siteName === 'string'
              ? req.query.siteName
              : '';
    const nodeId =
      req.body &&
      req.body.node &&
      typeof req.body.node.id === 'string' &&
      req.body.node.id
        ? req.body.node.id
        : req.body &&
            typeof req.body['node[id]'] === 'string' &&
            req.body['node[id]']
          ? req.body['node[id]']
          : req.body &&
              typeof req.body.nodeId === 'string' &&
              req.body.nodeId
            ? req.body.nodeId
            : req.query && typeof req.query.nodeId === 'string'
              ? req.query.nodeId
              : '';
    
    // Check for required parameters and authentication - return appropriate status codes
    if (!req.query['site_token']) {
      return res.sendStatus(403); // Missing token = auth issue
    }
    
    if (!siteName) {
      return res.sendStatus(500); // Missing required parameters
    }

    const uploadedFile = resolveUploadedFile(req);
    if (!uploadedFile) {
      return res.sendStatus(500); // Missing or invalid file
    }
    
    // Validate the token - if invalid, return 403
    if (!HAXCMS.validateRequestToken(req.query['site_token'], HAXCMS.getActiveUserName() + ':' + siteName)) {
      return res.sendStatus(403); // Invalid token = auth issue
    }
    
    // Token is valid, proceed with file upload
    let site = await HAXCMS.loadSite(siteName);
    if (site) {
      if (!platformAllows(site, 'uploadMedia')) {
        return featureDisabledResponse(
          res,
          'Uploading media is disabled for this site',
        );
      }
      // update the page's content, using manifest to find it
      // this ensures that writing is always to what the file system
      // determines to be the correct page
      let page = null;
      if (nodeId) {
        page = site.loadNode(nodeId);
      }
      let upload = uploadedFile;
      upload.name = upload.originalname;
      upload.tmp_name = path.join("./", upload.path);
      let file = new HAXCMSFile();
      let fileResult = await file.save(upload, site, page);
      if (!fileResult || fileResult['status'] == 500) {
        return res.sendStatus(500);
      }
      else {
        await site.gitCommit('File added: ' + upload['name']);
        return res.status(200).json(fileResult);
      }
    } else {
      return res.sendStatus(500); // Site not found
    }
  }
  module.exports = saveFile;
