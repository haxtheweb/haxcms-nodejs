/* global process, console */
// Generates test/fixtures/block-operations-vectors.json from the node
// implementation (haxtheweb/issues#3270); haxcms-php must reproduce every
// expectation. Copy the result to haxcms-php
// system/backend/php/tests/fixtures/block-operations-vectors.json.
//
// usage: node scripts/generate-block-operation-vectors.cjs . <stored page html files...>
// then: npx prettier --write test/fixtures/block-operations-vectors.json
// (the published vectors used pages from webcomponents
// elements/haxcms-elements/test/fixtures/insights/pages and demo/pages)
const fs = require("fs");
const path = require("path");
const root = path.resolve(process.argv[2] || ".");
const bo = require(path.join(root, "src/lib/blockOperations.js"));
const { sanitizeHTMLForStorage } = require(
  path.join(root, "src/lib/sanitizeContent.js"),
);
const run = (html, ops) =>
  bo.runBlockOperations(html, ops, { sanitize: sanitizeHTMLForStorage });
const ref = (html, tag, index) => {
  const el = bo.scanElements(html).filter((e) => e.tag === tag)[index];
  return { tag, index, before: html.slice(el.start, el.end) };
};
const set = (html, tag, index, s) =>
  Object.assign({ op: "setAttributes", set: s }, ref(html, tag, index));
const rep = (html, tag, index, after) =>
  Object.assign({ op: "replaceBlock", after }, ref(html, tag, index));
const crypto = require("crypto");
const cases = [];
const pages = {};
function add(name, html, ops, pageKey) {
  const r = run(html, ops);
  let expect;
  if (r.ok) {
    expect = {
      ok: true,
      sha256: crypto
        .createHash("sha256")
        .update(r.content, "utf8")
        .digest("hex"),
      blocks: r.results.map((x) => r.content.slice(x.start, x.end)),
      indexes: r.results.map((x) => x.index),
      relocated: r.results.map((x) => x.relocated),
    };
    if (!pageKey) expect.content = r.content;
  } else {
    expect = {
      ok: false,
      code: r.code,
      op: typeof r.op === "number" ? r.op : null,
    };
  }
  const c = { name };
  if (pageKey) c.page = pageKey;
  else c.html = html;
  c.ops = ops;
  c.expect = expect;
  cases.push(c);
}
// --- scanning and splicing
const P =
  '<h2>Intro</h2><p>Text <img src="files/a.png" alt="old"> more</p><media-image source="files/m.jpg"></media-image>';
