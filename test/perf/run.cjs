#!/usr/bin/env node
"use strict";

// Perf + memory regression harness. See test/perf/README.md.
//
//   node test/perf/run.cjs <command> [options]
//
// commands
//   all         memory + load + outline on one fixture (default)
//   memory      reader and editor navigation churn, then idle
//   lighthouse  cold page loads, phone and desktop (+ Lighthouse when installed)
//   outline     open the outline designer as an editor
//   scale       the above at several site sizes, with a growth report
//   site        just build the fixture site (on --base-url, to keep it)
//
// options
//   --short           quick profile (fewer visits, one load run)
//   --size <n>        fixture page count (default 500)
//   --sizes <a,b,c>   sizes for `scale` (default 100,500,1000)
//   --check           compare against test/perf/budgets.json, exit 1 on regression
//   --out <file>      results JSON (default test/perf/results/<command>-<profile>.json)
//   --report <file>   markdown report (default: next to the JSON)
//   --base-url <url>  use a running server instead of booting an isolated one;
//                     credentials come from HAXCMS_PERF_USERNAME (default admin)
//                     and HAXCMS_PERF_PASSWORD
//
// Without --base-url the harness boots the same isolated server the e2e suite
// uses (temp HAXCMS_ROOT, ephemeral port, real auth) and builds fixture sites
// in it. To measure the webcomponents monorepo instead of the bundled front
// end: NODE_ENV=development HAXCMS_WEBCOMPONENTS_ROOT=../webcomponents.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const minimist = require("minimist");
const {
  budgetsForProfile,
  compareToBudgets,
  formatReport,
  median,
  selectBudgets,
} = require("./budgets.cjs");
const { ensureFixtureSite } = require("./fixture.cjs");
const { runMemoryScenario } = require("./memory.cjs");
const { runLighthouse, runLoadScenario } = require("./load.cjs");
const { runOutlineScenario } = require("./outline.cjs");
const { formatResultsMarkdown, formatScaleMarkdown } = require("./report.cjs");

const PERF_DIR = __dirname;
const REPO_ROOT = path.join(__dirname, "..", "..");

// What each profile runs. Per-visit metrics don't depend on the visit count,
// so short and full share the 500 page fixture; short just does less of it.
const PROFILES = {
  full: {
    reader: { visits: 240, idleSeconds: 60 },
    editor: { visits: 100, idleSeconds: 30 },
    loadRuns: 3,
    formFactors: ["mobile", "desktop"],
    pages: ["home", "deep"],
  },
  short: {
    reader: { visits: 40, idleSeconds: 15 },
    editor: { visits: 20, idleSeconds: 10 },
    loadRuns: 1,
    formFactors: ["mobile"],
    pages: ["deep"],
  },
  // per size in a `scale` run: what grows with page count, kept quick
  scale: {
    reader: { visits: 40, idleSeconds: 5 },
    editor: null,
    loadRuns: 1,
    formFactors: ["mobile", "desktop"],
    pages: ["deep"],
  },
};

const DEFAULT_SIZE = 500;
const DEFAULT_SCALE_SIZES = [100, 500, 1000];
const COMMANDS = ["all", "memory", "lighthouse", "outline", "scale", "site"];

function log(message) {
  process.stdout.write("[perf] " + message + "\n");
}

function frontEndVersion() {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.HAXCMS_WEBCOMPONENTS_ROOT
  ) {
    return "linked:" + path.resolve(process.env.HAXCMS_WEBCOMPONENTS_ROOT);
  }
  try {
    const pkg = path.join(
      REPO_ROOT,
      "src/public/build/es6/node_modules/@haxtheweb/haxcms-elements/package.json",
    );
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch (e) {
    return "unknown";
  }
}

function pageUrl(baseUrl, fixture, which) {
  const siteBase = baseUrl + "/_sites/" + fixture.name + "/";
  if (which === "home") {
    return siteBase;
  }
  // a page at the bottom of the outline: deepest menu state, last module
  const deep = fixture.items.filter(function (item) {
    return item.indent >= 2;
  });
  const target = deep.length
    ? deep[deep.length - 1]
    : fixture.items[fixture.items.length - 1];
  return siteBase + target.slug;
}

async function startServer(argv) {
  if (argv["base-url"]) {
    const password = process.env.HAXCMS_PERF_PASSWORD;
    if (!password) {
      throw new Error(
        "--base-url needs HAXCMS_PERF_PASSWORD in the environment",
      );
    }
    return {
      baseUrl: String(argv["base-url"]).replace(/\/+$/, ""),
      credentials: {
        username: process.env.HAXCMS_PERF_USERNAME || "admin",
        password: password,
      },
      stop: async function () {},
    };
  }
  // the e2e harness owns isolated server boot (temp root, real auth)
  const harness = require("../e2e/helpers/harness.cjs");
  const runtime = await harness.setupE2ERuntime();
  return {
    baseUrl: runtime.baseUrl,
    credentials: runtime.credentials,
    stop: async function () {
      await harness.teardownE2ERuntime(runtime);
    },
  };
}

