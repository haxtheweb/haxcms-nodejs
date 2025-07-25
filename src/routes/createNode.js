const { HAXCMS } = require('../lib/HAXCMS.js');
const path = require('path');
const JSONOutlineSchemaItem = require('../lib/JSONOutlineSchemaItem.js');
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
  let nodeParams = req.body;
  if (req.query['site_token'] && HAXCMS.validateRequestToken(req.query['site_token'], HAXCMS.getActiveUserName() + ':' + nodeParams['site']['name'])) {
    let item;
    let site = await HAXCMS.loadSite(req.body['site']['name'].toLowerCase());
    // implies we've been TOLD to create nodes
    // this is typically from a docx import
    if (nodeParams['items']) {
      // create pages
      for (i=0; i < nodeParams['items'].length; i++) {
        // outline-designer allows delete + confirmation but we don't have anything
        // so instead, just don't process the thing in question if asked to delete it
        if (nodeParams['items'][i]['delete'] && nodeParams['items'][i]['delete'] == true) {
          // do nothing
        }
        else {
          item = site.addPage(
          nodeParams['items'][i]['parent'], 
          nodeParams['items'][i]['title'], 
          'html', 
          nodeParams['items'][i]['slug'],
          nodeParams['items'][i]['id'],
          nodeParams['items'][i]['indent'],
          nodeParams['items'][i]['contents']
          );  
        }
      }
      await site.gitCommit(nodeParams['items'].length + ' pages added'); 
    }
    else {
      // generate a new item based on the site
      item = site.itemFromParams(nodeParams);
      item.metadata.images = [];
      item.metadata.videos = [];
      // generate the boilerplate to fill this page
      HAXCMS.recurseCopy(
        HAXCMS.boilerplatePath + 'page/default',
        path.join(site.siteDirectory, item.location.replace('/index.html', ''))
      );
      // add the item back into the outline schema
      site.manifest.addItem(item);
      await site.manifest.save();
      // support for duplicating the content of another item
      if (nodeParams['node']['duplicate']) {
        // verify we can load this id
        let nodeToDuplicate;
        if (nodeToDuplicate = site.loadNode(nodeParams['node']['duplicate'])) {
            let content = await site.getPageContent(nodeToDuplicate);
            let page;
            // verify we actually have the id of an item that we just created
            if (page = site.loadNode(item.id)) {
            // write it to the file system
            // this all seems round about but it's more secure
            let bytes = await page.writeLocation(
                content,
                site.siteDirectory
            );
            }
        }
      }
      // implies front end was told to generate a page with set content
      // this is possible when importing and processing a file to generate
      // html which becomes the boilerplated content in effect
      else if (nodeParams['node']['contents']) {
        let page;
        if (page = site.loadNode(item.id)) {
            // write it to the file system
            let bytes = await page.writeLocation(
            nodeParams['node']['contents'],
            site.siteDirectory
            );
        }
      }
      await site.gitCommit('Page added:' + item.title + ' (' + item.id + ')'); 
      // update the alternate formats as a new page exists
      await site.updateAlternateFormats();
    }
    res.send({
      status: 200,
      data: item
    });
  } else {
    res.sendStatus(403);
  }
}
module.exports = createNode;