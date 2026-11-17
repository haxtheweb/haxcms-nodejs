"use strict";

// DRAFT plugin platform (contingent on https://github.com/haxtheweb/haxcms-plugins/pull/15).
//
// Runs the spec's backend fixtures against a REAL site in a temp HAXCMS_ROOT (no catalog plugin is needed):
//   - saveNode fires page.before.save: fx-backend stores its declared metadata.plugins field in site.json,
//     and a vetoing plugin (fx-vetoer) stops the write with 409
//   - updateAlternateFormats fires rebuild.after: fx-backend writes its managed file into the site folder
//   - deleteNode fires page.before.delete (veto) and page.after.delete
//   - plugin operations are mounted under x/api/v1/plugins/<id>/: fx-backend's notes keep personal data at the
//     spec's siteData path, and security comes from the operation's declaration
//   - /.well-known/<reserved name>: fx-well-known answers once its required issuer is set
//
// Constraints honored: CommonJS (.cjs), require(), node:test + node:assert/strict, no optional chaining.

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-platform-"));
process.env.HAXCMS_ROOT = testRoot + "/";
const spec = path.dirname(
  require.resolve("@haxtheweb/haxcms-plugin-spec/package.json"),
);
process.env.HAXCMS_PLUGIN_DIRS = [
  path.join(spec, "conformance", "fixtures", "fx-backend"),
  path.join(spec, "conformance", "fixtures", "fx-vetoer"),
  path.join(spec, "examples", "example"),
  path.join(spec, "conformance", "fixtures", "fx-well-known"),
].join(path.delimiter);

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveNode = require("../../src/siteRoutes/v1/routes/saveNode.js");
const deleteNode = require("../../src/siteRoutes/v1/routes/deleteNode.js");
const pluginSystem = require("../../src/lib/plugins/pluginSystem.js");
const { mountPluginRoutes } = require("../../src/lib/plugins/pluginRoutes.js");

test.after(() => {
  fs.removeSync(testRoot);
});

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.sent = obj;
      return this;
    },
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
  };
}

function siteReq(site, body) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    query: {},
    params: {},
    body: Object.assign(
      { site: { name: site.manifest.metadata.site.name } },
      body,
    ),
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "admin",
      siteName: site.manifest.metadata.site.name,
    },
  };
}

let site;
before(async () => {
  site = await HAXCMS.loadSite("plugin-demo", true);
  assert.ok(site && site.manifest, "site created");
});

function freshSite() {
  return HAXCMS.loadSite("plugin-demo");
}

describe("plugin discovery", () => {
  // the tier names are the spec's (spec/03); an unknown tier name sorted as NaN and broke tier precedence
  test("HAXCMS_PLUGIN_DIRS plugins load in the system-contrib tier", async () => {
    pluginSystem.reset();
    const h = await pluginSystem.host(await freshSite(), { user: null });
    assert.equal(h.get("fx-vetoer").tier, "system-contrib");
    const { dirs } = pluginSystem.pluginDirsFor(null, testRoot);
    for (const d of dirs)
      assert.ok(
        [
          "haxiam-core",
          "haxiam-contrib",
          "system-core",
          "system-contrib",
          "site",
        ].includes(d.tier),
        `${d.path}: ${d.tier}`,
      );
  });
});

