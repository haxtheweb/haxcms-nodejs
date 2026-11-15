const fs = require("fs");
const path = require("path");
const util = require("node:util");
const child_process = require("node:child_process");
const execFile = util.promisify(child_process.execFile);
const stripTagsImport = require("locutus/php/strings/strip_tags");
const strip_tags = stripTagsImport.strip_tags || stripTagsImport;
const {
  sanitizeURLValue,
  sanitizeHTMLForStorage,
} = require("../../lib/sanitizeContent.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const { clientSafeErrorDetail } = require("../../lib/clientErrorMessage.js");
const {
  getApiBasePath,
  getQueryValue,
  resolveSiteForRequest,
  findItemByIdOrSlug,
  sendFormattedResponse,
} = require("./siteRouteUtils.js");
const { parseCommitMessage } = require("../../lib/commitContext.js");
const {
  SITE_FILE,
  STRUCTURE_SCAN_LIMIT,
  findStructureChanges,
} = require("../../lib/structureHistory.js");

/**
 * haxtheweb/issues#3191: split a commit subject into its op-code parts.
 * Subjects without a valid prefix (manual commits, history from before op
 * codes) come back as actor "X" with the subject as the summary.
 */
function getCommitOpFields(message = "") {
  return parseCommitMessage(message);
}

function sanitizePageLocation(siteDirectory, location) {
  const normalizedLocation = String(location || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalizedLocation || normalizedLocation.indexOf("..") !== -1) {
    return null;
  }
  const siteRoot = path.resolve(siteDirectory);
  const absolutePath = path.resolve(siteRoot, normalizedLocation);
  const siteRootPrefix = siteRoot + path.sep;
  if (absolutePath !== siteRoot && absolutePath.indexOf(siteRootPrefix) !== 0) {
    return null;
  }
  return {
    absolutePath,
    location: normalizedLocation,
  };
}

async function gitOutput(siteDirectory, args, trim = true) {
  const result = await execFile("git", ["--no-pager"].concat(args), {
    cwd: siteDirectory,
    maxBuffer: 1024 * 1024 * 20,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (trim) {
    return stdout.trim();
  }
  return stdout;
}

function toPositiveInteger(value, fallbackValue, minValue = 0, maxValue = 0) {
  let parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    parsed = fallbackValue;
  }
  if (parsed < minValue) {
    parsed = minValue;
  }
  if (maxValue > 0 && parsed > maxValue) {
    parsed = maxValue;
  }
  return parsed;
}

function parseRevisionRows(logRaw = "", offset = 0) {
  const revisions = [];
  if (!logRaw) {
    return revisions;
  }
  const lines = String(logRaw).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) {
      continue;
    }
    const parts = lines[i].split("\u001f");
    if (parts.length < 7) {
      continue;
    }
    const timestamp = parseInt(parts[4], 10);
    revisions.push({
      revisionNumber: offset + revisions.length + 1,
      hash: parts[0],
      shortHash: parts[1],
      author: parts[2],
      authorEmail: parts[3],
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
      date: parts[5],
      message: parts[6],
      ...getCommitOpFields(parts[6]),
    });
  }
  return revisions;
}

function sanitizeRevisionId(value = "") {
  let revisionId = String(value || "").trim();
  if (revisionId === "") {
    return "";
  }
  try {
    revisionId = decodeURIComponent(revisionId);
  } catch {
    // intentionally ignored
  }
  revisionId = revisionId.trim();
  if (!/^[a-fA-F0-9]{7,64}$/.test(revisionId)) {
    return "";
  }
  return revisionId;
}

function parseRevisionJSONPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(rawPayload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getItemMetadataFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const itemMetadata = {};
  if (Object.prototype.hasOwnProperty.call(payload, "id")) {
    itemMetadata.id = payload.id;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "title")) {
    itemMetadata.title = payload.title;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "description")) {
    itemMetadata.description = payload.description;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "slug")) {
    itemMetadata.slug = payload.slug;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "parent")) {
    itemMetadata.parent = payload.parent;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "order")) {
    itemMetadata.order = payload.order;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "indent")) {
    itemMetadata.indent = payload.indent;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "metadata") &&
    payload.metadata &&
    typeof payload.metadata === "object" &&
    !Array.isArray(payload.metadata)
  ) {
    itemMetadata.metadata = payload.metadata;
  } else {
    itemMetadata.metadata = {};
  }
  return itemMetadata;
}

