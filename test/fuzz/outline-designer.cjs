"use strict";

// Outline designer fuzzer (haxtheweb/issues#3252).
//
// Drives the REAL outline designer inside the REAL site editor, against a
// REAL haxcms server, through hundreds of seeded random edits: move up/down,
// indent/outdent (the designer's own Alt+arrow keyboard handlers), add after,
// add at top, rename (F2 + typing), duplicate, lock/unlock, delete, delete a
// selection, undo. Every `saveEvery` edits it saves the way the Save button
// does (getData() -> haxcms-save-outline -> @site/updateSiteOutline), then
// checks:
//
//   1. the save answered 200
//   2. what the designer showed before saving ("title<parent title", in row
//      order, deleted pages left out) is exactly what the server stored
//   3. the stored outline is sound: unique ids and slugs, every parent
//      exists, no cycles, indent = depth
//   4. every stored page has its file on disk, and every page that was never
//      renamed into a duplicate keeps its original contents byte for byte
//   5. after the save the designer reloads the same number of pages
//
// Ops are recorded as { op, id, name } (ids, not row positions) so a failing
// run can be replayed and shrunk to a minimal list of edits.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining, no Math.random
// (seeded generator only).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { seededRandom } = require("../perf/fixture.cjs");
const { INSTALL_DEEP_QUERY } = require("../perf/outline.cjs");

const OPS = [
  // [name, weight]
  ["moveUp", 10],
  ["moveDown", 10],
  ["indent", 10],
  ["outdent", 10],
  ["addAfter", 7],
  ["addTop", 2],
  ["rename", 7],
  ["duplicate", 5],
  ["lock", 3],
  ["delete", 6],
  ["deleteSelection", 2],
  ["undo", 4],
];

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function pickWeighted(rand, list) {
  let total = 0;
  list.forEach(function (entry) {
    total += entry[1];
  });
  let roll = rand() * total;
  for (let i = 0; i < list.length; i++) {
    roll -= list[i][1];
    if (roll < 0) {
      return list[i][0];
    }
  }
  return list[list.length - 1][0];
}

// helpers installed in the page once per load; they find the designer
// wherever the admin shell put it
const INSTALL_DESIGNER_HELPERS = function () {
  globalThis.__fz = {
    el: function () {
      return globalThis.__perfDeepQuery("outline-designer");
    },
    settle: async function (ms) {
      const el = globalThis.__fz.el();
      if (!el) {
        return;
      }
      await el.updateComplete;
      await new Promise(function (r) {
        setTimeout(r, ms || 120);
      });
      await el.updateComplete;
    },
    li: function (id) {
      const el = globalThis.__fz.el();
      return el.shadowRoot.querySelector('li[data-item-id="' + id + '"]');
    },
    idx: function (id) {
      return globalThis.__fz.el().items.findIndex(function (i) {
        return i.id === id;
      });
    },
    key: function (id, k, opts) {
      const row = globalThis.__fz.li(id);
      if (!row) {
        return false;
      }
      row.dispatchEvent(
        new KeyboardEvent(
          "keydown",
          Object.assign(
            { key: k, bubbles: true, cancelable: true },
            opts || {},
          ),
        ),
      );
      return true;
    },
    // ids of rows on screen that are not deleted (collapsed children and
    // deleted pages can't be acted on)
    rows: function () {
      const el = globalThis.__fz.el();
      const byId = {};
      el.items.forEach(function (i) {
        byId[i.id] = i;
      });
      return Array.from(el.shadowRoot.querySelectorAll("li[data-item-id]"))
        .map(function (r) {
          return r.getAttribute("data-item-id");
        })
        .filter(function (id) {
          return byId[id] && !byId[id].delete;
        });
    },
    capture: async function () {
      const el = globalThis.__fz.el();
      // folded pages hide their sub-pages' rows; open everything so "shown"
      // is the whole outline
      el.expandAll();
      await globalThis.__fz.settle(200);
      // big outlines render rows in batches: wait until every visible page
      // has its row
      const deadline = Date.now() + 20000;
      while (
        el.shadowRoot.querySelectorAll("li[data-item-id]").length <
          el._visibleItems().length &&
        Date.now() < deadline
      ) {
        await new Promise(function (r) {
          setTimeout(r, 100);
        });
      }
      await el.updateComplete;
      const data = await el.getData();
      const sent = JSON.parse(JSON.stringify(data.items));
      const byId = {};
      sent.forEach(function (i) {
        byId[i.id] = i;
      });
      const shown = Array.from(
        el.shadowRoot.querySelectorAll("li[data-item-id]"),
      )
        .map(function (r) {
          return r.getAttribute("data-item-id");
        })
        .filter(function (id) {
          return byId[id] && !byId[id].delete;
        })
        .map(function (id) {
          const parent = byId[id].parent && byId[byId[id].parent];
          return byId[id].title + "<" + (parent ? parent.title : "root");
        });
      return { sent: sent, shown: shown };
    },
  };
};

