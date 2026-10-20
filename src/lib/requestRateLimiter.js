// Per-IP request ceiling applied app-wide (see app.js). Uses express-rate-limit
// so the limiter is a well-known, audited implementation. Keyed on req.ip,
// which honors the app's configured `trust proxy` setting.
const { rateLimit } = require("express-rate-limit");

function createRequestRateLimiter(settings) {
  if (!settings || settings.enabled === false) {
    return (req, res, next) => next();
  }
  return rateLimit({
    windowMs: settings.windowMs,
    limit: settings.max,
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
