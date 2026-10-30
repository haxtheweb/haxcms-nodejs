/**
 * Commit op codes (haxtheweb/issues#3191).
 *
 * Every commit HAXcms makes is prefixed with who made it and which API
 * operation produced it, so a site's git history becomes a replayable
 * transaction log ("recipe") and the revision history UI can explain what
 * changed a page:
 *
 *   [<actor>:<op>[:<txn>]] <message>
 *
 *   actor  H human | A agent | S system (no request)
 *   op     OpenAPI operationId (site-spec.yaml / system-spec.yaml) or a
 *          reserved op (siteCreate, direct, system, upgradeManagedFiles);
 *          letters and digits only
 *   txn    4 lowercase letters/digits, shared by every commit one request
 *          makes (an outline save's deletes, rebuilds and save group by it)
 *
 * Anything that does not match this format (commits made by hand, by other
 * tools, and every commit from before this change) parses as actor "X"
 * (external) so the UI can show it as-is. HAX never writes X.
 *
 * The actor is self-reported (X-HAX-Actor header, or HAX_ACTOR for CLI use).
 * It is for transparency only and must never be used to decide permissions.
 *
 * No version information ever goes into a commit message.
 */
const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const commitContextStorage = new AsyncLocalStorage();

// the whole message (prefix included) never exceeds this; matches the
// existing sanitizeGitCommitMessage() cap
const COMMIT_MESSAGE_MAX_LENGTH = 200;
const OP_MAX_LENGTH = 48;
const TXN_LENGTH = 4;
const ACTOR_CODES = {
  human: "H",
  h: "H",
  agent: "A",
  a: "A",
};
const WRITTEN_ACTORS = /^[HAS]$/;
const PREFIX_PATTERN =
  /^\[([HAS]):([A-Za-z][A-Za-z0-9]{0,47})(?::([a-z0-9]{4}))?\] (.*)$/;
const TXN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Keep letters and digits only. Used for every token inside the brackets so
 * nothing from a header, env var or route name can add spaces, separators or
 * brackets to the prefix.
 */
function alphanumeric(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Normalize a self-reported actor value (header or env) to H or A.
 * Anything unrecognized returns "" so the caller can apply its default.
 */
function normalizeActor(value) {
  const key = alphanumeric(value).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ACTOR_CODES, key)) {
    return ACTOR_CODES[key];
  }
  return "";
}

/**
 * An op is letters and digits, starting with a letter, at most 48 chars.
 */
function normalizeOp(value) {
  const op = alphanumeric(value).substring(0, OP_MAX_LENGTH);
  if (/^[A-Za-z]/.test(op)) {
    return op;
  }
  return "";
}

function normalizeTxn(value) {
  const txn = alphanumeric(value).toLowerCase();
  if (txn.length === TXN_LENGTH) {
    return txn;
  }
  return "";
}

/**
 * Collapse whitespace and trim the human-readable part of the message.
 */
