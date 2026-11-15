const { HAXCMS } = require("../../lib/HAXCMS.js");
const { siteHTMLContent } = require("../../lib/JOSHelpers.js");
const linkChecker = require("../../lib/linkChecker.js");
const {
  getApiBasePath,
  resolveSiteForRequest,
  sendFormattedResponse,
} = require("./siteRouteUtils.js");

/**
 * POST x/api/v1/site/check-links
 * Body: { links: [href, ...] } (at most linkChecker.LINK_CHECK_MAX_LINKS)
 *
 * Answers whether each outside link still resolves. Only links that appear
 * in this site's own pages are checked; see lib/linkChecker.js for the
 * limits. Mirrors haxcms-php lib/siteRoutes/v1/siteCheckLinks.php.
 */
async function checkSiteLinks(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      data: {
        message:
          "Unable to resolve site context for /x/api/v1/site/check-links",
      },
    });
  }
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const links = Array.isArray(body.links) ? body.links : null;
  if (!links || links.length === 0) {
    return res.status(400).json({
      status: 400,
      data: { message: "links is required" },
    });
  }
  if (links.length > linkChecker.LINK_CHECK_MAX_LINKS) {
    return res.status(400).json({
      status: 400,
      data: {
        message: `invalid links value (at most ${linkChecker.LINK_CHECK_MAX_LINKS} per request)`,
      },
    });
  }
  const auth = req.haxcmsSiteApiAuth || {};
  const rateSettings = HAXCMS.getLinkCheckRateLimitSettings();
  const outcome = await linkChecker.checkSiteLinks({
    site: site,
    links: links,
    loadSiteHtml: (s) => siteHTMLContent(s, null, null, true),
    rateKey: String(auth.userName || "") + "::" + String(auth.siteName || ""),
    rateSettings: rateSettings,
  });
  const windowMinutes = Math.max(1, Math.round(rateSettings.windowMs / 60000));
  if (outcome.rateLimited) {
    res.set("Retry-After", String(outcome.retryAfterSeconds));
    const minutes = Math.max(1, Math.ceil(outcome.retryAfterSeconds / 60));
    return res.status(429).json({
      status: 429,
      data: {
        message: `Link check limit reached: ${rateSettings.max} checks per ${windowMinutes} minute${windowMinutes !== 1 ? "s" : ""} for this site. You can retry in ${minutes} minute${minutes !== 1 ? "s" : ""}.`,
        retryAfterSeconds: outcome.retryAfterSeconds,
      },
    });
  }
  const apiBasePath = getApiBasePath(req);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outcome.results.length,
      checked: outcome.checked,
      cached: outcome.cached,
      deferred: outcome.deferred,
      results: outcome.results,
      limits: {
        maxLinks: linkChecker.LINK_CHECK_MAX_LINKS,
        windowSeconds: Math.round(rateSettings.windowMs / 1000),
        maxChecksPerWindow: rateSettings.max,
        remaining: outcome.remaining,
        cacheSeconds: Math.round(linkChecker.LINK_CHECK_RESULT_TTL_MS / 1000),
      },
      links: {
        self: `${apiBasePath}/v1/site/check-links`,
      },
    },
    {
      allowedFormats: ["json"],
      defaultFormat: "json",
    },
  );
}

module.exports = {
  checkSiteLinks,
};
