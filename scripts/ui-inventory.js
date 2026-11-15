#!/usr/bin/env node
"use strict";

/**
 * UI inventory: a generated, ground-truth record of what the HAXcms editor and
 * admin UI actually look like on this checkout. Prototypes and design reviews
 * compare against it instead of describing the UI from memory
 * (haxtheweb/issues#3234).
 *
 * It boots the same isolated runtime the e2e suite uses (temp dir, ephemeral
 * port, auth enabled), logs in, creates a site, then walks a fixed list of
 * real UI states: dashboard, site view, site view as a visitor who is not
 * logged in, edit mode, outline, add page, user menu and every top-level
 * section of the site admin dialog. For each state it
 * writes:
 *
 *   - screenshots at desktop and mobile, light and dark (prefers-color-scheme)
 *   - every visible control and heading: component tag, host chain, id, role,
 *     label, visible text, icon, box, key computed styles, and which DDD /
 *     HAX UI tokens those styles resolve to
 *   - the ordered list of labels a user can see
 *
 * plus tokens.css (every --ddd-* / --hax-ui-* value as it resolved at runtime)
 * so an artifact can load the real values instead of retyping them.
 *
 * This is a reference, not a test: it never fails on visual change and never
 * touches the e2e baselines in test/e2e/__screenshots__.
 *
 *   npm run ui:inventory
 *   npm run ui:inventory -- --out /some/dir --states site-view,site-admin
 *   npm run ui:inventory -- --variants desktop-light --sub
 *
 * Prototypes of something new on a page need the real page around it:
 *   --page-html <file>   replace the first page's content with this HTML
 *   --page-title <text>  and its title
 *   --measure <selector> record that element's box per state and variant
 *                        (deep query), e.g. an empty slot the proposal fills
 *   --theme <element>    switch the fixture site to this theme (a key of
 *                        src/coreConfig/themes.json, e.g. clean-two)
 *   --site-files <dir>   copy this folder's files into the fixture site's
 *                        files/ (media, captions or images the page uses),
 *                        so the page needs nothing from the network
 *   --outline <file>     JSON list of extra pages to add after the first one,
 *                        each { "title", "parent" (index in this list, or
 *                        omit for top level), "html" (optional) }, so menus,
 *                        breadcrumbs and prev / next show a real course shape
 *   --viewport-width <px>   wider desktop captures (mobile variants keep their
 *                        width), for layouts that change on large screens
 *   --page-script <file> run this script in the page after each state is
 *                        entered and before capture (for example: watch half
 *                        a video, open a collapse) so learner and interaction
 *                        state comes from real use; recorded in the manifest
 *   --viewport-height <px>  taller captures for every variant, so content below
 *                        the fold is in frame (themes such as clean-one scroll
 *                        inside their own container, so a full-page capture
 *                        would not show it)
 *
 * To inventory unreleased webcomponents work, run with a linked checkout:
 *   NODE_ENV=development HAXCMS_WEBCOMPONENTS_ROOT=../webcomponents npm run ui:inventory
 */

const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");

const helpers = require("../test/e2e/helpers/index.cjs");

const ROOT = path.resolve(__dirname, "..");

const VARIANTS = {
  "desktop-light": { width: 1280, height: 800, scheme: "light" },
  "desktop-dark": { width: 1280, height: 800, scheme: "dark" },
  "mobile-light": { width: 390, height: 844, scheme: "light" },
  "mobile-dark": { width: 390, height: 844, scheme: "dark" },
};

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, "ui-inventory"),
    states: null,
    variants: Object.keys(VARIANTS),
    sub: false,
    pageHtml: null,
    pageTitle: null,
    measure: null,
    viewportHeight: null,
    theme: null,
    siteFiles: null,
    outline: null,
    viewportWidth: null,
    pageScript: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" && argv[i + 1]) {
      args.out = path.resolve(argv[++i]);
    } else if (a === "--states" && argv[i + 1]) {
      args.states = argv[++i].split(",").map((s) => s.trim());
    } else if (a === "--variants" && argv[i + 1]) {
      args.variants = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter((v) => Object.prototype.hasOwnProperty.call(VARIANTS, v));
    } else if (a === "--page-html" && argv[i + 1]) {
      args.pageHtml = path.resolve(argv[++i]);
    } else if (a === "--page-title" && argv[i + 1]) {
      args.pageTitle = argv[++i];
    } else if (a === "--measure" && argv[i + 1]) {
      args.measure = argv[++i];
    } else if (a === "--viewport-height" && argv[i + 1]) {
      args.viewportHeight = parseInt(argv[++i], 10) || null;
    } else if (a === "--theme" && argv[i + 1]) {
      args.theme = argv[++i].trim();
    } else if (a === "--site-files" && argv[i + 1]) {
      args.siteFiles = path.resolve(argv[++i]);
    } else if (a === "--outline" && argv[i + 1]) {
      args.outline = path.resolve(argv[++i]);
    } else if (a === "--viewport-width" && argv[i + 1]) {
      args.viewportWidth = parseInt(argv[++i], 10) || null;
    } else if (a === "--page-script" && argv[i + 1]) {
      args.pageScript = path.resolve(argv[++i]);
    } else if (a === "--sub") {
      args.sub = true;
    }
  }
  return args;
}

