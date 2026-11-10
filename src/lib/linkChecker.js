"use strict";

/**
 * Outside link checks for Reports (haxtheweb/issues#3167).
 *
 * POST x/api/v1/site/check-links asks whether the outside links an author
 * put in their pages still answer. A browser cannot tell on its own: a
 * cross-origin fetch in no-cors mode is opaque (status 0 for a 200 and a 404
 * alike), so the check runs here. It replaces the old open-apis
 * linkValidator call, which sent the site's links to a third-party service.
 *
 * Abuse limits, so the endpoint cannot be used as an open proxy or a
 * request cannon:
 *  - Only links that appear in this site's own page HTML are checked. The
 *    request names which links; the URL that is fetched is always the one
 *    read from the site's content, never the string from the request body.
 *  - http(s) only, through safeFetch: every hop is DNS-resolved and refused
 *    if any address is private, loopback, link-local or cloud metadata, and
 *    the connection is pinned to the checked IP (no DNS rebinding).
 *  - HEAD first, then GET only when HEAD is refused; both discard the body,
 *    so nothing is downloaded and nothing from the remote site is returned
 *    to the caller except the status code and the final URL.
 *  - At most LINK_CHECK_MAX_LINKS per request, LINK_CHECK_CONCURRENCY at a
 *    time, a per-link timeout and redirect cap, and a per-request time
 *    budget (links not reached are answered "deferred" to send again).
 *  - A per user and site budget of network checks per window
 *    (config.security.linkCheckRateLimit); cached answers do not count.
 *  - Answers are cached for LINK_CHECK_RESULT_TTL_MS, so re-opening Reports
 *    does not re-request every outside site.
 *
 * Parity: haxcms-php lib/LinkChecker.php implements the same rules, states
 * and limits.
 */

const { parse } = require("node-html-parser");
const { safeFetch } = require("./safeFetch.js");

const LINK_CHECK_MAX_LINKS = 25;
const LINK_CHECK_MAX_HREF_LENGTH = 2048;
const LINK_CHECK_CONCURRENCY = 4;
const LINK_CHECK_TIMEOUT_MS = 8000;
const LINK_CHECK_MAX_REDIRECTS = 5;
const LINK_CHECK_RESULT_TTL_MS = 30 * 60 * 1000;
const LINK_CHECK_RESULT_CACHE_MAX = 2000;
const LINK_CHECK_SITE_LINKS_TTL_MS = 60 * 1000;
// Wall-clock budget for one request. Links not started by then come back
// "skipped" / "deferred" (not cached, not charged) for the client to resend.
const LINK_CHECK_REQUEST_BUDGET_MS = 20 * 1000;
const LINK_CHECK_USER_AGENT = "HAXcms-link-check/1.0 (+https://haxtheweb.org)";

// Statuses that mean the site answered but will not talk to a script, so a
// person should open the link: auth walls, bot blocking, rate limits.
const CHECK_BY_HAND_STATUSES = [401, 403, 407, 429, 451, 999];

const resultCache = new Map();
const siteLinksCache = new Map();
const budgetTracker = new Map();
const MAX_TRACKED_BUDGETS = 10000;

/**
 * The URL to fetch for an href as written in page HTML, or "" when it is
 * not an outside http(s) link. Protocol-relative //host links are checked
 * over https, the way a browser on an https site would follow them.
 */
