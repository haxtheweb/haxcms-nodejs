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
 * Trim spaces and tabs (only) from both ends, without a regex.
 * @param {string} value
 * @returns {string}
 */
function trimSpacesAndTabs(value) {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === " " || value[start] === "\t")) {
    start++;
  }
  while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) {
    end--;
  }
  return value.slice(start, end);
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
  // Security (SEC-DOS): linear-time. The rest of the line is taken whole and
  // spaces/tabs are trimmed in code; a lazy span followed by [ \t]*$ is
  // quadratic on a long run of spaces and would block the event loop.
  // A bare "title:" with nothing after it is skipped, as before.
  const titleLines = /^title:(.*)$/gm;
  let titleLine;
  while ((titleLine = titleLines.exec(match[1])) !== null) {
    if (titleLine[1] !== "") {
      title = trimSpacesAndTabs(titleLine[1])
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim();
      break;
    }
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