function gitHead(dir) {
  try {
    return childProcess
      .execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
  } catch {
    return null;
  }
}

function slug(value) {
  const parts = String(value)
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter(Boolean);
  return parts.join("-").slice(0, 60);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// page-side code (runs in the browser via page.evaluate)
// ---------------------------------------------------------------------------

// Finds the first element (light or shadow DOM, any depth) matching a CSS
// selector and, optionally, whose trimmed text or label equals `text`.
// Clicks its inner <button> when it wraps one. Returns true when clicked.
function pageClickDeep(selector, text) {
  const doc = globalThis.document;
  function labelOf(el) {
    return (
      el.getAttribute("label") ||
      el.getAttribute("aria-label") ||
      (el.textContent || "").trim().replace(/\s+/g, " ")
    );
  }
  function walk(root) {
    const found = root.querySelectorAll(selector);
    for (let i = 0; i < found.length; i++) {
      if (!text || labelOf(found[i]) === text) {
        return found[i];
      }
    }
    const all = root.querySelectorAll("*");
    for (let j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) {
        const r = walk(all[j].shadowRoot);
        if (r) {
          return r;
        }
      }
    }
    return null;
  }
  const el = walk(doc);
  if (!el) {
    return false;
  }
  const inner = el.shadowRoot && el.shadowRoot.querySelector("button");
  (inner || el).click();
  return true;
}

// Returns true when an element matching `selector` exists at any depth.
function pageExistsDeep(selector) {
  const doc = globalThis.document;
  function walk(root) {
    if (root.querySelector(selector)) {
      return true;
    }
    const all = root.querySelectorAll("*");
    for (let j = 0; j < all.length; j++) {
      if (all[j].shadowRoot && walk(all[j].shadowRoot)) {
        return true;
      }
    }
    return false;
  }
  return walk(doc);
}

// Labels of the site admin rail's top-level items, in order.
function pageAdminRailItems(includeSub) {
  const doc = globalThis.document;
  function find(root) {
    const hit = root.querySelector("haxcms-site-admin");
    if (hit) {
      return hit;
    }
    const all = root.querySelectorAll("*");
    for (let j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) {
        const r = find(all[j].shadowRoot);
        if (r) {
          return r;
        }
      }
    }
    return null;
  }
  const admin = find(doc);
  if (!admin || !admin.shadowRoot) {
    return [];
  }
  const sel = includeSub
    ? ".rail-item:not(.rail-collapse)"
    : ".rail-row > .rail-item:not(.rail-collapse)";
  const items = admin.shadowRoot.querySelectorAll(sel);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    out.push({
      index: i,
      sub: items[i].classList.contains("sub"),
      text: (items[i].textContent || "").trim().replace(/\s+/g, " "),
    });
  }
  return out;
}

function pageClickAdminRailItem(index, includeSub) {
  const doc = globalThis.document;
  function find(root) {
    const hit = root.querySelector("haxcms-site-admin");
    if (hit) {
      return hit;
    }
    const all = root.querySelectorAll("*");
    for (let j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) {
        const r = find(all[j].shadowRoot);
        if (r) {
          return r;
        }
      }
    }
    return null;
  }
  const admin = find(doc);
  if (!admin || !admin.shadowRoot) {
    return false;
  }
  const sel = includeSub
    ? ".rail-item:not(.rail-collapse)"
    : ".rail-row > .rail-item:not(.rail-collapse)";
  const items = admin.shadowRoot.querySelectorAll(sel);
  if (!items[index]) {
    return false;
  }
  items[index].click();
  return true;
}

