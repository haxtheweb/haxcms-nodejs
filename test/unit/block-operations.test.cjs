"use strict";

// Unit tests for src/lib/blockOperations.js (haxtheweb/issues#3270): the
// stored-source scanner, setAttributes / replaceBlock, the before guard
// (stale, relocated, ambiguous), the per-tag allowlist and value kinds, the
// change-only sanitizer check and the structural check.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const bo = require("../../src/lib/blockOperations.js");
const { sanitizeHTMLForStorage } = require("../../src/lib/sanitizeContent.js");

const run = (html, ops) =>
  bo.runBlockOperations(html, ops, { sanitize: sanitizeHTMLForStorage });
const ref = (html, tag, index) => {
  const el = bo.scanElements(html).filter((e) => e.tag === tag)[index];
  return { tag, index, before: html.slice(el.start, el.end) };
};
const setOp = (html, tag, index, set) =>
  Object.assign({ op: "setAttributes", set }, ref(html, tag, index));

describe("scanElements", () => {
  test("records exact spans for void, explicit and raw-text elements", () => {
    const html =
      '<p>a <img src="x.png"> <b>b</b></p><simple-img src=y alt=z /><script>if (a < b) { "</div>" }</script><video-player source="v"></video-player>';
    const els = bo.scanElements(html);
    const by = (tag) => els.find((e) => e.tag === tag);
    assert.equal(
      html.slice(by("img").start, by("img").end),
      '<img src="x.png">',
    );
    // <x-y /> is an open tag, as browsers parse it; this one never closes
    assert.equal(by("simple-img").explicit, false);
    assert.equal(by("simple-img").end, -1);
    assert.equal(
      html.slice(by("script").start, by("script").end),
      '<script>if (a < b) { "</div>" }</script>',
    );
    assert.equal(
      html.slice(by("video-player").start, by("video-player").end),
      '<video-player source="v"></video-player>',
    );
    assert.equal(by("p").explicit, true);
    // nothing inside the script is an element
    assert.equal(els.filter((e) => e.tag === "div").length, 0);
  });

  test("implicitly closed elements are not addressable", () => {
    const els = bo.scanElements("<ul><li>one<li>two</ul><p>a<div>b</div>");
    const lis = els.filter((e) => e.tag === "li");
    assert.equal(lis[0].explicit, false);
    const p = els.find((e) => e.tag === "p");
    assert.equal(p.explicit, false);
  });

  test("comments, quoted > and tags inside attribute values are skipped", () => {
    const html =
      '<!-- <img alt="no"> --><a title="x > <img>" href="y">t</a><img alt="yes">';
    const imgs = bo.scanElements(html).filter((e) => e.tag === "img");
    assert.equal(imgs.length, 1);
    assert.equal(html.slice(imgs[0].start, imgs[0].end), '<img alt="yes">');
  });

  test("offsets hold when the page has characters that change length when lowercased", () => {
    const html = '<p>İİİ</p><script>x</SCRIPT ><img alt="a">';
    const img = bo.scanElements(html).find((e) => e.tag === "img");
    assert.equal(html.slice(img.start, img.end), '<img alt="a">');
  });
});

