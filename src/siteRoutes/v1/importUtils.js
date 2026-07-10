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
