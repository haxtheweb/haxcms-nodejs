const {
  getApiBasePath,
  getQueryValue,
  resolveSiteForRequest,
  sendFormattedResponse,
  findItemByIdOrSlug,
  getItemContent,
} = require("./siteRouteUtils.js");
const { sanitizeHTMLForStorage } = require("../../lib/sanitizeContent.js");
const FileContentScanner = require("../../lib/FileContentScanner.js");
const blockOperations = require("../../lib/blockOperations.js");
const { changeBudget } = require("../../lib/linkChecker.js");
const { HAXCMS } = require("../../lib/HAXCMS.js");

/**
 * x/api/v1/content/{idOrSlug}/blocks (haxtheweb/issues#3270)
 *
 * GET   lists the allowlisted elements on a page with the { tag, index,
 *       before } a client sends back to change one.
 * PATCH { ops: [...], note? } changes those elements without re-saving the
 *       page; see lib/blockOperations.js for the rules. All ops succeed or
 *       none do; one git commit per page.
 *
 * Mirrors haxcms-php lib/siteRoutes/v1/contentBlocks.php.
 */

// one block write per page at a time (read, patch, write); keyed by site
// directory and page id
const pageLocks = new Map();
async function withPageLock(key, fn) {
  const previous = pageLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  pageLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (pageLocks.get(key) === chained) {
      pageLocks.delete(key);
    }
  }
}

function notFound(res, message) {
  return res.status(404).json({ status: 404, data: { message } });
}

function isLocked(page) {
  return !!(
    page &&
    page.metadata &&
    (page.metadata.locked === true || page.metadata.locked === "true")
  );
}