describe("setAttributes", () => {
  const page =
    '<h2>Intro</h2><p>Text <img src="files/a.png" alt="old"> more</p><media-image source="files/m.jpg"></media-image>';

  test("changes only the attribute bytes, trims text values", () => {
    const r = run(page, [
      setOp(page, "img", 0, { alt: "  A water cycle diagram  " }),
    ]);
    assert.equal(r.ok, true);
    assert.equal(
      r.content,
      page.replace('alt="old"', 'alt="A water cycle diagram"'),
    );
  });

  test("adds a missing attribute right after the tag name and escapes it", () => {
    const r = run(page, [
      setOp(page, "media-image", 0, { alt: 'He said "hi" & <left>' }),
    ]);
    assert.equal(r.ok, true);
    assert.ok(
      r.content.includes(
        '<media-image alt="He said &quot;hi&quot; &amp; &lt;left&gt;" source="files/m.jpg">',
      ),
    );
  });

  test("null removes the attribute", () => {
    const r = run(page, [setOp(page, "img", 0, { alt: null })]);
    assert.equal(r.ok, true);
    assert.ok(r.content.includes('<img src="files/a.png">'));
  });

  test("url values: http(s) and site paths only", () => {
    const html = '<a href="https://media.aanda.psu.edu/v.mp4">v</a>';
    assert.equal(
      run(html, [setOp(html, "a", 0, { href: "https://media.psu.edu/v.mp4" })])
        .ok,
      true,
    );
    assert.equal(
      run(html, [setOp(html, "a", 0, { href: "files/v.mp4" })]).ok,
      true,
    );
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.example/x",
      "https://exa mple.org",
      "vbscript:x",
    ]) {
      const r = run(html, [setOp(html, "a", 0, { href: bad })]);
      assert.equal(r.ok, false, bad);
      assert.equal(r.code, "invalid", bad);
    }
  });

  test("only allowlisted attributes, never handlers or style", () => {
    for (const name of [
      "onerror",
      "style",
      "srcdoc",
      "data-x",
      "class",
      "src-set",
    ]) {
      const r = run(page, [setOp(page, "img", 0, { [name]: "x" })]);
      assert.equal(r.ok, false, name);
      assert.equal(r.code, "not-allowed", name);
    }
  });

  test("tags outside the allowlist and page metadata tags are refused", () => {
    assert.equal(
      run(page, [setOp(page, "h2", 0, { title: "x" })]).code,
      "not-allowed",
    );
    const pb = '<page-break title="T"></page-break><p>a</p>';
    assert.equal(
      run(pb, [setOp(pb, "page-break", 0, { title: "x" })]).code,
      "not-allowed",
    );
  });

  test("a value the sanitizer would drop is refused, not silently changed", () => {
    const html = '<img src="a.png">';
    // DOMPurify drops an attribute holding a closing raw-text tag; the value
    // rules refuse it first, in both backends
    const r = run(html, [
      setOp(html, "img", 0, { alt: '"></img><script>alert(1)</script>' }),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "invalid");
    // and the sanitizer check still stands behind them
    const swapped = bo.checkChangeSanitizes(
      { op: "setAttributes" },
      "img",
      { alt: "x]>y" },
      "",
      sanitizeHTMLForStorage,
    );
    assert.equal(swapped.code, "sanitizer-rejected");
  });

  test("duplicate attributes on the element are not addressable", () => {
    const html = '<img alt="a" alt="b" src="x">';
    assert.equal(
      run(html, [setOp(html, "img", 0, { alt: "c" })]).code,
      "not-addressable",
    );
  });
});

describe("before guard", () => {
  const page = '<img src="a.png"><img src="b.png"><img src="a.png">';

  test("a changed element is stale and nothing is written", () => {
    const op = setOp(page, "img", 1, { alt: "x" });
    op.before = '<img src="b2.png">';
    const r = run(page, [op]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "stale");
  });

  test("a moved but unique element is relocated", () => {
    const op = setOp(page, "img", 1, { alt: "B" });
    op.index = 0;
    const r = run(page, [op]);
    assert.equal(r.ok, true);
    assert.equal(r.results[0].relocated, true);
    assert.equal(r.results[0].index, 1);
  });

  test("a moved element with an identical twin is ambiguous", () => {
    const op = setOp(page, "img", 0, { alt: "A" });
    op.index = 1;
    assert.equal(run(page, [op]).code, "ambiguous");
  });

  test("the right index on identical twins is accepted", () => {
    const r = run(page, [setOp(page, "img", 2, { alt: "third" })]);
    assert.equal(r.ok, true);
    assert.equal(
      r.content,
      '<img src="a.png"><img src="b.png"><img alt="third" src="a.png">',
    );
  });
});

