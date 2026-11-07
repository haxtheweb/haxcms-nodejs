"use strict";

// OpenAPI contract: route map vs spec
//
// haxcms-nodejs and haxcms-php must answer the same API, and the OpenAPI
// specs in src/openapi are the contract both are held to. These checks keep
// the Node route registry and the specs from drifting apart, with no server
// boot:
//   - every system route Node registers is documented in system-spec.yaml,
//     and every documented system operation is registered (the one known
//     PHP-only operation is listed explicitly)
//   - auth declarations match the router: open routes never require a
//     bearer JWT, every other system operation does, and no route is both
//     open and admin
//   - every site-spec operation under /x/api/v1 has a registered handler
//   - operationIds are unique in each spec
//   - the system discovery endpoint (systemRoutes/discovery/openapi.js)
//     serves the spec file verbatim at /openapi, the parsed spec at .json,
//     YAML at .yaml and ?format=yaml, and a generic 500 (no filesystem path)
//     when the file cannot be read
//   - the site discovery endpoint negotiates YAML/JSON from the Accept
//     header and the ?format aliases, and answers a generic 500 when the
//     spec cannot be read
//
// Parity: haxcms-php carries a test under the same name that holds its
// router to the same two spec files. CommonJS, globalThis, NO optional
// chaining, node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodeFsPromises = require("node:fs/promises");
const path = require("path");
const yaml = require("js-yaml");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SYSTEM_SPEC_PATH = path.join(
  REPO_ROOT,
  "src",
  "openapi",
  "system-spec.yaml",
);
const SITE_SPEC_PATH = path.join(REPO_ROOT, "src", "openapi", "site-spec.yaml");

const {
  SystemRoutesMap,
  SystemV1OpenRoutes,
  SystemV1AdminRoutes,
} = require("../../src/lib/SystemRoutesMap.js");
const { SiteRoutesMap } = require("../../src/lib/SiteRoutesMap.js");
const systemOpenapi = require("../../src/systemRoutes/discovery/openapi.js");
const siteOpenapi = require("../../src/siteRoutes/discovery/openapi.js");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const SYSTEM_BASE = "/system/api/v1";
// documented for cross-platform parity, implemented only by haxcms-php
// (HAXiam-managed deployments); see its description in system-spec.yaml
const PHP_ONLY_SYSTEM_OPERATIONS = ["post /system/api/v1/haxiamAddUserAccess"];

const systemSpecRaw = fs.readFileSync(SYSTEM_SPEC_PATH, "utf8");
const systemSpec = yaml.load(systemSpecRaw);
const siteSpec = yaml.load(fs.readFileSync(SITE_SPEC_PATH, "utf8"));

// "/system/api/v1/sites/{siteName}/clone" -> segments with params as "*"
function toPattern(specPath) {
  return specPath
    .split("/")
    .filter((s) => s !== "")
    .map((s) => (s.charAt(0) === "{" || s.charAt(0) === ":" ? "*" : s));
}

function patternsMatch(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && a[i] !== "*" && b[i] !== "*") {
      return false;
    }
  }
  return true;
}

function specOperations(spec) {
  const ops = [];
  Object.keys(spec.paths).forEach((specPath) => {
    HTTP_METHODS.forEach((method) => {
      const op = spec.paths[specPath][method];
      if (op && typeof op === "object") {
        ops.push({ method: method, path: specPath, op: op });
      }
    });
  });
  return ops;
}

function systemRoutePath(route) {
  return SYSTEM_BASE + (route === "" ? "" : "/" + route);
}

function registeredSystemOps() {
  const ops = [];
  Object.keys(SystemRoutesMap).forEach((method) => {
    Object.keys(SystemRoutesMap[method]).forEach((route) => {
      ops.push({ method: method, route: route, path: systemRoutePath(route) });
    });
  });
  return ops;
}

function requiresBearer(op) {
  return (
    Array.isArray(op.security) &&
    op.security.some(
      (req) => req && Object.prototype.hasOwnProperty.call(req, "bearerAuth"),
    )
  );
}

function stubRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.body = obj;
      return this;
    },
  };
}

