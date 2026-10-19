#!/usr/bin/env node
// this runs when we are executing locally via npx
// this way we don't get multiple windows opening per port update
process.env.HAXCMS_DISABLE_JWT_CHECKS = true;
// Security (SEC-DEPLOY): with the no-login bypass active app.js binds
// 127.0.0.1 unless HAXCMS_HOST is set explicitly (e.g. HAXCMS_HOST=0.0.0.0 to
// allow LAN access, which prints a loud warning).
const { serverReady, serverProtocol, getListenHost } = require("./app.js");
const { getBrowserHost } = require("./lib/listenHost.js");
async function go() {
  const openPkg = await import("open");
  const open = openPkg.default;
  const port = await serverReady;
  // opens the url in the default browser
  open(`${serverProtocol}://${getBrowserHost(getListenHost())}:${port}`);
}

go();
