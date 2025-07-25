const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');
/**
 * @OA\Get(
 *    path="/listSites",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="Load a list of all sites the user has created"
 *   )
 * )
 */
async function listSites(req, res) {
  if (req.query['user_token'] && HAXCMS.validateRequestToken(req.query['user_token'], HAXCMS.getActiveUserName())) {
    // top level fake JOS
    let returnData = {
      id: '123-123-123-123',
      title: 'My sites',
      author: 'me',
      description: 'All of my micro sites I know and love',
      license: 'by-sa',
      metadata: {
        pageCount: 0
      },
      items: []
    };
    // Loop through all the files in the temp directory
    if (!fs.existsSync(path.join(HAXCMS.HAXCMS_ROOT, HAXCMS.sitesDirectory))) {
      fs.mkdirSync(path.join(HAXCMS.HAXCMS_ROOT, HAXCMS.sitesDirectory));
    }
    const files = fs.readdirSync(path.join(HAXCMS.HAXCMS_ROOT, HAXCMS.sitesDirectory));
    // Need to use a for loop to remain syncronous
    for (const item of files) {
      const stat = fs.statSync(path.join(HAXCMS.HAXCMS_ROOT, HAXCMS.sitesDirectory, item))
      if (stat.isDirectory() && item != '.git') {
        try {
          let site = JSON.parse(await fs.readFileSync(path.join(HAXCMS.HAXCMS_ROOT, `${HAXCMS.sitesDirectory}/${item}/site.json`),'utf8'));
          site.location = `${HAXCMS.basePath}${HAXCMS.sitesDirectory}/${item}/`;
          site.slug = `${HAXCMS.basePath}${HAXCMS.sitesDirectory}/${item}/`;
          site.metadata.pageCount = site.items.length;
          delete site.items;
          returnData.items.push(site);  
        }
        catch(err) {
          // something without a site.json
          //console.error(err);
        }
      }
    }
    res.send({
      status: 200,
      data: returnData
    });
  } else {
    res.sendStatus(403);
  }
}
module.exports = listSites;