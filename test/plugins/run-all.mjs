// DRAFT (plugin platform, contingent on https://github.com/haxtheweb/haxcms-plugin-examples/pull/1).
//
// Runs the spec's conformance cases, then every core and contrib plugin's own tests, against real HAXcms storage
// through test/plugins/haxcms-adapter.mjs (Node runtime only; PHP plugins are haxcms-php's job).
//   npm run test:plugins            all of it
//   npm run test:plugins -- feeds   one plugin (folder name under core-plugins/ or contrib-plugins/)
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const spec = dirname(require.resolve("@haxtheweb/haxcms-plugin-spec/package.json"));
const adapter = join(here, "haxcms-adapter.mjs");
const only = process.argv[2];
const env = { ...process.env, HAXCMS_ROOT: process.env.HAXCMS_ROOT || mkdtempSync(join(tmpdir(), "haxcms-plugin-cases-")) + "/" };
const run = (args) => spawnSync(process.execPath, args, { stdio: "inherit", env }).status === 0;

let failed = [];
if (!only && !run([join(spec, "conformance", "run.mjs"), "--backend", adapter])) failed.push("conformance");
for (const tier of ["core-plugins", "contrib-plugins"]) {
  for (const name of readdirSync(join(spec, tier)).sort()) {
    const dir = join(spec, tier, name);
    if (only && name !== only) continue;
    if (!existsSync(join(dir, "tests"))) continue;
    if (!run([join(spec, "harness", "run-cases.mjs"), dir, "--runtime", "nodejs", "--backend", adapter])) failed.push(name);
  }
}
console.log(failed.length ? `\nfailed: ${failed.join(", ")}` : "\nall plugin cases pass against HAXcms storage");
process.exit(failed.length ? 1 : 0);
