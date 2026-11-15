// HAXiam (config.iam) tenant isolation nightly (haxtheweb/issues#3262),
// run by .github/workflows/haxiam-nightly.yml. Plain scripting, no AI.
//
// Builds a THROWAWAY HAXiam-style layout in a temp dir (users/alice and
// users/bob, the boilerplate config.json plus iam = true as a HAXiam install
// has it, one shared SALT/.pk/.rpk like HAXiam's shared _iamConfig, random
// passwords), boots one src/app.js per tenant on localhost,
// and checks over HTTP that one user cannot list, create, read, archive,
// download, clone or edit another user's sites. Nothing live is touched.
//
// These are the same login / site creation / tenant isolation checks that
// haxtheweb/haxiam's testing/nightly/flows.php runs against haxcms-php inside
// a real HAXiam (haxcms-php's haxiam nightly). Keep the two in step.
//
// When HAX_ISSUES_TOKEN is set, files (or comments on) one open issue per
// failing check in haxtheweb/issues titled
// `[nightly] haxiam: haxcms-nodejs <check>`. Exit 1 on any failure.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_REPO = "haxtheweb/issues";
const PREFIX = "[nightly] haxiam: haxcms-nodejs ";

function log(line = "") {
  process.stdout.write(`${line}\n`);
}

const results = new Map();
let current = "setup";
function group(name) {
  current = name;
  if (!results.has(name)) {
    results.set(name, { pass: 0, fail: [] });
  }
  log(`\n## ${name}`);
}
function ok(cond, label, detail = "") {
  const r = results.get(current);
  if (cond) {
    r.pass++;
    log(`PASS  ${label}`);
  } else {
    r.fail.push(detail ? `${label} (${detail})` : label);
    log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
  return !!cond;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A throwaway tenant: its own HAXCMS_ROOT (users/<name>), shared secrets.
function makeTenant(base, name, secrets) {
  const root = path.join(base, "users", name);
  const config = path.join(root, "_config");
  fs.mkdirSync(path.join(root, "_sites"), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, ".isHAXcmsConfig"), "");
  const boilerplate = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "src/boilerplate/systemsetup/config.json"),
      "utf8",
    ),
  );
  boilerplate.iam = true;
  fs.writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify(boilerplate, null, 2),
  );
  for (const [file, value] of Object.entries(secrets)) {
    fs.writeFileSync(path.join(config, file), value, { mode: 0o600 });
  }
  return {
    name,
    root,
    password: crypto.randomBytes(18).toString("base64url"),
    port: 0,
    proc: null,
    log: "",
  };
}

async function boot(tenant) {
  tenant.port = await freePort();
  tenant.proc = spawn(process.execPath, [path.join(ROOT, "src/app.js")], {
    cwd: tenant.root,
    env: {
      ...env,
      HAXCMS_ROOT: tenant.root + path.sep,
      PORT: String(tenant.port),
      HAXCMS_RUNTIME_USERNAME: tenant.name,
      HAXCMS_RUNTIME_PASSWORD: tenant.password,
      HAX_ISSUES_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => {
    tenant.log = (tenant.log + chunk.toString()).slice(-20000);
  };
  tenant.proc.stdout.on("data", keep);
  tenant.proc.stderr.on("data", keep);
  for (let i = 0; i < 120; i++) {
    try {
      const r = await request(tenant.port, "GET", "/", {});
      if (r.status > 0) {
        return true;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

// Plain localhost HTTP request (no redirects followed).
function request(port, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: body
          ? { ...headers, "content-length": Buffer.byteLength(body) }
          : headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            text,
            setCookie: res.headers["set-cookie"] || [],
          });
        });
      },
    );
    req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body || undefined);
  });
}

// One HTTP call; remembers the refresh cookie like a browser would.
async function call(tenant, method, route, opts = {}) {
  const headers = { accept: "application/json" };
  if (opts.auth) {
    headers.authorization = `Bearer ${opts.auth.jwt}`;
    headers["x-haxcms-user-token"] = opts.auth.userToken;
    if (opts.auth.cookie) {
      headers.cookie = opts.auth.cookie;
    }
  }
  if (opts.siteToken) {
    headers["x-haxcms-site-token"] = opts.siteToken;
  }
  let body;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await request(tenant.port, method, route, headers, body);
  const text = res.text;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, setCookie: res.setCookie };
}

async function login(tenant, user, password) {
  const r = await call(tenant, "POST", "/system/api/v1/session/login", {
    body: { username: user, password },
  });
  if (r.status !== 200 || !r.json || !r.json.jwt) {
    return { ok: false, status: r.status };
  }
  const refresh = r.setCookie.find((c) =>
    c.startsWith("haxcms_refresh_token="),
  );
  return {
    ok: true,
    status: r.status,
    jwt: r.json.jwt,
    userToken: r.json.userToken,
    cookie: refresh ? refresh.split(";")[0] : "",
  };
}