describe("core save points fire plugin hooks", () => {
  test("page.before.save: fx-backend adds its declared field; it lands in site.json", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await freshSite();
    const page = s.manifest.items[0];
    const words = new Array(410).fill("word").join(" ");
    const res = stubRes();
    await saveNode(
      siteReq(s, {
        node: {
          id: page.id,
          body: `<page-break title="Reading" published></page-break><p>${words}</p>`,
        },
      }),
      res,
    );
    assert.equal(res.statusCode, null, JSON.stringify(res.body));
    assert.equal(res.sent.status, 200);
    const stored = JSON.parse(
      fs.readFileSync(path.join(s.siteDirectory, "site.json"), "utf8"),
    );
    const item = stored.items.find((i) => i.id === page.id);
    assert.deepEqual(item.metadata.plugins["fx-backend"], { words: 410 });
  });

  test("page.before.save: a veto stops the write with 409 and the file is unchanged", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await freshSite();
    const page = s.manifest.items[0];
    const before = fs.readFileSync(
      path.join(s.siteDirectory, page.location),
      "utf8",
    );
    const res = stubRes();
    await saveNode(
      siteReq(s, {
        node: {
          id: page.id,
          body: '<page-break title="Forbidden thing"></page-break><p>nope</p>',
        },
      }),
      res,
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.message, "fx-vetoer: forbidden");
    assert.equal(
      fs.readFileSync(path.join(s.siteDirectory, page.location), "utf8"),
      before,
    );
  });

  test("rebuild.after: fx-backend writes its managed file into the site folder after core rewrites its files", async () => {
    const s = await freshSite();
    await s.updateAlternateFormats();
    const list = fs.readFileSync(
      path.join(s.siteDirectory, "fx-backend.txt"),
      "utf8",
    );
    // the titles of the listed pages, one per line
    assert.match(list, /^Reading$/m);
  });

  test("page.before.delete: a veto keeps the page; page.after.delete runs after a delete", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await freshSite();
    // a page the vetoer refuses to delete; added straight to site.json because the vetoer also refuses to save it
    const first = s.manifest.items[0];
    const item = JSON.parse(JSON.stringify(first));
    item.id = "item-forbidden";
    item.title = "Forbidden page";
    item.slug = "forbidden-page";
    item.location = "pages/forbidden-page/index.html";
    fs.outputFileSync(path.join(s.siteDirectory, item.location), "<p>x</p>");
    item.order = 99;
    s.manifest.items.push(item);
    await s.manifest.save(false);
    const s2 = await freshSite();
    const res = stubRes();
    await deleteNode(siteReq(s2, { node: { id: "item-forbidden" } }), res);
    assert.equal(res.statusCode, 409);
    const s3 = await freshSite();
    assert.ok(s3.loadNode("item-forbidden"), "still there");
  });

  test("page.after.delete: an allowed delete removes the page and the after hook sees it", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await freshSite();
    const item = JSON.parse(JSON.stringify(s.manifest.items[0]));
    item.id = "item-ok-delete";
    item.title = "Plain page";
    item.slug = "plain-page";
    item.location = "pages/plain-page/index.html";
    fs.outputFileSync(path.join(s.siteDirectory, item.location), "<p>x</p>");
    item.order = 100;
    s.manifest.items.push(item);
    await s.manifest.save(false);
    const res = stubRes();
    await deleteNode(
      siteReq(await freshSite(), { node: { id: "item-ok-delete" } }),
      res,
    );
    assert.equal(res.statusCode, null, JSON.stringify(res.body));
    const s3 = await freshSite();
    assert.ok(!s3.loadNode("item-ok-delete"), "gone");
  });
});

describe("plugin operations are mounted under x/api/v1/plugins/<id>/", () => {
  function mount() {
    const routes = [];
    const app = {
      all: (p, h) => routes.push({ p, h }),
      get: (p, h) => routes.push({ p, h, get: true }),
      post: (p, h) => routes.push({ p, h, post: true }),
    };
    let authState = {
      userName: "admin",
      jwt: true,
      userToken: false,
      siteToken: true,
    };
    mountPluginRoutes(app, {
      basePath: "/",
      sitesDirectory: "_sites",
      resolveSite: async () => freshSite(),
      resolveAuth: () => authState,
    });
    const siteRoute = routes.find((r) => r.p === "/x/api/v1/plugins/:plugin/*");
    const get = async (p, auth) => {
      authState = auth || {
        userName: "admin",
        jwt: true,
        userToken: false,
        siteToken: true,
      };
      const res = stubRes();
      let nextCalled = false;
      const route =
        routes.find(
          (r) => r.p === "/x/api/v1/plugins/contributions" && p === r.p,
        ) ||
        routes.find(
          (r) => r.p === "/.well-known/:name" && p.startsWith("/.well-known/"),
        );
      await route.h(
        {
          method: "GET",
          params: { name: p.split("/").pop() },
          query: {},
          body: {},
          headers: {},
        },
        res,
        () => {
          nextCalled = true;
        },
      );
      res.nextCalled = nextCalled;
      return res;
    };
    return {
      get,
      call: async (method, plugin, rest, body, auth) => {
        authState = auth || {
          userName: "admin",
          jwt: true,
          userToken: false,
          siteToken: true,
        };
        const res = stubRes();
        await siteRoute.h(
          {
            method,
            params: { plugin, 0: rest },
            query: {},
            body: body || {},
            headers: {},
          },
          res,
        );
        return res;
      },
    };
  }

  test("notes: create and list through the route; personal data at the siteData path", async () => {
    const r = mount();
    const s = await freshSite();
    const pageId = s.manifest.items[0].id;
    const created = await r.call(
      "POST",
      "fx-backend",
      `pages/${pageId}/notes`,
      { body: "Nice page" },
    );
    assert.equal(created.statusCode, 200, JSON.stringify(created.body));
    assert.equal(created.body.body, "Nice page");
    const listed = await r.call("GET", "fx-backend", `pages/${pageId}/notes`);
    assert.equal(listed.body.length, 1);
    const file = path.join(
      testRoot,
      "_config",
      "siteData",
      s.manifest.id,
      "fx-backend",
      "notes.json",
    );
    assert.ok(fs.existsSync(file), file);
    assert.equal(
      JSON.parse(fs.readFileSync(file, "utf8"))[0].authorId,
      "admin",
    );
  });

  test("security comes from the operation: a visitor cannot post; an unknown path is 404", async () => {
    const r = mount();
    const s = await freshSite();
    const pageId = s.manifest.items[0].id;
    const visitor = await r.call(
      "POST",
      "fx-backend",
      `pages/${pageId}/notes`,
      { body: "hi" },
      { userName: "", jwt: false, userToken: false, siteToken: false },
    );
    assert.equal(visitor.statusCode, 401);
    const missing = await r.call("GET", "fx-backend", "nope");
    assert.equal(missing.statusCode, 404);
  });

  test("contributions: site-surface entries and advertised contracts, without plugin ids in the contract list", async () => {
    const r = mount();
    const res = await r.get("/x/api/v1/plugins/contributions");
    assert.equal(res.statusCode, null, JSON.stringify(res.body));
    const data = res.body.data;
    // the example plugin ships a site slot (insights.section) but stays inactive until its required greeting is set,
    // and an inactive plugin contributes nothing (spec/07 separation rule)
    assert.equal(
      data.contributions.find((c) => c.id === "explosions-insights"),
      undefined,
    );
    assert.ok(data.contributions.every((c) => c.surface === "site"));
    assert.ok(
      data.contributions.find((c) => c.id === "fx-backend-insights"),
      JSON.stringify(data.contributions),
    );
    assert.deepEqual(data.contracts["insights.check"].provides, ["word.count"]);
    const visitor = await r.get("/x/api/v1/plugins/contributions", {
      userName: "",
      jwt: false,
      userToken: false,
      siteToken: false,
    });
    assert.equal(visitor.statusCode, 401);
  });

  test(".well-known: reserved names only; fx-well-known answers once its issuer is set", async () => {
    const r = mount();
    const unknown = await r.get("/.well-known/security.txt");
    assert.ok(
      unknown.nextCalled,
      "not reserved: falls through to the rest of the app",
    );
    pluginSystem.reset();
    const before = await r.get("/.well-known/oauth-authorization-server");
    // fx-well-known stays inactive until its required issuer has a value, so nothing serves the name yet
    assert.ok(before.nextCalled, JSON.stringify(before.body));
    fs.outputJsonSync(
      path.join(testRoot, "_config", "plugins", "config", "fx-well-known.json"),
      { issuer: "https://cms.example.edu" },
    );
    pluginSystem.reset();
    const meta = await r.get("/.well-known/oauth-authorization-server");
    assert.equal(meta.nextCalled, false);
    assert.deepEqual(meta.body, { issuer: "https://cms.example.edu" });
  });
});

