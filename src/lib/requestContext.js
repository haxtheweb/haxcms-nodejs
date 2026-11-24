// The request being handled, for code that runs deep inside it without the
// req object (HAXCMS.getDomain, used when managed files and feeds are
// written). Per request through AsyncLocalStorage, so concurrent requests
// never see each other's host. Outside a request (CLI, startup) there is
// none, as in haxcms-php's CLI.
const { AsyncLocalStorage } = require("node:async_hooks");

const requestStorage = new AsyncLocalStorage();

function requestContextMiddleware(req, res, next) {
  requestStorage.run({ req }, next);
}

function currentRequest() {
  const store = requestStorage.getStore();
  return store && store.req ? store.req : null;
}

// run fn as if handling req (tests, internal sub-requests)
function runWithRequest(req, fn) {
  return requestStorage.run({ req }, fn);
}

module.exports = { requestContextMiddleware, currentRequest, runWithRequest };
