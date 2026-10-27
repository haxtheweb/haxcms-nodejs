const test = require("node:test");
const assert = require("node:assert/strict");
const {
  identifyLicense,
  normalizeLicenseValue,
  getLicenseTerms,
} = require("../../src/lib/licenses.js");

const code = (text) => identifyLicense(text).code;

test("normalizeLicenseValue: exact, SPDX suffix and CC spellings", () => {
  assert.equal(normalizeLicenseValue("by-sa"), "by-sa");
  assert.equal(normalizeLicenseValue("MIT"), "mit");
  assert.equal(normalizeLicenseValue("GPL-3.0-or-later"), "gpl-3.0");
  assert.equal(normalizeLicenseValue("CC BY-NC-SA"), "by-nc-sa");
  assert.equal(
    normalizeLicenseValue("https://creativecommons.org/licenses/by-nc/4.0/"),
    "by-nc",
  );
  assert.equal(normalizeLicenseValue("nonsense"), null);
  assert.equal(normalizeLicenseValue(""), null);
  assert.equal(normalizeLicenseValue(null), null);
});

test("identifyLicense: Creative Commons, spelled out and abbreviated", () => {
  assert.equal(code("CC BY 4.0"), "by");
  assert.equal(code("CC BY-SA"), "by-sa");
  assert.equal(code("cc-by-nc-nd"), "by-nc-nd");
  assert.equal(
    code(
      "Creative Commons Attribution-NonCommercial-NoDerivs 4.0 United States License",
    ),
    "by-nc-nd",
  );
  assert.equal(
    code(
      "Attribution-NonCommercial-NoDerivatives 4.0 International Public License",
    ),
    "by-nc-nd",
  );
  assert.equal(
    code("Creative Commons Attribution-ShareAlike 4.0 International"),
    "by-sa",
  );
});

test("identifyLicense: another Creative Commons version gets no code", () => {
  const info = identifyLicense(
    "Creative Commons Attribution-ShareAlike 3.0 Unported",
  );
  assert.equal(info.code, null);
  assert.equal(info.version, "3.0");
  assert.match(info.label, /3\.0/);
  assert.equal(code("https://creativecommons.org/licenses/by/2.5/"), null);
  assert.equal(code("CC BY-NC 3.0"), null);
});

test("identifyLicense: public domain tools and an SPDX tag", () => {
  assert.equal(code("CC0 1.0 Universal"), "cc0");
  assert.equal(
    code("https://creativecommons.org/publicdomain/zero/1.0/"),
    "cc0",
  );
  assert.equal(
    code("https://creativecommons.org/publicdomain/mark/1.0/"),
    "pdm",
  );
  assert.equal(code("// SPDX-License-Identifier: Apache-2.0\n"), "apache-2.0");
});

test("identifyLicense: well known software license texts", () => {
  const cases = {
    mit: "Permission is hereby granted, free of charge, to any person obtaining a copy",
    isc: "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted",
    "apache-2.0": "Apache License\n Version 2.0, January 2004",
    "gpl-2.0": "GNU GENERAL PUBLIC LICENSE\n Version 2, June 1991",
    "gpl-3.0": "GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007",
    "lgpl-3.0": "GNU LESSER GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007",
    "agpl-3.0":
      "GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007",
    "mpl-2.0": "Mozilla Public License Version 2.0",
    unlicense:
      "This is free and unencumbered software released into the public domain.",
    "bsd-2-clause":
      "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met: 1. a 2. b",
    "bsd-3-clause":
      "Redistribution and use in source and binary forms, with or without modification, are permitted provided that: 1. a 2. b 3. Neither the name of the copyright holder",
  };
  Object.keys(cases).forEach((expected) => {
    assert.equal(code(cases[expected]), expected, expected);
  });
});

test("identifyLicense: the lesser and affero texts are not read as plain GPL", () => {
  assert.equal(
    code(
      "GNU LESSER GENERAL PUBLIC LICENSE Version 3\n ... GNU GENERAL PUBLIC LICENSE",
    ),
    "lgpl-3.0",
  );
});

test("identifyLicense: unknown text is reported, never guessed", () => {
  assert.deepEqual(identifyLicense("Licensed to the Acme guild."), {
    code: null,
    version: "",
    label: "Licensed to the Acme guild.",
  });
  // an owner keeping the work to themselves is a license, not an unknown
  assert.equal(
    identifyLicense("All rights reserved.").code,
    "all-rights-reserved",
  );
  assert.equal(identifyLicense("").code, null);
  assert.equal(identifyLicense(undefined).code, null);
  assert.equal(identifyLicense({}).code, null);
});

test("identifyLicense: only reads the start of a very large file", () => {
  const padding = "x".repeat(70000);
  assert.equal(
    code(
      padding +
        "Permission is hereby granted, free of charge, to any person obtaining a copy",
    ),
    null,
  );
});

test("getLicenseTerms: what a Creative Commons code asks of reuse", () => {
  assert.deepEqual(getLicenseTerms("by"), []);
  assert.deepEqual(getLicenseTerms("by-sa"), ["share-alike"]);
  assert.deepEqual(getLicenseTerms("by-nc-nd"), [
    "non-commercial",
    "no-derivatives",
  ]);
  assert.deepEqual(getLicenseTerms("by-nc-sa"), [
    "non-commercial",
    "share-alike",
  ]);
  assert.deepEqual(getLicenseTerms("mit"), []);
  assert.deepEqual(getLicenseTerms("cc0"), []);
  assert.deepEqual(getLicenseTerms(undefined), []);
});
