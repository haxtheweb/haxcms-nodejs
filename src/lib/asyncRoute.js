// Express 4 does not catch a rejected promise from an async route handler.
// The rejection becomes an unhandled rejection, and Node (15+) exits the
// process on those, so one throwing request takes the whole server down.
// wrapAsyncRoute hands the rejection to next(err) instead, where the final
// error handler (requestErrorHandler.js) answers it like any other error.

function wrapAsyncRoute(handler) {
  if (typeof handler !== "function") {
    throw new TypeError("wrapAsyncRoute expects a route handler function");
  }
  return function wrappedAsyncRoute(req, res, next) {
    let result;
    try {
      result = handler(req, res, next);
    } catch (err) {
      return next(err);
    }
    if (result && typeof result.then === "function") {
      return result.then(undefined, function (err) {
        // a response already on the wire cannot carry an error envelope
        if (res && res.headersSent) {
          return undefined;
        }
        return next(err);
      });
    }
    return result;
  };
}

// Express routes a HEAD request to the matching GET route, so a handler that
// keys a registry by req.method sees "head" for a route only registered as
// "get". Map it back so HEAD and GET resolve to the same registered handler.
function registryMethod(method) {
  const lower = String(method || "").toLowerCase();
  return lower === "head" ? "get" : lower;
}

module.exports = { wrapAsyncRoute, registryMethod };
