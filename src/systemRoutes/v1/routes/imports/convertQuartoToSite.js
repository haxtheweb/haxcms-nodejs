const MarkdownIt = require("markdown-it");
const markdownItFootnote = require("markdown-it-footnote");
const { loadYamlSafely } = require("../../../../lib/safeYaml.js");
const { parse } = require("node-html-parser");
const JSONOutlineSchemaItem = require("../../../../lib/JSONOutlineSchemaItem.js");
const { HAXCMS } = require("../../../../lib/HAXCMS.js");
const { escapeHTMLAttribute } = require("../../../../lib/sanitizeContent.js");
// reached through the module object so the network boundary can be stubbed in tests
const safeFetchLib = require("../../../../lib/safeFetch.js");
// Security (L1): client-safe exception text (no paths / stack internals)
const {
  clientSafeErrorDetail,
} = require("../../../../lib/clientErrorMessage.js");

const GITHUB_API = "https://api.github.com";
const RAW_ORIGIN = "https://raw.githubusercontent.com";
// The GitHub API 403s every call that arrives without a User-Agent, so the
// repository and tree reads carry one (same string as convertGitbookToSite,
// convertVitepressToSite and haxcms-php).
const GITHUB_API_HEADERS = {
  "User-Agent": "HAXcms-Import/1.0",
  Accept: "application/vnd.github.v3+json",
};
const RAW_HEADERS = { "User-Agent": "HAXcms-Import/1.0" };
// Safety valves: a Quarto book runs to hundreds of pages. Page bodies are
// fetched one at a time; assets travel to createSite as URLs, which downloads
// them behind its own SSRF guard (haxtheweb/issues#3060), so only their count
// is capped here. Exported so tests can exercise the limits.
const LIMITS = {
  maxPages: 500,
  maxFiles: 2000,
  maxIncludes: 200,
  fetchBudgetSeconds: 900,
  requestDelayMs: 100,
};
const MAX_INCLUDE_DEPTH = 3;
// Quarto keeps its project file at the root of the project it renders
const CONFIG_PATH_REGEX = /(^|\/)_quarto\.ya?ml$/;
// document types Quarto renders that this importer reads as pages
const PAGE_EXTENSION_REGEX = /\.(qmd|rmd|md|ipynb)$/i;
const PAGE_EXTENSIONS = [".qmd", ".Rmd", ".rmd", ".md", ".ipynb"];
const NOTEBOOK_REGEX = /\.ipynb$/i;
// license codes site.license and license-element both understand
const SUPPORTED_LICENSES = [
  "by",
  "by-sa",
  "by-nd",
  "by-nc",
  "by-nc-sa",
  "by-nc-nd",
];
// createSite only accepts these extensions in build.files, so anything else
// (an .svg diagram, a .zip download) keeps its source URL instead
const IMPORTABLE_ASSET_REGEX =
  /\.(jpg|jpeg|png|gif|webm|webp|mp4|mp3|mov|csv|ppt|pptx|xlsx|doc|xls|docx|pdf|rtf|txt|vtt|xml)$/i;
const IMAGE_EXTENSION_REGEX = /\.(jpg|jpeg|png|gif|webp)$/i;
// Quarto's five callout types onto the stop-note statuses HAX offers
const CALLOUTS = {
  note: { status: "info", title: "Note" },
  tip: { status: "success", title: "Tip" },
  important: { status: "stop", title: "Important" },
  warning: { status: "warning", title: "Warning" },
  caution: { status: "warning", title: "Caution" },
};
// directories Quarto itself skips when it looks for something to render
const IGNORED_DIRECTORY_REGEX = /^(node_modules|renv|venv|site-packages)$/;
const GENERATED_DIRECTORY_REGEX = /_(files|cache)$/;
// the output format this import stands in for, used by content-visible and
// content-hidden divs
const TARGET_FORMAT = "html";

/**
 * POST /system/api/v1/site/import/quarto
 * Convert a Quarto project (book or website) into a HAXcms site schema.
 *
 * Expects JSON body with a `repoUrl` param: a GitHub repository URL, with an
 * optional /tree/<branch>.
 *
 * Quarto declares its outline in _quarto.yml: book.chapters (with parts) and
 * book.appendices for a book, website.sidebar or website.navbar for a site.
 * The YAML is read as data and the project is never rendered or executed:
 * repoUrl is caller-supplied, so running the repository's own code or the
 * Quarto CLI would be arbitrary code execution. A project with no readable
 * outline falls back to the pages on disk, which is what Quarto does when no
 * chapters are listed. Code chunks are imported as code; their outputs are not
 * computed, and the result says so.
 *
 * Returns { status: 200, data: { items, filename, files, site, truncated,
 * unmappedComponents } }.
 */
async function convertQuartoToSite(req, res) {
  const body = readRequestBody(req);
  const repoUrl =
    body && typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";
  if (repoUrl === "") {
    return sendError(res, 400, "missing `repoUrl` param");
  }
  let repo = null;
  try {
    repo = parseRepoUrl(repoUrl);
  } catch (e) {
    return sendError(res, 400, e.message);
  }
  try {
    const source = await resolveRepository(repo);
    const imported = await importSite(source);
    return res.json({
      status: 200,
      data: {
        items: imported.items,
        filename: source.title,
        files: imported.files,
        site: { license: source.license },
        truncated: imported.truncated,
        unmappedComponents: imported.unmappedComponents,
      },
    });
  } catch (error) {
    const status = error && error.status ? error.status : 400;
    return sendError(
      res,
      status,
      clientSafeErrorDetail(error, "Unable to import the Quarto project"),
    );
  }
}

function readRequestBody(req) {
  if (!req || !req.body) {
    return {};
  }
  if (typeof req.body === "object") {
    return req.body;
  }
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body.trim());
    } catch {
      return {};
    }
  }
  return {};
}

function sendError(res, status, message) {
  return res.status(status).json({
    status: status,
    data: { error: message, items: [], filename: null, files: {} },
  });
}

function importError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** owner, repo and optional branch out of a GitHub repository URL. */
function parseRepoUrl(sourceUrl) {
  let parsed = null;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw importError(400, `Invalid repoUrl: ${sourceUrl}`);
  }
  if (parsed.hostname.toLowerCase() !== "github.com") {
    throw importError(400, "repoUrl must be a github.com repository URL");
  }
  const segments = parsed.pathname.split("/").filter((piece) => piece !== "");
  if (segments.length < 2) {
    throw importError(
      400,
      `repoUrl is missing the owner/repo path: ${sourceUrl}`,
    );
  }
  const owner = segments[0];
  const name = segments[1].replace(/\.git$/i, "");
  // /tree/<branch> names a branch; deeper path segments are ignored because
  // the config discovery walks the whole tree anyway
  let branch = null;
  if (segments[2] === "tree" && segments[3]) {
    branch = segments[3];
  }
  return { owner: owner, name: name, branch: branch };
}

