"use strict";

/**
 * Canonical HAXcms license list, shared by HAXCMS.getLicenseData,
 * JSONOutlineSchema.getLicenseDetails and the createSite route.
 * Order is significant: creative-commons, public-domain, software.
 * The same list is mirrored in haxcms-php and the webcomponents client.
 */
const LICENSE_GROUPS = {
  "creative-commons": "Creative Commons",
  "public-domain": "Public domain",
  software: "Software",
};

const LICENSES = [
  {
    code: "by",
    group: "creative-commons",
    name: "Attribution",
    link: "https://creativecommons.org/licenses/by/4.0/",
    image: "https://i.creativecommons.org/l/by/4.0/88x31.png",
  },
  {
    code: "by-sa",
    group: "creative-commons",
    name: "Attribution Share a like",
    link: "https://creativecommons.org/licenses/by-sa/4.0/",
    image: "https://i.creativecommons.org/l/by-sa/4.0/88x31.png",
  },
  {
    code: "by-nd",
    group: "creative-commons",
    name: "Attribution No derivatives",
    link: "https://creativecommons.org/licenses/by-nd/4.0/",
    image: "https://i.creativecommons.org/l/by-nd/4.0/88x31.png",
  },
  {
    code: "by-nc",
    group: "creative-commons",
    name: "Attribution non-commercial",
    link: "https://creativecommons.org/licenses/by-nc/4.0/",
    image: "https://i.creativecommons.org/l/by-nc/4.0/88x31.png",
  },
  {
    code: "by-nc-sa",
    group: "creative-commons",
    name: "Attribution non-commercial share a like",
    link: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    image: "https://i.creativecommons.org/l/by-nc-sa/4.0/88x31.png",
  },
  {
    code: "by-nc-nd",
    group: "creative-commons",
    name: "Attribution Non-commercial No derivatives",
    link: "https://creativecommons.org/licenses/by-nc-nd/4.0/",
    image: "https://i.creativecommons.org/l/by-nc-nd/4.0/88x31.png",
  },
  {
    code: "cc0",
    group: "public-domain",
    name: "CC0 1.0 Universal",
    link: "https://creativecommons.org/publicdomain/zero/1.0/",
    image: "https://licensebuttons.net/p/zero/1.0/88x31.png",
  },
  {
    code: "pdm",
    group: "public-domain",
    name: "Public Domain Mark 1.0",
    link: "https://creativecommons.org/publicdomain/mark/1.0/",
    image: "https://licensebuttons.net/p/mark/1.0/88x31.png",
  },
  {
    code: "mit",
    group: "software",
    name: "MIT License",
    link: "https://opensource.org/license/mit",
    image: "",
  },
  {
    code: "apache-2.0",
    group: "software",
    name: "Apache License 2.0",
    link: "https://www.apache.org/licenses/LICENSE-2.0",
    image: "",
  },
  {
    code: "bsd-2-clause",
    group: "software",
    name: "BSD 2-Clause License",
    link: "https://opensource.org/license/bsd-2-clause",
    image: "",
  },
  {
    code: "bsd-3-clause",
    group: "software",
    name: "BSD 3-Clause License",
    link: "https://opensource.org/license/bsd-3-clause",
    image: "",
  },
  {
    code: "isc",
    group: "software",
    name: "ISC License",
    link: "https://opensource.org/license/isc-license-txt",
    image: "",
  },
  {
    code: "mpl-2.0",
    group: "software",
    name: "Mozilla Public License 2.0",
    link: "https://www.mozilla.org/MPL/2.0/",
    image: "",
  },
  {
    code: "gpl-2.0",
    group: "software",
    name: "GNU General Public License v2.0",
    link: "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html",
    image: "",
  },
  {
    code: "gpl-3.0",
    group: "software",
    name: "GNU General Public License v3.0",
    link: "https://www.gnu.org/licenses/gpl-3.0.html",
    image: "",
  },
  {
    code: "lgpl-3.0",
    group: "software",
    name: "GNU Lesser General Public License v3.0",
    link: "https://www.gnu.org/licenses/lgpl-3.0.html",
    image: "",
  },
  {
    code: "agpl-3.0",
    group: "software",
    name: "GNU Affero General Public License v3.0",
    link: "https://www.gnu.org/licenses/agpl-3.0.html",
    image: "",
  },
  {
    code: "unlicense",
    group: "software",
    name: "The Unlicense",
    link: "https://unlicense.org/",
    image: "",
  },
];

function getLicenseCodes() {
  return LICENSES.map((license) => license.code);
}

function getLicense(code) {
  if (typeof code !== "string") {
    return null;
  }
  for (const license of LICENSES) {
    if (license.code === code) {
      return license;
    }
  }
  return null;
}

/**
 * Display name: group label + ": " + license name
 */