describe("batches", () => {
  const page =
    '<div><img src="a.png"></div><img src="b.png"><video-player source="v"></video-player>';

  test("several ops apply together, as one-at-a-time would", () => {
    const ops = [
      setOp(page, "img", 0, { alt: "A" }),
      setOp(page, "img", 1, { alt: "B" }),
      setOp(page, "video-player", 0, { "media-title": "Lecture 1" }),
    ];
    const r = run(page, ops);
    assert.equal(r.ok, true);
    assert.equal(
      r.content,
      '<div><img alt="A" src="a.png"></div><img alt="B" src="b.png"><video-player media-title="Lecture 1" source="v"></video-player>',
    );
  });

  test("all or nothing: one bad op refuses the batch", () => {
    const ops = [
      setOp(page, "img", 0, { alt: "A" }),
      setOp(page, "img", 1, { onclick: "x" }),
    ];
    const r = run(page, ops);
    assert.equal(r.ok, false);
    assert.equal(r.op, 1);
  });

  test("nested or repeated targets are refused", () => {
    const html = '<a href="x"><img src="a.png"></a>';
    const r = run(html, [
      setOp(html, "a", 0, { title: "t" }),
      setOp(html, "img", 0, { alt: "a" }),
    ]);
    assert.equal(r.code, "overlap");
    assert.equal(
      run(html, [
        setOp(html, "img", 0, { alt: "a" }),
        setOp(html, "img", 0, { alt: "b" }),
      ]).code,
      "overlap",
    );
  });
});

describe("replaceBlock", () => {
  const page =
    '<p>Intro</p><video-player source="https://youtu.be/a" media-title="old"></video-player><p>After</p>';

  test("replaces one element with the same tag", () => {
    const op = Object.assign(
      {
        op: "replaceBlock",
        after:
          '<video-player source="https://youtu.be/b" media-title="new"></video-player>',
      },
      ref(page, "video-player", 0),
    );
    const r = run(page, [op]);
    assert.equal(r.ok, true);
    assert.equal(
      r.content,
      '<p>Intro</p><video-player source="https://youtu.be/b" media-title="new"></video-player><p>After</p>',
    );
  });

  test("refuses a different tag, extra elements, page-breaks and markup the sanitizer would change", () => {
    const base = ref(page, "video-player", 0);
    const tryAfter = (after) =>
      run(page, [Object.assign({ op: "replaceBlock", after }, base)]);
    assert.equal(tryAfter("<media-image></media-image>").code, "invalid");
    assert.equal(
      tryAfter("<video-player></video-player><p>x</p>").code,
      "invalid",
    );
    assert.equal(
      tryAfter("<video-player><page-break></page-break></video-player>").code,
      "invalid",
    );
    assert.equal(
      tryAfter('<video-player onerror="x"></video-player>').code,
      "sanitizer-rejected",
    );
    assert.equal(
      tryAfter("<video-player><script>x</script></video-player>").code,
      "sanitizer-rejected",
    );
  });
});

describe("structural check", () => {
  test("a patch that also changes another element is caught", () => {
    const before = '<img src="a.png"><img src="b.png">';
    const op = setOp(before, "img", 0, { alt: "A" });
    const tampered = '<img alt="A" src="a.png"><img src="b.png" data-x="1">';
    const v = bo.verifyStructure(before, tampered, [op], [{ alt: "A" }]);
    assert.equal(v.ok, false);
    assert.equal(v.code, "structure-changed");
    assert.equal(
      bo.verifyStructure(
        before,
        '<img alt="A" src="a.png"><img src="b.png">',
        [op],
        [{ alt: "A" }],
      ).ok,
      true,
    );
  });
});