async function openDesigner(page) {
  await page.evaluate(INSTALL_DEEP_QUERY);
  await page.evaluate(INSTALL_DESIGNER_HELPERS);
  await page.waitForFunction(
    function () {
      return globalThis.__perfDeepQuery("haxcms-site-editor-ui") !== null;
    },
    { timeout: 60000, polling: 100 },
  );
  await page.evaluate(function () {
    globalThis
      .__perfDeepQuery("haxcms-site-editor-ui")
      ._outlineButtonTap(null, false, null, {});
  });
  await page.waitForFunction(
    function () {
      const el = globalThis.__perfDeepQuery("outline-designer");
      return (
        !!el &&
        !!el.shadowRoot &&
        el.items &&
        el.items.length > 0 &&
        el.shadowRoot.querySelectorAll("li[data-item-id]").length > 0
      );
    },
    { timeout: 120000, polling: 150 },
  );
  await page.evaluate(function () {
    // no animations to wait out between edits
    globalThis.__fz.el().setAttribute("reduced-motion", "reduce");
  });
  await page.evaluate(function () {
    return globalThis.__fz.settle(300);
  });
}

// choose the next edit from what is on screen now. Targets are recorded as
// row positions (plus the id, for reading), so replaying the same list from
// the same starting outline repeats the same edits exactly, even for pages
// created during the run, whose ids are random.
async function chooseOp(page, rand, counter) {
  const rows = await page.evaluate(function () {
    return globalThis.__fz.rows();
  });
  if (rows.length === 0) {
    return { op: "addTop", name: "Fuzz page " + counter };
  }
  const op = pickWeighted(rand, OPS);
  const row = Math.floor(rand() * rows.length);
  const step = { op: op, row: row, id: rows[row] };
  if (op === "deleteSelection") {
    step.row2 = Math.floor(rand() * rows.length);
  }
  if (op === "addAfter" || op === "addTop" || op === "rename") {
    step.name = "Fuzz page " + counter;
  }
  return step;
}