// the system engine (spec/13 section 8b): system routes, the plugin list and dashboard contributions run with no site,
// never on some site's engine
describe("system-scope routes run on the system engine", () => {
  test("the plugin list and dashboard contributions never resolve a site", async () => {
    const routes = [];
    const app = {
      all: (p, h) => routes.push({ p, h }),
      get: (p, h) => routes.push({ p, h }),
      post: (p, h) => routes.push({ p, h, post: true }),
    };
    mountPluginRoutes(app, {
      basePath: "/",
      sitesDirectory: "_sites",
      resolveSite: async () => {
        throw new Error("a system route asked for a site");
      },
      resolveAuth: (req, site) => {
        assert.equal(site, null);
        return {
          userName: "admin",
          jwt: true,
          userToken: true,
          siteToken: false,
        };
      },
    });
    const call = async (path) => {
      const res = stubRes();
      await routes
        .find((r) => r.p === path)
        .h(
          { method: "GET", params: {}, query: {}, body: {}, headers: {} },
          res,
        );
      return res;
    };
    const list = await call("/system/api/v1/plugins");
    assert.ok(Array.isArray(list.body.data), JSON.stringify(list.body));
    assert.ok(list.body.data.length > 0, "core plugins are listed");
    const dash = await call("/system/api/v1/plugins/contributions");
    assert.ok(
      dash.body.data.contributions.every(
        (c) => (c.surface || "dashboard") === "dashboard",
      ),
    );
  });

  test("the system engine has no site: site stores, records and rendering refuse", async () => {
    const h = await pluginSystem.systemHost({ user: null });
    assert.equal(h.site, null);
    assert.equal(h.siteInfo(), null);
    await assert.rejects(
      () => h.render({ id: "p1", content: "x" }),
      /rendering: needs a site; this is the system engine/,
    );
    await assert.rejects(
      () => h.saveEntity("page", { id: "p1", title: "x" }),
      /page records: needs a site/,
    );
    // each request gets its own view; the engine underneath is cached per HAXcms root
    assert.strictEqual(
      Object.getPrototypeOf(await pluginSystem.systemHost({ user: null })),
      Object.getPrototypeOf(h),
      "cached per HAXcms root",
    );
  });
});