// Walks every root and records the visible UI plus the token table.
function pageCollect() {
  const doc = globalThis.document;
  const win = globalThis;
  const MAX = 2000;
  const CONTROL_TAGS = {
    button: 1,
    a: 1,
    input: 1,
    select: 1,
    textarea: 1,
    label: 1,
    legend: 1,
    summary: 1,
    h1: 1,
    h2: 1,
    h3: 1,
    h4: 1,
    h5: 1,
    h6: 1,
  };
  const TEXT_TAGS = {
    button: 1,
    a: 1,
    label: 1,
    legend: 1,
    summary: 1,
    h1: 1,
    h2: 1,
    h3: 1,
    h4: 1,
    h5: 1,
    h6: 1,
    option: 1,
  };

  // 1. token names from every stylesheet we can reach
  const roots = [doc];
  const hosts = [doc.documentElement];
  (function gather(root) {
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        roots.push(all[i].shadowRoot);
        hosts.push(all[i]);
        gather(all[i].shadowRoot);
      }
    }
  })(doc);
  const names = {};
  const scanned = new Set();
  const NAME_RE = /(--(?:ddd|hax-ui)-[a-zA-Z0-9-]+)\s*:/g;
  function scanSheet(sheet) {
    if (scanned.has(sheet)) {
      return;
    }
    scanned.add(sheet);
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      rules = null;
    }
    if (!rules) {
      return;
    }
    for (let i = 0; i < rules.length; i++) {
      const textValue = rules[i].cssText || "";
      let m = NAME_RE.exec(textValue);
      while (m) {
        names[m[1]] = true;
        m = NAME_RE.exec(textValue);
      }
      NAME_RE.lastIndex = 0;
    }
  }
  for (let r = 0; r < roots.length; r++) {
    const root = roots[r];
    const sheets = [];
    if (root.styleSheets) {
      for (let s = 0; s < root.styleSheets.length; s++) {
        sheets.push(root.styleSheets[s]);
      }
    }
    if (root.adoptedStyleSheets) {
      for (let s = 0; s < root.adoptedStyleSheets.length; s++) {
        sheets.push(root.adoptedStyleSheets[s]);
      }
    }
    for (let s = 0; s < sheets.length; s++) {
      scanSheet(sheets[s]);
    }
  }

  // 2. resolve each token (document first, then the first host defining it)
  const tokens = {};
  const nameList = Object.keys(names).sort();
  for (let h = 0; h < hosts.length; h++) {
    const cs = win.getComputedStyle(hosts[h]);
    for (let n = 0; n < nameList.length; n++) {
      const key = nameList[n];
      if (!Object.prototype.hasOwnProperty.call(tokens, key)) {
        const v = cs.getPropertyValue(key).trim();
        if (v) {
          tokens[key] = v;
        }
      }
    }
  }

  // 3. reverse map: normalized computed value -> token names
  const probe = doc.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  doc.body.appendChild(probe);
  const byColor = {};
  const byLength = {};
  const tokenKeys = Object.keys(tokens);
  for (let t = 0; t < tokenKeys.length; t++) {
    const key = tokenKeys[t];
    const value = tokens[key];
    probe.style.color = "";
    probe.style.color = value;
    if (probe.style.color) {
      const c = win.getComputedStyle(probe).color;
      byColor[c] = (byColor[c] || []).concat(key);
    }
    probe.style.width = "";
    probe.style.width = value;
    if (probe.style.width && /px|rem|em/.test(value)) {
      const w = win.getComputedStyle(probe).width;
      byLength[w] = (byLength[w] || []).concat(key);
    }
  }
  probe.remove();

  // Only names from the token family that fits the property, so a 16px
  // font size is not reported as a spacing token that happens to be 16px.
  const FAMILY = {
    color:
      /color|primary|accent|theme|text|ink|bg|background|surface|border|focus|link|danger|success|warning|info|gray|grey|white|black/,
    fontSize: /font-size|text|type|fs-/,
    padding: /spacing|space|pad|gap|inset/,
    radius: /radius/,
  };
  function tokensFor(map, value, family) {
    if (!value || value === "rgba(0, 0, 0, 0)") {
      return [];
    }
    const parts = family === "color" ? [value] : value.split(" ");
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "0px" || !map[parts[i]]) {
        continue;
      }
      const names = map[parts[i]].filter((n) => FAMILY[family].test(n));
      if (names.length) {
        out.push(names.slice(0, 4));
      }
    }
    return out;
  }

  // 4. deep elementFromPoint so we can tell what a user actually sees on top
  function deepHit(x, y) {
    let el = doc.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard < 50) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) {
        break;
      }
      el = inner;
      guard++;
    }
    return el;
  }
  function composedContains(outer, inner) {
    let node = inner;
    let guard = 0;
    while (node && guard < 500) {
      if (node === outer) {
        return true;
      }
      node = node.parentNode || node.host || null;
      guard++;
    }
    return false;
  }

  // 5. walk visible UI
  const elements = [];
  const labels = [];
  const seenLabels = {};
  (function walk(root, chain) {
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length && elements.length < MAX; i++) {
      const e = all[i];
      const tag = e.tagName.toLowerCase();
      const isCustom = tag.indexOf("-") !== -1;
      const role = e.getAttribute("role") || "";
      const aria = e.getAttribute("aria-label") || "";
      if (isCustom || CONTROL_TAGS[tag] || role || aria) {
        const rect = e.getBoundingClientRect();
        let visible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < win.innerHeight &&
          rect.left < win.innerWidth;
        if (visible && typeof e.checkVisibility === "function") {
          visible = e.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          });
        }
        if (visible) {
          const cx = Math.min(
            Math.max(rect.left + rect.width / 2, 0),
            win.innerWidth - 1,
          );
          const cy = Math.min(
            Math.max(rect.top + rect.height / 2, 0),
            win.innerHeight - 1,
          );
          const hit = deepHit(cx, cy);
          const onTop = !!(
            hit &&
            (composedContains(e, hit) || composedContains(hit, e))
          );
          const label = (
            e.getAttribute("label") ||
            aria ||
            e.getAttribute("title") ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          let text = "";
          if (TEXT_TAGS[tag]) {
            text = (e.textContent || "")
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 120);
          }
          const cs = win.getComputedStyle(e);
          const record = {
            host: chain,
            tag: tag,
            id: e.id || "",
            role: role,
            label: label,
            text: text,
            icon: e.getAttribute("icon") || "",
            onTop: onTop,
            box: [
              Math.round(rect.left),
              Math.round(rect.top),
              Math.round(rect.width),
              Math.round(rect.height),
            ],
            style: {
              color: cs.color,
              background: cs.backgroundColor,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              fontFamily: (cs.fontFamily || "").split(",")[0].trim(),
              padding: cs.padding,
              radius: cs.borderRadius,
              height: cs.height,
            },
            tokens: {
              color: tokensFor(byColor, cs.color, "color"),
              background: tokensFor(byColor, cs.backgroundColor, "color"),
              fontSize: tokensFor(byLength, cs.fontSize, "fontSize"),
              padding: tokensFor(byLength, cs.padding, "padding"),
              radius: tokensFor(byLength, cs.borderRadius, "radius"),
            },
          };
          elements.push(record);
          const seen = label || text;
          if (seen && onTop && !seenLabels[seen]) {
            seenLabels[seen] = true;
            labels.push(seen);
          }
        }
      }
      if (e.shadowRoot) {
        walk(e.shadowRoot, chain ? chain + " > " + tag : tag);
      }
    }
  })(doc, "");

  return {
    url: win.location.pathname,
    viewport: [win.innerWidth, win.innerHeight],
    labels: labels,
    elements: elements,
    tokens: tokens,
  };
}

