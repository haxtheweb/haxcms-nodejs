/**
 * Copyright 2026 The Pennsylvania State University
 * @license Apache-2.0, see LICENSE for full text.
 */
/*
 * hax-site-check: what a HAXcms site zip import accepts, as one
 * dependency-free file that runs in browsers and in Node
 * (haxtheweb/issues#3426).
 *
 * haxcms-nodejs's own importer (lib/siteZip.js) uses these checks, so a
 * generator that runs this file gets the answer the importer would give.
 * haxcms-php keeps the same rules (SiteZip.php) under parity tests.
 *
 * Load it any way that suits:
 *   Node:     const { checkHaxSite } = require("./hax-site-check.js");
 *   Browser:  <script src="https://browser.hax.cloud/hax-site-check.js">
 *             or import "https://browser.hax.cloud/hax-site-check.js";
 *             then globalThis.HAXSiteCheck.checkHaxSite(...)
 *
 * It changes nothing and reads nothing on its own: it is handed site.json
 * (and, for checkHaxSite, the list of paths in the zip) and returns a list
 * of problems. An empty list of errors means the importer takes the site.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    // CommonJS (Node): exported, and nothing added to the global object
    module.exports = api;
  } else if (root) {
    // a <script> or an ES module import in a browser
    root.HAXSiteCheck = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : null, function () {
  "use strict";

  // version of these rules; changes with the hax-handoff protocol
  const VERSION = "1.0.0";

  const LIMITS = Object.freeze({
    // pages in one site.json
    maxItems: 5000,
    // a page id: letters, digits and _ . : - only
    maxIdLength: 255,
    // a path named by site.json
    maxPathLength: 1024,
    // entries in the zip (files and folders)
    maxZipEntries: 10000,
    // everything in the zip, inflated
    maxInflatedBytes: 256 * 1024 * 1024,
    // the zip upload itself, by default; an operator can set it from 1 MB up
    // to 1024 MB (security.conversionMaxUploadMb)
    defaultMaxUploadBytes: 50 * 1024 * 1024,
  });

  const ITEM_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
  const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  const CUSTOM_BUILD = "custom/build/custom.es6.js";

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function optional(value, type) {
    return (
      typeof value === "undefined" || value === null || typeof value === type
    );
  }

  // path.posix.normalize, without Node's path module
  function normalizePosix(value) {
    const absolute = value.charAt(0) === "/";
    const trailing = value.charAt(value.length - 1) === "/";
    const out = [];
    const parts = value.split("/");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === "" || part === ".") {
        continue;
      }
      if (part === "..") {
        if (out.length > 0 && out[out.length - 1] !== "..") {
          out.pop();
        } else if (!absolute) {
          out.push("..");
        }
        continue;
      }
      out.push(part);
    }
    let result = out.join("/");
    if (result === "" && !absolute) {
      result = ".";
    }
    if (result !== "" && trailing) {
      result += "/";
    }
    return (absolute ? "/" : "") + result;
  }

  /**
   * A path from site.json that stays inside the site folder, or "" when it
   * does not (a scheme, a backslash, an absolute path or one that climbs
   * out with ..). Query strings and #fragments are dropped.
   * @param {*} value
   * @returns {string}
   */
  function siteRelativePath(value) {
    if (
      typeof value !== "string" ||
      value === "" ||
      value.length > LIMITS.maxPathLength
    ) {
      return "";
    }
    if (SCHEME.test(value) || value.indexOf("\\") !== -1) {
      return "";
    }
    const cleaned = value.split("?")[0].split("#")[0];
    const normalized = normalizePosix(cleaned.replace(/^\.\//, ""));
    if (
      normalized === "" ||
      normalized === "." ||
      normalized.charAt(0) === "/" ||
      normalized === ".." ||
      normalized.indexOf("../") === 0
    ) {
      return "";
    }
    return normalized;
  }

  function problem(severity, code, message, path) {
    return { severity: severity, code: code, message: message, path: path };
  }

  /**
   * Every reason the importer would refuse this site.json, in order. The
   * importer refuses a site.json with any of these whole, before it reads a
   * page or file.
   * @param {*} site decoded site.json
   * @returns {Array<{severity: string, code: string, message: string, path: string}>}
   */
  function checkSiteOutline(site) {
    const out = [];
    const err = (code, message, path) =>
      out.push(problem("error", code, message, path));
    if (!isPlainObject(site)) {
      err("SITE_NOT_OBJECT", "site.json must be a JSON object.", "");
      return out;
    }
    if (!optional(site.title, "string")) {
      err("SITE_TITLE", "site.title must be a string.", "title");
    }
    if (!optional(site.description, "string")) {
      err(
        "SITE_DESCRIPTION",
        "site.description must be a string.",
        "description",
      );
    }
    if (
      !(typeof site.metadata === "undefined" || isPlainObject(site.metadata))
    ) {
      err("SITE_METADATA", "site.metadata must be an object.", "metadata");
    }
    if (!Array.isArray(site.items)) {
      err("ITEMS_MISSING", "site.items must be a list of pages.", "items");
      return out;
    }
    if (site.items.length === 0) {
      err("ITEMS_EMPTY", "site.items must list at least one page.", "items");
    }
    if (site.items.length > LIMITS.maxItems) {
      err(
        "ITEMS_TOO_MANY",
        "site.items lists " +
          site.items.length +
          " pages; the most a site can have is " +
          LIMITS.maxItems +
          ".",
        "items",
      );
    }
    const ids = new Set();
    site.items.forEach((item, i) => {
      const at = "items[" + i + "]";
      if (!isPlainObject(item)) {
        err("ITEM_NOT_OBJECT", "Each page must be an object.", at);
        return;
      }
      if (typeof item.id !== "string") {
        err("ITEM_ID", "Each page needs a string id.", at + ".id");
      } else if (!ITEM_ID.test(item.id)) {
        err(
          "ITEM_ID",
          "A page id may use only letters, digits and _ . : - and be 1 to " +
            LIMITS.maxIdLength +
            " characters long.",
          at + ".id",
        );
      } else if (ids.has(item.id)) {
        err(
          "ITEM_ID_DUPLICATE",
          "Page id " + item.id + " is used twice.",
          at + ".id",
        );
      } else {
        ids.add(item.id);
      }
      if (!/^pages\/.+\.html$/.test(siteRelativePath(item.location))) {
        err(
          "ITEM_LOCATION",
          "A page's location must be an .html file under pages/ inside the site (for example pages/home/index.html).",
          at + ".location",
        );
      }
      const types = [
        ["title", "string"],
        ["slug", "string"],
        ["parent", "string"],
        ["indent", "number"],
        ["order", "number"],
      ];
      types.forEach((pair) => {
        if (!optional(item[pair[0]], pair[1])) {
          err(
            "ITEM_" + pair[0].toUpperCase(),
            "A page's " + pair[0] + " must be a " + pair[1] + " (or null).",
            at + "." + pair[0],
          );
        }
      });
      if (
        !(typeof item.metadata === "undefined" || isPlainObject(item.metadata))
      ) {
        err(
          "ITEM_METADATA",
          "A page's metadata must be an object.",
          at + ".metadata",
        );
        return;
      }
      const files = item.metadata ? item.metadata.files : undefined;
      if (typeof files === "undefined") {
        return;
      }
      if (!Array.isArray(files)) {
        err(
          "ITEM_FILES",
          "metadata.files must be a list.",
          at + ".metadata.files",
        );
        return;
      }
      files.forEach((file, j) => {
        if (
          !isPlainObject(file) ||
          !/^files\/./.test(siteRelativePath(file.url))
        ) {
          err(
            "ITEM_FILE_URL",
            "Each file a page lists must have a url under files/ inside the site.",
            at + ".metadata.files[" + j + "].url",
          );
        }
      });
    });
    return out;
  }

  /**
   * True when the importer takes this site.json.
   * @param {*} site decoded site.json
   * @returns {boolean}
   */
  function isSiteOutline(site) {
    return checkSiteOutline(site).length === 0;
  }

  /**
   * The folder in the zip that holds site.json: "" at the top, "name/" one
   * folder down, null when there is none (deeper does not count).
   * @param {Array<string>} paths every entry path in the zip
   * @returns {string|null}
   */
  function siteRoot(paths) {
    if (paths.indexOf("site.json") !== -1) {
      return "";
    }
    for (let i = 0; i < paths.length; i++) {
      const parts = paths[i].split("/");
      if (parts.length === 2 && parts[1] === "site.json" && parts[0] !== "") {
        return parts[0] + "/";
      }
    }
    return null;
  }

  /**
   * Check a site before handing it to HAX: the rules the importer applies
   * (errors) plus what would import but lose something (warnings).
   *
   * @param {Object} site
   * @param {*} site.siteJson site.json, decoded or as text
   * @param {Array<string>|Object} [site.files] every path in the zip, as a
   *   list or as an object keyed by path (values are sizes in bytes). With
   *   files, the check also places site.json and looks for the pages and
   *   files it names.
   * @param {number} [site.zipBytes] size of the zip, to check the upload cap
   * @param {number} [site.maxUploadBytes] the receiving server's upload cap,
   *   when known (default LIMITS.defaultMaxUploadBytes)
   * @returns {{ok: boolean, problems: Array, version: string}}
   */
  function checkHaxSite(site) {
    const problems = [];
    const input = isPlainObject(site) ? site : {};
    let paths = null;
    let sizes = null;
    if (Array.isArray(input.files)) {
      paths = input.files.filter((p) => typeof p === "string");
    } else if (isPlainObject(input.files)) {
      sizes = input.files;
      paths = Object.keys(input.files);
    }
    let prefix = "";
    if (paths) {
      // folders are not entries the importer reads
      const filesOnly = paths.filter((p) => p.charAt(p.length - 1) !== "/");
      if (paths.length > LIMITS.maxZipEntries) {
        problems.push(
          problem(
            "error",
            "ZIP_TOO_MANY_ENTRIES",
            "The zip holds " +
              paths.length +
              " entries; the most it can hold is " +
              LIMITS.maxZipEntries +
              ".",
            "",
          ),
        );
      }
      if (sizes) {
        let total = 0;
        filesOnly.forEach((p) => {
          total += typeof sizes[p] === "number" && sizes[p] > 0 ? sizes[p] : 0;
        });
        if (total > LIMITS.maxInflatedBytes) {
          problems.push(
            problem(
              "error",
              "ZIP_TOO_LARGE",
              "The site's files add up to more than " +
                Math.round(LIMITS.maxInflatedBytes / (1024 * 1024)) +
                " MB.",
              "",
            ),
          );
        }
      }
      const found = siteRoot(filesOnly);
      if (found === null) {
        problems.push(
          problem(
            "error",
            "SITE_JSON_MISSING",
            "The zip needs site.json at its top or inside one folder.",
            "site.json",
          ),
        );
        return { ok: false, problems: problems, version: VERSION };
      }
      prefix = found;
      paths = filesOnly;
    }
    if (typeof input.zipBytes === "number") {
      const cap =
        typeof input.maxUploadBytes === "number" && input.maxUploadBytes > 0
          ? input.maxUploadBytes
          : LIMITS.defaultMaxUploadBytes;
      if (input.zipBytes > cap) {
        problems.push(
          problem(
            "error",
            "ZIP_UPLOAD_TOO_LARGE",
            "The zip is larger than the " +
              Math.round(cap / (1024 * 1024)) +
              " MB the server takes.",
            "",
          ),
        );
      }
    }
    let siteJson = input.siteJson;
    if (typeof siteJson === "string") {
      try {
        siteJson = JSON.parse(siteJson);
      } catch {
        problems.push(
          problem(
            "error",
            "SITE_JSON_PARSE",
            "site.json is not valid JSON.",
            "site.json",
          ),
        );
        return { ok: false, problems: problems, version: VERSION };
      }
    }
    const outline = checkSiteOutline(siteJson);
    outline.forEach((p) => problems.push(p));
    if (paths && outline.length === 0) {
      const has = (relative) => {
        const safe = siteRelativePath(relative);
        return safe !== "" && paths.indexOf(prefix + safe) !== -1;
      };
      siteJson.items.forEach((item, i) => {
        if (!has(item.location)) {
          problems.push(
            problem(
              "warning",
              "PAGE_MISSING",
              "Page " +
                item.id +
                " names " +
                item.location +
                ", which is not in the zip; it imports empty.",
              "items[" + i + "].location",
            ),
          );
        }
        const files =
          item.metadata && item.metadata.files ? item.metadata.files : [];
        files.forEach((file, j) => {
          if (!has(file.url)) {
            problems.push(
              problem(
                "warning",
                "FILE_MISSING",
                file.url + " is not in the zip, so it is not imported.",
                "items[" + i + "].metadata.files[" + j + "].url",
              ),
            );
          }
        });
      });
      if (paths.indexOf(prefix + CUSTOM_BUILD) !== -1) {
        problems.push(
          problem(
            "warning",
            "CUSTOM_CODE",
            "The site carries its own JavaScript (" +
              CUSTOM_BUILD +
              "). It imports where the server allows site zip imports (browser.hax.cloud does); other servers refuse site zips unless the operator turns them on.",
            CUSTOM_BUILD,
          ),
        );
      }
    }
    return {
      ok: problems.every((p) => p.severity !== "error"),
      problems: problems,
      version: VERSION,
    };
  }

  return Object.freeze({
    VERSION: VERSION,
    LIMITS: LIMITS,
    CUSTOM_BUILD: CUSTOM_BUILD,
    siteRelativePath: siteRelativePath,
    checkSiteOutline: checkSiteOutline,
    isSiteOutline: isSiteOutline,
    siteRoot: siteRoot,
    checkHaxSite: checkHaxSite,
  });
});
