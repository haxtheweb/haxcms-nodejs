const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const JWT = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const GitPlus = require('./GitPlus.js');
const JSONOutlineSchema = require('./JSONOutlineSchema.js');
const { discoverConfigPath } = require('./discoverConfigPath.js');
const filter_var = require('./filter_var.js');
const explodeImport = require('locutus/php/strings/explode');
// may need to change as we get into CLI integration
const HAXCMS_ROOT = process.env.HAXCMS_ROOT || path.join(process.cwd(), "/");
const HAXCMS_DEFAULT_THEME = 'clean-two';
const HAXCMS_FALLBACK_HEX = '#3f51b5';
const SITE_FILE_NAME = 'site.json';
// HAXCMSSite which overlaps heavily and is referenced here often
const utf8 = require('utf8');
const JSONOutlineSchemaItem = require('./JSONOutlineSchemaItem.js');
const FeedMe = require('./RSS.js');
const TurndownService = require('turndown');
const jsyaml = require('js-yaml');
const arraySearchImport = require('locutus/php/array/array_search');
const arrayUnshiftImport = require('locutus/php/array/array_unshift');
const implodeImport = require('locutus/php/strings/implode');
const arrayUniqueImport = require('locutus/php/array/array_unique');
const jsonEncodeImport = require('locutus/php/json/json_encode');
const strtrImport = require('locutus/php/strings/strtr');
const usortImport = require('locutus/php/array/usort');
const explode = explodeImport.explode || explodeImport;
const array_search = arraySearchImport.array_search || arraySearchImport;
const array_unshift = arrayUnshiftImport.array_unshift || arrayUnshiftImport;
const implode = implodeImport.implode || implodeImport;
const array_unique = arrayUniqueImport.array_unique || arrayUniqueImport;
const json_encode = jsonEncodeImport.json_encode || jsonEncodeImport;
const strtr = strtrImport.strtr || strtrImport;
const usort = usortImport.usort || usortImport;
const sharp = require('sharp');
const util  = require('node:util');
const child_process  = require('child_process');
const {
  sanitizeHTMLForStorage,
  sanitizeURLValue,
  escapeHTMLAttribute,
  escapeXMLValue,
} = require('./sanitizeContent.js');
const exec = util.promisify(child_process.exec);
const turndownService = new TurndownService();
turndownService.keep(function(node) {
  return node && node.nodeName && String(node.nodeName).indexOf('-') !== -1;
});
// a site object
class HAXCMSSite
{
    constructor() {
        this.name;
        this.manifest;
        this.directory;
        this.basePath = '/';
        this.language = 'en-us';
        this.siteDirectory;
    }
    /**
     * Load a site based on directory and name. Assumes multi-site mode
     */
    async load(directory, siteBasePath, name)
    {
        this.name = name;
        let tmpname = decodeURIComponent(name);
        tmpname = HAXCMS.cleanTitle(tmpname, false);
        this.basePath = siteBasePath;
        this.directory = directory;
        this.manifest = new JSONOutlineSchema();
        await this.manifest.load(this.directory + '/' + tmpname + '/site.json');
        this.siteDirectory = path.join(this.directory, tmpname);
    }
    /**
     * Load a single site from a directory directly. Assumes single-site mode
     */
    async loadSingle(directory) {
      this.name = path.basename(directory);
      this.basePath = '/';
      this.directory = directory;
      this.manifest = new JSONOutlineSchema();
      await this.manifest.load(path.join(directory, SITE_FILE_NAME));
      // set additional value to ensure things requiring root find it since it is the root
      this.siteDirectory = path.dirname(path.join(directory, SITE_FILE_NAME));
    }
    /**
     * Initialize a new site with a single page to start the outline
     * @var directory string file system path
     * @var siteBasePath string web based url / base_path
     * @var name string name of the site
     * @var gitDetails git details
     * @var domain domain information
     *
     * @return HAXCMSSite object
     */
    async newSite(
        directory,
        siteBasePath,
        name,
        gitDetails = null,
        domain = null,
        build = null
    ) {
      // calls must set basePath internally to avoid page association issues
      this.basePath = siteBasePath;
      this.directory = directory;
      this.name = name;
      // clean up name so it can be in a URL / published
      let tmpname = decodeURIComponent(name);
      tmpname = HAXCMS.cleanTitle(tmpname, false);
      let loop = 0;
      let newName = tmpname;
      if (fs.existsSync(directory + "/" + newName)) {
        while (fs.existsSync(directory  + "/" + newName)) {
            loop++;
            newName = tmpname + '-' + loop;
        }
      }
      tmpname = newName;
      // siteDirectory set so we can discover this and work with it while it's being built
      this.siteDirectory = path.join(this.directory, tmpname);
      // attempt to shift it on the file system
      await HAXCMS.recurseCopy(
          HAXCMS.boilerplatePath + 'site',
          directory + '/' + tmpname
      );
      try {
        // create symlink to make it easier to resolve things to single built asset buckets
        await fs.symlink('../../build', directory + '/' + tmpname + '/build');
        // symlink to do local development if needed
        await fs.symlink('../../dist', directory + '/' + tmpname + '/dist');
        // symlink to do project development if needed
        if (fs.pathExistsSync(HAXCMS.HAXCMS_ROOT + 'node_modules') && (fs.lstatSync(HAXCMS.HAXCMS_ROOT + 'node_modules').isSymbolicLink() || fs.lstatSync(HAXCMS.HAXCMS_ROOT + 'node_modules').isDirectory())) {
          await fs.symlink(
            '../../node_modules',
            directory + '/' + tmpname + '/node_modules'
            );
        }
        // links babel files so that unification is easier
        await fs.symlink('../../wc-registry.json', directory + '/' + tmpname + '/wc-registry.json');
        await fs.symlink(
          '../../../babel/babel-top.js',
          directory + '/' + tmpname + '/assets/babel-top.js'
        );
        await fs.symlink(
            '../../../babel/babel-bottom.js',
            directory + '/' + tmpname + '/assets/babel-bottom.js'
        );
        // default support is for gh-pages
        if (domain == null && (gitDetails != null && gitDetails.user)) {
          domain = 'https://' + gitDetails.user + '.github.io/' + tmpname;
        } else if (domain != null) {
            // put domain into CNAME not the github.io address if that exists
            await fs.writeFileSync(directory + '/' + tmpname + '/CNAME', domain);
        }
      }
      catch(e) {}
    // load what we just created
    this.manifest = new JSONOutlineSchema();
    // where to save it to
    this.manifest.file = directory + '/' + tmpname + '/site.json';
    // start updating the schema to match this new item we got
    this.manifest.title = name;
    this.manifest.location = this.basePath + tmpname + '/index.html';
    this.manifest.metadata = {};
    this.manifest.metadata.author = {};
    this.manifest.metadata.site = {};
    this.manifest.metadata.site.settings = {};
    this.manifest.metadata.site.settings.lang = 'en';
    this.manifest.metadata.site.settings.canonical = true;
    this.manifest.metadata.site.settings.pathauto = true;
    this.manifest.metadata.site.name = tmpname;
    this.manifest.metadata.site.domain = domain;
    this.manifest.metadata.site.created = Math.floor(Date.now() / 1000);
    this.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
    this.manifest.metadata.theme = {};
    this.manifest.metadata.theme.variables = {};
    this.manifest.metadata.node = {};
    this.manifest.metadata.node.fields = {};
    this.manifest.items = [];
      // create an initial page to make sense of what's there
      // this will double as saving our location and other updated data
      // accept a schema which can generate an array of pages to start
      if (build == null) {
        await this.addPage(null, 'Welcome', 'init', 'welcome');
      }
      else {
        let pageSchema = [];
        switch (build.structure) {
          case 'from-skeleton':
          case 'import':
            // implies we had a backend service process much of what we are to build for an import
            // from-skeleton uses same structure as import but comes from skeleton files
            if (build.items) {
              for (let i=0; i < build.items.length; i++) {
                pageSchema.push({
                  "parent" : build.items[i]['parent'],
                  "title" : build.items[i]['title'],
                  "template" : "html",
                  "slug" : build.items[i]['slug'],
                  "id" : build.items[i]['id'],
                  "indent" : build.items[i]['indent'],
                  "contents" : build.items[i]['content'] || build.items[i]['contents'] || '',
                  "order" : build.items[i]['order'],
                  "metadata" : (build.items[i]['metadata']) ? build.items[i]['metadata'] : null,
              });
              }
            }
            for (let i=0; i < pageSchema.length; i++) {
              if (pageSchema[i]['template'] == 'html') {
                await this.addPage(
                  pageSchema[i]['parent'], 
                  pageSchema[i]['title'], 
                  pageSchema[i]['template'], 
                  pageSchema[i]['slug'],
                  pageSchema[i]['id'],
                  pageSchema[i]['indent'],
                  pageSchema[i]['contents'],
                  pageSchema[i]['order'],
                  pageSchema[i]['metadata'],
                );
              }
              else {
                await this.addPage(pageSchema[i]['parent'], pageSchema[i]['title'], pageSchema[i]['template'], pageSchema[i]['slug']);
              }
            }
          break;
          case 'course':
            pageSchema = [{ 
                "parent" : null,
                "title" : "Welcome to " + name,
                "template" : "course",
                "slug" : "welcome"
            }];
            switch (build.type) {
              case 'docx import':
                  // ensure we have items
                if (build.items) {
                  for (let i=0; i < build.items.length; i++) {
                    pageSchema.push({
                      "parent" : build.items[i]['parent'],
                      "title" : build.items[i]['title'],
                      "template" : "html",
                      "slug" : build.items[i]['slug'],
                      "id" : build.items[i]['id'],
                      "indent" : build.items[i]['indent'],
                      "contents" : build.items[i]['contents'],
                      "order" : build.items[i]['order'],
                      "metadata" : (build.items[i]['metadata']) ? build.items[i]['metadata'] : null,
                    });
                  }
                }
              break;
              case '6w':
                for (let i=0; i < 6; i++) {
                  pageSchema.push({
                    "parent" : null,
                    "title" : "Lesson " + (i+1),
                    "template" : "lesson",
                    "slug" : "lesson-" + (i+1)
                  });
                }
              break;
              case '15w':
                for (let i=0; i < 15; i++) {
                  pageSchema.push({
                    "parent" : null,
                    "title" : "Lesson " + (i+1),
                    "template" : "lesson",
                    "slug" : "lesson-" + (i+1)
                });
                }
              break;
              default:
                /*pageSchema.push({
                  "parent" : null,
                  "title" : "Lessons",
                  "template" : "default",
                  "slug" : "lessons"
                });*/
              break;
            }
            /*pageSchema.push({
              "parent" : null,
              "title" : "Glossary",
              "template" : "glossary",
              "slug" : "glossary"
            });*/
            for (let i=0; i < pageSchema.length; i++) {
              if (pageSchema[i]['template'] == 'html') {
                await this.addPage(
                  pageSchema[i]['parent'], 
                  pageSchema[i]['title'], 
                  pageSchema[i]['template'], 
                  pageSchema[i]['slug'],
                  pageSchema[i]['id'],
                  pageSchema[i]['indent'],
                  pageSchema[i]['contents'],
                  pageSchema[i]['order'],
                  pageSchema[i]['metadata'],
                );
              }
              else {
                await this.addPage(pageSchema[i]['parent'], pageSchema[i]['title'], pageSchema[i]['template'], pageSchema[i]['slug']);
              }
            }
          break;
          case 'blog':
            await this.addPage(null, 'Article 1', 'init', 'article-1');
            await this.addPage(null, 'Article 2', 'init', 'article-2');
            await this.addPage(null, 'Meet the author', 'init', 'meet-the-author');
          break;
          case 'website':
            switch (build.type) {
              default:
                await this.addPage(null, 'Home', 'init', 'home');
              break;
            }
          break;
          case 'collection':
            await this.addPage(null, 'Home', 'collection', 'home');
          break;
          case 'training':
            await this.addPage(null, 'Start', 'init', 'start');
            break;
          case 'portfolio':
            switch (build.type) {
              case 'art':
                await this.addPage(null, 'Gallery 1', 'init', 'gallery-1');
                await this.addPage(null, 'Gallery 2', 'init', 'gallery-2');
                await this.addPage(null, 'Meet the artist', 'init', 'meet-the-artist');
              break;
              case 'business':
              case 'technology':
              default:
                await this.addPage(null, 'Article 1', 'init', 'article-1');
                await this.addPage(null, 'Article 2', 'init', 'article-2');
                await this.addPage(null, 'Meet the author', 'init', 'meet-the-author');
              break;
            }
          break;
        }
      }
      try {
        // write the managed files to ensure we get happy copies
        await this.rebuildManagedFiles();
      }
      catch(e){}
      try {
        // put this in version control :) :) :)
        const git = new GitPlus({
          dir: directory + '/' + tmpname,
          cliVersion: await this.gitTest()
        });
        // initalize git repo
        await git.init();
        await git.add();
        await git.commit('A new journey begins: ' + this.manifest.title + ' (' + this.manifest.id + ')');
        if (
            !(this.manifest.metadata.site && this.manifest.metadata.site.git && this.manifest.metadata.site.git.url) &&
            (gitDetails != null && gitDetails.url)
        ) {
            await this.gitSetRemote(gitDetails);
        }
      }
      catch(e){
        console.warn(e);
      }
      return this;
    }
    /**
     * Return the forceUpgrade status which is whether to force end users to upgrade their browser
     * @return string status of forced upgrade, string as boolean since it'll get written into a JS file
     */
    getForceUpgrade() {
        if (this.manifest.metadata.site.settings.forceUpgrade) {
            return "true";
        }
        return "false";
    }
    /**
     * Return the sw status
     * @return string status of forced upgrade, string as boolean since it'll get written into a JS file
     */
    getServiceWorkerStatus() {
        if ((this.manifest.metadata.site.settings.sw) && this.manifest.metadata.site.settings.sw) {
            return true;
        }
        return false;
    }
    async gitTest() {
      try {
        const { stdout, stderr } = await exec('git --version');
        return stdout;
      } catch (e) {
        return null;
      }
    }
    /**
     * Return an array of files we care about rebuilding on managed file operations
     * @return array keyed array of files we wish to pull from the boilerplate and keep in sync
     */
    getManagedTemplateFiles() {
        return {
          // HAX core / application / PWA requirements
          'htaccess' : '.htaccess',
          'build' : 'build.js',
          'buildhaxcms' : 'build-haxcms.js',
          'outdated' : 'assets/upgrade-browser.html',
          'index' : 'index.html', // static published fallback
          'ghpages' : 'ghpages.html', // github pages publishing for custom theme work
          '404' : '404.html', // github / static published redirect appropriately
          // seo / performance
          'push' : 'push-manifest.json',
          'robots' : 'robots.txt',
          'llms' : 'llms.txt',
          'securitytxt' : '.well-known/security.txt',
          'apicatalog' : '.well-known/api-catalog',
          // pwa related files
          'msbc' : 'browserconfig.xml',
          'manifest' : 'manifest.json',
          'sw' : 'service-worker.js',
          'offline' : 'offline.html', // pwa offline page
          // local development tooling
          'webdevserverhaxcmsconfigcjs' : 'web-dev-server.haxcms.config.cjs',
          'package' : 'package.json',
          // SCORM 1.2
          'imsmdrootv1p2p1' : 'imsmd_rootv1p2p1.xsd',
          'imscprootv1p1p2' : 'imscp_rootv1p1p2.xsd',
          'adlcprootv1p2' : 'adlcp_rootv1p2.xsd',
          'imsxml' : 'ims_xml.xsd',
          'imsmanifest' : 'imsmanifest.xml',
          // files directory execution hardening
          'fileshtaccess' : 'files/.htaccess',
        };
    }
    /**
     * Build the default public base path for this site without protocol/host.
     */
    getDefaultSiteBasePath() {
      let basePath = '/';
      if (typeof this.basePath === 'string' && this.basePath !== '') {
        basePath = this.basePath;
      }
      if (basePath.substring(0, 1) !== '/') {
        basePath = '/' + basePath;
      }
      if (basePath.substring(basePath.length - 1) !== '/') {
        basePath += '/';
      }
      return basePath + this.manifest.metadata.site.name + '/';
    }
    /**
     * Reprocess the files that twig helps set in their static
     * form that the user is not in control of.
     */
    async rebuildManagedFiles() {
      let templates = this.getManagedTemplateFiles();
      // this can't be there by default since it's a dynamic file and we only
      // want to update this when we are refreshing the managed files directly
      // not the case w/ non php backends but still fine for consistency
      templates['indexphp'] = 'index.php';
      for (var key in templates) {
        const destinationPath = this.siteDirectory + '/' + templates[key];
        const destinationDirectory = path.dirname(destinationPath);
        if (!fs.pathExistsSync(destinationDirectory)) {
          fs.mkdirpSync(destinationDirectory);
        }
        await fs.copySync(HAXCMS.boilerplatePath + "/site/" + templates[key], destinationPath);
      }
      let licenseData = this.getLicenseData('all');
      let licenseLink = '';
      let licenseName = '';
      let domain = null;
      if ((this.manifest.license) && (licenseData[this.manifest.license])) {
        licenseLink = licenseData[this.manifest.license]['link'];
        licenseName = 'License: ' + licenseData[this.manifest.license]['name'];
      }
      if (this.manifest.metadata.site.domain) {
        domain = this.manifest.metadata.site.domain;
      }
      if (domain == null || domain == '') {
        let fallbackDomain = HAXCMS.getDomain();
        const siteBasePath = this.getDefaultSiteBasePath();
        if (!fallbackDomain || fallbackDomain == '') {
          domain = siteBasePath;
        }
        else {
          fallbackDomain = fallbackDomain.replace('iam.', 'oer.');
          if (!/^https?:\/\//.test(fallbackDomain)) {
            fallbackDomain = 'https://' + fallbackDomain;
          }
          domain = fallbackDomain.replace(/\/$/, '') + '/' + siteBasePath.replace(/^\//, '');
        }
      }
      if (domain.substring(domain.length - 1) != '/') {
        domain += '/';
      }
      let templateVars = {
          'hexCode': HAXCMS.HAXCMS_FALLBACK_HEX,
          'version': await HAXCMS.getHAXCMSVersion(),
          'basePath' :
              this.basePath + this.manifest.metadata.site.name + '/',
          'domain': domain,
          'title': this.manifest.title,
          'short': this.manifest.metadata.site.name,
          'privateSite' : this.manifest.metadata.site.settings.private,
          'description': this.manifest.description,
          'forceUpgrade': this.getForceUpgrade(),
          'swhash': [],
          'ghPagesURLParamCount': 0,
          'licenseLink': licenseLink,
          'licenseName': licenseName,
          'securityTxtExpires': new Date(Date.now() + (1000 * 60 * 60 * 24 * 180)).toISOString(),
          'serviceWorkerScript': this.getServiceWorkerScript(this.basePath + this.manifest.metadata.site.name + '/'),
          'bodyAttrs': this.getSitePageAttributes(),
          'metadata': await this.getSiteMetadata(),
          'logo512x512': await this.getLogoSize('512','512'),
          'logo256x256': await this.getLogoSize('256','256'),
          'logo192x192': await this.getLogoSize('192','192'),
          'logo144x144': await this.getLogoSize('144','144'),
          'logo96x96': await this.getLogoSize('96','96'),
          'logo72x72': await this.getLogoSize('72','72'),
          'logo48x48': await this.getLogoSize('48','48'),
          'favicon': await this.getLogoSize('32','32'),
      };
      let swItems = [...this.manifest.items];
      // the core files you need in every SW manifest
      let coreFiles = [
          'index.html',
          await this.getLogoSize('512','512'),
          await this.getLogoSize('256','256'),
          await this.getLogoSize('192','192'),
          await this.getLogoSize('144','144'),
          await this.getLogoSize('96','96'),
          await this.getLogoSize('72','72'),
          await this.getLogoSize('48','48'),
          'manifest.json',
          'site.json',
          '404.html',
      ];
      let handle;
      // loop through files directory so we can cache those things too
      if (handle = fs.readdirSync(this.siteDirectory + '/files')) {
        handle.forEach(file => {
          if (
              file != "." &&
              file != ".." &&
              file != '.gitkeep' &&
              file != '.DS_Store' &&
              file != '.htaccess'
          ) {
            // ensure this is a file
            if (
              fs.lstatSync(this.siteDirectory + '/files/' + file).isFile()
            ) {
                coreFiles.push('files/' + file);
            } else {
                // @todo maybe step into directories?
            }
          }
        });
      }
      for (var key in coreFiles) {
          let coreItem = {};
          coreItem.location = coreFiles[key];
          swItems.push(coreItem);
      }
      // generate a legit hash value that's the same for each file name + file size
      for (var key in swItems) {
        let filesize;
        let item = swItems[key];
        if (
            item.location === '' ||
            item.location === templateVars['basePath']
        ) {
            filesize = await fs.statSync(
              this.siteDirectory + '/index.html'
            ).size;
        } else if (
          fs.pathExistsSync(this.siteDirectory + '/' + item.location) &&
          fs.lstatSync(this.siteDirectory + '/' + item.location).isFile()
        ) {
            filesize = await fs.statSync(
              this.siteDirectory + '/' + item.location
            ).size;
        } else {
            // ?? file referenced but doesn't exist
            filesize = 0;
        }
        if (filesize !== 0) {
          templateVars['swhash'].push([
              item.location,
              strtr(
                HAXCMS.hmacBase64(
                      item.location + filesize,
                      'haxcmsswhash',
                  ),
                  {
                      '+':'',
                      '/':'',
                      '=':'',
                      '-':''
                  }
              )
          ]);
        }
      }
      if ((this.manifest.metadata.theme.variables.hexCode)) {
        templateVars['hexCode'] = this.manifest.metadata.theme.variables.hexCode;
      }
      // put the twig written output into the file
      var Twig = require('twig');
      for (var key in templates) {
        // ensure files exist before going to write them
          if (await fs.lstatSync(this.siteDirectory + '/' + templates[key]).isFile()) {
            try {
              let fileData = await fs.readFileSync(this.siteDirectory + '/' + templates[key],
                {encoding:'utf8', flag:'r'}, 'utf8');
              let template = await Twig.twig({data: fileData, async: false});
              let templatedHTML = template.render(templateVars);
              await fs.writeFileSync(this.siteDirectory + '/' + templates[key], templatedHTML);           
            }
            catch(e) {}
          }
      }
      try {
        await this.updateAlternateFormats('llms');
      }
      catch (e) {}
    }
    /**
     * Rename a page from one location to another
     * This ensures that folders are moved but not the final index.html involved
     * It also helps secure the sites by ensuring movement is only within
     * their folder tree
     */
    async renamePageLocation(oldItem, newItem) {        
        oldItem = oldItem.replace('./', '').replace('../', '');
        newItem = newItem.replace('./', '').replace('../', '');
        // ensure the path to the new folder is valid
        if (await fs.pathExistsSync(this.siteDirectory + '/' + oldItem) &&
          await fs.lstatSync(this.siteDirectory + '/' + oldItem).isFile()) {
            await fs.moveSync(
              this.siteDirectory + '/' + oldItem.replace('/index.html', ''),
              this.siteDirectory + '/' + newItem.replace('/index.html', '')
            );
            await fs.unlinkSync(this.siteDirectory + '/' + oldItem);
        }
    }
    /**
     * Basic wrapper to commit current changes to version control of the site
     */
    async gitCommit(msg = 'Committed changes')
    {
        try {
          // commit, true flag will attempt to make this a git repo if it currently isn't
          const git = new GitPlus({
            dir: this.siteDirectory,
            cliVersion: await this.gitTest()
          });
          await git.add();
          await git.commit(msg);
          // commit should execute the automatic push flag if it's on
          if ((this.manifest.metadata.site.git.autoPush) && this.manifest.metadata.site.git.autoPush && (this.manifest.metadata.site.git.branch)) {
            await git.checkout(this.manifest.metadata.site.git.branch);
            await git.push();
          }
        }
        catch(e){}
        return true;
    }
    /**
     * Basic wrapper to revert top commit of the site
     */
    async gitRevert(count = 1)
    {
      try {
        const git = new GitPlus({
          dir: this.siteDirectory,
          cliVersion: await this.gitTest()
        });
        await git.revert(count);
      }
      catch(e){}
      return true;
    }
    /**
     * Basic wrapper to commit current changes to version control of the site
     */
    async gitPush()
    {
      try {
        const git = new GitPlus({
          dir: this.siteDirectory,
          cliVersion: await this.gitTest()
        });
        await git.add();
        await git.commit("commit forced");
        await git.push();
      }
      catch(e){}
      return true;
    }

    /**
     * Basic wrapper to commit current changes to version control of the site
     *
     * @var git a stdClass containing repo details
     */
    async gitSetRemote(gitDetails)
    {
      try {
        const git = new GitPlus({
          dir: this.siteDirectory,
          cliVersion: await this.gitTest()
        });
        await repo.setRemote("origin", gitDetails.url);
      }
      catch(e){}
      return true;
    }
    /**
     * Add a page to the site's file system and reflect it in the outine schema.
     *
     * @var parent JSONOutlineSchemaItem representing a parent to add this page under
     * @var title title of the new page to create
     * @var template string which boilerplate page template / directory to load
     *
     * @return page repesented as JSONOutlineSchemaItem
     */
    async addPage(parent = null, title = 'New page', template = "default", slug = 'welcome', id = null, indent = null, html = '<p></p>', order = null, metadata = null)
    {
        // draft an outline schema item
        let page = new JSONOutlineSchemaItem();
        // support direct ID setting, useful for parent associations calculated ahead of time
        if (id) {
          page.id = id;
        }
        // set a crappy default title
        page.title = title;
        if (parent == null) {
          page.parent = null;
          page.indent = 0;
        }
        else if (typeof parent === 'string' || parent instanceof String) {
          // set to the parent id
          page.parent = parent;
          // move it one indentation below the parent; this can be changed later if desired
          page.indent = indent;
        } else {
          // set to the parent id
          page.parent = parent.id;
          // move it one indentation below the parent; this can be changed later if desired
          page.indent = parent.indent + 1;
        }
        // set order to the page's count for default add to end ordering
        if (order || order === 0) {
          page.order = order;
        }
        else {
          page.order = this.manifest.items.length;
        }
        // location is the html file we just copied and renamed
        page.location = 'pages/' + page.id + '/index.html';
        // sanitize slug but dont trust it was anything
        if (slug == '') {
          slug = title;
        }
        page.slug = this.getUniqueSlugName(HAXCMS.cleanTitle(slug));
        // support presetting multiple metadata attributes like tags, pageType, etc
        if (metadata) {
          for (const key in metadata) {
            let value = metadata[key]
            page.metadata[key] = value;
          }
        }
        page.metadata.created = Math.floor(Date.now() / 1000);
        page.metadata.updated = Math.floor(Date.now() / 1000);
        let location = path.join(this.siteDirectory, 'pages', page.id);
        // copy the page we use for simplicity (or later complexity if we want)
        switch (template) {
            case 'course':
            case 'glossary':
            case 'collection':
            case 'init':
            case 'lesson':
            case 'default':
              await HAXCMS.recurseCopy(HAXCMS.boilerplatePath + 'page/' + template, location);
            break;
            // didn't understand it, just go default
            default:
              await HAXCMS.recurseCopy(HAXCMS.boilerplatePath + 'page/default', location);
            break;
        }
        this.manifest.addItem(page);
        this.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
        await this.manifest.save();
        // support direct HTML setting
        let alternateContent = '';
        if (template == 'html') {
          // now this should exist if it didn't a minute ago
          alternateContent = sanitizeHTMLForStorage(html);
          let bytes = page.writeLocation(
            alternateContent,
            this.siteDirectory
          );
        }
        this.writePageAlternateFormats(page, alternateContent);
        this.updateAlternateFormats();
        return page;
    }
    /**
     * Save the site, though this basically is just a mapping to the manifest site.json saving
     */
    async save(reorder = true) {
      await this.manifest.save(reorder);
    }
    /**
     * Update RSS, Atom feeds, site map, legacy outline, search index
     * which are physical files and need rebuilt on chnages to data structure
     */
    async updateAlternateFormats(format = null)
    {
        let rss = new FeedMe();
        let domain = null;
        if (this.manifest.metadata.site.domain) {
          domain = this.manifest.metadata.site.domain;
        }
        if (domain == null || domain == '') {
          // mirror PHP fallback behavior for generated feeds
          let fallbackDomain = HAXCMS.getDomain();
          const siteBasePath = this.getDefaultSiteBasePath();
          if (!fallbackDomain || fallbackDomain == '') {
            domain = siteBasePath;
          }
          else {
            fallbackDomain = fallbackDomain.replace('iam.', 'oer.');
            if (!/^https?:\/\//.test(fallbackDomain)) {
              fallbackDomain = 'https://' + fallbackDomain;
            }
            domain = fallbackDomain.replace(/\/$/, '') + '/' + siteBasePath.replace(/^\//, '');
          }
        }
        if (format == null || format == 'rss') {
            try {
              fs.writeFileSync(this.siteDirectory + '/rss.xml', rss.getRSSFeed(this, domain));
              fs.writeFileSync(
                this.siteDirectory + '/atom.xml',
                rss.getAtomFeed(this, domain)
              );
            }
            catch (e) {
              // keep parity with PHP behavior: never hard fail a save on feed serialization
            }
        }
        if (format == null || format == 'sitemap') {
            try {
              if (domain != null && domain != '') {
                fs.writeFileSync(this.siteDirectory + '/sitemap.xml', rss.getSitemap(this, domain));
                fs.writeFileSync(
                  this.siteDirectory + '/sitemap-index.xml',
                  rss.getSitemapIndex(domain)
                );
              }
            }
            catch (e) {
              // keep parity with PHP behavior: never hard fail a save on sitemap serialization
            }
        }
        if (format == null || format == 'search') {
            // now generate the search index
            await fs.writeFileSync(
              this.siteDirectory + '/lunrSearchIndex.json',
                    json_encode(await this.lunrSearchIndex(this.manifest.items))
            );
        }
        if (format == null || format == 'llms') {
            try {
              fs.writeFileSync(this.siteDirectory + '/llms.txt', this.getLLMSTxt(domain));
            }
            catch (e) {
              // keep parity with PHP behavior: never hard fail a save on llms serialization
            }
        }
    }
    /**
     * Generate llms.txt content based on site structure and generated markdown pages.
     */
    getLLMSTxt(domain = '') {
      let title = this.getLLMSSafeText(this.manifest.title);
      if (title == '') {
        title = this.getLLMSSafeText(this.name);
      }
      if (title == '') {
        title = 'HAXcms site';
      }
      let lines = ['# ' + title];
      let description = this.getLLMSSafeText(this.manifest.description);
      if (description != '') {
        lines.push('');
        lines.push('> ' + description);
      }
      lines.push('');
      lines.push('HAXcms is a file-based CMS: authored pages and metadata are stored as portable files, not locked into a database-only workflow.');
      lines.push('The canonical site structure is `site.json`, represented in JSON Outline Schema (`id`, `parent`, `order`, `slug`, `location`, and `metadata`).');
      lines.push('Use HAX CLI and ecosystem tooling to maintain human-authored content while keeping machine-readable outputs synchronized.');
      lines.push('Managed files (feeds, search indexes, manifests, and this `llms.txt`) are generated artifacts and should be rebuilt by tooling.');
      lines.push('');
      lines.push('## Core resources');
      lines.push('- [site.json](' + this.getLLMSResourceURL(domain, 'site.json') + '): Canonical site manifest and navigation tree in JSON Outline Schema format.');
      lines.push('- [llms.txt](' + this.getLLMSResourceURL(domain, 'llms.txt') + '): LLM-oriented guide to this site and its machine-readable resources.');
      lines.push('');
      lines.push('## Pages');
      let items = [];
      if (this.manifest && this.manifest.items) {
        items = this.manifest.orderTree(this.manifest.items);
      }
      let hasPages = false;
      for (let key in items) {
        let item = items[key];
        if (!item || !item.location) {
          continue;
        }
        let markdownLocation = this.getPageAlternateLocation(item.location, 'md');
        if (markdownLocation == '') {
          continue;
        }
        let itemTitle = this.getLLMSSafeLinkText(item.title || item.slug || item.id || 'Untitled page');
        let itemDescription = this.getLLMSSafeText(item.description);
        let line = '- [' + itemTitle + '](' + this.getLLMSResourceURL(domain, markdownLocation) + ')';
        if (itemDescription != '') {
          line += ': ' + itemDescription;
        }
        lines.push(line);
        hasPages = true;
      }
      if (!hasPages) {
        lines.push('- [Site outline](' + this.getLLMSResourceURL(domain, 'site.json') + '): No page markdown files are currently available.');
      }
      lines.push('');
      lines.push('## Optional');
      lines.push('- [Search index](' + this.getLLMSResourceURL(domain, 'lunrSearchIndex.json') + '): Lunr corpus for quick full-text retrieval.');
      lines.push('- [RSS feed](' + this.getLLMSResourceURL(domain, 'rss.xml') + '): Site updates in RSS format.');
      lines.push('- [Atom feed](' + this.getLLMSResourceURL(domain, 'atom.xml') + '): Site updates in Atom format.');
      lines.push('- [Sitemap](' + this.getLLMSResourceURL(domain, 'sitemap.xml') + '): URL-level discovery map for the published site.');
      return lines.join('\n') + '\n';
    }
    /**
     * Build a normalized llms.txt link URL from domain/base and a relative resource path.
     */
    getLLMSResourceURL(domain = '', location = '') {
      let baseURL = this.getLLMSBaseURL(domain);
      let cleanLocation = '';
      if (typeof location === 'string') {
        cleanLocation = location.replace(/\\/g, '/').replace(/^\/+/, '');
      }
      if (cleanLocation == '') {
        return baseURL;
      }
      if (baseURL == '/') {
        return '/' + cleanLocation;
      }
      return baseURL + cleanLocation;
    }
    /**
     * Normalize domain/base values into a URL-safe prefix for llms.txt links.
     */
    getLLMSBaseURL(domain = '') {
      let baseURL = '';
      if (typeof domain === 'string') {
        baseURL = domain.trim();
      }
      if (baseURL == '') {
        return '/';
      }
      if (!/^https?:\/\//.test(baseURL) && baseURL.substring(0, 1) != '/') {
        baseURL = '/' + baseURL;
      }
      if (baseURL.substring(baseURL.length - 1) != '/') {
        baseURL += '/';
      }
      return baseURL;
    }
    /**
     * Normalize text for llms.txt body content.
     */
    getLLMSSafeText(value = '') {
      if (value == null || typeof value === 'undefined') {
        return '';
      }
      let text = String(value);
      return text.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    }
    /**
     * Normalize markdown link text and escape bracket characters.
     */
    getLLMSSafeLinkText(value = '') {
      let text = this.getLLMSSafeText(value);
      if (text == '') {
        text = 'Untitled page';
      }
      return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    }
    /**
     * Create Lunr.js style search index
     */
    async lunrSearchIndex(items) {
      let data = [];
      let textData;
      for (var key in items) {
        let item = items[key];
        let created = Math.floor(Date.now() / 1000);
        if ((item.metadata) && (item.metadata.created)) {
          created = item.metadata.created;
        }
        textData = '';
        try {
          textData = await fs.readFileSync(path.join(this.siteDirectory, item.location),
          {encoding:'utf8', flag:'r'});
          textData = this.cleanSearchData(textData);
          // may seem silly but IDs in lunr have a size limit for some reason in our context..
          data.push({
            "id":item.id.replace('-', '').replace('item-', '').substring(0, 29),
            "title":item.title,
            "created":created,
            "location": item.slug,
            "description":item.description,
            "text":textData,
          });
        }
        catch(e) {}
      }
      return data;
    }
    /**
     * Clean up data from a file and make it easy for us to index on the front end
     */
    cleanSearchData(text) {
      if (text == '' || text == null || !text) {
        return '';
      }
      // clean up initial, small, trim, replace end lines, utf8 no tags
      text = utf8.encode(text.replace(/(<([^>]+)>)/ig,"").replace("\n", ' ').toLowerCase().trim());
      // all weird chars
      text = text.replace('/[^a-z0-9\']/', ' ');
      text = text.replace("'", '');
      // all words 1 to 4 letters long
      text = text.replace('~\b[a-z]{1,4}\b\s*~', '');
      // all excess white space
      text = text.replace('/\s+/', ' ');
      // crush string to array and back to make an unique index
      text = implode(' ', array_unique(explode(' ', text)));
      return text;
    }
    /**
     * Sort items by a certain key value. Must be in the included list for safety of the sort
     * @var string key - the key name to sort on, only some supported
     * @var string dir - direction to sort, ASC default or DESC to reverse
     * @return array items - sorted items based on the key used
     */
    sortItems(key, dir = 'ASC') {
        let items = [];
        if (Array.isArray(this.manifest.items)) {
          for (var itemKey in this.manifest.items) {
            let item = this.manifest.items[itemKey];
            if (item && typeof item === 'object') {
              items.push(item);
            }
          }
        }
        else if (this.manifest.items && typeof this.manifest.items === 'object') {
          for (var objKey in this.manifest.items) {
            let item = this.manifest.items[objKey];
            if (item && typeof item === 'object') {
              items.push(item);
            }
          }
        }
        let sortDir = 'ASC';
        if (dir == 'DESC') {
          sortDir = 'DESC';
        }
        switch (key) {
            case 'created':
            case 'updated':
            case 'readtime':
              usort(items, function (a, b) {
                let aMeta = {};
                let bMeta = {};
                if (a.metadata && typeof a.metadata === 'object') {
                  aMeta = a.metadata;
                }
                if (b.metadata && typeof b.metadata === 'object') {
                  bMeta = b.metadata;
                }
                let aValue = Number(aMeta[key]);
                let bValue = Number(bMeta[key]);
                if (isNaN(aValue)) {
                  aValue = 0;
                }
                if (isNaN(bValue)) {
                  bValue = 0;
                }
                if (aValue === bValue) {
                  return 0;
                }
                if (sortDir == 'DESC') {
                  return aValue > bValue ? -1 : 1;
                }
                return aValue < bValue ? -1 : 1;
              });
            break;
            case 'id':
            case 'title':
            case 'indent':
            case 'location':
            case 'order':
            case 'parent':
            case 'description':
                usort(items, function (a, b) {
                  let aValue = '';
                  let bValue = '';
                  if (typeof a[key] !== 'undefined' && a[key] !== null) {
                    aValue = String(a[key]);
                  }
                  if (typeof b[key] !== 'undefined' && b[key] !== null) {
                    bValue = String(b[key]);
                  }
                  if (aValue === bValue) {
                    return 0;
                  }
                  if (sortDir == 'DESC') {
                    return aValue > bValue ? -1 : 1;
                  }
                  return aValue < bValue ? -1 : 1;
                });
            break;
        }
        return items;
    }
    /**
     * Build a JOS into a tree of links recursively
     */
    treeToNodes(current, rendered = [], html = '')
    {
        let loc = '';
        for (var key in current) {
            let item = this.manifest.items[key];
            if (!array_search(item.id, rendered)) {
                loc +=`<li><a href="${item.location}" target="content">${item.title}</a>`;
                rendered.push(item.id);
                let children = [];
                for (var key2 in this.manifest.items) {
                    let child = this.manifest.items[key2];
                    if (child.parent == item.id) {
                        children.push(child);
                    }
                }
                // sort the kids
                usort(children, function (a, b) {
                    return a.order > b.order;
                });
                // only walk deeper if there were children for this page
                if (children.length > 0) {
                    loc += this.treeToNodes(children, rendered);
                }
                loc += '</li>';
            }
        }
        // make sure we aren't empty here before wrapping
        if (loc != '') {
            loc = '<ul>' + loc + '</ul>';
        }
        return html + loc;
    }
    /**
     * Load node by unique id
     */
    loadNode(uuid)
    {
      for (var key in this.manifest.items) {
        let item = this.manifest.items[key];
        if (item.id == uuid) {
          return item;
        }
      }
      return false;
    }
    /**
     * Get a social sharing image based on context of page or site having media
     * @var string page page to mine the image from or attempt to
     * @return string full URL to an image
     */
    getSocialShareImage(page = null) {
      // resolve a JOS Item vs null
      let id = null;
      if (page != null) {
        id = page.id;
      }
      let fileName;
      if (!(fileName)) {
        if (page == null) {
          page = this.loadNodeByLocation();
        }
        if (page && page.metadata && page.metadata.files) {
          for (var key in page.metadata.files) {
            let file = page.metadata.files[key];
            if (file.type == 'image/jpeg') {
              fileName = file.fullUrl;
            }
          }
        }
        // look for the theme banner
        if ((this.manifest.metadata.theme.variables.image)) {
          fileName = this.manifest.metadata.theme.variables.image;
        }
      }
      return fileName;
    }
    /**
     * Return attributes for the site
     * @todo make this mirror the drupal get attributes method
     * @return string eventually, array of data keyed by type of information
     */
    getSitePageAttributes() {
      return 'vocab="http://schema.org/" prefix="oer:http://oerschema.org cc:http://creativecommons.org/ns dc:http://purl.org/dc/terms/"';
    }
    /**
     * Return the base tag accurately which helps with the PWA / SW side of things
     * @return string HTML blob for hte <base> tag
     */
    getBaseTag() {
      return '<base href="' + this.basePath + this.name + '/" />';
    }
    /**
     * Return a standard service worker that takes into account
     * the context of the page it's been placed on.
     * @todo this will need additional vetting based on the context applied
     * @return string <script> tag that will be a rather standard service worker
     */
    getServiceWorkerScript(basePath = null, ignoreDevMode = false, addSW = true) {
      // because this can screw with caching, let's make sure we
      // can throttle it locally for developers as needed
      if (!addSW || (HAXCMS.developerMode && !ignoreDevMode)) {
        return "\n  <!-- Service worker disabled via settings -->\n";
      }
      // support dynamic calculation
      if (basePath == null) {
        basePath = this.basePath + this.name + '/';
      }
      return `
      <script>
        if ('serviceWorker' in navigator) {
          var sitePath = '{basePath}';
          // discover this path downstream of the root of the domain
          var swScope = window.location.pathname.substring(0, window.location.pathname.indexOf(sitePath)) + sitePath;
          if (swScope != document.head.getElementsByTagName('base')[0].href) {
            document.head.getElementsByTagName('base')[0].href = swScope;
          }
          window.addEventListener('load', function () {
            navigator.serviceWorker.register('service-worker.js', {
              scope: swScope
            }).then(function (registration) {
              registration.onupdatefound = function () {
                // The updatefound event implies that registration.installing is set; see
                // https://slightlyoff.github.io/ServiceWorker/spec/service_worker/index.html#service-worker-container-updatefound-event
                var installingWorker = registration.installing;
                installingWorker.onstatechange = function () {
                  switch (installingWorker.state) {
                    case 'installed':
                      if (!navigator.serviceWorker.controller) {
                        window.dispatchEvent(new CustomEvent('haxcms-toast-show', {
                          bubbles: true,
                          cancelable: false,
                          detail: {
                            text: 'Pages you view are cached for offline use.',
                            duration: 5000
                          }
                        }));
                      }
                    break;
                    case 'redundant':
                      throw Error('The installing service worker became redundant.');
                    break;
                  }
                };
              };
            }).catch(function (e) {
              console.warn('Service worker registration failed:', e);
            });
            // Check to see if the service worker controlling the page at initial load
            // has become redundant, since this implies there's a new service worker with fresh content.
            if (navigator.serviceWorker.controller) {
              navigator.serviceWorker.controller.onstatechange = function(event) {
                if (event.target.state === 'redundant') {
                  var b = document.createElement('paper-button');
                  b.appendChild(document.createTextNode('Reload'));
                  b.raised = true;
                  b.addEventListener('click', function(e){ window.location.reload(true); });
                  window.dispatchEvent(new CustomEvent('haxcms-toast-show', {
                    bubbles: true,
                    cancelable: false,
                    detail: {
                      text: 'A site update is available. Reload for latest content.',
                      duration: 8000,
                      slot: b,
                      clone: false
                    }
                  }));
                }
              };
            }
          });
        }
      </script>`;
    }
    /**
     * Load content of this page
     * @var JSONOutlineSchemaItem page - a loaded page object
     * @return string HTML / contents of the page object
     */
    async getPageContent(page) {
      if ((page.location) && page.location != '') {
        return filter_var(await fs.readFileSync(path.join(this.siteDirectory, page.location),
        {encoding:'utf8', flag:'r'}));
      }
    }
    /**
     * Generate per-page alternate formats in the same folder as index.html.
     * This is best-effort and never throws.
     */
    async writePageAlternateFormats(page, htmlContent = '') {
      if (!page || !page.location || page.location == '' || !this.siteDirectory) {
        return false;
      }
      let content = '';
      if (typeof htmlContent === 'string' && htmlContent != '') {
        content = htmlContent;
      }
      else {
        try {
          content = await this.getPageContent(page);
        }
        catch (e) {
          content = '';
        }
      }
      if (typeof content !== 'string' || content == '') {
        content = '<p></p>';
      }
      // Markdown
      try {
        let markdown = turndownService.turndown(content);
        let markdownLocation = this.getPageAlternateLocation(page.location, 'md');
        fs.writeFileSync(path.join(this.siteDirectory, markdownLocation), markdown);
      }
      catch (e) {}
      // JSON
      try {
        let jsonPayload = this.getPageAlternatePayload(page, content, 'json');
        fs.writeFileSync(
          path.join(this.siteDirectory, jsonPayload.location),
          JSON.stringify(jsonPayload, null, 2)
        );
      }
      catch (e) {}
      // YAML
      try {
        let yamlPayload = this.getPageAlternatePayload(page, content, 'yaml');
        fs.writeFileSync(
          path.join(this.siteDirectory, yamlPayload.location),
          jsyaml.dump(yamlPayload)
        );
      }
      catch (e) {}
      // XML
      try {
        let xmlPayload = this.getPageAlternatePayload(page, content, 'xml');
        fs.writeFileSync(
          path.join(this.siteDirectory, xmlPayload.location),
          this.getPageAlternateXML(xmlPayload)
        );
      }
      catch (e) {}
      return true;
    }
    /**
     * Build structured payload with location set for extension.
     */
    getPageAlternatePayload(page, content, extension = 'json') {
      let payload = {};
      try {
        payload = JSON.parse(JSON.stringify(page));
      }
      catch (e) {
        payload = {};
      }
      payload.location = this.getPageAlternateLocation(page.location, extension);
      payload.content = content;
      return payload;
    }
    /**
     * Derive alternate file location from page location.
     */
    getPageAlternateLocation(location = '', extension = 'json') {
      if (typeof location !== 'string' || location == '') {
        return '';
      }
      let cleanExtension = String(extension).replace(/^\./, '').toLowerCase();
      let normalizedLocation = location.replace(/\\/g, '/');
      if (/\.html?$/i.test(normalizedLocation)) {
        return normalizedLocation.replace(/\.html?$/i, '.' + cleanExtension);
      }
      return normalizedLocation + '.' + cleanExtension;
    }
    /**
     * Build HTML <link rel="alternate"> tags for available page sidecar formats.
     */
    getPageAlternateLinkTags(page = null, canonicalPath = '') {
      if (
        !page ||
        !page.slug ||
        typeof page.slug !== 'string' ||
        page.slug == '' ||
        !this.siteDirectory
      ) {
        return '';
      }
      let basePath = canonicalPath;
      if (typeof basePath !== 'string' || basePath == '') {
        basePath = '/' + String(page.slug).replace(/^\/+/, '').replace(/\/+$/, '');
      }
      basePath = String(basePath).replace(/\/+$/, '');
      if (basePath == '') {
        return '';
      }
      const formatMimeMap = {
        html: 'text/html',
        md: 'text/markdown',
        json: 'application/json',
        yaml: 'application/yaml',
        xml: 'application/xml',
      };
      let tags = '';
      for (let format in formatMimeMap) {
        let variantLocation = this.getPageAlternateLocation(page.location, format);
        if (!variantLocation) {
          continue;
        }
        let variantPath = path.join(this.siteDirectory, variantLocation);
        if (fs.pathExistsSync(variantPath) && fs.lstatSync(variantPath).isFile()) {
          tags +=
            '  <link rel="alternate" type="' +
            escapeHTMLAttribute(formatMimeMap[format]) +
            '" href="' +
            escapeHTMLAttribute(basePath + '.' + format) +
            '" />' +
            "\n";
        }
      }
      return tags;
    }
    /**
     * Generate XML output for per-page structured payload.
     */
    getPageAlternateXML(payload = {}) {
      let xml = '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<item>';
      for (let key in payload) {
        xml += this.getPageAlternateXMLNode(key, payload[key]);
      }
      xml += '\n</item>\n';
      return xml;
    }
    /**
     * Serialize a payload node to XML recursively.
     */
    getPageAlternateXMLNode(key, value) {
      let tagName = this.getSafeXMLTagName(key);
      if (key == 'content') {
        return '\n<' + tagName + '><![CDATA[' + this.getSafeCDATA(value) + ']]></' + tagName + '>';
      }
      if (Array.isArray(value)) {
        let output = '';
        for (let i = 0; i < value.length; i++) {
          output += this.getPageAlternateXMLNode('item', value[i]);
        }
        return '\n<' + tagName + '>' + output + '\n</' + tagName + '>';
      }
      if (value && typeof value === 'object') {
        let output = '';
        for (let childKey in value) {
          output += this.getPageAlternateXMLNode(childKey, value[childKey]);
        }
        return '\n<' + tagName + '>' + output + '\n</' + tagName + '>';
      }
      if (value === null || typeof value === 'undefined') {
        return '\n<' + tagName + '></' + tagName + '>';
      }
      return '\n<' + tagName + '>' + escapeXMLValue(String(value)) + '</' + tagName + '>';
    }
    /**
     * Ensure XML tags are valid and deterministic.
     */
    getSafeXMLTagName(name = '') {
      let tagName = String(name).replace(/[^a-zA-Z0-9_-]/g, '-');
      if (tagName == '') {
        tagName = 'item';
      }
      if (/^[0-9]/.test(tagName)) {
        tagName = 'item-' + tagName;
      }
      return tagName;
    }
    /**
     * Prevent CDATA breakouts.
     */
    getSafeCDATA(value = '') {
      return String(value).replace(/\]\]>/g, ']]]]><![CDATA[>');
    }
    /**
     * Generate the stub of a well formed site.json item
     * based on parameters
     */
    itemFromParams(params) {
      // get a new item prototype
      let item = HAXCMS.outlineSchema.newItem();
      let cleanTitle = '';
      // set the title
      item.title = params['node']['title'].replace("\n", '');
      if ((params['node']['id']) && params['node']['id'] != '' && params['node']['id'] != null) {
          item.id = params['node']['id'];
      }
      item.location = 'pages/' + item.id + '/index.html';
      if ((params['indent']) && params['indent'] != '' && params['indent'] != null) {
          item.indent = params['indent'];
      }
      if ((params['order']) && params['order'] != '' && params['order'] != null) {
          item.order = params['order'];
      }
      if ((params['parent']) && params['parent'] != '' && params['parent'] != null) {
          item.parent = params['parent'];
      } else {
          item.parent = null;
      }
      if ((params['description']) && params['description'] != '' && params['description'] != null) {
          item.description = params['description'].replace("\n", '');
      }
      if ((params['metadata']) && params['metadata'] != '' && params['metadata'] != null) {
          item.metadata = params['metadata'];
      }
      if (typeof params['node']['location'] !== 'undefined' && params['node']['location'] != '' && params['node']['location'] != null) {
        cleanTitle = HAXCMS.cleanTitle(params['node']['location']);
        item.slug = this.getUniqueSlugName(cleanTitle);
      } else {
        cleanTitle = HAXCMS.cleanTitle(item.title);
        item.slug = this.getUniqueSlugName(cleanTitle, item, true);
      }
      item.metadata.created = Math.floor(Date.now() / 1000);
      item.metadata.updated = Math.floor(Date.now() / 1000);
      return item;
    }
    /**
     * Return accurate, rendered site metadata
     * @var JSONOutlineSchemaItem page - a loaded page object, most likely whats active
     * @return string an html chunk of tags for the head section
     * @todo move this to a render function / section / engine
     */
    async getSiteMetadata(page = null, domain = null, cdn = '', canonicalPath = '') {
      const escapeHtml = (value) => escapeHTMLAttribute(value);
      const sanitizeUrl = (value) => sanitizeURLValue(value, '');
      if (page == null) {
        page = new JSONOutlineSchemaItem();
      }
      // domain's need to inject their own full path for OG metadata (which is edge case)
      // most of the time this is the actual usecase so use the active path
      if (domain == null) {
        domain = HAXCMS.getURI();
      }
      // support preconnecting CDNs, sets us up for dynamic CDN switching too
      let preconnect = '';
      let base = './';
      if (cdn == '' && HAXCMS.cdn != './') {
        preconnect = `<link rel="preconnect" crossorigin href="${escapeHtml(sanitizeUrl(HAXCMS.cdn))}" />`;
        cdn = HAXCMS.cdn;
      }
      if (cdn != '') {
        // preconnect for faster DNS lookup
        preconnect = `<link rel="preconnect" crossorigin href="${escapeHtml(sanitizeUrl(cdn))}" />`;
        // preload rewrite correctly
        base = sanitizeUrl(cdn);
      }
      let title = page.title;
      let siteTitle = this.manifest.title + ' | ' + page.title;
      let description = page.description;
      let hexCode = HAXCMS.HAXCMS_FALLBACK_HEX;
      let robots;
      let canonical;
      if (description == '') {
        description = this.manifest.description;
      }
      if (title == '' || title == 'New item') {
        title = this.manifest.title;
        siteTitle = this.manifest.title;
      }
      if ((this.manifest.metadata.theme.variables.hexCode)) {
          hexCode = this.manifest.metadata.theme.variables.hexCode;
      }
      // if we have a privacy flag, then tell robots not to index this were it to be found
      // which in HAXiam this isn't possible
      if (this.manifest.metadata.site.settings.private) {
        robots = '<meta name="robots" content="none" />';
      }
      else {
        robots = '<meta name="robots" content="index, follow" />';
      }
      // canonical flag, if set we use domain and canonicalPath context
      let canonicalBase = sanitizeUrl(domain);
      if (this.manifest.metadata.site.domain && this.manifest.metadata.site.domain != '') {
        canonicalBase = sanitizeUrl(this.manifest.metadata.site.domain);
      }
      let canonicalUrl = canonicalBase;
      if (this.manifest.metadata.site.settings.canonical) {
        if (canonicalPath && canonicalPath != '') {
          const normalizedCanonicalPath = String(canonicalPath).substring(0, 1) === '/'
            ? String(canonicalPath)
            : '/' + String(canonicalPath);
          if (/^https?:\/\//i.test(canonicalBase)) {
            const originMatch = String(canonicalBase).match(/^https?:\/\/[^/]+/i);
            if (originMatch && originMatch[0]) {
              canonicalUrl = sanitizeUrl(originMatch[0] + normalizedCanonicalPath);
            }
            else {
              canonicalUrl = sanitizeUrl(String(canonicalBase).replace(/\/+$/, '') + normalizedCanonicalPath);
            }
          }
          else {
            canonicalUrl = sanitizeUrl(String(canonicalBase).replace(/\/+$/, '') + normalizedCanonicalPath);
          }
        }
        else if (
          this.manifest.metadata.site.domain &&
          this.manifest.metadata.site.domain != '' &&
          page.slug &&
          page.slug != ''
        ) {
          canonicalUrl = sanitizeUrl(
            String(this.manifest.metadata.site.domain).replace(/\/+$/, '') +
            '/' +
            String(page.slug).replace(/^\/+/, '')
          );
        }
        canonical = '  <link rel="canonical" href="' + escapeHtml(canonicalUrl) + '" />' + "\n";
      }
      else {
        canonical = '';
      }
      let prevResource = '';
      let nextResource = '';
      // if we have a place in the array bc it's a page, then we can get next / prev
      if (page.id && this.manifest.getItemKeyById(page.id) !== false) {
        let currentId = this.manifest.getItemKeyById(page.id);
        if (currentId > 0 && this.manifest.items[currentId-1] && this.manifest.items[currentId-1].slug) {
          prevResource = '  <link rel="prev" href="' + escapeHtml(String(this.manifest.items[currentId - 1].slug)) + '" />' + "\n";
        }
        if (currentId < this.manifest.items.length-1 && this.manifest.items[currentId+1] && this.manifest.items[currentId+1].slug) {
          nextResource = '  <link rel="next" href="' + escapeHtml(String(this.manifest.items[currentId + 1].slug)) + '" />' + "\n";
        }
      }
      const alternateLinks = this.getPageAlternateLinkTags(page, canonicalPath);
      canonical += alternateLinks;
      const safeSiteTitle = escapeHtml(siteTitle);
      const safeTitle = escapeHtml(title);
      const safeDescription = escapeHtml(description);
      const safeManifestTitle = escapeHtml(this.manifest.title);
      const safeDomain = escapeHtml(sanitizeUrl(canonicalUrl || domain));
      const safeSocialShareImage = escapeHtml(sanitizeUrl(this.getSocialShareImage(page)));
      const safeHexCode = escapeHtml(hexCode);
      const joinUrl = (baseValue = '', segmentValue = '') => {
        const normalizedBase = String(baseValue || '');
        const normalizedSegment = String(segmentValue || '');
        if (normalizedSegment == '') {
          return normalizedBase;
        }
        if (/^https?:\/\//i.test(normalizedSegment)) {
          return normalizedSegment;
        }
        if (normalizedBase == '') {
          return normalizedSegment;
        }
        return normalizedBase.replace(/\/+$/, '') + '/' + normalizedSegment.replace(/^\/+/, '');
      };
      let inLanguage = 'en-US';
      if (
        this.manifest &&
        this.manifest.metadata &&
        this.manifest.metadata.site &&
        this.manifest.metadata.site.settings &&
        this.manifest.metadata.site.settings.lang &&
        String(this.manifest.metadata.site.settings.lang).trim() != ''
      ) {
        inLanguage = String(this.manifest.metadata.site.settings.lang).trim();
      }
      let pageUrlForStructuredData = sanitizeUrl(canonicalUrl || domain);
      let siteUrlForStructuredData = sanitizeUrl(canonicalBase || domain);
      if (siteUrlForStructuredData == '') {
        siteUrlForStructuredData = pageUrlForStructuredData;
      }
      if (pageUrlForStructuredData == '') {
        pageUrlForStructuredData = siteUrlForStructuredData;
      }
      const toAbsoluteStructuredDataUrl = (value = '') => {
        const sanitizedValue = sanitizeUrl(value);
        if (sanitizedValue == '') {
          return '';
        }
        if (/^https?:\/\//i.test(sanitizedValue)) {
          return sanitizedValue;
        }
        if (siteUrlForStructuredData != '') {
          return sanitizeUrl(joinUrl(siteUrlForStructuredData, sanitizedValue));
        }
        return sanitizedValue;
      };
      let socialShareImageForStructuredData = toAbsoluteStructuredDataUrl(
        this.getSocialShareImage(page),
      );
      let siteLogoForStructuredData = toAbsoluteStructuredDataUrl(
        await this.getLogoSize('512', '512'),
      );
      let pageUpdatedISO = '';
      let pageCreatedISO = '';
      if (
        page &&
        page.metadata &&
        typeof page.metadata.updated !== 'undefined' &&
        page.metadata.updated !== null &&
        page.metadata.updated !== ''
      ) {
        let updatedTimestamp = parseInt(page.metadata.updated, 10);
        if (!isNaN(updatedTimestamp) && updatedTimestamp > 0) {
          pageUpdatedISO = new Date(updatedTimestamp * 1000).toISOString();
        }
      }
      if (
        page &&
        page.metadata &&
        typeof page.metadata.created !== 'undefined' &&
        page.metadata.created !== null &&
        page.metadata.created !== ''
      ) {
        let createdTimestamp = parseInt(page.metadata.created, 10);
        if (!isNaN(createdTimestamp) && createdTimestamp > 0) {
          pageCreatedISO = new Date(createdTimestamp * 1000).toISOString();
        }
      }
      const manifestAuthor =
        this.manifest &&
        this.manifest.metadata &&
        this.manifest.metadata.author
          ? this.manifest.metadata.author
          : {};
      let authorName = '';
      if (manifestAuthor && manifestAuthor.name) {
        authorName = String(manifestAuthor.name).trim();
      } else if (
        this.manifest &&
        typeof this.manifest.author === 'string' &&
        String(this.manifest.author).trim() != ''
      ) {
        authorName = String(this.manifest.author).trim();
      } else if (
        this.manifest &&
        this.manifest.author &&
        this.manifest.author.name
      ) {
        authorName = String(this.manifest.author.name).trim();
      }
      let authorEmail = '';
      if (manifestAuthor && manifestAuthor.email) {
        authorEmail = String(manifestAuthor.email).trim();
      } else if (
        this.manifest &&
        this.manifest.author &&
        this.manifest.author.email
      ) {
        authorEmail = String(this.manifest.author.email).trim();
      }
      let authorSocialLink = '';
      if (manifestAuthor && manifestAuthor.socialLink) {
        authorSocialLink = sanitizeUrl(String(manifestAuthor.socialLink).trim());
      } else if (
        this.manifest &&
        this.manifest.author &&
        this.manifest.author.socialLink
      ) {
        authorSocialLink = sanitizeUrl(
          String(this.manifest.author.socialLink).trim(),
        );
      }
      let authorImageForStructuredData = '';
      if (manifestAuthor && manifestAuthor.image) {
        authorImageForStructuredData = toAbsoluteStructuredDataUrl(
          manifestAuthor.image,
        );
      } else if (
        this.manifest &&
        this.manifest.author &&
        this.manifest.author.image
      ) {
        authorImageForStructuredData = toAbsoluteStructuredDataUrl(
          this.manifest.author.image,
        );
      }
      let breadcrumbTrail = [];
      if (page && page.id && this.manifest && this.manifest.items) {
        let itemBuilder = page;
        if (typeof itemBuilder.title === 'undefined' || itemBuilder.title == '') {
          let activeItemIndex = this.manifest.getItemKeyById(page.id);
          if (
            activeItemIndex !== false &&
            this.manifest.items[activeItemIndex]
          ) {
            itemBuilder = this.manifest.items[activeItemIndex];
          }
        }
        let safetyCounter = 0;
        while (itemBuilder && safetyCounter < 200) {
          breadcrumbTrail.unshift(itemBuilder);
          if (itemBuilder.parent == null) {
            break;
          }
          itemBuilder = this.manifest.items.find((i) => i.id == itemBuilder.parent);
          safetyCounter++;
        }
      } else if (page && (page.title || page.slug)) {
        breadcrumbTrail = [page];
      }
      let breadcrumbListElements = [];
      let breadcrumbPosition = 1;
      if (siteUrlForStructuredData != '') {
        breadcrumbListElements.push({
          '@type': 'ListItem',
          'position': breadcrumbPosition,
          'name':
            this.manifest && this.manifest.title
              ? String(this.manifest.title)
              : 'Home',
          'item': siteUrlForStructuredData,
        });
        breadcrumbPosition++;
      }
      for (let index = 0; index < breadcrumbTrail.length; index++) {
        let breadcrumbItem = breadcrumbTrail[index];
        if (!breadcrumbItem) {
          continue;
        }
        let breadcrumbName = '';
        if (breadcrumbItem.title && String(breadcrumbItem.title).trim() != '') {
          breadcrumbName = String(breadcrumbItem.title).trim();
        } else if (
          breadcrumbItem.slug &&
          String(breadcrumbItem.slug).trim() != ''
        ) {
          breadcrumbName = String(breadcrumbItem.slug).trim();
        } else {
          breadcrumbName = safeTitle;
        }
        let breadcrumbUrl = '';
        if (breadcrumbItem.slug && String(breadcrumbItem.slug).trim() != '') {
          breadcrumbUrl = toAbsoluteStructuredDataUrl(breadcrumbItem.slug);
        }
        if (breadcrumbUrl == '' && index === breadcrumbTrail.length - 1) {
          breadcrumbUrl = pageUrlForStructuredData;
        }
        if (breadcrumbUrl == '') {
          breadcrumbUrl = siteUrlForStructuredData;
        }
        if (
          breadcrumbPosition === 2 &&
          siteUrlForStructuredData != '' &&
          breadcrumbUrl == siteUrlForStructuredData
        ) {
          continue;
        }
        if (breadcrumbUrl == '') {
          continue;
        }
        breadcrumbListElements.push({
          '@type': 'ListItem',
          'position': breadcrumbPosition,
          'name': breadcrumbName,
          'item': breadcrumbUrl,
        });
        breadcrumbPosition++;
      }
      let metadata = `<meta charset="utf-8" />
  ${preconnect}
  <link rel="preconnect" crossorigin href="https://fonts.googleapis.com">
  <link rel="preconnect" crossorigin href="https://cdnjs.cloudflare.com">
  <link rel="preconnect" crossorigin href="https://i.creativecommons.org">
  <link rel="preconnect" crossorigin href="https://licensebuttons.net">
  <link rel="preload" href="${base}build.js" as="script" />
  <link rel="preload" href="${base}build-haxcms.js" as="script" />
  <link rel="preload" href="${base}wc-registry.json" as="fetch" crossorigin="anonymous" fetchpriority="high" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/wc-autoload/wc-autoload.js" crossorigin="anonymous" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/dynamic-import-registry/dynamic-import-registry.js" crossorigin="anonymous" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-builder.js" crossorigin="anonymous" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-store.js" crossorigin="anonymous" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-router.js" crossorigin="anonymous" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/haxcms-elements/lib/core/HAXCMSThemeWiring.js" crossorigin="anonymous" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/haxcms-elements/lib/core/HAXCMSLitElementTheme.js" crossorigin="anonymous" />
  <link rel="modulepreload" href="${base}build/es6/node_modules/@haxtheweb/utils/utils.js" crossorigin="anonymous" />
  <link rel="preload" href="${base}build/es6/node_modules/@haxtheweb/haxcms-elements/lib/base.css" as="style" />
  <link rel="llms" href="llms.txt" title="LLM Content Map" />
  <link rel="alternate" type="text/markdown" href="llms.txt" title="Markdown Summary" />
  <meta name="generator" content="HAXcms">
  ${canonical}${prevResource}${nextResource}
  <link rel="manifest" href="manifest.json" />
  <meta name="viewport" content="width=device-width, minimum-scale=1, initial-scale=1, user-scalable=yes">
  <title>${safeSiteTitle}</title>
  <link rel="icon" href="${escapeHtml(sanitizeUrl(await this.getLogoSize('16', '16')))}">
  <meta name="theme-color" content="${safeHexCode}">
  ${robots}
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="application-name" content="${safeTitle}">

  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="${safeTitle}">

  <link rel=\"apple-touch-icon\" sizes=\"48x48\" href=\"${escapeHtml(sanitizeUrl(await this.getLogoSize('48', '48')))}\">
  <link rel=\"apple-touch-icon\" sizes=\"72x72\" href=\"${escapeHtml(sanitizeUrl(await this.getLogoSize('72', '72')))}\">
  <link rel=\"apple-touch-icon\" sizes=\"96x96\" href=\"${escapeHtml(sanitizeUrl(await this.getLogoSize('96', '96')))}\">
  <link rel=\"apple-touch-icon\" sizes=\"144x144\" href=\"${escapeHtml(sanitizeUrl(await this.getLogoSize('144', '144')))}\">
  <link rel=\"apple-touch-icon\" sizes=\"192x192\" href=\"${escapeHtml(sanitizeUrl(await this.getLogoSize('192', '192')))}\">

  <meta name=\"msapplication-TileImage\" content=\"${escapeHtml(sanitizeUrl(await this.getLogoSize('144', '144')))}\">
  <meta name=\"msapplication-TileColor\" content=\"${safeHexCode}\">
  <meta name="msapplication-tap-highlight" content="no">
        
  <meta name=\"description\" content=\"${safeDescription}\" />
  <meta name=\"og:sitename\" property=\"og:sitename\" content=\"${safeManifestTitle}\" />
  <meta name=\"og:title\" property=\"og:title\" content=\"${safeTitle}\" />
  <meta name="og:type" property="og:type" content="article" />
  <meta name=\"og:url\" property=\"og:url\" content=\"${safeDomain}\" />
  <meta name=\"og:description\" property=\"og:description\" content=\"${safeDescription}\" />
  <meta name=\"og:image\" property=\"og:image\" content=\"${safeSocialShareImage}\" />
  <meta name="twitter:card" property="twitter:card" content="summary_large_image" />
  <meta name=\"twitter:site\" property=\"twitter:site\" content=\"${safeDomain}\" />
  <meta name=\"twitter:title\" property=\"twitter:title\" content=\"${safeTitle}\" />
  <meta name=\"twitter:description\" property=\"twitter:description\" content=\"${safeDescription}\" />
  <meta name=\\\"twitter:image\\\" property=\\\"twitter:image\\\" content=\\\"${safeSocialShareImage}\\\" />`;  
      metadata = metadata.replace(new RegExp('\\\\+"', 'g'), '"');
      let structuredDataBaseUrl = siteUrlForStructuredData || pageUrlForStructuredData;
      let siteStructuredDataId = String(siteUrlForStructuredData).replace(/\/$/, '') + '#website';
      let pageStructuredDataId = String(pageUrlForStructuredData).replace(/\/$/, '') + '#webpage';
      let breadcrumbStructuredDataId = String(pageUrlForStructuredData).replace(/\/$/, '') + '#breadcrumb';
      let authorStructuredDataId = String(structuredDataBaseUrl).replace(/\/$/, '') + '#author';
      let publisherStructuredDataId = String(structuredDataBaseUrl).replace(/\/$/, '') + '#publisher';
      let jsonLdGraph = [];
      let authorNode = null;
      let publisherNode = null;
      if (
        authorName != '' ||
        authorEmail != '' ||
        authorSocialLink != '' ||
        authorImageForStructuredData != ''
      ) {
        authorNode = {
          '@type': 'Person',
          '@id': authorStructuredDataId,
        };
        if (authorName != '') {
          authorNode.name = authorName;
        }
        if (authorEmail != '') {
          authorNode.email = authorEmail;
        }
        if (authorSocialLink != '') {
          authorNode.sameAs = [authorSocialLink];
        }
        if (authorImageForStructuredData != '') {
          authorNode.image = {
            '@type': 'ImageObject',
            'url': authorImageForStructuredData,
          };
        }
        jsonLdGraph.push(authorNode);
      }
      if (siteUrlForStructuredData != '') {
        publisherNode = {
          '@type': 'Organization',
          '@id': publisherStructuredDataId,
          'url': siteUrlForStructuredData,
          'name':
            this.manifest && this.manifest.title
              ? String(this.manifest.title)
              : title,
        };
        if (siteLogoForStructuredData != '') {
          publisherNode.logo = {
            '@type': 'ImageObject',
            'url': siteLogoForStructuredData,
          };
        }
        if (authorNode && authorNode['@id']) {
          publisherNode.founder = {
            '@id': authorNode['@id'],
          };
        }
        jsonLdGraph.push(publisherNode);
      }
      if (siteUrlForStructuredData != '') {
        let webSiteNode = {
          '@type': 'WebSite',
          '@id': siteStructuredDataId,
          'url': siteUrlForStructuredData,
          'name':
            this.manifest && this.manifest.title
              ? String(this.manifest.title)
              : title,
          'inLanguage': inLanguage,
        };
        let searchTargetUrl = sanitizeUrl(
          joinUrl(siteUrlForStructuredData, 'x/search') +
            '?search={search_term_string}',
        );
        if (searchTargetUrl != '') {
          webSiteNode.potentialAction = {
            '@type': 'SearchAction',
            'target': {
              '@type': 'EntryPoint',
              'urlTemplate': searchTargetUrl,
            },
            'query-input': 'required name=search_term_string',
          };
        }
        if (publisherNode && publisherNode['@id']) {
          webSiteNode.publisher = {
            '@id': publisherNode['@id'],
          };
        }
        if (authorNode && authorNode['@id']) {
          webSiteNode.author = {
            '@id': authorNode['@id'],
          };
        }
        if (siteLogoForStructuredData != '') {
          webSiteNode.image = {
            '@type': 'ImageObject',
            'url': siteLogoForStructuredData,
          };
        }
        jsonLdGraph.push(webSiteNode);
      }
      if (breadcrumbListElements.length > 0 && pageUrlForStructuredData != '') {
        jsonLdGraph.push({
          '@type': 'BreadcrumbList',
          '@id': breadcrumbStructuredDataId,
          'itemListElement': breadcrumbListElements,
        });
      }
      if (pageUrlForStructuredData != '') {
        let webPageNode = {
          '@type': 'WebPage',
          '@id': pageStructuredDataId,
          'url': pageUrlForStructuredData,
          'name': title,
          'description': description,
          'inLanguage': inLanguage,
        };
        if (siteUrlForStructuredData != '') {
          webPageNode.isPartOf = {
            '@id': siteStructuredDataId,
          };
        }
        if (socialShareImageForStructuredData != '') {
          webPageNode.primaryImageOfPage = {
            '@type': 'ImageObject',
            'url': socialShareImageForStructuredData,
          };
          webPageNode.image = socialShareImageForStructuredData;
        }
        if (pageCreatedISO != '') {
          webPageNode.datePublished = pageCreatedISO;
        }
        if (pageUpdatedISO != '') {
          webPageNode.dateModified = pageUpdatedISO;
        }
        if (authorNode && authorNode['@id']) {
          webPageNode.author = {
            '@id': authorNode['@id'],
          };
        }
        if (publisherNode && publisherNode['@id']) {
          webPageNode.publisher = {
            '@id': publisherNode['@id'],
          };
        }
        if (breadcrumbListElements.length > 0) {
          webPageNode.breadcrumb = {
            '@id': breadcrumbStructuredDataId,
          };
        }
        if (page && page.id) {
          webPageNode.identifier = String(page.id);
        }
        jsonLdGraph.push(webPageNode);
      }
      if (jsonLdGraph.length > 0) {
        let jsonLdMetadata = {
          '@context': 'https://schema.org',
          '@graph': jsonLdGraph,
        };
        let jsonLdString = JSON.stringify(jsonLdMetadata).replace(/</g, '\\u003c');
        metadata += "\n  <script type=\"application/ld+json\">" + jsonLdString + "</script>";
      }
      // mix in license metadata if we have it
      let licenseData = this.getLicenseData('all');
      if ((this.manifest.license) && (licenseData[this.manifest.license])) {
          metadata += "\n" + '  <meta rel="cc:license" href="' + escapeHtml(sanitizeUrl(licenseData[this.manifest.license]['link'])) + '" content="License: ' + escapeHtml(licenseData[this.manifest.license]['name']) + '"/>' + "\n";
      }
      // add in X link if they provided one
      if ((this.manifest.metadata.author.socialLink) && (this.manifest.metadata.author.socialLink.indexOf('https://twitter.com/') === 0 || this.manifest.metadata.author.socialLink.indexOf('https://x.com/') === 0)) {
          metadata += "\n" + '  <meta name="twitter:creator" content="' + escapeHtml(this.manifest.metadata.author.socialLink.replace('https://twitter.com/', '@').replace('https://x.com/', '@')) + '" />';
      }
      return metadata;
    }
    /**
     * Load a node based on a path
     * @var path the path to try loading based on or search for the active from address
     * @return new JSONOutlineSchemaItem() a blank JOS item
     */
    loadNodeByLocation(path = null) {
        // load from the active address if we have one
        if (path == null) {
          path = path.resolve(__dirname).replace('/' + HAXCMS.sitesDirectory + '/' + this.name + '/', '');
        }
        path += "/index.html";
        // failsafe in case someone had closing /
        path = 'pages/' + path.replace('//', '/');
        for (var key in this.manifest.files) {
          let item = this.manifest.items[key];
          if (item.location == path) {
              return item;
          }
        }
       return new JSONOutlineSchemaItem();
    }
    /**
     * Generate or load the path to variations on the logo
     * @var string height height of the icon as a string
     * @var string width width of the icon as a string
     * @return string path to the image (web visible) that was created or pulled together
     */
    async getLogoSize(height, width) {
      let fileName;
      if (!(fileName)) {
        // if no logo, just bail with an easy standard one
        if (!(this.manifest.metadata.site.logo) || ((this.manifest.metadata.site) && (this.manifest.metadata.site.logo == '' || this.manifest.metadata.site.logo == null || this.manifest.metadata.site.logo == "null"))) {
            fileName = 'assets/icon-' + height + 'x' + width + '.png';
        }
        else {
          // ensure this path exists otherwise let's create it on the fly
          let path = this.siteDirectory + '/';
          fileName = this.manifest.metadata.site.logo.replace('files/', 'files/haxcms-managed/' + height + 'x' + width + '-');
          if (fs.pathExistsSync(path + this.manifest.metadata.site.logo) &&
              fs.lstatSync(path + this.manifest.metadata.site.logo).isFile() && 
              !fs.pathExistsSync(path + fileName)) {
              // make folder if doesnt exist
              if (!fs.pathExistsSync(path + 'files/haxcms-managed')) {
                fs.mkdirSync(path + 'files/haxcms-managed');
              }
              const image = await sharp(path + this.manifest.metadata.site.logo)
              .metadata()
              .then(({ width }) => sharp(path + this.manifest.metadata.site.logo)
                .resize({
                  width: parseInt(width),
                  height: parseInt(height),
                })
                .toFile(path + fileName)
              );
          }
        }
      }
      return fileName;
    }
    /**
     * Load field schema for a page
     * Field cascade always follows Core + Deploy + Theme + Site
     * Anything downstream can always override upstream but no one can remove fields
     */
    async loadNodeFieldSchema(page)
    {
        let fields = {
            'configure':{},
            'advanced':{}
        };
        // load core fields
        // it may seem silly but we seek to not brick any usecase so if this file is gone.. don't die
        if (fs.pathExistsSync(HAXCMS.coreConfigPath + 'nodeFields.json') &&
            fs.lstatSync(HAXCMS.coreConfigPath + 'nodeFields.json').isFile()) {
            let coreFields = JSON.parse(
              await fs.readFileSync(
                    HAXCMS.coreConfigPath + 'nodeFields.json',
                    {encoding:'utf8', flag:'r'}
                )
            );
            let themes = {};
            let hThemes = HAXCMS.getThemes();
            for (var key in hThemes) {
              let item = hThemes[key];
              themes[key] = item.name;
              themes['key'] = key;
            }
            // this needs to be set dynamically
              for (var key in coreFields.advanced) {
                let item = coreFields.advanced[key];
                if (item.property === 'theme') {
                  coreFields.advanced[key].options = themes;
                }
            }
            // CORE fields
            if ((coreFields.configure)) {
              for (var key in coreFields.configure) {
                let item = coreFields.configure[key];
                // edge case for pathauto
                if (item.property == 'location' && (this.manifest.metadata.site.settings.pathauto) && this.manifest.metadata.site.settings.pathauto) {
                  // skip this core field if we have pathauto on
                  item.required = false;
                  item.disabled = true;
                }
                fields['configure'].push(item);
              }
            }
            if (coreFields.advanced) {
              for (var key in coreFields.advanced) {
                let item = coreFields.advanced[key];
                fields['advanced'].push(item);
              }
            }
        }
        // fields can live globally in config
        if ((HAXCMS.config.node.fields)) {
            if ((HAXCMS.config.node.fields.configure)) {
                for (var key in HAXCMS.config.node.fields.configure) {
                    fields['configure'].push(HAXCMS.config.node.fields.configure[key]);
                }
            }
            if ((HAXCMS.config.node.fields.advanced)) {
              for (var key in HAXCMS.config.node.fields.advanced) {
                fields['advanced'].push(HAXCMS.config.node.fields.advanced[key]);
              }
            }
        }
        // fields can live in the theme
        if (
            (this.manifest.metadata.theme.fields) &&
            fs.pathExistsSync(HAXCMS.HAXCMS_ROOT +
              'build/es6/node_modules/' +
              this.manifest.metadata.theme.fields) &&
            fs.lstatSync(
                HAXCMS.HAXCMS_ROOT +
                    'build/es6/node_modules/' +
                    this.manifest.metadata.theme.fields
            ).isFile()
        ) {
            // @todo think of how to make this less brittle
            // not a fan of pegging loading this definition to our file system's publishing structure
            themeFields = JSON.parse(
              await fs.readFileSync(
                    HAXCMS.HAXCMS_ROOT +
                        'build/es6/node_modules/' +
                        this.manifest.metadata.theme.fields,
                        {encoding:'utf8', flag:'r'}
                )
            );
            if ((themeFields.configure)) {
                for (var key in themeFields.configure) {
                  fields['configure'].push(themeFields.configure[key]);
                }
            }
            if ((themeFields.advanced)) {
              for (var key in themeFields.advanced) {
                fields['advanced'].push(themeFields.advanced[key]);
              }
            }
        }
        // fields can live in the site itself
        if (this.manifest.metadata.node.fields) {
            if (this.manifest.metadata.node.fields.configure) {
                for (var key in this.manifest.metadata.node.fields.configure) {
                    fields['configure'].push(this.manifest.metadata.node.fields.configure[key]);
                }
            }
            if (this.manifest.metadata.node.fields.advanced) {
              for (var key in this.manifest.metadata.node.fields.advanced) {
                fields['advanced'].push(this.manifest.metadata.node.fields.advanced[key]);
              }
            }
        }
        // core values that live outside of the fields area
        let values = {
          'title': page.title,
          'location': page.location.replace('pages/','').replace('/index.html', ''),
          'description':page.description,
          'created':((page.metadata.created) ? page.metadata.created : 54),
          'published':((page.metadata.published) ? page.metadata.published : true),
        };
        // now get the field data from the page
        if ((page.metadata.fields)) {
          for (var key in page.metadata.fields) {
            let item = page.metadata.fields[key];
            if (key == 'theme') {
              values[key] = item['key'];
            } else {
              values[key] = item;
            }
          }
        }
        // response as schema and values
        response = {};
        response.haxSchema = fields;
        response.values = values;
        return response;
    }
    /**
     * License data for common open license
     */
    getLicenseData(type = 'select')
    {
        let list = {
            "by":{
                'name':"Creative Commons: Attribution",
                'link':"https://creativecommons.org/licenses/by/4.0/",
                'image':"https://i.creativecommons.org/l/by/4.0/88x31.png"
            },
            "by-sa":{
                'name':"Creative Commons: Attribution Share a like",
                'link':"https://creativecommons.org/licenses/by-sa/4.0/",
                'image':"https://i.creativecommons.org/l/by-sa/4.0/88x31.png"
            },
            "by-nd":{
                'name':"Creative Commons: Attribution No derivatives",
                'link':"https://creativecommons.org/licenses/by-nd/4.0/",
                'image':"https://i.creativecommons.org/l/by-nd/4.0/88x31.png"
            },
            "by-nc":{
                'name':"Creative Commons: Attribution non-commercial",
                'link':"https://creativecommons.org/licenses/by-nc/4.0/",
                'image':"https://i.creativecommons.org/l/by-nc/4.0/88x31.png"
            },
            "by-nc-sa":{
                'name' :
                    "Creative Commons: Attribution non-commercial share a like",
                'link':"https://creativecommons.org/licenses/by-nc-sa/4.0/",
                'image' :
                    "https://i.creativecommons.org/l/by-nc-sa/4.0/88x31.png"
            },
            "by-nc-nd":{
                'name' :
                    "Creative Commons: Attribution Non-commercial No derivatives",
                'link':"https://creativecommons.org/licenses/by-nc-nd/4.0/",
                'image' :
                    "https://i.creativecommons.org/l/by-nc-nd/4.0/88x31.png"
            }
        };
        let data = {};
        if (type == 'select') {
            for (var key in list) {
              data[key] = list[key]['name'];
            }
        }
        else {
            data = list;
        }
        return data;
    }
    /**
     * Update page in the manifest list of items. useful if updating some
     * data about an existing entry.
     * @return JSONOutlineSchemaItem or false
     */
    async updateNode(page)
    {
      for (var key in this.manifest.items) {
        let item = this.manifest.items[key];
        if (item.id === page.id) {
          this.manifest.items[key] = page;
          await this.manifest.save(false);
          await this.updateAlternateFormats();
          return page;
        }
      }
      return false;
    }
    /**
     * Delete a page from the manifest
     * @return JSONOutlineSchemaItem or false
     */
    async deleteNode(page)
    {
          for (var key in this.manifest.items) {
            let item = this.manifest.items[key];
            if (item.id === page.id) {
                this.manifest.items.splice(key, 1);
                await this.manifest.save(false);
                await this.updateAlternateFormats();
                return true;
            }
        }
        return false;
    }
    /**
     * Change the directory this site is located in
     */
    async changeName(newName)
    {
        newName = newName.replace('./', '').replace('../', '');
        // attempt to shift it on the file system
        if (newName != this.manifest.metadata.site.name) {
            this.manifest.metadata.site.name = newName;
            return await fs.rename(this.manifest.metadata.site.name, newName);
        }
    }
    /**
     * Test and ensure the name being returned is a slug currently unused
     */
    getUniqueSlugName(slug, page = null, pathAuto = false)
    {
      let rSlug = slug;
      // check for pathauto setting and this having a parent
      if (page != null && page.parent != null && page.parent != '' && pathAuto) {
        let item = {...page};
        let pieces = [slug];
        let tmp = '';
        while (item = this.manifest.getItemById(item.parent)) {
          tmp = explode('/', item.slug);
          array_unshift(pieces, tmp.pop());
        }
        slug = implode('/', pieces);
        rSlug = slug;
      }
      // trap for a / as 1st character if we had empty pieces
      while (rSlug.substring(0, 1) == "/") {
        rSlug = rSlug.substring(1);
      }
      let loop = 0;
      let ready = false;
      // while not ready, keep checking
      while (!ready) {
        ready = true;
        // loop through items
        for (var key in this.manifest.items) {
          let item = this.manifest.items[key];
          // if our slug matches an existing
          if (rSlug == item.slug) {
            // if we have a page, and it matches that, bail out cause we have it already
            if (page != null && item.id == page.id) {
              return rSlug;
            }
            else {
              // increment the number
              loop++;
              // append to the new slug
              rSlug = slug + '-' + loop;
              // force a new test
              ready = false;
            }
          }
        }
      }
      return rSlug;
    }
    
