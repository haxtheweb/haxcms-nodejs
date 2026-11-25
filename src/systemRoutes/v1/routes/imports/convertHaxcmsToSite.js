// theme/ left the site boilerplate (haxtheweb/issues#3337) and is not a
// createSite siteFiles target; only the custom build carries over.
const SITE_FILES_TO_IMPORT = ["custom/build/custom.es6.js"];
const BOILERPLATE_CUSTOM_ES6 = "// custom comment script here";
const { safeFetch } = require("../../../../lib/safeFetch.js");
// files are staged locally so createSite can ingest them as file entities
const {
  getBulkImportStagingRoot,
  stageRemoteFile,
} = require("../../../../lib/stageRemoteFile.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const {
  clientSafeErrorDetail,
} = require("../../../../lib/clientErrorMessage.js");
const fs = require("fs-extra");
const {
  readSiteZip,
  siteZipImportEnabled,
} = require("../../../../lib/siteZip.js");
const {
  getConversionUploadMaxBytes,
} = require("../../../../lib/uploadSecurity.js");
const { HAXCMS } = require("../../../../lib/HAXCMS.js");

/**
 * POST /system/api/v1/site/import/:platform
 * Convert a remote HAXcms site into a JSON Outline Schema items array.
 *
 * Expects a JSON body with { repoUrl: string }.
 * Returns { status: 200, data: { items: [...], filename: string, files: {}, siteFiles: {} } }.
 */
async function convertHaxcmsToSite(req, res) {
  let body = {};
  if (
    req &&
    req.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body)
  ) {
    body = req.body;
  }

  // an uploaded site zip (what Download site gives) instead of an address
  if (req && Array.isArray(req.files) && req.files.length > 0) {
    return convertHaxcmsZipToSite(req.files[0], res);
  }

  if (!body || !body.repoUrl) {
    return res.status(400).json({
      status: 400,
      data: {
        error: "missing `repoUrl` param",
        items: [],
        filename: null,
      },
    });
  }

  let url = body.repoUrl.replace("/site.json", "");
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({
      status: 400,
      data: {
        error: "Invalid repoUrl",
        items: [],
        filename: null,
      },
    });
  }

  if (!parsedUrl.pathname || !parsedUrl.host) {
    return res.status(400).json({
      status: 400,
      data: {
        error: "Invalid repoUrl",
        items: [],
        filename: null,
      },
    });
  }

  parsedUrl.host = parsedUrl.host.replace("iam.", "oer.");
  const base =
    `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`.replace(
      /\/+$/,
      "",
    );

  let site;
  try {
    const response = await safeFetch(`${base}/site.json`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    site = await response.json();
  } catch (e) {
    return res.status(400).json({
      status: 400,
      data: {
        error: `Unable to fetch site.json: ${clientSafeErrorDetail(e)}`,
        items: [],
        filename: null,
      },
    });
  }

  if (!site || !Array.isArray(site.items)) {
    return res.status(400).json({
      status: 400,
      data: {
        error: "Invalid site.json structure",
        items: [],
        filename: null,
      },
    });
  }

  const downloads = {};
  const siteFiles = {};
  const stagingRoot = getBulkImportStagingRoot();
  let stagingIdx = 0;

  for (let i = 0; i < site.items.length; i++) {
    const item = site.items[i];
    if (item && item.location) {
      try {
        const response = await safeFetch(`${base}/${item.location}`);
        item.contents = response.ok ? await response.text() : "";
      } catch {
        item.contents = "";
      }
    }
    if (
      item.metadata &&
      item.metadata.files &&
      Array.isArray(item.metadata.files)
    ) {
      for (let j = 0; j < item.metadata.files.length; j++) {
        const file = item.metadata.files[j];
        if (file && file.url) {
          const stagedPath = await stageRemoteFile(
            `${base}/${file.url}`,
            stagingRoot,
            stagingIdx++,
            file.url,
          );
          if (stagedPath) {
            downloads[file.url] = stagedPath;
          }
        }
      }
    }
  }

  for (let i = 0; i < SITE_FILES_TO_IMPORT.length; i++) {
    const filePath = SITE_FILES_TO_IMPORT[i];
    try {
      const resp = await safeFetch(`${base}/${filePath}`);
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.trim() !== "") {
          if (
            filePath === "custom/build/custom.es6.js" &&
            text.trim() === BOILERPLATE_CUSTOM_ES6
          ) {
            continue;
          }
          siteFiles[filePath] = `${base}/${filePath}`;
        }
      }
    } catch {
      // intentionally ignored
    }
  }

  const filename =
    site.metadata && site.metadata.site && site.metadata.site.name
      ? site.metadata.site.name
      : parsedUrl.pathname.split("/").pop();

  return res.json({
    status: 200,
    data: {
      items: site.items,
      filename: filename,
      files: downloads,
      siteFiles: siteFiles,
    },
  });
}

/**
 * The same import from an uploaded HAXcms site zip (multipart, one file).
 * Returns the URL import's shape plus `site` ({ title, description, theme })
 * so a caller can keep the site's look. The site's custom build
 * (custom/build/custom.es6.js) comes back in siteFiles as a staged file,
 * which createSite writes only while site zip import is on.
 */
async function convertHaxcmsZipToSite(file, res) {
  // off unless the operator turns it on (see siteZipImportEnabled)
  if (!siteZipImportEnabled()) {
    return res.status(403).json({
      status: 403,
      data: {
        error: "site-zip-import is disabled",
        reason: "DISABLED",
        items: [],
        filename: null,
      },
    });
  }
  // Security (SEC-DOS): the conversion upload cap, not the general one; the
  // zip is read into memory
  const maxBytes = getConversionUploadMaxBytes(HAXCMS.config);
  if (typeof file.size === "number" && file.size > maxBytes) {
    return res.status(400).json({
      status: 400,
      data: {
        error: `File exceeds the maximum upload size of ${Math.round(maxBytes / (1024 * 1024))} MB`,
        reason: "ZIP_BUDGET",
        items: [],
        filename: null,
      },
    });
  }
  let buffer;
  try {
    buffer = fs.readFileSync(file.path);
  } catch (e) {
    return res.status(400).json({
      status: 400,
      data: {
        error: `Unable to read uploaded file: ${clientSafeErrorDetail(e)}`,
        items: [],
        filename: null,
      },
    });
  }
  try {
    const read = await readSiteZip(buffer, getBulkImportStagingRoot());
    return res.json({
      status: 200,
      data: {
        items: read.items,
        filename: read.filename,
        files: read.files,
        siteFiles: read.siteFiles,
        site: read.site,
      },
    });
  } catch (e) {
    return res.status(400).json({
      status: 400,
      data: {
        error: clientSafeErrorDetail(e),
        reason: e && typeof e.reason === "string" ? e.reason : "INVALID_SITE",
        items: [],
        filename: null,
      },
    });
  }
}

module.exports = { convertHaxcmsToSite };
