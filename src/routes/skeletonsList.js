const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');

/**
 * Discover available site skeletons from core and user config directories.
 * Returns metadata list compatible with app-hax v2 dashboard.
 * Requires a valid user_token and JWT.
 *
 * @OA\Get(
 *    path="/skeletonsList",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="List available site skeletons"
 *   )
 * )
 */
async function skeletonsList(req, res) {
  // Validate user_token like listSites
  if (!req.query.user_token || !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }

  const items = [];
  // directories to scan for JSON skeleton definitions
  const dirs = [];
  // built-in skeletons now live under coreConfig/skeletons like other core config
  const coreDir = path.join(HAXCMS.coreConfigPath, 'skeletons');
  // _config location remains in the cascade for overrides / custom skeletons
  const configDir = path.join(HAXCMS.HAXCMS_ROOT, '_config', 'skeletons');
  
  if (await fs.pathExists(coreDir)) {
    dirs.push(coreDir);
  }
  if (await fs.pathExists(configDir)) {
    dirs.push(configDir);
  }

  for (const dir of dirs) {
    try {
      const files = await fs.readdir(dir);
      
      for (const file of files) {
        if (file === '.' || file === '..') continue;
        
        const filePath = path.join(dir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile() && path.extname(file).toLowerCase() === '.json') {
          try {
            const json = await fs.readFile(filePath, 'utf8');
            const skeleton = JSON.parse(json);
            
            if (typeof skeleton !== 'object') continue;
            
            // Accept flexible export structures; derive meta fields
            const meta = skeleton.meta || {};
            const title = meta.useCaseTitle || meta.name || path.basename(file, '.json');
            const description = meta.useCaseDescription || meta.description || '';
            const image = meta.useCaseImage || '';
            
            // categories/tags from meta or build type if present
            let category = [];
            if (Array.isArray(meta.category)) {
              category = meta.category;
            } else if (Array.isArray(meta.tags)) {
              category = meta.tags;
            }
            
            // attributes/icons optional in meta
            const attributes = Array.isArray(meta.attributes) ? meta.attributes : [];
            
            // demo/source url optional
            const demo = meta.sourceUrl || '#';
            
            // Build API URL to fetch skeleton content with user_token
            const skeletonName = path.basename(file, '.json');
            // "default-starter" is a shared internal fallback skeleton that
            // many generic themes point at behind the scenes. It should not
            // appear in the public list of selectable skeletons.
            if (skeletonName === 'default-starter') {
              continue;
            }
            const baseAPIPath = HAXCMS.basePath + HAXCMS.systemRequestBase;
            const userToken = req.query.user_token;
            const skeletonUrl = `${baseAPIPath}getSkeleton?name=${encodeURIComponent(skeletonName)}&user_token=${encodeURIComponent(userToken)}`;
            
            items.push({
              title: title,
              description: description,
              image: image,
              category: category,
              attributes: attributes,
              'demo-url': demo,
              'skeleton-url': skeletonUrl
            });
          } catch (parseError) {
            // Skip invalid JSON files
            console.warn(`Failed to parse skeleton file ${file}:`, parseError.message);
          }
        }
      }
    } catch (readError) {
      console.warn(`Failed to read directory ${dir}:`, readError.message);
    }
  }

  return res.json({
    status: 200,
    data: items
  });
}

module.exports = skeletonsList;
