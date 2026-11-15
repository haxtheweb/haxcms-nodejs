"use strict";

// Method x route x auth matrix (haxtheweb/issues#3247).
//
// Sends every method to every path in both OpenAPI specs, as an anonymous
// caller, with an invalid bearer, and with a valid session (reads and
// undeclared methods only), against an isolated haxcms-nodejs server. Every
// answer must be a 4xx or 2xx, never a 5xx or a dropped connection; secured
// operations must not answer 2xx without credentials; undeclared methods must
// not answer 2xx. An anonymous HEAD crashed the server once (#3236); this is
// the systematic version of that accident.
//
// PHP parity: with HAXCMS_PHP_BASE_URL set (e.g. https://haxcms.ddev.site),
// the same requests go to haxcms-php too and the status codes must match,
// except pairs listed with a reason in method-matrix-allowlist.json. Also set
// HAXCMS_PHP_USERNAME / HAXCMS_PHP_PASSWORD and HAXCMS_PHP_TEST_SITE (default
// "blog") for the valid-session column.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const https = require("node:https");
const axios = require("axios");

const {
  buildCells,
  cellProblems,
  findAllowed,
  headersFor,
  loadSpec,
  parityProblem,
} = require("./helpers/method-matrix.cjs");
const {
  setupE2ERuntime,
  teardownE2ERuntime,
} = require("../e2e/helpers/harness.cjs");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SYSTEM_SPEC = loadSpec(
  path.join(REPO_ROOT, "src/openapi/system-spec.yaml"),
);
const SITE_SPEC = loadSpec(path.join(REPO_ROOT, "src/openapi/site-spec.yaml"));
const ALLOW_LIST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "method-matrix-allowlist.json"), "utf8"),
);
const SITE_NAME = "methodmatrix";
// every request must be answered; a request that takes longer than this
// counts as no answer (a hang)
const REQUEST_TIMEOUT_MS = 20000;
const VERBOSE = process.env.HAXCMS_METHOD_MATRIX_VERBOSE === "1";
const PHP_BASE_URL = process.env.HAXCMS_PHP_BASE_URL || "";

// DDEV serves PHP over a self-signed certificate
const INSECURE_LOCAL_AGENT = new https.Agent({ rejectUnauthorized: false });

async function send(baseUrl, cell, session) {
  const hasBody =
    ["POST", "PUT", "PATCH", "DELETE"].indexOf(cell.method) !== -1;
  const headers = headersFor(cell.auth, session);
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  try {
    const response = await axios({
      method: cell.method,
      url: baseUrl + cell.url,
      headers: headers,
      data: hasBody ? "{}" : undefined,
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
      responseType: "arraybuffer",
      validateStatus: () => true,
      httpsAgent: INSECURE_LOCAL_AGENT,
    });
    return response.status;
  } catch (err) {
    // no HTTP answer at all: reset, hang, crash
    return "no response: " + (err && err.code ? err.code : String(err));
  }
}

async function alive(baseUrl) {
  const response = await axios.get(baseUrl + "/system/api/v1/status", {
    validateStatus: () => true,
    timeout: 10000,
    httpsAgent: INSECURE_LOCAL_AGENT,
  });
  return response.status < 500;
}

function cellsFor(siteName, itemSlug) {
  const params = {
    siteName: siteName,
    idOrSlug: itemSlug,
    format: "json",
    code: "en",
    themeName: "clean-two",
    webcomponentName: "accent-card",
    regionName: "header",
    report: "matrix-placeholder",
  };
  return buildCells(SYSTEM_SPEC, { prefix: "", params: params }).concat(
    buildCells(SITE_SPEC, { prefix: "/_sites/" + siteName, params: params }),
  );
}