function toCheckUrl(href) {
  if (typeof href !== "string") {
    return "";
  }
  var value = href.trim();
  if (value === "" || value.length > LINK_CHECK_MAX_HREF_LENGTH) {
    return "";
  }
  if (value.indexOf("//") === 0) {
    value = "https:" + value;
  }
  if (!/^https?:\/\//i.test(value)) {
    return "";
  }
  try {
    var parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    if (!parsed.hostname) {
      return "";
    }
    // the fragment never reaches the server; drop it so #a and #b share
    // one check
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * Outside links in a block of page HTML: Map of href (trimmed, as written)
 * to the URL that is fetched for it.
 */
function extractOutsideLinks(html) {
  var found = new Map();
  if (typeof html !== "string" || html === "") {
    return found;
  }
  var doc = parse(`<div>${html}</div>`);
  var anchors = doc.querySelectorAll("a[href]");
  for (var i = 0; i < anchors.length; i++) {
    var raw = anchors[i].getAttribute("href");
    if (typeof raw !== "string") {
      continue;
    }
    var href = raw.trim();
    if (found.has(href)) {
      continue;
    }
    var checkUrl = toCheckUrl(href);
    if (checkUrl !== "") {
      found.set(href, checkUrl);
    }
  }
  return found;
}

/**
 * Every outside link in the site's pages (published or not), cached for a
 * minute per site so a scan sending links in batches reads the pages once.
 * loadSiteHtml(site) returns the concatenated page HTML.
 */
async function getSiteOutsideLinks(site, loadSiteHtml, now) {
  var key =
    site && (site.siteDirectory || site.name)
      ? String(site.siteDirectory || site.name)
      : "";
  var cached = key !== "" ? siteLinksCache.get(key) : null;
  if (cached && now - cached.at < LINK_CHECK_SITE_LINKS_TTL_MS) {
    return cached.links;
  }
  var html = await loadSiteHtml(site);
  var links = extractOutsideLinks(html);
  if (key !== "") {
    if (siteLinksCache.size >= 200) {
      siteLinksCache.clear();
    }
    siteLinksCache.set(key, { at: now, links: links });
  }
  return links;
}

function errorReason(e) {
  var code = e && e.code ? String(e.code) : "";
  switch (code) {
    case "SSRF_PRIVATE":
      return { state: "skipped", reason: "private" };
    case "SSRF_INVALID_URL":
    case "SSRF_PROTOCOL":
    case "SSRF_HOSTNAME":
      return { state: "broken", reason: "invalid" };
    case "SSRF_DNS":
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { state: "broken", reason: "dns" };
    case "SSRF_TIMEOUT":
    case "ETIMEDOUT":
      return { state: "check", reason: "timeout" };
    case "SSRF_REDIRECTS":
    case "SSRF_REDIRECT":
      return { state: "broken", reason: "redirects" };
    default:
      break;
  }
  if (
    code.indexOf("ERR_TLS") === 0 ||
    code.indexOf("CERT_") === 0 ||
    code.indexOf("ERR_SSL") === 0 ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
  ) {
    return { state: "broken", reason: "tls" };
  }
  return { state: "broken", reason: "connection" };
}

/**
 * State for a final HTTP status: ok, redirected, check (answered but will
 * not talk to a script) or broken.
 */
function classifyStatus(status, redirected) {
  if (status >= 200 && status < 400) {
    return { state: redirected ? "redirected" : "ok", reason: "" };
  }
  if (CHECK_BY_HAND_STATUSES.indexOf(status) !== -1) {
    return { state: "check", reason: "refused" };
  }
  return { state: "broken", reason: "http" };
}

/**
 * Network check of one URL. HEAD first; many servers refuse HEAD (405,
 * 501, or 403/400 from bot filters), so any status of 400 or more other
 * than a plain 404/410 is retried once as a GET. Both discard the body.
 */
async function checkUrl(url, fetchImpl) {
  var doFetch = fetchImpl || safeFetch;
  var options = {
    headers: {
      "user-agent": LINK_CHECK_USER_AGENT,
      accept: "*/*",
    },
    discardBody: true,
    timeoutMs: LINK_CHECK_TIMEOUT_MS,
    maxRedirects: LINK_CHECK_MAX_REDIRECTS,
  };
  try {
    var response = await doFetch(
      url,
      Object.assign({}, options, { method: "HEAD" }),
    );
    if (
      response.status >= 400 &&
      response.status !== 404 &&
      response.status !== 410
    ) {
      response = await doFetch(
        url,
        Object.assign({}, options, { method: "GET" }),
      );
    }
    var redirected =
      response.redirected === true &&
      typeof response.url === "string" &&
      response.url !== "" &&
      response.url !== url;
    var verdict = classifyStatus(response.status, redirected);
    return {
      state: verdict.state,
      reason: verdict.reason,
      status: response.status,
      finalUrl: redirected ? response.url : "",
    };
  } catch (e) {
    var failed = errorReason(e);
    return {
      state: failed.state,
      reason: failed.reason,
      status: null,
      finalUrl: "",
    };
  }
}

function readCachedResult(url, now) {
  var entry = resultCache.get(url);
  if (!entry) {
    return null;
  }
  if (now - entry.at > LINK_CHECK_RESULT_TTL_MS) {
    resultCache.delete(url);
    return null;
  }
  return entry;
}

function storeResult(url, result, now) {
  if (resultCache.size >= LINK_CHECK_RESULT_CACHE_MAX) {
    // Map keeps insertion order: drop the oldest tenth
    var drop = Math.ceil(LINK_CHECK_RESULT_CACHE_MAX / 10);
    var keys = resultCache.keys();
    for (var i = 0; i < drop; i++) {
      var next = keys.next();
      if (next.done) {
        break;
      }
      resultCache.delete(next.value);
    }
  }
  resultCache.set(url, Object.assign({ at: now }, result));
}

/**
 * Fixed-window budget of network checks per user and site. Returns
 * { allowed, remaining, retryAfterSeconds } for a request that needs `n`
 * network checks; an allowed request spends them.
 */
function reserveChecks(key, n, now, settings) {
  return changeBudget(key, n, now, settings);
}

// Give back checks that were reserved but never made (deferred links).
function refundChecks(key, n, now, settings) {
  if (!settings || settings.enabled === false || n <= 0) {
    return;
  }
  var entry = budgetTracker.get(key);
  if (entry && now - entry.windowStart < settings.windowMs) {
    entry.used = Math.max(0, entry.used - n);
  }
}

function changeBudget(key, n, now, settings) {
  if (!settings || settings.enabled === false || n <= 0) {
    return {
      allowed: true,
      remaining: settings ? settings.max : 0,
      retryAfterSeconds: 0,
    };
  }
  var entry = budgetTracker.get(key);
  if (!entry || now - entry.windowStart >= settings.windowMs) {
    if (!entry && budgetTracker.size >= MAX_TRACKED_BUDGETS) {
      budgetTracker.delete(budgetTracker.keys().next().value);
    }
    entry = { windowStart: now, used: 0 };
    budgetTracker.set(key, entry);
  }
  var remaining = settings.max - entry.used;
  if (n > remaining) {
    return {
      allowed: false,
      remaining: remaining > 0 ? remaining : 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((entry.windowStart + settings.windowMs - now) / 1000),
      ),
    };
  }
  entry.used += n;
  return {
    allowed: true,
    remaining: settings.max - entry.used,
    retryAfterSeconds: 0,
  };
}

async function runPool(items, limit, worker) {
  var index = 0;
  async function next() {
    while (index < items.length) {
      var current = index;
      index += 1;
      await worker(items[current]);
    }
  }
  var runners = [];
  for (var i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(next());
  }
  await Promise.all(runners);
}

/**
 * Check the requested hrefs against the site's own outside links.
 *
 * @param {Object} o
 * @param {Object} o.site resolved site
 * @param {Array} o.links hrefs as the client found them in page HTML
 * @param {Function} o.loadSiteHtml async (site) => page HTML for every page
 * @param {String} o.rateKey user::site budget key
 * @param {Object} o.rateSettings { enabled, windowMs, max }
 * @param {Function} [o.fetchImpl] test seam, defaults to safeFetch
 * @param {Number} [o.now]
 * @param {Number} [o.budgetMs] per-request time budget (test seam)
 * @returns {Promise<Object>} { rateLimited, retryAfterSeconds, results,
 *   checked, cached, deferred, remaining }
 */
async function checkSiteLinks(o) {
  var now = typeof o.now === "number" ? o.now : Date.now();
  var requested = [];
  var seen = new Set();
  var list = Array.isArray(o.links) ? o.links : [];
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string") {
      continue;
    }
    var href = list[i].trim();
    if (
      href === "" ||
      href.length > LINK_CHECK_MAX_HREF_LENGTH ||
      seen.has(href)
    ) {
      continue;
    }
    seen.add(href);
    requested.push(href);
  }
  var siteLinks = await getSiteOutsideLinks(o.site, o.loadSiteHtml, now);
  // Security: the fetch target always comes from the site's own content
  // (siteLinks), looked up by the requested href; a requested href that is
  // not in the site is answered "skipped" and never fetched.
  var results = [];
  var toFetch = [];
  var byUrl = new Map();
  for (var r = 0; r < requested.length; r++) {
    var requestedHref = requested[r];
    var row = {
      href: requestedHref,
      state: "skipped",
      reason: "not-in-site",
      status: null,
      finalUrl: "",
      cached: false,
      checkedAt: null,
    };
    results.push(row);
    if (!siteLinks.has(requestedHref)) {
      continue;
    }
    var siteUrl = siteLinks.get(requestedHref);
    var hit = readCachedResult(siteUrl, now);
    if (hit) {
      row.state = hit.state;
      row.reason = hit.reason;
      row.status = hit.status;
      row.finalUrl = hit.finalUrl;
      row.cached = true;
      row.checkedAt = new Date(hit.at).toISOString();
      continue;
    }
    if (!byUrl.has(siteUrl)) {
      byUrl.set(siteUrl, []);
      toFetch.push(siteUrl);
    }
    byUrl.get(siteUrl).push(row);
  }
  var budget = reserveChecks(
    o.rateKey || "",
    toFetch.length,
    now,
    o.rateSettings,
  );
  if (!budget.allowed) {
    return {
      rateLimited: true,
      retryAfterSeconds: budget.retryAfterSeconds,
      remaining: budget.remaining,
      results: [],
      checked: 0,
      cached: 0,
      deferred: 0,
    };
  }
  var budgetMs =
    typeof o.budgetMs === "number" ? o.budgetMs : LINK_CHECK_REQUEST_BUDGET_MS;
  var deadline = Date.now() + budgetMs;
  var deferred = 0;
  await runPool(toFetch, LINK_CHECK_CONCURRENCY, async (url) => {
    var rows = byUrl.get(url) || [];
    if (Date.now() >= deadline) {
      deferred += 1;
      for (var d = 0; d < rows.length; d++) {
        rows[d].reason = "deferred";
      }
      return;
    }
    var outcome = await checkUrl(url, o.fetchImpl);
    var at = Date.now();
    storeResult(url, outcome, at);
    for (var k = 0; k < rows.length; k++) {
      rows[k].state = outcome.state;
      rows[k].reason = outcome.reason;
      rows[k].status = outcome.status;
      rows[k].finalUrl = outcome.finalUrl;
      rows[k].checkedAt = new Date(at).toISOString();
    }
  });
  refundChecks(o.rateKey || "", deferred, now, o.rateSettings);
  var cachedCount = 0;
  for (var c = 0; c < results.length; c++) {
    if (results[c].cached) {
      cachedCount += 1;
    }
  }
  return {
    rateLimited: false,
    retryAfterSeconds: 0,
    remaining: budget.remaining + deferred,
    results: results,
    checked: toFetch.length - deferred,
    cached: cachedCount,
    deferred: deferred,
  };
}

// Test-only: forget cached answers, site link lists and budgets.
function resetForTesting() {
  resultCache.clear();
  siteLinksCache.clear();
  budgetTracker.clear();
}

module.exports = {
  LINK_CHECK_MAX_LINKS,
  LINK_CHECK_CONCURRENCY,
  LINK_CHECK_TIMEOUT_MS,
  LINK_CHECK_RESULT_TTL_MS,
  LINK_CHECK_REQUEST_BUDGET_MS,
  LINK_CHECK_USER_AGENT,
  toCheckUrl,
  extractOutsideLinks,
  classifyStatus,
  errorReason,
  checkUrl,
  reserveChecks,
  changeBudget,
  checkSiteLinks,
  resetForTesting,
};