// ctx.exec on a real HAXcms (spec/13): the engine checks the exec list and argument list; the host runs the command
// with no shell, files in a private {tmp} folder removed afterwards, the site folder as cwd, a minimal environment
// and a timeout. haxcms-php runs the same rules (PluginPlatformTest).
describe("ctx.exec runs listed commands", () => {
  const plugin = {
    id: "fx-exec-live",
    manifest: { capabilities: ["exec:run"], exec: [process.execPath] },
    settings: {},
    explicit: new Set(),
    form: [],
  };
  let host;
  before(async () => {
    const { HaxcmsPluginHost } = await import(
      "../../src/lib/plugins/HaxcmsPluginHost.mjs"
    );
    const dir = fs.mkdtempSync(path.join(testRoot, "exec-site-"));
    host = new HaxcmsPluginHost({
      site: {
        siteDirectory: dir,
        manifest: {
          id: "site-exec",
          title: "x",
          metadata: { site: { name: "x" } },
          items: [],
        },
      },
      root: testRoot,
      version: "0.0.0",
      liveExec: true,
    });
  });

  test("files reach {tmp}, cwd is the site, the environment is minimal, {tmp} is removed", async () => {
    const script =
      "const fs=require('fs');const t=process.argv[1];" +
      "process.stdout.write(JSON.stringify({key:fs.readFileSync(t+'/id','utf8'),mode:(fs.statSync(t+'/id').mode&0o777).toString(8)," +
      "home:process.env.HOME===t,cwd:process.cwd(),secret:process.env.HAX_SECRET_TEST||null,input:fs.readFileSync(0,'utf8')}));" +
      "process.stderr.write('warn')";
    process.env.HAX_SECRET_TEST = "leak";
    const r = await host.execFor(
      plugin,
      process.execPath,
      ["-e", script, "{tmp}"],
      {
        files: { id: { content: "KEY" } },
        input: "hello",
      },
    );
    delete process.env.HAX_SECRET_TEST;
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "warn");
    const out = JSON.parse(r.stdout);
    assert.deepEqual(
      {
        key: out.key,
        mode: out.mode,
        home: out.home,
        secret: out.secret,
        input: out.input,
      },
      { key: "KEY", mode: "600", home: true, secret: null, input: "hello" },
    );
    assert.equal(fs.realpathSync(out.cwd), fs.realpathSync(host.site.path));
    assert.deepEqual(host.execCalls.slice(-1)[0].args.slice(-1), ["<tmp>"]);
  });

  test("a non-zero exit is returned, a timeout kills and throws, cwd and file names stay inside", async () => {
    const r = await host.execFor(plugin, process.execPath, [
      "-e",
      "process.exit(3)",
    ]);
    assert.equal(r.code, 3);
    await assert.rejects(
      host.execFor(
        plugin,
        process.execPath,
        ["-e", "setTimeout(()=>{},10000)"],
        { timeout: 200 },
      ),
      /timed out after 200 ms/,
    );
    await assert.rejects(
      host.execFor(plugin, process.execPath, ["-e", "1"], { cwd: ".." }),
      /cwd must be inside the site folder/,
    );
    await assert.rejects(
      host.execFor(plugin, process.execPath, ["-e", "1"], {
        files: { "../x": { content: "" } },
      }),
      /not a plain file name/,
    );
    await assert.rejects(
      host.execFor(plugin, "sh", ["-c", "id"]),
      /may not run "sh"/,
    );
  });
});

// One engine serves every request for a site, so a request's user must not live on it (spec/13 section 8c). Each
// request here carries its own credentials and the two overlap; with the user kept on the shared engine, both notes
// were written as the same author.
describe("overlapping requests keep their own user", () => {
  test("two people posting a note at the same moment are each the author of their own", async () => {
    const routes = [];
    const app = {
      all: (p, h) => routes.push({ p, h }),
      get: (p, h) => routes.push({ p, h }),
      post: (p, h) => routes.push({ p, h }),
    };
    mountPluginRoutes(app, {
      basePath: "/",
      sitesDirectory: "_sites",
      resolveSite: async () => freshSite(),
      resolveAuth: (req) => ({
        userName: req.who,
        jwt: true,
        userToken: false,
        siteToken: true,
      }),
    });
    const siteRoute = routes.find((r) => r.p === "/x/api/v1/plugins/:plugin/*");
    const s = await freshSite();
    const pageId = s.manifest.items[0].id;
    const post = async (who) => {
      const res = stubRes();
      await siteRoute.h(
        {
          who,
          method: "POST",
          params: { plugin: "fx-backend", 0: `pages/${pageId}/notes` },
          query: {},
          body: { body: `from ${who}` },
          headers: {},
        },
        res,
      );
      return res;
    };
    for (let round = 0; round < 10; round++) {
      const [a, b] = await Promise.all([post("alice"), post("bob")]);
      assert.equal(a.statusCode, 200, JSON.stringify(a.body));
      assert.equal(a.body.authorId, "alice", `round ${round}`);
      assert.equal(b.body.authorId, "bob", `round ${round}`);
    }
  });

  test("a view has its own user and shares the engine's plugins and stores", async () => {
    const s = await freshSite();
    const alice = await pluginSystem.host(s, { user: { id: "alice" } });
    const bob = await pluginSystem.host(s, { user: { id: "bob" } });
    assert.equal(alice.user.id, "alice");
    assert.equal(bob.user.id, "bob");
    assert.equal(alice.plugins, bob.plugins);
    assert.equal(alice.memory, bob.memory);
  });
});