describe("OpenAPI contract: route map vs system-spec", () => {
  test("every registered system route is documented", () => {
    const ops = specOperations(systemSpec);
    const missing = registeredSystemOps().filter(
      (r) =>
        !ops.some(
          (o) =>
            o.method === r.method &&
            patternsMatch(toPattern(o.path), toPattern(r.path)),
        ),
    );
    assert.deepEqual(
      missing.map((r) => r.method + " " + r.path),
      [],
      "registered in SystemRoutesMap but missing from system-spec.yaml",
    );
  });

  test("every documented system operation is registered (PHP-only listed)", () => {
    const registered = registeredSystemOps();
    const missing = specOperations(systemSpec)
      .filter(
        (o) =>
          !registered.some(
            (r) =>
              r.method === o.method &&
              patternsMatch(toPattern(o.path), toPattern(r.path)),
          ),
      )
      .map((o) => o.method + " " + o.path);
    assert.deepEqual(missing, PHP_ONLY_SYSTEM_OPERATIONS);
  });

  test("open routes never require a bearer JWT", () => {
    const offenders = specOperations(systemSpec)
      .filter(
        (o) =>
          SystemV1OpenRoutes.indexOf(
            o.path.replace(/^\/system\/api\/v1\/?/, ""),
          ) !== -1,
      )
      .filter((o) => requiresBearer(o.op))
      .map((o) => o.method + " " + o.path);
    assert.deepEqual(offenders, []);
  });

  test("every non-open system operation declares bearer auth", () => {
    const offenders = specOperations(systemSpec)
      .filter(
        (o) =>
          SystemV1OpenRoutes.indexOf(
            o.path.replace(/^\/system\/api\/v1\/?/, ""),
          ) === -1,
      )
      .filter((o) => !requiresBearer(o.op))
      .map((o) => o.method + " " + o.path);
    assert.deepEqual(offenders, []);
  });

  test("no route is both open and admin, and every listed route exists", () => {
    const both = SystemV1OpenRoutes.filter(
      (r) => SystemV1AdminRoutes.indexOf(r) !== -1,
    );
    assert.deepEqual(both, []);
    const registeredRoutes = registeredSystemOps().map((r) => r.route);
    const listed = SystemV1OpenRoutes.concat(SystemV1AdminRoutes);
    assert.deepEqual(
      listed.filter((r) => registeredRoutes.indexOf(r) === -1),
      [],
      "open/admin lists name only registered routes",
    );
  });

  test("operationIds are unique in each spec", () => {
    [systemSpec, siteSpec].forEach((spec) => {
      const seen = {};
      const dupes = [];
      specOperations(spec).forEach((o) => {
        if (o.op.operationId) {
          if (seen[o.op.operationId]) {
            dupes.push(o.op.operationId);
          }
          seen[o.op.operationId] = true;
        }
      });
      assert.deepEqual(dupes, [], spec.info.title);
    });
  });
});

describe("OpenAPI contract: route map vs site-spec", () => {
  test("every documented /x/api/v1 operation has a registered handler", () => {
    const registered = [];
    Object.keys(SiteRoutesMap).forEach((method) => {
      Object.keys(SiteRoutesMap[method]).forEach((route) => {
        if (typeof SiteRoutesMap[method][route] === "function") {
          registered.push({
            method: method,
            pattern: toPattern("/x/api/" + route),
          });
        }
      });
    });
    const missing = specOperations(siteSpec)
      .filter((o) => o.path.indexOf("/x/api/v1/") === 0)
      .filter(
        (o) =>
          !registered.some(
            (r) =>
              r.method === o.method &&
              patternsMatch(r.pattern, toPattern(o.path)),
          ),
      )
      .map((o) => o.method + " " + o.path);
    assert.deepEqual(missing, []);
  });
});

describe("OpenAPI contract: system discovery endpoint", () => {
  test("/openapi serves the spec file verbatim as YAML", async () => {
    const res = stubRes();
    await systemOpenapi(
      { originalUrl: SYSTEM_BASE + "/openapi", query: {} },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers["Content-Type"],
      "application/yaml; charset=utf-8",
    );
    assert.equal(res.body, systemSpecRaw);
  });

  test("/openapi.json serves the parsed spec", async () => {
    const res = stubRes();
    await systemOpenapi(
      { originalUrl: SYSTEM_BASE + "/openapi.json?x=1", query: {} },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers["Content-Type"],
      "application/json; charset=utf-8",
    );
    assert.deepEqual(res.body, systemSpec);
  });

  test("/openapi.yaml, .yml and ?format=yaml|yml serve equivalent YAML", async () => {
    const reqs = [
      { originalUrl: SYSTEM_BASE + "/openapi.yaml", query: {} },
      { url: SYSTEM_BASE + "/openapi.yml", query: {} },
      { originalUrl: SYSTEM_BASE + "/spec", query: { format: "YAML" } },
      { originalUrl: SYSTEM_BASE + "/spec", query: { format: "yml" } },
    ];
    for (let i = 0; i < reqs.length; i++) {
      const res = stubRes();
      await systemOpenapi(reqs[i], res);
      assert.equal(
        res.headers["Content-Type"],
        "application/yaml; charset=utf-8",
        JSON.stringify(reqs[i]),
      );
      assert.deepEqual(
        yaml.load(res.body),
        systemSpec,
        JSON.stringify(reqs[i]),
      );
    }
  });

  test("?format=json or an unknown format falls back to JSON", async () => {
    const reqs = [
      { originalUrl: SYSTEM_BASE + "/spec", query: { format: "json" } },
      { originalUrl: SYSTEM_BASE + "/spec", query: { format: "xml" } },
      {},
    ];
    for (let i = 0; i < reqs.length; i++) {
      const res = stubRes();
      await systemOpenapi(reqs[i], res);
      assert.equal(
        res.headers["Content-Type"],
        "application/json; charset=utf-8",
      );
      assert.deepEqual(res.body, systemSpec);
    }
  });

  test("an unreadable spec is a 500 that does not leak a filesystem path", async (t) => {
    t.mock.method(nodeFsPromises, "readFile", async () => {
      const err = new Error(
        "ENOENT: no such file, open '" + SYSTEM_SPEC_PATH + "'",
      );
      err.code = "ENOENT";
      throw err;
    });
    const res = stubRes();
    await systemOpenapi(
      { originalUrl: SYSTEM_BASE + "/openapi.json", query: {} },
      res,
    );
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.status, 500);
    assert.equal(typeof res.body.error, "string");
    assert.equal(
      res.body.error.indexOf(REPO_ROOT),
      -1,
      "no repo path in the error",
    );
    assert.equal(res.body.error.indexOf("openapi/system-spec.yaml"), -1);
  });

  test("a spec that parses to nothing is a 500", async (t) => {
    t.mock.method(nodeFsPromises, "readFile", async () => "");
    const res = stubRes();
    await systemOpenapi(
      { originalUrl: SYSTEM_BASE + "/openapi.json", query: {} },
      res,
    );
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.status, 500);
  });
});

