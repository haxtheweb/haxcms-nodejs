"use strict";

// Child process for test/unit/app-local-mode-site-writes.test.cjs: boots
// src/app.js in local mode (HAXCMS_DISABLE_JWT_CHECKS, the `hax serve` /
// npx haxcms-nodejs mode) on an ephemeral port in a temp root (cwd + HOME set
// by the parent), drives outline saves over HTTP and prints what it saw.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

process.env.HAXCMS_DISABLE_JWT_CHECKS = "true";
process.env.HAXCMS_ROOT = process.cwd() + "/";
process.env.PORT = "0";

const appModule = require(path.join(__dirname, "..", "..", "src", "app.js"));

const SITE = "localwrites";

function request(port, method, url, body, headers) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  const allHeaders = Object.assign({ host: "localhost" }, headers || {});
  if (payload) {
    allHeaders["content-type"] = "application/json";
    allHeaders["content-length"] = String(payload.length);
  }
  return new Promise(function (resolve, reject) {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: port,
        method: method,
        path: url,
        headers: allHeaders,
      },
      function (res) {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          text += chunk;
        });
        res.on("end", function () {
          resolve({ status: res.statusCode, text: text });
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function page(id, title, parent, order) {
  return {
    id: id,
    title: title,
    parent: parent,
    indent: parent ? 1 : 0,
    order: order,
    metadata: {},
  };
}

appModule.serverReady
  .then(async function (port) {
    const out = {};
    // local mode checks that request-token headers are present, not their value
    const created = await request(
      port,
      "POST",
      "/system/api/v1/sites",
      { site: { name: SITE } },
      {
        "x-haxcms-user-token": "local",
      },
    );
    out.createStatus = created.status;
    const siteJsonPath = path.join(process.cwd(), "_sites", SITE, "site.json");
    const outlineUrl = "/_sites/" + SITE + "/x/api/v1/site/outline";
    const siteHeaders = { "x-haxcms-site-token": "local" };

    const seeded = await request(
      port,
      "PATCH",
      outlineUrl,
      {
        items: [page("a", "A", null, 0), page("b", "B", null, 1)],
      },
      siteHeaders,
    );
    out.seedStatus = seeded.status;
    const manifest = JSON.parse(fs.readFileSync(siteJsonPath, "utf8"));
    out.titles = manifest.items
      .map(function (i) {
        return i.title;
      })
      .sort();
    const idOf = function (title) {
      return manifest.items.find(function (i) {
        return i.title === title;
      }).id;
    };

    const before = fs.readFileSync(siteJsonPath, "utf8");
    const cycle = await request(
      port,
      "PATCH",
      outlineUrl,
      {
        items: [
          page(idOf("A"), "A", idOf("B"), 0),
          page(idOf("B"), "B", idOf("A"), 0),
        ],
      },
      siteHeaders,
    );
    out.cycleStatus = cycle.status;
    out.cycleLeftSiteJsonUnchanged =
      before === fs.readFileSync(siteJsonPath, "utf8");

    const noToken = await request(port, "PATCH", outlineUrl, { items: [] });
    out.noTokenStatus = noToken.status;

    process.stdout.write("RESULT " + JSON.stringify(out) + "\n");
  })
  .catch(function (e) {
    process.stdout.write("ERROR " + String((e && e.stack) || e) + "\n");
    process.exitCode = 1;
  })
  .finally(function () {
    if (appModule.server) {
      appModule.server.close();
    }
  });