// Box of the first element matching `selector` at any depth, in CSS pixels of
// the viewport, or null when it is missing or not rendered.
function pageMeasureDeep(selector) {
  const doc = globalThis.document;
  function walk(root) {
    const hit = root.querySelector(selector);
    if (hit) {
      return hit;
    }
    const all = root.querySelectorAll("*");
    for (let j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) {
        const r = walk(all[j].shadowRoot);
        if (r) {
          return r;
        }
      }
    }
    return null;
  }
  const el = walk(doc);
  if (!el) {
    return null;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    return null;
  }
  return [
    Math.round(r.left),
    Math.round(r.top),
    Math.round(r.width),
    Math.round(r.height),
  ];
}

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

// Dialog handling, dark-mode pin and failed-request tracking for a capture tab.
async function preparePage(ctx, page, scheme) {
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {});
  });
  // HAX saves the visitor's dark-mode choice in localStorage
  // (app-hax-darkMode), and a saved choice wins over prefers-color-scheme.
  // Another tab's store can write its own value back while this one loads,
  // so clearing the key is not enough: pin it to this capture's scheme
  // before any page script runs.
  await page.evaluateOnNewDocument((dark) => {
    try {
      globalThis.window.localStorage.setItem(
        "app-hax-darkMode",
        JSON.stringify(dark),
      );
    } catch {
      /* storage unavailable */
    }
  }, scheme === "dark");
  if (ctx.onRequestFailed) {
    page.on("requestfailed", ctx.onRequestFailed);
  }
}

// Swaps in a new capture tab, closing the previous one (and the visitor
// context it may have lived in).
async function replacePage(ctx, page, visitorContext) {
  const old = ctx.page;
  const oldVisitorContext = ctx.visitorContext;
  ctx.page = page;
  ctx.visitorContext = visitorContext || null;
  if (old) {
    try {
      await old.close({ runBeforeUnload: false });
    } catch {
      /* ignore */
    }
  }
  if (oldVisitorContext) {
    try {
      await oldVisitorContext.close();
    } catch {
      /* ignore */
    }
  }
}

// Replaces ctx.page with a new tab in the same (logged-in) browser.
async function freshPage(ctx, scheme) {
  ctx.scheme = scheme;
  const page = await helpers.newPage(ctx.browser);
  await preparePage(ctx, page, scheme);
  await replacePage(ctx, page);
}