// JWT + user token + a site token for siteName, from the refresh cookie.
async function refresh(tenant, auth, siteName) {
  const r = await call(tenant, "POST", "/system/api/v1/session/refresh", {
    auth: { jwt: auth.jwt, userToken: auth.userToken, cookie: auth.cookie },
    body: siteName ? { siteName } : {},
  });
  const next = r.setCookie.find((c) => c.startsWith("haxcms_refresh_token="));
  if (r.status !== 200 || !r.json || !r.json.jwt) {
    return null;
  }
  return {
    jwt: r.json.jwt,
    userToken: r.json.userToken || auth.userToken,
    siteToken: r.json.siteToken || "",
    cookie: next ? next.split(";")[0] : auth.cookie,
  };
}

function siteJson(tenant, site) {
  const file = path.join(tenant.root, "_sites", site, "site.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function denied(status) {
  return status === 401 || status === 403;
}

async function runChecks(alice, bob) {
  group("login");
  const a = await login(alice, "alice", alice.password);
  ok(a.ok, "alice signs in on her tenant", `HTTP ${a.status}`);
  const b = await login(bob, "bob", bob.password);
  ok(b.ok, "bob signs in on his tenant", `HTTP ${b.status}`);
  const cross = await login(alice, "bob", bob.password);
  ok(
    !cross.ok,
    "bob's credentials do not sign in on alice's tenant",
    `HTTP ${cross.status}`,
  );
  if (!a.ok || !b.ok) {
    return;
  }

  group("site creation");
  const ca = await call(alice, "POST", "/system/api/v1/sites", {
    auth: a,
    body: { site: { name: "alicesite", theme: "clean-one" } },
  });
  ok(
    ca.status === 200 && siteJson(alice, "alicesite"),
    "alice creates a site in her own space",
    `HTTP ${ca.status} ${ca.text.slice(0, 200)}`,
  );
  const cb = await call(bob, "POST", "/system/api/v1/sites", {
    auth: b,
    body: { site: { name: "bobsite", theme: "clean-one" } },
  });
  ok(
    cb.status === 200 && siteJson(bob, "bobsite"),
    "bob creates a site in his own space",
    `HTTP ${cb.status} ${cb.text.slice(0, 200)}`,
  );
  const list = await call(alice, "GET", "/system/api/v1/sites", { auth: a });
  const names = JSON.stringify(list.json || {});
  ok(
    list.status === 200 &&
      names.includes("alicesite") &&
      !names.includes("bobsite"),
    "alice's site list has her site and not bob's",
    `HTTP ${list.status}`,
  );

  group("tenant isolation");
  // bob holds a valid session on his tenant (same signing keys, as in HAXiam)
  // and asks his tenant for a site token naming alice's site.
  const bt = (await refresh(bob, b, "alicesite")) || b;
  let r = await call(alice, "GET", "/system/api/v1/sites", { auth: bt });
  ok(
    denied(r.status),
    "bob cannot list sites in alice's space",
    `HTTP ${r.status}`,
  );
  r = await call(alice, "POST", "/system/api/v1/sites", {
    auth: bt,
    body: { site: { name: "planted", theme: "clean-one" } },
  });
  ok(
    denied(r.status) && !siteJson(alice, "planted"),
    "bob cannot create a site in alice's space",
    `HTTP ${r.status}`,
  );
  r = await call(alice, "GET", "/system/api/v1/sites/alicesite", { auth: bt });
  ok(
    denied(r.status),
    "bob cannot read alice's site metadata",
    `HTTP ${r.status}`,
  );
  r = await call(bob, "GET", "/system/api/v1/sites/alicesite", { auth: bt });
  ok(
    r.status !== 200,
    "bob cannot reach alice's site by name through his own space",
    `HTTP ${r.status}`,
  );
  for (const op of ["archive", "download", "clone"]) {
    r = await call(alice, "POST", `/system/api/v1/sites/alicesite/${op}`, {
      auth: bt,
      body: { site: { name: "alicesite" } },
    });
    ok(
      r.status !== 200 && siteJson(alice, "alicesite"),
      `bob cannot ${op} alice's site`,
      `HTTP ${r.status}`,
    );
  }
  // site-level write: positive control first so the negative means something
  const at = await refresh(alice, a, "alicesite");
  const before = siteJson(alice, "alicesite");
  const itemId =
    before && before.items && before.items[0] ? before.items[0].id : "";
  ok(
    !!(at && at.siteToken && itemId),
    "alice gets a site token for her site and it has a first page",
  );
  const sitePath = `/_sites/alicesite/x/api/v1/items/${itemId}`;
  r = await call(alice, "PATCH", sitePath, {
    auth: at || a,
    siteToken: at ? at.siteToken : "",
    body: { operation: "setTitle", title: "Written by alice" },
  });
  const afterOwn = siteJson(alice, "alicesite");
  ok(
    r.status === 200 &&
      afterOwn &&
      afterOwn.items[0].title === "Written by alice",
    "alice can edit a page in her own site (control)",
    `HTTP ${r.status} ${r.text.slice(0, 200)}`,
  );
  r = await call(alice, "PATCH", sitePath, {
    auth: bt,
    siteToken: bt.siteToken || "",
    body: { operation: "setTitle", title: "Written by bob" },
  });
  const afterBob = siteJson(alice, "alicesite");
  ok(
    r.status !== 200 &&
      afterBob &&
      afterBob.items[0].title === "Written by alice",
    "bob cannot edit a page in alice's site, even with a site token he requested for it",
    `HTTP ${r.status}`,
  );
  r = await call(alice, "GET", "/system/api/v1/sites");
  ok(
    denied(r.status),
    "an anonymous caller cannot list alice's sites",
    `HTTP ${r.status}`,
  );
}

// GitHub REST call (node:https, same as scripts/fuzz-nightly.mjs)
function github(token, method, url, body) {
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: url,
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "haxiam-nightly",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode > 299) {
            reject(
              new Error(
                `${method} ${url} -> ${res.statusCode}: ${text.slice(0, 300)}`,
              ),
            );
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function say(line = "") {
  log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
}

async function report(failures) {
  say("## HAXiam nightly (haxcms-nodejs)");
  say();
  if (!failures.length) {
    say(
      "All login, site creation and tenant isolation checks passed (throwaway HAXiam tenants, config.iam on).",
    );
    return;
  }
  for (const [check, list] of failures) {
    say(`- **${check}**`);
    for (const f of list) {
      say(`  - ${f.replace(/\s+/g, " ")}`);
    }
  }
  say();
  const token = env.HAX_ISSUES_TOKEN || "";
  if (!token) {
    say(
      `Issue filing skipped: the \`HAX_ISSUES_TOKEN\` secret is not set here (it needs Issues: read and write on ${ISSUES_REPO}).`,
    );
    return;
  }
  const runUrl =
    env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : "";
  let open = [];
  try {
    const q = `repo:${ISSUES_REPO} is:issue is:open in:title "${PREFIX.trim()}"`;
    const search = await github(
      token,
      "GET",
      `/search/issues?per_page=100&q=${encodeURIComponent(q)}`,
    );
    open = search.items || [];
  } catch (error) {
    say(`- Searching for existing issues failed: \`${error.message}\``);
    return;
  }
  for (const [check, list] of failures) {
    const title = `${PREFIX}${check}`;
    const body = [
      "The haxcms-nodejs HAXiam nightly failed this check against throwaway HAXiam tenants (config.iam on) (localhost, no live deployment).",
      "",
      `- Check: \`${check}\``,
      `- Commit: \`${env.GITHUB_SHA || "unknown"}\``,
      runUrl ? `- Run: ${runUrl}` : "",
      "",
      "Failures:",
      "",
      "```text",
      list.join("\n"),
      "```",
      "",
      "Reproduce: `node scripts/haxiam-nightly.mjs`",
    ].join("\n");
    try {
      const existing = open.find((item) => item.title === title);
      if (existing) {
        await github(
          token,
          "POST",
          `/repos/${ISSUES_REPO}/issues/${existing.number}/comments`,
          { body },
        );
        say(`- Commented on ${existing.html_url} for \`${check}\``);
      } else {
        const created = await github(
          token,
          "POST",
          `/repos/${ISSUES_REPO}/issues`,
          {
            title,
            body: `${body}\n\nTracking: https://github.com/haxtheweb/issues/issues/3262`,
          },
        );
        say(`- Opened ${created.html_url} for \`${check}\``);
      }
    } catch (error) {
      say(`- Filing the issue for \`${check}\` failed: \`${error.message}\``);
    }
  }
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "haxiam-nightly-"));
  const secrets = {
    "SALT.txt": crypto.randomBytes(32).toString("hex"),
    ".pk": crypto.randomBytes(32).toString("hex"),
    ".rpk": crypto.randomBytes(32).toString("hex"),
  };
  const alice = makeTenant(base, "alice", secrets);
  const bob = makeTenant(base, "bob", secrets);
  try {
    group("boot");
    const up = await Promise.all([boot(alice), boot(bob)]);
    ok(up[0], "alice's tenant boots", alice.log.slice(-400));
    ok(up[1], "bob's tenant boots", bob.log.slice(-400));
    if (up[0] && up[1]) {
      await runChecks(alice, bob);
    }
  } finally {
    for (const t of [alice, bob]) {
      if (t.proc) {
        t.proc.kill();
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
  const failures = [];
  log("\n== summary");
  for (const [name, r] of results) {
    log(`${name.padEnd(18)} ${r.pass} passed, ${r.fail.length} failed`);
    if (r.fail.length) {
      failures.push([name, r.fail]);
    }
  }
  await report(failures);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
