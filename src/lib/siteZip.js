"use strict";

const path = require("path");
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

const MAX_SITE_ITEMS = 5000;
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const CUSTOM_BUILD = "custom/build/custom.es6.js";
const BOILERPLATE_CUSTOM_ES6 = "// custom comment script here";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optional(value, type) {
  return (
    typeof value === "undefined" || value === null || typeof value === type
  );
}

// True when site.json is a HAXcms site outline (JSON Outline Schema as
// HAXcms writes it): a list of pages, each with a safe unique id, its HTML
// under pages/, and any files it names under files/. Anything else is not a
// site and is refused whole, before a page or file is read.
function isSiteOutline(site) {
  if (
    !isPlainObject(site) ||
    !Array.isArray(site.items) ||
    site.items.length === 0 ||
    site.items.length > MAX_SITE_ITEMS ||
    !optional(site.title, "string") ||
    !optional(site.description, "string") ||
    !(typeof site.metadata === "undefined" || isPlainObject(site.metadata))
  ) {
    return false;
  }
  const ids = new Set();
  for (const item of site.items) {
    if (!isPlainObject(item) || typeof item.id !== "string") {
      return false;
    }
    if (!ITEM_ID.test(item.id) || ids.has(item.id)) {
      return false;
    }
    ids.add(item.id);
    const location = siteRelativePath(item.location);
    if (!/^pages\/.+\.html$/.test(location)) {
      return false;
    }
    if (
      !optional(item.title, "string") ||
      !optional(item.slug, "string") ||
      !optional(item.parent, "string") ||
      !optional(item.indent, "number") ||
      !optional(item.order, "number") ||
      !(typeof item.metadata === "undefined" || isPlainObject(item.metadata))
    ) {
      return false;
    }
    const files = item.metadata ? item.metadata.files : undefined;
    if (typeof files !== "undefined") {
      if (!Array.isArray(files)) {
        return false;
      }
      for (const file of files) {
        if (
          !isPlainObject(file) ||
          !/^files\/./.test(siteRelativePath(file.url))
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function siteZipError(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.reason = code;
  return err;
}

// a relative path from site.json that stays inside the site folder, or ""
function siteRelativePath(value) {
  if (typeof value !== "string" || value === "" || value.length > 1024) {
    return "";
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.indexOf("\\") !== -1) {
    return "";
  }
  const cleaned = value.split("?")[0].split("#")[0];
  const normalized = path.posix.normalize(cleaned.replace(/^\.\//, ""));
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return "";
  }
  return normalized;
}

// the folder in the zip that holds site.json: "" at the top, "name/" one
// folder down; anything deeper is not a site zip
function siteRoot(zip) {
  if (zip.file("site.json")) {
    return "";
  }
  let found = null;
  zip.forEach((entryPath, entry) => {
    if (found !== null || entry.dir) {
      return;
    }
    const parts = entryPath.split("/");
    if (parts.length === 2 && parts[1] === "site.json" && parts[0] !== "") {
      found = parts[0] + "/";
    }
  });
  return found;
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