    /**
     * Handle style guide save operation through saveNode endpoint
     * @param object bodyParams The request body parameters
     * @return object Response object with status and data
     */
    async handleStyleGuideSave(bodyParams) {
      const styleGuideFile = path.join(this.siteDirectory, 'theme', 'style-guide.html');
      
      // Extract content from node body (saveNode endpoint)
      let content = null;
      if (bodyParams['node'] && bodyParams['node']['body']) {
        content = bodyParams['node']['body'];
      }
      
      // validate that we have content to save
      if (!content) {
        return {
          '__failed': {
            'status': 400,
            'message': 'Content parameter is required',
          }
        };
      }
      
      // validate content is a string and has some actual content
      if (typeof content !== 'string') {
        return {
          '__failed': {
            'status': 400,
            'message': 'Content must be a string',
          }
        };
      }
      
      // basic validation - ensure we have some HTML-like content
      const cleanContent = content.trim();
      if (!cleanContent) {
        return {
          '__failed': {
            'status': 400,
            'message': 'Content cannot be empty',
          }
        };
      }
      
      // validate that content appears to be HTML by checking for basic HTML patterns
      // this follows similar pattern to how saveNode validates content structure
      if (!/<[^>]+>/.test(cleanContent)) {
        return {
          '__failed': {
            'status': 400,
            'message': 'Content must be valid HTML',
          }
        };
      }
      
      // check if the theme directory exists, if not create it
      const themeDirectory = path.join(this.siteDirectory, 'theme');
      if (!fs.existsSync(themeDirectory)) {
        try {
          await fs.ensureDir(themeDirectory);
        } catch (error) {
          return {
            '__failed': {
              'status': 500,
              'message': 'Failed to create theme directory',
            }
          };
        }
      }
      
      // ensure the site's style guide setting allows writing to the default location
      // only allow writing to the default location (theme/style-guide.html)
      // if user has changed the styleGuide setting to an external URL, block writes
      if (this.manifest.metadata.theme && 
          this.manifest.metadata.theme.styleGuide && 
          this.manifest.metadata.theme.styleGuide !== null && 
          this.manifest.metadata.theme.styleGuide !== '') {
        return {
          '__failed': {
            'status': 403,
            'message': 'Style guide is configured to use external source. Cannot edit through HAXcms.',
          }
        };
      }
      
      // write the content to the style guide file
      try {
        await fs.writeFile(styleGuideFile, cleanContent);
      } catch (error) {
        return {
          '__failed': {
            'status': 500,
            'message': 'Failed to write style guide file',
          }
        };
      }
      
      // commit to git
      await this.gitCommit('Style guide updated');
      
      return {
        'status': 200,
        'message': 'Style guide saved successfully',
        'data': {
          'file': 'theme/style-guide.html'
        }
      };
    }
}
// HAXcms core
class HAXCMSClass {
  safeStringCompare(stored, submitted) {
    if (typeof stored !== 'string' || typeof submitted !== 'string') {
      return false;
    }
    const storedBuffer = Buffer.from(stored, 'utf8');
    const submittedBuffer = Buffer.from(submitted, 'utf8');
    if (storedBuffer.length !== submittedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(storedBuffer, submittedBuffer);
  }
  hasDefaultCredentials() {
    return this.user && this.user.name === 'admin' && this.user.password === 'admin';
  }
  shouldAllowDefaultCredentials() {
    if (!process.env.HAXCMS_ALLOW_DEFAULT_CREDS) {
      return false;
    }
    const allowedValues = ['1', 'true', 'yes'];
    return allowedValues.indexOf(String(process.env.HAXCMS_ALLOW_DEFAULT_CREDS).toLowerCase()) !== -1;
  }
  getRuntimeCredentialOverride() {
    if (typeof globalThis === 'undefined' || !globalThis) {
      return null;
    }
    let runtimeUserName = '';
    let runtimePassword = '';
    if (
      globalThis.HAXCMS_RUNTIME_CREDENTIALS &&
      typeof globalThis.HAXCMS_RUNTIME_CREDENTIALS === 'object'
    ) {
      const runtimeCredentials = globalThis.HAXCMS_RUNTIME_CREDENTIALS;
      if (
        typeof runtimeCredentials.username === 'string' &&
        runtimeCredentials.username.trim() !== ''
      ) {
        runtimeUserName = runtimeCredentials.username.trim();
      }
      else if (
        typeof runtimeCredentials.name === 'string' &&
        runtimeCredentials.name.trim() !== ''
      ) {
        runtimeUserName = runtimeCredentials.name.trim();
      }
      if (
        typeof runtimeCredentials.password === 'string' &&
        runtimeCredentials.password.trim() !== ''
      ) {
        runtimePassword = runtimeCredentials.password;
      }
      else if (
        typeof runtimeCredentials.pass === 'string' &&
        runtimeCredentials.pass.trim() !== ''
      ) {
        runtimePassword = runtimeCredentials.pass;
      }
    }
    if (
      runtimeUserName === '' &&
      typeof globalThis.HAXCMS_RUNTIME_USERNAME === 'string' &&
      globalThis.HAXCMS_RUNTIME_USERNAME.trim() !== ''
    ) {
      runtimeUserName = globalThis.HAXCMS_RUNTIME_USERNAME.trim();
    }
    if (
      runtimePassword === '' &&
      typeof globalThis.HAXCMS_RUNTIME_PASSWORD === 'string' &&
      globalThis.HAXCMS_RUNTIME_PASSWORD.trim() !== ''
    ) {
      runtimePassword = globalThis.HAXCMS_RUNTIME_PASSWORD;
    }
    if (runtimeUserName === '' || runtimePassword === '') {
      return null;
    }
    return {
      name: runtimeUserName,
      password: runtimePassword,
    };
  }
  applyRuntimeCredentialOverride() {
    const runtimeCredentialOverride = this.getRuntimeCredentialOverride();
    if (!runtimeCredentialOverride) {
      return false;
    }
    this.superUser = {
      name: runtimeCredentialOverride.name,
      password: runtimeCredentialOverride.password,
    };
    this.user = {
      name: runtimeCredentialOverride.name,
      password: runtimeCredentialOverride.password,
    };
    return true;
  }
  generateSecurePassword() {
    return crypto.randomBytes(16).toString('hex');
  }
  getIntConfigValue(value, fallback, min, max) {
    let num = parseInt(value, 10);
    if (isNaN(num)) {
      num = fallback;
    }
    if (num < min) {
      num = min;
    }
    if (num > max) {
      num = max;
    }
    return num;
  }
  getLoginRateLimitSettings() {
    const defaults = {
      enabled: true,
      windowMs: 15 * 60 * 1000,
      maxAttempts: 5,
      blockMs: 15 * 60 * 1000,
    };
    let cfg = {};
    if (
      this.config &&
      this.config.security &&
      this.config.security.loginRateLimit
    ) {
      cfg = this.config.security.loginRateLimit;
    }
    let enabled = defaults.enabled;
    if (typeof cfg.enabled !== 'undefined') {
      enabled = cfg.enabled === true;
    }
    return {
      enabled: enabled,
      windowMs: this.getIntConfigValue(cfg.windowMs, defaults.windowMs, 10 * 1000, 24 * 60 * 60 * 1000),
      maxAttempts: this.getIntConfigValue(cfg.maxAttempts, defaults.maxAttempts, 1, 1000),
      blockMs: this.getIntConfigValue(cfg.blockMs, defaults.blockMs, 10 * 1000, 24 * 60 * 60 * 1000),
    };
  }
  // Express `trust proxy` setting, sourced from config so deployments behind a
  // reverse proxy can opt in to forwarded client IPs. Defaults to false (do not
  // trust any proxy), which keeps single-host/local setups using the socket IP.
  getTrustProxySetting() {
    if (
      this.config &&
      this.config.security &&
      typeof this.config.security.trustProxy !== 'undefined'
    ) {
      return this.config.security.trustProxy;
    }
    return false;
  }
  // True only when explicitly running in production (NODE_ENV=production). Used
  // to enable hardened defaults (e.g. Secure cookies) without impacting local
  // development, which never sets NODE_ENV to production.
  isProductionRuntime() {
    return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  }
  // Allowed CORS origin for browser clients. Config-driven so deployments can
  // lock responses to a known origin; falls back to the provided default (the
  // local dev origin) to preserve existing behavior when unset.
  getCorsAllowedOrigin(defaultOrigin = '') {
    if (
      this.config &&
      this.config.security &&
      typeof this.config.security.allowedOrigin === 'string' &&
      this.config.security.allowedOrigin.trim() !== ''
    ) {
      return this.config.security.allowedOrigin.trim();
    }
    return defaultOrigin;
  }
  async gitTest() {
    try {
      const { stdout, stderr } = await exec('git --version');
      return stdout;
    } catch (e) {
      return null;
    }
  }
  constructor() {
    this.developerMode = false;
    this.developerModeAdminOnly = false;
    this.cliWritePath = null;
    this.cdn = './';
    this.sessionJwt = null;
    this.protocol = 'http';
    this.domain = 'localhost';
    this.siteListing = {
      attr: '',
      slot: '',
    };
    this.basePath = '/';
    this.config = {};
    /**
     * @todo need a way to define these on node side as PHP settings won't carry
     */
    this.superUser = {
      name: 'admin',
      password: 'admin',
    };
    this.user = {
      name: 'admin',
      password: 'admin',
    };
    this.HAXCMS_ROOT = HAXCMS_ROOT;
    this.HAXCMS_DEFAULT_THEME = HAXCMS_DEFAULT_THEME;
    this.HAXCMS_FALLBACK_HEX = HAXCMS_FALLBACK_HEX;
    this.systemRequestBase = 'system/api/';
    this.acceptedHAXFileTypes = [
      "audio",
      "image",
      "gif",
      "video",
      "pdf",
      "csv",
      "svg",
      "markdown",
      "html",
      "document",
      "archive",
      "*",
    ];

    this.configDirectory = discoverConfigPath;
    // ensure expected config directories exist (mirrors PHP _config behavior)
    // - skeletons: deployment-level overrides
    // - user/skeletons: per-user skeletons created via UI
    try {
      const skelDir = path.join(this.configDirectory, 'skeletons');
      const userSkelDir = path.join(this.configDirectory, 'user', 'skeletons');
      const settingsDir = path.join(this.configDirectory, 'settings');
      if (!fs.existsSync(skelDir)) {
        fs.mkdirSync(skelDir, { recursive: true });
      }
      if (!fs.existsSync(userSkelDir)) {
        fs.mkdirSync(userSkelDir, { recursive: true });
      }
      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
      }
    }
    catch (e) {
      // non-fatal; directory creation can fail in some locked-down environments
    }
    // these are relative to the current path
    this.coreConfigPath = __dirname + '/../coreConfig/';
    this.boilerplatePath = __dirname + '/../boilerplate/';
    // these are relative to root which is cwd
    this.sitesDirectory = '_sites';
    // CLI's do not operate in multisite mode default folder creator
    if (!systemStructureContext() && !this.isCLI()) {
      this.operatingContext = 'multisite';
      // verify exists
      if (!fs.existsSync(path.join(HAXCMS_ROOT, this.sitesDirectory))) {
        fs.mkdirSync(path.join(HAXCMS_ROOT, this.sitesDirectory));
      }
    }
    else {
      this.operatingContext = 'single';
    }
    this.archivedDirectory = '_archived';
    this.publishedDirectory = '_published';
    
    // makes it easier to request a new item from the schema factory
    this.outlineSchema = new JSONOutlineSchema();
    // self healing if config is missing
    if (!fs.existsSync(path.join(this.configDirectory, "config.json"))) {
      fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/config.json'), path.join(this.configDirectory, 'config.json'));
    }
    this.config = JSON.parse(fs.readFileSync(path.join(this.configDirectory, "config.json"),
      {encoding:'utf8', flag:'r'}, 'utf8'));
    if (!this.config.themes) {
      this.config.themes = {};
    }
    if (!this.config.deploymentProfile) {
      if (this.config.iam) {
        this.config.deploymentProfile = 'haxiam-managed';
      }
      else if (this.operatingContext === 'multisite') {
        this.config.deploymentProfile = 'self-hosted-multi-site';
      }
      else {
        this.config.deploymentProfile = 'single-site';
      }
    }
    if (!this.config.mcp) {
      this.config.mcp = {};
    }
    if (typeof this.config.mcp.enabled === 'undefined') {
      this.config.mcp.enabled = this.getDeploymentProfile() !== 'haxiam-managed';
    }
    if (typeof this.config.mcp.readOnly === 'undefined') {
      this.config.mcp.readOnly = true;
    }
    if (!this.config.appJWTConnectionSettings) {
      this.config.appJWTConnectionSettings = {};
    }
    if (!this.config.security) {
      this.config.security = {};
    }
    if (!this.config.security.loginRateLimit) {
      this.config.security.loginRateLimit = {};
    }
    // load in core theme data
    let themeData = JSON.parse(fs.readFileSync(path.join(this.coreConfigPath, "themes.json"),
      {encoding:'utf8', flag:'r'}, 'utf8'));
    for (var name in themeData) {
      this.config.themes[name] = themeData[name];
    }
    // node
    if (!this.config.node) {
      this.config.node = {
        fields: {}
      };
    }
    // publishing endpoints
    if (!this.config.site) {
      this.config.site = {
        settings: {},
        git: {},
        static: {},
      }
    }
    if (!this.config.site.publishers) {
      this.config.site.publishers = {};
    }
    // load in core publishing data
    let publishingData = JSON.parse(fs.readFileSync(path.join(this.coreConfigPath, "publishers.json"),
      {encoding:'utf8', flag:'r'}, 'utf8'));
    for (var name in publishingData) {
      this.config.site.publishers[name] = publishingData[name];
    }
    // site fields in HAXschema format
    if (!this.config.site.fields) {
      this.config.site.fields = [{}];
    }
    let fieldsData = JSON.parse(fs.readFileSync(path.join(this.coreConfigPath, "siteFields.json"),
      {encoding:'utf8', flag:'r'}, 'utf8'));
    for (var name in fieldsData) {
      this.config.site.fields[0][name] = fieldsData[name];
    }
    let themeSelect = {};
    // ensure field schema has correct theme options
    // filter hidden / terrible themes from the site settings dialog
    for (var name in this.config.themes) {
      let theme = this.config.themes[name];
      if (theme && (theme.hidden || theme.terrible)) {
        continue;
      }
      themeSelect[name] = theme.name;
    }
    // @todo this is VERY hacky specific placement of the theme options
    this.config.site.fields[0].properties[1].properties[0].options = themeSelect;
    
    // so you can modify them via the UI
    if (!fs.existsSync(path.join(this.configDirectory, "userData.json"))) {
      fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/userData.json'), path.join(this.configDirectory, 'userData.json'));
    }
    this.userData = JSON.parse(fs.readFileSync(path.join(this.configDirectory, "userData.json"),
    {encoding:'utf8', flag:'r'}, 'utf8'));

    // security related files for hashing. if they don't exist, build them on the fly
    try {
      this.salt = fs.readFileSync(path.join(this.configDirectory, "SALT.txt"),
      {encoding:'utf8', flag:'r'}, 'utf8');  
    }
    catch (e) {
      this.salt = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(path.join(this.configDirectory, "SALT.txt"), this.salt);
    }
    // pk/rpk test for files that can contain these
    try {
      this.privateKey = fs.readFileSync(path.join(this.configDirectory, ".pk"),
      {encoding:'utf8', flag:'r'}, 'utf8');
    }
    catch (e) {
      this.privateKey = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(path.join(this.configDirectory, ".pk"), this.privateKey);
    }
    try {
      this.refreshPrivateKey = fs.readFileSync(path.join(this.configDirectory, ".rpk"),
      {encoding:'utf8', flag:'r'}, 'utf8');
    }
    catch (e) {
      this.refreshPrivateKey = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(path.join(this.configDirectory, ".rpk"), this.refreshPrivateKey);
    }
    // allow for loading in user defined config
    // pk/rpk test for files that can contain these
    try {
      this.user = JSON.parse(fs.readFileSync(path.join(this.configDirectory, ".user")),
      {encoding:'utf8', flag:'r'}, 'utf8');
      this.superUser = {...this.user};
    }
    catch (e) {
      // create a default user with secure random password
      const seededPassword = this.generateSecurePassword();
      this.superUser = {
        name: 'admin',
        password: seededPassword,
      };
      this.user = {
        name: 'admin',
        password: seededPassword,
      };
      fs.writeFileSync(path.join(this.configDirectory, ".user"), JSON.stringify(this.user, null, 2));
      if (!this.isCLI()) {
        console.error('***************************************************************');
        console.error('\nHAXcms USER CONFIGURATION FILE NOT FOUND, creating default user');
        console.error('\n*** HAXcms admin seeded credentials ***');
        console.error(`username: ${this.user.name}`);
        console.error(`password: ${seededPassword}`);
        console.error(`\nCredentials saved to: ${path.join(this.configDirectory, ".user")}`);
        console.error('Change this password immediately for production use.');
        console.error('\n***************************************************************');
      }
    }
    // allow runtime overrides for isolated testing or orchestration scenarios
    this.applyRuntimeCredentialOverride();
    // refuse to start web runtime with known default credentials unless explicitly overridden
    if (this.hasDefaultCredentials() && !this.isCLI() && !this.shouldAllowDefaultCredentials()) {
      console.error('***************************************************************');
      console.error('\n*** Refusing to start HAXcms ***');
      console.error('Default credentials were detected in .user:');
      console.error(` ${path.join(this.configDirectory, ".user")}`);
      console.error('Set a strong password and restart.');
      console.error('To override temporarily for emergency scenarios, set HAXCMS_ALLOW_DEFAULT_CREDS=1.');
      console.error('\n***************************************************************');
      throw new Error('HAXcms startup blocked due to default credentials.');
    }
  }
  /**
   * Load a site off the file system with option to create
   */
  async loadSite(name, create = false, domain = null, build = null)
    {
      let tmpname = decodeURIComponent(name);
      tmpname = this.cleanTitle(tmpname, false);
      // check if this exists, load but fallback for creating on the fly
      let singleSiteTest = await systemStructureContext();
      if (singleSiteTest && !create) {
        return singleSiteTest;
      }
      else if (fs.existsSync(this.HAXCMS_ROOT + this.sitesDirectory + '/' + tmpname) && 
        fs.lstatSync(this.HAXCMS_ROOT + this.sitesDirectory + '/' + tmpname).isDirectory() && !create
      ) {
          let site = new HAXCMSSite();
          await site.load(this.HAXCMS_ROOT + this.sitesDirectory,
              this.basePath + this.sitesDirectory + '/',
              tmpname);
          return site;
      }
      else if (create) {
        // attempt to create site
        return await this.createSite(name, domain, null, build);
      }
      return false;
  }
  /**
     * Attempt to create a new site on the file system
     *
     * @var name name of the new site to create
     * @var domain optional domain name to utilize during setup
     * @var git git object details
     *
     * @return boolean true for success, false for failed
     */
   async createSite(name, domain = null, git = null, build = null)
   {
       // try and make the folder
       var site = new HAXCMSSite();
       // see if we can get a remote setup on the fly
       if (git && !git.url && this.config.site.git) {
           git = this.config.site.git;
           // getting really into fallback mode here
           if (git['url']) {
               git['url'] += '/' + name + '.git';
           }
       }
       let writePath = HAXCMS_ROOT + this.sitesDirectory;
       // allow CLI operations to overwrite write location
       if (HAXCMS.cliWritePath && this.isCLI()) {
        writePath = HAXCMS.cliWritePath;
       }
       if (
           await site.newSite(
               writePath,
               this.basePath + this.sitesDirectory + '/',
               name,
               git,
               domain,
               build
           )
       ) {
           return site;
       }
       return false;
   }
  /**
   * Need to support CLI indentification
   */
  isCLI() {
    return process.env.haxcms_middleware === "node-cli";
  }
  /**
   * Deployment profile controls platform-level MCP defaults.
   */
  getDeploymentProfile() {
    if (!this.config || !this.config.deploymentProfile) {
      return 'single-site';
    }
    const profile = String(this.config.deploymentProfile).toLowerCase();
    const validProfiles = ['single-site', 'self-hosted-multi-site', 'haxiam-managed'];
    if (validProfiles.indexOf(profile) !== -1) {
      return profile;
    }
    return 'single-site';
  }
  /**
   * MCP availability policy.
   */
  isMcpEnabled() {
    if (!this.config || !this.config.mcp) {
      return false;
    }
    return this.config.mcp.enabled === true;
  }
  /**
   * MCP write-protection policy (true means write calls must be blocked).
   */
  isMcpReadOnly() {
    if (!this.isMcpEnabled()) {
      return true;
    }
    if (!this.config || !this.config.mcp) {
      return true;
    }
    return this.config.mcp.readOnly !== false;
  }
  /**
   * MCP write capability helper.
   */
  isMcpWriteEnabled() {
    return this.isMcpEnabled() && !this.isMcpReadOnly();
  }

