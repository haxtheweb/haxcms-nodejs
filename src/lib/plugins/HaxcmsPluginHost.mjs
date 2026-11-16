// DRAFT (plugin platform, contingent on https://github.com/haxtheweb/haxcms-plugins/pull/15).
//
// The plugin engine for one HAXcms site. It reuses the reference engine from the spec package (loading, manifest
// validation, hook dispatch with aliases, priorities, stages and no re-entry, vetoes, transactions, ctx, contracts,
// schedules, requirements) and replaces its in-memory storage with this site's real storage:
//   - page and site records come from site.json and the page files, and saves write them back;
//   - plugin stores live where spec/04 puts them (site: <site>/_config/data/<plugin>/, siteData:
//     <HAXCMS_ROOT>/_config/siteData/<site uuid>/<plugin>/, system: <HAXCMS_ROOT>/_config/systemData/<plugin>/);
//   - managed files are written into the site folder; ctx.fetch goes through core's safeFetch (SSRF guard) one hop
//     at a time, with the plugin's egress list checked again on every hop;
//   - ctx.now() is the real clock unless a test freezes it.
// Whether HAXcms keeps this shared engine or grows its own is an open question for review (spec/13 section 9).
import {
  MemoryBackend,
  REGISTRY_REFUSALS,
} from "@haxtheweb/haxcms-plugin-spec/harness/memory-backend.mjs";

// the registry's refusals, from the engine, so both backends and the reference answer alike
export { REGISTRY_REFUSALS };
import { join, dirname, resolve, sep } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  renameSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";

const require = createRequire(import.meta.url);
const JSONOutlineSchemaItem = require("../JSONOutlineSchemaItem.js");
const JSONOutlineSchema = require("../JSONOutlineSchema.js");
const { safeFetch } = require("../safeFetch.js");