function ensurePageMetadata(page) {
  if (
    !page.metadata ||
    typeof page.metadata !== "object" ||
    Array.isArray(page.metadata)
  ) {
    page.metadata = {};
  }
}

function normalizeTextValue(value) {
  if (value === null || typeof value === "undefined") {
    return "";
  }
  return strip_tags(String(value));
}

function setBooleanMetadataValue(page, sourceMetadata, fieldName) {
  if (
    sourceMetadata &&
    Object.prototype.hasOwnProperty.call(sourceMetadata, fieldName)
  ) {
    page.metadata[fieldName] = Boolean(sourceMetadata[fieldName]);
  } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
    delete page.metadata[fieldName];
  }
}

function setURLMetadataValue(page, sourceMetadata, fieldName) {
  if (
    sourceMetadata &&
    Object.prototype.hasOwnProperty.call(sourceMetadata, fieldName)
  ) {
    const safeValue = sanitizeURLValue(sourceMetadata[fieldName], "");
    if (safeValue) {
      page.metadata[fieldName] = safeValue;
    } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
      delete page.metadata[fieldName];
    }
  } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
    delete page.metadata[fieldName];
  }
}

function setURLArrayMetadataValue(page, sourceMetadata, fieldName) {
  if (
    sourceMetadata &&
    Object.prototype.hasOwnProperty.call(sourceMetadata, fieldName) &&
    Array.isArray(sourceMetadata[fieldName])
  ) {
    const values = [];
    for (let i = 0; i < sourceMetadata[fieldName].length; i++) {
      const safeValue = sanitizeURLValue(sourceMetadata[fieldName][i], "");
      if (safeValue) {
        values.push(safeValue);
      }
    }
    page.metadata[fieldName] = values;
  } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
    delete page.metadata[fieldName];
  }
}

function applyItemMetadataToPage(page, itemMetadata) {
  if (
    !itemMetadata ||
    typeof itemMetadata !== "object" ||
    Array.isArray(itemMetadata)
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(itemMetadata, "title")) {
    page.title = normalizeTextValue(itemMetadata.title);
  }
  if (Object.prototype.hasOwnProperty.call(itemMetadata, "description")) {
    page.description = normalizeTextValue(itemMetadata.description);
  }
  const sourceMetadata =
    itemMetadata.metadata &&
    typeof itemMetadata.metadata === "object" &&
    !Array.isArray(itemMetadata.metadata)
      ? itemMetadata.metadata
      : null;
  ensurePageMetadata(page);
  setBooleanMetadataValue(page, sourceMetadata, "published");
  setBooleanMetadataValue(page, sourceMetadata, "locked");
  setURLMetadataValue(page, sourceMetadata, "image");
  setURLArrayMetadataValue(page, sourceMetadata, "images");
  setURLArrayMetadataValue(page, sourceMetadata, "videos");
  return true;
}

function parseRevisionMetadata(revisionMetadataRaw = "", revisionHash = "") {
  const metadataParts = String(revisionMetadataRaw || "")
    .trim()
    .split("\u001f");
  return {
    hash: metadataParts[0] || revisionHash,
    shortHash: metadataParts[1] || String(revisionHash).substring(0, 7),
    author: metadataParts[2] || "",
    authorEmail: metadataParts[3] || "",
    timestamp: parseInt(metadataParts[4], 10) || 0,
    date: metadataParts[5] || "",
    message: metadataParts[6] || "",
    ...getCommitOpFields(metadataParts[6] || ""),
  };
}

function resolveLookupValue(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.slug) {
    return String(item.slug);
  }
  if (item.id) {
    return String(item.id);
  }
  return "";
}

/** longest restore note kept; the commit line is capped at 200 anyway */
const RESTORE_NOTE_MAX_LENGTH = 120;

/**
 * An optional note for a restore commit: one line, no control characters,
 * whitespace collapsed, at most RESTORE_NOTE_MAX_LENGTH characters.
 * sanitizeGitCommitMessage() still runs on the whole commit line.
 */
function normalizeRestoreNote(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .substring(0, RESTORE_NOTE_MAX_LENGTH)
    .trim();
}

/** page detail fields compared between two revisions' item metadata */
const COMPARE_FIELDS = [
  [
    "title",
    (m) => (m.title === undefined || m.title === null ? "" : String(m.title)),
  ],
  [
    "description",
    (m) =>
      m.description === undefined || m.description === null
        ? ""
        : String(m.description),
  ],
  [
    "slug",
    (m) => (m.slug === undefined || m.slug === null ? "" : String(m.slug)),
  ],
  // published unless it says otherwise; hidden and locked are off unless set
  ["published", (m) => String(!(m.metadata && m.metadata.published === false))],
  ["hideInMenu", (m) => String(!!(m.metadata && m.metadata.hideInMenu))],
  ["locked", (m) => String(!!(m.metadata && m.metadata.locked))],
];