add("set existing alt", P, [
  set(P, "img", 0, { alt: "A water cycle diagram" }),
]);
add("trim text value", P, [set(P, "img", 0, { alt: "  spaced  " })]);
add("add missing attribute after tag name, escaped", P, [
  set(P, "media-image", 0, { alt: 'He said "hi" & <left>' }),
]);
add("remove attribute", P, [set(P, "img", 0, { alt: null })]);
add("unicode value", P, [
  set(P, "img", 0, { alt: "emoji 🧪 مرحبا 光合作用 İstanbul" }),
]);
add("newline and tab in text value", P, [
  set(P, "img", 0, { alt: "line\nbreak\ttab" }),
]);
add("control character refused", P, [set(P, "img", 0, { alt: "bell\u0007" })]);
add("unicode spaces trimmed like String.prototype.trim", P, [
  set(P, "img", 0, { alt: "　 ﻿ wide   " }),
]);
add("CRLF and CR stored as LF", P, [set(P, "img", 0, { alt: "a\r\nb\rc" })]);
add("length counts code points: 4000 emoji accepted", P, [
  set(P, "img", 0, { alt: "🧪".repeat(4000) }),
]);
add("length counts code points: 4001 emoji refused", P, [
  set(P, "img", 0, { alt: "🧪".repeat(4001) }),
]);
add("unicode space inside url refused", '<a href="x">l</a>', [
  {
    op: "setAttributes",
    tag: "a",
    index: 0,
    before: '<a href="x">l</a>',
    set: { href: "https://e.x/ a" },
  },
]);
add("unicode spaces around url trimmed", '<a href="x">l</a>', [
  {
    op: "setAttributes",
    tag: "a",
    index: 0,
    before: '<a href="x">l</a>',
    set: { href: " https://e.x/a　" },
  },
]);
add(
  "op tag and attribute names lower-cased in ASCII only",
  '<IMG SRC="a.png">',
  [
    {
      op: "setAttributes",
      tag: "IMG",
      index: 0,
      before: '<IMG SRC="a.png">',
      set: { ALT: "x" },
    },
  ],
);
add(
  "non-ASCII letters in a tag name are not folded",
  '<İmg src="a.png"><img src="b.png">',
  [
    {
      op: "setAttributes",
      tag: "img",
      index: 0,
      before: '<img src="b.png">',
      set: { alt: "b" },
    },
  ],
);
add("text too long refused", P, [set(P, "img", 0, { alt: "x".repeat(4001) })]);
const Q = `<img alt='single "q"' src=unquoted data-x><IMG SRC="UP.png" ALT="UP">`;
add("single-quoted value rewritten", Q, [set(Q, "img", 0, { alt: "new" })]);
add("unquoted value rewritten", Q, [set(Q, "img", 0, { src: "files/b.png" })]);
add("uppercase tag and attribute", Q, [set(Q, "img", 1, { alt: "lower" })]);
const S = '<simple-img src=y alt=z /><video-player source="v"></video-player>';
add("self-closed custom element", S, [set(S, "simple-img", 0, { alt: "Z" })]);
add("custom element text attribute", S, [
  set(S, "video-player", 0, { "media-title": "Lecture 1" }),
]);
const R =
  '<!-- <img alt="comment"> --><script>var s = "<img alt=\\"js\\">";</script><textarea><img alt="raw"></textarea><img alt="real">';
add("elements in comments, script and textarea are not counted", R, [
  set(R, "img", 0, { alt: "REAL" }),
]);
const U = '<p>İİİ ǅ ẞ</p><script>x</SCRIPT ><img alt="a">';
add("offsets after length-changing case characters", U, [
  set(U, "img", 0, { alt: "b" }),
]);
const D = '<img alt="a" alt="b" src="x">';
add("duplicate attribute not addressable", D, [set(D, "img", 0, { alt: "c" })]);
// --- url kind
const L =
  '<a href="https://media.aanda.psu.edu/v.mp4">v</a><video-player source="https://media.aanda.psu.edu/x.mp4"></video-player>';
add("url swap on link", L, [
  set(L, "a", 0, { href: "https://media.psu.edu/v.mp4" }),
]);
add("url swap on custom element", L, [
  set(L, "video-player", 0, { source: "https://media.psu.edu/x.mp4" }),
]);
add("site path url", L, [set(L, "a", 0, { href: "files/v.mp4" })]);
for (const bad of [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,x",
  "//evil.example/x",
  "https://exa mple.org",
  "vbscript:x",
  "https://",
  "http://a\u0000b",
]) {
  add(`url refused: ${JSON.stringify(bad)}`, L, [
    set(L, "a", 0, { href: bad }),
  ]);
}
add("url too long refused", L, [
  set(L, "a", 0, { href: "https://e.x/" + "a".repeat(2048) }),
]);
for (const u of [
  "HTTPS://E.X:8443/p?q#h",
  "https://[::1]:80/x",
  "https://good.example@evil.example/",
  "https://exa%20mple.org",
  "https://bücher.de/",
  "http:/x",
  "/abs/path.png",
  "a:b",
  "./x:y",
  "mailto:a@b.c",
  "\\\\evil\\share",
  "https://e.x\\y",
  "https://e..x",
  "https://-e.x",
  "https://e.x:123456",
  "",
]) {
  add(`url rule: ${JSON.stringify(u)}`, L, [set(L, "a", 0, { href: u })]);
}
// URL values are stored as sent, on native and custom elements
const LU =
  '<a href="/a">a</a><img src="/i.png"><video-player source="/v.mp4"></video-player><track src="/t.vtt">';