// Run every cell against one backend. Returns { statuses: {id: status}, problems }
async function runMatrix(baseUrl, cells, session) {
  const statuses = {};
  const problems = [];
  let lastTemplate = null;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.skip) {
      continue;
    }
    if (cell.auth === "valid" && !session) {
      continue;
    }
    const started = Date.now();
    const status = await send(baseUrl, cell, session);
    statuses[cell.id] = status;
    if (VERBOSE) {
      process.stdout.write(
        "# " +
          cell.id +
          " -> " +
          status +
          " (" +
          (Date.now() - started) +
          " ms)\n",
      );
    }
    const found =
      typeof status === "number" ? cellProblems(cell, status) : [status];
    found.forEach(function (problem) {
      const allowed = findAllowed(ALLOW_LIST, cell, "problems");
      if (!allowed) {
        problems.push(cell.id + ": " + problem);
      }
    });
    // the server must still be up after every path's requests
    if (cell.template !== lastTemplate) {
      lastTemplate = cell.template;
      if (!(await alive(baseUrl))) {
        problems.push("server stopped answering after " + cell.id);
        break;
      }
    }
  }
  return { statuses: statuses, problems: problems };
}

let runtime = null;
let nodeSession = null;
let nodeCells = null;
let nodeResult = null;

async function login(baseUrl, credentials, siteName) {
  const response = await axios.post(baseUrl + "/system/api/v1/session/login", {
    username: credentials.username,
    password: credentials.password,
    site: { name: siteName },
  });
  return response.data;
}

// a small site with a few pages, created through the API
async function createSite(baseUrl, credentials, siteName) {
  const session = await login(baseUrl, credentials, siteName);
  const created = await axios.post(
    baseUrl + "/system/api/v1/sites",
    {
      site: { name: siteName, theme: "clean-two" },
      build: { type: "website", structure: "course" },
    },
    {
      headers: {
        Authorization: "Bearer " + session.jwt,
        "X-HAXCMS-User-Token": session.userToken,
      },
    },
  );
  assert.equal(created.status, 200);
  const siteSession = await login(baseUrl, credentials, siteName);
  await axios.post(
    baseUrl + "/_sites/" + siteName + "/x/api/v1/items",
    {
      site: { name: siteName },
      items: [
        {
          id: "item-matrix-1",
          title: "Matrix one",
          parent: null,
          indent: 0,
          order: 1,
          contents: "<p>one</p>",
        },
        {
          id: "item-matrix-2",
          title: "Matrix two",
          parent: "item-matrix-1",
          indent: 1,
          order: 0,
          contents: "<p>two</p>",
        },
      ],
    },
    {
      headers: {
        Authorization: "Bearer " + siteSession.jwt,
        "X-HAXCMS-User-Token": siteSession.userToken,
        "X-HAXCMS-Site-Token": siteSession.siteToken,
      },
    },
  );
  const manifest = await axios.get(
    baseUrl + "/_sites/" + siteName + "/site.json",
  );
  return manifest.data.items;
}

test.before(async () => {
  runtime = await setupE2ERuntime();
  const items = await createSite(
    runtime.baseUrl,
    runtime.credentials,
    SITE_NAME,
  );
  nodeSession = await login(runtime.baseUrl, runtime.credentials, SITE_NAME);
  nodeCells = cellsFor(SITE_NAME, items[items.length - 1].slug);
});

test.after(async () => {
  await teardownE2ERuntime(runtime);
});

test("matrix covers every path, method and auth state in both specs", () => {
  const paths =
    Object.keys(SYSTEM_SPEC.paths).length + Object.keys(SITE_SPEC.paths).length;
  assert.equal(nodeCells.length, paths * 7 * 3);
  assert.ok(nodeCells.filter((c) => !c.skip).length > paths * 7 * 2);
});

test("haxcms-nodejs: no 5xx, no auth bypass, no undeclared 2xx, still alive", async () => {
  nodeResult = await runMatrix(runtime.baseUrl, nodeCells, nodeSession);
  if (process.env.HAXCMS_METHOD_MATRIX_OUT) {
    fs.writeFileSync(
      process.env.HAXCMS_METHOD_MATRIX_OUT,
      JSON.stringify(nodeResult.statuses, null, 2) + "\n",
    );
  }
  assert.deepEqual(nodeResult.problems, []);
  assert.ok(await alive(runtime.baseUrl));
});

