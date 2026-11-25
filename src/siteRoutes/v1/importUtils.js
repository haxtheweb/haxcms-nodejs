const { parse } = require('node-html-parser');
const { htmlFromEl } = require('../../lib/convertUtils.js');
const JSONOutlineSchemaItem = require('../../lib/JSONOutlineSchemaItem.js');
const { HAXCMS } = require('../../lib/HAXCMS.js');

function getHighestHeadingLevel(doc) {
  for (let level = 1; level <= 4; level++) {
    const headings = doc.querySelectorAll(`h${level}`);
    if (headings.length > 0) {
      return level;
    }
  }
  return null;
}

function processSinglePageContent(wrapperEl) {
  if (!wrapperEl) {
    return '<p></p>';
  }
  let content = '';
  for (const child of wrapperEl.childNodes) {
    if (child && child.tagName) {
      content += htmlFromEl(child);
    }
  }
  return content !== '' ? content : wrapperEl.innerHTML;
}

function importSinglePage(title, content, pValue) {
  let item = new JSONOutlineSchemaItem();
  item.title = title;
  item.slug = HAXCMS.cleanTitle(item.title);
  item.order = 0;
  item.parent = pValue;
  item.contents = content;
  return item;
}

async function nextUntilElement(elem, tagMatches) {
  var siblings = [];
  elem = elem.nextElementSibling;
  while (elem) {
    if (tagMatches.includes(elem.tagName)) {
      break;
    }
    siblings.push(elem);
    elem = elem.nextElementSibling;
  }
  return {
    siblings: siblings,
    lastEl: elem,
  };
}

function getFallbackContent(type) {
  switch (type) {
    case 'portfolio':
      return `<p>Enjoy my portfolio and let me know if you have questions.</p>
<lesson-overview>
  <lesson-highlight smart="pages"></lesson-highlight>
</lesson-overview>`;
    case 'course':
      return `<p>Welcome to the lesson.</p>
<lesson-overview>
  <lesson-highlight smart="pages"></lesson-highlight>
  <lesson-highlight smart="readTime"></lesson-highlight>
  <lesson-highlight smart="selfChecks"></lesson-highlight>
  <lesson-highlight smart="audio"></lesson-highlight>
  <lesson-highlight smart="video"></lesson-highlight>
</lesson-overview>
<p>Let's begin!</p>`;
    default:
      return '<p></p>';
  }
}

const HEADING_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

/**
 * Pages of a HAXcms site export, or null when the HTML isn't one.
 *
 * Two export shapes carry their pages as blocks: the document export
 * (main[data-haxcms-export="site"] > article[data-item-id], each article's
 * first heading its title) and the wrapped export (a heading followed by
 * div[data-jos-item-id]). Exports made since data-item-parent was added say
 * each page's parent, so the outline comes back as it was; older document
 * exports import flat in order. A div[data-jos-item-id] list without
 * data-item-parent (older wrapped exports, hand-made files) is left to the
 * heading-based import. haxcms-php haxcmsImportSiteExportBlocks keeps the
 * same rules.
 */
function readSiteExportBlocks(doc) {
  const blocks = [];
  const articles = doc.querySelectorAll('main[data-haxcms-export="site"] > article[data-item-id]');
  if (articles.length > 0) {
    for (const article of articles) {
      let title = '';
      let contents = '';
      for (const child of article.childNodes) {
        if (!child || !child.tagName) {
          continue;
        }
        if (title === '' && HEADING_TAGS.includes(child.tagName)) {
          title = child.text.trim();
        } else {
          contents += htmlFromEl(child);
        }
      }
      blocks.push({
        id: article.getAttribute('data-item-id') || '',
        parent: article.getAttribute('data-item-parent') || '',
        title: title,
        contents: contents,
      });
    }
    return blocks;
  }
  const divs = doc.querySelectorAll('div[data-jos-item-id]');
  if (divs.length === 0) {
    return null;
  }
  for (const div of divs) {
    const heading = div.previousElementSibling;
    if (!div.hasAttribute('data-item-parent') || !heading || !HEADING_TAGS.includes(heading.tagName)) {
      return null;
    }
    let contents = '';
    for (const child of div.childNodes) {
      if (child && child.tagName) {
        contents += htmlFromEl(child);
      }
    }
    blocks.push({
      id: div.getAttribute('data-jos-item-id') || '',
      parent: div.getAttribute('data-item-parent') || '',
      title: heading.text.trim(),
      contents: contents,
    });
  }
  return blocks;
}

function importSiteExportBlocks(blocks, parentId, type) {
  // an export lists pages in outline order, which can put a page before its
  // parent, so make every page first and link parents second
  const items = [];
  const byExportId = {};
  for (const block of blocks) {
    const item = new JSONOutlineSchemaItem();
    item.title = block.title.replace(/\s+/g, ' ') || 'Untitled';
    item.contents = block.contents;
    if (block.id && !byExportId[block.id]) {
      byExportId[block.id] = item;
    }
    items.push(item);
  }
  const parentOf = new Map();
  blocks.forEach((block, i) => {
    const parentItem = block.parent ? byExportId[block.parent] : null;
    parentOf.set(items[i], parentItem && parentItem !== items[i] ? parentItem : null);
  });
  // in a parent chain that loops back on itself the first page found becomes
  // top level (haxcms-php haxcmsImportSiteExportItems keeps the same rule)
  const depthOf = (item) => {
    let depth = 0;
    let at = parentOf.get(item);
    while (at && depth <= items.length) {
      depth++;
      at = parentOf.get(at);
    }
    return at ? -1 : depth;
  };
  const slugOf = (item) => {
    const parentItem = parentOf.get(item);
    return (parentItem ? slugOf(parentItem) + '/' : '') + HAXCMS.cleanTitle(item.title);
  };
  const order = {};
  for (const item of items) {
    if (depthOf(item) < 0) {
      parentOf.set(item, null);
    }
  }
  for (const item of items) {
    const parentItem = parentOf.get(item);
    item.parent = parentItem ? parentItem.id : parentId;
    item.indent = depthOf(item);
    item.slug = slugOf(item);
    const key = item.parent || '';
    item.order = order[key] || 0;
    order[key] = item.order + 1;
    if (item.contents === '') {
      item.contents = parentItem ? '<p></p>' : getFallbackContent(type);
    }
  }
  return items;
}