const clone = (v) =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v));
// drops "<...>" tag spans (as /<[^>]+>/g does) without a regex sanitizer; the result is a path segment of
// [a-z0-9-] only, never HTML. Same output as haxcms-php's HAXCMSPluginHost::slug.
const withoutTags = (text) => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // a tag needs at least one character that is not ">" before its closing ">"
    const close =
      text[i] === "<" && i + 1 < text.length && text[i + 1] !== ">"
        ? text.indexOf(">", i + 1)
        : -1;
    if (close !== -1) {
      i = close + 1;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
};
const slugify = (t) =>
  withoutTags(String(t || "").toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "page";

export class HaxcmsPluginHost extends MemoryBackend {
  /**
   * @param {object} o
   * @param {object|null} o.site a loaded HAXCMSSite, or null for the system engine: HAXcms-wide work with no site
   *                             (spec/13 section 8b)
   * @param {string} o.root      HAXCMS_ROOT (for siteData and system stores)
   * @param {string} o.version   the running HAXcms version
   * @param {boolean} [o.liveNetwork]  real fetches through safeFetch (HAXcms); off for test adapters
   * @param {boolean} [o.liveExec]  ctx.exec runs the command (HAXcms); off for test adapters, which answer from fakes
   * @param {object} [o.user]    the signed-in user record, or null for a visitor (omitted: the engine's default admin)
   * @param {string} [o.target]  server (default), desktop or browser (spec/14)
   * @param {boolean} [o.hydrate] read the site's records now (default); false leaves it to the caller
   */
  constructor({
    site,
    root,
    version,
    user,
    hookTimeout,
    liveNetwork = false,
    liveExec = false,
    target = "server",
    hydrate = true,
  }) {
    const name =
      site &&
      ((site.manifest &&
        site.manifest.metadata &&
        site.manifest.metadata.site &&
        site.manifest.metadata.site.name) ||
        site.name ||
        "site");
    super({
      haxcmsVersion: version,
      runtime: "nodejs",
      // where this backend runs (spec/14): server, desktop (haxcms-desktop) or browser (haxcms-browser)
      target,
      site: site
        ? { id: site.manifest.id, name, path: site.siteDirectory }
        : null,
      ...(user !== undefined ? { user } : {}),
      ...(hookTimeout ? { hookTimeout } : {}),
    });
    this.haxSite = site;
    this.root = root;
    // live network only when HAXcms runs it; adapters for the spec's runners stay offline (fakes or nothing)
    this.liveNetwork = liveNetwork;
    this.liveExec = liveExec;
    this.tmpCount = 0;
    let frozen = null;
    // the real clock; tests may freeze it (backend.now = ms)
    Object.defineProperty(this, "now", {
      get: () => (frozen === null ? Date.now() : frozen),
      set: (v) => {
        frozen = v;
      },
      configurable: true,
    });
    // HAXcms hydrates only once a plugin is active (pluginSystem.host); test adapters hydrate up front
    if (hydrate) {
      this.hydrate();
    }
  }

  /** Whether any plugin is active: when none is, nothing listens and core's saves need no engine work at all. */
  hasActive() {
    return this.plugins.some((p) => p.status === "active");
  }

  // ---- records: site.json and the page files ----
  hydrate() {
    if (!this.haxSite) return;
    const m = this.haxSite.manifest;
    this.records.site = {
      [this.site.id]: {
        id: m.id,
        title: m.title,
        description: m.description,
        license: m.license,
        metadata: clone(m.metadata) || {},
        items: [],
      },
    };
    this.records.page = {};
    for (const it of m.items || [])
      this.records.page[it.id] = { ...clone(it), content: this.readPage(it) };
  }
  // re-read site.json and the page files: records are what is on disk, not what was last held in memory
  // (conformance `reload` step, spec/13 section 9)
  async reload() {
    if (!this.haxSite) return;
    const fresh = new JSONOutlineSchema();
    if (await fresh.load(this.haxSite.manifest.file))
      this.haxSite.manifest = fresh;
    this.hydrate();
  }
  // an atomic transaction that fails puts back what it wrote to disk too (the engine restores the files it was told
  // about through rememberFile); site.json is then read again so the next save does not write the rolled-back pages
  async transaction(fn, opts = {}) {
    try {
      return await super.transaction(fn, opts);
    } catch (e) {
      if (e && e.rolledBack) await this.reload();
      throw e;
    }
  }
  // written whole to a temp file beside it and renamed, so a reader never sees half a file (spec/04)
  writeFile(full, content, mode) {
    this.rememberFile(full);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.${++this.tmpCount}.tmp`;
    writeFileSync(tmp, content, mode ? { mode } : undefined);
    renameSync(tmp, full);
  }
  async saveManifest() {
    if (!this.haxSite) return;
    if (this.haxSite.manifest.file)
      this.rememberFile(this.haxSite.manifest.file);
    await this.haxSite.manifest.save(false);
  }
  readPage(item) {
    try {
      const full = this.haxSite.resolvePageLocationRealPath(item.location);
      return full ? readFileSync(full, "utf8") : "";
    } catch {
      return "";
    }
  }
  // seeding (tests and conformance cases) goes through the same write path as saves
  seed(records = {}) {
    super.seed(records);
    if (records.site) this.writeToDisk("site", this.records.site[this.site.id]);
    for (const r of Object.values(this.records.page || {}))
      this.writeToDisk("page", r);
  }
  // called by the engine after the before hooks accepted a save
  writeToDisk(type, record) {
    if (!this.haxSite) return;
    const m = this.haxSite.manifest;
    if (type === "page") {
      let item = (m.items || []).find((x) => x.id === record.id);
      if (!item) {
        item = new JSONOutlineSchemaItem();
        item.id = record.id;
        item.location = `pages/${slugify(record.slug || record.title || record.id)}-${String(record.id).slice(-6)}/index.html`;
        m.items.push(item);
      }
      for (const k of [
        "title",
        "slug",
        "parent",
        "order",
        "indent",
        "description",
      ])
        if (record[k] !== undefined) item[k] = record[k];
      if (!item.slug) item.slug = slugify(record.title || record.id);
      item.metadata = { ...(clone(record.metadata) || {}) };
      this.writeFile(
        join(this.site.path, item.location),
        String(record.content ?? ""),
      );
      this.records.page[record.id] = {
        ...clone(item),
        content: String(record.content ?? ""),
      };
      return this.saveManifest();
    } else if (type === "site") {
      if (record.title !== undefined) m.title = record.title;
      if (record.description !== undefined) m.description = record.description;
      if (record.metadata) m.metadata = clone(record.metadata);
      return this.saveManifest();
    }
  }
  async deleteEntity(type, id) {
    const r = await super.deleteEntity(type, id);
    if (r.deleted && type === "page" && this.haxSite) {
      const m = this.haxSite.manifest;
      const item = (m.items || []).find((x) => x.id === id);
      m.items = (m.items || []).filter((x) => x.id !== id);
      if (item && item.location) {
        const full = join(this.site.path, item.location);
        this.rememberFile(full);
        try {
          rmSync(join(this.site.path, dirname(item.location)), {
            recursive: true,
            force: true,
          });
        } catch {
          /* already gone */
        }
      }
      await this.saveManifest();
    }
    return r;
  }

  // ---- the site's public URL: its domain, else HAXCMS_PUBLIC_URL + the sites path ----
  // TODO(draft): HAXcms has no single "public base URL" setting today; the reference engine's example.invalid
  // fallback stays for test adapters that set neither.
  siteInfo() {
    const info = super.siteInfo();
    if (!info) return null;
    const m = this.haxSite.manifest;
    const domain = m && m.metadata && m.metadata.site && m.metadata.site.domain;
    const base = process.env.HAXCMS_PUBLIC_URL;
    if (!domain && base) {
      const sites = process.env.HAXCMS_SITES_PATH || "sites";
      info.url = `${base.replace(/\/+$/, "")}/${sites}/${this.site.name}/`;
    }
    return info;
  }

  // ---- settings (spec/13 sections 1 and 7): hooks and validation run in the engine; what was saved is written to
  //   system scope   <HAXCMS_ROOT>/_config/plugins/config/<id>.json
  //   site scope     <site>/_config/plugins/config/<id>.json          (a plugin whose settingsScope is site or both)
  // and secret fields (x-secret) never to either: they go to
  //   system scope   <HAXCMS_ROOT>/_config/plugins/secrets/<id>.json
  //   site scope     <HAXCMS_ROOT>/_config/siteData/<site uuid>/plugins/<id>.secrets.json
  // outside every site folder and its git history, readable by the server's user only.
  settingsFiles(p) {
    const perSite =
      !!this.haxSite &&
      ["site", "both"].includes(p.manifest.settingsScope || "system");
    return {
      config: perSite
        ? join(this.site.path, "_config", "plugins", "config", `${p.id}.json`)
        : join(this.root, "_config", "plugins", "config", `${p.id}.json`),
      secrets: perSite
        ? join(
            this.root,
            "_config",
            "siteData",
            this.site.id,
            "plugins",
            `${p.id}.secrets.json`,
          )
        : join(this.root, "_config", "plugins", "secrets", `${p.id}.json`),
    };
  }
  secretFields(p) {
    return new Set(
      p.form.filter((f) => f && f["x-secret"]).map((f) => f.property),
    );
  }
  async saveConfig(id, values) {
    const r = await super.saveConfig(id, values);
    const p = this.get(id);
    if (r.status === 200 && p) {
      const secret = this.secretFields(p);
      const files = this.settingsFiles(p);
      const plain = {};
      const hidden = {};
      for (const k of p.explicit) {
        (secret.has(k) ? hidden : plain)[k] = p.settings[k];
      }
      this.writeFile(files.config, JSON.stringify(plain, null, 2) + "\n");
      if (secret.size) {
        this.writeFile(
          files.secrets,
          JSON.stringify(hidden, null, 2) + "\n",
          0o600,
        );
      }
    }
    return r;
  }
  /** A plugin's settings for a screen: the form, and the values with every secret replaced by whether it is set. */
  settingsView(id) {
    const p = this.get(id);
    if (!p) return null;
    const secret = this.secretFields(p);
    const eff = this.effectiveSettings(p);
    const values = {};
    for (const [k, v] of Object.entries(eff)) {
      values[k] = secret.has(k)
        ? { secret: true, set: v !== undefined && v !== null && v !== "" }
        : v;
    }
    for (const k of secret) {
      if (!(k in values)) values[k] = { secret: true, set: false };
    }
    return {
      id: p.id,
      scope: p.manifest.settingsScope || "system",
      fields: p.form,
      values,
      status: p.status,
      unmet: p.unmet || [],
    };
  }

  // ---- plugin stores at the spec/04 locations ----
  storeFile(p, s) {
    if (["site", "siteData", "manifest"].includes(s.scope))
      this.requireSite(`${p.id}: store "${s.id}" (${s.scope} scope)`);
    if (s.scope === "site")
      return join(
        this.site.path,
        "_config",
        "data",
        p.id,
        s.file || `${s.id}.json`,
      );
    if (s.scope === "siteData")
      return join(
        this.root,
        "_config",
        "siteData",
        this.site.id,
        p.id,
        s.file || `${s.id}.json`,
      );
    if (s.scope === "system")
      return join(
        this.root,
        "_config",
        "systemData",
        p.id,
        s.file || `${s.id}.json`,
      );
    return null;
  }
  readStore(p, id) {
    const s = p.stores[id];
    const file =
      s && !(p.storeOverrides && id in p.storeOverrides)
        ? this.storeFile(p, s)
        : null;
    if (!file) return super.readStore(p, id);
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    } catch {
      return null;
    }
  }
  writeStore(p, id, value) {
    const s = p.stores[id];
    const file = s ? this.storeFile(p, s) : null;
    if (!file) return super.writeStore(p, id, value);
    if (p.storeOverrides) delete p.storeOverrides[id];
    this.writeFile(file, JSON.stringify(value, null, 2) + "\n");
  }

  // ---- managed files land in the site folder ----
  writeManaged(p, path, content) {
    this.requireSite(`${p.id}: managed files`);
    const r = super.writeManaged(p, path, content);
    this.writeFile(join(this.site.path, path), String(content));
    return r;
  }

  // ---- network: the engine checks the plugin's egress list on every hop (fetchFor); each hop goes through core's
  // SSRF-guarded fetch, resolved, validated and pinned, with no redirect followed inside it ----
  async fetchOnce(p, url, init, host) {
    // test harness fakes still win when a case provides them
    if (!this.liveNetwork) return super.fetchOnce(p, url, init, host);
    // init comes from the plugin: never let it ask safeFetch to follow redirects itself
    const opts = Object.assign({}, init, {
      maxRedirects: 0,
      redirect: "manual",
    });
    return safeFetch(url, opts);
  }

  // ---- ctx.exec: the engine has checked the exec list and argument list; this runs the command (spec/13) ----
  // No shell, an argument list only. `files` go into a private temp folder, named {tmp} in arguments, removed
  // afterwards. The command runs in the site folder (or a `cwd` inside it) with a minimal environment (PATH,
  // HOME={tmp}, LANG), a timeout (60 s by default, 300 s at most) and a 10 MB cap on each of stdout and stderr; a
  // time-out or an output over the cap kills it and throws. Same rules as haxcms-php's HAXCMSPluginHost::execOnce.
  async execOnce(p, cmd, args, opts = {}) {
    if (!this.liveExec) return super.execOnce(p, cmd, args, opts);
    const files = opts.files || {};
    for (const name of Object.keys(files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..")
        throw new Error(`exec file name "${name}" is not a plain file name`);
    }
    // a site engine runs in the site folder (or under it); the system engine has none, so it runs in its temp folder
    let cwd = null;
    if (this.site) {
      const site = realpathSync(this.site.path);
      cwd = resolve(site, String(opts.cwd || "."));
      if (cwd !== site && !cwd.startsWith(site + sep))
        throw new Error("exec cwd must be inside the site folder");
    } else if (opts.cwd && opts.cwd !== ".") this.requireSite("exec cwd");
    const timeout = Math.min(
      Number.isInteger(opts.timeout) && opts.timeout > 0 ? opts.timeout : 60000,
      300000,
    );
    const cap = 10 * 1024 * 1024;
    const tmp = mkdtempSync(join(tmpdir(), "hax-exec-"));
    if (cwd === null) cwd = tmp;
    try {
      for (const [name, f] of Object.entries(files)) {
        writeFileSync(join(tmp, name), String((f && f.content) ?? ""), {
          mode: f && Number.isInteger(f.mode) ? f.mode : 0o600,
        });
      }
      const argv = args.map((a) => a.split("{tmp}").join(tmp));
      return await new Promise((done, fail) => {
        const child = spawn(cmd, argv, {
          cwd,
          shell: false,
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            HOME: tmp,
            LANG: "C.UTF-8",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const out = { stdout: [], stderr: [], bytes: { stdout: 0, stderr: 0 } };
        let failure = null;
        const stop = (message) => {
          if (!failure) failure = new Error(message);
          child.kill("SIGKILL");
        };
        const timer = setTimeout(
          () => stop(`exec "${cmd}" timed out after ${timeout} ms`),
          timeout,
        );
        for (const stream of ["stdout", "stderr"]) {
          child[stream].on("data", (chunk) => {
            out.bytes[stream] += chunk.length;
            if (out.bytes[stream] > cap)
              return stop(`exec "${cmd}" ${stream} exceeded 10 MB`);
            out[stream].push(chunk);
          });
        }
        child.on("error", (e) => {
          clearTimeout(timer);
          fail(new Error(`exec "${cmd}" could not start: ${e.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (failure) return fail(failure);
          done({
            code: code === null ? 1 : code,
            stdout: Buffer.concat(out.stdout).toString("utf8"),
            stderr: Buffer.concat(out.stderr).toString("utf8"),
          });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(opts.input === undefined ? "" : String(opts.input));
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

export default HaxcmsPluginHost;
