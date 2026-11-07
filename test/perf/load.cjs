"use strict";

// Page load on a throttled phone and on desktop. Two layers:
//
// 1. Lab metrics read straight from Chrome (always available): LCP, FCP,
//    blocking time (long tasks after FCP, minus 50ms each), requests,
//    transferred KB, elements (including shadow roots) and JS heap. Median
//    of N runs, each in a fresh browser context (cold cache).
// 2. Lighthouse performance score, when the `lighthouse` package can be
//    loaded. It is not a dependency of this repo (it is large). Install it
//    anywhere and point at it, the way CI does:
//      npm install --prefix /tmp/lh lighthouse@13
//      HAXCMS_PERF_LIGHTHOUSE_DIR=/tmp/lh npm run perf:lighthouse
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const path = require("path");
const { pathToFileURL } = require("url");
const puppeteer = require("puppeteer-core");
const { median } = require("./budgets.cjs");

// Matches Lighthouse's mobile defaults (Moto G Power class device on slow 4G)
// closely enough to rank changes; absolute numbers will differ from PSI.
const PROFILES = {
  mobile: {
    viewport: {
      width: 412,
      height: 823,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1.75,
    },
    network: {
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    },
    cpuRate: 4,
  },
  desktop: {
    viewport: {
      width: 1350,
      height: 940,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    },
    network: {
      latency: 40,
      downloadThroughput: (10 * 1024 * 1024) / 8,
      uploadThroughput: (10 * 1024 * 1024) / 8,
    },
    cpuRate: 1,
  },
};

const LOAD_PROBES = function () {
  globalThis.__perfLcp = 0;
  globalThis.__perfLongTasks = [];
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        globalThis.__perfLcp = entry.startTime;
      });
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        globalThis.__perfLongTasks.push([entry.startTime, entry.duration]);
      });
    }).observe({ type: "longtask", buffered: true });
  } catch (e) {
    // older engines: metrics read as 0
  }
};

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function measureOnce(browser, url, profile) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setViewport(profile.viewport);
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "light" },
    ]);
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send(
      "Network.emulateNetworkConditions",
      Object.assign({ offline: false }, profile.network),
    );
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuRate });
    let requests = 0;
    let bytes = 0;
    cdp.on("Network.loadingFinished", function (event) {
      requests++;
      bytes += event.encodedDataLength || 0;
    });
    await page.evaluateOnNewDocument(LOAD_PROBES);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 240000 });
    await wait(3000);
    const timings = await page.evaluate(function () {
      const fcpEntry = performance.getEntriesByName(
        "first-contentful-paint",
      )[0];
      const fcp = fcpEntry ? fcpEntry.startTime : 0;
      let blocking = 0;
      globalThis.__perfLongTasks.forEach(function (task) {
        if (task[0] + task[1] > fcp) {
          blocking += Math.max(0, task[1] - 50);
        }
      });
      // count elements, including inside open shadow roots
      let elements = 0;
      const walk = function (root) {
        const all = root.querySelectorAll("*");
        elements += all.length;
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            walk(all[i].shadowRoot);
          }
        }
      };
      walk(document);
      return {
        lcp: globalThis.__perfLcp,
        fcp: fcp,
        blocking: blocking,
        elements: elements,
      };
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const metrics = await page.metrics();
    return {
      lcpMs: Math.round(timings.lcp),
      fcpMs: Math.round(timings.fcp),
      blockingMs: Math.round(timings.blocking),
      requests: requests,
      transferKB: Math.round(bytes / 1024),
      elements: timings.elements,
      heapMB: Math.round((metrics.JSHeapUsedSize / 1048576) * 10) / 10,
    };
  } finally {
    await context.close();
  }
}

/**
 * Median lab metrics over `runs` cold loads.
 * @param {object} browser puppeteer browser
 * @param {object} opts { url, formFactor: "mobile"|"desktop", runs }
 */
async function runLoadScenario(browser, opts) {
  const profile = PROFILES[opts.formFactor];
  if (!profile) {
    throw new Error("unknown form factor: " + opts.formFactor);
  }
  const rows = [];
  for (let i = 0; i < opts.runs; i++) {
    rows.push(await measureOnce(browser, opts.url, profile));
  }
  const out = { runs: rows.length };
  Object.keys(rows[0]).forEach(function (key) {
    out[key] = median(
      rows.map(function (r) {
        return r[key];
      }),
    );
  });
  return out;
}

// Resolve a lighthouse module from HAXCMS_PERF_LIGHTHOUSE_DIR, else from
// this repo's node_modules. Null when neither has it.
function resolveLighthouse(request) {
  const dirs = [];
  if (process.env.HAXCMS_PERF_LIGHTHOUSE_DIR) {
    dirs.push(path.resolve(process.env.HAXCMS_PERF_LIGHTHOUSE_DIR));
  }
  dirs.push(__dirname);
  for (let i = 0; i < dirs.length; i++) {
    try {
      return require.resolve(request, { paths: [dirs[i]] });
    } catch (e) {
      // try the next location
    }
  }
  return null;
}

async function importResolved(request) {
  const resolved = resolveLighthouse(request);
  if (!resolved) {
    return null;
  }
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default || mod;
}

async function loadLighthouse() {
  try {
    return await importResolved("lighthouse");
  } catch (e) {
    return null;
  }
}

/**
 * Median Lighthouse performance score (0-100) over `runs`, or null when the
 * lighthouse package is not installed. Each run gets its own Chrome so runs
 * don't share a cache.
 * @param {string} executablePath Chrome binary
 * @param {object} opts { url, formFactor, runs }
 */
async function runLighthouse(executablePath, opts) {
  const lighthouse = await loadLighthouse();
  if (!lighthouse) {
    return null;
  }
  let config;
  if (opts.formFactor === "desktop") {
    config = await importResolved("lighthouse/core/config/desktop-config.js");
  }
  const scores = [];
  const lcps = [];
  const tbts = [];
  for (let i = 0; i < opts.runs; i++) {
    const browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--remote-debugging-port=0",
      ],
    });
    try {
      const port = Number(new URL(browser.wsEndpoint()).port);
      const result = await lighthouse(
        opts.url,
        {
          port: port,
          output: "json",
          logLevel: "error",
          onlyCategories: ["performance"],
        },
        config,
      );
      const lhr = result && result.lhr;
      if (lhr && lhr.categories && lhr.categories.performance) {
        scores.push(Math.round(lhr.categories.performance.score * 100));
        const audits = lhr.audits || {};
        if (audits["largest-contentful-paint"]) {
          lcps.push(audits["largest-contentful-paint"].numericValue);
        }
        if (audits["total-blocking-time"]) {
          tbts.push(audits["total-blocking-time"].numericValue);
        }
      }
    } finally {
      await browser.close();
    }
  }
  if (scores.length === 0) {
    return null;
  }
  return {
    lighthouseScore: median(scores),
    lighthouseLcpMs: Math.round(median(lcps) || 0),
    lighthouseTbtMs: Math.round(median(tbts) || 0),
  };
}

module.exports = {
  PROFILES,
  resolveLighthouse,
  runLighthouse,
  runLoadScenario,
};