async function fetchJson(url, description) {
  let response = null;
  try {
    response = await safeFetchLib.safeFetch(url, {
      headers: GITHUB_API_HEADERS,
    });
  } catch (e) {
    throw importError(
      400,
      `Unable to reach ${description}: ${clientSafeErrorDetail(e)}`,
    );
  }
  if (!response.ok) {
    throw importError(
      response.status === 404 ? 422 : 400,
      `Unable to read ${description} (HTTP ${response.status})`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw importError(400, `Unable to parse ${description}`);
  }
}

/** Fetch text, or null when it cannot be read; page bodies are optional. */
async function fetchText(url) {
  try {
    const response = await safeFetchLib.safeFetch(url, {
      headers: RAW_HEADERS,
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectOf(value) {
  return isObject(value) ? value : {};
}

/** A non-empty trimmed string, or "" for anything else. */
function stringOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve the repository: default branch, file tree, _quarto.yml and the
 * site level metadata the project file carries.
 */
async function resolveRepository(repo) {
  const repoData = await fetchJson(
    `${GITHUB_API}/repos/${repo.owner}/${repo.name}`,
    `the repository ${repo.owner}/${repo.name}`,
  );
  const branch = repo.branch || repoData.default_branch || "main";
  const treeData = await fetchJson(
    `${GITHUB_API}/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    `the file tree of ${repo.owner}/${repo.name}`,
  );
  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];
  const paths = {};
  for (let i = 0; i < tree.length; i++) {
    if (
      tree[i] &&
      tree[i].type === "blob" &&
      typeof tree[i].path === "string"
    ) {
      paths[tree[i].path] = true;
    }
  }
  const configPath = findConfigPath(paths);
  if (configPath === null) {
    throw importError(
      422,
      `No _quarto.yml file found in ${repo.owner}/${repo.name}`,
    );
  }
  const root =
    configPath.indexOf("/") === -1
      ? ""
      : configPath.slice(0, configPath.lastIndexOf("/"));
  const rawBase = `${RAW_ORIGIN}/${repo.owner}/${repo.name}/${branch}`;
  const configSource = await fetchText(`${rawBase}/${encodeURI(configPath)}`);
  if (configSource === null) {
    throw importError(422, `Unable to read ${configPath}`);
  }
  const config = readConfig(configSource);
  return {
    owner: repo.owner,
    name: repo.name,
    branch: branch,
    paths: paths,
    root: root,
    rawBase: rawBase,
    config: config,
    title: config.title || repo.name,
    license: config.license,
    accessed: new Date().toISOString(),
  };
}

/**
 * The project file that describes the site: the shallowest _quarto.yml. A
 * repository can carry more than one (an example project, a fixture), and the
 * one at the top is the project Quarto renders.
 */
function findConfigPath(paths) {
  const candidates = Object.keys(paths).filter((candidate) =>
    CONFIG_PATH_REGEX.test(candidate),
  );
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    if (depth !== 0) {
      return depth;
    }
    return a.localeCompare(b);
  });
  return candidates[0];
}

/**
 * Read the parts of _quarto.yml that describe the site. The YAML is parsed
 * with the size cap and without aliases; a file that cannot be parsed is the
 * same as an empty one, and the page tree is used instead.
 */
function readConfig(text) {
  let data = {};
  try {
    const parsed = loadYamlSafely(text);
    if (isObject(parsed)) {
      data = parsed;
    }
  } catch {
    data = {};
  }
  const project = objectOf(data.project);
  const book = objectOf(data.book);
  const website = objectOf(data.website);
  const render = Array.isArray(project.render)
    ? project.render.filter((entry) => typeof entry === "string")
    : null;
  return {
    type: stringOf(project.type).toLowerCase(),
    title: stringOf(book.title) || stringOf(website.title),
    author: authorText(book.author) || authorText(data.author),
    siteUrl: stringOf(book["site-url"]) || stringOf(website["site-url"]),
    license: normalizeLicense(data.license),
    outputDir: stringOf(project["output-dir"]).replace(/^\.?\/|\/$/g, ""),
    render: render,
    chapters: Array.isArray(book.chapters) ? book.chapters : null,
    appendices: Array.isArray(book.appendices) ? book.appendices : null,
    sidebar: sidebarContents(website.sidebar),
    navbar: isObject(website.navbar) ? website.navbar : null,
  };
}

/** Quarto allows a string, a list of strings, or maps with a name. */
function authorText(value) {
  const names = [];
  const collect = (entry) => {
    if (typeof entry === "string") {
      names.push(entry.trim());
    } else if (isObject(entry)) {
      const name = entry.name;
      if (typeof name === "string") {
        names.push(name.trim());
      } else if (isObject(name) && typeof name.literal === "string") {
        names.push(name.literal.trim());
      } else if (isObject(name) && (name.given || name.family)) {
        names.push(`${stringOf(name.given)} ${stringOf(name.family)}`.trim());
      }
    }
  };
  if (Array.isArray(value)) {
    value.forEach(collect);
  } else {
    collect(value);
  }
  return names.filter((name) => name !== "").join(", ");
}

/** website.sidebar is one map or a list of them; the first with contents wins. */
function sidebarContents(sidebar) {
  const candidates = Array.isArray(sidebar) ? sidebar : [sidebar];
  for (let i = 0; i < candidates.length; i++) {
    if (isObject(candidates[i]) && Array.isArray(candidates[i].contents)) {
      return candidates[i].contents;
    }
  }
  return null;
}

/** CC BY-SA 4.0, cc-by-sa and by-sa all mean the same license code. */
function normalizeLicense(value) {
  if (typeof value !== "string") {
    return null;
  }
  const code = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/^cc-/, "")
    .replace(/-\d+(\.\d+)*$/, "");
  return SUPPORTED_LICENSES.indexOf(code) === -1 ? null : code;
}

/** Slug for one page title, trimmed the way convertOpenstaxToSite trims. */
function titleSlug(title) {
  const cleaned = HAXCMS.cleanTitle(title);
  const trimmed = cleaned.replace(/^-+|-+$/g, "");
  return trimmed === "" ? cleaned : trimmed;
}

function titleFromPath(path) {
  const name = path.split("/").pop().replace(PAGE_EXTENSION_REGEX, "");
  const words = name.replace(/[-_]+/g, " ").trim();
  return words === "" || words.toLowerCase() === "index"
    ? "Home"
    : words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizePath(path) {
  const parts = [];
  path.split("/").forEach((piece) => {
    if (piece === "" || piece === ".") {
      return;
    }
    if (piece === "..") {
      parts.pop();
      return;
    }
    parts.push(piece);
  });
  return parts.join("/");
}

function rootPrefix(source) {
  return source.root === "" ? "" : `${source.root}/`;
}

/** A glob over project-relative paths: * stays in a folder, ** crosses them. */
function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern.charAt(i);
    if (character === "*" && pattern.charAt(i + 1) === "*") {
      source += ".*";
      i++;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether Quarto would skip a project-relative path when looking for pages:
 * anything under a folder or file starting with . or _, README and agent
 * instruction files, dependency and cache folders, and the output directory.
 */
function isIgnoredPath(relative, source) {
  const segments = relative.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.charAt(0) === "." || segment.charAt(0) === "_") {
      return true;
    }
    if (
      i < segments.length - 1 &&
      (IGNORED_DIRECTORY_REGEX.test(segment) ||
        GENERATED_DIRECTORY_REGEX.test(segment))
    ) {
      return true;
    }
  }
  const name = segments[segments.length - 1];
  if (
    /^readme\.(md|qmd|rmd|ipynb)$/i.test(name) ||
    /^(agents|claude)\.md$/i.test(name)
  ) {
    return true;
  }
  const outputDir = source.config.outputDir;
  return (
    outputDir !== "" &&
    (relative === outputDir || relative.indexOf(`${outputDir}/`) === 0)
  );
}

/** project.render narrows the pages; a ! entry removes matches. */
function isRenderable(relative, source) {
  const render = source.config.render;
  if (!render || render.length === 0) {
    return true;
  }
  let included = !render.some((entry) => entry.charAt(0) !== "!");
  render.forEach((entry) => {
    const negated = entry.charAt(0) === "!";
    const pattern = negated ? entry.slice(1) : entry;
    if (globToRegExp(pattern.replace(/^\.?\//, "")).test(relative)) {
      included = !negated;
    }
  });
  return included;
}

/** Every page Quarto would render under the project root, in tree order. */
function listPages(source) {
  const prefix = rootPrefix(source);
  return Object.keys(source.paths)
    .filter((candidate) => candidate.indexOf(prefix) === 0)
    .map((candidate) => candidate.slice(prefix.length))
    .filter(
      (relative) =>
        PAGE_EXTENSION_REGEX.test(relative) &&
        !isIgnoredPath(relative, source) &&
        isRenderable(relative, source),
    )
    .sort((a, b) => {
      const indexA = /(^|\/)index\.[a-z]+$/i.test(a) ? 0 : 1;
      const indexB = /(^|\/)index\.[a-z]+$/i.test(b) ? 0 : 1;
      if (a.split("/").length !== b.split("/").length) {
        return a.split("/").length - b.split("/").length;
      }
      if (indexA !== indexB) {
        return indexA - indexB;
      }
      return a.localeCompare(b);
    });
}

/**
 * Repository path of a project-relative page reference, or null when the
 * repository does not carry it. References may be written root-relative.
 */
function resolvePagePath(reference, source) {
  const clean = String(reference).split("#")[0].split("?")[0].trim();
  if (clean === "" || !PAGE_EXTENSION_REGEX.test(clean)) {
    return null;
  }
  const repoPath = normalizePath(`${rootPrefix(source)}${clean}`);
  return source.paths[repoPath] ? repoPath : null;
}

function isExternal(reference) {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(reference);
}

/**
 * One outline entry, whichever of the shapes Quarto writes it in:
 *   - a string path                      (chapters, contents)
 *   - { href, text }                      (chapters, contents, navbar)
 *   - { part: file | title, chapters }    (book parts)
 *   - { section: title, href?, contents } (sidebar sections)
 *   - { text, menu }                      (navbar menus)
 *   - { auto: glob | [globs] | true }     (generated sidebar entries)
 * target is the page reference, label an explicit title, children nested
 * entries and auto the generated-entry request.
 */
function describeEntry(entry) {
  if (typeof entry === "string") {
    return { target: entry.trim(), label: "", children: null, auto: null };
  }
  if (!isObject(entry)) {
    return null;
  }
  let target = stringOf(entry.href) || stringOf(entry.file);
  let label = stringOf(entry.text);
  let children = null;
  if (typeof entry.part === "string") {
    // a part is either a page that introduces its chapters or just a title
    if (PAGE_EXTENSION_REGEX.test(entry.part.trim())) {
      target = target || entry.part.trim();
    } else {
      label = label || entry.part.trim();
    }
    children = Array.isArray(entry.chapters) ? entry.chapters : [];
  } else if (typeof entry.section === "string") {
    label = entry.section.trim() || label;
    children = Array.isArray(entry.contents) ? entry.contents : [];
  } else if (Array.isArray(entry.menu)) {
    children = entry.menu;
  } else if (Array.isArray(entry.contents)) {
    children = entry.contents;
  }
  let auto = null;
  if (entry.auto === true) {
    auto = [];
  } else if (typeof entry.auto === "string") {
    auto = [entry.auto];
  } else if (Array.isArray(entry.auto)) {
    auto = entry.auto.filter((glob) => typeof glob === "string");
  }
  return { target: target, label: label, children: children, auto: auto };
}

/**
 * Walk entries into flat, ordered nodes that point at their parent by index.
 * A group carrying a page and children becomes a page with children; a group
 * with only children becomes a landing page, the way convertOpenstaxToSite
 * treats chapter headings. A page already placed is not placed twice.
 * Returns the next order at this depth.
 */
function walkEntries(entries, depth, parentIndex, builder, startOrder) {
  let order = startOrder || 0;
  for (let i = 0; i < entries.length; i++) {
    const info = describeEntry(entries[i]);
    if (!info) {
      continue;
    }
    // separators and external links are navigation, not pages
    if (/^-{3,}$/.test(info.target) || /^-{3,}$/.test(info.label)) {
      continue;
    }
    if (info.auto !== null) {
      order = addGlobNodes(info.auto, depth, parentIndex, builder, order);
      continue;
    }
    if (info.target.indexOf("*") !== -1) {
      order = addGlobNodes([info.target], depth, parentIndex, builder, order);
      continue;
    }
    const external = info.target !== "" && isExternal(info.target);
    if (external && info.children === null) {
      continue;
    }
    let path = external ? null : resolvePagePath(info.target, builder.source);
    if (path !== null && builder.used[path]) {
      path = null;
    }
    if (path === null && info.label === "" && info.children === null) {
      // a reference to a page the repository does not carry, and nothing to
      // show for it
      continue;
    }
    const node = addNode(builder, path, info.label, depth, parentIndex, order);
    order++;
    if (info.children !== null) {
      walkEntries(info.children, depth + 1, node, builder, 0);
    }
  }
  return order;
}

function addNode(builder, path, label, depth, parentIndex, order) {
  const relative =
    path === null ? null : path.slice(rootPrefix(builder.source).length);
  builder.nodes.push({
    title: label || (relative ? titleFromPath(relative) : "Untitled"),
    explicit: label !== "",
    path: path,
    relative: relative,
    depth: depth,
    order: order,
    parentIndex: parentIndex,
  });
  if (path !== null) {
    builder.used[path] = true;
  }
  return builder.nodes.length - 1;
}

/** Glob entries ("chapters/*.qmd", auto: ...) into the pages they match. */
function addGlobNodes(globs, depth, parentIndex, builder, startOrder) {
  let order = startOrder;
  const pages = listPages(builder.source);
  const patterns = globs.length === 0 ? null : globs;
  const matched = pages.filter((relative) => {
    if (patterns === null) {
      return true;
    }
    return patterns.some((glob) =>
      globToRegExp(glob.replace(/^\.?\//, "")).test(relative),
    );
  });
  matched.forEach((relative) => {
    const path = `${rootPrefix(builder.source)}${relative}`;
    if (builder.used[path]) {
      return;
    }
    addNode(builder, path, "", depth, parentIndex, order);
    order++;
  });
  return order;
}

function createBuilder(source) {
  return { source: source, nodes: [], used: {} };
}

/** book.chapters (parts included) followed by book.appendices. */
function outlineFromBook(source) {
  const builder = createBuilder(source);
  let order = 0;
  if (source.config.chapters) {
    order = walkEntries(source.config.chapters, 0, null, builder, order);
  }
  if (source.config.appendices) {
    walkEntries(source.config.appendices, 0, null, builder, order);
  }
  return builder.nodes;
}

function outlineFromSidebar(source) {
  const builder = createBuilder(source);
  walkEntries(source.config.sidebar, 0, null, builder, 0);
  return builder.nodes;
}

/** navbar.left then navbar.right; a menu becomes a page with children. */
function outlineFromNavbar(source) {
  const builder = createBuilder(source);
  const navbar = source.config.navbar;
  let order = 0;
  ["left", "right"].forEach((side) => {
    if (Array.isArray(navbar[side])) {
      order = walkEntries(navbar[side], 0, null, builder, order);
    }
  });
  return builder.nodes;
}

/**
 * Every page in the project, in tree order, when no outline can be read.
 * Mirrors Quarto's own behavior of rendering whatever is on disk, index first.
 */
function outlineFromTree(source) {
  const builder = createBuilder(source);
  addGlobNodes([], 0, null, builder, 0);
  return builder.nodes;
}

function buildOutline(source) {
  const config = source.config;
  let nodes = [];
  if (config.chapters || config.appendices) {
    nodes = outlineFromBook(source);
  } else if (config.sidebar) {
    nodes = outlineFromSidebar(source);
  } else if (config.navbar) {
    nodes = outlineFromNavbar(source);
  }
  if (nodes.length === 0) {
    nodes = outlineFromTree(source);
  }
  return nodes;
}

function budgetExhausted(context) {
  return (Date.now() - context.startedAt) / 1000 > LIMITS.fetchBudgetSeconds;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Build the items, page bodies and file map for one repository. */
async function importSite(source) {
  const outline = buildOutline(source);
  if (outline.length === 0) {
    throw importError(422, "The Quarto project has no pages to import");
  }
  const context = {
    source: source,
    files: {},
    fileNames: {},
    filesByPath: {},
    slugByPath: {},
    slugs: {},
    unmapped: {},
    includes: 0,
    startedAt: Date.now(),
    truncated: false,
  };
  const items = [];
  // first pass: items and slugs, so page bodies can link to siblings by slug
  for (let i = 0; i < outline.length; i++) {
    const node = outline[i];
    const item = new JSONOutlineSchemaItem();
    item.title = node.title;
    item.indent = node.depth;
    item.order = node.order;
    const parentItem =
      node.parentIndex === null ? null : items[node.parentIndex];
    item.parent = parentItem ? parentItem.id : null;
    item.slug = uniqueSlug(
      parentItem
        ? `${parentItem.slug}/${titleSlug(node.title)}`
        : titleSlug(node.title),
      context,
    );
    item.metadata = {
      sourceType: "quarto",
      quarto: {
        repo: `${source.owner}/${source.name}`,
        branch: source.branch,
        path: node.path,
        license: source.license,
        author: source.config.author,
        workTitle: source.config.title,
        accessed: source.accessed,
      },
    };
    const sourceUrl = pageSourceUrl(node, source);
    if (sourceUrl) {
      item.metadata.source = sourceUrl;
    }
    items.push(item);
    node.item = item;
    if (node.path) {
      context.slugByPath[node.path] = item.slug;
    }
  }
  // second pass: page bodies, bounded by the page cap and the time budget
  let fetched = 0;
  for (let i = 0; i < outline.length; i++) {
    const node = outline[i];
    if (!node.path) {
      // a group with no page of its own: a landing page for its children
      node.item.contents = "<p></p>";
      continue;
    }
    if (fetched >= LIMITS.maxPages || budgetExhausted(context)) {
      context.truncated = true;
      node.item.contents = sourceFallback(node.item.metadata.source);
      continue;
    }
    if (fetched > 0) {
      await delay(LIMITS.requestDelayMs);
    }
    const markdown = await fetchText(
      `${source.rawBase}/${encodeURI(node.path)}`,
    );
    fetched++;
    if (markdown === null) {
      node.item.contents = sourceFallback(node.item.metadata.source);
      continue;
    }
    node.item.contents = await renderPage(markdown, node, context);
  }
  return {
    items: items,
    files: context.files,
    truncated: context.truncated,
    unmappedComponents: Object.keys(context.unmapped).sort(),
  };
}

/** Two pages with the same title under one parent must not share a slug. */
function uniqueSlug(slug, context) {
  let candidate = slug;
  let counter = 1;
  while (context.slugs[candidate]) {
    counter++;
    candidate = `${slug}-${counter}`;
  }
  context.slugs[candidate] = true;
  return candidate;
}

/** Where the page lives on the published Quarto site, when it says. */
function pageSourceUrl(node, source) {
  if (!node.relative || !source.config.siteUrl) {
    return null;
  }
  return `${source.config.siteUrl.replace(/\/$/, "")}/${node.relative.replace(PAGE_EXTENSION_REGEX, ".html")}`;
}

function sourceFallback(source) {
  if (!source) {
    return "<p></p>";
  }
  const href = escapeHTMLAttribute(source);
  return `<p>Read this page on <a href="${href}">the source site</a>.</p>`;
}

/** Split YAML front matter from the markdown body. */
function splitFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) {
    return { data: {}, body: markdown };
  }
  let data = {};
  try {
    // Security (SEC-SSRF): size cap + anchor/alias rejection (alias
    // amplification); a rejected front matter falls back to {} like any
    // other unparseable front matter.
    const parsed = loadYamlSafely(match[1]);
    if (parsed && typeof parsed === "object") {
      data = parsed;
    }
  } catch {
    data = {};
  }
  return { data: data, body: markdown.slice(match[0].length) };
}

/** A markdown-it that renders Quarto's pandoc footnotes. */
function createRenderer() {
  const renderer = new MarkdownIt({ html: true, linkify: false });
  renderer.use(markdownItFootnote);
  return renderer;
}

/** name="value", name=value, #id, .class pairs out of an attribute block. */
function parseAttributes(source) {
  const result = { id: "", classes: [], values: {} };
  const pattern =
    /(?:#([^\s.#}"']+))|(?:\.([^\s.#}"']+))|([A-Za-z][A-Za-z0-9_:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+)))?/g;
  let match = pattern.exec(source);
  while (match !== null) {
    if (match[1] !== undefined) {
      result.id = match[1];
    } else if (match[2] !== undefined) {
      result.classes.push(match[2]);
    } else if (match[3] !== undefined) {
      let value = "true";
      if (match[4] !== undefined) {
        value = match[4];
      } else if (match[5] !== undefined) {
        value = match[5];
      } else if (match[6] !== undefined) {
        value = match[6];
      }
      result.values[match[3]] = value;
    }
    match = pattern.exec(source);
  }
  return result;
}

/**
 * One page into HAX-ready HTML. Quarto syntax that markdown-it does not know
 * (fenced divs, callouts, executable chunks, shortcodes, attribute blocks,
 * cross-references) is mapped or unwrapped before rendering, then assets,
 * links and images are rewritten against the imported site.
 */
async function renderPage(raw, node, context) {
  const markdown = NOTEBOOK_REGEX.test(node.path)
    ? notebookToMarkdown(raw, context)
    : raw;
  const split = splitFrontmatter(markdown);
  const frontTitle = stringOf(split.data.title);
  let body = split.body;
  // a chapter with no title in its front matter is titled by its first heading
  let headingTitle = "";
  if (frontTitle === "") {
    const heading = takeLeadingHeading(body);
    if (heading !== null) {
      body = heading.body;
      headingTitle = heading.title;
    }
  }
  // an outline label is the title the navigation shows, so it wins
  const pageTitle = frontTitle || headingTitle;
  if (pageTitle !== "" && !node.explicit) {
    node.item.title = pageTitle;
  }
  const pageLicense =
    normalizeLicense(split.data.license) || context.source.license;
  const author = authorText(split.data.author) || context.source.config.author;
  if (pageLicense) {
    node.item.metadata.quarto.license = pageLicense;
  }
  if (author) {
    node.item.metadata.quarto.author = author;
  }
  body = await expandIncludes(body, node.path, context, 0);
  body = transformCodeBlocks(body, context);
  body = transformShortcodes(body, node, context);
  body = transformDivs(body);
  body = mapText(body, (text) => transformInline(text, context));
  const html = createRenderer().render(body);
  const container = parse(`<div>${html}</div>`, { comment: false });
  rewriteMedia(container, node, context);
  rewriteLinks(container, node, context);
  let contents = container.innerHTML
    .replace(/^<div>/, "")
    .replace(/<\/div>$/, "")
    .trim();
  if (pageLicense) {
    contents += `\n${licenseElement(pageLicense, node, context, author)}`;
  }
  return contents === "" ? "<p></p>" : contents;
}

/** The first line as a level one heading: its text, and the body without it. */
function takeLeadingHeading(body) {
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") {
    index++;
  }
  if (index >= lines.length) {
    return null;
  }
  const match = /^#\s+(.+?)\s*$/.exec(lines[index]);
  if (!match) {
    return null;
  }
  const title = headingText(match[1]);
  if (title === "") {
    return null;
  }
  lines.splice(index, 1);
  return { title: title, body: lines.join("\n") };
}

/** A heading's text without its pandoc attribute block or emphasis marks. */
function headingText(text) {
  return text
    .replace(/\s*\{[^}]*\}\s*$/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

// --- fenced code and text segments ----------------------------------------

/**
 * Markdown as alternating text and fenced-code segments, so the transforms
 * that rewrite Quarto syntax never touch what sits inside a code block.
 */
function splitSegments(markdown) {
  const segments = [];
  let current = { code: false, lines: [] };
  let fence = null;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence === null) {
      const open = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open && !(open[1].charAt(0) === "`" && open[2].indexOf("`") !== -1)) {
        if (current.lines.length > 0) {
          segments.push(current);
        }
        current = { code: true, lines: [line] };
        fence = { character: open[1].charAt(0), length: open[1].length };
        continue;
      }
      current.lines.push(line);
    } else {
      current.lines.push(line);
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (
        close &&
        close[1].charAt(0) === fence.character &&
        close[1].length >= fence.length
      ) {
        segments.push(current);
        current = { code: false, lines: [] };
        fence = null;
      }
    }
  }
  if (current.lines.length > 0) {
    segments.push(current);
  }
  return segments;
}

function joinSegments(segments) {
  const lines = [];
  segments.forEach((segment) => {
    segment.lines.forEach((line) => {
      lines.push(line);
    });
  });
  return lines.join("\n");
}

/** Apply a text transform to the segments that are not code. */
function mapText(markdown, transform) {
  const segments = splitSegments(markdown);
  segments.forEach((segment) => {
    if (!segment.code) {
      segment.lines = transform(segment.lines.join("\n")).split("\n");
    }
  });
  return joinSegments(segments);
}

/** Apply a text transform to one line, leaving inline code alone. */
function outsideInlineCode(line, transform) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((piece, index) => (index % 2 === 1 ? piece : transform(piece)))
    .join("");
}

// --- notebooks, includes, code chunks ---------------------------------------

function cellSource(source) {
  if (Array.isArray(source)) {
    return source.join("");
  }
  return typeof source === "string" ? source : "";
}

/**
 * A Jupyter notebook as the markdown Quarto would render: markdown cells as
 * they are, code cells as executable chunks, and a leading raw cell holding
 * YAML as the front matter. Outputs are not imported.
 */
function notebookToMarkdown(raw, context) {
  let notebook = null;
  try {
    notebook = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!isObject(notebook) || !Array.isArray(notebook.cells)) {
    return "";
  }
  const metadata = objectOf(notebook.metadata);
  const language = (
    stringOf(objectOf(metadata.kernelspec).language) ||
    stringOf(objectOf(metadata.language_info).name) ||
    "python"
  ).replace(/[^A-Za-z0-9_+-]/g, "");
  let frontMatter = "";
  const parts = [];
  notebook.cells.forEach((cell, index) => {
    if (!isObject(cell)) {
      return;
    }
    const source = cellSource(cell.source);
    if (cell.cell_type === "markdown") {
      parts.push(source);
    } else if (cell.cell_type === "code") {
      parts.push(`\`\`\`{${language}}\n${source}\n\`\`\``);
      if (Array.isArray(cell.outputs) && cell.outputs.length > 0) {
        context.unmapped["code-outputs"] = true;
      }
    } else if (
      cell.cell_type === "raw" &&
      index === 0 &&
      /^---\r?\n/.test(source.trim())
    ) {
      frontMatter = source.trim();
    }
  });
  const body = parts.join("\n\n");
  return frontMatter === "" ? body : `${frontMatter}\n\n${body}`;
}

// chunk engines that draw from their own source, with no output to compute
const DIAGRAM_ENGINES = ["mermaid", "dot"];

const INCLUDE_REGEX = /\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g;

/**
 * {{< include file.qmd >}} pulls another file's markdown into the page. The
 * included file is read relative to the file that includes it, runs through
 * the same pipeline as a page, and is bounded in depth and in count.
 */
async function expandIncludes(markdown, currentPath, context, depth) {
  const segments = splitSegments(markdown);
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].code) {
      continue;
    }
    let text = segments[i].lines.join("\n");
    const matches = [];
    let match = INCLUDE_REGEX.exec(text);
    while (match !== null) {
      matches.push({ token: match[0], reference: match[1] });
      match = INCLUDE_REGEX.exec(text);
    }
    INCLUDE_REGEX.lastIndex = 0;
    for (let j = 0; j < matches.length; j++) {
      const replacement = await readInclude(
        matches[j].reference,
        currentPath,
        context,
        depth,
      );
      text = text.replace(matches[j].token, () => replacement);
    }
    segments[i].lines = text.split("\n");
  }
  return joinSegments(segments);
}