function getLicenseDisplayName(license) {
  return LICENSE_GROUPS[license.group] + ": " + license.name;
}

/**
 * code -> display name ("select") or code -> {name, link, image, group}
 */
function getLicenseMap(type = "select") {
  const data = {};
  for (const license of LICENSES) {
    if (type == "select") {
      data[license.code] = getLicenseDisplayName(license);
    } else {
      data[license.code] = {
        name: getLicenseDisplayName(license),
        link: license.link,
        image: license.image,
        group: license.group,
      };
    }
  }
  return data;
}

/**
 * Reduce a license string to one of our codes. Accepts the code itself
 * ("by-sa", "MIT"), SPDX style ("GPL-3.0-only"), and the usual Creative
 * Commons spellings ("CC BY-SA", a creativecommons.org/licenses URL).
 * Longest codes are tried first so "by-nc-sa" is not shadowed by "by".
 */
function normalizeLicenseValue(rawValue, supported) {
  if (!rawValue || typeof rawValue !== "string") {
    return null;
  }
  const codes = Array.isArray(supported) ? supported : getLicenseCodes();
  const value = rawValue.trim().toLowerCase().replace(/_/g, "-");
  if (value === "") {
    return null;
  }
  if (codes.indexOf(value) !== -1) {
    return value;
  }
  // SPDX style suffixes, e.g. GPL-3.0-only or GPL-3.0-or-later
  const spdxValue = value.replace(/-(only|or-later)$/, "");
  if (spdxValue === "") {
    return null;
  }
  if (codes.indexOf(spdxValue) !== -1) {
    return spdxValue;
  }
  const byLength = codes.slice().sort((a, b) => b.length - a.length);
  for (const code of byLength) {
    if (
      spdxValue.indexOf("/licenses/" + code) !== -1 ||
      spdxValue.indexOf("cc " + code) !== -1 ||
      spdxValue.indexOf("cc-" + code) !== -1 ||
      spdxValue.indexOf("cc:" + code) !== -1
    ) {
      return code;
    }
  }
  return null;
}

/** "Attribution-NonCommercial-ShareAlike" flags to a CC code, or null. */
function ccCodeFromTerms(terms) {
  const text = terms.toLowerCase().replace(/[^a-z]/g, "");
  if (text.indexOf("attribution") === -1) {
    return null;
  }
  let code = "by";
  if (text.indexOf("noncommercial") !== -1) {
    code += "-nc";
  }
  if (text.indexOf("noderiv") !== -1) {
    code += "-nd";
  } else if (text.indexOf("sharealike") !== -1) {
    code += "-sa";
  }
  return code;
}

/**
 * What a license statement says: the code we can apply (or null), the
 * version when one was stated, and a short label for messages. A Creative
 * Commons license at a version other than 4.0 gets no code, because the
 * links and badges we carry are for 4.0 and calling 3.0 work "4.0" would
 * misstate its terms.
 *
 * Works on a short statement ("CC BY-SA 4.0", "MIT") and on the text of a
 * LICENSE file. Only well known wording is recognized; anything else is
 * reported as unrecognized, never guessed.
 */
