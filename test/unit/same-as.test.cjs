// Site sameAs: the site's profiles elsewhere, published on the Organization
// node of the managed head's JSON-LD (haxtheweb/issues#3367).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSameAsList,
  SAME_AS_MAX_COUNT,
} = require("../../src/lib/sameAs.js");

test("normalizeSameAsList keeps http(s) profile URLs in order, once", () => {
  assert.deepEqual(
    normalizeSameAsList(
      "https://github.com/haxtheweb\n  https://www.linkedin.com/company/x  \r\nhttps://github.com/haxtheweb\n\nhttp://example.org/a",
    ),
    [
      "https://github.com/haxtheweb",
      "https://www.linkedin.com/company/x",
      "http://example.org/a",
    ],
  );
  assert.deepEqual(normalizeSameAsList(["https://mastodon.social/@hax"]), [
    "https://mastodon.social/@hax",
  ]);
});

test("normalizeSameAsList drops anything that is not a plain web URL", () => {
  assert.deepEqual(
    normalizeSameAsList([
      "javascript:alert(1)",
      "mailto:a@example.com",
      "data:text/html,x",
      "files/relative.html",
      "https://user:pass@example.com/",
      "not a url",
      "",
      5,
      null,
      {},
      "https://" + "a".repeat(2050) + ".com",
    ]),
    [],
  );
  assert.deepEqual(normalizeSameAsList(null), []);
  assert.deepEqual(normalizeSameAsList({ 0: "https://x.org" }), []);
});

test("normalizeSameAsList keeps at most SAME_AS_MAX_COUNT", () => {
  const many = [];
  for (let i = 0; i < SAME_AS_MAX_COUNT + 5; i++) {
    many.push("https://example.org/" + i);
  }
  assert.equal(normalizeSameAsList(many).length, SAME_AS_MAX_COUNT);
});

test("normalizeSameAsList matches the shared vectors haxcms-php uses", () => {
  const { vectors } = require("../fixtures/same-as-vectors.json");
  vectors.forEach(({ input, kept }) => {
    assert.deepEqual(
      normalizeSameAsList([input]),
      kept === null ? [] : [kept],
      input,
    );
  });
});
