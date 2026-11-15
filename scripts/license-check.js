"use strict";
/**
 * Dependency license check (haxtheweb/issues#3262).
 *
 * This package is Apache-2.0, so every dependency in yarn.lock (direct and
 * transitive, runtime and dev) must carry a license that is compatible with
 * it. Licenses are read from the installed node_modules tree; a package that
 * is not installed on this platform (an optional dependency for another OS)
 * is looked up on the npm registry instead.
 *
 *   node scripts/license-check.js --base-lockfile <path>
 *       PR mode: only packages that are NEW compared with the given (base
 *       branch) yarn.lock are checked.
 *   node scripts/license-check.js
 *       Sweep mode: every package in yarn.lock is checked.
 *   node scripts/license-check.js --repo-license
 *       Also check that LICENSE.md / LICENSE and package.json are Apache-2.0.
 *
 * Verdicts:
 *   allowed       MIT, MIT-0, ISC, BSD-*, Apache-2.0, 0BSD, CC0-1.0,
 *                 Unlicense, Python-2.0, BlueOak-1.0.0
 *   denied        GPL-*, AGPL-*, SSPL, BUSL, Commons Clause, UNLICENSED
 *   unknown       no license field, or "SEE LICENSE IN ..."
 *   needs review  LGPL-*, MPL-*, and any other license not listed above
 * Anything but "allowed" fails (exit 1). A package a maintainer has reviewed
 * and accepted can be listed in .github/license-exceptions.json as
 * { "name@version": "reason" } (or "name" for every version).
 *
 * Findings go to stdout, to GitHub annotations and, when GITHUB_STEP_SUMMARY
 * is set, to the job summary.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REGISTRY = "https://registry.npmjs.org/";

const ALLOWED = new Set(
  [
    "MIT",
    "MIT-0",
    "ISC",
    "Apache-2.0",
    "0BSD",
    "CC0-1.0",
    "Unlicense",
    "Python-2.0",
    "BlueOak-1.0.0",
  ].map((id) => id.toLowerCase()),
);

// Common non-SPDX spellings found in package.json files.
const ALIASES = {
  "apache 2.0": "Apache-2.0",
  "apache-2": "Apache-2.0",
  apache2: "Apache-2.0",
  "apache 2": "Apache-2.0",
  "apache license 2.0": "Apache-2.0",
  "apache license, version 2.0": "Apache-2.0",
  "the mit license": "MIT",
  "mit license": "MIT",
  "isc license": "ISC",
  cc0: "CC0-1.0",
  "the unlicense": "Unlicense",
  // Old package.json files say just "BSD"; every BSD variant is allowed.
  bsd: "BSD-3-Clause",
};

const RANK = { allowed: 0, review: 1, unknown: 2, denied: 3 };
const LABEL = {
  allowed: "allowed",
  review: "needs review",
  unknown: "unknown license",
  denied: "incompatible with Apache-2.0",
};

function classifyId(raw) {
  let id = String(raw || "").trim();
  if (!id) return "unknown";
  const alias = ALIASES[id.toLowerCase()];
  if (alias) id = alias;
  const lower = id.toLowerCase();
  if (lower === "unlicensed" || lower.startsWith("see license")) {
    return lower === "unlicensed" ? "denied" : "unknown";
  }
  if (/^(a)?gpl/.test(lower)) return "denied";
  if (/sspl|^busl|business source|commons[ -]clause/.test(lower)) {
    return "denied";
  }
  if (/^(lgpl|mpl)/.test(lower)) return "review";
  if (ALLOWED.has(lower) || /^bsd-/.test(lower)) return "allowed";
  return "review";
}

// Evaluates an SPDX expression: OR picks the most permissive choice, AND
// the most restrictive. "X WITH exception" is judged as X.
function classifyExpression(expr) {
  const text = String(expr || "").trim();
  if (!text) return "unknown";
  if (/commons[ -]clause/i.test(text)) return "denied";
  if (/^see license/i.test(text)) return "unknown";
  const tokens = text
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean);
  let pos = 0;
  const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
  const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);
  function primary() {
    if (tokens[pos] === "(") {
      pos++;
      const inner = orExpr();
      if (tokens[pos] === ")") pos++;
      return inner;
    }
    const words = [];
    while (
      pos < tokens.length &&
      !["(", ")"].includes(tokens[pos]) &&
      !/^(and|or)$/i.test(tokens[pos])
    ) {
      words.push(tokens[pos]);
      pos++;
    }
    const withAt = words.findIndex((w) => /^with$/i.test(w));
    const id = (withAt === -1 ? words : words.slice(0, withAt)).join(" ");
    return classifyId(id.replace(/\+$/, ""));
  }
  function andExpr() {
    let result = primary();
    while (/^and$/i.test(tokens[pos] || "")) {
      pos++;
      result = worst(result, primary());
    }
    return result;
  }
  function orExpr() {
    let result = andExpr();
    while (/^or$/i.test(tokens[pos] || "")) {
      pos++;
      result = best(result, andExpr());
    }
    return result;
  }
  return orExpr();
}

function licenseFromManifest(pkg) {
  if (!pkg) return "";
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") {
    return pkg.license.type;
  }
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses
      .map((l) => (typeof l === "string" ? l : l && l.type))
      .filter(Boolean)
      .join(" OR ");
  }
  return "";
}

// yarn v1 lockfile -> Map("name@version" -> { name, version }). The real
// package name comes from the resolved tarball URL so npm: aliases resolve
// to the package that is actually installed.
function parseLockfile(text) {
  const entries = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*:$/.test(line) && !line.startsWith("#")) {
      const first = line.slice(0, -1).split(",")[0].trim().replace(/"/g, "");
      const at = first.lastIndexOf("@");
      current = { name: at > 0 ? first.slice(0, at) : first, version: "" };
      continue;
    }
    if (!current) continue;
    let m = line.match(/^ {2}version "?([^"\s]+)"?$/);
    if (m) {
      current.version = m[1];
      continue;
    }
    m = line.match(/^ {2}resolved "?([^"\s]+)"?$/);
    if (m) {
      const real = m[1].match(/^https?:\/\/[^/]+\/(.+?)\/-\//);
      if (real) current.name = decodeURIComponent(real[1]);
      if (current.version) {
        entries.set(`${current.name}@${current.version}`, {
          name: current.name,
          version: current.version,
        });
      }
      current = null;
    }
  }
  return entries;
}

// Every installed package.json under node_modules (including nested trees).
function installedLicenses() {
  const found = new Map();
  const stack = [path.join(ROOT, "node_modules")];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (name.startsWith("@")) {
        stack.push(full);
        continue;
      }
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(full, "package.json"), "utf8"),
        );
        if (pkg.name && pkg.version) {
          found.set(`${pkg.name}@${pkg.version}`, licenseFromManifest(pkg));
        }
      } catch {
        // not a package directory
      }
      stack.push(path.join(full, "node_modules"));
    }
  }
  return found;
}

async function registryLicense(name, version) {
  const encoded = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  const url = `${REGISTRY}${encoded}/${encodeURIComponent(version)}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return "";
    return licenseFromManifest(await res.json());
  } catch {
    return "";
  }
}

function loadExceptions() {
  const file = path.join(ROOT, ".github", "license-exceptions.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function checkRepoLicense() {
  const problems = [];
  const file = ["LICENSE.md", "LICENSE"]
    .map((f) => path.join(ROOT, f))
    .find((f) => fs.existsSync(f));
  if (!file) {
    problems.push("No LICENSE.md or LICENSE file at the repository root.");
  } else {
    const text = fs.readFileSync(file, "utf8");
    if (!/Apache License/i.test(text) || !/Version 2\.0/i.test(text)) {
      problems.push(
        `${path.basename(file)} is no longer the Apache License, Version 2.0.`,
      );
    }
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  if (pkg.license !== "Apache-2.0") {
    problems.push(
      `package.json "license" is ${JSON.stringify(pkg.license)}, expected "Apache-2.0".`,
    );
  }
  return problems;
}

function escapeCell(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

async function main() {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf("--base-lockfile");
  const basePath = baseAt === -1 ? null : args[baseAt + 1];
  const repoLicense = args.includes("--repo-license");

  const head = parseLockfile(
    fs.readFileSync(path.join(ROOT, "yarn.lock"), "utf8"),
  );
  let targets = [...head.values()];
  let scope = `all ${targets.length} packages in yarn.lock`;
  if (basePath) {
    const base = fs.existsSync(basePath)
      ? parseLockfile(fs.readFileSync(basePath, "utf8"))
      : new Map();
    targets = targets.filter((e) => !base.has(`${e.name}@${e.version}`));
    scope = `${targets.length} package(s) new compared with the base branch`;
  }

  const installed = installedLicenses();
  const exceptions = loadExceptions();
  const results = [];
  const queue = targets.slice();
  async function worker() {
    while (queue.length) {
      const e = queue.shift();
      const key = `${e.name}@${e.version}`;
      let license = installed.get(key);
      let source = "node_modules";
      if (license === undefined) {
        license = await registryLicense(e.name, e.version);
        source = "npm registry";
      }
      let verdict = classifyExpression(license);
      let note = "";
      const exception = exceptions[key] || exceptions[e.name];
      if (verdict !== "allowed" && exception) {
        note = `accepted by exception: ${exception}`;
        verdict = "allowed";
      }
      results.push({ key, license, source, verdict, note });
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  results.sort((a, b) => a.key.localeCompare(b.key));

  const problems = results.filter((r) => r.verdict !== "allowed");
  const repoProblems = repoLicense ? checkRepoLicense() : [];

  const summary = [];
  summary.push("### Dependency license check");
  summary.push("");
  summary.push(`Checked ${scope}.`);
  summary.push("");
  if (problems.length) {
    summary.push(
      "| Package | License | Verdict | Read from |",
      "| --- | --- | --- | --- |",
    );
    for (const r of problems) {
      summary.push(
        `| \`${escapeCell(r.key)}\` | ${escapeCell(r.license || "(none)")} | ${LABEL[r.verdict]} | ${r.source} |`,
      );
    }
    summary.push("");
    summary.push(
      "Denied and unknown licenses must not ship in an Apache-2.0 project. " +
        '"Needs review" (LGPL, MPL and anything not on the allow list) means a ' +
        "maintainer has to decide; once accepted, add the package to " +
        "`.github/license-exceptions.json` with the reason.",
    );
  } else {
    summary.push("All checked packages have an allowed license.");
  }
  const accepted = results.filter((r) => r.note);
  if (accepted.length) {
    summary.push("", "Accepted by exception:");
    for (const r of accepted) {
      summary.push(`- \`${escapeCell(r.key)}\`: ${escapeCell(r.note)}`);
    }
  }
  if (repoLicense) {
    summary.push("", "### Repository license");
    summary.push("");
    summary.push(
      repoProblems.length
        ? repoProblems.map((p) => `- ${p}`).join("\n")
        : "LICENSE.md and package.json are Apache-2.0.",
    );
  }
  const text = summary.join("\n") + "\n";
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
  if (process.env.GITHUB_ACTIONS) {
    for (const r of problems) {
      process.stdout.write(
        `::error title=License ${LABEL[r.verdict]}::${r.key} is licensed "${r.license || "(none)"}" (${LABEL[r.verdict]}).\n`,
      );
    }
    for (const p of repoProblems) {
      process.stdout.write(`::error title=Repository license::${p}\n`);
    }
  }
  if (problems.length || repoProblems.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`license-check: ${err && err.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = { classifyExpression, parseLockfile };
