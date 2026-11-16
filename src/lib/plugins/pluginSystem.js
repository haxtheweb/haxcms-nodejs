// DRAFT (plugin platform, contingent on https://github.com/haxtheweb/haxcms-plugins/pull/15).
//
// Finds plugins, keeps one engine (HaxcmsPluginHost) per site, keeps the plugin registry, and gives core code:
//   before(site, type, record, previous) / after(...)  fire the entity hooks (and their page.* / manifest.* aliases)
//                                                       around core's own saves and deletes
//   rebuild(site, reason)                              rebuild.before / rebuild.after after core rewrote managed files
//   host(site, { user })                               the engine as one request sees it, for routes and anything else
//   systemHost({ user })                               the system engine (no site), for system routes
//   registry(site, opts) / enable(...) / disable(...)  what is installed and what is on (spec/03, The plugin registry)
// Core never names a plugin here: everything comes from the plugin folders and the registry files.
//
// Where plugins come from (spec/03 tiers, spec/13 section 1):
//   - core plugins shipped with HAXcms: the spec package's core-plugins/ folder (none in its base today)
//   - system contrib: <HAXCMS_ROOT>/_plugins/<id>/
//   - site:           <site>/_plugins/<id>/
//   - development and tests: HAXCMS_PLUGIN_DIRS (path list); these are on without being listed
// What is on: <HAXCMS_ROOT>/_config/plugins/plugins.yaml for the system and <site>/_config/plugins/plugins.yaml for
// one site, each { version: 1, enabled: [ids], plugins: {...} }; the system file also carries locked and blocked.
// A plugin that is installed and not enabled is "available": the engine reads its manifest and loads none of its code.
//
// One engine serves every request for its site, so nothing about a request lives on it: host() returns a view made
// by forUser(user) that shares the engine's state and has its own user and transaction (spec/13 section 8c).
const path = require("path");
const fs = require("fs");
const YAML = require("yaml");

const state = { hosts: new Map(), engine: null, version: null };
const TARGETS = ["server", "desktop", "browser"];
const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Where this backend runs (spec/14). haxcms-desktop and haxcms-browser set HAXCMS_TARGET; anything else is a server. */
function target() {
  const t = String(process.env.HAXCMS_TARGET || "server");
  return TARGETS.includes(t) ? t : "server";
}

function listPluginDirs(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .sort()
    .map((n) => path.join(dir, n))
    .filter((d) => fs.existsSync(path.join(d, "plugin.yaml")));
}

function specRoot() {
  try {
    return path.dirname(
      require.resolve("@haxtheweb/haxcms-plugin-spec/package.json"),
    );
  } catch {
    return null;
  }
}

function haxRootOf(root) {
  return root || process.env.HAXCMS_ROOT || process.cwd();
}

// ---- the registry files (spec/03) ----
function registryFile(scopeRoot) {
  return path.join(scopeRoot, "_config", "plugins", "plugins.yaml");
}

const idList = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && ID.test(x)) : [];

/** One scope's registry file, with every list present. A missing or unreadable file is an empty registry. */
function readRegistryFile(scopeRoot) {
  let doc = null;
  try {
    doc = YAML.parse(fs.readFileSync(registryFile(scopeRoot), "utf8"));
  } catch {
    doc = null;
  }
  const d = doc && typeof doc === "object" ? doc : {};
  return {
    version: 1,
    enabled: idList(d.enabled),
    locked: idList(d.locked),
    blocked: idList(d.blocked),
    plugins:
      d.plugins && typeof d.plugins === "object" && !Array.isArray(d.plugins)
        ? d.plugins
        : {},
  };
}

/** Written whole to a temp file and renamed, so a reader never sees half a registry. */
function writeRegistryFile(scopeRoot, reg) {
  const file = registryFile(scopeRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = { version: 1, enabled: reg.enabled.slice().sort() };
  if (reg.locked.length) {
    out.locked = reg.locked;
  }
  if (reg.blocked.length) {
    out.blocked = reg.blocked;
  }
  out.plugins = reg.plugins;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, YAML.stringify(out));
  fs.renameSync(tmp, file);
}

/** What the deployment decided for every site: the system registry (enabled, locked, blocked). */
function deploymentConfig(root) {
  return readRegistryFile(haxRootOf(root));
}

/**
 * The plugin folders for a site, highest tier last (site copies override system copies, which override core),
 * and the ids that are on without being listed: plugins from HAXCMS_PLUGIN_DIRS.
 */
