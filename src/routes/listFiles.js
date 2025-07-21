const { HAXCMS } = require('../lib/HAXCMS.js');
const fs = require('fs');
const path = require('path');
const mime = require('mime');
/**
   * @OA\Post(
   *    path="/listFiles",
   *    tags={"hax","authenticated","file"},
   *    @OA\Parameter(
   *         name="jwt",
   *         description="JSON Web token, obtain by using  /login",
   *         in="query",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *    @OA\Response(
   *        response="200",
   *        description="Load existing files for presentation in HAX find area"
   *   )
   * )
   */
  async function listFiles(req, res) {
    let files = [];
    // verify that we have params expected from frontend
    if (req.query && req.query['siteName']) {
      let site = await HAXCMS.loadSite(req.query['siteName']);
      if (site && site.siteDirectory) {
        let search = (typeof req.query['filename'] !== 'undefined') ? req.query['filename'] : '';
        // build files directory path
        let siteFilePath = path.join(site.siteDirectory, 'files');
        let handle;
        if (handle = fs.readdirSync(siteFilePath)) {
          handle.forEach(file => {
            if (
                file != "." &&
                file != ".." &&
                file != '.gitkeep' &&
                file != '.DS_Store'
            ) {
              // ensure this is a file
              if (
                fs.lstatSync(siteFilePath + '/' + file).isFile()
              ) {
                // ensure this is a file and if we are searching for results then return only exact ones
                if (!search || search == "" || file.indexOf(search) !== -1) {
                  let fullUrl = '/files/' + file;
                  // multiple sites then append the base url to site management area
                  if (HAXCMS.operatingContext == 'multisite') {
                    fullUrl = HAXCMS.basePath +
                    HAXCMS.sitesDirectory + '/' +
                    site.manifest.metadata.site.name + '/files/' + file
                  }
                  files.push({
                    'path' : 'files/' + file,
                    'fullUrl' : fullUrl,
                    'url' : 'files/' + file,
                    'mimetype' : mime.getType(siteFilePath + '/' + file),
                    'name' : file
                  });
                }
              } else {
                  // @todo maybe step into directories?
              }
            }
          });
        }
      }
    }
    res.send(files);
  }
  module.exports = listFiles;