for (const u of [
  "/files/café.png",
  "/q?a=$1&b[]=2",
  "/x^`{|}y",
  "https://e.x/媒体/視頻.mp4#t=1",
  "/already%C3%A9",
  "https://e.x/😀",
  "https://[::1]/x",
]) {
  add(`url stored as sent on a: ${JSON.stringify(u)}`, LU, [
    set(LU, "a", 0, { href: u }),
  ]);
  add(`url stored as sent on img: ${JSON.stringify(u)}`, LU, [
    set(LU, "img", 0, { src: u }),
  ]);
  add(`url stored as sent on custom element: ${JSON.stringify(u)}`, LU, [
    set(LU, "video-player", 0, { source: u }),
  ]);
}
add("url stored as sent on track", LU, [
  set(LU, "track", 0, { src: "/captions/é.vtt" }),
]);
add("url length counts characters", L, [
  set(L, "a", 0, { href: "/" + "é".repeat(400) }),
]);
// sequences DOMPurify drops an attribute for are refused in both backends;
// ASCII case only, so a non-ASCII look-alike letter is ordinary text
for (const v of [
  "a --> b",
  "a --!> b",
  "x]>y",
  "end </TITLE> x",
  "</script",
  "</ſtyle>",
  "- ->",
  "] >",
  "<!-- ok",
]) {
  add(`markup-close rule: ${JSON.stringify(v)}`, P, [
    set(P, "img", 0, { alt: v }),
  ]);
}
add("markup-close rule on url", L, [set(L, "a", 0, { href: "/x-->y" })]);
// a custom element written <x-y /> is an open tag (as browsers parse it), so
// it has no exact end unless closed later
const SC =
  "<simple-img src=x alt=y /><p>after</p><simple-img src=z />tail</simple-img>";
add("self-closed custom element is an open tag", SC, [
  {
    op: "setAttributes",
    tag: "simple-img",
    index: 0,
    before: "<simple-img src=x alt=y />",
    set: { alt: "q" },
  },
]);
add("self-closed custom element closed later", SC, [
  set(SC, "simple-img", 1, { alt: "q" }),
]);
// HTML5 void siblings edited together (an HTML4 parser nests <track> in <source>)
const AV =
  '<video controls><source src="/v.mp4" type="video/mp4"><track src="/t.vtt" kind="captions" label="en"></video>';
add("source and track siblings in one batch", AV, [
  set(AV, "source", 0, { src: "/v2.mp4" }),
  set(AV, "track", 0, { src: "/t2.vtt", label: null }),
]);
// --- allowlist
for (const name of [
  "onerror",
  "OnClick",
  "style",
  "srcdoc",
  "formaction",
  "data-x",
  "class",
  "id",
]) {
  add(`attribute not allowed: ${name}`, P, [set(P, "img", 0, { [name]: "x" })]);
}
add("tag not in allowlist", P, [set(P, "h2", 0, { title: "x" })]);
const PB = '<page-break title="T"></page-break><p>a</p>';
add("page-break never a target", PB, [
  set(PB, "page-break", 0, { title: "x" }),
]);
add("non-string value refused", P, [set(P, "img", 0, { alt: 5 })]);
add("empty set refused", P, [set(P, "img", 0, {})]);
add("unknown op refused", P, [
  Object.assign(ref(P, "img", 0), { op: "deleteBlock" }),
]);
// --- before guard
const T = '<img src="a.png"><img src="b.png"><img src="a.png">';
add("stale before", T, [
  Object.assign(set(T, "img", 1, { alt: "x" }), {
    before: '<img src="b2.png">',
  }),
]);
add("relocated unique", T, [
  Object.assign(set(T, "img", 1, { alt: "B" }), { index: 0 }),
]);
add("ambiguous twins", T, [
  Object.assign(set(T, "img", 0, { alt: "A" }), { index: 1 }),
]);
add("right index on twins", T, [set(T, "img", 2, { alt: "third" })]);
add("index out of range relocates", T, [
  Object.assign(set(T, "img", 1, { alt: "B" }), { index: 99 }),
]);
const I = "<ul><li>one<li>two</ul><p>a<div>b</div>";
add("implicitly closed element not addressable", I, [
  {
    op: "setAttributes",
    tag: "li",
    index: 0,
    before: "<li>one",
    set: { title: "x" },
  },
]);
// --- batches
const B =
  '<div><img src="a.png"></div><img src="b.png"><video-player source="v"></video-player>';