function pluginDirsFor(site, root) {
  const out = [];
  const dev = [];
  const spec = specRoot();
  if (spec) {
    for (const d of listPluginDirs(path.join(spec, "core-plugins"))) {
      out.push({ path: d, tier: "system-core" });
    }
  }
  for (const d of listPluginDirs(path.join(root, "_plugins"))) {
    out.push({ path: d, tier: "system-contrib" });
  }
  for (const d of String(process.env.HAXCMS_PLUGIN_DIRS || "")
    .split(path.delimiter)
    .filter(Boolean)) {
    const found = fs.existsSync(path.join(d, "plugin.yaml"))
      ? [d]
      : listPluginDirs(d);
    for (const x of found) {
      out.push({ path: x, tier: "system-contrib" });
      dev.push(path.basename(x));
    }
  }
  if (site && site.siteDirectory) {
    for (const d of listPluginDirs(path.join(site.siteDirectory, "_plugins"))) {
      out.push({ path: d, tier: "site" });
    }
  }
  return { dirs: out, dev };
}

/** The ids enabled for a scope: the system's list, that site's own list, locked ones and development folders. */
function enabledFor(site, root, dev) {
  const system = readRegistryFile(root);
  const own =
    site && site.siteDirectory
      ? readRegistryFile(site.siteDirectory).enabled
      : [];
  const ids = new Set([...system.enabled, ...system.locked, ...own, ...dev]);
  return {
    enabled: [...ids].filter((id) => !system.blocked.includes(id)),
    locked: system.locked,
    blocked: system.blocked,
    system: system.enabled,
    own,
  };
}

async function engine() {
  if (!state.engine) {
    state.engine = await import("./HaxcmsPluginHost.mjs");
  }
  return state.engine;
}

function haxcmsVersion() {
  if (!state.version) {
    state.version =
      readJson(path.join(__dirname, "..", "..", "..", "package.json"), {})
        .version || "0.0.0";
  }
  return state.version;
}

/**
 * Saved plugin settings (spec/13 section 7): schema defaults (the engine adds those), then
 * <HAXCMS_ROOT>/_config/plugins/config/<id>.json, then <site>/_config/plugins/config/<id>.json (site wins), then
 * the secret fields from <HAXCMS_ROOT>/_config/plugins/secrets/<id>.json and, for a site,
 * <HAXCMS_ROOT>/_config/siteData/<site uuid>/plugins/<id>.secrets.json. Secrets never sit in a site folder.
 */
function pluginSettings(dirs, site, root) {
  const out = {};
  for (const d of dirs) {
    const id = path.basename(d.path);
    if (!ID.test(id)) {
      continue;
    }
    const system = readJson(
      path.join(root, "_config", "plugins", "config", `${id}.json`),
      {},
    );
    const local =
      site && site.siteDirectory
        ? readJson(
            path.join(
              site.siteDirectory,
              "_config",
              "plugins",
              "config",
              `${id}.json`,
            ),
            {},
          )
        : {};
    const secrets = readJson(
      path.join(root, "_config", "plugins", "secrets", `${id}.json`),
      {},
    );
    const siteSecrets =
      site && site.manifest && site.manifest.id
        ? readJson(
            path.join(
              root,
              "_config",
              "siteData",
              String(site.manifest.id),
              "plugins",
              `${id}.secrets.json`,
            ),
            {},
          )
        : {};
    const all = { ...system, ...local, ...secrets, ...siteSecrets };
    if (Object.keys(all).length) {
      out[id] = all;
    }
  }
  return out;
}

/** The engine itself for a site or (site null) the system, cached. Requests never work on this directly. */
async function rootHost(site, root) {
  const haxRoot = haxRootOf(root);
  const key = site ? site.siteDirectory : `\0system:${haxRoot}`;
  let h = state.hosts.get(key);
  if (!h) {
    const { HaxcmsPluginHost } = await engine();
    h = new HaxcmsPluginHost({
      site: site || null,
      root: haxRoot,
      version: haxcmsVersion(),
      liveNetwork: true,
      liveExec: true,
      target: target(),
      hydrate: false,
    });
    const { dirs, dev } = pluginDirsFor(site, haxRoot);
    const on = enabledFor(site, haxRoot, dev);
    await h.load(dirs, {
      enabled: on.enabled,
      blocked: on.blocked,
      required: on.locked,
      settings: pluginSettings(dirs, site, haxRoot),
    });
    state.hosts.set(key, h);
  }
  return h;
}

/**
 * The plugin engine for a site as one request sees it. `user` is the caller (null for a visitor). The site's records
 * are read only when a plugin is active: with none, nothing listens and nothing is read.
 */
async function host(site, { root, user = null } = {}) {
  if (!site || !site.manifest) {
    return null;
  }
  const h = await rootHost(site, root);
  // core reloads the site per request; keep the engine's view of site.json and pages current
  h.haxSite = site;
  if (h.hasActive()) {
    h.hydrate();
  }
  return h.forUser(user);
}

