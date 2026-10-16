const fs = require('fs-extra');
const path = require('path');
let baseConfigPath = require('os').homedir();
// support for tmp in vercel
if (process.env.VERCEL_ENV) {
    baseConfigPath = "/tmp/";
}
// discover configuration based on path
// cascade is as follows
// - cwd path all the way back to root looking for _config or .haxcmsconfig directories
// - home directory for .haxcmsconfig
// - none? then use the baked in fake one / default or create one on the fly for the user?
let cwdPathAry = process.cwd().split('/');
let foundConfig = null;
var discoverConfigPath = null;
while (!foundConfig && cwdPathAry.length > 0) {
    let configPathCheck = path.join(cwdPathAry.join('/'), '_config');
    // verify that a file called .isHAXcmsConfig exists so we know it's not something else claiming to be config
    if (fs.pathExistsSync(configPathCheck) && fs.pathExistsSync(path.join(configPathCheck, '.isHAXcmsConfig'))) {
        foundConfig = configPathCheck;
    }
    // remove end so we can keep checking as we go
    cwdPathAry.pop();
}
// look in home directory if we found no project directory
// this can use the . config look up
if (!foundConfig && fs.pathExistsSync(path.join(baseConfigPath, '.haxcmsconfig')) && fs.pathExistsSync(path.join(baseConfigPath, '.haxcmsconfig', '.isHAXcmsConfig'))) {
    foundConfig = path.join(baseConfigPath, '.haxcmsconfig');
}

// found something, send it back up
if (foundConfig) {
    discoverConfigPath = foundConfig;
}
else {
    // didn't find anything, so we have to create something on the fly
    if (fs.pathExistsSync(baseConfigPath)) {
        try {
            // Security (review 2026-10): tolerate a pre-existing EMPTY
            // ~/.haxcmsconfig. The Docker image declares it as a VOLUME so the
            // keys / salt / admin user survive container recreation; a fresh
            // named volume or bind mount is an empty directory, and the old
            // mkdirSync() threw EEXIST there, dropping into the 'epic fail'
            // branch below (config inside the package, regenerated every boot).
            // ensureDirSync + copy-if-absent never overwrites existing files.
            const homeConfig = path.join(baseConfigPath, '.haxcmsconfig');
            fs.ensureDirSync(homeConfig);
            fs.ensureDirSync(path.join(homeConfig, 'tmp'));
            fs.ensureDirSync(path.join(homeConfig, 'cache'));
            fs.ensureDirSync(path.join(homeConfig, 'user'));
            fs.ensureDirSync(path.join(homeConfig, 'user/files'));
            // user-level skeletons live here (writable from UI)
            fs.ensureDirSync(path.join(homeConfig, 'user/skeletons'));
            // deployment-level skeleton overrides live here (mirrors PHP _config/skeletons)
            fs.ensureDirSync(path.join(homeConfig, 'skeletons'));
            // settings directory for system-level feature flags (enabled blocks/themes/skeletons)
            fs.ensureDirSync(path.join(homeConfig, 'settings'));
            fs.ensureDirSync(path.join(homeConfig, 'node_modules'));
            const copyIfAbsent = (from, to) => {
                if (!fs.pathExistsSync(to)) {
                    fs.copyFileSync(from, to);
                }
            };
            copyIfAbsent(path.join(__dirname, '/../boilerplate/systemsetup/config.json'), path.join(homeConfig, 'config.json'));
            copyIfAbsent(path.join(__dirname, '/../boilerplate/systemsetup/my-custom-elements.js'), path.join(homeConfig, 'my-custom-elements.js'));
            copyIfAbsent(path.join(__dirname, '/../boilerplate/systemsetup/userData.json'), path.join(homeConfig, 'userData.json'));
            // just for platform consistency, this makes no sense at face value
            copyIfAbsent(path.join(__dirname, '/../boilerplate/systemsetup/config.php'), path.join(homeConfig, 'config.php'));
            copyIfAbsent(path.join(__dirname, '/../boilerplate/systemsetup/.htaccess'), path.join(homeConfig, '.htaccess'));
            // the boilerplate ships this as a dotfile; the old name without the dot
            // threw ENOENT, which fell through to the 'epic fail' branch below and
            // put credentials inside the installed package (lost on every update)
            copyIfAbsent(path.join(__dirname, '/../boilerplate/systemsetup/.user-files-htaccess'), path.join(homeConfig, 'user/files/.htaccess'));
            // touch the marker LAST so a half-seeded directory is re-seeded next boot
            fs.ensureFileSync(path.join(homeConfig, '.isHAXcmsConfig'));
            // now we can declare that we have a path
            discoverConfigPath = homeConfig;
        }
        catch(e) {
            // epic fail
            discoverConfigPath = path.join(__dirname, '/../boilerplate/systemsetup/');
        }
    }
}
// ensure tmp is there
if (!fs.pathExistsSync(path.join(discoverConfigPath, 'tmp/'))) {
    fs.mkdirSync(path.join(discoverConfigPath, 'tmp/'));
}
// ensure settings exists for new and legacy config directories
if (!fs.pathExistsSync(path.join(discoverConfigPath, 'settings/'))) {
    fs.mkdirSync(path.join(discoverConfigPath, 'settings/'));
}
module.exports = { discoverConfigPath };
