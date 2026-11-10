#!/usr/bin/env node
"use strict";

// Outline designer fuzzer CLI. See test/fuzz/README.md.
//
//   node test/fuzz/run.cjs [options]
//
//   --seeds <a,b,c|a-b>  seeds to run (default 1-3); same seed, same edits
//   --ops <n>            edits per session (default 200)
//   --save-every <n>     save + check every n edits (default 20)
//   --size <n>           pages in the starting outline (default 60)
//   --replay <file>      replay the exact edits from a failure report
//   --no-shrink          report a failure without shrinking it
//   --base-url <url>     use a running server (HAXCMS_PERF_PASSWORD, and
//                        HAXCMS_PERF_USERNAME default admin); page file
//                        checks are skipped since the site directory is not
//                        known
//
// Without --base-url it boots the isolated e2e server. Each session gets a
// fresh copy of the seeded perf<size> outline. A failure writes
// test/fuzz/results/outline-<seed>.json with the edits that led to it and,
// unless --no-shrink, a shrunk minimal list that still fails.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const fs = require("fs");
const path = require("path");
const minimist = require("minimist");
const { createFixtureSite } = require("../perf/fixture.cjs");
const { runOutlineFuzz } = require("./outline-designer.cjs");

const RESULTS_DIR = path.join(__dirname, "results");
const MAX_SHRINK_RUNS = 40;

function log(message) {
  process.stdout.write("[fuzz] " + message + "\n");
}

function parseSeeds(value) {
  const text = String(value || "1-3");
  const seeds = [];
  text.split(",").forEach(function (part) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    if (range) {
      for (let s = parseInt(range[1], 10); s <= parseInt(range[2], 10); s++) {
        seeds.push(s);
      }
    } else if (/^\d+$/.test(part.trim())) {
      seeds.push(parseInt(part.trim(), 10));
    }
  });
  return seeds;
}

// ddmin-style shrink: drop chunks of edits while the failure still happens
async function shrink(steps, stillFails) {
  let current = steps.slice();
  let chunk = Math.max(1, Math.floor(current.length / 2));
  let runs = 0;
  while (chunk >= 1 && runs < MAX_SHRINK_RUNS) {
    let removed = false;
    for (
      let start = 0;
      start < current.length && runs < MAX_SHRINK_RUNS;
      start += chunk
    ) {
      const candidate = current
        .slice(0, start)
        .concat(current.slice(start + chunk));
      if (candidate.length === 0) {
        continue;
      }
      runs++;
      if (await stillFails(candidate)) {
        current = candidate;
        removed = true;
        start -= chunk;
      }
    }
    if (!removed) {
      if (chunk === 1) {
        break;
      }
      chunk = Math.floor(chunk / 2);
    }
  }
  return { steps: current, runs: runs };
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    boolean: ["shrink", "help"],
    string: ["seeds", "base-url", "replay"],
    default: { shrink: true },
  });
  if (argv.help) {
    process.stdout.write(
      "usage: node test/fuzz/run.cjs [--seeds 1-3] [--ops 200] [--save-every 20] [--size 60] [--replay file] [--no-shrink] [--base-url url]\n",
    );
    return 0;
  }
  const ops = parseInt(argv.ops || 200, 10);
  const saveEvery = parseInt(argv["save-every"] || 20, 10);
  const size = parseInt(argv.size || 60, 10);
  const replay = argv.replay
    ? JSON.parse(fs.readFileSync(path.resolve(argv.replay), "utf8"))
    : null;
  const seeds = replay ? [replay.seed] : parseSeeds(argv.seeds);

  let server;
  if (argv["base-url"]) {
    if (!process.env.HAXCMS_PERF_PASSWORD) {
      throw new Error(
        "--base-url needs HAXCMS_PERF_PASSWORD in the environment",
      );
    }
    server = {
      baseUrl: String(argv["base-url"]).replace(/\/+$/, ""),
      credentials: {
        username: process.env.HAXCMS_PERF_USERNAME || "admin",
        password: process.env.HAXCMS_PERF_PASSWORD,
      },
      siteRoot: null,
      stop: async function () {},
    };
  } else {
    const harness = require("../e2e/helpers/harness.cjs");
    const runtime = await harness.setupE2ERuntime();
    server = {
      baseUrl: runtime.baseUrl,
      credentials: runtime.credentials,
      siteRoot: path.join(runtime.runtimeRoot, "_sites"),
      stop: async function () {
        await harness.teardownE2ERuntime(runtime);
      },
    };
  }
  const browserHelpers = require("../e2e/helpers/browser.cjs");
  const browser = await browserHelpers.launchBrowser();
  let copies = 0;
  // a fresh copy of the seeded outline for every session and replay
  const freshSite = async function (seed) {
    copies++;
    const siteName = "fuzz-" + seed + "-" + copies;
    await createFixtureSite(
      server.baseUrl,
      server.credentials,
      "perf" + size,
      siteName,
    );
    return siteName;
  };
  const session = async function (seed, steps) {
    const site = await freshSite(seed);
    return runOutlineFuzz(browser, {
      baseUrl: server.baseUrl,
      site: site,
      credentials: server.credentials,
      siteDirectory: server.siteRoot ? path.join(server.siteRoot, site) : null,
      seed: seed,
      ops: ops,
      saveEvery: saveEvery,
      steps: steps,
    });
  };
  let failures = 0;
  try {
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const started = Date.now();
      const result = await session(
        seed,
        replay ? replay.minimal || replay.steps : null,
      );
      const took = Math.round((Date.now() - started) / 1000);
      if (result.ok) {
        log(
          "seed " +
            seed +
            ": ok, " +
            result.applied +
            "/" +
            result.steps.length +
            " edits applied, " +
            result.saves +
            " saves checked (" +
            took +
            " s)",
        );
        continue;
      }
      failures++;
      log(
        "seed " +
          seed +
          ": FAILED after edit " +
          result.at +
          ": " +
          result.failure,
      );
      const report = {
        seed: seed,
        size: size,
        saveEvery: saveEvery,
        failure: result.failure,
        at: result.at,
        steps: result.steps.slice(0, result.at),
      };
      if (argv.shrink && !replay) {
        log("shrinking " + report.steps.length + " edits...");
        const shrunk = await shrink(report.steps, async function (candidate) {
          const again = await session(seed, candidate);
          return !again.ok && !again.harnessError;
        });
        report.minimal = shrunk.steps;
        log(
          "minimal failing edit list: " +
            shrunk.steps.length +
            " edits (" +
            shrunk.runs +
            " replays)",
        );
        shrunk.steps.forEach(function (step) {
          log("  " + JSON.stringify(step));
        });
      }
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const out = path.join(RESULTS_DIR, "outline-" + seed + ".json");
      fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
      log(
        "report: " +
          out +
          " (replay: node test/fuzz/run.cjs --replay " +
          path.relative(process.cwd(), out) +
          ")",
      );
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  return failures ? 1 : 0;
}

main()
  .then(function (code) {
    process.exit(code);
  })
  .catch(function (err) {
    process.stderr.write(
      "[fuzz] failed: " + (err && err.stack ? err.stack : err) + "\n",
    );
    process.exit(1);
  });
