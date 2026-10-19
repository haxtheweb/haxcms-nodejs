"use strict";

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { HAXCMS } = require("./HAXCMS.js");
// reached through the module object so the network boundary can be stubbed in tests
const safeFetchLib = require("./safeFetch.js");

// Bulk-import staging shared by the site importers and createSite (#3060).
// HAXCMSFile.isValidBulkImportStagedPath only accepts real files under
// <configDirectory>/tmp/imports, so a remote file is downloaded here first and
// the staged path then takes the same bulk-import save as any other file.

// Directory under the HAXCMS config tree where bulk-import files are staged,
// created if it does not exist yet.
function getBulkImportStagingRoot() {
  const root = path.join(HAXCMS.configDirectory, "tmp", "imports");
  try {
    fs.ensureDirSync(root);
  } catch (e) {}
  return root;
}

// Fetch a remote file via safeFetch (SSRF-guarded: every resolved address and
// redirect hop is validated and the connection is pinned to the checked
// address) and stage it under the bulk-import root so createSite can move it
// into the site tree. Returns the absolute staged path, or null on any
// fetch/write failure or empty body (the file is simply skipped, matching how
// page fetch failures are handled). idx keeps staged filenames unique across
// the import.
async function stageRemoteFile(url, stagingRoot, idx, relPath) {
  try {
    const response = await safeFetchLib.safeFetch(url);
    if (!response || !response.ok) {
      return null;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf || buf.length === 0) {
      return null;
    }
    const ext = path.extname(relPath || "");
    // Security (L6): match safeFetchToFile's staging hygiene — exclusive
    // create at 0600 and a crypto-random name instead of Math.random().
    const stagedPath = path.join(
      stagingRoot,
      "haximp-" + Date.now() + "-" + idx + "-" + crypto.randomUUID() + ext,
    );
    fs.writeFileSync(stagedPath, buf, { mode: 0o600, flag: "wx" });
    return stagedPath;
  } catch (e) {
    return null;
  }
}

module.exports = { getBulkImportStagingRoot, stageRemoteFile };