// perform one recorded edit; returns false when it could not apply (target
// gone in a shrunk replay), which is not a failure
async function applyOp(page, step) {
  const ok = await page.evaluate(async function (step) {
    const fz = globalThis.__fz;
    const el = fz.el();
    // resolve the recorded row to the page on that row now
    const rows = fz.rows();
    if (typeof step.row === "number") {
      if (step.row >= rows.length) {
        return false;
      }
      step.id = rows[step.row];
      step.ids = [step.id];
      if (
        typeof step.row2 === "number" &&
        step.row2 < rows.length &&
        step.row2 !== step.row
      ) {
        step.ids.push(rows[step.row2]);
      }
    }
    const has = function (id) {
      return fz.idx(id) !== -1 && !!fz.li(id);
    };
    switch (step.op) {
      case "moveUp":
        return has(step.id) && fz.key(step.id, "ArrowUp", { altKey: true });
      case "moveDown":
        return has(step.id) && fz.key(step.id, "ArrowDown", { altKey: true });
      case "indent":
        return has(step.id) && fz.key(step.id, "ArrowRight", { altKey: true });
      case "outdent":
        return has(step.id) && fz.key(step.id, "ArrowLeft", { altKey: true });
      case "addAfter":
        if (!has(step.id)) {
          return false;
        }
        await el._addAfterAndEdit(fz.idx(step.id));
        return "type";
      case "addTop":
        await el._addTop();
        return true;
      case "rename":
        return has(step.id) && fz.key(step.id, "F2") ? "type" : false;
      case "duplicate":
        if (!has(step.id)) {
          return false;
        }
        el.itemOp(fz.idx(step.id), "duplicate");
        return true;
      case "lock":
        if (!has(step.id)) {
          return false;
        }
        el.itemOp(fz.idx(step.id), "lock");
        return true;
      case "delete":
        if (!has(step.id)) {
          return false;
        }
        await el._toggleDelete(fz.idx(step.id));
        return true;
      case "deleteSelection": {
        const ids = step.ids.filter(has);
        if (ids.length === 0) {
          return false;
        }
        el.selectedPages = ids;
        await el.updateComplete;
        el.deleteSelected();
        return true;
      }
      case "undo":
        el.undo();
        return true;
      default:
        return false;
    }
  }, step);
  if (ok === "type") {
    // the designer put a label into edit mode: type a name like a person
    await wait(150);
    const editing = await page.evaluate(function () {
      const el = globalThis.__fz.el();
      const active = el.shadowRoot.activeElement;
      return !!active && active.isContentEditable === true;
    });
    if (editing) {
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.type(step.name);
      await page.keyboard.press("Enter");
    }
  }
  await page.evaluate(
    function (ms) {
      return globalThis.__fz.settle(ms);
    },
    step.op === "delete" || step.op === "deleteSelection" ? 300 : 120,
  );
  return ok !== false;
}

// ---- server-side checks ----------------------------------------------------

function storedTree(items) {
  const titleOf = function (id) {
    const found = items.find(function (i) {
      return i.id === id;
    });
    return found ? found.title : "root";
  };
  const out = [];
  const walk = function (parent) {
    items
      .map(function (item, position) {
        return { item: item, position: position };
      })
      .filter(function (x) {
        return (x.item.parent || null) === parent;
      })
      .sort(function (a, b) {
        return (
          parseInt(a.item.order, 10) - parseInt(b.item.order, 10) ||
          a.position - b.position
        );
      })
      .forEach(function (x) {
        out.push(x.item.title + "<" + titleOf(x.item.parent));
        walk(x.item.id);
      });
  };
  walk(null);
  return out;
}

function outlineProblems(items, siteDirectory) {
  const problems = [];
  const byId = {};
  const slugs = {};
  items.forEach(function (item) {
    if (byId[item.id]) {
      problems.push("duplicate id " + item.id);
    }
    byId[item.id] = item;
    if (item.slug) {
      if (slugs[item.slug]) {
        problems.push("duplicate slug " + item.slug);
      }
      slugs[item.slug] = true;
    }
  });
  items.forEach(function (item) {
    if (item.parent && !byId[item.parent]) {
      problems.push(item.id + " has missing parent " + item.parent);
    }
    // walk to the root: catches cycles and checks indent = depth
    let depth = 0;
    let cursor = item;
    const seen = {};
    while (cursor && cursor.parent) {
      if (seen[cursor.id]) {
        problems.push("cycle through " + item.id);
        break;
      }
      seen[cursor.id] = true;
      cursor = byId[cursor.parent];
      depth++;
    }
    if (parseInt(item.indent, 10) !== depth) {
      problems.push(item.id + " indent " + item.indent + " but depth " + depth);
    }
    if (siteDirectory && item.location) {
      const file = path.join(siteDirectory, item.location);
      if (!fs.existsSync(file)) {
        problems.push(item.id + " has no page file " + item.location);
      }
    }
  });
  return problems;
}

function hashFile(file) {
  try {
    return crypto
      .createHash("sha1")
      .update(fs.readFileSync(file))
      .digest("hex");
  } catch (e) {
    return null;
  }
}

/**
 * One fuzz session.
 * @param {object} browser puppeteer browser
 * @param {object} opts {
 *   baseUrl, site, credentials, siteDirectory (optional, for file checks),
 *   seed, ops, saveEvery, steps (replay this exact list instead of choosing),
 *   tamperPayload (self-test only: rewrite the items before they are sent),
 *   beforeSave (diagnostics: async (page, { sent, shown }, saveNumber))
 * }
 * @returns {object} { ok, steps, saves, applied, failure, at }
 */
