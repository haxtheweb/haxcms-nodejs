// Property-based fuzzing (fast-check) of the security-critical string
// handling helpers: path confinement, URL host matching and the untrusted HTML
// sanitizer. These take attacker-controlled input, so the properties are
// "never throws" and "never lets the dangerous thing through".
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fc = require("fast-check");
const {
  hasTraversal,
  isUnsafeRelativePath,
  pathWithinBase,
  resolveContainedPath,
} = require("../../src/lib/pathConfinement.js");
const { urlHostMatches } = require("../../src/lib/urlHost.js");
const { sanitizeUntrustedHtml } = require("../../src/lib/convertUtils.js");

const RUNS = { numRuns: 300 };

// path-ish strings biased toward traversal tricks
const pathToken = fc.constantFrom(
  "..",
  ".",
  "a",
  "b.txt",
  "/",
  "\\",
  "%2e%2e",
  "\0",
  " ",
  "~",
  "C:",
  "...",
  "files",
);
const pathish = fc
  .array(fc.oneof(pathToken, fc.string({ maxLength: 6 })), { maxLength: 8 })
  .map((parts) => parts.join(""));

test("hasTraversal / isUnsafeRelativePath flag every '..' segment and NUL", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ maxLength: 5 }), { maxLength: 4 }),
      fc.constantFrom("/", "\\"),
      fc.array(fc.string({ maxLength: 5 }), { maxLength: 4 }),
      (before, sep, after) => {
        const value = [...before, "..", ...after].join(sep);
        assert.strictEqual(hasTraversal(value), true);
        assert.strictEqual(isUnsafeRelativePath(value), true);
      },
    ),
    RUNS,
  );
  fc.assert(
    fc.property(fc.string(), fc.string(), (a, b) => {
      assert.strictEqual(hasTraversal(a + "\0" + b), true);
    }),
    RUNS,
  );
});

test("resolveContainedPath never returns a path outside the base", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-fuzz-"));
  const realBase = fs.realpathSync(base);
  try {
    fs.mkdirSync(path.join(base, "files"));
    fc.assert(
      fc.property(fc.oneof(pathish, fc.string()), (location) => {
        const result = resolveContainedPath(base, location);
        if (result !== false) {
          assert.strictEqual(typeof result, "string");
          assert.ok(
            pathWithinBase(result, realBase) || pathWithinBase(result, base),
            `escaped base: ${JSON.stringify(location)} -> ${result}`,
          );
        }
      }),
      RUNS,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("urlHostMatches never throws and returns a boolean", () => {
  fc.assert(
    fc.property(fc.anything(), (value) => {
      assert.strictEqual(
        typeof urlHostMatches(value, ["youtube.com"]),
        "boolean",
      );
    }),
    RUNS,
  );
});

test("urlHostMatches ignores the domain when it is only in path/query/userinfo", () => {
  const domain = "youtube.com";
  const label = fc.stringMatching(/^[a-z]{1,8}$/);
  fc.assert(
    fc.property(
      label,
      fc.constantFrom("/", "/watch?u=", "/?next=", "#"),
      (evil, tail) => {
        // evil host + the trusted domain only in the path/query/fragment
        const host = `${evil}.invalid`;
        assert.strictEqual(
          urlHostMatches(`https://${host}${tail}${domain}`, [domain]),
          false,
        );
        // trusted domain only as userinfo in front of the real host
        assert.strictEqual(
          urlHostMatches(`https://${domain}@${host}/`, [domain]),
          false,
        );
        // look-alike suffix without a dot boundary
        assert.strictEqual(
          urlHostMatches(`https://${evil}${domain}/`, [domain]),
          false,
        );
      },
    ),
    RUNS,
  );
  fc.assert(
    fc.property(label, (sub) => {
      assert.strictEqual(
        urlHostMatches(`https://${sub}.${domain}/x`, [domain]),
        true,
      );
      assert.strictEqual(urlHostMatches(`//${domain}/x`, [domain]), true);
    }),
    RUNS,
  );
});

const htmlToken = fc.constantFrom(
  "<script>alert(1)</script>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<img src=x onerror=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  "<a href=' jav&#x09;ascript:alert(1)'>x</a>",
  "<iframe src=//evil.example></iframe>",
  "<svg onload=alert(1)>",
  '<p onclick="x()">hi</p>',
  "<style>@import 'x'</style>",
  "<",
  ">",
  '"',
  "'",
  "&lt;",
  "text",
  "<p>",
  "</p>",
  "\0",
);

test("sanitizeUntrustedHtml never throws and strips active content", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.array(htmlToken, { maxLength: 8 }).map((t) => t.join("")),
        fc.string(),
        fc.string({ unit: "binary" }),
      ),
      (html) => {
        const out = sanitizeUntrustedHtml(html);
        assert.strictEqual(typeof out, "string");
        assert.ok(!/<\s*script/i.test(out), `script survived: ${out}`);
        assert.ok(!/<\s*iframe/i.test(out), `iframe survived: ${out}`);
        assert.ok(
          !/<[^>]*\son[a-z]+\s*=/i.test(out),
          `handler survived: ${out}`,
        );
        assert.ok(
          !/href\s*=\s*["']?\s*javascript:/i.test(out),
          `js url survived: ${out}`,
        );
      },
    ),
    RUNS,
  );
});

// fast-check counterexample: an iframe inside foreign SVG content made
// jsdom's window.close() throw during scratch-DOM teardown
test("sanitizeUntrustedHtml handles iframes nested in svg content", () => {
  const html =
    "<svg onload=alert(1)><iframe src=//evil.example></iframe><p><iframe src=//evil.example></iframe>";
  const out = sanitizeUntrustedHtml(html);
  assert.strictEqual(typeof out, "string");
  assert.ok(!/<\s*iframe/i.test(out), `iframe survived: ${out}`);
  assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(out), `handler survived: ${out}`);
});
