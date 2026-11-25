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
 * @returns {Promise<{items: Array, files: Object, site: Object, filename: string}>}
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
  if (!siteJson || !Array.isArray(siteJson.items)) {
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

module.exports = { readSiteZip, siteRelativePath, unlinkStaged };