async function runOutlineFuzz(browser, opts) {
  const rand = seededRandom(opts.seed);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const steps = [];
  let saves = 0;
  let applied = 0;
  const statuses = [];
  page.on("response", function (response) {
    if (
      /\/x\/api\/v1\/site\/outline/.test(response.url()) &&
      response.request().method() !== "OPTIONS"
    ) {
      statuses.push(response.status());
    }
  });
  const fail = function (message, at) {
    return {
      ok: false,
      steps: steps,
      saves: saves,
      applied: applied,
      failure: message,
      at: at,
    };
  };
  try {
    await page.setViewport({ width: 1400, height: 1000 });
    const url = opts.baseUrl + "/_sites/" + opts.site + "/";
    await page.goto(url, { waitUntil: "networkidle0", timeout: 180000 });
    const status = await page.evaluate(
      async function (u, p, s) {
        const r = await fetch("/system/api/v1/session/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: u, password: p, site: { name: s } }),
        });
        return r.status;
      },
      opts.credentials.username,
      opts.credentials.password,
      opts.site,
    );
    if (status !== 200) {
      return fail("login failed: " + status, 0);
    }
    await page.goto(url, { waitUntil: "networkidle0", timeout: 180000 });
    await openDesigner(page);
    // original page contents, to prove saves never touch pages they shouldn't
    const original = {};
    if (opts.siteDirectory) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(opts.siteDirectory, "site.json"), "utf8"),
      );
      manifest.items.forEach(function (item) {
        original[item.id] = hashFile(
          path.join(opts.siteDirectory, item.location),
        );
      });
    }
    const total = opts.steps ? opts.steps.length : opts.ops;
    for (let i = 0; i < total; i++) {
      const step = opts.steps
        ? opts.steps[i]
        : await chooseOp(page, rand, i + 1);
      steps.push(step);
      if (await applyOp(page, step)) {
        applied++;
      }
      const last = i === total - 1;
      if ((i + 1) % opts.saveEvery !== 0 && !last) {
        continue;
      }
      // ---- save, the way the Save button does, then check ----
      const before = await page.evaluate(function () {
        return globalThis.__fz.capture();
      });
      if (opts.beforeSave) {
        // diagnostics hook: look at the page right before a save
        await opts.beforeSave(page, before, saves + 1);
      }
      const statusCount = statuses.length;
      // self-test hook: a test can corrupt what gets sent to prove the
      // checks catch a save that doesn't match what the designer showed
      const payload = opts.tamperPayload
        ? opts.tamperPayload(JSON.parse(JSON.stringify(before.sent)))
        : before.sent;
      await page.evaluate(function (items) {
        globalThis.dispatchEvent(
          new CustomEvent("haxcms-save-outline", {
            bubbles: true,
            composed: true,
            detail: items,
          }),
        );
      }, payload);
      const deadline = Date.now() + 120000;
      while (statuses.length === statusCount && Date.now() < deadline) {
        await wait(100);
      }
      saves++;
      const saveStatus = statuses[statuses.length - 1];
      if (saveStatus !== 200) {
        return fail("save answered " + saveStatus, i + 1);
      }
      const stored = await page.evaluate(async function () {
        const r = await fetch("site.json?fuzz=" + Date.now(), {
          credentials: "include",
        });
        return (await r.json()).items;
      });
      const tree = storedTree(stored);
      if (JSON.stringify(tree) !== JSON.stringify(before.shown)) {
        let first = 0;
        while (first < tree.length && tree[first] === before.shown[first]) {
          first++;
        }
        // which rows only one side has, and what the designer sent for them
        const count = function (list) {
          const m = {};
          list.forEach(function (row) {
            m[row] = (m[row] || 0) + 1;
          });
          return m;
        };
        const storedCount = count(tree);
        const shownCount = count(before.shown);
        const onlyStored = Object.keys(storedCount).filter(function (row) {
          return storedCount[row] > (shownCount[row] || 0);
        });
        const onlyShown = Object.keys(shownCount).filter(function (row) {
          return shownCount[row] > (storedCount[row] || 0);
        });
        const sentFor = function (row) {
          const title = row.split("<")[0];
          return before.sent
            .filter(function (item) {
              return item.title === title;
            })
            .map(function (item) {
              const parent = before.sent.find(function (p) {
                return p.id === item.parent;
              });
              return {
                id: item.id,
                parent: item.parent,
                parentDeleted: !!(parent && parent.delete),
                delete: !!item.delete,
                order: item.order,
                indent: item.indent,
              };
            });
        };
        const detail = {
          onlyStored: onlyStored.slice(0, 5).map(function (row) {
            return { row: row, sent: sentFor(row) };
          }),
          onlyShown: onlyShown.slice(0, 5),
        };
        return fail(
          "stored outline differs from what the designer showed, first at row " +
            first +
            ": stored " +
            JSON.stringify(tree.slice(first, first + 3)) +
            " vs shown " +
            JSON.stringify(before.shown.slice(first, first + 3)) +
            " (" +
            tree.length +
            " stored, " +
            before.shown.length +
            " shown); " +
            JSON.stringify(detail),
          i + 1,
        );
      }
      const problems = outlineProblems(stored, opts.siteDirectory);
      if (problems.length) {
        return fail(
          "unsound outline: " + problems.slice(0, 5).join("; "),
          i + 1,
        );
      }
      if (opts.siteDirectory) {
        const changed = stored.filter(function (item) {
          return (
            Object.prototype.hasOwnProperty.call(original, item.id) &&
            hashFile(path.join(opts.siteDirectory, item.location)) !==
              original[item.id]
          );
        });
        if (changed.length) {
          return fail(
            "page contents changed by an outline save: " +
              changed
                .slice(0, 3)
                .map(function (c) {
                  return c.id;
                })
                .join(", "),
            i + 1,
          );
        }
      }
      // the designer reloads from the saved manifest before the next edit
      const reloaded = await page
        .waitForFunction(
          function (ids) {
            // reloaded = holds exactly the server's pages, by id (a count
            // alone can match before the reload lands)
            const el = globalThis.__perfDeepQuery("outline-designer");
            if (!el || !el.items || el.items.length !== ids.length) {
              return false;
            }
            const mine = el.items
              .map(function (i) {
                return i.id;
              })
              .sort();
            return mine.every(function (id, n) {
              return id === ids[n];
            });
          },
          { timeout: 30000, polling: 150 },
          stored
            .map(function (item) {
              return item.id;
            })
            .sort(),
        )
        .then(function () {
          return true;
        })
        .catch(function () {
          return false;
        });
      if (!reloaded) {
        const count = await page.evaluate(function () {
          const el = globalThis.__perfDeepQuery("outline-designer");
          return el && el.items ? el.items.length : -1;
        });
        return fail(
          "designer did not reload the saved outline (" +
            count +
            " items, server has " +
            stored.length +
            ")",
          i + 1,
        );
      }
      await page.evaluate(function () {
        return globalThis.__fz.settle(300);
      });
      // ...with the server's ids: a page still under the id the designer
      // made up for it would be created again by the next save
      const unknown = await page.evaluate(
        function (ids) {
          return globalThis.__fz
            .el()
            .items.map(function (i) {
              return i.id;
            })
            .filter(function (id) {
              return ids.indexOf(id) === -1;
            });
        },
        stored.map(function (item) {
          return item.id;
        }),
      );
      if (unknown.length) {
        return fail(
          "after the save the designer still holds " +
            unknown.length +
            " page id(s) the server does not have (" +
            unknown.slice(0, 3).join(", ") +
            "); the next save would create those pages again",
          i + 1,
        );
      }
    }
    return {
      ok: true,
      steps: steps,
      saves: saves,
      applied: applied,
      failure: null,
      at: null,
    };
  } catch (err) {
    // the harness itself broke (page closed, timeout): reported, but never
    // mistaken for the bug being shrunk
    const result = fail(
      "harness error: " + (err && err.message ? err.message : err),
      steps.length,
    );
    result.harnessError = true;
    return result;
  } finally {
    await context.close();
  }
}

module.exports = {
  OPS,
  outlineProblems,
  pickWeighted,
  runOutlineFuzz,
  storedTree,
};