async function readInclude(reference, currentPath, context, depth) {
  const clean = reference.replace(/^["']|["']$/g, "");
  if (!PAGE_EXTENSION_REGEX.test(clean) || isExternal(clean)) {
    return "";
  }
  const directory = currentPath.split("/").slice(0, -1).join("/");
  const repoPath =
    clean.charAt(0) === "/"
      ? normalizePath(`${rootPrefix(context.source)}${clean}`)
      : normalizePath(`${directory}/${clean}`);
  if (!context.source.paths[repoPath]) {
    return "";
  }
  if (depth >= MAX_INCLUDE_DEPTH || context.includes >= LIMITS.maxIncludes) {
    context.truncated = true;
    return "";
  }
  context.includes++;
  const included = await fetchText(
    `${context.source.rawBase}/${encodeURI(repoPath)}`,
  );
  if (included === null) {
    return "";
  }
  const markdown = NOTEBOOK_REGEX.test(repoPath)
    ? notebookToMarkdown(included, context)
    : included;
  const inner = await expandIncludes(
    splitFrontmatter(markdown).body,
    repoPath,
    context,
    depth + 1,
  );
  return `\n\n${inner}\n\n`;
}

/**
 * Executable chunks ({r}, {python}, {julia}) become plain fenced code in the
 * language they name. Chunk options (#| lines and knitr header options) are
 * execution metadata and are dropped; a chunk that Quarto would hide
 * (echo or include false) is dropped with them. Raw {=html} blocks keep their
 * content, other raw blocks are dropped. Outputs are not computed, so a page
 * with executable chunks is reported as having none.
 */
function transformCodeBlocks(markdown, context) {
  const segments = splitSegments(markdown);
  segments.forEach((segment) => {
    if (!segment.code) {
      return;
    }
    const open = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/.exec(segment.lines[0]);
    if (!open) {
      return;
    }
    const info = open[3].trim();
    const raw = /^\{=([A-Za-z0-9_-]+)\}$/.exec(info);
    if (raw) {
      const inner = segment.lines.slice(1);
      if (/^\s{0,3}(`{3,}|~{3,})\s*$/.test(inner[inner.length - 1] || "")) {
        inner.pop();
      }
      segment.code = false;
      segment.lines =
        raw[1].toLowerCase() === "html" ? ["", ...inner, ""] : [""];
      return;
    }
    const chunk = /^\{\s*\.?([A-Za-z0-9_+-]+)\s*(?:,\s*|\s+)?([^}]*)\}$/.exec(
      info,
    );
    if (!chunk) {
      return;
    }
    const executable =
      !/^\{\s*\./.test(info) && DIAGRAM_ENGINES.indexOf(chunk[1]) === -1;
    const lines = segment.lines.slice(1);
    const closer = /^\s{0,3}(`{3,}|~{3,})\s*$/.test(
      lines[lines.length - 1] || "",
    )
      ? lines.pop()
      : null;
    const options = {};
    while (lines.length > 0 && /^\s*#\|/.test(lines[0])) {
      const option = /^\s*#\|\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(lines[0]);
      if (option) {
        options[option[1]] = option[2].trim().toLowerCase();
      }
      lines.shift();
    }
    const header = chunk[2] || "";
    const hidden =
      options.echo === "false" ||
      options.include === "false" ||
      /\b(echo|include)\s*=\s*(FALSE|F|false)\b/.test(header);
    if (
      executable &&
      options.eval !== "false" &&
      !/\beval\s*=\s*(FALSE|F|false)\b/.test(header)
    ) {
      context.unmapped["code-outputs"] = true;
    }
    if (hidden) {
      segment.code = false;
      segment.lines = [""];
      return;
    }
    segment.lines = [`${open[1]}${open[2]}${chunk[1]}`, ...lines];
    if (closer !== null) {
      segment.lines.push(closer);
    }
  });
  return joinSegments(segments);
}

// --- shortcodes -----------------------------------------------------------

const SHORTCODE_REGEX = /\{\{<\s*([A-Za-z0-9_-]+)\s*([\s\S]*?)\s*>\}\}/g;
// shortcodes that exist only to steer another output format
const SILENT_SHORTCODES = ["pagebreak", "lipsum"];

/** Positional and name="value" arguments of a shortcode. */
function parseShortcodeArguments(source) {
  const positional = [];
  const named = {};
  const pattern =
    /([A-Za-z][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    if (match[1] !== undefined) {
      const value =
        match[2] !== undefined
          ? match[2]
          : match[3] !== undefined
            ? match[3]
            : match[4];
      named[match[1]] = value;
    } else {
      const value =
        match[5] !== undefined
          ? match[5]
          : match[6] !== undefined
            ? match[6]
            : match[7];
      positional.push(value);
    }
    match = pattern.exec(source);
  }
  return { positional: positional, named: named };
}

/**
 * Quarto shortcodes. video has a HAX equivalent (video-player); the others are
 * unwrapped to nothing and reported in unmappedComponents rather than left as
 * text the site cannot render. include is handled earlier.
 */
function transformShortcodes(markdown, node, context) {
  return mapText(markdown, (text) =>
    text.replace(SHORTCODE_REGEX, (match, name, rawArguments) => {
      const lower = name.toLowerCase();
      if (lower === "video") {
        const args = parseShortcodeArguments(rawArguments);
        const source = args.positional[0] || "";
        if (source === "") {
          return "";
        }
        const resolved = isExternal(source)
          ? source
          : registerAsset(source, node, context) ||
            absoluteSourceUrl(source, node, context);
        let tag = `<video-player source="${escapeHTMLAttribute(resolved)}"`;
        if (args.named.title) {
          tag += ` media-title="${escapeHTMLAttribute(args.named.title)}"`;
        }
        return `\n\n${tag}></video-player>\n\n`;
      }
      if (lower !== "include" && SILENT_SHORTCODES.indexOf(lower) === -1) {
        context.unmapped[`shortcode:${lower}`] = true;
      }
      return "";
    }),
  );
}

// --- fenced divs and callouts --------------------------------------------------

/** Whether a content-visible/hidden div applies to the html output. */
function appliesToTarget(values) {
  const when = stringOf(values["when-format"]).toLowerCase();
  const unless = stringOf(values["unless-format"]).toLowerCase();
  const names = (value) => value.split(/[\s,]+/).filter((name) => name !== "");
  if (when !== "" && names(when).indexOf(TARGET_FORMAT) === -1) {
    return false;
  }
  return !(unless !== "" && names(unless).indexOf(TARGET_FORMAT) !== -1);
}

/**
 * Pandoc fenced divs (::: {.class} ... :::). Callouts become stop-note (the
 * title comes from the title attribute, else a first heading, else the type);
 * content-visible/content-hidden divs are kept or dropped for html output;
 * every other div keeps its id and classes. Blank lines around each wrapper
 * let the markdown inside still render.
 */
function transformDivs(markdown) {
  const segments = splitSegments(markdown);
  const out = [];
  const stack = [];
  segments.forEach((segment) => {
    if (segment.code) {
      segment.lines.forEach((line) => {
        if (!stack.some((frame) => frame.kind === "drop")) {
          out.push(line);
        }
      });
      return;
    }
    const lines = segment.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === null) {
        continue;
      }
      const fence = /^\s{0,3}(:{3,})\s*(.*?)\s*$/.exec(line);
      const dropping = stack.some((frame) => frame.kind === "drop");
      if (!fence) {
        if (!dropping) {
          out.push(line);
        }
        continue;
      }
      const attributeText = fence[2].replace(/\s*:+\s*$/, "").trim();
      if (attributeText === "") {
        const frame = stack.pop();
        if (frame && frame.close.length > 0) {
          out.push(...frame.close);
        } else if (!frame && !dropping) {
          out.push(line);
        }
        continue;
      }
      // ::: {.class key=value} carries an attribute block; ::: class is the
      // same thing with a bare class name
      const attributes =
        attributeText.charAt(0) === "{"
          ? parseAttributes(attributeText.replace(/^\{|\}$/g, ""))
          : {
              id: "",
              classes: attributeText.split(/\s+/).filter((name) => name !== ""),
              values: {},
            };
      if (dropping) {
        stack.push({ kind: "drop", close: [] });
        continue;
      }
      const callout = calloutOf(attributes);
      if (callout !== null) {
        let title = stringOf(attributes.values.title);
        if (title === "") {
          // Quarto takes the first heading inside a callout as its title
          let next = i + 1;
          while (
            next < lines.length &&
            lines[next] !== null &&
            lines[next].trim() === ""
          ) {
            next++;
          }
          const heading =
            next < lines.length && lines[next] !== null
              ? /^#{1,6}\s+(.+?)\s*$/.exec(lines[next])
              : null;
          if (heading) {
            title = headingText(heading[1]);
            lines[next] = null;
          }
        }
        out.push(
          "",
          `<stop-note status="${escapeHTMLAttribute(callout.status)}" title="${escapeHTMLAttribute(title || callout.title)}">`,
          '<div slot="message">',
          "",
        );
        stack.push({
          kind: "callout",
          close: ["", "</div>", "</stop-note>", ""],
        });
        continue;
      }
      const conditional =
        attributes.classes.indexOf("content-visible") !== -1
          ? "visible"
          : attributes.classes.indexOf("content-hidden") !== -1
            ? "hidden"
            : "";
      if (conditional !== "") {
        const applies = appliesToTarget(attributes.values);
        const keep = conditional === "visible" ? applies : !applies;
        stack.push({ kind: keep ? "unwrap" : "drop", close: [] });
        continue;
      }
      let open = "<div";
      if (attributes.id !== "") {
        open += ` id="${escapeHTMLAttribute(attributes.id)}"`;
      }
      if (attributes.classes.length > 0) {
        open += ` class="${escapeHTMLAttribute(attributes.classes.join(" "))}"`;
      }
      out.push("", `${open}>`, "");
      stack.push({ kind: "div", close: ["", "</div>", ""] });
    }
  });
  // a div left open at the end of the page is closed for it
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.close.length > 0) {
      out.push(...frame.close);
    }
  }
  return out.join("\n");
}

function calloutOf(attributes) {
  for (let i = 0; i < attributes.classes.length; i++) {
    const match = /^callout-(note|tip|important|warning|caution)$/.exec(
      attributes.classes[i],
    );
    if (match) {
      return CALLOUTS[match[1]];
    }
  }
  return null;
}

// --- inline pandoc syntax -------------------------------------------------------

/**
 * Inline syntax markdown-it does not know: attribute blocks on images, links
 * and headings, bracketed spans, and cross-references. Image attributes are
 * mined for fig-alt; the rest are dropped. A cross-reference keeps its
 * readable key without the @, since numbering needs a real render.
 */
function transformInline(text, context) {
  return text
    .split("\n")
    .map((line) => {
      let result = line.replace(
        /^(#{1,6}\s+.*?)\s+\{[^}]*\}\s*$/,
        (match, heading) => heading,
      );
      // A captioned table: ": Caption {#tbl-key}" becomes an emphasized line.
      result = result.replace(
        /^:\s+(.+?)\s*\{#tbl-[^}]*\}\s*$/,
        (match, caption) => `*${caption}*`,
      );
      // Image attributes run before code spans are set aside, because a
      // caption can hold inline code (`qplot`) that would split the image.
      result = result.replace(
        /!\[((?:[^\]`]|`[^`]*`)*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\{([^}]*)\}/g,
        (match, caption, source, attributeText, offset) => {
          const before = result.slice(0, offset);
          if ((before.match(/`/g) || []).length % 2 === 1) {
            return match;
          }
          const attributes = parseAttributes(attributeText);
          const alt = attributes.values["fig-alt"] || caption;
          return `![${alt}](${source})`;
        },
      );
      result = outsideInlineCode(result, (piece) => {
        let value = piece;
        value = value.replace(
          /(\[[^\]]*\]\([^)]*\))\{[^}]*\}/g,
          (match, link) => link,
        );
        value = value.replace(
          /\[([^\]]+)\]\{([^}]*)\}/g,
          (match, content, attributeText) => {
            const attributes = parseAttributes(attributeText);
            if (attributes.classes.length === 0) {
              return content;
            }
            return `<span class="${escapeHTMLAttribute(attributes.classes.join(" "))}">${content}</span>`;
          },
        );
        value = value.replace(
          /(^|[^\w@])@((?:fig|tbl|sec|eq|lst|thm|lem|cor|prp|cnj|def|exm|exr)-[\w:.-]*[\w])/g,
          (match, before, key) => {
            context.unmapped["cross-references"] = true;
            return `${before}${key}`;
          },
        );
        return value;
      });
      return result;
    })
    .join("\n");
}

// --- media, links and assets -----------------------------------------------------

/** Images become media-image; anything else keeps its source. */
function rewriteMedia(container, node, context) {
  const images = container.querySelectorAll("img");
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const source = image.getAttribute("src");
    if (!source) {
      continue;
    }
    const resolved =
      registerAsset(source, node, context) ||
      absoluteSourceUrl(source, node, context);
    const alt = escapeHTMLAttribute(image.getAttribute("alt") || "");
    if (
      IMAGE_EXTENSION_REGEX.test(resolved) ||
      resolved.indexOf("files/") === 0
    ) {
      image.replaceWith(
        `<media-image source="${escapeHTMLAttribute(resolved)}" alt="${alt}"></media-image>`,
      );
    } else {
      image.setAttribute("src", resolved);
    }
  }
}

/**
 * In-project links point at the imported slugs; links to importable files join
 * the file map; everything else is absolutized against the source repository.
 */
function rewriteLinks(container, node, context) {
  const links = container.querySelectorAll("a");
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const href = link.getAttribute("href");
    if (!href || href.indexOf("#") === 0 || isExternal(href)) {
      continue;
    }
    const docPath = resolveDocPath(href, context.source, node);
    if (docPath !== null && context.slugByPath[docPath]) {
      const hash =
        href.indexOf("#") === -1 ? "" : href.slice(href.indexOf("#"));
      link.setAttribute("href", `${context.slugByPath[docPath]}${hash}`);
      continue;
    }
    const asset = registerAsset(href, node, context);
    link.setAttribute("href", asset || absoluteSourceUrl(href, node, context));
  }
}

/**
 * A link to the page that backs it. Links are written against the rendered
 * site (chapter.html) or the source (chapter.qmd), relative to the page that
 * carries them or to the project root.
 */
function resolveDocPath(link, source, node) {
  let target = String(link).split("#")[0].split("?")[0];
  if (target === "") {
    return null;
  }
  target = target.replace(/\.html$/i, "").replace(PAGE_EXTENSION_REGEX, "");
  const directory = node.path
    ? node.path.split("/").slice(0, -1).join("/")
    : "";
  const base =
    target.charAt(0) === "/"
      ? normalizePath(`${rootPrefix(source)}${target}`)
      : normalizePath(
          `${directory === "" ? rootPrefix(source) : directory}/${target}`,
        );
  const candidates = [];
  PAGE_EXTENSIONS.forEach((extension) => {
    candidates.push(`${base}${extension}`);
  });
  PAGE_EXTENSIONS.forEach((extension) => {
    candidates.push(`${base}/index${extension}`);
  });
  for (let i = 0; i < candidates.length; i++) {
    if (source.paths[candidates[i]]) {
      return candidates[i];
    }
  }
  return null;
}

/**
 * Resolve a page reference to a repository file and add it to the file map.
 * Returns the site-relative path, or null when the file is not importable.
 */
function registerAsset(reference, node, context) {
  if (
    typeof reference !== "string" ||
    reference === "" ||
    isExternal(reference)
  ) {
    return null;
  }
  const clean = reference.split("#")[0].split("?")[0];
  if (clean === "" || !IMPORTABLE_ASSET_REGEX.test(clean)) {
    return null;
  }
  const repoPath = resolveAssetPath(clean, node, context);
  if (repoPath === null) {
    return null;
  }
  if (context.filesByPath[repoPath]) {
    return context.filesByPath[repoPath];
  }
  if (Object.keys(context.files).length >= LIMITS.maxFiles) {
    context.truncated = true;
    return null;
  }
  const name = uniqueFileName(repoPath, context);
  const sitePath = `files/${name}`;
  context.files[sitePath] = encodeURI(`${context.source.rawBase}/${repoPath}`);
  context.filesByPath[repoPath] = sitePath;
  return sitePath;
}

/** An asset reference to a path inside the repository, or null. */
function resolveAssetPath(reference, node, context) {
  const prefix = rootPrefix(context.source);
  let candidate = "";
  if (reference.charAt(0) === "/") {
    // a leading slash is the project root, as it is for Quarto itself
    candidate = normalizePath(`${prefix}${reference}`);
  } else {
    const directory = node.path
      ? node.path.split("/").slice(0, -1).join("/")
      : prefix.replace(/\/$/, "");
    candidate = normalizePath(`${directory}/${reference}`);
  }
  return context.source.paths[candidate] ? candidate : null;
}

/** files/ is flat, so keep basenames unique across the import. */
function uniqueFileName(repoPath, context) {
  const base = repoPath
    .split("/")
    .pop()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!context.fileNames[base]) {
    context.fileNames[base] = true;
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  const extension = dot === -1 ? "" : base.slice(dot);
  let counter = 1;
  let candidate = `${stem}-${counter}${extension}`;
  while (context.fileNames[candidate]) {
    counter++;
    candidate = `${stem}-${counter}${extension}`;
  }
  context.fileNames[candidate] = true;
  return candidate;
}

/**
 * A reference that stays remote - an extension createSite will not import, or
 * a file the repository does not actually carry - pointed at the source
 * repository so the page still resolves.
 */
function absoluteSourceUrl(reference, node, context) {
  if (isExternal(reference)) {
    return reference;
  }
  const clean = reference.split("#")[0].split("?")[0];
  const repoPath = resolveAssetPath(clean, node, context);
  if (repoPath !== null) {
    return encodeURI(`${context.source.rawBase}/${repoPath}`);
  }
  const prefix = rootPrefix(context.source);
  if (clean.charAt(0) === "/") {
    return encodeURI(
      `${context.source.rawBase}/${normalizePath(`${prefix}${clean}`)}`,
    );
  }
  const directory = node.path
    ? node.path.split("/").slice(0, -1).join("/")
    : prefix.replace(/\/$/, "");
  return encodeURI(
    `${context.source.rawBase}/${normalizePath(`${directory}/${clean}`)}`,
  );
}

/** Attribution for one page, using the license code the source declared. */
function licenseElement(license, node, context, author) {
  const title =
    node.item.title || context.source.config.title || context.source.title;
  let element = `<license-element license="${escapeHTMLAttribute(license)}" title="${escapeHTMLAttribute(title)}"`;
  if (author) {
    element += ` creator="${escapeHTMLAttribute(author)}"`;
  }
  if (node.item.metadata && node.item.metadata.source) {
    element += ` source="${escapeHTMLAttribute(node.item.metadata.source)}"`;
  }
  return `${element}></license-element>`;
}

module.exports = { convertQuartoToSite, LIMITS };
