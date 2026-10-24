// DRAFT (plugin platform, contingent on https://github.com/haxtheweb/haxcms-plugin-examples/pull/1).
//
// Mounts plugin operations (spec/05): each plugin's config/openapi.yaml paths live under
//   site scope    /x/api/v1/plugins/<id>/...        (and /<sitesDirectory>/<site>/x/api/v1/plugins/<id>/...)
//   system scope  /system/api/v1/plugins/<id>/...
// and the plugin list at GET /system/api/v1/plugins. The engine enforces each operation's declared security from
// the credentials app.js resolved for the request; routes never decide auth themselves.
const pluginSystem = require("./pluginSystem.js");

/**
 * @param {object} app      the express app
 * @param {object} deps     functions app.js already has:
 *   resolveSite(req)        -> HAXCMSSite or null (multisite path, auth context, payload, referer)
 *   resolveAuth(req, site)  -> { userName, jwt: bool, userToken: bool, siteToken: bool }
 *   basePath                -> the HAXcms base path ("/")
 *   sitesDirectory          -> "sites"
 */
function mountPluginRoutes(app, deps) {
  const credentialsOf = (auth) => (auth.jwt && (auth.userToken || auth.siteToken) ? "both" : auth.jwt ? "jwt" : "none");
  const userOf = (auth) => (auth.userName ? { id: auth.userName, name: auth.userName, displayName: auth.userName, roles: ["admin"], avatar: null } : null);

  const handle = (scope) => async (req, res) => {
    try {
      const site = await deps.resolveSite(req);
      if (!site) {
        return res.status(404).json({ status: 404, data: { message: "Unable to resolve site context for plugin route" } });
      }
      const auth = deps.resolveAuth(req, site);
      const h = await pluginSystem.host(site, { user: userOf(auth) });
      const id = req.params.plugin;
      // the last wildcard is the operation path (the first, on /<sites>/*/x/api/..., is the site path)
      const rest = "/" + String((req.params[1] !== undefined ? req.params[1] : req.params[0]) || "").replace(/^\/+/, "");
      const p = h.get(id);
      if (!p || p.status !== "active") {
        return res.status(404).json({ status: 404, data: { message: "not found" } });
      }
      // find the operation whose path template matches (scope must match too)
      let match = null;
      for (const [operationId, op] of Object.entries(p.ops)) {
        if (op.verb !== req.method.toLowerCase() || op.scope !== scope) {
          continue;
        }
        const names = [];
        const re = new RegExp("^" + op.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([^}]+)\\?\}/g, (m, n) => { names.push(n); return "([^/]+)"; }) + "$");
        const mm = re.exec(rest);
        if (mm) {
          match = { operationId, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(mm[i + 1])])) };
          break;
        }
      }
      if (!match) {
        return res.status(404).json({ status: 404, data: { message: "not found" } });
      }
      const r = await h.call(match.operationId, { params: match.params, query: req.query || {}, body: req.body || {}, headers: req.headers || {} }, { credentials: credentialsOf(auth) });
      for (const [k, v] of Object.entries(r.headers || {})) {
        res.set(k, v);
      }
      return res.status(r.status || 200).json(r.body === undefined ? null : r.body);
    } catch (e) {
      return res.status(500).json({ status: 500, data: { message: "server error" } });
    }
  };

  const base = deps.basePath || "/";
  app.all(`${base}x/api/v1/plugins/:plugin/*`, handle("site"));
  app.all(`${base}${deps.sitesDirectory}/*/x/api/v1/plugins/:plugin/*`, handle("site"));
  app.all(`${base}system/api/v1/plugins/:plugin/*`, handle("system"));
  app.get(`${base}system/api/v1/plugins`, async (req, res) => {
    const site = await deps.resolveSite(req);
    const auth = deps.resolveAuth(req, site);
    if (!auth.jwt) {
      return res.status(401).json({ status: 401, data: { message: "access denied" } });
    }
    const h = site ? await pluginSystem.host(site, { user: userOf(auth) }) : null;
    return res.json({ status: 200, data: h ? h.status() : [] });
  });
}

module.exports = { mountPluginRoutes };