// The plugin registry (spec/03): what is installed, what is on, and the routes that change it. fx-exec and
// fx-optional are installed the way a deployment installs a plugin, as folders under <HAXCMS_ROOT>/_plugins/.
describe("the plugin registry: installed is not enabled", () => {
  const authAll = {
    userName: "admin",
    jwt: true,
    userToken: true,
    siteToken: true,
  };
  let routes;
  let auth;
  const find = (p) => routes.find((r) => r.p === p);
  const run = async (p, params) => {
    const res = stubRes();
    await find(p).h(
      {
        method: "POST",
        params: params || {},
        query: {},
        body: {},
        headers: {},
      },
      res,
    );
    return res;
  };
  const entry = (res, id) => res.body.data.find((e) => e.id === id);

  before(() => {
    for (const id of ["fx-exec", "fx-optional"]) {
      fs.copySync(
        path.join(spec, "conformance", "fixtures", id),
        path.join(testRoot, "_plugins", id),
      );
    }
    pluginSystem.reset();
    routes = [];
    const app = {
      all: (p, h) => routes.push({ p, h }),
      get: (p, h) => routes.push({ p, h }),
      post: (p, h) => routes.push({ p, h }),
    };
    auth = authAll;
    mountPluginRoutes(app, {
      basePath: "/",
      sitesDirectory: "_sites",
      resolveSite: async () => freshSite(),
      resolveAuth: () => auth,
    });
  });

  test("a plugin dropped into _plugins is available: listed, not loaded, no routes", async () => {
    const list = await run("/system/api/v1/plugins");
    assert.equal(list.statusCode, null, JSON.stringify(list.body));
    const e = entry(list, "fx-exec");
    assert.equal(e.status, "available");
    assert.equal(e.enabled, false);
    assert.deepEqual(e.needs, ["backend", "process"]);
    assert.deepEqual(e.targets, {
      server: "full",
      desktop: "full",
      browser: "no",
    });
    const res = stubRes();
    await find("/x/api/v1/plugins/:plugin/*").h(
      {
        method: "POST",
        params: { plugin: "fx-exec", 0: "run/echo" },
        query: {},
        body: {},
        headers: {},
      },
      res,
    );
    assert.equal(res.statusCode, 404);
  });

  test("the registry needs both credentials; a site's registry needs the site token", async () => {
    auth = { userName: "admin", jwt: true, userToken: false, siteToken: false };
    assert.equal((await run("/system/api/v1/plugins")).statusCode, 401);
    assert.equal((await run("/x/api/v1/plugins")).statusCode, 401);
    assert.equal(
      (
        await run("/system/api/v1/plugins/:plugin/enable", {
          plugin: "fx-exec",
        })
      ).statusCode,
      401,
    );
    auth = authAll;
  });

  test("enable for the system: written to plugins.yaml, active in every site, a site cannot turn it off", async () => {
    const on = await run("/system/api/v1/plugins/:plugin/enable", {
      plugin: "fx-exec",
    });
    assert.equal(on.statusCode, null, JSON.stringify(on.body));
    assert.equal(on.body.data.status, "active");
    assert.equal(on.body.data.scope, "system");
    const file = path.join(testRoot, "_config", "plugins", "plugins.yaml");
    assert.match(fs.readFileSync(file, "utf8"), /enabled:\n\s+- fx-exec/);
    assert.equal(
      pluginSystem.readRegistryFile(testRoot).plugins["fx-exec"].by,
      "admin",
    );
    const inSite = await run("/x/api/v1/plugins");
    assert.equal(entry(inSite, "fx-exec").status, "active");
    const off = await run("/x/api/v1/plugins/:plugin/disable", {
      plugin: "fx-exec",
    });
    assert.equal(off.statusCode, 409, JSON.stringify(off.body));
  });

  test("enable for one site: written to the site's plugins.yaml and counted by the system", async () => {
    const on = await run("/x/api/v1/plugins/:plugin/enable", {
      plugin: "fx-optional",
    });
    assert.equal(on.statusCode, null, JSON.stringify(on.body));
    assert.equal(on.body.data.scope, "site");
    const s = await freshSite();
    assert.deepEqual(pluginSystem.readRegistryFile(s.siteDirectory).enabled, [
      "fx-optional",
    ]);
    const system = await run("/system/api/v1/plugins");
    assert.equal(entry(system, "fx-optional").status, "available");
    assert.deepEqual(entry(system, "fx-optional").sites, [
      path.basename(s.siteDirectory),
    ]);
  });

  test("disable: removed from the file and off again; unknown ids are 404", async () => {
    const off = await run("/system/api/v1/plugins/:plugin/disable", {
      plugin: "fx-exec",
    });
    assert.equal(off.statusCode, null, JSON.stringify(off.body));
    assert.equal(off.body.data.enabled, false);
    assert.deepEqual(pluginSystem.readRegistryFile(testRoot).enabled, []);
    const siteOff = await run("/x/api/v1/plugins/:plugin/disable", {
      plugin: "fx-optional",
    });
    assert.equal(siteOff.statusCode, null, JSON.stringify(siteOff.body));
    const s = await freshSite();
    assert.deepEqual(
      pluginSystem.readRegistryFile(s.siteDirectory).enabled,
      [],
    );
    const missing = await run("/system/api/v1/plugins/:plugin/enable", {
      plugin: "no-such-plugin",
    });
    assert.equal(missing.statusCode, 404);
    const odd = await run("/system/api/v1/plugins/:plugin/enable", {
      plugin: "../etc",
    });
    assert.equal(odd.statusCode, 404);
  });

  test("a blocked plugin cannot be enabled", async () => {
    const file = path.join(testRoot, "_config", "plugins", "plugins.yaml");
    fs.writeFileSync(file, "version: 1\nenabled: []\nblocked: [fx-exec]\n");
    pluginSystem.reset();
    const on = await run("/system/api/v1/plugins/:plugin/enable", {
      plugin: "fx-exec",
    });
    assert.equal(on.statusCode, 409, JSON.stringify(on.body));
    fs.writeFileSync(file, "version: 1\nenabled: []\n");
    pluginSystem.reset();
  });
});

