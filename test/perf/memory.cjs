"use strict";

// Memory over a long session: navigate client-side through a site (the way
// the router does when a link is clicked), optionally entering and leaving
// edit mode, then sit idle. GC is forced before every sample, so what grows
// is what stays reachable.
//
// Per-visit growth is the regression signal; an idle tab must stay flat:
//   heapKBPerVisit, nodesPerVisit, listenersPerVisit
//   reactionsPerVisit   MobX reactions created during the run and still live
//   detachedObserved    Resize/Intersection observer targets that left the
//                       document but are still observed (keeps them alive)
//   i18nDeadEntries     i18n-manager registrations whose element is gone
//   idleRequests        fetches made while the tab sat idle
//   idleTimers          timer + animation frame callbacks fired while idle
//   idleGrowthKB        heap growth while idle
//   navMsMedian         click to content in the store, median per visit
//   navTimeouts         visits whose content never arrived (should be 0)
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const { median, perVisit } = require("./budgets.cjs");

const WARMUP_VISITS = 10;

// Installed before any app script runs.
const PAGE_PROBES = function () {
  const reg = [];
  globalThis.__perfObserverRegistry = reg;
  ["ResizeObserver", "IntersectionObserver"].forEach(function (name) {
    const proto = globalThis[name] && globalThis[name].prototype;
    if (!proto) {
      return;
    }
    const observe = proto.observe;
    const unobserve = proto.unobserve;
    const disconnect = proto.disconnect;
    proto.observe = function (target) {
      if (!this.__perfTargets) {
        this.__perfTargets = new Set();
        reg.push(new WeakRef(this));
      }
      this.__perfTargets.add(new WeakRef(target));
      return observe.apply(this, arguments);
    };
    proto.unobserve = function (target) {
      const targets = this.__perfTargets;
      if (targets) {
        targets.forEach(function (ref) {
          if (ref.deref() === target) {
            targets.delete(ref);
          }
        });
      }
      return unobserve.apply(this, arguments);
    };
    proto.disconnect = function () {
      if (this.__perfTargets) {
        this.__perfTargets.clear();
      }
      return disconnect.apply(this, arguments);
    };
  });
  globalThis.__perfFetches = 0;
  const fetchFn = globalThis.fetch;
  globalThis.fetch = function () {
    globalThis.__perfFetches++;
    return fetchFn.apply(this, arguments);
  };
  // count timer and animation-frame callbacks as they fire, so an interval
  // started long before the idle window still shows up as idle work
  globalThis.__perfTimers = 0;
  const counted = function (fn) {
    if (typeof fn !== "function") {
      return fn;
    }
    return function () {
      globalThis.__perfTimers++;
      return fn.apply(this, arguments);
    };
  };
  ["setTimeout", "setInterval", "requestAnimationFrame"].forEach(
    function (name) {
      const original = globalThis[name];
      if (typeof original !== "function") {
        return;
      }
      globalThis[name] = function (fn) {
        const args = Array.prototype.slice.call(arguments);
        args[0] = counted(fn);
        return original.apply(globalThis, args);
      };
    },
  );
};

// Count MobX reactions: each one is recorded the first time it schedules.
// Long-lived reactions from boot that react to navigation are recorded
// during warmup, so growth after the start sample is reactions created (and
// never disposed) by the measured visits.
async function hookReactions(page) {
  await page.evaluate(async function () {
    const mobx = await import("./build/es6/node_modules/mobx/dist/mobx.esm.js");
    globalThis.__perfReactions = [];
    const schedule = mobx.Reaction.prototype.schedule_;
    mobx.Reaction.prototype.schedule_ = function () {
      if (!this.__perfSeen) {
        this.__perfSeen = true;
        globalThis.__perfReactions.push(new WeakRef(this));
      }
      return schedule.call(this);
    };
  });
}