/**
 * Page detail fields that differ between two item metadata payloads, as
 * RevisionFieldChange rows. Empty when either side has no metadata.
 */
function diffRevisionItemMetadata(fromMetadata, toMetadata) {
  if (!fromMetadata || !toMetadata) {
    return [];
  }
  const changes = [];
  COMPARE_FIELDS.forEach(([field, read]) => {
    const from = read(fromMetadata);
    const to = read(toMetadata);
    if (from !== to) {
      changes.push({ field: field, from: from, to: to });
    }
  });
  return changes;
}

/**
 * One side of a compare: the commit's metadata, the page file at that
 * commit, and its item metadata (.json variant) when present.
 */
async function loadRevisionSide(
  siteDirectory,
  location,
  jsonVariantLocation,
  revisionHash,
) {
  const revisionMetadataRaw = await gitOutput(
    siteDirectory,
    [
      "show",
      "--quiet",
      "--date=iso-strict",
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%s",
      revisionHash,
    ],
    false,
  );
  if (!revisionMetadataRaw) {
    return null;
  }
  const revision = parseRevisionMetadata(revisionMetadataRaw, revisionHash);
  const content = await gitOutput(
    siteDirectory,
    ["show", revisionHash + ":" + location],
    false,
  );
  let itemMetadata = null;
  if (jsonVariantLocation) {
    try {
      const itemMetadataRaw = await gitOutput(
        siteDirectory,
        ["show", revisionHash + ":" + jsonVariantLocation],
        false,
      );
      itemMetadata = getItemMetadataFromPayload(
        parseRevisionJSONPayload(itemMetadataRaw),
      );
    } catch {
      // intentionally ignored: older revisions have no .json variant
    }
  }
  return {
    revision: revision,
    content: content,
    hasItemMetadata: !!itemMetadata,
    itemMetadata: itemMetadata,
  };
}

async function listItemRevisions(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      data: {
        message:
          "Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions",
      },
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : "";
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      data: { message: `Item not found for idOrSlug "${idOrSlug}"` },
    });
  }
  if (!item.id || typeof site.loadNode !== "function") {
    return res.status(404).json({
      status: 404,
      data: { message: "Unable to resolve item page context for revisions" },
    });
  }
  const page = site.loadNode(item.id);
  if (!page || !page.location) {
    return res.status(404).json({
      status: 404,
      data: { message: "Unable to resolve page location for revisions" },
    });
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return res.status(400).json({
      status: 400,
      data: { message: "Invalid node file location" },
    });
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return res.status(404).json({
      status: 404,
      data: { message: "Node file not found" },
    });
  }

  const limit = toPositiveInteger(
    getQueryValue(req, "page.limit", 25),
    25,
    1,
    200,
  );
  const offset = toPositiveInteger(
    getQueryValue(req, "page.offset", 0),
    0,
    0,
    0,
  );
  const logFormat = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%s";
  try {
    // haxtheweb/issues#3191: a page's history is the commits that touched
    // its file ("content") plus the commits where its outline entry in
    // site.json changed: moves, renames, publish toggles ("structure").
    // Newest first, in git's own order.
    const unionRaw = await gitOutput(
      site.siteDirectory,
      [
        "log",
        "--date=iso-strict",
        "--pretty=format:" + logFormat,
        "--",
        fileData.location,
        SITE_FILE,
      ],
      false,
    );
    const pageHashes = new Set(
      String(
        await gitOutput(
          site.siteDirectory,
          ["log", "--pretty=format:%H", "--", fileData.location],
          false,
        ),
      )
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row !== ""),
    );
    let structureChanges = {};
    try {
      // one more than the limit: the oldest is the baseline it is compared to
      const siteHashes = String(
        await gitOutput(
          site.siteDirectory,
          [
            "log",
            "--pretty=format:%H",
            "--max-count=" + (STRUCTURE_SCAN_LIMIT + 1),
            "--",
            SITE_FILE,
          ],
          false,
        ),
      )
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row !== "");
      structureChanges = await findStructureChanges(
        site.siteDirectory,
        item.id,
        siteHashes,
      );
    } catch {
      // structure history is best effort; content history still lists
      structureChanges = {};
    }
    const history = parseRevisionRows(unionRaw, 0)
      .filter(
        (row) =>
          pageHashes.has(row.hash) ||
          Object.prototype.hasOwnProperty.call(structureChanges, row.hash),
      )
      .map((row) => {
        row.kind = pageHashes.has(row.hash) ? "content" : "structure";
        row.changes = Object.prototype.hasOwnProperty.call(
          structureChanges,
          row.hash,
        )
          ? structureChanges[row.hash]
          : [];
        return row;
      });
    const total = history.length;
    const revisions = history
      .slice(offset, offset + limit)
      .map((row, index) => {
        row.revisionNumber = offset + index + 1;
        return row;
      });
    const lookupValue = item.slug ? String(item.slug) : String(item.id);
    const apiBasePath = getApiBasePath(req);
    const jsonVariantLocation =
      typeof site.getPageAlternateLocation === "function"
        ? site.getPageAlternateLocation(page.location, "json")
        : "";
    return sendFormattedResponse(
      req,
      res,
      {
        nodeId: item.id,
        nodeSlug: item.slug || "",
        nodeTitle: item.title || "",
        jsonVariantLocation: jsonVariantLocation || "",
        count: revisions.length,
        total,
        page: {
          limit,
          offset,
          total,
        },
        revisions,
        structureScanLimit: STRUCTURE_SCAN_LIMIT,
        links: {
          self: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions`,
          item: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}`,
        },
      },
      {
        allowedFormats: ["json"],
        defaultFormat: "json",
      },
    );
  } catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: clientSafeErrorDetail(e, "Unable to load item revisions"),
      },
    });
  }
}

