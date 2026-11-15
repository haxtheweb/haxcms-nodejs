"use strict";

// Deterministic fixture sites for the perf harness. Same seed, same site:
// titles, outline shape and page bodies never change between runs, so
// numbers from different runs (and machines) are comparable. (Item ids and
// slugs are assigned by the server; scenarios read them from site.json.)
//
// Sites are created through the real API (system createSite, then one bulk
// site items create), the same path the app uses.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining, no Math.random.

const axios = require("axios");

const WORDS = (
  "design learning web component accessible content module lesson student " +
  "outline theme performance memory render browser element structure semantic " +
  "media assessment feedback revision understanding evidence platform portable"
).split(" ");

// small linear congruential generator: deterministic, not for security
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeText(rand) {
  const pick = function () {
    return WORDS[Math.floor(rand() * WORDS.length)];
  };
  const sentence = function (n) {
    const words = [];
    for (let i = 0; i < n; i++) {
      words.push(pick());
    }
    const text = words.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  };
  const paragraph = function (sentences) {
    const out = [];
    for (let i = 0; i < sentences; i++) {
      out.push(sentence(9 + Math.floor(rand() * 10)));
    }
    return "<p>" + out.join(" ") + "</p>";
  };
  return { sentence, paragraph };
}

// A page body with the kinds of blocks real HAX pages have. Every custom
// element used here ships with haxcms-nodejs's front end.
function pageBody(rand) {
  const t = makeText(rand);
  const blocks = [
    function () {
      return t.paragraph(3);
    },
    function () {
      return "<h3>" + t.sentence(4).slice(0, -1) + "</h3>" + t.paragraph(2);
    },
    function () {
      let items = "";
      for (let i = 0; i < 5; i++) {
        items += "<li>" + t.sentence(7) + "</li>";
      }
      return "<ul>" + items + "</ul>";
    },
    function () {
      return "<blockquote>" + t.sentence(16) + "</blockquote>";
    },
    function () {
      return (
        '<a11y-collapse heading="' +
        t.sentence(4).slice(0, -1) +
        '"><p slot="content">' +
        t.sentence(20) +
        "</p></a11y-collapse>"
      );
    },
    function () {
      return (
        '<self-check title="Check your understanding" question="' +
        t.sentence(8).slice(0, -1) +
        '?"><p>' +
        t.sentence(12) +
        "</p></self-check>"
      );
    },
    function () {
      return (
        '<grid-plate layout="1-1"><div slot="col-1">' +
        t.paragraph(2) +
        '</div><div slot="col-2">' +
        t.paragraph(2) +
        "</div></grid-plate>"
      );
    },
    function () {
      return (
        '<accent-card accent-color="blue"><div slot="heading">' +
        t.sentence(3).slice(0, -1) +
        '</div><div slot="content">' +
        t.sentence(14) +
        "</div></accent-card>"
      );
    },
  ];
  const parts = [t.paragraph(5)];
  const count = 4 + Math.floor(rand() * 6);
  for (let i = 0; i < count; i++) {
    parts.push(blocks[Math.floor(rand() * blocks.length)]());
  }
  return parts.join("");
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Shape of the fixture named perf<N>: modules of 4 lessons x 5 pages
// (25 items per module), as many modules as N needs, truncated at exactly N
// items. perf500 = 20 modules, perf1000 = 40, perf10000 = 400.
const LESSONS_PER_MODULE = 4;
const PAGES_PER_LESSON = 5;
const ITEMS_PER_MODULE = 1 + LESSONS_PER_MODULE * (1 + PAGES_PER_LESSON);
const MAX_SIZE = 20000;

function fixtureShape(name) {
  const match = /^perf([0-9]+)$/.exec(String(name));
  const size = match ? parseInt(match[1], 10) : NaN;
  if (!match || !(size >= 1) || size > MAX_SIZE) {
    throw new Error(
      "perf fixture names are perf<N> with 1 <= N <= " +
        MAX_SIZE +
        ", got: " +
        name,
    );
  }
  return {
    size: size,
    modules: Math.ceil(size / ITEMS_PER_MODULE),
    lessons: LESSONS_PER_MODULE,
    pages: PAGES_PER_LESSON,
    seed: size,
  };
}

// Deterministic outline for a shape: same shape, same items, byte for byte.
function buildOutline(shape) {
  const rand = seededRandom(shape.seed);
  const t = makeText(rand);
  const items = [];
  let idCounter = 0;
  const add = function (title, parent, indent, order) {
    idCounter++;
    const item = {
      id: "item-perf-" + shape.seed + "-" + String(idCounter).padStart(5, "0"),
      title: title,
      slug: slugify(title),
      parent: parent,
      indent: indent,
      order: order,
      contents: pageBody(rand),
    };
    items.push(item);
    return item.id;
  };
  const full = function () {
    return items.length >= shape.size;
  };
  for (let m = 1; m <= shape.modules && !full(); m++) {
    const moduleId = add(
      "Module " + m + ": " + t.sentence(3).slice(0, -1),
      null,
      0,
      m - 1,
    );
    for (let l = 1; l <= shape.lessons && !full(); l++) {
      const lessonId = add(
        "Lesson " + m + "." + l + " " + t.sentence(3).slice(0, -1),
        moduleId,
        1,
        l - 1,
      );
      for (let p = 1; p <= shape.pages && !full(); p++) {
        add(
          "Page " + m + "." + l + "." + p + " " + t.sentence(3).slice(0, -1),
          lessonId,
          2,
          p - 1,
        );
      }
    }
  }
  return items;
}

// Split an outline into create requests of whole top-level subtrees (parents
// always land in the same or an earlier request), about `target` items each.
function batchOutline(items, target) {
  const batches = [];
  let current = [];
  items.forEach(function (item) {
    if (item.indent === 0 && current.length >= target) {
      batches.push(current);
      current = [];
    }
    current.push(item);
  });
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

async function login(baseUrl, credentials, siteName) {
  const response = await axios.post(
    baseUrl + "/system/api/v1/session/login",
    {
      username: credentials.username,
      password: credentials.password,
      site: siteName ? { name: siteName } : undefined,
    },
    { validateStatus: () => true },
  );
  if (response.status !== 200 || !response.data || !response.data.jwt) {
    throw new Error("perf fixture login failed: " + response.status);
  }
  return response.data;
}

// The site's outline as the front end sees it: [{ id, slug, indent }] in
// outline order, or null when the site does not exist.
async function fetchSiteItems(baseUrl, name) {
  const response = await axios.get(baseUrl + "/_sites/" + name + "/site.json", {
    validateStatus: () => true,
  });
  if (
    response.status !== 200 ||
    !response.data ||
    !Array.isArray(response.data.items)
  ) {
    return null;
  }
  return response.data.items.map(function (item) {
    return { id: item.id, slug: item.slug, indent: item.indent };
  });
}

// Create a fixture site through the API. Returns { name, items } with items
// read back from site.json. `siteName` (optional) builds the perf<N> outline
// under another site name, e.g. a fresh copy per fuzz run.
async function createFixtureSite(baseUrl, credentials, name, siteName) {
  const shape = fixtureShape(name);
  const target = siteName || name;
  const session = await login(baseUrl, credentials);
  const site = await axios.post(
    baseUrl + "/system/api/v1/sites",
    {
      site: {
        name: target,
        description: "perf fixture " + name,
        theme: "clean-two",
      },
      build: { type: "website", structure: "course" },
    },
    {
      headers: {
        Authorization: "Bearer " + session.jwt,
        "X-HAXCMS-User-Token": session.userToken,
      },
      validateStatus: () => true,
    },
  );
  if (site.status !== 200) {
    throw new Error(
      "perf fixture createSite failed: " +
        site.status +
        " " +
        JSON.stringify(site.data),
    );
  }
  const siteSession = await login(baseUrl, credentials, target);
  const items = buildOutline(shape);
  const batches = batchOutline(items, 250);
  for (let i = 0; i < batches.length; i++) {
    const bulk = await axios.post(
      baseUrl + "/_sites/" + target + "/x/api/v1/items",
      { site: { name: target }, items: batches[i] },
      {
        headers: {
          Authorization: "Bearer " + siteSession.jwt,
          "X-HAXCMS-User-Token": siteSession.userToken || "",
          "X-HAXCMS-Site-Token": siteSession.siteToken,
        },
        maxBodyLength: Infinity,
        validateStatus: () => true,
        timeout: 600000,
      },
    );
    if (bulk.status !== 200) {
      throw new Error(
        "perf fixture bulk create failed (batch " +
          (i + 1) +
          "/" +
          batches.length +
          "): " +
          bulk.status +
          " " +
          JSON.stringify(bulk.data).slice(0, 300),
      );
    }
  }
  const created = await fetchSiteItems(baseUrl, target);
  if (!created || created.length < items.length) {
    throw new Error(
      "perf fixture " + target + " is missing items after create",
    );
  }
  return { name: target, items: created, reused: false };
}

// Reuse the fixture when a server already has it (repeat local runs against
// a dev server), otherwise create it.
async function ensureFixtureSite(baseUrl, credentials, name) {
  const existing = await fetchSiteItems(baseUrl, name);
  if (existing && existing.length > 0) {
    return { name: name, items: existing, reused: true };
  }
  return createFixtureSite(baseUrl, credentials, name);
}

module.exports = {
  batchOutline,
  buildOutline,
  createFixtureSite,
  ensureFixtureSite,
  fetchSiteItems,
  fixtureShape,
  login,
  pageBody,
  seededRandom,
  slugify,
};
