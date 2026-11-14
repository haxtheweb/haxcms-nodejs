/* global process, console, __dirname */
// Generates test/fixtures/sanitize-vectors.json: inputs and the stored HTML
// the storage sanitizer must produce in both haxcms-nodejs and haxcms-php
// (haxtheweb/issues#3273). Copy the file to haxcms-php
// system/backend/php/tests/fixtures/sanitize-vectors.json.
//
// usage: node scripts/generate-sanitize-vectors.cjs [--php <haxcms-php dir>] [page.html ...]
//        npx prettier --write test/fixtures/sanitize-vectors.json
// Without page arguments the pages already in the file are kept.
// With --php, cases where PHP 8.3 builds a different tree from malformed
// markup are marked php83Differs. PHP 8.3 parses with the parser
// haxcms-php ships (masterminds/html5), so the marks are the same on every
// host; PHP 8.4 (Dom\HTMLDocument) must match them all.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { sanitizeHTMLForStorage } = require("../src/lib/sanitizeContent.js");

const VECTORS_FILE = path.join(
  __dirname,
  "..",
  "test/fixtures/sanitize-vectors.json",
);

const args = process.argv.slice(2);
let phpDir = null;
const pages = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--php") {
    phpDir = args[++i];
  } else {
    const file = args[i];
    pages[path.basename(path.dirname(file)) + "/" + path.basename(file)] =
      fs.readFileSync(file, "utf8");
  }
}
if (Object.keys(pages).length === 0 && fs.existsSync(VECTORS_FILE)) {
  Object.assign(pages, JSON.parse(fs.readFileSync(VECTORS_FILE, "utf8")).pages);
}