describe("OpenAPI contract: site discovery endpoint negotiation", () => {
  function siteReq(overrides) {
    return Object.assign(
      {
        headers: {},
        query: {},
        originalUrl: "/_sites/demo/x/api/openapi",
        url: "/_sites/demo/x/api/openapi",
      },
      overrides || {},
    );
  }

  test("Accept: application/yaml, x-yaml or text/yaml serves YAML", async () => {
    const accepts = ["application/yaml", "application/x-yaml", "text/yaml"];
    for (let i = 0; i < accepts.length; i++) {
      const res = stubRes();
      await siteOpenapi(siteReq({ headers: { accept: accepts[i] } }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(
        res.headers["Content-Type"],
        "application/yaml; charset=utf-8",
        accepts[i],
      );
      assert.equal(yaml.load(res.body).openapi, siteSpec.openapi);
    }
  });

  test("Accept: JSON (plain or OAI vendor type) and no Accept serve JSON", async () => {
    const accepts = [
      "application/json",
      "application/vnd.oai.openapi+json;version=3.0",
      "",
    ];
    for (let i = 0; i < accepts.length; i++) {
      const res = stubRes();
      await siteOpenapi(
        siteReq({ headers: accepts[i] ? { accept: accepts[i] } : {} }),
        res,
      );
      assert.equal(res.statusCode, 200);
      assert.equal(
        res.headers["Content-Type"],
        "application/json; charset=utf-8",
        accepts[i],
      );
      const parsed = JSON.parse(res.body);
      assert.deepEqual(
        Object.keys(parsed.paths).sort(),
        Object.keys(siteSpec.paths).sort(),
      );
    }
  });

  test("?format aliases win over the Accept header", async () => {
    const cases = [
      {
        format: "yml",
        type: "application/yaml; charset=utf-8",
        accept: "application/json",
      },
      {
        format: "text/yaml",
        type: "application/yaml; charset=utf-8",
        accept: "application/json",
      },
      {
        format: "application/json",
        type: "application/json; charset=utf-8",
        accept: "application/yaml",
      },
      {
        format: "application/vnd.oai.openapi+json",
        type: "application/json; charset=utf-8",
        accept: "text/yaml",
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const res = stubRes();
      await siteOpenapi(
        siteReq({
          query: { format: cases[i].format },
          headers: { accept: cases[i].accept },
        }),
        res,
      );
      assert.equal(res.headers["Content-Type"], cases[i].type, cases[i].format);
    }
  });

  test("an unknown ?format falls through to the Accept header", async () => {
    const res = stubRes();
    await siteOpenapi(
      siteReq({ query: { format: "xml" }, headers: { accept: "text/yaml" } }),
      res,
    );
    assert.equal(
      res.headers["Content-Type"],
      "application/yaml; charset=utf-8",
    );
  });

  test("an unreadable site spec is a generic 500", async (t) => {
    t.mock.method(fs.promises, "readFile", async () => {
      throw new Error("EACCES: " + SITE_SPEC_PATH);
    });
    const res = stubRes();
    await siteOpenapi(siteReq(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, {
      status: 500,
      data: { message: "Failed to load site OpenAPI specification" },
    });
  });
});