  /**
   * Generate machine name
   */
  generateMachineName(name) {
      // mirror hardened PHP generateMachineName behavior
      if (name === undefined || name === null) {
        return 'default';
      }
      let n = String(name);
      // Remove null bytes
      n = n.replace(/\0/g, '');
      // URL decode to catch encoded traversal attempts
      try {
        n = decodeURIComponent(n);
      }
      catch (e) {
        // if decode fails, fall back to original string
      }
      // Remove any path traversal sequences completely
      n = n.replace(/\.{2,}/g, ''); // remove .. sequences
      n = n.replace(/[\\/]/g, ''); // remove all slashes
      // Only allow alphanumeric, hyphens, and underscores
      n = n.replace(/[^a-zA-Z0-9_-]+/g, '-');
      // Clean up multiple consecutive hyphens/underscores
      n = n.replace(/[-_]{2,}/g, '-');
      // Remove leading/trailing hyphens/underscores
      n = n.replace(/^[-_]+|[-_]+$/g, '');
      // Convert to lowercase
      n = n.toLowerCase();
      // Fallback for empty result
      if (!n) {
        n = 'default';
      }
      return n;
  }

  /**
   * Generate slug name
   */
  generateSlugName(name) {
    if (name === undefined || name === null) {
      return '';
    }
    let n = String(name);
    // Remove null bytes
    n = n.replace(/\0/g, '');
    // URL decode to catch encoded traversal attempts
    try {
      n = decodeURIComponent(n);
    }
    catch (e) {
      // ignore decode errors, keep original string
    }
    // Remove path traversal sequences while preserving forward slashes for URLs
    n = n.replace(/\.{2,}[\\/]*?/g, ''); // remove ../ and .. sequences
    n = n.replace(/\\/g, ''); // remove backslashes
    // Convert to lowercase first
    let slug = n.toLowerCase();
    // Allow word chars, hyphens, and forward slashes; normalize others to '-'
    slug = slug.replace(/[^\w\-\/]+/g, '-');
    // Clean up multiple consecutive hyphens
    slug = slug.replace(/-{2,}/g, '-');
    // Clean up multiple consecutive slashes
    slug = slug.replace(/\/{2,}/g, '/');
    // Remove leading/trailing hyphens and slashes
    slug = slug.replace(/^[-/]+|[-/]+$/g, '');
    // Ensure no path traversal sequences remain after processing
    if (slug.indexOf('..') !== -1) {
      slug = slug.replace(/\.+/g, '');
    }
    // slugs CAN NOT start with / but otherwise it should be allowed
    while (slug.substring(0, 1) === '/') {
      slug = slug.substring(1);
    }
    return slug;
  }
  /**
   * Generate UUID
   */
  generateUUID() {
    return uuidv4();
  }
  /**
   * Clean up a title / sanitize the input string for file system usage
   */
  cleanTitle(value, stripPage = true)
  {
      let cleanTitle = value.trim();
      // strips off the identifies for a page on the file system
      if (stripPage) {
          cleanTitle = cleanTitle.replace('pages/', '').replace('/index.html', '');
      }
      cleanTitle = cleanTitle.replace(/ /g, '-').toLowerCase();
      cleanTitle = cleanTitle.replace(/[^\w\-\/]+/gu, '-');
      cleanTitle = cleanTitle.replace(/--+/gu, '-');
      // ensure we don't return an empty title or it could break downstream things
      if (cleanTitle == '') {
          cleanTitle = 'blank';
      }
      return cleanTitle;
  }
  /**
   * Validate that a request token is accurate
   */
  validateRequestToken(token = null, value = '', query = {})
    {
      if (this.isCLI() || (this.HAXCMS_DISABLE_JWT_CHECKS && !this.isProductionRuntime())) {
          return true;
      }
      // default token is POST
      if (token == null && query['token']) {
        token = query['token'];
      }
      if (token != null) {
        if (this.safeStringCompare(this.getRequestToken(value), String(token))) {
          return true;
        }
      }
      return false;
    }
    /**
     * Get the active user name based on the session
     * or the super user if the session is not set
     */
    getActiveUserName() {
      if (this.user.name != null && this.user.name != '') {
        return this.user.name;
      }
      else if (this.superUser.name) {
        return this.superUser.name;
      }
    }
    getRequestToken(value = '')
    {
        return this.hmacBase64(value, this.privateKey + this.salt);
    }
    hmacBase64(data, key)
    {
      return crypto
        .createHmac('sha256', key)
        .update(data)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    }
    /**
     * load form and spitting out HAXschema + values in our standard transmission method
     */
    async loadForm(form_id, context = []) {
      let fields = {};
      let value = {};
      // @todo add future support for dependency injection as far as allowed forms
      if (typeof this[form_id + "Form"] === "function") {
        fields = await this[form_id + "Form"](context);
      }
      else {
        fields = {
          '__failed': {
            'status': 500,
            'message': form_id + ' does not exist',
          }
        };
      }
      if (typeof this[form_id + "Value"] === "function") {
        value = await this[form_id + "Value"](context);
      }
      // ensure values are set for the hidden internal fields
      value.haxcms_form_id = form_id;
      value.haxcms_form_token = this.getRequestToken(form_id);
      return {
        'fields': fields,
        'value': value,
      };
    }
    /**
     * Process the form submission data
     */
    async processForm(form_id, params, context = []) {
      // make sure we have the original value / key pairs for the form
      if (this[form_id + "Value"]) {
        value = await this[form_id + "Value"](context);
      }
      else {
        fields = {
          '__failed': {
            'status': 500,
            'message': form_id + ' does not exist',
          }
        };
      }
    }
    /**
     * Magic function that will convert foo.bar.zzz into obj.foo.bar.zzz with look up.
     */
    deepObjectLookUp(obj, path) {
      let thing = explode('-', path);
      // while exists, pop off key and expand deeper in value assessment
      let current = obj;
      while (thing.length > 0) {
        let key = thing.shift();
        if (typeof current !== 'undefined' && key) {
          current = current[key];
        }
      }
      return current;
    }

