const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("node-html-parser");
const {
  sanitizeUntrustedHtml,
  htmlFromEl,
} = require("../../src/lib/convertUtils.js");

function el(html) {
  return parse(`<div id="w">${html}</div>`).querySelector("#w").firstChild;
}

test("sanitizeUntrustedHtml strips script blocks, including nested-tag bypasses", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<scr<script></script>ipt>alert(1)</scr</script >ipt>",
    "<SCRIPT >alert(1)</SCRIPT >",
    "<script/x>alert(1)</script>",
    "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
    "<style>@import 'x';</style><p>hi</p>",
  ];
  for (const payload of payloads) {
    const out = sanitizeUntrustedHtml(payload);
    assert.ok(
      !/<\s*script/i.test(out),
      `script survived: ${payload} -> ${out}`,
    );
    assert.ok(!/<\s*style/i.test(out), `style survived: ${payload} -> ${out}`);
    assert.ok(!/srcdoc/i.test(out), `srcdoc survived: ${payload} -> ${out}`);
  }
});

test("sanitizeUntrustedHtml removes event handlers and javascript: URLs", () => {
  const out = sanitizeUntrustedHtml(
    '<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><a href=" jav&#x09;ascript:alert(1)">y</a><div onclick="x()">z</div>',
  );
  assert.ok(!/onerror|onclick/i.test(out), out);
  assert.ok(!/javascript:/i.test(out), out);
});

test("sanitizeUntrustedHtml keeps ordinary content", () => {
  const out = sanitizeUntrustedHtml(
    '<h1>Title</h1><p>Hello <strong>world</strong></p><a href="https://example.com/a">link</a><img src="https://example.com/i.png" alt="i"><video-player source="https://example.com/v.mp4"></video-player>',
  );
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<strong>world<\/strong>/);
  assert.match(out, /href="https:\/\/example\.com\/a"/);
  assert.match(out, /<img[^>]+src="https:\/\/example\.com\/i\.png"/);
  assert.match(out, /<video-player/);
});

test("sanitizeUntrustedHtml handles non-strings and null bytes", () => {
  assert.equal(sanitizeUntrustedHtml(null), "");
  assert.equal(sanitizeUntrustedHtml(undefined), "");
  assert.ok(!sanitizeUntrustedHtml("<p>a\u0000b</p>").includes("\u0000"));
});

function attrsOf(html, selector) {
  const node = parse(html).querySelector(selector);
  return node ? Object.keys(node.attributes) : null;
}

test("htmlFromEl escapes attribute values built from paragraph text", () => {
  const url = 'https://youtube.com/watch?v=1" onload="alert(1)';
  const out = htmlFromEl(el(`<p>${url.replace(/"/g, "&quot;")}</p>`));
  // the value must stay inside the single source attribute
  assert.deepEqual(attrsOf(out, "video-player"), ["source"], out);
});

test("htmlFromEl escapes placeholder text and math content", () => {
  const ph = htmlFromEl(el('<p>[text: say "hi" now]</p>'));
  assert.deepEqual(attrsOf(ph, "place-holder"), ["type", "text"], ph);
  const math = htmlFromEl(el("<p>[math: a &lt; b]</p>"));
  const m = parse(math).querySelector("lrn-math");
  assert.ok(m, math);
  assert.equal(m.childNodes.length, 1, math); // text only, no injected elements
  const injected = htmlFromEl(
    el("<p>[math: <img src=x onerror=alert(1)>]</p>"),
  );
  assert.ok(!parse(injected).querySelector("img"), injected);
});

test("htmlFromEl only emits well-formed custom element names for ! placeholders", () => {
  assert.equal(
    htmlFromEl(el("<p>!my-element</p>")),
    "<my-element></my-element>",
  );
  const bad = htmlFromEl(el("<p>!x-y onmouseover=alert(1)</p>"));
  const x = parse(bad).querySelector("x-y");
  assert.equal(x, null, bad); // not turned into an element with extra attributes
});
