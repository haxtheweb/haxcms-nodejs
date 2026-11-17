// DRAFT (plugin platform, contingent on https://github.com/haxtheweb/haxcms-plugins/pull/15).
//
// Mounts plugin operations (spec/05): each plugin's config/openapi.yaml paths live under
//   site scope    /x/api/v1/plugins/<id>/...        (and /<sitesDirectory>/<site>/x/api/v1/plugins/<id>/...)
//   system scope  /system/api/v1/plugins/<id>/...
// The engine enforces each operation's declared security from the credentials app.js resolved for the request.
// Core's own routes here are the plugin registry and enablement (spec/03, The plugin registry):
//   GET  /system/api/v1/plugins                  the registry for the system        (JWT + user token)
//   POST /system/api/v1/plugins/<id>/enable      enable for the whole system        (JWT + user token)
//   POST /system/api/v1/plugins/<id>/disable
//   GET  /x/api/v1/plugins                       the registry as one site sees it   (JWT + site token)
//   POST /x/api/v1/plugins/<id>/enable           enable for that site               (JWT + site token)
//   POST /x/api/v1/plugins/<id>/disable
//   GET, POST .../plugins/<id>/settings          a plugin's settings form and values; secrets are write-only
//   GET  .../plugins/<id>/assets/<path>          one of its front-end files (frontend/dist), no credentials
//   GET  .../plugins/openapi.json|yaml           what the plugins that are on add to the API, for that scope
//   GET  .../plugins/<id>/openapi.json|yaml      the same for one plugin
// assets, openapi.json, openapi.yaml, enable, disable and settings are reserved sub-paths: a plugin operation cannot
// take them. PLATFORM_ROUTES below is the list, and src/openapi documents each entry.
const pluginSystem = require("./pluginSystem.js");
const fs = require("fs");
const path = require("path");

// yaml comes with the spec package; plugin registries and openapi files are YAML or JSON
function loadYaml() {
  const spec = path.dirname(
    require.resolve("@haxtheweb/haxcms-plugin-spec/package.json"),
  );
  return require(require.resolve("yaml", { paths: [spec] }));
}
function readYaml(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return file.endsWith(".json") ? JSON.parse(text) : loadYaml().parse(text);
  } catch {
    return null;
  }
}
function readRegistry(dir, name) {
  const d = path.join(dir, "registries", name);
  if (!fs.existsSync(d)) {
    return [];
  }
  return fs
    .readdirSync(d)
    .filter((f) => /\.(ya?ml|json)$/.test(f))
    .sort()
    .map((f) => readYaml(path.join(d, f)))
    .filter(Boolean);
}

/**
 * The routes core answers itself under .../plugins, the same at system scope (/system/api/v1/plugins) and site scope
 * (/x/api/v1/plugins). Both OpenAPI specs document exactly these; "credentials" false means no sign-in is asked for.
 */
const PLATFORM_ROUTES = [
  { method: "get", path: "", handler: "registry", credentials: true },
  {
    method: "get",
    path: "/contributions",
    handler: "contributions",
    credentials: true,
  },
  {
    method: "get",
    path: "/openapi.json",
    handler: "contract",
    credentials: true,
  },
  {
    method: "get",
    path: "/openapi.yaml",
    handler: "contract",
    credentials: true,
  },
  {
    method: "post",
    path: "/{plugin}/enable",
    handler: "enable",
    credentials: true,
  },
  {
    method: "post",
    path: "/{plugin}/disable",
    handler: "disable",
    credentials: true,
  },
  {
    method: "get",
    path: "/{plugin}/settings",
    handler: "settings",
    credentials: true,
  },
  {
    method: "post",
    path: "/{plugin}/settings",
    handler: "saveSettings",
    credentials: true,
  },
  {
    method: "get",
    path: "/{plugin}/openapi.json",
    handler: "pluginContract",
    credentials: true,
  },
  {
    method: "get",
    path: "/{plugin}/openapi.yaml",
    handler: "pluginContract",
    credentials: true,
  },
  {
    method: "get",
    path: "/{plugin}/assets/{assetPath}",
    handler: "asset",
    credentials: false,
  },
];