// Replaces ctx.page with a tab in a separate browser context that has never
// logged in, keeping the viewport and color scheme captureState already set.
async function visitorPage(ctx) {
  const viewport = ctx.page.viewport();
  const context = await ctx.browser.createBrowserContext();
  const page = await context.newPage();
  if (viewport) {
    await page.setViewport(viewport);
  }
  await helpers.pinColorScheme(page, ctx.scheme);
  await preparePage(ctx, page, ctx.scheme);
  await replacePage(ctx, page, context);
}

async function gotoSite(ctx, visitor) {
  const url = ctx.runtime.baseUrl + "/_sites/" + ctx.siteName + "/";
  try {
    await ctx.page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  } catch {
    await ctx.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  }
  // a visitor gets the theme without the editor top bar
  await ctx.page.waitForSelector(
    visitor ? "haxcms-site-builder" : "haxcms-site-editor-ui",
    { timeout: 30000 },
  );
  await delay(4000);
}

async function dismissOverlays(ctx) {
  await ctx.page.keyboard.press("Escape");
  await delay(800);
}

async function clickTopBar(ctx, id) {
  const r = await helpers.clickEditorButtonById(ctx.page, id);
  if (!r || !r.clicked) {
    throw new Error("top bar control " + id + " not found");
  }
  await delay(2500);
}

