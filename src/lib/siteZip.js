"use strict";

const fs = require("fs-extra");
const JSZip = require("jszip");
const { boundZipBuffer, hasZipSignature } = require("./boundedZip.js");
const { stageFileBuffer } = require("./stageRemoteFile.js");

// A HAXcms site zip is what Download site gives: site.json (JSON Outline
// Schema) with pages/, files/ and maybe custom/ beside it, either at the top
// of the zip or inside one folder. Reading one gives the same result as
// importing the site from its address (convertHaxcmsToSite): items with their
// page contents, files staged under the bulk-import root, and a filename.
//
// Security (SEC-UPLOAD, SEC-DOS, SEC-PATH): the zip is inflated under
// boundedZip's limits before anything reads it; only regular entries under
// the folder that holds site.json are read; a path named by site.json is
// used only when it stays inside that folder (no "..", no absolute path, no
// scheme). Nothing is written but the staged copies, which createSite takes
// through its own checks.

// A site zip can carry custom/build/custom.es6.js: the site's own
// JavaScript, which runs for everyone who opens the site and for its editors
// on this origin. So importing a site from a zip is off unless the operator
// turns it on: config security.siteZipImport = true, or the environment
// variable HAXCMS_SITE_ZIP_IMPORT=true. haxcms-browser turns it on, because
// there HAXcms runs in the person's own tab and serves only them.
function siteZipImportEnabled() {
  if (process.env.HAXCMS_SITE_ZIP_IMPORT === "true") {
    return true;
  }
  const { HAXCMS } = require("./HAXCMS.js");
  return !!(
    HAXCMS &&
    HAXCMS.config &&
    HAXCMS.config.security &&
    HAXCMS.config.security.siteZipImport === true
  );
}

// What the importer accepts lives in one dependency-free file that
// generators run too (haxtheweb/issues#3426), so they and this importer
// cannot disagree: lib/shared/hax-site-check.js, served by browser.hax.cloud
// as /hax-site-check.js.
const siteCheck = require("./shared/hax-site-check.js");
const { siteRelativePath, isSiteOutline, CUSTOM_BUILD } = siteCheck;
const BOILERPLATE_CUSTOM_ES6 = "// custom comment script here";

function siteZipError(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.reason = code;
  return err;
}

// the folder in the zip that holds site.json: "" at the top, "name/" one
// folder down; anything deeper is not a site zip
function siteRoot(zip) {
  const paths = [];
  zip.forEach((entryPath, entry) => {
    if (!entry.dir) {
      paths.push(entryPath);
    }
  });
  return siteCheck.siteRoot(paths);
}

/**
 * Read an uploaded HAXcms site zip.
 * @param {Buffer} buffer the upload
 * @param {string} stagingRoot bulk-import staging root
 * @returns {Promise<{items: Array, files: Object, siteFiles: Object, site: Object, filename: string}>}
 */
async function readSiteZip(buffer, stagingRoot) {
  if (!hasZipSignature(buffer)) {
    throw siteZipError("Uploaded file is not a valid .zip file.", "NOT_A_ZIP");
  }
  let bounded;
  try {
    bounded = await boundZipBuffer(buffer, "zip");
  } catch (e) {
    throw siteZipError(
      e && e.message ? e.message : "Uploaded file is not a valid .zip file.",
      e && e.code === "ZIP_BUDGET" ? "ZIP_BUDGET" : "NOT_A_ZIP",
    );
  }
  const zip = await JSZip.loadAsync(bounded, { createFolders: false });
  const root = siteRoot(zip);
  if (root === null) {
    throw siteZipError("Invalid site.json structure", "INVALID_SITE");
  }
  let siteJson;
  try {
    siteJson = JSON.parse(await zip.file(root + "site.json").async("string"));
  } catch {
    throw siteZipError("Invalid site.json structure", "INVALID_SITE");
  }
  if (!isSiteOutline(siteJson)) {
    throw siteZipError("Invalid site.json structure", "INVALID_SITE");
  }

  const read = (relative) => {
    const safe = siteRelativePath(relative);
    if (safe === "") {
      return null;
    }
    const entry = zip.file(root + safe);
    return entry && !entry.dir ? entry : null;
  };

  const files = {};
  const siteFiles = {};
  let stagingIdx = 0;
  try {
    for (let i = 0; i < siteJson.items.length; i++) {
      const item = siteJson.items[i];
      if (!item || typeof item !== "object") {
        continue;
      }
      if (item.location) {
        const page = read(item.location);
        item.contents = page ? await page.async("string") : "";
      }
      if (
        item.metadata &&
        item.metadata.files &&
        Array.isArray(item.metadata.files)
      ) {
        for (let j = 0; j < item.metadata.files.length; j++) {
          const file = item.metadata.files[j];
          if (!file || typeof file.url !== "string") {
            continue;
          }
          const entry = read(file.url);
          if (!entry || files[file.url]) {
            continue;
          }
          const staged = stageFileBuffer(
            await entry.async("nodebuffer"),
            stagingRoot,
            stagingIdx++,
            file.url,
          );
          if (staged) {
            files[file.url] = staged;
          }
        }
      }
    }
    // the site's own code (a custom theme): carried as a staged file that
    // createSite writes to custom/build/custom.es6.js
    const custom = zip.file(root + CUSTOM_BUILD);
    if (custom && !custom.dir) {
      const code = await custom.async("nodebuffer");
      const text = code.toString("utf8").trim();
      if (text !== "" && text !== BOILERPLATE_CUSTOM_ES6) {
        const staged = stageFileBuffer(
          code,
          stagingRoot,
          stagingIdx++,
          "custom.es6.js",
        );
        if (staged) {
          siteFiles[CUSTOM_BUILD] = staged;
        }
      }
    }
  } catch (e) {
    unlinkStaged(files);
    throw e;
  }

  const metadata =
    siteJson.metadata && typeof siteJson.metadata === "object"
      ? siteJson.metadata
      : {};
  const siteMeta =
    metadata.site && typeof metadata.site === "object" ? metadata.site : {};
  const theme =
    metadata.theme &&
    typeof metadata.theme === "object" &&
    typeof metadata.theme.element === "string"
      ? metadata.theme.element
      : null;
  const title = typeof siteJson.title === "string" ? siteJson.title : "";
  const filename =
    typeof siteMeta.name === "string" && siteMeta.name !== ""
      ? siteMeta.name
      : title !== ""
        ? title
        : root.replace(/\/$/, "") || "imported-site";
  return {
    items: siteJson.items,
    files,
    siteFiles,
    filename,
    site: {
      title,
      description:
        typeof siteJson.description === "string" ? siteJson.description : "",
      theme,
    },
  };
}

function unlinkStaged(files) {
  for (const key of Object.keys(files || {})) {
    try {
      fs.unlinkSync(files[key]);
    } catch {
      // intentionally ignored
    }
  }
}

module.exports = {
  readSiteZip,
  siteRelativePath,
  isSiteOutline,
  siteZipImportEnabled,
  unlinkStaged,
  CUSTOM_BUILD,
};
