"use strict";

// Opening the outline designer (Site settings > Structure) as a logged-in
// editor: how long until its rows are on screen and stop changing, how many
// rows it rendered, and how much heap it took. This is the editor view whose
// cost grows most directly with page count, so it is the one to watch when
// sites get bigger.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const OPEN_TIMEOUT_MS = 120000;

// Installs globalThis.__perfDeepQuery(selector): find an element anywhere in
// the page, inside shadow roots too.
const INSTALL_DEEP_QUERY = function () {
  globalThis.__perfDeepQuery = function (selector) {
    const walk = function (root) {
      const found = root.querySelector(selector);
      if (found) {
        return found;
      }
      const all = root.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          const inner = walk(all[i].shadowRoot);
          if (inner) {
            return inner;
          }
        }
      }
      return null;
    };
    return walk(document);
  };
};

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {object} browser puppeteer browser
 * @param {object} opts { baseUrl, site, items, credentials }
 */
async function runOutlineScenario(browser, opts) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    const cdp = await page.createCDPSession();
    await cdp.send("HeapProfiler.enable");
    const url =
      opts.baseUrl + "/_sites/" + opts.site + "/" + opts.items[0].slug;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 180000 });
    const status = await page.evaluate(
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
      opts.credentials.username,
      opts.credentials.password,
      opts.site,
    );
    if (status !== 200) {
      throw new Error("perf outline login failed: " + status);
    }
    await page.goto(url, { waitUntil: "networkidle0", timeout: 180000 });
    await page.evaluate(INSTALL_DEEP_QUERY);
    await page.waitForFunction(
      function () {
        return globalThis.__perfDeepQuery("#outlinebutton") !== null;
      },
      { timeout: 60000, polling: 100 },
    );
    await wait(1000);
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await page.metrics();
    // a real pointer click on the toolbar button, as an editor would
    const box = await page.evaluate(function () {
      const r = globalThis
        .__perfDeepQuery("#outlinebutton")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const started = Date.now();
    await page.mouse.click(box.x, box.y);
    // rows on screen and unchanged across three checks 150ms apart
    const rows = await page.evaluate(async function (timeoutMs) {
      const countRows = function () {
        const designer = globalThis.__perfDeepQuery("outline-designer");
        if (!designer || !designer.shadowRoot) {
          return 0;
        }
        return designer.shadowRoot.querySelectorAll("li.item[data-item-id]")
          .length;
      };
      const deadline = Date.now() + timeoutMs;
      let last = -1;
      let stable = 0;
      while (Date.now() < deadline) {
        await new Promise(function (r) {
          setTimeout(r, 150);
        });
        const n = countRows();
        if (n > 0 && n === last) {
          stable++;
          if (stable >= 3) {
            return n;
          }
        } else {
          stable = 0;
        }
        last = n;
      }
      return -1;
    }, OPEN_TIMEOUT_MS);
    // subtract the settle checks (3 x 150ms) the loop needed to confirm
    const openMs = Math.max(0, Date.now() - started - 450);
    await cdp.send("HeapProfiler.collectGarbage");
    const after = await page.metrics();
    if (rows < 0) {
      throw new Error("outline designer never finished rendering rows");
    }
    return {
      outlineOpenMs: openMs,
      outlineRows: rows,
      outlineHeapMB:
        Math.round(
          ((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1048576) * 10,
        ) / 10,
      outlineNodes: after.Nodes - before.Nodes,
    };
  } finally {
    await context.close();
  }
}

module.exports = { runOutlineScenario, INSTALL_DEEP_QUERY };