/**
 * The system engine as one request sees it: HAXcms-wide plugins with no site, for system-scope operations, the
 * registry and dashboard contributions (spec/13 section 8b). Site-tier plugins are not part of it.
 */
async function systemHost({ root, user = null } = {}) {
  const h = await rootHost(null, root);
  return h.forUser(user);
}

/** Forget cached engines (after plugins are installed, enabled or disabled). */
function reset() {
  state.hosts.clear();
}

/** Whether any plugin is active for the site, without reading a page. */
async function listening(site, opts = {}) {
  if (!site || !site.manifest) {
    return false;
  }
  return (await rootHost(site, opts.root)).hasActive();
}

/**
 * Fire the before hooks for a save core is about to make. Returns { record, veto, warnings }: when `veto` is set,
 * core must not write; otherwise it writes `record` (plugins may have changed it).
 */
async function before(site, type, record, previous, opts = {}) {
  if (!(await listening(site, opts))) {
    return { record, veto: null, warnings: [] };
  }
  const h = await host(site, opts);
  const op = opts.delete ? "delete" : previous ? "update" : "create";
  const r = await h.fire(`entity.before.${op}`, record, {
    entity: type,
    previous,
  });
  // fields under metadata.plugins.<id> must be declared by that plugin (spec/04); others are dropped with a warning
  const warnings = [
    ...(r.warnings || []),
    ...(!r.veto && !opts.delete ? h.checkPluginMetadata(type, r.subject) : []),
  ];
  return {
    record: opts.delete ? record : r.subject,
    veto: r.veto || null,
    warnings,
  };
}

/** Fire the after hooks once core has written (or deleted) the record. */
async function after(site, type, record, previous, opts = {}) {
  if (!(await listening(site, opts))) {
    return { warnings: [] };
  }
  const h = await host(site, opts);
  const op = opts.delete ? "delete" : previous ? "update" : "create";
  const r = await h.fire(`entity.after.${op}`, record, {
    entity: type,
    previous,
  });
  return { warnings: r.warnings || [] };
}

/** rebuild.before / rebuild.after around core's managed-file rewrite (updateAlternateFormats). */
async function rebuild(site, reason = "save", opts = {}) {
  if (!(await listening(site, opts))) {
    return null;
  }
  const h = await host(site, opts);
  return h.rebuild(reason);
}

// ---- the registry (spec/03) ----
/** Sites that enabled a plugin themselves: { pluginId: [site folder names] }, from each site's registry file. */
function sitesUsing(root, sitesDirectory) {
  const out = {};
  const base = path.join(root, sitesDirectory || "_sites");
  if (!fs.existsSync(base)) {
    return out;
  }
  for (const name of fs.readdirSync(base).sort()) {
    const dir = path.join(base, name);
    if (!fs.existsSync(registryFile(dir))) {
      continue;
    }
    for (const id of readRegistryFile(dir).enabled) {
      out[id] = out[id] || [];
      out[id].push(name);
    }
  }
  return out;
}

/**
 * The registry for the system (site null) or for one site: one entry per installed plugin with its status, what it
 * needs from a backend, how it fits each target and what is limited here (spec/03, spec/14).
 */
async function registry(site, opts = {}) {
  const root = haxRootOf(opts.root);
  const h = site ? await host(site, opts) : await systemHost(opts);
  if (!h) {
    return [];
  }
  const system = readRegistryFile(root);
  const own =
    site && site.siteDirectory
      ? readRegistryFile(site.siteDirectory).enabled
      : [];
  const using = site ? {} : sitesUsing(root, opts.sitesDirectory);
  return h.registry().map((e) => {
    const entry = {
      ...e,
      locked: system.locked.includes(e.id),
      blocked: system.blocked.includes(e.id),
      scope: system.enabled.includes(e.id)
        ? "system"
        : own.includes(e.id)
          ? "site"
          : null,
    };
    if (!site) {
      entry.sites = using[e.id] || [];
    }
    return entry;
  });
}

async function entryOf(site, id, opts) {
  return (await registry(site, opts)).find((e) => e.id === id) || null;
}

/**
 * Enable a plugin for the system (site null) or for one site. Runs the engine's enable (install hooks on a first
 * enable, plugin.before.enable, requirements) and writes the registry file only when that succeeded.
 * Returns { status, body }.
 */
