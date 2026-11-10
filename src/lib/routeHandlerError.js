// Errors thrown inside an API route handler (haxtheweb/issues#3287).
//
// Invariant: an error thrown (or a promise rejected) inside a system or site
// API route handler ends the request with the OpenAPI ApiError envelope
// ({ status: 500, data: { message: "Server error" } }). It never leaves the
// request hanging or escapes as an unhandled rejection, which would stop the
// server under Node's default --unhandled-rejections=throw. The error is
// logged, never sent: it can carry server paths. A response the handler
// already started is ended as it is.
//
// haxcms-php answers the same envelope (SiteRouteUtils::invokeRouteHandler).
//
// CommonJS, no optional chaining.

const ROUTE_HANDLER_ERROR_MESSAGE = "Server error";
const LOG_LABEL_MAX = 120;
const LOG_MESSAGE_MAX = 300;

function truncate(value, max) {
  const text = String(
    value === undefined || value === null ? "" : value,
  ).replace(/[\x00-\x1f\x7f]+/g, " ");
  return text.length <= max ? text : text.substring(0, max) + "…";
}

// log the error without a raw request body it may carry (body-parser errors
// put the whole body on err.body)
function logRouteHandlerError(label, err) {
  const prefix = "HAXcms: error in API route " + truncate(label, LOG_LABEL_MAX);
  if (
    err &&
    typeof err === "object" &&
    Object.prototype.hasOwnProperty.call(err, "body")
  ) {
    const safe = {};
    [
      "name",
      "message",
      "type",
      "status",
      "statusCode",
      "code",
      "stack",
    ].forEach((key) => {
      if (err[key] !== undefined) {
        safe[key] =
          key === "message" ? truncate(err[key], LOG_MESSAGE_MAX) : err[key];
      }
    });
    console.error(prefix, safe);
  } else {
    console.error(prefix, err);
  }
}

function sendRouteHandlerError(req, res, err, label) {
  logRouteHandlerError(label || (req && req.path) || "", err);
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  res
    .status(500)
    .json({ status: 500, data: { message: ROUTE_HANDLER_ERROR_MESSAGE } });
}

/**
 * Wraps an async Express handler so a thrown error or rejected promise
 * answers the ApiError envelope (Express 4 does not catch rejections of
 * async handlers).
 */
function guardApiRouteHandler(label, handler) {
  return async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (error) {
      sendRouteHandlerError(req, res, error, label);
    }
  };
}

module.exports = {
  ROUTE_HANDLER_ERROR_MESSAGE,
  sendRouteHandlerError,
  guardApiRouteHandler,
};
