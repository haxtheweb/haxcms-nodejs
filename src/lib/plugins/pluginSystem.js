// DRAFT (plugin platform, contingent on https://github.com/haxtheweb/haxcms-plugin-examples/pull/1).
//
// Finds plugins, keeps one engine (HaxcmsPluginHost) per site, and gives core code three things:
//   before(site, type, record, previous) / after(...)  fire the entity hooks (and their page.* / manifest.* aliases)
//                                                       around core's own saves and deletes
//   rebuild(site, reason)                              rebuild.before / rebuild.after after core rewrote managed files
//   host(site, user)                                   the engine, for routes (operations) and anything else
// Core never names a plugin here: everything comes from the plugin folders and the deployment's plugin config.
//
// Where plugins come from (spec/03 tiers, simplified for the draft):
//   - core plugins shipped with HAXcms: the spec package's core-plugins/ folder; required ones are always on,
//     the rest only when listed in `enabled` (spec decision: no defaultEnabled flag)
//   - system tier: <HAXCMS_ROOT>/_config/plugins/<id>/
//   - site tier:   <site>/_config/plugins/<id>/
//   - extra folders: HAXCMS_PLUGIN_DIRS (path-list), for development and tests
// Deployment config: <HAXCMS_ROOT>/_config/plugins/plugins.json { "enabled": [ids], "disabled": [ids], "blocked": [ids] }
// (HAXiam blocks mcp this way). The spec plans plugins.yaml with lock data; JSON keeps the draft dependency-free.
const path = require("path");
const fs = require("fs");

const state = { hosts: new Map(), engine: null, version: null };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function listPluginDirs(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .map((n) => path.join(dir, n))
    .filter((d) => fs.existsSync(path.join(d, "plugin.yaml")));
}

function specRoot() {
  try {
    return path.dirname(require.resolve("@haxtheweb/haxcms-plugin-spec/package.json"));
  } catch {
    return null;
  }
}

function deploymentConfig(root) {
  const c = readJson(path.join(root, "_config", "plugins", "plugins.json"), {});
  return {
    enabled: Array.isArray(c.enabled) ? c.enabled : [],
    disabled: Array.isArray(c.disabled) ? c.disabled : [],
    blocked: Array.isArray(c.blocked) ? c.blocked : [],
  };
}

/**
 * The plugin folders for a site, highest tier last (site copies override system copies, which override core).
 * Core plugins that are not required load only when the deployment enabled them.
 */
function pluginDirsFor(site, root) {
  const cfg = deploymentConfig(root);
  const out = [];
  const spec = specRoot();
  if (spec) {
    for (const d of listPluginDirs(path.join(spec, "core-plugins"))) {
      let manifest = "";
      try {
        manifest = fs.readFileSync(path.join(d, "plugin.yaml"), "utf8");
      } catch {
        continue;
      }
      const id = (/^id:\s*(\S+)/m.exec(manifest) || [])[1];
      const required = /^required:\s*true/m.test(manifest);
      if (required || cfg.enabled.includes(id)) {
        out.push({ path: d, tier: "system-core" });
      }
    }
  }
  for (const d of listPluginDirs(path.join(root, "_config", "plugins"))) {
    out.push({ path: d, tier: "system" });
  }
  for (const d of String(process.env.HAXCMS_PLUGIN_DIRS || "").split(path.delimiter).filter(Boolean)) {
    if (fs.existsSync(path.join(d, "plugin.yaml"))) {
      out.push({ path: d, tier: "system" });
    } else {
      for (const x of listPluginDirs(d)) {
        out.push({ path: x, tier: "system" });
      }
    }
  }
  if (site && site.siteDirectory) {
    for (const d of listPluginDirs(path.join(site.siteDirectory, "_config", "plugins"))) {
      out.push({ path: d, tier: "site" });
    }
  }
  return { dirs: out, cfg };
}

async function engine() {
  if (!state.engine) {
    state.engine = await import("./HaxcmsPluginHost.mjs");
  }
  return state.engine;
}

function haxcmsVersion() {
  if (!state.version) {
    state.version = readJson(path.join(__dirname, "..", "..", "..", "package.json"), {}).version || "0.0.0";
  }
  return state.version;
}

/**
 * The plugin engine for a site (cached per site folder). `user` is the caller for this request (null for a visitor).
 */
async function host(site, { root, user = null } = {}) {
  if (!site || !site.manifest) {
    return null;
  }
  const key = site.siteDirectory;
  let h = state.hosts.get(key);
  if (!h) {
    const { HaxcmsPluginHost } = await engine();
    const haxRoot = root || process.env.HAXCMS_ROOT || process.cwd();
    h = new HaxcmsPluginHost({ site, root: haxRoot, version: haxcmsVersion(), user, liveNetwork: true });
    const { dirs, cfg } = pluginDirsFor(site, haxRoot);
    await h.load(dirs, { disabled: cfg.disabled, blocked: cfg.blocked });
    state.hosts.set(key, h);
  }
  // core reloads the site per request; keep the engine's view of site.json and pages current
  h.haxSite = site;
  h.hydrate();
  h.user = user;
  return h;
}

/** Forget cached engines (after plugins are installed, enabled or disabled). */
function reset() {
  state.hosts.clear();
}

/**
 * Fire the before hooks for a save core is about to make. Returns { record, veto, warnings }: when `veto` is set,
 * core must not write; otherwise it writes `record` (plugins may have changed it).
 */
async function before(site, type, record, previous, opts = {}) {
  const h = await host(site, opts);
  if (!h) {
    return { record, veto: null, warnings: [] };
  }
  const op = opts.delete ? "delete" : previous ? "update" : "create";
  const r = await h.fire(`entity.before.${op}`, record, { entity: type, previous });
  // fields under metadata.plugins.<id> must be declared by that plugin (spec/04); others are dropped with a warning
  const warnings = [...(r.warnings || []), ...(!r.veto && !opts.delete ? h.checkPluginMetadata(type, r.subject) : [])];
  return { record: opts.delete ? record : r.subject, veto: r.veto || null, warnings };
}

/** Fire the after hooks once core has written (or deleted) the record. */
async function after(site, type, record, previous, opts = {}) {
  const h = await host(site, opts);
  if (!h) {
    return { warnings: [] };
  }
  const op = opts.delete ? "delete" : previous ? "update" : "create";
  const r = await h.fire(`entity.after.${op}`, record, { entity: type, previous });
  return { warnings: r.warnings || [] };
}

/** rebuild.before / rebuild.after around core's managed-file rewrite (updateAlternateFormats). */
async function rebuild(site, reason = "save", opts = {}) {
  const h = await host(site, opts);
  return h ? h.rebuild(reason) : null;
}

module.exports = { host, reset, before, after, rebuild, pluginDirsFor, deploymentConfig };
