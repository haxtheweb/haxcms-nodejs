const { HAXCMS } = require('../../../lib/HAXCMS.js');
const fs = require('fs-extra');
const path = require('path');
const archiverModule = require('archiver');
function createArchiver(format, options = {}) {
  const normalizedFormat = String(format || '').trim().toLowerCase();
  if (typeof archiverModule === 'function') {
    return archiverModule(format, options);
  }
  if (
    archiverModule &&
    typeof archiverModule.default === 'function'
  ) {
    return archiverModule.default(format, options);
  }
  if (
    archiverModule &&
    typeof archiverModule.create === 'function'
  ) {
    return archiverModule.create(format, options);
  }
  if (
    archiverModule &&
    typeof archiverModule === 'object' &&
    normalizedFormat === 'zip' &&
    typeof archiverModule.ZipArchive === 'function'
  ) {
    return new archiverModule.ZipArchive(options);
  }
  if (
    archiverModule &&
    typeof archiverModule === 'object' &&
    normalizedFormat === 'tar' &&
    typeof archiverModule.TarArchive === 'function'
  ) {
    return new archiverModule.TarArchive(options);
  }
  if (
    archiverModule &&
    typeof archiverModule === 'object' &&
    normalizedFormat === 'json' &&
    typeof archiverModule.JsonArchive === 'function'
  ) {
    return new archiverModule.JsonArchive(options);
  }
  throw new Error('archiver module does not expose a compatible factory');
}
/**
   * @OA\Post(
   *    path="/downloadSite",
   *    tags={"cms","authenticated","site","meta"},
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
   *        description="Download the site folder as a zip file"
   *   )
   * )
   */
  async function downloadSite(req, res) {
    // load site
      let site = await HAXCMS.loadSite(req.body['site']['name']);
      // create archived directory in this tree if it doesn't exist already
      if (!fs.existsSync(HAXCMS.HAXCMS_ROOT + HAXCMS.publishedDirectory)) {
        fs.mkdirSync(HAXCMS.HAXCMS_ROOT + HAXCMS.publishedDirectory);
      }
      // helpful boilerplate https://stackoverflow.com/questions/29873248/how-to-zip-a-whole-directory-and-download-using-php
      let dir = HAXCMS.HAXCMS_ROOT + HAXCMS.sitesDirectory + '/' + site.name;
      // form a basic name
      let zip_file =
        HAXCMS.HAXCMS_ROOT +
        HAXCMS.publishedDirectory +
        '/' +
        site.name +
        '.zip';
      // Get real path for our folder
      let rootPath = await fs.realpath(dir);
      // Initialize archive object
      await zipDirectory(rootPath, zip_file);
      res.send({
        status: 200,
        data: {
        'link':
          HAXCMS.basePath +
          HAXCMS.publishedDirectory +
          '/' + site.name +
          '.zip',
        'name': site.name + '.zip'
        }
      });
  }


/**
 * Relative paths (forward slashes) of every symlink under sourceDir. Links
 * are never followed, and node_modules / .git are not walked since the
 * archive ignores them anyway.
 * @param {String} sourceDir: folder to scan
 * @param {String} relDir: sub folder being scanned, relative to sourceDir
 * @returns {Promise<String[]>}
 */
async function findSymlinks(sourceDir, relDir = '') {
  const found = [];
  let entries = [];
  try {
    entries = await fs.readdir(path.join(sourceDir, relDir), { withFileTypes: true });
  }
  catch {
    return found;
  }
  for (const entry of entries) {
    const relPath = relDir ? relDir + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) {
      found.push(relPath);
    }
    else if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      found.push(...await findSymlinks(sourceDir, relPath));
    }
  }
  return found;
}

// a name with glob characters in it still has to match literally in `ignore`
function escapeGlob(value) {
  return value.replace(/[\\*?[\]{}()!+@|]/g, '\\$&');
}

/**
 * Zip a site folder. Symlinks are left out: a scaffolded site links build,
 * dist, wc-registry.json and the babel files to the multi-site root, and those
 * targets don't exist once the zip is unpacked anywhere else (a dangling link
 * that some unzip tools warn about). They are multi-site plumbing rather than
 * site content, so nothing is lost by leaving them out.
 * @param {String} sourceDir: /some/folder/to/compress
 * @param {String} outPath: /path/to/created.zip
 * @returns {Promise}
 */
async function zipDirectory(sourceDir, outPath) {
  const symlinks = await findSymlinks(sourceDir);
  const archive = createArchiver('zip', { zlib: { level: 9 }});
  const stream = fs.createWriteStream(outPath);

  return new Promise((resolve, reject) => {
    archive
      .glob('**/*', {
        cwd: sourceDir,
        ignore: [
          'node_modules/**',
          'node_modules',
          '.git/**',
          '.git',
          ...symlinks.map(escapeGlob),
        ],
      })
      .on('error', err => reject(err))
      .pipe(stream)
    ;

    stream.on('close', () => resolve());
    archive.finalize();
  });
}
  module.exports = downloadSite;