async function itemRevisionDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      data: {
        message:
          "Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions/:revisionId",
      },
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : "";
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      data: { message: `Item not found for idOrSlug "${idOrSlug}"` },
    });
  }
  if (!item.id || typeof site.loadNode !== "function") {
    return res.status(404).json({
      status: 404,
      data: {
        message: "Unable to resolve item page context for revision detail",
      },
    });
  }
  const page = site.loadNode(item.id);
  if (!page || !page.location) {
    return res.status(404).json({
      status: 404,
      data: { message: "Unable to resolve page location for revision detail" },
    });
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return res.status(400).json({
      status: 400,
      data: { message: "Invalid node file location" },
    });
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return res.status(404).json({
      status: 404,
      data: { message: "Node file not found" },
    });
  }
  const revisionHash =
    req && req.params && req.params.revisionId
      ? sanitizeRevisionId(req.params.revisionId)
      : "";
  if (revisionHash === "") {
    return res.status(400).json({
      status: 400,
      data: { message: "Invalid revision hash" },
    });
  }
  try {
    const revisionMetadataRaw = await gitOutput(
      site.siteDirectory,
      [
        "show",
        "--quiet",
        "--date=iso-strict",
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%s",
        revisionHash,
      ],
      false,
    );
    if (!revisionMetadataRaw) {
      return res.status(404).json({
        status: 404,
        data: { message: "Revision not found" },
      });
    }
    const revisionMetadata = parseRevisionMetadata(
      revisionMetadataRaw,
      revisionHash,
    );
    const revisionContent = await gitOutput(
      site.siteDirectory,
      ["show", revisionHash + ":" + fileData.location],
      false,
    );
    const jsonVariantLocation =
      typeof site.getPageAlternateLocation === "function"
        ? site.getPageAlternateLocation(page.location, "json")
        : "";
    let itemMetadata = null;
    if (jsonVariantLocation) {
      try {
        const itemMetadataRaw = await gitOutput(
          site.siteDirectory,
          ["show", revisionHash + ":" + jsonVariantLocation],
          false,
        );
        const parsedPayload = parseRevisionJSONPayload(itemMetadataRaw);
        itemMetadata = getItemMetadataFromPayload(parsedPayload);
      } catch {
        // intentionally ignored
      }
    }
    const lookupValue = resolveLookupValue(item);
    const apiBasePath = getApiBasePath(req);
    return sendFormattedResponse(
      req,
      res,
      {
        nodeId: item.id,
        nodeSlug: item.slug || "",
        nodeTitle: item.title || "",
        revision: revisionMetadata,
        content: revisionContent,
        jsonVariantLocation: jsonVariantLocation || "",
        hasItemMetadata: !!itemMetadata,
        itemMetadata: itemMetadata,
        links: {
          self: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}`,
          revisions: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions`,
          restore: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}/restore`,
          item: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}`,
        },
      },
      {
        allowedFormats: ["json"],
        defaultFormat: "json",
      },
    );
  } catch (e) {
    const message = clientSafeErrorDetail(e, "");
    if (message.indexOf("does not exist") !== -1) {
      return res.status(404).json({
        status: 404,
        data: { message: "Revision content for this page was not found" },
      });
    }
    return res.status(500).json({
      status: 500,
      data: { message: message || "Unable to load item revision detail" },
    });
  }
}

