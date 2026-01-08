const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');

/**
 * Get a specific skeleton file by name.
 * Returns the skeleton JSON data.
 * Requires a valid user_token and JWT.
 *
 * @OA\Get(
 *    path="/getSkeleton",
 *    tags={"cms"},
 *    @OA\Parameter(
 *         name="name",
 *         description="Skeleton file name (without .json extension)",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Returns skeleton JSON data"
 *   )
 * )
 */
async function getSkeleton(req, res) {
  // Validate user_token like listSites
  if (!req.query.user_token || !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }

  const skeletonName = req.query.name;
  if (!skeletonName) {
    return res.status(400).json({
      status: 400,
      message: 'skeleton name is required',
    });
  }

  // Sanitize the skeleton name to prevent directory traversal
  const safeName = path.basename(skeletonName);
  const fileName = safeName.endsWith('.json') ? safeName : `${safeName}.json`;

  // directories to search for skeleton files
  const dirs = [];
  // coreConfig provides built-in skeletons consistent with other core definitions
  const coreDir = path.join(HAXCMS.coreConfigPath, 'skeletons');
  // _config location still participates in the cascade for overrides
  const configDir = path.join(HAXCMS.HAXCMS_ROOT, '_config', 'skeletons');
  
  if (await fs.pathExists(coreDir)) {
    dirs.push(coreDir);
  }
  if (await fs.pathExists(configDir)) {
    dirs.push(configDir);
  }

  // Search for the skeleton file
  for (const dir of dirs) {
    const filePath = path.join(dir, fileName);
    
    if (await fs.pathExists(filePath)) {
      try {
        const json = await fs.readFile(filePath, 'utf8');
        const skeleton = JSON.parse(json);
        
        return res.json({
          status: 200,
          data: skeleton
        });
      } catch (parseError) {
        return res.status(500).json({
          status: 500,
          message: `Failed to parse skeleton file: ${parseError.message}`,
        });
      }
    }
  }

  return res.status(404).json({
    status: 404,
    message: 'skeleton not found',
  });
}

module.exports = getSkeleton;
