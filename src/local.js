#!/usr/bin/env node

// this runs when we are executing locally via npx
// this way we don't get multiple windows opening per port update
process.env.HAXCMS_DISABLE_JWT_CHECKS = true;
const port = process.env.PORT || 3000;
require('./app.js');
async function go() {
  const openPkg = await import('open');
  const open = openPkg.default;
  // opens the url in the default browser 
  open(`http://localhost:${port}`);
}

go();