async function runMemory(browser, server, fixture, profile, scenarios) {
  log(
    "memory: reader, " +
      profile.reader.visits +
      " visits (" +
      fixture.name +
      ")",
  );
  scenarios["reader." + fixture.name] = await runMemoryScenario(browser, {
    baseUrl: server.baseUrl,
    site: fixture.name,
    items: fixture.items,
    visits: profile.reader.visits,
    idleSeconds: profile.reader.idleSeconds,
    editor: false,
  });
  if (!profile.editor) {
    return;
  }
  log(
    "memory: editor, " + profile.editor.visits + " visits, edit mode every 5th",
  );
  scenarios["editor." + fixture.name] = await runMemoryScenario(browser, {
    baseUrl: server.baseUrl,
    site: fixture.name,
    items: fixture.items,
    visits: profile.editor.visits,
    idleSeconds: profile.editor.idleSeconds,
    editor: true,
    credentials: server.credentials,
  });
}

async function runLoad(
  browser,
  executablePath,
  server,
  fixture,
  profile,
  scenarios,
  meta,
) {
  for (let f = 0; f < profile.formFactors.length; f++) {
    for (let p = 0; p < profile.pages.length; p++) {
      const formFactor = profile.formFactors[f];
      const which = profile.pages[p];
      const url = pageUrl(server.baseUrl, fixture, which);
      const key = formFactor + "." + which + "." + fixture.name;
      log("load: " + key + " (" + profile.loadRuns + " run(s))");
      const lab = await runLoadScenario(browser, {
        url: url,
        formFactor: formFactor,
        runs: profile.loadRuns,
      });
      const lighthouse = await runLighthouse(executablePath, {
        url: url,
        formFactor: formFactor,
        runs: profile.loadRuns,
      });
      meta.lighthouse = lighthouse !== null;
      scenarios[key] = Object.assign(lab, lighthouse || {});
    }
  }
}

async function runOutline(browser, server, fixture, scenarios) {
  log("outline: open outline designer (" + fixture.name + ")");
  scenarios["outline." + fixture.name] = await runOutlineScenario(browser, {
    baseUrl: server.baseUrl,
    site: fixture.name,
    items: fixture.items,
    credentials: server.credentials,
  });
}

// What the server hands every visitor, before any script runs: site.json
// (raw and gzip) and the server-rendered HTML of the deep page.
async function runSiteMetrics(server, fixture, scenarios) {
  const siteJsonUrl = server.baseUrl + "/_sites/" + fixture.name + "/site.json";
  const timed = async function (url, gzip) {
    const times = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        decompress: !gzip,
        headers: { "Accept-Encoding": gzip ? "gzip" : "identity" },
        validateStatus: () => true,
      });
      times.push(Date.now() - started);
      if (response.status !== 200) {
        throw new Error("GET " + url + " returned " + response.status);
      }
      bytes = response.data.byteLength;
    }
    return { kb: Math.round((bytes / 1024) * 10) / 10, ms: median(times) };
  };
  const raw = await timed(siteJsonUrl, false);
  const gz = await timed(siteJsonUrl, true);
  const html = await timed(pageUrl(server.baseUrl, fixture, "deep"), false);
  scenarios["site." + fixture.name] = Object.assign(
    // server time to build the site through the API (fresh fixtures only)
    typeof fixture.createSeconds === "number"
      ? { createSeconds: fixture.createSeconds }
      : {},
    {
      siteJsonKB: raw.kb,
      siteJsonGzipKB: gz.kb,
      siteJsonMs: raw.ms,
      pageHtmlKB: html.kb,
      pageHtmlMs: html.ms,
    },
  );
}

function parseSizes(value) {
  const sizes = String(value || "")
    .split(",")
    .map(function (v) {
      return parseInt(v.trim(), 10);
    })
    .filter(function (v) {
      return v > 0;
    });
  return sizes.length ? sizes : DEFAULT_SCALE_SIZES.slice();
}