async function enable(site, id, opts = {}) {
  const root = haxRootOf(opts.root);
  const refusals = (await engine()).REGISTRY_REFUSALS;
  if (!ID.test(String(id))) {
    return { status: 404, body: { error: refusals.notInstalled } };
  }
  const system = readRegistryFile(root);
  if (system.blocked.includes(id)) {
    return { status: 409, body: { error: refusals.blocked } };
  }
  const h = site ? await host(site, opts) : await systemHost(opts);
  const p = h && h.get(id);
  if (!p) {
    return { status: 404, body: { error: refusals.notInstalled } };
  }
  if (site) {
    // install and enable hooks may read the site's records, which are not read while nothing is active
    h.hydrate();
  }
  if (site && p.tier !== "site" && system.enabled.includes(id)) {
    // already on for every site: nothing to record for this one
    return { status: 200, body: await entryOf(site, id, opts) };
  }
  const r =
    p.status === "active" || p.status === "inactive"
      ? { status: 200 }
      : await h.enable(id);
  if (r.status !== 200) {
    return r;
  }
  const scopeRoot = site ? site.siteDirectory : root;
  const reg = readRegistryFile(scopeRoot);
  if (!reg.enabled.includes(id)) {
    reg.enabled.push(id);
  }
  reg.plugins[id] = {
    version: String(p.manifest.version || ""),
    enabledAt: new Date().toISOString(),
    by: opts.user && opts.user.name ? String(opts.user.name) : "",
  };
  writeRegistryFile(scopeRoot, reg);
  if (!site) {
    // every site's engine has to see the new system list
    reset();
  }
  return { status: 200, body: await entryOf(site, id, opts) };
}

/** Disable a plugin for the system or for one site. Refusals come from the engine (required, dependents). */
async function disable(site, id, opts = {}) {
  const root = haxRootOf(opts.root);
  const refusals = (await engine()).REGISTRY_REFUSALS;
  if (!ID.test(String(id))) {
    return { status: 404, body: { error: refusals.notInstalled } };
  }
  const system = readRegistryFile(root);
  const h = site ? await host(site, opts) : await systemHost(opts);
  const p = h && h.get(id);
  if (!p) {
    return { status: 404, body: { error: refusals.notInstalled } };
  }
  if (system.locked.includes(id)) {
    return { status: 409, body: { error: refusals.locked } };
  }
  if (site && system.enabled.includes(id)) {
    return { status: 409, body: { error: refusals.systemEnabled } };
  }
  const r = await h.disable(id);
  if (r.status !== 200) {
    return r;
  }
  const scopeRoot = site ? site.siteDirectory : root;
  const reg = readRegistryFile(scopeRoot);
  reg.enabled = reg.enabled.filter((x) => x !== id);
  delete reg.plugins[id];
  writeRegistryFile(scopeRoot, reg);
  reset();
  const entry = await entryOf(site, id, opts);
  return {
    status: 200,
    body: r.body && r.body.inUse ? { ...entry, inUse: r.body.inUse } : entry,
  };
}

// ---- settings (spec/13 section 7) ----
/** A plugin's settings form and values for the system (site null) or one site; secrets come back as set or not. */
async function settings(site, id, opts = {}) {
  const refusals = (await engine()).REGISTRY_REFUSALS;
  const h = site ? await host(site, opts) : await systemHost(opts);
  const view = h && ID.test(String(id)) ? h.settingsView(id) : null;
  return view
    ? { status: 200, body: view }
    : { status: 404, body: { error: refusals.notInstalled } };
}

/**
 * Save a plugin's settings. The system saves system-scope settings; a site saves its own only for a plugin whose
 * settingsScope is site or both. Validation and the config hooks run in the engine; a secret left out or sent
 * empty keeps its stored value.
 */
async function saveSettings(site, id, values, opts = {}) {
  const refusals = (await engine()).REGISTRY_REFUSALS;
  const h = site ? await host(site, opts) : await systemHost(opts);
  const p = h && ID.test(String(id)) ? h.get(id) : null;
  if (!p || p.status === "available" || p.status === "refused") {
    return { status: 404, body: { error: refusals.notInstalled } };
  }
  const scope = p.manifest.settingsScope || "system";
  if (site ? scope === "system" : scope === "site") {
    return { status: 409, body: { error: refusals.settingsScope } };
  }
  if (site) {
    h.hydrate();
  }
  const secret = h.secretFields(p);
  const clean = {};
  const input =
    values && typeof values === "object" && !Array.isArray(values)
      ? values
      : {};
  for (const [k, v] of Object.entries(input)) {
    if (secret.has(k) && (v === "" || v === null || v === undefined)) {
      continue;
    }
    clean[k] = v;
  }
  const r = await h.saveConfig(id, clean);
  if (r.status !== 200) {
    return r;
  }
  return { status: 200, body: h.settingsView(id) };
}

module.exports = {
  settings,
  saveSettings,
  host,
  systemHost,
  reset,
  before,
  after,
  rebuild,
  registry,
  enable,
  disable,
  target,
  pluginDirsFor,
  deploymentConfig,
  readRegistryFile,
};
