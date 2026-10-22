"use strict";

// Tests for the shared license list (src/lib/licenses.js) and its consumers:
// HAXCMSSite.getLicenseData, JSONOutlineSchema.getLicenseDetails and the
// createSite license normalizer.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

// createSite.js captures HAXCMS_ROOT at require time, so point it at a temp dir
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "licenses-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const licenses = require("../../src/lib/licenses.js");
const JSONOutlineSchema = require("../../src/lib/JSONOutlineSchema.js");
const { HAXCMSSite } = require("../../src/lib/HAXCMS.js");
const createSiteRoute = require("../../src/systemRoutes/v1/routes/createSite.js");

test.after(() => {
  fs.removeSync(testRoot);
});

const EXPECTED_CODES = [
  "by",
  "by-sa",
  "by-nd",
  "by-nc",
  "by-nc-sa",
  "by-nc-nd",
  "cc0",
  "pdm",
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "mpl-2.0",
  "gpl-2.0",
  "gpl-3.0",
  "lgpl-3.0",
  "agpl-3.0",
  "unlicense",
];

describe("license list", () => {
  test("has the 19 canonical codes in spec order", () => {
    assert.deepEqual(licenses.getLicenseCodes(), EXPECTED_CODES);
    assert.equal(licenses.LICENSES.length, 19);
  });

  test("is grouped creative-commons, public-domain, software", () => {
    assert.deepEqual(Object.keys(licenses.LICENSE_GROUPS), [
      "creative-commons",
      "public-domain",
      "software",
    ]);
    const groups = licenses.LICENSES.map((license) => license.group);
    assert.deepEqual(groups.slice(0, 6), Array(6).fill("creative-commons"));
    assert.deepEqual(groups.slice(6, 8), Array(2).fill("public-domain"));
    assert.deepEqual(groups.slice(8), Array(11).fill("software"));
  });

  test("every license has a link; image only for CC and public domain", () => {
    for (const license of licenses.LICENSES) {
      assert.match(license.link, /^https:\/\//, license.code);
      assert.ok(license.name, license.code);
      if (license.group === "software") {
        assert.equal(license.image, "", license.code);
      } else {
        assert.match(license.image, /^https:\/\//, license.code);
      }
    }
  });

  test("getLicense looks up by code", () => {
    assert.equal(licenses.getLicense("mit").name, "MIT License");
    assert.equal(licenses.getLicense("nope"), null);
    assert.equal(licenses.getLicense(undefined), null);
  });
});

describe("getLicenseData", () => {
  test("select returns code -> prefixed display name in spec order", () => {
    const site = new HAXCMSSite();
    const select = site.getLicenseData();
    assert.deepEqual(Object.keys(select), EXPECTED_CODES);
    assert.equal(select["by"], "Creative Commons: Attribution");
    assert.equal(
      select["by-nc-nd"],
      "Creative Commons: Attribution Non-commercial No derivatives",
    );
    assert.equal(select["cc0"], "Public domain: CC0 1.0 Universal");
    assert.equal(select["pdm"], "Public domain: Public Domain Mark 1.0");
    assert.equal(select["mit"], "Software: MIT License");
    assert.equal(
      select["gpl-3.0"],
      "Software: GNU General Public License v3.0",
    );
  });

  test("any other type returns code -> {name, link, image, group}", () => {
    const site = new HAXCMSSite();
    const all = site.getLicenseData("all");
    assert.deepEqual(Object.keys(all), EXPECTED_CODES);
    assert.deepEqual(all["cc0"], {
      name: "Public domain: CC0 1.0 Universal",
      link: "https://creativecommons.org/publicdomain/zero/1.0/",
      image: "https://licensebuttons.net/p/zero/1.0/88x31.png",
      group: "public-domain",
    });
    assert.equal(all["mit"].image, "");
    assert.equal(all["mit"].group, "software");
  });
});

describe("JSONOutlineSchema.getLicenseDetails", () => {
  test("returns name, link, image and group for a new code", () => {
    const outline = new JSONOutlineSchema();
    outline.license = "apache-2.0";
    assert.deepEqual(outline.getLicenseDetails(), {
      name: "Software: Apache License 2.0",
      link: "https://www.apache.org/licenses/LICENSE-2.0",
      image: "",
      group: "software",
    });
  });

  test("returns an empty object for unknown licenses", () => {
    const outline = new JSONOutlineSchema();
    outline.license = "unknown";
    assert.deepEqual(outline.getLicenseDetails(), {});
  });
});

describe("createSite license normalizer", () => {
  const supported = createSiteRoute.getSupportedSiteLicenseCodes();
  const normalize = (value) =>
    createSiteRoute.normalizeSiteLicenseValue(value, supported);

  test("default supported codes derive from the shared list", () => {
    assert.deepEqual(supported, EXPECTED_CODES);
  });

  test("exact matches win, case and underscores normalized", () => {
    assert.equal(normalize("by-nc-sa"), "by-nc-sa");
    assert.equal(normalize("  MIT "), "mit");
    assert.equal(normalize("Apache_2.0"), "apache-2.0");
    assert.equal(normalize("cc0"), "cc0");
  });

  test("accepts SPDX -only and -or-later suffixes", () => {
    assert.equal(normalize("GPL-3.0-only"), "gpl-3.0");
    assert.equal(normalize("GPL-3.0-or-later"), "gpl-3.0");
    assert.equal(normalize("AGPL-3.0-or-later"), "agpl-3.0");
    assert.equal(normalize("GPL-2.0-only"), "gpl-2.0");
  });

  test("matches license urls", () => {
    assert.equal(
      normalize("https://creativecommons.org/licenses/by-nc-sa/4.0/"),
      "by-nc-sa",
    );
  });

  test("longest code wins over shorter prefixes (regression)", () => {
    // "by" used to match first and shadow every longer CC code
    assert.equal(normalize("cc-by-nc-sa-4.0"), "by-nc-sa");
    assert.equal(normalize("CC BY-NC-ND 4.0"), "by-nc-nd");
    assert.equal(normalize("cc:by-sa"), "by-sa");
    assert.equal(
      normalize("https://creativecommons.org/licenses/by-nd/4.0/"),
      "by-nd",
    );
  });

  test("unknown or empty values return null", () => {
    assert.equal(normalize("totally-unknown"), null);
    assert.equal(normalize("-only"), null);
    assert.equal(normalize("   "), null);
    assert.equal(normalize(""), null);
    assert.equal(normalize(null), null);
    assert.equal(normalize(42), null);
  });
});

describe("single-source license list", () => {
  const data = require("../../src/lib/licenses.json");

  test("licenses.json is well formed", () => {
    assert.equal(data.version, 1);
    const groupIds = data.groups.map((g) => g.id);
    assert.equal(new Set(groupIds).size, groupIds.length);
    const codes = data.licenses.map((l) => l.code);
    assert.equal(new Set(codes).size, codes.length);
    data.licenses.forEach((l) => {
      assert.ok(groupIds.includes(l.group), l.code + " has a known group");
      assert.ok(l.name && l.link, l.code + " is complete");
    });
  });

  test("the module is built from the JSON", () => {
    assert.deepEqual(
      licenses.getLicenseCodes(),
      data.licenses.map((l) => l.code),
    );
  });

  test("applyLicenseOptions fills the site settings license field", () => {
    const fields = [
      { fields: [{ property: "manifest-license", options: {} }] },
    ];
    assert.equal(licenses.applyLicenseOptions(fields), true);
    assert.deepEqual(
      Object.keys(fields[0].fields[0].options),
      Object.keys(licenses.getLicenseMap("select")),
    );
    assert.equal(licenses.applyLicenseOptions([{ property: "x" }]), false);
  });

  test("static siteFields.json does not carry a license copy", () => {
    const text = fs.readFileSync(
      path.join(__dirname, "../../src/coreConfig/siteFields.json"),
      "utf8",
    );
    const fields = JSON.parse(text);
    const found = [];
    (function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        if (node.property === "manifest-license") found.push(node);
        Object.keys(node).forEach((k) => walk(node[k]));
      }
    })(fields);
    assert.equal(found.length, 1);
    assert.equal(Object.keys(found[0].options || {}).length, 0);
  });
});