describe("listBlocks", () => {
  test("lists allowlisted elements with decoded allowlisted attributes", () => {
    const html =
      '<p>x</p><img src="a.png" alt="Tom &amp; Jerry" class="c"><h2>t</h2><a href="https://e.x?a=1&amp;b=2">l</a><ul><li>one</ul>';
    const blocks = bo.listBlocks(html);
    assert.deepEqual(
      blocks.map((b) => b.tag),
      ["img", "a"],
    );
    assert.deepEqual(blocks[0].attributes, {
      alt: "Tom & Jerry",
      src: "a.png",
    });
    assert.equal(blocks[1].attributes.href, "https://e.x?a=1&b=2");
    assert.equal(bo.listBlocks(html, { tag: "a" }).length, 1);
  });

  test("a listed block can be sent straight back", () => {
    const html = '<img src="a.png"><img src="a.png">';
    const b = bo.listBlocks(html)[1];
    const r = run(html, [
      {
        op: "setAttributes",
        tag: b.tag,
        index: b.index,
        before: b.before,
        set: { alt: "second" },
      },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.content, '<img src="a.png"><img alt="second" src="a.png">');
  });
});

describe("allowlist file", () => {
  test("every entry is a known kind and a valid lower-case name", () => {
    const list = bo.ALLOWLIST;
    assert.ok(list.version >= 1);
    for (const tag of Object.keys(list.tags)) {
      assert.match(tag, /^[a-z][a-z0-9-]*$/);
      assert.notEqual(tag, "page-break");
      for (const name of Object.keys(list.tags[tag])) {
        assert.match(name, /^[a-z_:][a-z0-9_.:-]*$/);
        assert.doesNotMatch(name, /^(on|style$|srcdoc$)/);
        assert.ok(
          ["text", "url"].includes(list.tags[tag][name]),
          `${tag} ${name}`,
        );
      }
    }
  });
});

describe("value rules not reachable through JSON in PHP", () => {
  test("lone surrogates are refused in text and url values", () => {
    assert.equal(bo.normalizeValue("text", "a\ud800", "alt").code, "invalid");
    assert.equal(bo.normalizeValue("url", "/x\udc00", "src").code, "invalid");
  });
  test("url values are percent-encoded where storage would encode them", () => {
    assert.equal(
      bo.normalizeValue("url", "/café$[]", "src").value,
      "/caf%C3%A9%24%5B%5D",
    );
    assert.equal(
      bo.normalizeValue("url", "https://[::1]/x", "src").code,
      "invalid",
    );
  });
});

describe("allowlist and storage agree", () => {
  // an attribute the storage sanitizer drops can never be set; it must not be
  // offered (haxcms-php runs the same check against its sanitizer)
  test("every allowlisted attribute survives the storage sanitizer", () => {
    const VOID = new Set(["area", "img", "source", "track"]);
    for (const tag of Object.keys(bo.ALLOWLIST.tags)) {
      for (const name of Object.keys(bo.ALLOWLIST.tags[tag])) {
        const html = VOID.has(tag) ? `<${tag}>` : `<${tag}></${tag}>`;
        const value =
          bo.ALLOWLIST.tags[tag][name] === "url"
            ? "/files/x.png"
            : "Plain words";
        const r = bo.runBlockOperations(
          html,
          [
            {
              op: "setAttributes",
              tag,
              index: 0,
              before: html,
              set: { [name]: value },
            },
          ],
          { sanitize: sanitizeHTMLForStorage },
        );
        assert.equal(r.ok, true, `${tag} ${name}: ${r.ok ? "" : r.message}`);
      }
    }
  });
});

describe("structure check is never partial", () => {
  test("a change after many explained ones is still found", () => {
    const imgs = (alt) =>
      Array.from(
        { length: 70 },
        (_, i) => `<img src="/${i}.png" alt="${alt}${i}">`,
      ).join("");
    const before = imgs("a") + "<p>untouched</p>";
    const after = imgs("b") + "<p>changed</p>";
    const ops = Array.from({ length: 70 }, (_, i) => ({
      op: "setAttributes",
      tag: "img",
      index: i,
      set: { alt: `b${i}` },
    }));
    const sets = ops.map((op) => op.set);
    assert.equal(
      bo.verifyStructure(before, imgs("b") + "<p>untouched</p>", ops, sets).ok,
      true,
    );
    assert.equal(
      bo.verifyStructure(before, after, ops, sets).code,
      "structure-changed",
    );
  });
});