    /**
     * Return the form for the siteSettings
     */
    async siteSettingsForm(context) {
      let site = await this.loadSite(context['site']['name']);
      return this.config.site.fields;
    }
    /**
     * Build a selectorList for the front-end that has all values
     * for selection keyed by item id: title, ordered based on
     * hierarchy with -- for each level down
     */
    itemSelectorList() {
      let items = site.manifest.orderTree(site.manifest.items);
      itemValues = [
        {
          "text": "-- No page --",
          "value": null,
        }
      ];
      for (var key in items) {
        let item = items[key];
        // calculate -- depth so it looks like a tree
        itemBuilder = item;
        // walk back through parent tree
        distance = "- ";
        while (itemBuilder && itemBuilder.parent != null) {
          itemBuilder = this.findParent(items, itemBuilder);
          // double check structure is sound
          if (itemBuilder) {
            distance = "--" + distance;
          }
        }
        itemValues.push({
          "text": distance + item.title,
          "value": item.id,
        })
      }
      return itemValues;
    }
    /**
     * Return the form for the siteSettings
     */
    async siteSettingsValue(context) {
      let site = await this.loadSite(context['site']['name']);
      // passing in as JSON for sanity
      let jsonResponse = JSON.parse(`{
        "manifest": {
          "site": {
            "manifest-title": null,
            "manifest-description": null,
            "manifest-metadata-site-homePageId": null,
            "manifest-metadata-site-domain": null,
            "manifest-metadata-site-tags": null,
            "manifest-metadata-site-logo": null
          },
          "theme": {
            "manifest-metadata-theme-element": null,
            "manifest-metadata-theme-variables-image": null,
            "manifest-metadata-theme-variables-imageAlt": null,
            "manifest-metadata-theme-variables-imageLink": null,
            "manifest-metadata-theme-variables-hexCode": null,
            "manifest-metadata-theme-variables-cssVariable": null,
            "manifest-metadata-theme-variables-palette": null,
            "manifest-metadata-theme-variables-icon": null,
            "regions": {
              "manifest-metadata-theme-regions-header": null,
              "manifest-metadata-theme-regions-sidebarFirst": null,
              "manifest-metadata-theme-regions-sidebarSecond": null,
              "manifest-metadata-theme-regions-contentTop": null,
              "manifest-metadata-theme-regions-contentBottom": null,
              "manifest-metadata-theme-regions-footerPrimary": null,
              "manifest-metadata-theme-regions-footerSecondary": null
            }
          },
          "author": {
            "manifest-license": null,
            "manifest-metadata-author-image": null,
            "manifest-metadata-author-name": null,
            "manifest-metadata-author-email": null,
            "manifest-metadata-author-socialLink": null
          },
          "seo": {
            "manifest-metadata-site-settings-private": null,
            "manifest-metadata-site-settings-canonical": true,
            "manifest-metadata-site-settings-lang": null,
            "manifest-metadata-site-settings-pathauto": null,
            "manifest-metadata-site-settings-publishPagesOn": true,
            "manifest-metadata-site-settings-sw": null,
            "manifest-metadata-site-settings-forceUpgrade": null,
            "manifest-metadata-site-settings-gaID": null
          }
        }
      }`);
      // this will process the form values and engineer them out of
      // the manifest based on key location to value found there (if any)
      return this.populateManifestValues(site, jsonResponse);
    }
    /**
     * Populate values based on the structure of the form schema values
     * established previously. This REQUIRES that the key in the end
     * is a string in the form of "manifest-what-ever-value-this-needs"
     * which it then takes ANY structure and recursively populates it
     * with the appropriate values to match
     */
    populateManifestValues(site, manifestKeys) {
      for (var key in manifestKeys) {
        let value = manifestKeys[key];
        // cascade of our methodology for building out forms
        // which peg to the internal workings of JSON outline schema
        // while still being presented in a visually agnostic manner
        // this is some crazy S..
        // test if we have deeper items to traverse at this level

        if (typeof value !== "string" && typeof value !== "boolean" && value && Object.keys(value).length > 0) {
          manifestKeys[key] = this.populateManifestValues(site, value);
        }
        else if (typeof key === "string") {
          let lookup = this.deepObjectLookUp(site, key);
          if (lookup || lookup === '' || lookup === false) {
            // special support for regions as front end form structure differs slightly from backend
            // to support multiple attributes on a single object on front end
            // even when it's a 1 to 1
            if (key.indexOf('-regions-') !== -1) {
              let tmp = [];
              for (var rkey in lookup) {
                let regionId = lookup[rkey];
                if (regionId) {
                  tmp.push({
                    node: regionId
                  })  
                }
              }
              if (tmp.length > 0) {
                manifestKeys[key] = tmp;
              }
            }
            else {
              manifestKeys[key] = lookup;
            }
          }     
        }
      }
      // @todo needs to not be a hack :p
      if ((manifestKeys["manifest-metadata-theme-variables-cssVariable"])) {
        manifestKeys["manifest-metadata-theme-variables-cssVariable"] = manifestKeys["manifest-metadata-theme-variables-cssVariable"].replace('-7', '').replace("--simple-colors-default-theme-", '');
      }
      return manifestKeys;
    }
    /**
     * Get input method for HAXSchema based on a data type
     * @var type [string]
     */
    getInputMethod(type = null) {
      switch (type) {
        case 'string':
          return 'textfield';
        break;
        case 'number':
          return 'number';
        break;
        case 'date':
          return 'datepicker';
        break;
        case 'boolean':
          return 'boolean';
        break;
        default:
          return 'textfield';
        break;
      }
    }
    /**
     * Get the current version number
     */
    async getHAXCMSVersion()
    {
      let version = null;
      if (!version) {
        const versionFilePaths = [
          path.join(__dirname, '/../.version'),
          path.join(__dirname, '/../public', 'VERSION.txt'),
        ];
        for (let i = 0; i < versionFilePaths.length; i++) {
          const versionFilePath = versionFilePaths[i];
          if (!fs.existsSync(versionFilePath)) {
            continue;
          }
          let vFile = await fs.readFileSync(
            versionFilePath,
            {encoding:'utf8', flag:'r'},
            'utf8'
          );
          if (vFile) {
            return filter_var(vFile);
          }
        }
      }
      return version;
    }
    /**
     * Load theme location data as mix of config and system
     */
    getThemes()
    {
        return this.config.themes;
    }
    /**
     * Build valid JSON Schema for the config we have knowledge of
     */
    getConfigSchema()
    {
        schema = {};
        schema['schema'] = "http://json-schema.org/schema#";
        schema.title = "HAXCMS Config";
        schema.type = "object";
        schema.properties = {};
        schema.properties.publishing = {};
        schema.properties.publishing.title = "Publishing settings";
        schema.properties.publishing.type = "object";
        schema.properties.publishing.properties = {};
        schema.properties.apis = {};
        schema.properties.apis.title = "API Connectivity";
        schema.properties.apis.type = "object";
        schema.properties.apis.properties = {};
        // establish some defaults if nothing set internally
        publishing = {
            'vendor': {
                'name': 'Vendor',
                'description' :
                    'Name for this provided (github currently supported)',
                'value': 'github'
            },
            'branch': {
                'name': 'Branch',
                'description' :
                    'Project code branch (like master or gh-pages)',
                'value': 'gh-pages'
            },
            'url': {
                'name': 'Repo url',
                'description' :
                    'Base address / organization that new sites will be saved under',
                'value': 'git@github.com:elmsln'
            },
            'user': {
                'name': 'User / Org',
                'description': 'User name or organization to publish to',
                'value': ''
            },
            'email': {
                'name': 'Email',
                'description': 'Email address of your github account',
                'value': ''
            },
            'pass': {
                'name': 'Password',
                'description' :
                    'Only use this if you want to automate SSH key setup. This is not stored',
                'value': ''
            },
            'cdn': {
                'name': 'CDN',
                'description': 'A CDN address that supports HAXCMS',
                'value': 'cdn.webcomponents.psu.edu'
            }
        };
        // publishing
        for (var key in publishing) {
          let value = publishing[key];
            props = {};
            props.title = value['name'];
            props.type = 'string';
            if ((this.config.site.git[key])) {
                props.value = this.config.site.git[key];
            } else {
                props.value = value['value'];
            }
            props.component = {};
            props.component.name = "paper-input";
            props.component.valueProperty = "value";
            props.component.slot =
                '<div slot="suffix">' + value['description'] + '</div>';
            if (key == 'pass') {
                props.component.attributes = {};
                props.component.attributes.type = 'password';
            }
            if (key == 'pass' && (this.config.site.git.user)) {
                // keep moving but if we already have a user name we don't need this
                // we only ask for a password on the very first run through
                schema.properties.publishing.properties.user.component.slot =
                    '<div slot="suffix">Set, to change this manually edit config/config.json.</div>';
                schema.properties.publishing.properties.user.component.attributes = {};
                schema.properties.publishing.properties.user.component.attributes.disabled =
                    'disabled';
                schema.properties.publishing.properties.email.component.attributes = {};
                schema.properties.publishing.properties.email.component.attributes.disabled =
                    'disabled';
                schema.properties.publishing.properties.email.component.slot =
                    '<div slot="suffix">Set, to change this manually edit config/config.json.</div>';
            } else {
                schema.properties.publishing.properties[key] = props;
            }
        }
        // API keys
        hax = new HAXAppStoreService();
        apiDocs = hax.baseSupportedApps();
        for (var key in apiDocs) {
            props = {};
            props.title = key;
            props.type = 'string';
            // if we have this value loaded internally then set it
            if ((this.config.appStore.apiKeys[key])) {
                props.value = this.config.appStore.apiKeys[key];
            }
            props.component = {};
            // look for our documentation object name
            if ((apiDocs[key])) {
                props.title = apiDocs[key]['name'];
                props.component.slot =
                    '<div slot="suffix"><a href="' +
                    apiDocs[key]['docs'] +
                    '" target="_blank">See ' +
                    props.title +
                    ' developer docs.</a></div>';
            }
            props.component.name = "paper-input";
            props.component.valueProperty = "value";
            schema.properties.apis.properties[key] = props;
        }
        return schema;
    }
    /**
     * Set and validate config
     */
    setUserData(values)
    {
      // only support user picture for the moment
      if ((values.userPicture)) {
        this.userData.userPicture = values.userPicture;
      }
      this.saveUserDataFile();
    }
    /**
     * Write configuration to the config file
     */
    async saveUserDataFile()
    {
      return await fs.writeFileSync(this.configDirectory + '/userData.json',
        JSON.stringify(this.userData, null, 2)
      );
    }
    /**
     * Write configuration to the config file
     */
    async saveConfigFile()
    {
      return await fs.writeFileSync(this.configDirectory + '/config.json',
        JSON.stringify(this.config, null, 2)
      );
    }
    /**
     * get SSH Key that was created during install
     */
    getSSHKey()
    {
        return false;
    }
    // russia strikes again
    // https://stackoverflow.com/questions/3872423/php-problem-with-russian-language
    html_to_obj(html) {
      dom = new DOMDocument();
      html = mb_convert_encoding(html, 'HTML-ENTITIES', "UTF-8");
      dom.loadHTML(html);
      return this.element_to_obj(dom.documentElement);
    }
    element_to_obj(element) {
      obj = { "tag": element.tagName };
      for (var attribute in element.attributes) {
          obj[attribute.name] = attribute.value;
      }
      for (var subElement in element.childNodes) {
          if (subElement.nodeType == XML_TEXT_NODE) {
              obj["html"] = subElement.wholeText;
          }
          else {
              obj["children"].push(this.element_to_obj(subElement));
          }
      }
      return obj;
  }
    /**
     * parse attributes out of an HTML tag in a safer manner
     */
    parse_attributes(attr) {
      let atList = [];
      const regexp = /\s*(?:([a-z0-9-]+)\s*=\s*"([^"]*)")|(?:\s+([a-z0-9-]+)(?=\s*|>|\s+[a..z0-9]+))/ig;
      const matches = [...attr.matchAll(regexp)];
      for (var i in matches) {
        if (matches[i][3])
          atList[matches[i][3]] = null;
        else
          atList[matches[i][1]] = matches[i][2];
      }
      return atList;
    }
    /**
     * Helper for parsing out and returning page-break's in a body of content
     * to help support HAX multi-page editing / outlining capabilities
     */
    pageBreakParser(body = '<page-break></page-break>') {
      body += '<page-break fakeendcap="fakeendcap"></page-break>';
      let pageData = [];
      // match all pages + content
      const regexp = /(<page-break([\s\S]*?)>([\s\S]*?)<\/page-break>)([\s\S]*?)(?=<page-break)/g;
      const matches = [...body.matchAll(regexp)];
      for (var i in matches) {
        // replace & to avoid XML parsing issues
        let content = "<div " + matches[i][2].replace('published ', 'published="published" ').replace('locked ', 'locked="locked" ') + "></div>";
        let attrs = this.parse_attributes(content);
        pageData[i] = {
            "content": matches[i][4],
            // this assumes that the attributes are well formed; make sure front end did this
            // even for boolean attributes
            "attributes": attrs
        };
      }
      return pageData;
    }
    /**
     * Generate a valid HAX App store specification schema for connecting to this site via JSON.
     */
    siteConnectionJSON(siteToken = '', siteName = '')
    {
        const isMultisite = (
          this.operatingContext === 'multisite' ||
          (
            typeof this.getDeploymentProfile === 'function' &&
            this.getDeploymentProfile() === 'self-hosted-multi-site'
          )
        );
        const normalizedSiteName = String(siteName || '').trim();
        let browseEndPoint = 'x/api/v1/files';
        if (isMultisite && normalizedSiteName !== '') {
          browseEndPoint =
            this.sitesDirectory +
            '/' +
            encodeURIComponent(normalizedSiteName) +
            '/x/api/v1/files';
        }
        return {
      "details": {
        "title": "Local files",
        "icon": "perm-media",
        "color": "light-blue",
        "author": "HAXCMS",
        "description": "HAXCMS integration for HAX",
        "tags": ["media", "hax"]
      },
      "connection": {
        "protocol": this.protocol,
        "url": this.domain + this.basePath,
        "headers": {
          "X-HAXCMS-Site-Token": siteToken
        },
        "operations": {
          "browse": {
            "method": "GET",
            "endPoint": browseEndPoint,
            "pagination": {
              "style": "link",
              "props": {
                "first": "page.first",
                "next": "page.next",
                "previous": "page.previous",
                "last": "page.last"
              }
            },
            "search": {
              "filename": {
                "title": "File name",
                "type": "string"
              }
            },
            "data": {
              "__HAXAPPENDUPLOADENDPOINT__": true
            },
            "resultMap": {
              "defaultGizmoType": "image",
              "items": "data.files",
              "preview": {
                "title": "name",
                "details": "mimetype",
                "image": "fullUrl",
                "id": "uuid"
              },
              "gizmo": {
                "source": "fullUrl",
                "id": "uuid",
                "title": "name",
                "mimetype": "mimetype"
              }
            }
          },
          "add": {
            "method": "POST",
            "endPoint": browseEndPoint,
            "acceptsGizmoTypes": [
              "audio",
              "image",
              "gif",
              "video",
              "pdf",
              "csv",
              "svg",
              "markdown",
              "html",
              "document",
              "archive",
              "*"
            ],
            "resultMap": {
              "item": "data.file",
              "defaultGizmoType": "image",
              "gizmo": {
                "source": "url",
                "id": "uuid"
              }
            }
          }
        }
      }
    };
    }
  /**
   * Return the active URI if it exists
   */
   getURI() {
    if (HAXCMS && HAXCMS.request_url && HAXCMS.request_url.href) {
      return HAXCMS.request_url.href;
    }
    return '';
  }
  /**
   * Return the active domain if it exists
   */
   getDomain() {
    return this.domain;
  }
  /**
   * Load wc-registry.json relative to the site in question
   */
   getWCRegistryJson(site, base = './') {
    let wcMap = {};
    let wcPath = null;
    let wcPathCandidates = [];
    // need to make the request relative to site
    if (base == './') {
      if (site && site.siteDirectory) {
        wcPathCandidates.push(path.join(site.siteDirectory, 'wc-registry.json'));
      }
      // legacy expectation in project root
      wcPathCandidates.push(path.join(HAXCMS_ROOT, 'wc-registry.json'));
      // repo-local location used in haxcms-nodejs
      wcPathCandidates.push(path.join(HAXCMS_ROOT, 'src/public/wc-registry.json'));
      // fallback relative to this file for edge runtime roots
      wcPathCandidates.push(path.join(__dirname, '../public/wc-registry.json'));
    }
    else {
      wcPathCandidates.push(path.join(base, 'wc-registry.json'));
    }
    for (const candidatePath of wcPathCandidates) {
      if (fs.existsSync(candidatePath)) {
        wcPath = candidatePath;
        break;
      }
    }
    // support private IP space which will block this ever going through
    if (!process.env.IAM_PRIVATE_ADDRESS_SPACE && wcPath) {
      try {
        wcMap = JSON.parse(fs.readFileSync(wcPath, { encoding: 'utf8', flag: 'r' }));
      }
      catch (e) {
        wcMap = {};
      }
    }
    return wcMap;
  }
  /**
   * Test and ensure the name being returned is a location currently unused
   */
  getUniqueName(name)
  {
      let location = name;
      let loop = 0;
      const original = location;
      while (fs.existsSync(this.HAXCMS_ROOT + this.sitesDirectory + '/' + location)) {
        loop++;
        location = original + '-' + loop;
      }
      return location;
  }
    /**
     * Validate a JTW during POST
     */
    validateJWT(req, res)
    {
      if (this.isCLI() || (this.HAXCMS_DISABLE_JWT_CHECKS && !this.isProductionRuntime())) {
        return true;
      }
      var request = false;
      if (this.sessionJwt && this.sessionJwt != null) {
        request = this.decodeJWT(this.sessionJwt);
      }
      if (
        request == false &&
        req &&
        req.headers &&
        typeof req.headers.authorization === 'string' &&
        req.headers.authorization.trim() !== ''
      ) {
        const authorizationHeader = req.headers.authorization.trim();
        if (authorizationHeader.toLowerCase().indexOf('bearer ') === 0) {
          request = this.decodeJWT(authorizationHeader.substring(7).trim());
        }
      }
      // if we were able to find a valid JWT in that mess, try and validate it
      if (  
          request != false &&
          request.id &&
          request.id == this.getRequestToken('user') &&
          request.user &&
          this.validateUser(request.user)) {
        return true;
      }
      return false;
    }
    /**
     * Get user's JWT
     */
    getJWT(name = null)
    {
        let token = {};
        token['id'] = this.getRequestToken('user');
        let n = Math.floor(Date.now() / 1000);
        // used at time
        token['iat'] = n;
        // expiration time, 15 minutes
        token['exp'] = n + (15 * 60);
        // if the user was supplied then add to token, if not it's relatively worthless but oh well :)
        if (name) {
            token['user'] = name;
        }
        return JWT.sign(token, this.privateKey + this.salt);
    }
    /**
     * Decode the JWT to ensure accuracy, return false if an error happens
     */
    decodeJWT(key) {
      // if it can decode, it'll be an object, otherwise it's false
      try {
        return JWT.verify(key, this.privateKey + this.salt, {
          algorithms: ['HS256'],
        });
      }
      catch (e) {
        return false;
      }
    }
    /**
     * Get user's Refresh Token
     */
    getRefreshToken(name = null) {
      let token = {};
      token['user'] = name;
      let n = Math.floor(Date.now() / 1000);
      token['iat'] = n;
      token['exp'] = n + (24 * 60 * 60);
      return JWT.sign(token, this.refreshPrivateKey + this.salt);
    }
    /**
     * Decode the JWT to ensure accuracy, return false if an error happens
     */
    decodeRefreshToken(key) {
      // if it can decode, it'll be an object, otherwise it's false
      try {
        return JWT.verify(key, this.refreshPrivateKey + this.salt, {
          algorithms: ['HS256'],
        });
      }
      catch (e) {
        return false;
      }
    }
    /**
     * Validate a refresh JWT from cookie.
     * When endOnInvalid is true, this will send a 401 and clear the cookie
     * using the provided res object. When false it will simply return false
     * and let the caller decide what to do.
     */
    validateRefreshToken(endOnInvalid = true, req, res = null) {
      if (this.isCLI() || (this.HAXCMS_DISABLE_JWT_CHECKS && !this.isProductionRuntime())) {
        return true;
      }
      // get the refresh token from cookie
      let refreshToken = req.cookies['haxcms_refresh_token'];
      // if there isn't one then we have to bail
      if (!refreshToken) {
        if (endOnInvalid && res) {
          res.cookie('haxcms_refresh_token', '1', { maxAge: 1 });
          res.sendStatus(401);
        }
        return false;
      }
      // if there is a refresh token then decode it
      let refreshTokenDecoded = this.decodeRefreshToken(refreshToken);
      let n = Math.floor(Date.now() / 1000);
      // validate the token
      // make sure token has issued and expiration dates
      if ((refreshTokenDecoded.iat) && (refreshTokenDecoded.exp)) {
        // issued at date is less than or equal to now
        if (refreshTokenDecoded.iat <= n) {
          // expiration date is greater than now
          if (n < refreshTokenDecoded.exp) {
            // it's valid
            return refreshTokenDecoded;
          }
        }
      }
      // kick back the end if it's invalid and we are asked to end here
      if (endOnInvalid && res) {
        res.cookie('haxcms_refresh_token', '1', { maxAge: 1 });
        res.sendStatus(401);
      }
      return false;
    }
    /**
     * Validate that a user name that came across in a JWT decode is legit
     */
    validateUser(name)
    {
        if (
            this.user.name === name
        ) {
            return true;
        }
        else if (
            this.superUser.name === name
        ) {
            return true;
        }
        else {
            let usr = {};
            usr.name = name;
            usr.grantAccess = false;
            // fire custom event for things to respond to as needed
            // this is for SaaS providers to provide global validation
            return usr.grantAccess;
        }
        return false;
    }
    /**
     * test the active user login based on session.
     */
    testLogin(name, pass, adminFallback = false)
    {
        if (
            this.safeStringCompare(this.user.name, name) &&
            this.safeStringCompare(this.user.password, pass)
        ) {
            return true;
        }
        // if fallback is allowed, meaning the super admin then let them in
        // the default is to strictly test for the login in question
        // the fallback being allowable is useful for managed environments
        else if (
            adminFallback &&
            this.safeStringCompare(this.superUser.name, name) &&
            this.safeStringCompare(this.superUser.password, pass)
        ) {
            return true;
        }
        else {
            let usr = {};
            usr.name = name;
            usr.adminFallback = adminFallback;
            usr.grantAccess = false;
            // fire custom event for things to respond to as needed
            return usr.grantAccess;
        }
        return false;
    }
    /**
     * Recursive copy to rename high level but copy all files
     */
    async recurseCopy(src, dst, skip = [])
    {
      await fs.copySync(src, dst);
    }
}
const HAXCMS = new HAXCMSClass();

// recursively look backwards for site.json until we find one or have none (null)
async function systemStructureContext(dir = null) {
  if (!dir) {
    dir = process.cwd();
  }
  // verify file exists where we'd expect for a site
  if (fs.pathExistsSync(path.join(dir, SITE_FILE_NAME))) {
    // mirrors a 'load' but load in HAXcms context is a multi-site setup
    try {
      let site = new HAXCMSSite();
      await site.loadSingle(dir);
      return site;
    }
    catch(e) {}
  }
  return null;
}

module.exports = { HAXCMS, HAXCMSClass, HAXCMSSite, systemStructureContext };