// Settings, front-end files, anonymous limits and store writes over the routes (spec/13 sections 5, 7 and 8).
describe("settings, assets, rate limits and stores over the routes", () => {
  const authAll = {
    userName: "admin",
    jwt: true,
    userToken: true,
    siteToken: true,
  };
  let routes;
  let auth;
  const find = (p) => routes.find((r) => r.p === p);
  const run = async (p, req) => {
    const res = stubRes();
    res.sendBody = null;
    await find(p).h(
      Object.assign(
        { method: "GET", params: {}, query: {}, body: {}, headers: {} },
        req || {},
      ),
      res,
    );
    return res;
  };

  before(async () => {
    fs.copySync(
      path.join(spec, "conformance", "fixtures", "fx-tally"),
      path.join(testRoot, "_plugins", "fx-tally"),
    );
    pluginSystem.reset();
    routes = [];
    const app = {
      all: (p, h) => routes.push({ p, h }),
      get: (p, h) => routes.push({ p, h }),
      post: (p, h) => routes.push({ p: `POST ${p}`, h }),
    };
    auth = authAll;
    mountPluginRoutes(app, {
      basePath: "/",
      sitesDirectory: "_sites",
      resolveSite: async () => freshSite(),
      resolveAuth: () => auth,
    });
    const on = await run("POST /system/api/v1/plugins/:plugin/enable", {
      params: { plugin: "fx-tally" },
    });
    assert.equal(on.statusCode, null, JSON.stringify(on.body));
  });

  test("a secret setting is saved outside the config file, never sent back, and kept when left empty", async () => {
    const before = await run("/system/api/v1/plugins/:plugin/settings", {
      params: { plugin: "example" },
    });
    assert.equal(before.statusCode, null, JSON.stringify(before.body));
    assert.deepEqual(before.body.data.values.apiKey, {
      secret: true,
      set: false,
    });
    const saved = await run("POST /system/api/v1/plugins/:plugin/settings", {
      params: { plugin: "example" },
      body: { values: { apiKey: "k-12345-secret" } },
    });
    assert.equal(saved.statusCode, null, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data.values.apiKey, {
      secret: true,
      set: true,
    });
    assert.ok(
      !JSON.stringify(saved.body).includes("k-12345-secret"),
      "the secret came back",
    );
    const secrets = path.join(
      testRoot,
      "_config",
      "plugins",
      "secrets",
      "example.json",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(secrets, "utf8")).apiKey,
      "k-12345-secret",
    );
    assert.equal(
      fs.statSync(secrets).mode & 0o077,
      0,
      "the secrets file is readable by others",
    );
    const config = path.join(
      testRoot,
      "_config",
      "plugins",
      "config",
      "example.json",
    );
    assert.ok(!fs.readFileSync(config, "utf8").includes("k-12345-secret"));
    // after a restart the secret is read back from its own file
    pluginSystem.reset();
    const again = await run("POST /system/api/v1/plugins/:plugin/settings", {
      params: { plugin: "example" },
      body: { values: { apiKey: "" } },
    });
    assert.deepEqual(again.body.data.values.apiKey, {
      secret: true,
      set: true,
    });
    assert.equal(
      JSON.parse(fs.readFileSync(secrets, "utf8")).apiKey,
      "k-12345-secret",
    );
    auth = { userName: "admin", jwt: true, userToken: false, siteToken: true };
    assert.equal(
      (
        await run("/system/api/v1/plugins/:plugin/settings", {
          params: { plugin: "example" },
        })
      ).statusCode,
      401,
    );
    auth = authAll;
  });

  test("assets: a listed front-end file is served with its type; anything else is 404", async () => {
    const ok = await run("/x/api/v1/plugins/:plugin/assets/*", {
      params: { plugin: "fx-tally", 0: "fx-tally-board.js" },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["Content-Type"], "text/javascript");
    assert.equal(ok.headers["X-Content-Type-Options"], "nosniff");
    assert.match(String(ok.sent), /fx-tally-board/);
    for (const bad of [
      "unlisted.js",
      "edited.js",
      "../config/openapi.yaml",
      "img/../../src/nodejs/index.js",
      "sneaky.php",
      ".env",
    ]) {
      const res = await run("/x/api/v1/plugins/:plugin/assets/*", {
        params: { plugin: "fx-tally", 0: bad },
      });
      assert.equal(res.statusCode, 404, bad);
    }
    const off = await run("/x/api/v1/plugins/:plugin/assets/*", {
      params: { plugin: "fx-exec", 0: "x.js" },
    });
    assert.equal(off.statusCode, 404);
  });

  test("the contract: a plugin's operations at their mounted paths, as JSON or YAML, to a signed-in caller only", async () => {
    const one = await run("/x/api/v1/plugins/:plugin/openapi.json", {
      path: "/x/api/v1/plugins/fx-tally/openapi.json",
      params: { plugin: "fx-tally" },
    });
    assert.equal(one.statusCode, 200, JSON.stringify(one.body));
    assert.deepEqual(Object.keys(one.body.paths), [
      "/x/api/v1/plugins/fx-tally/burst",
      "/x/api/v1/plugins/fx-tally/careless",
      "/x/api/v1/plugins/fx-tally/vote",
    ]);
    assert.equal(
      one.body.paths["/x/api/v1/plugins/fx-tally/vote"].post.operationId,
      "fxTallyVote",
    );
    const asYaml = await run("/x/api/v1/plugins/:plugin/openapi.yaml", {
      path: "/x/api/v1/plugins/fx-tally/openapi.yaml",
      params: { plugin: "fx-tally" },
    });
    assert.equal(asYaml.statusCode, 200);
    assert.equal(
      asYaml.headers["Content-Type"],
      "application/yaml; charset=utf-8",
    );
    assert.match(String(asYaml.sent), /fxTallyVote/);
    // every plugin that is on, for the scope asked: fx-tally has nothing at system scope
    const site = await run("/x/api/v1/plugins/openapi.json", {
      path: "/x/api/v1/plugins/openapi.json",
    });
    assert.equal(site.statusCode, 200);
    assert.ok(site.body.paths["/x/api/v1/plugins/fx-tally/vote"]);
    const system = await run("/system/api/v1/plugins/openapi.json", {
      path: "/system/api/v1/plugins/openapi.json",
    });
    assert.equal(system.statusCode, 200);
    assert.ok(
      Object.keys(system.body.paths).every(
        (k) => k.indexOf("/system/api/v1/plugins/") === 0,
      ),
    );
    for (const missing of [
      ["/x/api/v1/plugins/:plugin/openapi.json", "fx-absent"],
      ["/system/api/v1/plugins/:plugin/openapi.json", "fx-tally"],
    ]) {
      const res = await run(missing[0], {
        path: "/openapi.json",
        params: { plugin: missing[1] },
      });
      assert.equal(res.statusCode, 404, missing.join(" "));
    }
    auth = { userName: "", jwt: false, userToken: false, siteToken: false };
    for (const p of [
      "/x/api/v1/plugins/openapi.json",
      "/system/api/v1/plugins/openapi.json",
      "/x/api/v1/plugins/:plugin/openapi.json",
    ]) {
      const res = await run(p, {
        path: "/openapi.json",
        params: { plugin: "fx-tally" },
      });
      assert.equal(res.statusCode, 401, p);
    }
    auth = authAll;
  });

  test("an anonymous caller is limited per address; the store file is written whole", async () => {
    auth = { userName: "", jwt: false, userToken: false, siteToken: false };
    const vote = (ip) =>
      run("/x/api/v1/plugins/:plugin/*", {
        method: "POST",
        ip,
        params: { plugin: "fx-tally", 0: "vote" },
      });
    const first = await Promise.all([
      vote("203.0.113.5"),
      vote("203.0.113.5"),
      vote("203.0.113.5"),
    ]);
    assert.deepEqual(
      first.map((r) => r.statusCode),
      [200, 200, 200],
    );
    const over = await vote("203.0.113.5");
    assert.equal(over.statusCode, 429);
    assert.ok(Number(over.headers["retry-after"]) > 0);
    assert.equal((await vote("203.0.113.9")).statusCode, 200);
    auth = authAll;
    const s = await freshSite();
    const dir = path.join(
      testRoot,
      "_config",
      "siteData",
      s.manifest.id,
      "fx-tally",
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, "tally.json"), "utf8")),
      { n: 4 },
    );
    assert.deepEqual(
      fs.readdirSync(dir),
      ["tally.json"],
      "a temp file was left behind",
    );
  });
});