/**
 * Compare two revisions of one page: both contents and the page detail
 * fields that differ (from = revisionId, to = compareRevisionId).
 */
async function compareItemRevisions(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      data: {
        message:
          "Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions/:revisionId/compare/:compareRevisionId",
      },
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : "";
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      data: { message: `Item not found for idOrSlug "${idOrSlug}"` },
    });
  }
  if (!item.id || typeof site.loadNode !== "function") {
    return res.status(404).json({
      status: 404,
      data: { message: "Unable to resolve item page context for compare" },
    });
  }
  const page = site.loadNode(item.id);
  if (!page || !page.location) {
    return res.status(404).json({
      status: 404,
      data: { message: "Unable to resolve page location for compare" },
    });
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return res.status(400).json({
      status: 400,
      data: { message: "Invalid node file location" },
    });
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return res.status(404).json({
      status: 404,
      data: { message: "Node file not found" },
    });
  }
  const fromHash =
    req && req.params && req.params.revisionId
      ? sanitizeRevisionId(req.params.revisionId)
      : "";
  const toHash =
    req && req.params && req.params.compareRevisionId
      ? sanitizeRevisionId(req.params.compareRevisionId)
      : "";
  if (fromHash === "" || toHash === "") {
    return res.status(400).json({
      status: 400,
      data: { message: "Invalid revision hash" },
    });
  }
  try {
    const jsonVariantLocation =
      typeof site.getPageAlternateLocation === "function"
        ? site.getPageAlternateLocation(page.location, "json")
        : "";
    const from = await loadRevisionSide(
      site.siteDirectory,
      fileData.location,
      jsonVariantLocation,
      fromHash,
    );
    const to = await loadRevisionSide(
      site.siteDirectory,
      fileData.location,
      jsonVariantLocation,
      toHash,
    );
    if (!from || !to) {
      return res.status(404).json({
        status: 404,
        data: { message: "Revision not found" },
      });
    }
    const lookupValue = resolveLookupValue(item);
    const apiBasePath = getApiBasePath(req);
    const itemBase = `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}`;
    return sendFormattedResponse(
      req,
      res,
      {
        nodeId: item.id,
        nodeSlug: item.slug || "",
        nodeTitle: item.title || "",
        jsonVariantLocation: jsonVariantLocation || "",
        from: from,
        to: to,
        contentChanged: from.content !== to.content,
        itemMetadataChanges: diffRevisionItemMetadata(
          from.itemMetadata,
          to.itemMetadata,
        ),
        links: {
          self: `${itemBase}/revisions/${encodeURIComponent(fromHash)}/compare/${encodeURIComponent(toHash)}`,
          from: `${itemBase}/revisions/${encodeURIComponent(fromHash)}`,
          to: `${itemBase}/revisions/${encodeURIComponent(toHash)}`,
          revisions: `${itemBase}/revisions`,
          item: itemBase,
        },
      },
      {
        allowedFormats: ["json"],
        defaultFormat: "json",
      },
    );
  } catch (e) {
    const message = clientSafeErrorDetail(e, "");
    // git's reason is in stderr; the client-safe message keeps only the
    // first line ("Command failed: ...")
    const reason =
      message + " " + (e && typeof e.stderr === "string" ? e.stderr : "");
    if (
      reason.indexOf("does not exist") !== -1 ||
      reason.indexOf("exists on disk, but not in") !== -1 ||
      reason.indexOf("bad object") !== -1 ||
      reason.indexOf("unknown revision") !== -1
    ) {
      return res.status(404).json({
        status: 404,
        data: { message: "Revision content for this page was not found" },
      });
    }
    return res.status(500).json({
      status: 500,
      data: { message: message || "Unable to compare item revisions" },
    });
  }
}