add("batch of three", B, [
  set(B, "img", 0, { alt: "A" }),
  set(B, "img", 1, { alt: "B" }),
  set(B, "video-player", 0, { "media-title": "L" }),
]);
add("batch refused by second op", B, [
  set(B, "img", 0, { alt: "A" }),
  set(B, "img", 1, { onclick: "x" }),
]);
const N = '<a href="x"><img src="a.png"></a>';
add("nested targets refused", N, [
  set(N, "a", 0, { title: "t" }),
  set(N, "img", 0, { alt: "a" }),
]);
add("same target twice refused", N, [
  set(N, "img", 0, { alt: "a" }),
  set(N, "img", 0, { alt: "b" }),
]);
// --- replaceBlock
const V =
  '<p>Intro</p><video-player source="https://youtu.be/a" media-title="old"></video-player><p>After</p>';
add("replace block same tag", V, [
  rep(
    V,
    "video-player",
    0,
    '<video-player source="https://youtu.be/b" media-title="new"></video-player>',
  ),
]);
add("replace with different tag refused", V, [
  rep(V, "video-player", 0, "<media-image></media-image>"),
]);
add("replace with two elements refused", V, [
  rep(V, "video-player", 0, "<video-player></video-player><p>x</p>"),
]);
add("replace containing page-break refused", V, [
  rep(
    V,
    "video-player",
    0,
    "<video-player><page-break></page-break></video-player>",
  ),
]);
add("replace with handler refused", V, [
  rep(V, "video-player", 0, '<video-player onerror="x"></video-player>'),
]);
add("replace with script refused", V, [
  rep(V, "video-player", 0, "<video-player><script>x</script></video-player>"),
]);
add("replace with unclosed element refused", V, [
  rep(V, "video-player", 0, "<video-player>"),
]);
// --- real stored pages: every allowlisted block gets an alt/title edit
const corpus = process.argv.slice(3);
let k = 0;
for (const f of corpus) {
  const html = fs.readFileSync(f, "utf8");
  if (html.length > 30000) continue;
  const key =
    path.basename(f) === "index.html"
      ? path.basename(path.dirname(f))
      : path.basename(f, ".html");
  const blocks = bo.listBlocks(html).slice(0, 6);
  if (!blocks.length) continue;
  pages[key] = html;
  for (const b of blocks) {
    const allowed = bo.ALLOWLIST.tags[b.tag];
    const name =
      Object.keys(allowed).find((n) => allowed[n] === "text") ||
      Object.keys(allowed)[0];
    const value =
      allowed[name] === "url"
        ? "https://media.psu.edu/moved/file.png"
        : `Edited ${b.tag} #${b.index}`;
    add(
      `corpus ${path.basename(path.dirname(f))} ${b.tag}#${b.index} ${name}`,
      html,
      [
        {
          op: "setAttributes",
          tag: b.tag,
          index: b.index,
          before: b.before,
          set: { [name]: value },
        },
      ],
      key,
    );
    k++;
  }
}
const out = {
  $comment:
    "Shared block operation vectors (haxtheweb/issues#3270). Generated from haxcms-nodejs src/lib/blockOperations.js; haxcms-php must reproduce every expectation byte for byte. Keep identical in both repos.",
  version: 1,
  pages,
  cases,
};
fs.writeFileSync(
  path.join(root, "test/fixtures/block-operations-vectors.json"),
  JSON.stringify(out, null, 1) + "\n",
);
console.log(
  cases.length,
  "cases,",
  k,
  "from corpus;",
  cases.filter((c) => c.expect.ok).length,
  "accepted",
);
console.log(
  Object.entries(
    cases.reduce((m, c) => {
      const k2 = c.expect.ok ? "ok" : c.expect.code;
      m[k2] = (m[k2] || 0) + 1;
      return m;
    }, {}),
  )
    .map(([a, b]) => `${a}:${b}`)
    .join(" "),
);