async function sample(page, cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const metrics = await page.metrics();
  const probes = await page.evaluate(function () {
    let reactions = 0;
    (globalThis.__perfReactions || []).forEach(function (ref) {
      const r = ref.deref();
      if (r && !r.isDisposed_ && !r.isDisposed) {
        reactions++;
      }
    });
    let detached = 0;
    (globalThis.__perfObserverRegistry || []).forEach(function (ref) {
      const o = ref.deref();
      if (!o || !o.__perfTargets) {
        return;
      }
      o.__perfTargets.forEach(function (t) {
        const el = t.deref();
        if (el && !el.isConnected) {
          detached++;
        }
      });
    });
    let i18nDead = 0;
    const i18n =
      globalThis.I18NManagerStore && globalThis.I18NManagerStore.instance;
    if (i18n && Array.isArray(i18n.elements)) {
      i18n.elements.forEach(function (e) {
        if (
          e &&
          e.context &&
          e.context.nodeType === 1 &&
          !e.context.isConnected
        ) {
          i18nDead++;
        }
      });
    }
    return {
      reactions: reactions,
      detached: detached,
      i18nDead: i18nDead,
      fetches: globalThis.__perfFetches || 0,
      timers: globalThis.__perfTimers || 0,
    };
  });
  return {
    heapKB: metrics.JSHeapUsedSize / 1024,
    nodes: metrics.Nodes,
    listeners: metrics.JSEventListeners,
    reactions: probes.reactions,
    detached: probes.detached,
    i18nDead: probes.i18nDead,
    fetches: probes.fetches,
    timers: probes.timers,
  };
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Client-side navigation, the same path as a user clicking a link the router
// intercepts. Resolves { arrived, ms }: whether the page's content reached
// the store, and how long that took.
async function navigateTo(page, item, timeoutMs) {
  const started = Date.now();
  await page.evaluate(function (slug) {
    const a = document.createElement("a");
    a.href = slug;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, item.slug);
  const arrived = await page
    .waitForFunction(
      function (id) {
        const s =
          globalThis.HAXCMS &&
          globalThis.HAXCMS.instance &&
          globalThis.HAXCMS.instance.store;
        return (
          !!s &&
          s.activeId === id &&
          !!s.activeItemContent &&
          s.activeItemContent.length > 0
        );
      },
      { timeout: timeoutMs, polling: 50 },
      item.id,
    )
    .then(function () {
      return true;
    })
    .catch(function () {
      return false;
    });
  return { arrived: arrived, ms: Date.now() - started };
}

async function toggleEditMode(page) {
  await page.evaluate(function () {
    globalThis.HAXCMS.instance.store.editMode = true;
  });
  await page
    .waitForFunction(
      function () {
        const h = globalThis.HaxStore && globalThis.HaxStore.instance;
        return !!(h && h.activeHaxBody);
      },
      { timeout: 20000, polling: 100 },
    )
    .catch(function () {
      return null;
    });
  await wait(400);
  await page.evaluate(function () {
    globalThis.HAXCMS.instance.store.editMode = false;
  });
  await wait(400);
}

async function loginInPage(page, credentials, site) {
  return page.evaluate(
    async function (username, password, siteName) {
      const response = await fetch("/system/api/v1/session/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username,
          password: password,
          site: { name: siteName },
        }),
      });
      return response.status;
    },
    credentials.username,
    credentials.password,
    site,
  );
}

// Visit order spreads across the whole outline, deterministic per run.
function visitOrder(count, visits, offset) {
  const order = [];
  for (let i = 0; i < visits; i++) {
    order.push((i * 37 + 1 + offset) % count);
  }
  return order;
}

function round(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

/**
 * @param {object} browser puppeteer browser
 * @param {object} opts {
 *   baseUrl, site, items: [{id, slug}], visits, idleSeconds,
 *   editor: boolean, credentials: {username, password}
 * }
 */
async function runMemoryScenario(browser, opts) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "light" },
    ]);
    await page.evaluateOnNewDocument(PAGE_PROBES);
    const cdp = await page.createCDPSession();
    await cdp.send("HeapProfiler.enable");
    const siteBase = opts.baseUrl + "/_sites/" + opts.site + "/";
    const first = opts.items[0];
    await page.goto(siteBase + first.slug, {
      waitUntil: "networkidle0",
      timeout: 180000,
    });
    if (opts.editor) {
      const status = await loginInPage(page, opts.credentials, opts.site);
      if (status !== 200) {
        throw new Error("perf editor login failed: " + status);
      }
      await page.goto(siteBase + first.slug, {
        waitUntil: "networkidle0",
        timeout: 180000,
      });
      await page.waitForFunction(
        function () {
          return globalThis.HAXCMS.instance.store.isLoggedIn === true;
        },
        { timeout: 60000 },
      );
    }
    await hookReactions(page);
    const count = opts.items.length;
    const warmup = visitOrder(count, WARMUP_VISITS, 7);
    for (let i = 0; i < warmup.length; i++) {
      await navigateTo(page, opts.items[warmup[i]], 20000);
      if (opts.editor && i === WARMUP_VISITS - 1) {
        await toggleEditMode(page);
      }
    }
    await wait(1500);
    const start = await sample(page, cdp);
    const order = visitOrder(count, opts.visits, 0);
    let navTimeouts = 0;
    const navTimes = [];
    for (let i = 0; i < order.length; i++) {
      const nav = await navigateTo(page, opts.items[order[i]], 20000);
      if (nav.arrived) {
        navTimes.push(nav.ms);
      } else {
        navTimeouts++;
      }
      if (opts.editor && i % 5 === 4) {
        await toggleEditMode(page);
      }
    }
    await wait(1500);
    const end = await sample(page, cdp);
    await wait(opts.idleSeconds * 1000);
    const idle = await sample(page, cdp);
    const visits = opts.visits;
    return {
      visits: visits,
      startHeapMB: round(start.heapKB / 1024, 1),
      endHeapMB: round(end.heapKB / 1024, 1),
      heapKBPerVisit: round(perVisit(start.heapKB, end.heapKB, visits), 1),
      nodesPerVisit: round(perVisit(start.nodes, end.nodes, visits), 1),
      listenersPerVisit: round(
        perVisit(start.listeners, end.listeners, visits),
        1,
      ),
      reactionsPerVisit: round(
        perVisit(start.reactions, end.reactions, visits),
        2,
      ),
      detachedObserved: end.detached,
      i18nDeadEntries: end.i18nDead,
      idleRequests: idle.fetches - end.fetches,
      idleTimers: idle.timers - end.timers,
      idleGrowthKB: Math.round(Math.max(0, idle.heapKB - end.heapKB)),
      navMsMedian: Math.round(median(navTimes) || 0),
      navTimeouts: navTimeouts,
    };
  } finally {
    await context.close();
  }
}

module.exports = { runMemoryScenario, visitOrder, PAGE_PROBES };