test("static site files and build assets refuse writes with 405", async () => {
  const urls = [
    "/_sites/" + SITE_NAME + "/site.json",
    "/_sites/" + SITE_NAME + "/manifest.json",
    "/_sites/" + SITE_NAME + "/.well-known/api-catalog",
    "/_sites/" +
      SITE_NAME +
      "/build/es6/node_modules/@haxtheweb/utils/utils.js",
  ];
  for (const url of urls) {
    const read = await axios.get(runtime.baseUrl + url, {
      validateStatus: () => true,
      responseType: "arraybuffer",
    });
    assert.equal(read.status, 200, "GET " + url);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const write = await axios({
        method: method,
        url: runtime.baseUrl + url,
        data: "{}",
        headers: { "Content-Type": "application/json" },
        validateStatus: () => true,
      });
      assert.equal(write.status, 405, method + " " + url);
      assert.equal(
        write.headers.allow,
        "GET, HEAD, OPTIONS",
        method + " " + url,
      );
    }
  }
  // the site's own file is untouched
  const after = await axios.get(
    runtime.baseUrl + "/_sites/" + SITE_NAME + "/site.json",
  );
  assert.ok(Array.isArray(after.data.items) && after.data.items.length > 1);
});

test("allow-list entries all carry a reason", () => {
  ["problems", "parity"].forEach((kind) => {
    (ALLOW_LIST[kind] || []).forEach((entry) => {
      assert.ok(
        typeof entry.reason === "string" && entry.reason.length > 10,
        kind + " entry needs a reason: " + JSON.stringify(entry),
      );
      ["method", "path", "auth"].forEach((key) => {
        assert.equal(
          typeof entry[key],
          "string",
          key + " in " + JSON.stringify(entry),
        );
      });
    });
  });
});

test(
  "haxcms-php answers the same status codes",
  {
    skip:
      PHP_BASE_URL === ""
        ? "set HAXCMS_PHP_BASE_URL to compare with haxcms-php"
        : false,
  },
  async () => {
    const phpBase = PHP_BASE_URL.replace(/\/+$/, "");
    const phpSite = process.env.HAXCMS_PHP_TEST_SITE || "blog";
    const siteJson = await axios.get(
      phpBase + "/_sites/" + phpSite + "/site.json",
      {
        httpsAgent: INSECURE_LOCAL_AGENT,
      },
    );
    const items = siteJson.data.items || [];
    assert.ok(items.length > 1, "PHP test site needs at least two pages");
    let phpSession = null;
    if (process.env.HAXCMS_PHP_USERNAME && process.env.HAXCMS_PHP_PASSWORD) {
      const response = await axios.post(
        phpBase + "/system/api/v1/session/login",
        {
          username: process.env.HAXCMS_PHP_USERNAME,
          password: process.env.HAXCMS_PHP_PASSWORD,
          site: { name: phpSite },
        },
        { httpsAgent: INSECURE_LOCAL_AGENT },
      );
      phpSession = response.data;
    }
    // same requests, PHP's site and page in the path; compare by cell id
    const phpCells = cellsFor(phpSite, items[1].slug);
    const phpResult = await runMatrix(phpBase, phpCells, phpSession);
    assert.deepEqual(phpResult.problems, [], "haxcms-php problems");
    const drift = [];
    Object.keys(phpResult.statuses).forEach((id) => {
      if (!Object.prototype.hasOwnProperty.call(nodeResult.statuses, id)) {
        return;
      }
      const cell = phpCells.find((c) => c.id === id);
      const problem = parityProblem(
        cell,
        nodeResult.statuses[id],
        phpResult.statuses[id],
        ALLOW_LIST,
      );
      if (problem) {
        drift.push(problem);
      }
    });
    assert.deepEqual(drift, [], "status codes differ between backends");
  },
);
