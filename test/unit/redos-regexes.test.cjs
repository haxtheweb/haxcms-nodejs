"use strict";

// ReDoS hardening (CodeQL triage): every replaced regex is diffed against the
// ORIGINAL regex on random inputs (same output) and each rewrite is timed on
// an adversarial input (< 200 ms).

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { stripMSWord } = require("../../src/lib/convertUtils.js");
const {
  trimTrailingSlashes,
  trimSlashes,
  stripAngleTags,
  hasAngleTag,
  removeBackslashesBeforeQuote,
  closingCustomElementNames,
  findPageBreakSections,
  matchAttributes,
} = require("../../src/lib/linearText.js");
const {
  MAX_REQUEST_URL_LENGTH,
  requestUrlGuard,
  collapseThroughToken,
  getBuildAssetRequestPath,
} = require("../../src/lib/requestUrlGuards.js");

function prng(seed) {
  let x = seed >>> 0 || 1;
  return function () {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
function randomString(rand, alphabet, maxLen) {
  const n = Math.floor(rand() * maxLen);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return out;
}
function fuzz(name, alphabet, maxLen, oldFn, newFn, runs = 4000) {
  test("matches original regex on random input: " + name, () => {
    const rand = prng(0xc0ffee + name.length);
    for (let i = 0; i < runs; i++) {
      const input = randomString(rand, alphabet, maxLen);
      assert.deepEqual(
        newFn(input),
        oldFn(input),
        "input: " + JSON.stringify(input),
      );
    }
  });
}
function fast(name, fn) {
  test("adversarial input completes in < 200 ms: " + name, () => {
    const start = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 200, "took " + ms + " ms");
  });
}

describe("getBuildAssetRequestPath (app.js alert #23)", () => {
  const oldFn = (url) =>
    String(url || "")
      .split("?")[0]
      .replace(/\/(.*?)\/build\//g, "build/")
      .replace(/\/(.*?)\/wc-registry.json/g, "wc-registry.json")
      .replace(/\/(.*?)\/build.js/g, "build.js")
      .replace(/\/(.*?)\/build-haxcms.js/g, "build-haxcms.js");

  test("normal URLs", () => {
    const urls = [
      "/sites/foo/build/x.js",
      "/build/x.js",
      "/x/wc-registry.json",
      "/a/b/wc-registry.json?v=1",
      "/x/build.js",
      "/x/build-haxcms.js",
      "/sites/a/b/c/build/es6/node_modules/@haxtheweb/x/x.js?q=/a/build/",
      "/a/build/b/build/c",
      "",
      undefined,
    ];
    for (const u of urls) {
      assert.equal(getBuildAssetRequestPath(u), oldFn(u), String(u));
    }
    assert.equal(
      getBuildAssetRequestPath("/sites/foo/build/x.js"),
      "build/x.js",
    );
    assert.equal(getBuildAssetRequestPath("/x/build.js"), "build.js");
    assert.equal(
      getBuildAssetRequestPath("/x/build-haxcms.js"),
      "build-haxcms.js",
    );
    assert.equal(
      getBuildAssetRequestPath("/x/wc-registry.json"),
      "wc-registry.json",
    );
  });
  fuzz(
    "getBuildAssetRequestPath",
    [
      "/",
      "build",
      "/build/",
      "/build.js",
      "/wc-registry.json",
      "a",
      "\n",
      "?",
      "-haxcms.js",
    ],
    14,
    oldFn,
    getBuildAssetRequestPath,
    6000,
  );
  fast("slashes then build.js (16 KB)", () => {
    getBuildAssetRequestPath("/".repeat(16000) + "build.js");
    getBuildAssetRequestPath("/".repeat(50000) + "build/");
    getBuildAssetRequestPath("/a".repeat(50000));
    getBuildAssetRequestPath("/\n".repeat(25000) + "/build/x");
  });
  test("collapseThroughToken is exported and literal", () => {
    assert.equal(
      collapseThroughToken("/a/build/b", "/build/", "build/"),
      "build/b",
    );
  });

  describe("requestUrlGuard (414 for oversized URLs)", () => {
    function run(url) {
      const res = {
        code: null,
        body: null,
        status(c) {
          this.code = c;
          return this;
        },
        send(b) {
          this.body = b;
        },
      };
      let nexted = false;
      requestUrlGuard({ url }, res, () => {
        nexted = true;
      });
      return { res, nexted };
    }
    test("allows normal and long-but-legit URLs", () => {
      assert.equal(
        run("/sites/foo/x/api/v1/pages?jwt=" + "a".repeat(1500)).nexted,
        true,
      );
      assert.equal(run("/".padEnd(MAX_REQUEST_URL_LENGTH, "a")).nexted, true);
    });
    test("rejects oversized URLs with 414", () => {
      const r = run("/".padEnd(MAX_REQUEST_URL_LENGTH + 1, "a"));
      assert.equal(r.nexted, false);
      assert.equal(r.res.code, 414);
    });
  });
});

describe("convertUtils (alerts #357-367)", () => {
  const cases = [
    [
      " style='",
      "'",
      /\sstyle='(\s|.)*?'/,
      / style='(\s|.)*?'/gim,
      / style='[^']*'/gim,
    ],
    [' style="', '"', 0, / style="(\s|.)*?"/gim, / style="[^"]*"/gim],
    [' face="', '"', 0, / face="(\s|.)*?"/gim, / face="[^"]*"/gim],
    [' id="', '"', 0, / id="(\s|.)*?"/gim, / id="[^"]*"/gim],
    [' dir="', '"', 0, / dir="(\s|.)*?"/gim, / dir="[^"]*"/gim],
    [' role="', '"', 0, / role="(\s|.)*?"/gim, / role="[^"]*"/gim],
    [
      ' contenteditable="',
      '"',
      0,
      / contenteditable="(\s|.)*?"/gim,
      / contenteditable="[^"]*"/gim,
    ],
    [' class="', '"', 0, / class="(\s|.)*?"/gim, / class="[^"]*"/gim],
    [
      ' data-hax-ray="',
      '"',
      0,
      / data-hax-ray="(\s|.)*?"/gim,
      / data-hax-ray="[^"]*"/gim,
    ],
    [' t="', '"', 0, / t="(\s|.)*?"/gim, / t="[^"]*"/gim],
  ];
  for (const c of cases) {
    const opener = c[0];
    const quote = c[1];
    fuzz(
      "regex " + JSON.stringify(opener),
      [opener, opener.toUpperCase(), quote, "a", "\n", " ", "\r", " "],
      12,
      (s) => s.replace(c[3], ""),
      (s) => s.replace(c[4], ""),
      3000,
    );
    fast("stripMSWord with unterminated" + JSON.stringify(opener), () => {
      stripMSWord(opener + " ".repeat(50000));
      stripMSWord((opener + " ").repeat(5000));
    });
  }
  test("stripMSWord still removes attributes", () => {
    const out = stripMSWord(
      '<p style="color:red" class="MsoNormal" id="x" dir="ltr" role="a" contenteditable="true" face="Arial" t="1">hi</p>',
    );
    assert.equal(out, "<p>hi</p>");
    assert.equal(stripMSWord("<p style='a:b'>x</p>"), "<p>x</p>");
  });
});

