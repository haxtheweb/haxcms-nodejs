// Express routes a HEAD request to the matching GET route, so a handler that
// keys a registry by req.method sees "head" for a route only registered as
// "get". registryMethod maps it back so HEAD resolves to the same handler and
// the same access policy as GET (haxtheweb/issues#3236).
//
// CommonJS, no optional chaining.

function registryMethod(method) {
  const lower = String(method || "").toLowerCase();
  return lower === "head" ? "get" : lower;
}

module.exports = { registryMethod };