/**
 * @param {object} app      the express app
 * @param {object} deps     functions app.js already has:
 *   resolveSite(req)        -> HAXCMSSite or null (multisite path, auth context, payload, referer)
 *   resolveAuth(req, site)  -> { userName, jwt: bool, userToken: bool, siteToken: bool }
 *   basePath                -> the HAXcms base path ("/")
 *   sitesDirectory          -> "sites"
 */
function mountPluginRoutes(app, deps) {
  const credentialsOf = (auth) =>
    auth.jwt && (auth.userToken || auth.siteToken)
      ? "both"
      : auth.jwt
        ? "jwt"
        : "none";
  const userOf = (auth) =>
    auth.userName
      ? {
          id: auth.userName,
          name: auth.userName,
          displayName: auth.userName,
          roles: ["admin"],
          avatar: null,
        }
      : null;

  const handle = (scope) => async (req, res) => {
    try {
      // system-scope operations run on the system engine, never on some site's (spec/13 section 8b)
      const site =
        scope === "system"
          ? null
          : await deps.resolveSite(req).catch(() => null);
      if (scope !== "system" && !site) {
        return res.status(404).json({
          status: 404,
          data: {
            message: "Unable to resolve site context for plugin route",
          },
        });
      }
      const auth = deps.resolveAuth(req, site);
      const h =
        scope === "system"
          ? await pluginSystem.systemHost({ user: userOf(auth) })
          : await pluginSystem.host(site, { user: userOf(auth) });
      const id = req.params.plugin;
      // the last wildcard is the operation path (the first, on /<sites>/*/x/api/..., is the site path)
      const rest =
        "/" +
        String(
          (req.params[1] !== undefined ? req.params[1] : req.params[0]) || "",
        ).replace(/^\/+/, "");
      const p = h.get(id);
      if (!p || p.status !== "active") {
        return res
          .status(404)
          .json({ status: 404, data: { message: "not found" } });
      }
      // find the operation whose path template matches (scope must match too)
      let match = null;
      for (const [operationId, op] of Object.entries(p.ops)) {
        if (op.verb !== req.method.toLowerCase() || op.scope !== scope) {
          continue;
        }
        const names = [];
        const re = new RegExp(
          "^" +
            op.path
              .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
              .replace(/\\?\{([^}]+)\\?\}/g, (m, n) => {
                names.push(n);
                return "([^/]+)";
              }) +
            "$",
        );
        const mm = re.exec(rest);
        if (mm) {
          match = {
            operationId,
            params: Object.fromEntries(
              names.map((n, i) => [n, decodeURIComponent(mm[i + 1])]),
            ),
          };
          break;
        }
      }
      if (!match) {
        return res
          .status(404)
          .json({ status: 404, data: { message: "not found" } });
      }
      const r = await h.call(
        match.operationId,
        {
          params: match.params,
          query: req.query || {},
          body: req.body || {},
          headers: req.headers || {},
        },
        // an anonymous call is counted against the caller's address (spec/05)
        { credentials: credentialsOf(auth), client: req.ip || null },
      );
      // what the operation logged goes to the log sinks
      await pluginSystem.settle(h);
      for (const [k, v] of Object.entries(r.headers || {})) {
        res.set(k, v);
      }
      return res
        .status(r.status || 200)
        .json(r.body === undefined ? null : r.body);
    } catch {
      return res
        .status(500)
        .json({ status: 500, data: { message: "server error" } });
    }
  };

  const base = deps.basePath || "/";

  // GET .../plugins/contributions (spec/07): declarative UI from enabled plugins for one surface, plus the advertised
  // core contracts by contract and result name, so core screens enable features without naming a plugin.
  const contributions = (surface) => async (req, res) => {
    const site = surface === "site" ? await deps.resolveSite(req) : null;
    const auth = deps.resolveAuth(req, site);
    // both credentials for the dashboard, site credentials for a site's admin screens (spec/13 section 8)
    const allowed =
      surface === "site"
        ? !!site && auth.jwt && auth.siteToken
        : auth.jwt && auth.userToken;
    if (!allowed) {
      return res
        .status(401)
        .json({ status: 401, data: { message: "access denied" } });
    }
    const h =
      surface === "site"
        ? await pluginSystem.host(site, { user: userOf(auth) })
        : await pluginSystem.systemHost({ user: userOf(auth) });
    if (!h) {
      return res.json({
        status: 200,
        data: { contributions: [], contracts: {} },
      });
    }
    const items = [];
    for (const p of h.plugins.filter((x) => x.status === "active")) {
      for (const c of readRegistry(p.dir, "dashboard")) {
        if ((c.surface || "dashboard") === surface) {
          items.push({ plugin: p.id, ...c });
        }
      }
    }
    items.sort((a, b) => (a.order || 0) - (b.order || 0));
    return res.json({
      status: 200,
      data: { contributions: items, contracts: h.advertisedContracts() },
    });
  };
  // GET /.well-known/<name> (spec/05): a public, system-scope GET a plugin marks with x-hax-well-known, served at the
  // standard location too. Only reserved names; the first active plugin that declares one serves it.
  const WELL_KNOWN = new Set([
    "oauth-authorization-server",
    "oauth-protected-resource",
    "openid-configuration",
  ]);
  app.get(`${base}.well-known/:name`, async (req, res, next) => {
    if (!WELL_KNOWN.has(req.params.name)) {
      return next();
    }
    try {
      // well-known metadata is system-wide: the system engine answers it
      const h = await pluginSystem.systemHost({ user: null });
      if (!h) {
        return next();
      }
      for (const p of h.plugins.filter((x) => x.status === "active")) {
        const api = readYaml(
          require("path").join(p.dir, "config", "openapi.yaml"),
        );
        for (const verbs of Object.values((api && api.paths) || {})) {
          const op = verbs && verbs.get;
          if (op && op["x-hax-well-known"] === req.params.name) {
            const r = await h.call(
              op.operationId,
              {
                params: {},
                query: req.query || {},
                body: {},
                headers: req.headers || {},
              },
              { credentials: "none" },
            );
            return res
              .status(r.status || 200)
              .json(r.body === undefined ? null : r.body);
          }
        }
      }
      return next();
    } catch {
      return res
        .status(500)
        .json({ status: 500, data: { message: "server error" } });
    }
  });

  // ---- the plugin registry and enablement (spec/03) ----
  const refuse = (res, status, message) =>
    res.status(status).json({ status, data: { message } });
  const systemRegistry = async (req, res) => {
    const auth = deps.resolveAuth(req, null);
    if (!auth.jwt || !auth.userToken) {
      return refuse(res, 401, "access denied");
    }
    const data = await pluginSystem.registry(null, {
      user: userOf(auth),
      sitesDirectory: deps.sitesDirectory,
    });
    return res.json({ status: 200, data });
  };
  const siteRegistry = async (req, res) => {
    const site = await deps.resolveSite(req).catch(() => null);
    const auth = deps.resolveAuth(req, site);
    if (!site || !auth.jwt || !auth.siteToken) {
      return refuse(res, 401, "access denied");
    }
    const data = await pluginSystem.registry(site, { user: userOf(auth) });
    return res.json({ status: 200, data });
  };
  const toggle = (scope, action) => async (req, res) => {
    try {
      const site =
        scope === "site" ? await deps.resolveSite(req).catch(() => null) : null;
      const auth = deps.resolveAuth(req, site);
      const allowed =
        scope === "site"
          ? !!site && auth.jwt && auth.siteToken
          : auth.jwt && auth.userToken;
      if (!allowed) {
        return refuse(res, 401, "access denied");
      }
      const r = await pluginSystem[action](site, String(req.params.plugin), {
        user: userOf(auth),
        sitesDirectory: deps.sitesDirectory,
      });
      if (r.status !== 200) {
        const body = r.body || {};
        const data = { message: body.error || "refused" };
        for (const k of ["dependencies", "dependents", "status", "previous"]) {
          if (body[k] !== undefined) {
            data[k] = body[k];
          }
        }
        return res.status(r.status).json({ status: r.status, data });
      }
      return res.json({ status: 200, data: r.body });
    } catch {
      return refuse(res, 500, "server error");
    }
  };
  // ---- settings (spec/13 section 7): the form and values; secrets are never sent back ----
  const settingsRoute = (scope, write) => async (req, res) => {
    try {
      const site =
        scope === "site" ? await deps.resolveSite(req).catch(() => null) : null;
      const auth = deps.resolveAuth(req, site);
      const allowed =
        scope === "site"
          ? !!site && auth.jwt && auth.siteToken
          : auth.jwt && auth.userToken;
      if (!allowed) {
        return refuse(res, 401, "access denied");
      }
      const opts = { user: userOf(auth) };
      const r = write
        ? await pluginSystem.saveSettings(
            site,
            String(req.params.plugin),
            req.body && req.body.values !== undefined
              ? req.body.values
              : req.body,
            opts,
          )
        : await pluginSystem.settings(site, String(req.params.plugin), opts);
      if (r.status !== 200) {
        return res.status(r.status).json({
          status: r.status,
          data: { message: (r.body && r.body.error) || "refused" },
        });
      }
      return res.json({ status: 200, data: r.body });
    } catch {
      return refuse(res, 500, "server error");
    }
  };
  // ---- front-end files (spec/07, assets): frontend/dist of a plugin that is on, nothing else ----
  const assetRoute = (scope) => async (req, res) => {
    try {
      const site =
        scope === "site" ? await deps.resolveSite(req).catch(() => null) : null;
      const h =
        scope === "site"
          ? await pluginSystem.host(site, { user: null })
          : await pluginSystem.systemHost({ user: null });
      const rest = String(
        (req.params[1] !== undefined ? req.params[1] : req.params[0]) || "",
      );
      const found = h ? h.asset(String(req.params.plugin), rest) : null;
      if (!found || found.status !== 200) {
        return refuse(res, 404, "not found");
      }
      res.set("Content-Type", found.type);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "public, max-age=300");
      return res.status(200).send(fs.readFileSync(found.file));
    } catch {
      return refuse(res, 500, "server error");
    }
  };
  // ---- the contract (spec/13 section 5): what the plugins that are on add to the API, for one scope ----
  const contract = (scope, one) => async (req, res) => {
    try {
      const site =
        scope === "site" ? await deps.resolveSite(req).catch(() => null) : null;
      const auth = deps.resolveAuth(req, site);
      const allowed =
        scope === "site"
          ? !!site && auth.jwt && auth.siteToken
          : auth.jwt && auth.userToken;
      if (!allowed) {
        return refuse(res, 401, "access denied");
      }
      const h =
        scope === "site"
          ? await pluginSystem.host(site, { user: userOf(auth) })
          : await pluginSystem.systemHost({ user: userOf(auth) });
      const opts = one
        ? { scope, plugin: String(req.params.plugin) }
        : { scope };
      const doc = h
        ? h.unifiedContract(opts)
        : { openapi: "3.1.0", info: { title: "HAXcms plugins" }, paths: {} };
      // one plugin's document exists only while that plugin is on and has operations in this scope
      if (one && Object.keys(doc.paths || {}).length === 0) {
        return refuse(res, 404, "not found");
      }
      if (/\.yaml$/.test(req.path)) {
        res.set("Content-Type", "application/yaml; charset=utf-8");
        return res.status(200).send(loadYaml().stringify(doc));
      }
      return res.status(200).json(doc);
    } catch {
      return refuse(res, 500, "server error");
    }
  };
  const handlers = {
    registry: (scope) => (scope === "site" ? siteRegistry : systemRegistry),
    contributions: (scope) =>
      contributions(scope === "site" ? "site" : "dashboard"),
    contract: (scope) => contract(scope, false),
    pluginContract: (scope) => contract(scope, true),
    enable: (scope) => toggle(scope, "enable"),
    disable: (scope) => toggle(scope, "disable"),
    settings: (scope) => settingsRoute(scope, false),
    saveSettings: (scope) => settingsRoute(scope, true),
    asset: (scope) => assetRoute(scope),
  };
  for (const [prefix, scope] of [
    [`${base}system/api/v1/plugins`, "system"],
    [`${base}x/api/v1/plugins`, "site"],
    [`${base}${deps.sitesDirectory}/*/x/api/v1/plugins`, "site"],
  ]) {
    for (const route of PLATFORM_ROUTES) {
      app[route.method](
        prefix +
          route.path.replace("{plugin}", ":plugin").replace("{assetPath}", "*"),
        handlers[route.handler](scope),
      );
    }
  }

  // everything else under .../plugins/<id>/ is that plugin's own operations
  app.all(`${base}x/api/v1/plugins/:plugin/*`, handle("site"));
  app.all(
    `${base}${deps.sitesDirectory}/*/x/api/v1/plugins/:plugin/*`,
    handle("site"),
  );
  app.all(`${base}system/api/v1/plugins/:plugin/*`, handle("system"));
}

module.exports = { mountPluginRoutes, PLATFORM_ROUTES };
