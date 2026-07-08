const { convertToHtml } = require('mammoth');
const { parse } = require('node-html-parser');
const { HAXCMS } = require('../../../lib/HAXCMS.js');
const {
  stripMSWord,
  validURL,
  htmlFromEl,
  processDocxHtml,
} = require('../../../lib/convertUtils.js');
const JSONOutlineSchemaItem = require('../../../lib/JSONOutlineSchemaItem.js');

/**
 * POST /system/api/v1/actions/import-docx
 * Convert an uploaded .docx or .doc file into a HAXcms site schema (items array).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Also accepts form fields: method (site|branch|page), type (course|portfolio|''), parentId.
 * Returns { status: 200, data: { items: [...], filename: string } }.
 */
async function importDocx(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'No file uploaded',
          items: [],
          filename: null,
        },
      });
    }

    const file = req.files[0];
    filename = file.originalname;
    if (!/\.(docx|doc)$/i.test(filename)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .docx or .doc, got: ${filename}`,
          items: [],
          filename: filename,
        },
      });
    }

    const fs = require('fs-extra');
    let buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unable to read uploaded file: ${e.message}`,
          items: [],
          filename: filename,
        },
      });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is empty',
          items: [],
          filename: filename,
        },
      });
    }

    const mammothOptions = {
      styleMap: [
        'u => em',
        'strike => del',
      ],
    };

    let html = '';
    try {
      const result = await convertToHtml({ buffer: buffer }, mammothOptions);
      html = result.value;
      html = processDocxHtml(html);
      html = stripMSWord(html);
    } catch (e) {
      html = '';
      throw new Error(`Error converting DOCX: ${e.message}`);
    }

    const doc = parse(`<div id="docx-import-wrapper">${html}</div>`);
    const type = req.body && req.body.type ? req.body.type : '';
    const method = req.body && req.body.method ? req.body.method : 'site';
    const parentIdField = req.body && req.body.parentId ? req.body.parentId : null;
    const parentId = parentIdField && parentIdField !== 'null' ? parentIdField : null;
    const titleValue = filename.replace(/\.(docx|doc)$/i, '');
    let items = [];

    switch (method) {
      case 'site': {
        let h1s = doc.querySelectorAll('h1');
        let h1Order = 0;
        if (h1s.length === 0) {
          items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#docx-import-wrapper')), parentId));
        } else {
          for await (const h1 of h1s) {
            let item = new JSONOutlineSchemaItem();
            item.title = h1.innerText.trim().replace('  ', ' ').replace('  ', ' ');
            item.slug = HAXCMS.cleanTitle(item.title);
            item.order = h1Order;
            item.parent = parentId;
            h1Order += 1;
            let tmp = await nextUntilElement(h1, ['H1']);
            let h1Children = tmp.siblings;
            let contents = '';
            let h2 = null;
            for await (const h1Child of h1Children) {
              if (h1Child.tagName === 'H2') {
                h2 = h1Child;
                break;
              } else if (h2 === null) {
                contents += htmlFromEl(h1Child);
              }
            }
            item.contents = contents !== '' ? contents : getFallbackContent(type);
            items.push(item);
            if (h2) {
              let h2Order = 0;
              while (h2 !== null && h2.tagName === 'H2') {
                let item2 = new JSONOutlineSchemaItem();
                item2.title = h2.innerText.trim().replace('  ', ' ').replace('  ', ' ');
                item2.slug = item.slug + '/' + HAXCMS.cleanTitle(item2.title);
                item2.order = h2Order;
                h2Order += 1;
                item2.indent = 1;
                item2.parent = item.id;
                let tmp = await nextUntilElement(h2, ['H1', 'H2']);
                let h2Children = tmp.siblings;
                h2 = tmp.lastEl;
                let contents2 = '';
                for await (const h2Child of h2Children) {
                  contents2 += htmlFromEl(h2Child);
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
        let els = doc.querySelectorAll('h1');
        let order = 0;
        if (els.length === 0) {
          items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#docx-import-wrapper')), parentId));
        } else {
          for await (const h1 of els) {
            let item = new JSONOutlineSchemaItem();
            item.title = h1.innerText.trim().replace('  ', ' ').replace('  ', ' ');
            item.slug = HAXCMS.cleanTitle(item.title);
            item.order = order;
            item.parent = parentId;
            order += 1;
            let tmp = await nextUntilElement(h1, ['H1']);
            let h1Children = tmp.siblings;
            let contents = '';
            for await (const h1Child of h1Children) {
              contents += htmlFromEl(h1Child);
            }
            item.contents = contents !== '' ? contents : getFallbackContent(type);
            items.push(item);
          }
        }
        break;
      }
      case 'page':
      default: {
        items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#docx-import-wrapper')), parentId));
        break;
      }
    }

    return res.json({
      status: 200,
      data: {
        items: items,
        filename: filename,
      },
    });
  } catch (error) {
    console.error('docxToSite: Error processing file:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing DOCX import: ${error.message}`,
        items: [],
        filename: filename,
      },
    });
  }
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

module.exports = { importDocx };
