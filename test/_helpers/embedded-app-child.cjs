"use strict";

// Child process for test/unit/app-embedded.test.cjs. Loads src/app.js with
// HAXCMS_EMBEDDED=1 in a temp HAXcms root (cwd + HOME set by the parent),
// serves `app` from a server this script owns, and prints what it saw as
// JSON. The parent checks the process then exits on its own: an embedded app
// must not leave a server or timers running.

const http = require("node:http");
const path = require("node:path");

process.env.HAXCMS_EMBEDDED = "1";
process.env.HAXCMS_ROOT = process.cwd() + "/";

const appModule = require(path.join(__dirname, "..", "..", "src", "app.js"));

let serverReadyResolved = false;
appModule.serverReady.then(function () {
  serverReadyResolved = true;
});

function get(port, url) {
  return new Promise(function (resolve, reject) {
    http
      .get({ host: "127.0.0.1", port: port, path: url }, function (res) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          body += chunk;
        });
        res.on("end", function () {
          resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"] || "",
            body: body,
          });
        });
      })
      .on("error", reject);
  });
}

appModule.appReady
  .then(async function () {
    const host = http.createServer(appModule.app);
    await new Promise(function (resolve) {
      host.listen(0, "127.0.0.1", resolve);
    });
    const port = host.address().port;
    const openapi = await get(port, "/system/api/v1/openapi.json");
    let openapiIsJson = false;
    try {
      openapiIsJson = !!JSON.parse(openapi.body).openapi;
    } catch (e) {
      openapiIsJson = false;
    }
    await new Promise(function (resolve) {
      host.close(resolve);
    });
    process.stdout.write(
      "RESULT " +
        JSON.stringify({
          embeddedRuntime: appModule.embeddedRuntime,
          serverIsNull: appModule.server === null,
          serverReadyResolved: serverReadyResolved,
          openapiStatus: openapi.status,
          openapiIsJson: openapiIsJson,
        }) +
        "\n",
    );
  })
  .catch(function (e) {
    process.stdout.write("ERROR " + String((e && e.stack) || e) + "\n");
    process.exitCode = 1;
  });
