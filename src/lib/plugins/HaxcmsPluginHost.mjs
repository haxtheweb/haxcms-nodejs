// DRAFT (plugin platform, contingent on https://github.com/haxtheweb/haxcms-plugin-examples/pull/1).
//
// The plugin engine for one HAXcms site. It reuses the reference engine from the spec package (loading, manifest
// validation, hook dispatch with aliases, priorities, stages and no re-entry, vetoes, transactions, ctx, contracts,
// schedules, requirements) and replaces its in-memory storage with this site's real storage:
//   - page and site records come from site.json and the page files, and saves write them back;
//   - plugin stores live where spec/04 puts them (site: <site>/_config/data/<plugin>/, siteData:
//     <HAXCMS_ROOT>/_config/siteData/<site uuid>/<plugin>/, system: <HAXCMS_ROOT>/_config/systemData/<plugin>/);
//   - managed files are written into the site folder; ctx.fetch goes through core's safeFetch (SSRF guard);
//   - ctx.now() is the real clock unless a test freezes it.
// Whether HAXcms keeps this shared engine or grows its own is an open question for review (spec/13 section 9).
import { MemoryBackend } from "@haxtheweb/haxcms-plugin-spec/harness/memory-backend.mjs";
import { join, dirname } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { URL } from "node:url";

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
   * @param {object} o.site      a loaded HAXCMSSite
   * @param {string} o.root      HAXCMS_ROOT (for siteData and system stores)
   * @param {string} o.version   the running HAXcms version
   * @param {boolean} [o.liveNetwork]  real fetches through safeFetch (HAXcms); off for test adapters
   * @param {object} [o.user]    the signed-in user record, or null for a visitor (omitted: the engine's default admin)
   */
  constructor({ site, root, version, user, hookTimeout, liveNetwork = false }) {
    const name =
      (site.manifest &&
        site.manifest.metadata &&
        site.manifest.metadata.site &&
        site.manifest.metadata.site.name) ||
      site.name ||
      "site";
    super({
      haxcmsVersion: version,
      runtime: "nodejs",
      site: { id: site.manifest.id, name, path: site.siteDirectory },
      ...(user !== undefined ? { user } : {}),
      ...(hookTimeout ? { hookTimeout } : {}),
    });
    this.haxSite = site;
    this.root = root;
    // live network only when HAXcms runs it; adapters for the spec's runners stay offline (fakes or nothing)
    this.liveNetwork = liveNetwork;
    let frozen = null;
    // the real clock; tests may freeze it (backend.now = ms)
    Object.defineProperty(this, "now", {
      get: () => (frozen === null ? Date.now() : frozen),
      set: (v) => {
        frozen = v;
      },
      configurable: true,
    });
    this.hydrate();
  }

  // ---- records: site.json and the page files ----
  hydrate() {
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
  writeFile(full, content) {
    this.rememberFile(full);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  async saveManifest() {
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
    if (r.deleted && type === "page") {
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
    const m = this.haxSite.manifest;
    const domain = m && m.metadata && m.metadata.site && m.metadata.site.domain;
    const base = process.env.HAXCMS_PUBLIC_URL;
    if (!domain && base) {
      const sites = process.env.HAXCMS_SITES_PATH || "sites";
      info.url = `${base.replace(/\/+$/, "")}/${sites}/${this.site.name}/`;
    }
    return info;
  }

  // ---- settings: saved to <HAXCMS_ROOT>/_config/plugins/config/<id>.json (spec/13); hooks and validation run in
  // the engine. TODO(draft): site-scope writes and write-only secrets.
  async saveConfig(id, values) {
    const r = await super.saveConfig(id, values);
    const p = this.get(id);
    if (r.status === 200 && p) {
      const file = join(
        this.root,
        "_config",
        "plugins",
        "config",
        `${id}.json`,
      );
      const saved = {};
      for (const k of p.explicit) saved[k] = p.settings[k];
      this.writeFile(file, JSON.stringify(saved, null, 2) + "\n");
    }
    return r;
  }

  // ---- plugin stores at the spec/04 locations ----
  storeFile(p, s) {
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
    const r = super.writeManaged(p, path, content);
    this.writeFile(join(this.site.path, path), String(content));
    return r;
  }

  // ---- network: egress from the manifest, then core's SSRF-guarded fetch ----
  async fetchFor(p, url, init = {}) {
    // test harness fakes still win when a case provides them
    if (!this.liveNetwork) return super.fetchFor(p, url, init);
    const host = new URL(url).hostname;
    const hosts = this.egressHosts(p);
    if (
      !(p.manifest.capabilities || []).includes("network:egress") ||
      !(hosts.includes("*") || hosts.includes(host))
    )
      throw new Error(`fetch to ${host} not allowed`);
    this.fetchCalls.push({
      plugin: p.id,
      method: (init.method || "GET").toUpperCase(),
      url,
    });
    // TODO(draft): safeFetch re-validates every redirect hop against private addresses; it does not yet re-check the
    // plugin's egress list per hop (spec/13 asks for both). Final-URL check until safeFetch exposes a hop callback.
    const res = await safeFetch(url, { ...init, maxRedirects: 5 });
    const finalHost = res && res.url ? new URL(res.url).hostname : host;
    if (!(hosts.includes("*") || hosts.includes(finalHost)))
      throw new Error(`fetch to ${finalHost} not allowed (redirected)`);
    return res;
  }
}

export default HaxcmsPluginHost;
