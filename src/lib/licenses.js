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

module.exports = {
  LICENSE_GROUPS,
  LICENSES,
  getLicenseCodes,
  getLicense,
  getLicenseDisplayName,
  getLicenseMap,
};