function baseStates() {
  return [
    {
      id: "dashboard",
      description: "app-hax dashboard, logged in, one site",
      enter: async (ctx) => {
        await ctx.page.goto(ctx.runtime.baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await ctx.page.waitForSelector("app-hax", { timeout: 30000 });
        await helpers.waitFor(
          () => ctx.page.evaluate(pageExistsDeep, "app-hax-site-bar"),
          15000,
        );
        await delay(2000);
      },
    },
    {
      id: "site-first-visit",
      description:
        "site view on first visit, as the editor lands (Merlin welcome)",
      enter: async (ctx) => {
        await gotoSite(ctx);
      },
    },
    {
      id: "site-view",
      description: "site view with the editor top bar, overlays dismissed",
      enter: async (ctx) => {
        await gotoSite(ctx);
        await dismissOverlays(ctx);
      },
    },
    {
      id: "site-view-visitor",
      description:
        "site view as a visitor who is not logged in (no editor top bar)",
      enter: async (ctx) => {
        await visitorPage(ctx);
        await gotoSite(ctx, true);
      },
    },
    {
      id: "edit-mode",
      description: "page in edit mode (Edit pressed), default tray",
      enter: async (ctx) => {
        await gotoSite(ctx);
        await dismissOverlays(ctx);
        await clickTopBar(ctx, "#editbutton");
      },
    },
    {
      id: "outline",
      description: "Outline (outline-designer) open",
      enter: async (ctx) => {
        await gotoSite(ctx);
        await dismissOverlays(ctx);
        await clickTopBar(ctx, "#outlinebutton");
      },
    },
    {
      id: "add-page",
      description: "Add page control pressed",
      enter: async (ctx) => {
        await gotoSite(ctx);
        await dismissOverlays(ctx);
        await clickTopBar(ctx, "#addpagebutton");
      },
    },
    {
      id: "user-menu",
      description: "user menu open",
      enter: async (ctx) => {
        await gotoSite(ctx);
        await dismissOverlays(ctx);
        const ok = await ctx.page.evaluate(
          pageClickDeep,
          "app-hax-user-menu-toggle",
          null,
        );
        if (!ok) {
          throw new Error("user menu toggle not found");
        }
        await delay(1500);
      },
    },
  ];
}

// The site admin dialog: one state per rail section, discovered at runtime so
// the inventory follows whatever sections main actually has.
async function adminStates(ctx, includeSub) {
  await gotoSite(ctx);
  await dismissOverlays(ctx);
  await clickTopBar(ctx, "#manifestbtn");
  const ready = await helpers.waitFor(
    () => ctx.page.evaluate(pageExistsDeep, "haxcms-site-admin"),
    20000,
  );
  if (!ready) {
    return [];
  }
  await delay(1500);
  const items = await ctx.page.evaluate(pageAdminRailItems, includeSub);
  return items.map((item) => ({
    id: "site-admin-" + slug(item.text.replace(/\s+\d+$/, "")),
    description:
      "Site Settings dialog, " +
      (item.sub ? "sub-section " : "section ") +
      '"' +
      item.text +
      '"',
    enter: async (c) => {
      await gotoSite(c);
      await dismissOverlays(c);
      await clickTopBar(c, "#manifestbtn");
      await helpers.waitFor(
        () => c.page.evaluate(pageExistsDeep, "haxcms-site-admin"),
        20000,
      );
      await delay(1500);
      const clicked = await c.page.evaluate(
        pageClickAdminRailItem,
        item.index,
        includeSub,
      );
      if (!clicked) {
        throw new Error("rail item not found: " + item.text);
      }
      await delay(1800);
    },
  }));
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

// Each variant is entered fresh with its viewport and color scheme set before
// the page loads. Switching the scheme on a loaded page makes HAX react (it
// shows a toast), so a mid-state switch would not show what a user who loads
// the page in that mode sees.
async function captureState(ctx, state, args) {
  const dir = path.join(args.out, "states", state.id);
  fs.mkdirSync(dir, { recursive: true });
  const shots = {};
  const measures = {};
  // DOM is recorded once, at the first variant (desktop-light by default).
  let dom = null;
  for (let v = 0; v < args.variants.length; v++) {
    const name = args.variants[v];
    const variant = VARIANTS[name];
    // A fresh tab per capture: leaving a page in edit mode raises a
    // "leave site?" prompt that would otherwise block the next navigation.
    await freshPage(ctx, variant.scheme);
    await ctx.page.setViewport({
      width:
        args.viewportWidth && name.indexOf("desktop") === 0
          ? args.viewportWidth
          : variant.width,
      height: args.viewportHeight || variant.height,
    });
    await helpers.pinColorScheme(ctx.page, variant.scheme);
    await state.enter(ctx);
    if (args.pageScript) {
      const source = fs.readFileSync(args.pageScript, "utf8");
      // the prototype author's own file, run as an async body through the
      // DevTools protocol (a script tag would be blocked by the site's CSP);
      // the capture waits for it to finish
      await ctx.page.evaluate("(async () => {\n" + source + "\n})()");
    }
    if (!dom) {
      const started = Date.now();
      dom = await ctx.page.evaluate(pageCollect);
      dom.variant = name;
      dom.ms = Date.now() - started;
    }
    if (args.measure) {
      measures[name] = await ctx.page.evaluate(pageMeasureDeep, args.measure);
    }
    const file = path.join(dir, name + ".png");
    await ctx.page.screenshot({
      path: file,
      type: "png",
      fullPage: false,
    });
    shots[name] = path.relative(args.out, file);
  }
  await ctx.page.setViewport({ width: 1280, height: 800 });
  await helpers.pinColorScheme(ctx.page, "light");
  fs.writeFileSync(
    path.join(dir, "dom.json"),
    JSON.stringify(dom.elements, null, 2),
  );
  return {
    id: state.id,
    description: state.description,
    url: dom.url,
    domVariant: dom.variant,
    screenshots: shots,
    measures: args.measure ? { selector: args.measure, boxes: measures } : null,
    labels: dom.labels,
    elementCount: dom.elements.length,
    dom: path.relative(args.out, path.join(dir, "dom.json")),
    tokens: dom.tokens,
    collectMs: dom.ms,
  };
}

// Writes the first page of the fixture site from --page-html / --page-title,
// straight to the site's files, before any state is captured. Returns a line
// for manifest.fixture so the change is on the record.
function applyPageFixture(runtime, siteName, args) {
  const siteDir = path.join(runtime.runtimeRoot, "_sites", siteName);
  const siteJsonPath = path.join(siteDir, "site.json");
  const site = JSON.parse(fs.readFileSync(siteJsonPath, "utf8"));
  const item = site.items && site.items[0];
  if (!item) {
    throw new Error("fixture site has no pages");
  }
  const notes = [];
  if (args.pageTitle) {
    item.title = args.pageTitle;
  }
  if (args.theme) {
    const themes = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "src", "coreConfig", "themes.json"),
        "utf8",
      ),
    );
    const entry = themes[args.theme];
    if (!entry || typeof entry !== "object") {
      throw new Error("unknown theme: " + args.theme);
    }
    site.metadata = site.metadata || {};
    const current = site.metadata.theme || {};
    site.metadata.theme = Object.assign({}, current, {
      element: entry.element,
      path: entry.path,
      name: entry.name,
      variables: current.variables || {},
    });
    notes.push("theme " + entry.element);
  }
  if (args.outline) {
    const extra = JSON.parse(fs.readFileSync(args.outline, "utf8"));
    if (!Array.isArray(extra)) {
      throw new Error("--outline must be a JSON list of pages");
    }
    const ids = [];
    const used = {};
    site.items.forEach((it) => {
      used[it.slug] = true;
    });
    for (let i = 0; i < extra.length; i++) {
      const entry = extra[i] || {};
      const title = String(entry.title || "Page " + (i + 1));
      let base =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "page";
      let slug = base;
      let n = 1;
      while (used[slug]) {
        slug = base + "-" + n++;
      }
      used[slug] = true;
      const id = "item-fixture-" + (i + 1);
      ids.push(id);
      const parentIndex =
        typeof entry.parent === "number" &&
        entry.parent >= 0 &&
        entry.parent < i
          ? entry.parent
          : null;
      const parent = parentIndex === null ? null : ids[parentIndex];
      const siblings = site.items.filter(
        (it) => (it.parent || null) === parent,
      );
      const location = "pages/" + slug + "/index.html";
      const page = JSON.parse(JSON.stringify(item));
      Object.assign(page, {
        id: id,
        title: title,
        slug: slug,
        location: location,
        parent: parent,
        order: siblings.length,
        indent:
          parentIndex === null ? 0 : (extra[parentIndex]._indent || 0) + 1,
      });
      entry._indent = page.indent;
      if (page.metadata) {
        delete page.metadata.pageType;
      }
      site.items.push(page);
      const target = path.resolve(siteDir, location);
      if (target.indexOf(siteDir + path.sep) !== 0) {
        throw new Error("page location escapes the site: " + location);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        typeof entry.html === "string" ? entry.html : "<p>" + title + "</p>",
      );
    }
    notes.push(
      extra.length + " extra page(s) from " + path.basename(args.outline),
    );
  }
  if (args.pageTitle || args.theme || args.outline) {
    fs.writeFileSync(siteJsonPath, JSON.stringify(site, null, 2));
  }
  if (args.siteFiles) {
    const filesDir = path.join(siteDir, "files");
    fs.mkdirSync(filesDir, { recursive: true });
    const names = fs
      .readdirSync(args.siteFiles, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    for (let i = 0; i < names.length; i++) {
      fs.copyFileSync(
        path.join(args.siteFiles, names[i]),
        path.join(filesDir, path.basename(names[i])),
      );
    }
    notes.push(
      names.length + " file(s) in files/ from " + path.basename(args.siteFiles),
    );
  }
  if (args.pageHtml) {
    const target = path.resolve(siteDir, item.location);
    if (target.indexOf(siteDir + path.sep) !== 0) {
      throw new Error("page location escapes the site: " + item.location);
    }
    fs.writeFileSync(target, fs.readFileSync(args.pageHtml, "utf8"));
  }
  return (
    "fresh site " +
    siteName +
    "; first page" +
    (args.pageTitle ? ' titled "' + args.pageTitle + '"' : "") +
    (args.pageHtml
      ? " with content from " + path.basename(args.pageHtml)
      : "") +
    (notes.length ? "; " + notes.join("; ") : "")
  );
}