function identifyLicense(rawText) {
  const result = { code: null, version: "", label: "" };
  if (typeof rawText !== "string") {
    return result;
  }
  const text = rawText.slice(0, 65536);
  const spdx = text.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/);
  if (spdx) {
    const code = normalizeLicenseValue(spdx[1]);
    if (code) {
      return { code: code, version: "", label: spdx[1] };
    }
  }
  // a Creative Commons deed URL carries the version: .../licenses/by-sa/3.0/
  const ccUrl = text.match(
    /creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/i,
  );
  if (ccUrl) {
    const urlCode = normalizeLicenseValue("cc-" + ccUrl[1]);
    if (urlCode && ccUrl[2] === "4.0") {
      return {
        code: urlCode,
        version: "4.0",
        label: "CC " + ccUrl[1].toUpperCase() + " 4.0",
      };
    }
    return {
      code: null,
      version: ccUrl[2],
      label: "CC " + ccUrl[1].toUpperCase() + " " + ccUrl[2],
    };
  }
  // Creative Commons, spelled out or abbreviated
  const longCc = text.match(
    /(?:Creative\s+Commons\s+)?(Attribution(?:[\s-]+(?:Non-?\s?Commercial|No\s?Derivs|No\s?Derivatives|Share\s?Alike))*)\s+(\d\.\d)\b/i,
  );
  const shortCc = text.match(
    /\bCC[\s-]+(BY(?:[\s-]+(?:NC|ND|SA))*)(?:[\s-]+(\d\.\d))?/i,
  );
  let ccCode = null;
  let ccVersion = "";
  let ccLabel = "";
  if (longCc) {
    ccCode = ccCodeFromTerms(longCc[1]);
    ccVersion = longCc[2];
    ccLabel =
      "Creative Commons " + longCc[1].replace(/\s+/g, " ") + " " + ccVersion;
  } else if (shortCc) {
    ccCode = ccCodeFromTerms(
      shortCc[1]
        .replace(/NC/i, "NonCommercial")
        .replace(/ND/i, "NoDerivs")
        .replace(/SA/i, "ShareAlike")
        .replace(/BY/i, "Attribution"),
    );
    ccVersion = shortCc[2] || "";
    ccLabel =
      "CC " +
      shortCc[1].toUpperCase().replace(/\s+/g, "-") +
      (ccVersion ? " " + ccVersion : "");
  }
  if (ccCode) {
    // no stated version means the current one; any other version is not ours
    if (ccVersion !== "" && ccVersion !== "4.0") {
      return { code: null, version: ccVersion, label: ccLabel };
    }
    return { code: ccCode, version: ccVersion || "4.0", label: ccLabel };
  }
  if (
    /\bCC0\b|CC0\s*1\.0|creativecommons\.org\/publicdomain\/zero/i.test(text)
  ) {
    return { code: "cc0", version: "1.0", label: "CC0 1.0" };
  }
  if (/creativecommons\.org\/publicdomain\/mark/i.test(text)) {
    return { code: "pdm", version: "1.0", label: "Public Domain Mark 1.0" };
  }
  const known = [
    [/GNU\s+AFFERO\s+GENERAL\s+PUBLIC\s+LICENSE[\s,]+Version\s+3/i, "agpl-3.0"],
    [/GNU\s+LESSER\s+GENERAL\s+PUBLIC\s+LICENSE[\s,]+Version\s+3/i, "lgpl-3.0"],
    [/GNU\s+GENERAL\s+PUBLIC\s+LICENSE[\s,]+Version\s+3/i, "gpl-3.0"],
    [/GNU\s+GENERAL\s+PUBLIC\s+LICENSE[\s,]+Version\s+2/i, "gpl-2.0"],
    [/Apache\s+License[\s,]+Version\s+2\.0/i, "apache-2.0"],
    [/Mozilla\s+Public\s+License[\s,]+(?:Version|v\.?)\s*2\.0/i, "mpl-2.0"],
    [
      /free\s+and\s+unencumbered\s+software\s+released\s+into\s+the\s+public\s+domain/i,
      "unlicense",
    ],
  ];
  for (const entry of known) {
    if (entry[0].test(text)) {
      return { code: entry[1], version: "", label: getLicense(entry[1]).name };
    }
  }
  if (
    /Redistribution\s+and\s+use\s+in\s+source\s+and\s+binary\s+forms,\s+with\s+or\s+without\s+modification,\s+are\s+permitted/i.test(
      text,
    )
  ) {
    const code = /Neither\s+the\s+name\s+of/i.test(text)
      ? "bsd-3-clause"
      : "bsd-2-clause";
    return { code: code, version: "", label: getLicense(code).name };
  }
  if (
    /Permission\s+to\s+use,\s+copy,\s+modify,\s+and\/or\s+distribute\s+this\s+software\s+for\s+any\s+purpose\s+with\s+or\s+without\s+fee/i.test(
      text,
    )
  ) {
    return { code: "isc", version: "", label: "ISC License" };
  }
  if (
    /Permission\s+is\s+hereby\s+granted,\s+free\s+of\s+charge,\s+to\s+any\s+person\s+obtaining\s+a\s+copy/i.test(
      text,
    )
  ) {
    return { code: "mit", version: "", label: "MIT License" };
  }
  // a bare code or URL, such as the value of a `license:` setting
  const trimmed = text.trim();
  if (trimmed.length <= 120) {
    const code = normalizeLicenseValue(trimmed);
    if (code) {
      return { code: code, version: "", label: trimmed };
    }
    if (trimmed !== "") {
      result.label = trimmed;
    }
  }
  return result;
}

/** Terms of a license code the person importing should know about. */
function getLicenseTerms(code) {
  const terms = [];
  if (typeof code !== "string") {
    return terms;
  }
  const group = getLicense(code);
  if (group && group.group === "creative-commons") {
    if (code.indexOf("nc") !== -1) {
      terms.push("non-commercial");
    }
    if (code.indexOf("nd") !== -1) {
      terms.push("no-derivatives");
    }
    if (code.indexOf("sa") !== -1) {
      terms.push("share-alike");
    }
  }
  return terms;
}

module.exports = {
  LICENSE_GROUPS,
  LICENSES,
  getLicenseCodes,
  getLicense,
  getLicenseDisplayName,
  getLicenseMap,
  normalizeLicenseValue,
  identifyLicense,
  getLicenseTerms,
};
