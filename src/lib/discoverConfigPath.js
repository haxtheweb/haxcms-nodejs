const fs = require('fs-extra');
const path = require('path');
const homedir = require('os').homedir();

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
if (!foundConfig && fs.pathExistsSync(path.join(homedir, '.haxcmsconfig')) && fs.pathExistsSync(path.join(homedir, '.haxcmsconfig', '.isHAXcmsConfig'))) {
    foundConfig = path.join(homedir, '.haxcmsconfig');
}

// found something, send it back up
if (foundConfig) {
    discoverConfigPath = foundConfig;
}
else {
    // didn't find anything, so we have to create something on the fly
    if (fs.pathExistsSync(homedir)) {
        try {
            fs.mkdirSync(path.join(homedir, '.haxcmsconfig'));
            const homeConfig = path.join(homedir, '.haxcmsconfig');
            // touch empty file for there to be a config folder definition
            fs.createFileSync(path.join(homeConfig, '.isHAXcmsConfig'));
            fs.mkdirSync(path.join(homeConfig, 'tmp'));
            fs.mkdirSync(path.join(homeConfig, 'cache'));
            fs.mkdirSync(path.join(homeConfig, 'user'));
            fs.mkdirSync(path.join(homeConfig, 'user/files'));
            fs.mkdirSync(path.join(homeConfig, 'node_modules'));
    
            fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/config.json'), path.join(homeConfig, 'config.json'));
            fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/my-custom-elements.js'), path.join(homeConfig, 'my-custom-elements.js'));
            fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/userData.json'), path.join(homeConfig, 'userData.json'));
            // just for platform consistency, this makes no sense at face value
            fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/config.php'), path.join(homeConfig, 'config.php'));
            fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/.htaccess'), path.join(homeConfig, '.htaccess'));
            fs.copyFileSync(path.join(__dirname, '/../boilerplate/systemsetup/user-files-htaccess'), path.join(homeConfig, 'user/files/.htaccess'));
            // now we can declare that we have a path
            discoverConfigPath = path.join(homedir, '.haxcmsconfig');    
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
module.exports = { discoverConfigPath };