function writeTokensCss(out, tokens) {
  const keys = Object.keys(tokens).sort();
  const lines = [
    "/* Generated by haxcms-nodejs scripts/ui-inventory.js: every DDD and HAX UI",
    "   token as it resolved at runtime. Load this in prototypes; never retype",
    "   token values by hand. Regenerate instead of editing. */",
    ":root {",
  ];
  for (let i = 0; i < keys.length; i++) {
    lines.push("  " + keys[i] + ": " + tokens[keys[i]] + ";");
  }
  lines.push("}", "");
  fs.writeFileSync(path.join(out, "tokens.css"), lines.join("\n"));
  return keys.length;
}

function writeReadme(out, manifest) {
  const lines = [
    "# HAXcms UI inventory",
    "",
    "Generated by `npm run ui:inventory` in haxcms-nodejs. Do not edit; regenerate.",
    "",
    "- haxcms-nodejs: `" + (manifest.source.haxcmsNodejs || "unknown") + "`",
    "- webcomponents: " + manifest.source.webcomponents,
    "- generated: " + manifest.generatedAt,
    "- theme: " + (manifest.theme || "default"),
    "- unreachable hosts: " +
      (Object.keys(manifest.failedHosts).length
        ? Object.keys(manifest.failedHosts).join(", ") +
          " (captures use fallbacks for anything served from them, such as" +
          " web fonts; re-run where they load before treating type as exact)"
        : "none"),
    "",
    "| State | What it is | Visible labels, in order |",
    "|---|---|---|",
  ];
  for (let i = 0; i < manifest.states.length; i++) {
    const s = manifest.states[i];
    lines.push(
      "| `" +
        s.id +
        "` | " +
        s.description.replace(/\|/g, "/") +
        " | " +
        s.labels.slice(0, 40).join(" · ").replace(/\|/g, "/") +
        (s.labels.length > 40 ? " …" : "") +
        " |",
    );
  }
  if (manifest.failures.length) {
    lines.push("", "## States that could not be captured", "");
    for (let f = 0; f < manifest.failures.length; f++) {
      lines.push(
        "- `" + manifest.failures[f].id + "`: " + manifest.failures[f].error,
      );
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(out, "README.md"), lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.join(args.out, "states"), { recursive: true });
  const linkedRoot =
    process.env.NODE_ENV === "development" &&
    process.env.HAXCMS_WEBCOMPONENTS_ROOT
      ? path.resolve(process.env.HAXCMS_WEBCOMPONENTS_ROOT)
      : null;
  const source = {
    haxcmsNodejs: gitHead(ROOT),
    webcomponents: linkedRoot
      ? "linked checkout `" + (gitHead(linkedRoot) || "unknown") + "`"
      : "bundled build in src/public/build",
  };

  const runtime = await helpers.setupE2ERuntime();
  helpers.patchHaxcmsRootForHarness(runtime);
  const browser = await helpers.launchBrowser();
  const page = await helpers.newPage(browser);
  const collector = helpers.createResponseCollector(page);
  // Hosts the browser could not reach (a sandbox that blocks fonts, say).
  // Recorded so nobody mistakes fallback rendering for the real thing.
  const failedHosts = {};
  function onRequestFailed(request) {
    let host = "unknown";
    try {
      host = new URL(request.url()).host;
    } catch {
      host = "unknown";
    }
    if (host.indexOf("127.0.0.1") !== 0 && host.indexOf("localhost") !== 0) {
      failedHosts[host] = (failedHosts[host] || 0) + 1;
    }
  }
  page.on("requestfailed", onRequestFailed);
  const siteName = helpers.FIXED_SITE_NAME.toLowerCase();
  const ctx = { runtime, browser, page, siteName, onRequestFailed };
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: source,
    fixture: "fresh site " + siteName + " from the default create flow",
    theme: null,
    variants: args.variants.reduce((acc, name) => {
      acc[name] = Object.assign({}, VARIANTS[name]);
      if (args.viewportHeight) {
        acc[name].height = args.viewportHeight;
      }
      if (args.viewportWidth && name.indexOf("desktop") === 0) {
        acc[name].width = args.viewportWidth;
      }
      return acc;
    }, {}),
    states: [],
    failures: [],
    failedHosts: failedHosts,
    pageScript: args.pageScript ? path.basename(args.pageScript) : null,
  };
  const allTokens = {};
  try {
    await page.goto(runtime.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await helpers.loginViaUI(page, collector, runtime.baseUrl);
    await helpers.createSiteViaUI(page, collector, helpers.FIXED_SITE_NAME);
    helpers.relocateCreatedSite(runtime, helpers.FIXED_SITE_NAME);
    if (
      args.pageHtml ||
      args.pageTitle ||
      args.theme ||
      args.siteFiles ||
      args.outline
    ) {
      manifest.fixture = applyPageFixture(runtime, siteName, args);
    }

    let states = baseStates();
    const wanted = args.states;
    const wantsAdmin =
      !wanted || wanted.some((w) => w.indexOf("site-admin") === 0);
    if (wantsAdmin) {
      try {
        states = states.concat(await adminStates(ctx, args.sub));
      } catch (e) {
        manifest.failures.push({
          id: "site-admin",
          error: e && e.message ? e.message : String(e),
        });
      }
    }
    if (wanted) {
      states = states.filter((s) =>
        wanted.some((w) => s.id === w || s.id.indexOf(w + "-") === 0),
      );
    }
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      try {
        const started = Date.now();
        const record = await captureState(ctx, state, args);
        if (!manifest.theme) {
          manifest.theme = await ctx.page.evaluate(() => {
            const doc = globalThis.document;
            const builder = doc.querySelector("haxcms-site-builder");
            if (builder && builder.firstElementChild) {
              return builder.firstElementChild.tagName.toLowerCase();
            }
            const known = ["clean-one", "clean-two", "learn-two-theme"];
            for (let k = 0; k < known.length; k++) {
              if (doc.querySelector(known[k])) {
                return known[k];
              }
            }
            return null;
          });
        }
        Object.assign(allTokens, record.tokens);
        delete record.tokens;
        manifest.states.push(record);
        console.log(
          "[inventory] " +
            state.id +
            ": " +
            record.elementCount +
            " elements, " +
            record.labels.length +
            " labels, " +
            Math.round((Date.now() - started) / 1000) +
            "s (collect " +
            record.collectMs +
            "ms)",
        );
      } catch (e) {
        manifest.failures.push({
          id: state.id,
          error: e && e.message ? e.message : String(e),
        });
        console.warn("[inventory] " + state.id + " failed: " + e);
      }
    }
  } finally {
    try {
      collector.detach();
    } catch {
      /* ignore */
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    await helpers.teardownE2ERuntime(runtime);
  }
  manifest.tokenCount = writeTokensCss(args.out, allTokens);
  fs.writeFileSync(
    path.join(args.out, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  writeReadme(args.out, manifest);
  console.log(
    "[inventory] wrote " +
      manifest.states.length +
      " states, " +
      manifest.tokenCount +
      " tokens, " +
      manifest.failures.length +
      " failures to " +
      args.out,
  );
  // An inventory with failures is still useful; exit 0 so it never gates CI.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