const TAGS = [
  "a",
  "abbr",
  "acronym",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "big",
  "blink",
  "blockquote",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "header",
  "hgroup",
  "hr",
  "i",
  "iframe",
  "image",
  "img",
  "input",
  "ins",
  "isindex",
  "kbd",
  "keygen",
  "label",
  "legend",
  "li",
  "listing",
  "main",
  "map",
  "mark",
  "marquee",
  "math",
  "menu",
  "meter",
  "nav",
  "nobr",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "param",
  "picture",
  "plaintext",
  "portal",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "slot",
  "small",
  "source",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "svg",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
  "xmp",
  "frame",
  "frameset",
  "applet",
  "meta",
  "link",
  "base",
  "media-image",
  "video-player",
  "grid-plate",
  "a11y-collapse",
  "stop-note",
  "code-sample",
  "page-break",
  "simple-img",
  "a11y-gif-player",
  "x-y",
  "annotation-xml",
  "font-face",
];
const ATTRS = [
  "href",
  "src",
  "alt",
  "title",
  "target",
  "rel",
  "id",
  "class",
  "name",
  "value",
  "type",
  "width",
  "height",
  "data-x",
  "aria-label",
  "role",
  "tabindex",
  "lang",
  "dir",
  "hidden",
  "onclick",
  "onerror",
  "OnLoad",
  "style",
  "srcdoc",
  "formaction",
  "action",
  "poster",
  "srcset",
  "xlink:href",
  "xmlns",
  "xmlns:xlink",
  "link",
  "source",
  "file",
  "sources",
  "tracks",
  "image-url",
  "thumbnail-src",
  "my-href",
  "download",
  "ping",
  "background",
  "cite",
  "longdesc",
  "usemap",
  "contenteditable",
  "slot",
  "is",
  "part",
  "nonce",
  "loading",
  "allow",
  "sandbox",
  "allowfullscreen",
  "referrerpolicy",
  "credentialless",
  "controls",
  "colspan",
  "open",
  "checked",
  "disabled",
  "readonly",
  "multiple",
  "selected",
  "placeholder",
  "for",
  "label",
  "caption",
  "summary",
  "accent-color",
  "icon",
  "card",
  "message",
  "correct",
  "data-correct",
  "text-align",
  "background-color",
  "preserve-content",
  "popover",
  "accesskey",
  "datetime",
  "kind",
  "data",
  "codebase",
  "attributename",
  "patchsrc",
  "xml:lang",
  "CLASS",
];
const VALUES = [
  "",
  "x",
  "hello world",
  "_blank",
  "https://example.com/a?b=1&c=2",
  "/files/a b.png",
  "files/b.pdf",
  "#top",
  "mailto:a@b.c",
  "tel:+1",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "java\tscript:alert(1)",
  "&#106;avascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:image/png;base64,iVBORw0KGgo=",
  "data:image/svg+xml,<svg onload=alert(1)>",
  "vbscript:x",
  "ftp://x",
  "//evil.example/x",
  "  padded  ",
  "\ttab\n",
  "a b",
  "café",
  "https://e.x/café?q=1",
  "x]>y",
  "a --> b",
  "a --!> b",
  "</title><img src=x onerror=alert(1)>",
  "</STYLE>",
  '"><img src=x onerror=alert(1)>',
  "&lt;b&gt;",
  "&amp;",
  "icons:check",
  "Note: hi",
  "JavaScript: the good parts",
  "<span>html</span>",
  "url(javascript:alert(1))",
  "https://e.x/$[]^`{|}",
  "allow-scripts allow-top-navigation",
  "eager",
  "unsafe-url",
  "images",
  "cookie",
  "action",
];
const esc = (v) =>
  v.replace(/&(?![a-z#0-9]+;)/gi, "&amp;").replace(/"/g, "&quot;");

const cases = [];
function add(name, html, options) {
  cases.push(options ? { name, html, options } : { name, html });
}
// one feature per case
for (const t of TAGS) add(`tag ${t}`, `<p>a</p><${t}>x</${t}><p>b</p>`);
for (const host of [
  "div",
  "a",
  "img",
  "media-image",
  "iframe",
  "input",
  "form",
]) {
  for (const a of ATTRS)
    add(`attribute ${host}[${a}]`, `<${host} ${a}="v1">x</${host}>`);
}
for (const [host, a] of [
  ["a", "href"],
  ["img", "src"],
  ["div", "title"],
  ["img", "alt"],
  ["div", "data-x"],
  ["media-image", "source"],
  ["div", "id"],
  ["img", "name"],
  ["media-image", "icon"],
  ["iframe", "src"],
  ["input", "name"],
  ["video-player", "media-title"],
]) {
  for (const v of VALUES)
    add(
      `value ${host}[${a}]=${JSON.stringify(v)}`,
      `<${host} ${a}="${esc(v)}">x</${host}>`,
    );
}
add(
  "valueless attributes",
  "<a11y-tab disabled>x</a11y-tab><simple-tag readonly></simple-tag><select multiple><option selected>1</option></select><input checked><x-y card></x-y>",
);
add(
  "explicit empty attributes",
  '<a11y-tab disabled="">x</a11y-tab><table bordered="" condensed=""><tbody><tr><td>x</td></tr></tbody></table>',
);
for (const c of [
  "<!-- plain -->",
  "<!---->",
  "<!-- <img src=x onerror=alert(1)> -->",
  "<!-- a > b -->",
  "<!--[if IE]>x<![endif]-->",
  "<?php echo 1; ?>",
  "<!-- GENERATED FILE - DO NOT EDIT BY HAND -->",
]) {
  add(`comment ${c}`, `<p>a</p>${c}<p>b</p>`);
  add(`comment inside ${c}`, `<div>${c}</div>`);
}
add(
  "import drops comments and iframes",
  '<!-- secret --><p>ok</p><iframe src="https://e.x"></iframe>',
  { forbidTags: ["iframe"], dropComments: true },
);
add(
  "import keeps media",
  '<p>ok <img src="/files/a.png" alt="A"></p><video-player source="https://e.x/v.mp4"></video-player>',
  { forbidTags: ["iframe"], dropComments: true },
);
add(
  "forbidTags removes with content",
  '<div><iframe src="https://e.x">x</iframe><p>keep</p></div>',
  { forbidTags: ["iframe"] },
);
add(
  "markup probe removes element",
  "<p><em>&lt;script&gt;<!-- c --></em> after</p>",
);
add(
  "markup probe keeps element with child",
  "<p><em><b>x</b>&lt;script&gt;<!-- c --></em></p>",
);
add("markup probe text only stays", "<p>&lt;script&gt; is text</p>");
add(
  "pre leading newline",
  "<pre>\n\nx</pre><textarea>\n\ny</textarea><listing>\n\nz</listing><pre>\ny</pre>",
);
add(
  "is attribute",
  '<div is="x-y" title="t">a</div><template is="x"><b>t</b></template>',
);
add(
  "clobbering in a form",
  '<form id="search"><input name="action"><input name="q"><button id="submit">go</button><img name="cookie" src="a.png"><img name="pic" src="b.png"></form><div id="images">anchor</div><h2 id="title">t</h2>',
);
add(
  "code-sample template",
  '<code-sample><template preserve-content><div class="x"><b>code</b></div></template></code-sample>',
);
add(
  "template content sanitized",
  '<template><img src="x" onerror="alert(1)"><script>alert(1)</script><b>ok</b></template>',
);
add(
  "iframe normalized",
  '<iframe src="https://www.youtube.com/embed/x" sandbox="allow-scripts allow-top-navigation" loading="EAGER" referrerpolicy="bogus" onload="x" allowfullscreen>fallback</iframe>',
);
add(
  "table rows get tbody",
  "<table>\n  <tr><td>1</td></tr>\n  <tr><td>2</td></tr>\n</table><table><thead><tr><th>h</th></tr></thead><tr><td>1</td></tr></table>",
);
add(
  "html5 void elements",
  '<video controls><source src="/v.mp4" type="video/mp4"><track src="/t.vtt" kind="captions">fallback</video><p>a<wbr>b</p>',
);
add("image becomes img", '<p><image src="/a.png" alt="a">after</p>');
// what an HTML5 parser does with markup authors and imports really produce
add("less than sign in text", "<p>1 < 2 and 3 <= 4</p><p>x &amp;< y</p>");
add("less than sign at the end", "a <");
add(
  "raw text end tag with space or case",
  "<p>a</p><script>x</SCRIPT ><p>b</p><style>y</style\n><p>c</p>",
);
add(
  "raw text end tag needs the whole name",
  '<script>z</scriptx><p>hidden</p></script foo="1"><p>f</p>',
);
add(
  "textarea end tag",
  "<textarea>t</textareas> 1 < 2</TEXTAREA ><p>d</p><textarea>unclosed <b>",
);
add("end tag with a slash", "<title>q</title/><div>x</div/><p>y</p>");
add(
  "stray end paragraph",
  "<div></p>x</div><p>a<p>b</p></p>c<a11y-collapse><p ><p></p><p >text</p></p></a11y-collapse>",
);
add(
  "svg and math removed",
  '<svg><a href="javascript:alert(1)">x</a></svg><math><mi>x</mi></math><p>ok</p>',
);
add(
  "unknown tags unwrapped",
  '<object data="x.swf"><param name="a" value="b">fallback <b>text</b></object><portal src="https://e.x">p</portal><blink>still</blink>',
);
add(
  "raw text elements removed",
  "<noscript><b>n</b></noscript><xmp><b>x</b></xmp><noembed>e</noembed><noframes>f</noframes><title>t</title><p>after</p>",
);
add(
  "urls are not rewritten",
  '<a href="files/HAX.psu World changer.png">x</a><img src="https://e.x/café?q=[1]&amp;b={2}" alt="a"><media-image source="/files/a b.png"></media-image>',
);
add(
  "whitespace in values is kept",
  '<p data-selected="Hey, ! is NOT for " title="  two  ">x</p><stop-note message="<b>x</b>\n"></stop-note>',
);
add(
  "hax design attributes on standard elements",
  '<h2 background-color="light-blue" text-align="left" padding-top="8">T</h2><p font-size="x-large" text-align="center">p</p><ul margin-top="0"><li>x</li></ul><table bordered condensed sort><tr><td>x</td></tr></table>',
);
add(
  "links keep target",
  '<a href="https://haxtheweb.org/" target="_blank" rel="noopener">HAX</a><a target="_self" href="#x">x</a>',
);
add(
  "entities and nbsp",
  '<p>a &amp; b &lt; c &gt; d &nbsp; e &quot; f &#39; g &copy; h</p><p title="a &amp; b &quot;q&quot; &lt;x&gt; &nbsp;">t</p>',
);
add("empty input", "");
add("text only", "just text & more");

// seeded generated markup (malformed on purpose)
let seed = 3273;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(rnd() * list.length)];
const TEXT = [
  "text",
  " ",
  "a & b",
  "1 < 2",
  "&nbsp;",
  "é",
  "<!-- c -->",
  "&lt;script&gt;",
  "\n",
];
function gen(depth) {
  if (depth > 3 || rnd() < 0.3) {
    return pick(TEXT);
  }
  const t = pick(TAGS);
  let attrs = "";
  for (let k = 0; k < Math.floor(rnd() * 3); k++) {
    attrs += ` ${pick(ATTRS)}="${esc(pick(VALUES))}"`;
  }
  let inner = "";
  for (let k = 0; k < Math.floor(rnd() * 3); k++) {
    inner += gen(depth + 1);
  }
  return `<${t}${attrs}>${inner}${rnd() < 0.85 ? `</${t}>` : ""}`;
}
for (let i = 0; i < 400; i++) {
  add(`generated ${i}`, gen(0) + gen(0) + gen(0));
}

// expectations from Node
const out = [];
for (const c of cases) {
  c.expect = sanitizeHTMLForStorage(c.html, c.options || {});
  // text an HTML5 parser has to move out of a table: parse5 (jsdom) puts it
  // after the table, the spec, browsers and PHP 8.4 before it
  if (/<\/table>\s*[^<\s]/.test(c.expect)) {
    c.fosterText = true;
  }
  out.push(c);
}
const pageCases = [];
for (const name of Object.keys(pages)) {
  const html = sanitizeHTMLForStorage(pages[name]);
  pageCases.push({
    name: `page ${name}`,
    page: name,
    expect: {
      sha256: crypto.createHash("sha256").update(html, "utf8").digest("hex"),
    },
  });
}
// after the pages, so the cases above keep their place in the file
const tail = [
  [
    "youtube https",
    '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
  ],
  [
    "vimeo uppercase scheme",
    '<iframe src="HTTP://player.vimeo.com/video/1"></iframe>',
  ],
  ["protocol-relative", '<iframe src="//example.org/embed"></iframe>'],
  ["leading space https", '<iframe src=" https://ok.example/x"></iframe>'],
  ["root-relative", '<iframe src="/files/x.html"></iframe>'],
  ["relative", '<iframe src="files/x.html"></iframe>'],
  ["about blank", '<iframe src="about:blank"></iframe>'],
  ["data url", '<iframe src="data:text/html,hi"></iframe>'],
  ["javascript url", '<iframe src="javascript:alert(1)"></iframe>'],
  ["blob url", '<iframe src="blob:https://a.example/b"></iframe>'],
  [
    "explicit author sandbox kept",
    '<iframe src="https://a.example/x" sandbox="allow-scripts"></iframe>',
  ],
].map(([name, html]) => ({
  name: `iframe default sandbox: ${name}`,
  html,
  expect: sanitizeHTMLForStorage(html),
}));
const all = out.concat(pageCases, tail);

if (phpDir) {
  // run haxcms-php on every case to mark where PHP 8.3 differs
  const tmp = path.join(
    require("os").tmpdir(),
    `sanitize-vectors-${process.pid}.json`,
  );
  fs.writeFileSync(tmp, JSON.stringify({ pages, cases: all }));
  const script = `
    include ${JSON.stringify(path.join(path.resolve(phpDir), "system/backend/php/lib/SanitizeContent.php"))};
    $v = json_decode(file_get_contents($argv[1]), true);
    $r = array();
    foreach ($v['cases'] as $c) {
      $html = isset($c['page']) ? $v['pages'][$c['page']] : $c['html'];
      $o = SanitizeContent::sanitizeHTMLForStorage($html, isset($c['options']) ? $c['options'] : array());
      $r[] = isset($c['page']) ? hash('sha256', $o) : $o;
    }
    echo json_encode($r, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);`;
  const phpOut = JSON.parse(
    execFileSync("php", ["-r", script, tmp], { maxBuffer: 1 << 28 }).toString(),
  );
  fs.unlinkSync(tmp);
  let differs = 0;
  all.forEach((c, i) => {
    const want = typeof c.expect === "string" ? c.expect : c.expect.sha256;
    if (phpOut[i] !== want) {
      c.php83Differs = true;
      differs++;
    }
  });
  console.log(`PHP 8.3 differs on ${differs} of ${all.length} cases`);
}

fs.writeFileSync(
  VECTORS_FILE,
  JSON.stringify(
    {
      $comment:
        "Storage sanitizer vectors shared by haxcms-nodejs and haxcms-php (haxtheweb/issues#3273). expect is the exact stored HTML (or its sha256 for whole pages). php83Differs marks malformed markup PHP 8.3 (masterminds/html5, shipped with haxcms-php) builds differently; PHP 8.4 (Dom\\HTMLDocument) must match every case. Generated by haxcms-nodejs scripts/generate-sanitize-vectors.cjs.",
      version: 1,
      pages,
      cases: all,
    },
    null,
    1,
  ) + "\n",
);
console.log(`${all.length} cases (${pageCases.length} pages)`);