function normalizeSummary(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function createTxn() {
  // crypto.randomInt is uniform (no modulo bias)
  let txn = "";
  for (let i = 0; i < TXN_LENGTH; i++) {
    txn += TXN_ALPHABET.charAt(crypto.randomInt(TXN_ALPHABET.length));
  }
  return txn;
}

function getHeader(req, name) {
  if (!req || !req.headers) {
    return "";
  }
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return typeof value === "string" ? value : "";
}

/**
 * Build the commit context for one API request. No X-HAX-Actor header means
 * a human, so the HAX editor works without sending anything.
 */
function createRequestCommitContext(req, op) {
  return {
    actor: normalizeActor(getHeader(req, "x-hax-actor")) || "H",
    op: normalizeOp(op),
    txn: createTxn(),
  };
}

/**
 * Run fn with a commit context; every gitCommit() inside it (including
 * across awaits) uses this context's actor, op and txn.
 */
function runWithCommitContext(context, fn) {
  return commitContextStorage.run(context, fn);
}

function getCommitContext() {
  return commitContextStorage.getStore() || null;
}

/**
 * Context for commits made outside any request (CLI scripts, maintenance).
 * HAX_ACTOR lets a CLI caller say who it is; otherwise the commit is
 * attributed to the system.
 */
function getFallbackCommitContext() {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  return {
    actor: normalizeActor(env.HAX_ACTOR || "") || "S",
    op: "",
    txn: "",
  };
}

/**
 * Format the op-code prefix, e.g. "[A:updateItem:x9r1]".
 */
function formatCommitPrefix(context) {
  const ctx = context || {};
  const actor = WRITTEN_ACTORS.test(ctx.actor || "") ? ctx.actor : "S";
  const op = normalizeOp(ctx.op || "") || "system";
  const txn = normalizeTxn(ctx.txn || "");
  return "[" + actor + ":" + op + (txn ? ":" + txn : "") + "]";
}

/**
 * Prefix an already-sanitized message. Whitespace is collapsed and trimmed,
 * and the message is cut so the whole line fits COMMIT_MESSAGE_MAX_LENGTH;
 * the prefix itself is never cut.
 *
 * opOverride replaces the context's op for a single commit (e.g. siteCreate
 * for a new site's first commit). A message that already carries a valid
 * prefix is returned unchanged so a commit is never double-prefixed.
 */
function formatCommitMessage(safeMessage, opOverride, context) {
  const message = normalizeSummary(safeMessage);
  if (PREFIX_PATTERN.test(message)) {
    return message.substring(0, COMMIT_MESSAGE_MAX_LENGTH);
  }
  const base = context || getCommitContext() || getFallbackCommitContext();
  const prefix = formatCommitPrefix({
    actor: base.actor,
    op: normalizeOp(opOverride || "") || base.op,
    txn: base.txn,
  });
  const room = COMMIT_MESSAGE_MAX_LENGTH - prefix.length - 1;
  return prefix + " " + message.substring(0, Math.max(room, 0)).trim();
}

/**
 * Parse a commit subject. Never returns null: a subject that does not match
 * the format (manual commits, other tools, all history from before op codes)
 * comes back as actor "X" with the whole subject as its summary. Older
 * HAXcms versions stored every subject wrapped in literal single quotes;
 * those are dropped from the summary.
 */
function parseCommitMessage(subject) {
  const raw = String(subject || "");
  const unquoted =
    raw.length > 1 &&
    raw.charAt(0) === "'" &&
    raw.charAt(raw.length - 1) === "'"
      ? raw.substring(1, raw.length - 1)
      : raw;
  const match = PREFIX_PATTERN.exec(unquoted);
  if (!match) {
    return {
      actor: "X",
      op: "",
      txn: "",
      summary: normalizeSummary(unquoted),
    };
  }
  return {
    actor: match[1],
    op: match[2],
    txn: match[3] || "",
    summary: normalizeSummary(match[4]),
  };
}

/**
 * Map of "<method> <registry route>" to OpenAPI operationId, read from the
 * spec files so the op vocabulary always matches the published API.
 *
 *   site registry   "patch v1/site/outline"  <- /x/api/v1/site/outline
 *   system registry "post sites"             <- /system/api/v1/sites
 */
let operationIdIndex = null;
const SPEC_SOURCES = [
  { file: "site-spec.yaml", scope: "site", prefix: "/x/api/" },
  { file: "system-spec.yaml", scope: "system", prefix: "/system/api/v1/" },
];
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

function specPathToRouteKey(specPath, prefix) {
  if (specPath.indexOf(prefix) !== 0) {
    return null;
  }
  return specPath
    .substring(prefix.length)
    .replace(/\{([^}]+)\}/g, ":$1")
    .replace(/\/$/, "");
}

function buildOperationIdIndex(specDirectory) {
  const index = { site: {}, system: {} };
  const dir = specDirectory || path.join(__dirname, "../openapi");
  for (let s = 0; s < SPEC_SOURCES.length; s++) {
    const source = SPEC_SOURCES[s];
    let spec = null;
    try {
      spec = YAML.parse(fs.readFileSync(path.join(dir, source.file), "utf8"));
    } catch {
      spec = null;
    }
    if (!spec || !spec.paths) {
      continue;
    }
    const specPaths = Object.keys(spec.paths);
    for (let p = 0; p < specPaths.length; p++) {
      const routeKey = specPathToRouteKey(specPaths[p], source.prefix);
      if (routeKey === null) {
        continue;
      }
      const pathItem = spec.paths[specPaths[p]] || {};
      for (let m = 0; m < HTTP_METHODS.length; m++) {
        const operation = pathItem[HTTP_METHODS[m]];
        if (operation && typeof operation.operationId === "string") {
          index[source.scope][HTTP_METHODS[m] + " " + routeKey] =
            operation.operationId;
        }
      }
    }
  }
  return index;
}

/**
 * Resolve the operationId for a registered route. Falls back to the method
 * plus the route key's literal segments so a route missing from the spec
 * still produces a stable op code.
 */
function getOperationId(scope, method, routeKey) {
  if (!operationIdIndex) {
    operationIdIndex = buildOperationIdIndex();
  }
  const table = operationIdIndex[scope] || {};
  const key = String(method || "").toLowerCase() + " " + String(routeKey || "");
  if (Object.prototype.hasOwnProperty.call(table, key)) {
    return normalizeOp(table[key]) || "system";
  }
  const fallback = String(routeKey || "")
    .split("/")
    .filter((part) => part !== "" && part.charAt(0) !== ":")
    .map((part) => {
      const clean = alphanumeric(part);
      return clean.charAt(0).toUpperCase() + clean.substring(1);
    })
    .join("");
  return normalizeOp(String(method || "").toLowerCase() + fallback) || "system";
}

module.exports = {
  COMMIT_MESSAGE_MAX_LENGTH,
  normalizeActor,
  normalizeOp,
  createTxn,
  createRequestCommitContext,
  runWithCommitContext,
  getCommitContext,
  getFallbackCommitContext,
  formatCommitPrefix,
  formatCommitMessage,
  parseCommitMessage,
  buildOperationIdIndex,
  getOperationId,
};