function writeOutputs(argv, command, profileName, results, markdown) {
  const out = argv.out
    ? path.resolve(argv.out)
    : path.join(PERF_DIR, "results", command + "-" + profileName + ".json");
  const report = argv.report
    ? path.resolve(argv.report)
    : out.replace(/\.json$/, "") + ".md";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
  fs.writeFileSync(report, markdown);
  log("results: " + out);
  log("report: " + report);
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    boolean: ["short", "check", "help"],
    string: ["out", "report", "base-url", "sizes", "size"],
  });
  const command = argv._[0] || "all";
  if (argv.help || COMMANDS.indexOf(command) === -1) {
    process.stdout.write(
      "usage: node test/perf/run.cjs <" +
        COMMANDS.join("|") +
        "> [--short] [--size n] [--sizes a,b,c] [--check] [--out file] [--report file] [--base-url url]\n",
    );
    return argv.help ? 0 : 2;
  }
  const size = argv.size ? parseInt(argv.size, 10) : DEFAULT_SIZE;
  const sizes = command === "scale" ? parseSizes(argv.sizes) : [size];
  let profileName = argv.short ? "short" : "full";
  if (command === "scale") {
    profileName = "scale";
  }
  const profile = PROFILES[profileName];
  const started = Date.now();
  const server = await startServer(argv);
  let browser = null;
  try {
    const fixtures = [];
    for (let i = 0; i < sizes.length; i++) {
      const name = "perf" + sizes[i];
      log("fixture " + name + " on " + server.baseUrl);
      const fixtureStarted = Date.now();
      const fixture = await ensureFixtureSite(
        server.baseUrl,
        server.credentials,
        name,
      );
      if (!fixture.reused) {
        fixture.createSeconds =
          Math.round((Date.now() - fixtureStarted) / 100) / 10;
      }
      log(
        "fixture ready: " +
          fixture.items.length +
          " items" +
          (fixture.reused
            ? " (reused)"
            : " in " + Math.round((Date.now() - fixtureStarted) / 1000) + " s"),
      );
      fixtures.push(fixture);
    }
    if (command === "site") {
      return 0;
    }
    // e2e browser helper: system Chrome via puppeteer-core
    const browserHelpers = require("../e2e/helpers/browser.cjs");
    const executablePath = browserHelpers.findChromeExecutable();
    browser = await browserHelpers.launchBrowser();
    const meta = {
      command: command,
      profile: profileName,
      startedAt: new Date(started).toISOString(),
      node: process.version,
      chrome: await browser.version(),
      frontEnd: frontEndVersion(),
      fixtures: fixtures.map(function (f) {
        return f.name;
      }),
      lighthouse: false,
    };
    const scenarios = {};
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i];
      if (command === "scale" || command === "all") {
        await runSiteMetrics(server, fixture, scenarios);
      }
      if (command === "memory" || command === "all" || command === "scale") {
        await runMemory(browser, server, fixture, profile, scenarios);
      }
      if (
        command === "lighthouse" ||
        command === "all" ||
        command === "scale"
      ) {
        await runLoad(
          browser,
          executablePath,
          server,
          fixture,
          profile,
          scenarios,
          meta,
        );
      }
      if (command === "outline" || command === "all" || command === "scale") {
        await runOutline(browser, server, fixture, scenarios);
      }
    }
    if (
      !meta.lighthouse &&
      (command === "lighthouse" || command === "all" || command === "scale")
    ) {
      log(
        "lighthouse not installed: lab metrics only (npm i --no-save lighthouse for scores)",
      );
    }
    meta.durationS = Math.round((Date.now() - started) / 1000);
    const results = { meta: meta, scenarios: scenarios };
    if (command === "scale") {
      results.sizes = sizes;
    }
    const markdown =
      command === "scale"
        ? formatScaleMarkdown(results)
        : formatResultsMarkdown(results);
    writeOutputs(argv, command, profileName, results, markdown);
    Object.keys(scenarios).forEach(function (name) {
      log(name + " " + JSON.stringify(scenarios[name]));
    });
    if (argv.check) {
      if (command === "scale") {
        log("--check is for fixed-size runs; scale runs only report");
        return 0;
      }
      const file = JSON.parse(
        fs.readFileSync(path.join(PERF_DIR, "budgets.json"), "utf8"),
      );
      const budgets = budgetsForProfile(file, profileName);
      const report = compareToBudgets(results, {
        tolerance: budgets.tolerance,
        metrics: selectBudgets(
          budgets.metrics,
          command,
          meta.lighthouse,
          "perf" + size,
        ),
      });
      process.stdout.write(formatReport(report) + "\n");
      return report.pass ? 0 : 1;
    }
    return 0;
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.stop();
  }
}

main()
  .then(function (code) {
    process.exit(code);
  })
  .catch(function (err) {
    process.stderr.write(
      "[perf] failed: " + (err && err.stack ? err.stack : err) + "\n",
    );
    process.exit(1);
  });
