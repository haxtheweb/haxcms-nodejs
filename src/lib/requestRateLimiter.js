// Per-IP request ceiling applied app-wide (see app.js). Uses express-rate-limit
// so the limiter is a well-known, audited implementation. Keyed on req.ip,
// which honors the app's configured `trust proxy` setting.
const { rateLimit } = require("express-rate-limit");

// The same limiter instance is mounted app-wide AND directly on individual
// routes (CodeQL's js/missing-rate-limiting only recognises a limiter that is
// in the route's own handler chain). `skip` marks the request on first sight so
// a request passing through several mounts is only counted once.
const COUNTED = Symbol("haxcmsRequestRateLimited");

function createRequestRateLimiter(settings) {
  if (!settings || settings.enabled === false) {
    return (req, res, next) => next();
  }
  return rateLimit({
    windowMs: settings.windowMs,
    limit: settings.max,
    skip: (req) => {
      if (req[COUNTED]) {
        return true;
      }
      req[COUNTED] = true;
      return false;
    },
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // trust proxy is config-driven; validation warnings about it are noise here
    validate: { trustProxy: false, xForwardedForHeader: false },
    // Plain-text 429 (no JSON message literal) so this does not need a new
    // entry in the shared haxcms-elements message-code catalog.
    handler: (req, res) => {
      res
        .status(429)
        .type("text/plain")
        .send("Too many requests, please slow down and try again shortly.");
    },
  });
}

module.exports = { createRequestRateLimiter };