// "alt on 3 img, href on 1 a" for the commit message
function summarize(ops) {
  const counts = {};
  ops.forEach((op) => {
    const tag = String(op.tag || "").toLowerCase();
    const what =
      op.op === "setAttributes" && op.set && typeof op.set === "object"
        ? Object.keys(op.set)
            .map((n) => String(n).toLowerCase())
            .sort()
            .join("+")
        : "block";
    const key = `${what} on ${tag}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts)
    .map((key) => {
      const parts = key.split(" on ");
      return `${parts[0]} on ${counts[key]} ${parts[1]}`;
    })
    .join(", ");
}

function normalizeNote(value) {
  if (typeof value !== "string") {
    return "";
  }
  // a git commit message: one line of plain text, no < or >, no control
  // characters
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>\x00-\x1f\x7f]/g, "")
    .trim()
    .substring(0, 120);
}

/**
 * When a media URL changes, the page's image/video lists (used by themes and
 * search cards) should follow it.
 */
function followMediaUrls(page, ops, results) {
  if (!page.metadata || typeof page.metadata !== "object") {
    return;
  }
  ["images", "videos"].forEach((key) => {
    if (!Array.isArray(page.metadata[key])) {
      return;
    }
    ops.forEach((op, i) => {
      const r = results[i];
      if (op.op !== "setAttributes" || !r || !r.set || !r.previous) {
        return;
      }
      Object.keys(r.set).forEach((name) => {
        const before = r.previous[name];
        const after = r.set[name];
        if (
          typeof before !== "string" ||
          before === "" ||
          typeof after !== "string" ||
          after === ""
        ) {
          return;
        }
        page.metadata[key] = page.metadata[key].map((v) =>
          v === before ? after : v,
        );
      });
    });
  });
}

async function listContentBlocks(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return notFound(
      res,
      "Unable to resolve site context for /x/api/v1/content/:idOrSlug/blocks",
    );
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : "";
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item || !item.id) {
    return notFound(res, `Content not found for idOrSlug "${idOrSlug}"`);
  }
  const tag = String(getQueryValue(req, "tag", "") || "").toLowerCase();
  const html = await getItemContent(site, item);
  const blocks = blockOperations.listBlocks(html, { tag });
  const apiBasePath = getApiBasePath(req);
  return sendFormattedResponse(
    req,
    res,
    {
      id: item.id,
      slug: item.slug || "",
      count: blocks.length,
      blocks,
      links: {
        self: `${apiBasePath}/v1/content/${encodeURIComponent(item.slug || item.id)}/blocks`,
      },
    },
    { allowedFormats: ["json"], defaultFormat: "json" },
  );
}

async function updateContentBlocks(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return notFound(
      res,
      "Unable to resolve site context for /x/api/v1/content/:idOrSlug/blocks",
    );
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : "";
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item || !item.id) {
    return notFound(res, `Content not found for idOrSlug "${idOrSlug}"`);
  }
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    return res
      .status(400)
      .json({ status: 400, data: { message: "Missing `ops` param" } });
  }
  if (body.ops.length > blockOperations.MAX_OPS) {
    return res.status(400).json({
      status: 400,
      data: {
        message: `invalid ops value (at most ${blockOperations.MAX_OPS} per page)`,
      },
    });
  }
  const page = site.loadNode(item.id);
  if (!page) {
    return notFound(res, `Content not found for idOrSlug "${idOrSlug}"`);
  }
  if (isLocked(page)) {
    return res.status(423).json({
      status: 423,
      data: { message: `Page "${idOrSlug}" is locked`, reason: "locked" },
    });
  }
  const ops = body.ops;
  const note = normalizeNote(body.note);
  const lockKey = `${site.siteDirectory}::${page.id}`;
  return withPageLock(lockKey, async () => {
    const html = String((await site.getPageContent(page)) || "");
    const outcome = blockOperations.runBlockOperations(html, ops, {
      sanitize: sanitizeHTMLForStorage,
    });
    if (!outcome.ok) {
      const opIndex = typeof outcome.op === "number" ? outcome.op : 0;
      if (outcome.code === "stale" || outcome.code === "ambiguous") {
        return res.status(409).json({
          status: 409,
          data: {
            message: `Block ${opIndex} no longer matches the stored page`,
            reason: outcome.code,
            detail: outcome.message,
            op: opIndex,
          },
        });
      }
      return res.status(400).json({
        status: 400,
        data: {
          message: `Block ${opIndex} refused (${outcome.code}): ${outcome.message}`,
          reason: outcome.code,
          detail: outcome.message,
          op: opIndex,
        },
      });
    }
    // A budget of block changes per site per window, charged only for a
    // change that passed every check and is about to be written, so a
    // script or AI agent cannot flood the site with commits while refused
    // and stale requests cost nothing.
    const rateSettings = HAXCMS.getBlockOperationsRateLimitSettings();
    const budget = changeBudget(
      `blocks::${site.siteDirectory}`,
      ops.length,
      Date.now(),
      rateSettings,
    );
    if (!budget.allowed) {
      const windowSeconds = Math.round(rateSettings.windowMs / 1000);
      res.set("Retry-After", String(budget.retryAfterSeconds));
      return res.status(429).json({
        status: 429,
        data: {
          message: `Block change limit reached: ${rateSettings.max} changes per ${windowSeconds} seconds for this site. You can retry in ${budget.retryAfterSeconds} seconds.`,
          reason: "rate-limited",
          retryAfter: budget.retryAfterSeconds,
          remaining: budget.remaining,
        },
      });
    }
    // what each set attribute held before, for metadata that follows URLs
    const scanBefore = blockOperations.scanElements(html);
    outcome.results.forEach((r) => {
      if (!r.set) {
        return;
      }
      const el = scanBefore.filter((e) => e.tag === r.tag)[r.index];
      const decoded = el
        ? blockOperations.listBlocks(html.slice(el.start, el.end), {
            tag: r.tag,
          })
        : [];
      r.previous = decoded.length ? decoded[0].attributes : {};
    });
    const written = await page.writeLocation(
      outcome.content,
      site.siteDirectory,
    );
    if (written === false) {
      return res
        .status(500)
        .json({ status: 500, data: { message: "failed to write" } });
    }
    await FileContentScanner.rebuildPageFilesUuids(site, page, outcome.content);
    if (
      !page.metadata ||
      typeof page.metadata !== "object" ||
      Array.isArray(page.metadata)
    ) {
      page.metadata = {};
    }
    followMediaUrls(page, ops, outcome.results);
    const now = Math.floor(Date.now() / 1000);
    page.metadata.updated = now;
    await site.updateNode(page, false);
    if (typeof site.writePageAlternateFormats === "function") {
      await site.writePageAlternateFormats(page, outcome.content);
    }
    if (
      site.manifest.metadata &&
      site.manifest.metadata.site &&
      typeof site.manifest.metadata.site === "object"
    ) {
      site.manifest.metadata.site.updated = now;
    }
    await site.manifest.save(false);
    await site.gitCommit(
      `Block operations: ${summarize(ops)} on ${page.title || "Untitled"} (${page.id})` +
        (note ? `: ${note}` : ""),
    );
    const apiBasePath = getApiBasePath(req);
    return sendFormattedResponse(
      req,
      res,
      {
        id: page.id,
        slug: page.slug || item.slug || "",
        title: page.title || "",
        count: outcome.results.length,
        results: outcome.results.map((r, i) => ({
          op: i,
          tag: r.tag,
          index: r.index,
          relocated: r.relocated,
          before: outcome.content.slice(r.start, r.end),
        })),
        links: {
          self: `${apiBasePath}/v1/content/${encodeURIComponent(page.slug || item.slug || page.id)}/blocks`,
        },
      },
      { allowedFormats: ["json"], defaultFormat: "json" },
    );
  });
}

module.exports = {
  listContentBlocks,
  updateContentBlocks,
  // exported for tests
  summarize,
  normalizeNote,
};
