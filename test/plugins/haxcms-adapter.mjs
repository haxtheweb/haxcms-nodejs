// Adapter for the plugin spec's runners (spec/13 section 9): every case gets a fresh, real HAXcms site in a temp
// HAXCMS_ROOT and the HaxcmsPluginHost engine over it, so the spec's conformance cases and any plugin's tests run
// against HAXcms storage instead of the in-memory reference.
//   HAXCMS_ROOT=$(mktemp -d)/ node node_modules/@haxtheweb/haxcms-plugin-spec/conformance/run.mjs --backend test/plugins/haxcms-adapter.mjs
//   HAXCMS_ROOT=$(mktemp -d)/ node node_modules/@haxtheweb/haxcms-plugin-spec/harness/run-cases.mjs <plugin> --runtime nodejs --backend test/plugins/haxcms-adapter.mjs
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HaxcmsPluginHost } from "../../src/lib/plugins/HaxcmsPluginHost.mjs";

const require = createRequire(import.meta.url);
// HAXcms reads HAXCMS_ROOT when HAXCMS.js loads; default to a fresh temp folder
if (!process.env.HAXCMS_ROOT) process.env.HAXCMS_ROOT = mkdtempSync(join(tmpdir(), "haxcms-plugin-cases-")) + "/";
const { HAXCMS } = require("../../src/lib/HAXCMS.js");
let n = 0;

export async function createBackend(opts = {}) {
  const site = await HAXCMS.loadSite(`conformance-${process.pid}-${++n}`, true);
  if (!site || !site.manifest) throw new Error("could not create a HAXcms site for the case");
  // start each case from an empty outline, as the reference does
  site.manifest.items = [];
  await site.manifest.save(false);
  // system and siteData stores are shared across sites, so each case gets its own store root and starts empty
  const storeRoot = mkdtempSync(join(tmpdir(), "plugin-stores-"));
  const host = new HaxcmsPluginHost({ site, root: storeRoot, version: opts.haxcmsVersion || "26.10.1", ...(opts.user !== undefined ? { user: opts.user } : {}), ...(opts.hookTimeout ? { hookTimeout: opts.hookTimeout } : {}) });
  // the reference's frozen clock, so time-based cases mean the same thing (a case's run.now overrides it)
  host.now = Date.parse("2026-01-01T00:00:00Z");
  return host;
}