// An outline save and a new page are page events (spec/06): the page hooks fire for each page inside one bulk
// transaction whose origin names the operation, a veto refuses the whole save before anything is written, and
// what the hooks return is not applied.
describe("outline saves and new pages fire the page hooks", () => {
  const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");
  const createNode = require("../../src/siteRoutes/v1/routes/createNode.js");
  const logOf = async (s) => (await pluginSystem.host(s, { user: null })).log;
  const count = (log, text) => log.filter((l) => l.message === text).length;

  // its own site: earlier tests leave a page named "forbidden" in the shared one
  const outlineSite = () => HAXCMS.loadSite("plugin-outline");

  before(async () => {
    assert.ok(await HAXCMS.loadSite("plugin-outline", true));
    fs.copySync(
      path.join(spec, "conformance", "fixtures", "fx-probe-a"),
      path.join(testRoot, "_plugins", "fx-probe-a"),
    );
    pluginSystem.reset();
    const on = await pluginSystem.enable(null, "fx-probe-a", {});
    assert.equal(on.status, 200, JSON.stringify(on));
  });

  test("saveOutline: one transaction, a before and an after hook per page, and the outline saved as sent", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await outlineSite();
    const items = JSON.parse(JSON.stringify(s.manifest.items));
    items.push({
      id: "item-new-from-outline",
      title: "Added in the outline",
      parent: null,
      order: items.length,
      indent: 0,
    });
    const from = (await logOf(s)).length;
    const res = stubRes();
    await saveOutline(siteReq(s, { items }), res);
    assert.equal(res.statusCode, null, JSON.stringify(res.body));
    assert.equal(res.body.status, 200);
    const after = await outlineSite();
    assert.equal(after.manifest.items.length, items.length);
    assert.ok(
      after.manifest.items.some((i) => i.title === "Added in the outline"),
    );
    const log = (await logOf(after)).slice(from);
    assert.equal(count(log, "fx-probe-a:page.before.save"), items.length);
    assert.equal(count(log, "fx-probe-a:page.after.save"), items.length);
    // two transactions: the before hooks, then the after hooks, each started once
    assert.equal(count(log, "fx-probe-a:transaction.before.start"), 2);
    const order = log
      .map((l) => l.message)
      .filter((m) => /fx-probe-a:(page|transaction\.before\.start)/.test(m));
    assert.equal(order[0], "fx-probe-a:transaction.before.start");
    assert.ok(
      order.lastIndexOf("fx-probe-a:page.before.save") <
        order.indexOf("fx-probe-a:page.after.save"),
    );
  });

  test("saveOutline: a veto refuses the whole save and site.json is untouched", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await outlineSite();
    const file = path.join(s.siteDirectory, "site.json");
    const stored = fs.readFileSync(file, "utf8");
    const items = JSON.parse(JSON.stringify(s.manifest.items));
    items[0].title = "Renamed, and should not be";
    items.push({
      id: "item-forbidden",
      title: "forbidden page",
      parent: null,
      order: items.length,
      indent: 0,
    });
    const res = stubRes();
    await saveOutline(siteReq(s, { items }), res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.data.message, "fx-vetoer: forbidden");
    assert.equal(fs.readFileSync(file, "utf8"), stored);
    assert.ok(
      !fs.existsSync(path.join(s.siteDirectory, "pages", "forbidden-page")),
    );
  });

  test("createNode: the new page goes through page.before.save and a veto refuses it", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await outlineSite();
    const before = s.manifest.items.length;
    const from = (await logOf(s)).length;
    const ok = stubRes();
    await createNode(siteReq(s, { node: { title: "Made by createNode" } }), ok);
    assert.equal(
      ok.sent && ok.sent.status,
      200,
      JSON.stringify(ok.body || ok.sent),
    );
    const log = (await logOf(await outlineSite())).slice(from);
    assert.equal(count(log, "fx-probe-a:page.before.save"), 1);
    assert.equal(count(log, "fx-probe-a:page.after.save"), 1);
    const no = stubRes();
    await createNode(
      siteReq(await outlineSite(), { node: { title: "forbidden" } }),
      no,
    );
    assert.equal(no.statusCode, 409, JSON.stringify(no.body || no.sent));
    assert.equal((await outlineSite()).manifest.items.length, before + 1);
  });
});
