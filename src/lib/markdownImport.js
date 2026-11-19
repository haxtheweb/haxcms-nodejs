const MarkdownIt = require("markdown-it");
const markdownItFootnote = require("markdown-it-footnote");

/**
 * Markdown (.md / .markdown) and plain text (.txt) to HTML for the import
 * routes.
 *
 * Plain text is read as Markdown: prose comes out as paragraphs, and a .txt
 * that uses `#` headings, lists or links (as many notes do) keeps that
 * structure, so it can become a multi-page site. This matches what the site
 * editor has always done with a .txt dropped on a page (md-to-html).
 *
 * Parity: haxcms-php renders with Michelf MarkdownExtra set up like this
 * markdown-it (raw HTML on, footnotes on, `language-` code classes), the same
 * pairing the Quarto and VitePress importers use.
 */

const renderer = new MarkdownIt({ html: true, linkify: false });
renderer.use(markdownItFootnote);

/**
 * Bytes to text: UTF-8 (BOM dropped), or Windows-1252 when the bytes are not
 * valid UTF-8 (older Windows .txt files).
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeTextBuffer(buffer) {
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder("windows-1252").decode(buffer);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Take a leading YAML front matter block off; its `title:` (if any) is
 * returned so a single-page import can use it.
 * @param {string} markdown
 * @returns {{ title: string, body: string }}
 */
function splitFrontMatter(markdown) {
  const match = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(
    markdown,
  );
  if (!match) {
    return { title: "", body: markdown };
  }
  let title = "";
  const titleLine = /^title:[ \t]*(.+?)[ \t]*$/m.exec(match[1]);
  if (titleLine) {
    title = titleLine[1].replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return { title: title, body: markdown.slice(match[0].length) };
}

/**
 * @param {string} markdown
 * @returns {string} HTML
 */
function renderMarkdown(markdown) {
  return renderer.render(markdown);
}

module.exports = { decodeTextBuffer, splitFrontMatter, renderMarkdown };
