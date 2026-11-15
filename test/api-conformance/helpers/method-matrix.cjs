"use strict";

// Method x route x auth matrix (haxtheweb/issues#3247).
//
// Builds every request a client could make against the two OpenAPI specs:
// each path, crossed with GET/HEAD/OPTIONS/POST/PUT/PATCH/DELETE, crossed
// with anonymous / invalid bearer / valid session. Shared by the Node
// conformance test and its PHP parity mode so both backends get exactly the
// same requests.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const fs = require("fs");
const YAML = require("yaml");

const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
const AUTH_STATES = ["anonymous", "invalid", "valid"];

function loadSpec(specPath) {
  return YAML.parse(fs.readFileSync(specPath, "utf8"));
}

// Public when the operation (or the spec default) has no requirement, or
// lists an empty requirement object (OpenAPI's "auth optional").
function isPublicOperation(spec, operation) {
  const security =
    operation && operation.security !== undefined
      ? operation.security
      : spec.security;
  if (!Array.isArray(security) || security.length === 0) {
    return true;
  }
  return security.some(function (requirement) {
    return !requirement || Object.keys(requirement).length === 0;
  });
}

function fillPath(template, params) {
  return template.replace(/\{([^}]*)\}/g, function (match, name) {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      return encodeURIComponent(params[name]);
    }
    return "matrix-placeholder";
  });
}

/**
 * Every (method, path, auth) cell for one spec.
 * @param {object} spec parsed OpenAPI document
 * @param {object} opts { prefix: "" | "/_sites/<name>", params: {name: value} }
 * @returns {Array<object>} cells: { id, method, template, url, auth,
 *   declared, public, skip }
 *
 * A valid session only sends declared reads plus undeclared methods: declared
 * writes with an empty body could still change the site under test, and the
 * per-route conformance tests already cover them with real payloads.
 */
function buildCells(spec, opts) {
  const cells = [];
  const paths = Object.keys(spec.paths || {}).sort();
  paths.forEach(function (template) {
    const operations = spec.paths[template] || {};
    METHODS.forEach(function (method) {
      const operation = operations[method.toLowerCase()];
      const declared = !!operation;
      // HEAD and OPTIONS are answered for GET routes by the framework, so they
      // count as declared when GET is
      const getDeclared = !!operations.get;
      AUTH_STATES.forEach(function (auth) {
        const cell = {
          id: method + " " + template + " " + auth,
          method: method,
          template: template,
          url: opts.prefix + fillPath(template, opts.params || {}),
          auth: auth,
          declared: declared,
          getDeclared: getDeclared,
          public: declared ? isPublicOperation(spec, operation) : null,
          skip: auth === "valid" && declared && MUTATING.indexOf(method) !== -1,
        };
        cells.push(cell);
      });
    });
  });
  return cells;
}

function headersFor(auth, session) {
  const headers = { Accept: "application/json" };
  if (auth === "invalid") {
    headers.Authorization = "Bearer not.a.valid.jwt";
    headers["X-HAXCMS-User-Token"] = "matrix-invalid";
    headers["X-HAXCMS-Site-Token"] = "matrix-invalid";
  } else if (auth === "valid") {
    headers.Authorization = "Bearer " + session.jwt;
    headers["X-HAXCMS-User-Token"] = session.userToken || "";
    headers["X-HAXCMS-Site-Token"] = session.siteToken || "";
  }
  return headers;
}

/**
 * Problems with one answered cell, independent of the other backend:
 * - any 5xx (the server failed instead of answering)
 * - a 2xx without credentials on an operation that requires them
 * - a 2xx for a method the spec does not declare (HEAD/OPTIONS excepted)
 */
function cellProblems(cell, status) {
  const problems = [];
  if (status >= 500) {
    problems.push("server error " + status);
  }
  const ok = status >= 200 && status < 300;
  if (
    ok &&
    cell.declared &&
    cell.public === false &&
    (cell.auth === "anonymous" || cell.auth === "invalid")
  ) {
    problems.push(status + " without valid credentials on a secured operation");
  }
  if (
    ok &&
    !cell.declared &&
    cell.method !== "HEAD" &&
    cell.method !== "OPTIONS"
  ) {
    problems.push(status + " for a method the spec does not declare");
  }
  if (ok && cell.method === "HEAD" && !cell.getDeclared && !cell.declared) {
    problems.push(status + " for HEAD on a path with no GET");
  }
  return problems;
}

// Allow-list entries match on method / path template / auth ("*" = any) and
// carry a reason. Returns the matching entry or null.
function findAllowed(allowList, cell, kind) {
  const entries = (allowList && allowList[kind]) || [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (
      (e.method === "*" || e.method === cell.method) &&
      (e.path === "*" || e.path === cell.template) &&
      (e.auth === "*" || e.auth === cell.auth)
    ) {
      return e;
    }
  }
  return null;
}

// Status codes from two backends for the same cell: identical, or the pair
// is allow-listed.
function parityProblem(cell, nodeStatus, phpStatus, allowList) {
  if (nodeStatus === phpStatus) {
    return null;
  }
  const allowed = findAllowed(allowList, cell, "parity");
  if (
    allowed &&
    (!allowed.node || allowed.node.indexOf(nodeStatus) !== -1) &&
    (!allowed.php || allowed.php.indexOf(phpStatus) !== -1)
  ) {
    return null;
  }
  return cell.id + ": node " + nodeStatus + ", php " + phpStatus;
}

module.exports = {
  AUTH_STATES,
  METHODS,
  buildCells,
  cellProblems,
  fillPath,
  findAllowed,
  headersFor,
  isPublicOperation,
  loadSpec,
  parityProblem,
};