/**
 * Parse HTML from an import wrapper into a JSON Outline Schema items array.
 *
 * @param {string} html - raw HTML string
 * @param {object} options
 * @param {string} options.titleValue - base title for single-page imports
 * @param {string} options.method - 'site' | 'branch' | 'page'
 * @param {string} options.type - 'course' | 'portfolio' | ''
 * @param {string|null} options.parentId
 * @returns {Promise<Array>} items array
 */
async function importHtmlToItems(html, options) {
  const doc = parse(`<div id="import-wrapper">${html}</div>`);
  const method = options.method || 'site';
  const type = options.type || '';
  const parentId = options.parentId || null;
  const titleValue = options.titleValue || 'import';
  let items = [];

  switch (method) {
    case 'site': {
      const exportBlocks = readSiteExportBlocks(doc);
      if (exportBlocks && exportBlocks.length > 0) {
        items = importSiteExportBlocks(exportBlocks, parentId, type);
        break;
      }
      const highestLevel = getHighestHeadingLevel(doc);
      const rootTag = highestLevel ? `h${highestLevel}` : null;
      const childTag = highestLevel && highestLevel < 4 ? `h${highestLevel + 1}` : null;
      const rootTagName = rootTag ? rootTag.toUpperCase() : null;
      const childTagName = childTag ? childTag.toUpperCase() : null;

      if (!rootTag) {
        items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#import-wrapper')), parentId));
      } else {
        const rootHeadings = doc.querySelectorAll(rootTag);
        let rootOrder = 0;
        const rootStopTags = [rootTagName];
        const childStopTags = childTagName ? [...rootStopTags, childTagName] : rootStopTags;

        for await (const rootHeading of rootHeadings) {
          let item = new JSONOutlineSchemaItem();
          item.title = rootHeading.text.trim().replace('  ', ' ').replace('  ', ' ');
          item.slug = HAXCMS.cleanTitle(item.title);
          item.order = rootOrder;
          item.parent = parentId;
          rootOrder += 1;
          let tmp = await nextUntilElement(rootHeading, rootStopTags);
          let rootChildren = tmp.siblings;
          let contents = '';
          let childHeading = null;
          for await (const rootChild of rootChildren) {
            if (childTagName && rootChild.tagName === childTagName) {
              childHeading = rootChild;
              break;
            } else if (childHeading === null) {
              contents += htmlFromEl(rootChild);
            }
          }
          item.contents = contents !== '' ? contents : getFallbackContent(type);
          items.push(item);
          if (childHeading) {
            let childOrder = 0;
            while (childHeading !== null && childHeading.tagName === childTagName) {
              let item2 = new JSONOutlineSchemaItem();
          item2.title = childHeading.text.trim().replace('  ', ' ').replace('  ', ' ');
              item2.slug = item.slug + '/' + HAXCMS.cleanTitle(item2.title);
              item2.order = childOrder;
              childOrder += 1;
              item2.indent = 1;
              item2.parent = item.id;
              let tmp = await nextUntilElement(childHeading, childStopTags);
              let childChildren = tmp.siblings;
              childHeading = tmp.lastEl;
              let contents2 = '';
              for await (const childChild of childChildren) {
                contents2 += htmlFromEl(childChild);
              }
              item2.contents = contents2 !== '' ? contents2 : '<p></p>';
              items.push(item2);
            }
          }
        }
      }
      break;
    }
    case 'branch': {
      const highestLevel = getHighestHeadingLevel(doc);
      const rootTag = highestLevel ? `h${highestLevel}` : null;
      const rootTagName = rootTag ? rootTag.toUpperCase() : null;

      if (!rootTag) {
        items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#import-wrapper')), parentId));
      } else {
        const rootHeadings = doc.querySelectorAll(rootTag);
        let order = 0;
        const rootStopTags = [rootTagName];

        for await (const rootHeading of rootHeadings) {
          let item = new JSONOutlineSchemaItem();
          item.title = rootHeading.text.trim().replace('  ', ' ').replace('  ', ' ');
          item.slug = HAXCMS.cleanTitle(item.title);
          item.order = order;
          item.parent = parentId;
          order += 1;
          let tmp = await nextUntilElement(rootHeading, rootStopTags);
          let rootChildren = tmp.siblings;
          let contents = '';
          for await (const rootChild of rootChildren) {
            contents += htmlFromEl(rootChild);
          }
          item.contents = contents !== '' ? contents : getFallbackContent(type);
          items.push(item);
        }
      }
      break;
    }
    case 'page':
    default: {
      items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#import-wrapper')), parentId));
      break;
    }
  }

  return items;
}

module.exports = {
  importHtmlToItems,
  getHighestHeadingLevel,
  processSinglePageContent,
  importSinglePage,
  nextUntilElement,
  getFallbackContent,
};
