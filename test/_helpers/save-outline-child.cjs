"use strict";

// Runs one saveOutline request in its own process, for fault-injection
// scenarios that can block the event loop (a request that spins forever
// would take the whole test runner down with it if it ran in-process).
//
//   node test/_helpers/save-outline-child.cjs <scenario> <empty temp dir>
//
// The parent owns (creates and removes) the temp dir, since a child that is
// killed mid-request cannot clean up after itself.
// Prints "STARTED" right before the request and "DONE <json>" when the
// handler returns or throws. The parent decides how long to wait after
// STARTED. Scenarios:
//   cycle        two pages that are each other's parent
//   self-parent  a page that is its own parent

const fs = require("fs-extra");
const path = require("path");

const scenario = process.argv[2];
const root = process.argv[3];
process.env.HAXCMS_ROOT = root + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

function makeReq(siteName, items) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: { authenticated: true, userName: "tester" },
    body: { site: { name: siteName }, items: items },
  };
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

async function main() {
  if (!root || !fs.existsSync(root)) {
    throw new Error("usage: save-outline-child.cjs <scenario> <temp dir>");
  }
  HAXCMS.configDirectory = fs.mkdtempSync(path.join(root, "config-"));
  HAXCMS.validateRequestToken = () => true;
  const siteName = "child";
  await HAXCMS.createSite(siteName);
  const seed = stubRes();
  await saveOutline(
    makeReq(siteName, [page("a", "A", null, 0), page("b", "B", null, 1)]),
    seed,
  );
  const site = await HAXCMS.loadSite(siteName);
  const id = (title) => site.manifest.items.find((i) => i.title === title).id;
  let items;
  if (scenario === "cycle") {
    items = [page(id("A"), "A", id("B"), 0), page(id("B"), "B", id("A"), 0)];
  } else if (scenario === "self-parent") {
    items = [page(id("A"), "A", id("A"), 0)];
  } else {
    throw new Error("unknown scenario " + scenario);
  }
  const before = fs.readFileSync(path.join(site.siteDirectory, "site.json"));
  const res = stubRes();
  let thrown = null;
  process.stdout.write("STARTED\n");
  try {
    await saveOutline(makeReq(siteName, items), res);
  } catch (e) {
    thrown = String(e && e.message);
  }
  const after = fs.readFileSync(path.join(site.siteDirectory, "site.json"));
  process.stdout.write(
    "DONE " +
      JSON.stringify({
        status: res.statusCode,
        body: res.body,
        thrown: thrown,
        siteJsonUnchanged: before.equals(after),
      }) +
      "\n",
  );
}

main().catch((e) => {
  process.stdout.write("ERROR " + String(e && e.message) + "\n");
  process.exitCode = 1;
});