describe("linearText: HAXCMS.js alerts", () => {
  // #375 cleanSearchData tag strip
  fuzz(
    "stripAngleTags (#375)",
    ["<", ">", "a", " ", "\n", "<>", "<a>"],
    14,
    (s) => s.replace(/(<([^>]+)>)/gi, ""),
    (s) => stripAngleTags(s, ""),
  );
  fuzz(
    "stripAngleTags with replacement",
    ["<", ">", "a", " "],
    14,
    (s) => s.replace(/<[^>]+>/g, " "),
    (s) => stripAngleTags(s, " "),
  );
  fast("stripAngleTags", () => {
    stripAngleTags("<".repeat(100000), "");
    stripAngleTags("<>".repeat(50000), "");
  });
  test("stripAngleTags representative", () => {
    assert.equal(
      stripAngleTags("<p>Hello <b>world</b></p>", ""),
      "Hello world",
    );
  });

  // #383 html validity check
  fuzz(
    "hasAngleTag (#383)",
    ["<", ">", "a", " ", "\n", "<>"],
    12,
    (s) => /<[^>]+>/.test(s),
    hasAngleTag,
  );
  fast("hasAngleTag", () => {
    assert.equal(hasAngleTag("<".repeat(100000)), false);
    assert.equal(hasAngleTag("<>".repeat(50000)), false);
  });

  // #376-#381, #385 slash trims
  fuzz(
    "trimTrailingSlashes (#377-381)",
    ["/", "a", "\n"],
    12,
    (s) => s.replace(/\/+$/, ""),
    trimTrailingSlashes,
  );
  fuzz(
    "trimSlashes (#385)",
    ["/", "a", "\n"],
    12,
    (s) => s.replace(/^\/+|\/+$/g, ""),
    trimSlashes,
  );
  fast("slash trims", () => {
    trimTrailingSlashes("/".repeat(200000) + "x");
    trimSlashes("/".repeat(200000) + "x" + "/".repeat(200000));
  });
  test("slash trims representative", () => {
    assert.equal(trimTrailingSlashes("https://a.b/c//"), "https://a.b/c");
    assert.equal(trimSlashes("/x/y/"), "x/y");
    assert.equal(trimSlashes("///"), "");
  });

  // #382 backslash-quote cleanup
  fuzz(
    "removeBackslashesBeforeQuote (#382)",
    ["\\", '"', "a", " "],
    12,
    (s) => s.replace(new RegExp('\\\\+"', "g"), '"'),
    removeBackslashesBeforeQuote,
  );
  fast("removeBackslashesBeforeQuote", () => {
    removeBackslashesBeforeQuote("\\".repeat(200000) + "x");
    removeBackslashesBeforeQuote('\\\\"'.repeat(50000));
  });

  // #368/#369 content tag scan
  const OLD_TAG = /<(?:"[^"]*"['"]*|'[^']*'['"]*|[^'">])+>/g;
  // what the old code produced, restricted to keys that can resolve (bare
  // closing tags); opening-tag keys carried a leading "<" and never resolved
  function oldNames(s) {
    const out = [];
    const matches = s.match(OLD_TAG) || [];
    for (const m of matches) {
      if (m.indexOf("-") !== -1) {
        const tag = m.replace(/<\//g, "").replace(/>/g, "");
        if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(tag) && out.indexOf(tag) === -1) {
          out.push(tag);
        }
      }
    }
    return out;
  }
  fuzz(
    "closingCustomElementNames (#368/#369) resolvable names",
    [
      "<my-el>",
      "</my-el>",
      "</p>",
      "<p>",
      "</a-b>",
      " ",
      "a",
      "-",
      "\n",
      'x="y"',
    ],
    8,
    oldNames,
    (s) =>
      closingCustomElementNames(s).filter((n) =>
        /^[a-z0-9]+(-[a-z0-9]+)+$/.test(n),
      ),
  );
  test("closingCustomElementNames representative", () => {
    assert.deepEqual(
      closingCustomElementNames(
        '<p>x</p><my-el a="b">t</my-el><other-el></other-el><my-el></my-el>',
      ),
      ["my-el", "other-el"],
    );
  });
  fast("closingCustomElementNames", () => {
    closingCustomElementNames("<" + '"'.repeat(100000));
    closingCustomElementNames("</" + "-".repeat(100000));
    closingCustomElementNames("</a".repeat(50000));
  });

  // #387 pageBreakParser
  const OLD_PB =
    /(<page-break([\s\S]*?)>([\s\S]*?)<\/page-break>)([\s\S]*?)(?=<page-break)/g;
  fuzz(
    "findPageBreakSections (#387)",
    [
      "<page-break",
      ">",
      "</page-break>",
      "a",
      " ",
      "/",
      "\n",
      "<page-break></page-break>",
    ],
    10,
    (s) =>
      [...s.matchAll(OLD_PB)].map((m) => ({ attributes: m[2], content: m[4] })),
    findPageBreakSections,
    6000,
  );
  fast("findPageBreakSections", () => {
    findPageBreakSections("<page-break>".repeat(50000));
    findPageBreakSections("<page-break a>".repeat(50000) + "</page-break>");
    findPageBreakSections("<page-break".repeat(50000));
  });

  // #386 parse_attributes
  const OLD_ATTR =
    /\s*(?:([a-z0-9-]+)\s*=\s*"([^"]*)")|(?:\s+([a-z0-9-]+)(?=\s*|>|\s+[a..z0-9]+))/gi;
  const caps = (ms) => ms.map((m) => [m.index, m[0], m[1], m[2], m[3]]);
  fuzz(
    "matchAttributes (#386)",
    [" ", "a", "B", "-", "=", '"', "1", "\n", "title", "="],
    14,
    (s) => caps([...s.matchAll(OLD_ATTR)]),
    (s) => caps(matchAttributes(s)),
    8000,
  );
  fast("matchAttributes", () => {
    matchAttributes(" ".repeat(100000));
    matchAttributes("a".repeat(100000));
    matchAttributes("a ".repeat(50000));
    matchAttributes('a="'.repeat(30000));
  });
});

describe("HAXCMS.pageBreakParser integration", () => {
  test("parses page-breaks and attributes like before", () => {
    const HAXCMS = require("../../src/lib/HAXCMS.js");
    const inst =
      HAXCMS.HAXCMS && HAXCMS.HAXCMS.pageBreakParser ? HAXCMS.HAXCMS : HAXCMS;
    if (typeof inst.pageBreakParser !== "function") {
      return;
    }
    const out = inst.pageBreakParser(
      '<page-break title="A b" slug="a" published></page-break><p>one</p><page-break title="B" slug="b"></page-break><p>two</p>',
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].content, "<p>one</p>");
    assert.equal(out[0].attributes.title, "A b");
    assert.equal(out[0].attributes.slug, "a");
    assert.equal(out[0].attributes.published, "published");
    assert.equal(out[1].content, "<p>two</p>");
    assert.equal(out[1].attributes.slug, "b");
  });
});