async function restoreItemRevision(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      data: {
        message:
          "Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions/:revisionId/restore",
      },
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : "";
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      data: { message: `Item not found for idOrSlug "${idOrSlug}"` },
    });
  }
  if (!item.id || typeof site.loadNode !== "function") {
    return res.status(404).json({
      status: 404,
      data: {
        message: "Unable to resolve item page context for revision restore",
      },
    });
  }
  const page = site.loadNode(item.id);
  if (!page || !page.location) {
    return res.status(404).json({
      status: 404,
      data: { message: "Unable to resolve page location for revision restore" },
    });
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return res.status(400).json({
      status: 400,
      data: { message: "Invalid node file location" },
    });
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return res.status(404).json({
      status: 404,
      data: { message: "Node file not found" },
    });
  }
  const revisionHash =
    req && req.params && req.params.revisionId
      ? sanitizeRevisionId(req.params.revisionId)
      : "";
  if (revisionHash === "") {
    return res.status(400).json({
      status: 400,
      data: { message: "Invalid revision hash" },
    });
  }
  try {
    // Security (SEC-SANITIZE): old revisions may predate the current
    // sanitizer policy; restore goes through the same storage sanitizer as
    // saveNode before it is written back
    const revisionContent = sanitizeHTMLForStorage(
      String(
        await gitOutput(
          site.siteDirectory,
          ["show", revisionHash + ":" + fileData.location],
          false,
        ),
      ),
    );
    const bytes = await page.writeLocation(revisionContent, site.siteDirectory);
    if (bytes === false) {
      return res.status(500).json({
        status: 500,
        data: { message: "Failed writing restored revision" },
      });
    }
    const jsonVariantLocation =
      typeof site.getPageAlternateLocation === "function"
        ? site.getPageAlternateLocation(page.location, "json")
        : "";
    let itemMetadata = null;
    let itemMetadataRestored = false;
    if (jsonVariantLocation) {
      try {
        const itemMetadataRaw = await gitOutput(
          site.siteDirectory,
          ["show", revisionHash + ":" + jsonVariantLocation],
          false,
        );
        const parsedPayload = parseRevisionJSONPayload(itemMetadataRaw);
        itemMetadata = getItemMetadataFromPayload(parsedPayload);
        itemMetadataRestored = applyItemMetadataToPage(page, itemMetadata);
      } catch {
        // intentionally ignored
      }
    }
    if (typeof site.writePageAlternateFormats === "function") {
      await site.writePageAlternateFormats(page, revisionContent);
    }
    if (
      !page.metadata ||
      typeof page.metadata !== "object" ||
      Array.isArray(page.metadata)
    ) {
      page.metadata = {};
    }
    const now = Math.floor(Date.now() / 1000);
    page.metadata.updated = now;
    if (
      site.manifest &&
      site.manifest.metadata &&
      site.manifest.metadata.site &&
      typeof site.manifest.metadata.site === "object"
    ) {
      site.manifest.metadata.site.updated = now;
    }
    if (site.manifest && typeof site.manifest.save === "function") {
      await site.manifest.save();
    }
    const note = normalizeRestoreNote(
      req && req.body && typeof req.body === "object" ? req.body.note : "",
    );
    if (typeof site.gitCommit === "function") {
      // the note goes last: when the line is too long for the 200 character
      // commit limit, the formatter cuts the note, never the restore itself
      await site.gitCommit(
        "Page revision restored: " +
          (page.title || "Untitled") +
          " (" +
          page.id +
          ") from " +
          revisionHash.substring(0, 12) +
          (note ? ": " + note : ""),
      );
    }
    const lookupValue = resolveLookupValue(item);
    const apiBasePath = getApiBasePath(req);
    return sendFormattedResponse(
      req,
      res,
      {
        nodeId: item.id,
        nodeSlug: item.slug || "",
        nodeTitle: page.title || item.title || "",
        restoredFromHash: revisionHash,
        note: note,
        jsonVariantLocation: jsonVariantLocation || "",
        hasItemMetadata: !!itemMetadata,
        itemMetadataRestored: itemMetadataRestored,
        links: {
          self: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}/restore`,
          revision: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}`,
          revisions: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions`,
          item: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}`,
        },
      },
      {
        allowedFormats: ["json"],
        defaultFormat: "json",
      },
    );
  } catch (e) {
    const message = clientSafeErrorDetail(e, "");
    if (message.indexOf("does not exist") !== -1) {
      return res.status(404).json({
        status: 404,
        data: { message: "Revision content for this page was not found" },
      });
    }
    return res.status(500).json({
      status: 500,
      data: { message: message || "Unable to restore item revision" },
    });
  }
}

module.exports = {
  listItemRevisions,
  itemRevisionDetail,
  compareItemRevisions,
  restoreItemRevision,
  getCommitOpFields,
  normalizeRestoreNote,
  diffRevisionItemMetadata,
};
