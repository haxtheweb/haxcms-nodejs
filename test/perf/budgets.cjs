"use strict";

// Compare a perf run against committed budgets.
//
// budgets.json holds one budget set per run profile ("full", "short"):
//   { "tolerance": 0.15, "full": { "<scenario>.<metric>": <budget> }, ... }
//
// A budget is either
//   - a number: the metric's ceiling (lower is better), or
//   - { "max": n, "slack": s }: ceiling plus an absolute allowance, for
//     metrics whose healthy value is near 0 (a percentage of 0 is 0), or
//   - { "min": n, "slack": s }: a floor (higher is better), e.g. a score.
// The tolerance (default 15%) widens every limit, because medians still move
// run to run. A budgeted metric missing from the results fails too, so a
// scenario that silently stopped running can't pass.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

function flatten(results) {
  const flat = {};
  const scenarios = (results && results.scenarios) || {};
  Object.keys(scenarios).forEach(function (scenario) {
    const metrics = scenarios[scenario] || {};
    Object.keys(metrics).forEach(function (metric) {
      if (typeof metrics[metric] === "number") {
        flat[scenario + "." + metric] = metrics[metric];
      }
    });
  });
  return flat;
}

function normalizeBudget(budget) {
  if (typeof budget === "number") {
    return { kind: "max", value: budget, slack: 0 };
  }
  if (budget && typeof budget === "object") {
    const slack = typeof budget.slack === "number" ? budget.slack : 0;
    if (typeof budget.min === "number") {
      return { kind: "min", value: budget.min, slack: slack };
    }
    if (typeof budget.max === "number") {
      return { kind: "max", value: budget.max, slack: slack };
    }
  }
  throw new Error("invalid budget: " + JSON.stringify(budget));
}

function limitFor(budget, tolerance) {
  if (budget.kind === "min") {
    return budget.value * (1 - tolerance) - budget.slack;
  }
  return budget.value * (1 + tolerance) + budget.slack;
}

/**
 * @param {object} results { scenarios: { name: { metric: number } } }
 * @param {object} budgets { tolerance, metrics: { "scenario.metric": budget } }
 */
function compareToBudgets(results, budgets) {
  const tolerance =
    budgets && typeof budgets.tolerance === "number" ? budgets.tolerance : 0.15;
  const limits = (budgets && budgets.metrics) || {};
  const flat = flatten(results);
  const rows = Object.keys(limits)
    .sort()
    .map(function (key) {
      const budget = normalizeBudget(limits[key]);
      const allowed = limitFor(budget, tolerance);
      const row = {
        key: key,
        kind: budget.kind,
        budget: budget.value,
        allowed: allowed,
        value: null,
        status: "missing",
      };
      if (!Object.prototype.hasOwnProperty.call(flat, key)) {
        return row;
      }
      row.value = flat[key];
      const broken =
        budget.kind === "min" ? row.value < allowed : row.value > allowed;
      row.status = broken ? (budget.kind === "min" ? "under" : "over") : "ok";
      return row;
    });
  const failed = rows.filter(function (r) {
    return r.status !== "ok";
  });
  return {
    tolerance: tolerance,
    rows: rows,
    failed: failed,
    pass: failed.length === 0,
  };
}

// Pick a profile's budgets out of budgets.json.
function budgetsForProfile(file, profile) {
  const metrics = file && file[profile];
  if (!metrics || typeof metrics !== "object") {
    throw new Error('budgets.json has no "' + profile + '" profile');
  }
  return { tolerance: file.tolerance, metrics: metrics };
}

// Which command produces a budget key's scenario.
function commandForKey(key) {
  if (/^(reader|editor)\./.test(key)) {
    return "memory";
  }
  if (/^outline\./.test(key)) {
    return "outline";
  }
  if (/^site\./.test(key)) {
    return "all";
  }
  return "lighthouse";
}

// Only judge what this run produced: the command's scenarios, on the fixture
// it used. Lighthouse score budgets apply only when lighthouse was installed.
function selectBudgets(metrics, command, haveLighthouse, fixture) {
  const selected = {};
  Object.keys(metrics).forEach(function (key) {
    const owner = commandForKey(key);
    if (command !== "all" && owner !== command) {
      return;
    }
    const scenario = key.slice(0, key.lastIndexOf("."));
    if (fixture && !scenario.endsWith("." + fixture)) {
      return;
    }
    const metric = key.slice(key.lastIndexOf(".") + 1);
    if (!haveLighthouse && metric.indexOf("lighthouse") === 0) {
      return;
    }
    selected[key] = metrics[key];
  });
  return selected;
}

function fmt(n) {
  return String(Math.round(n * 100) / 100);
}

function formatReport(report) {
  const lines = [];
  lines.push(
    "perf budgets (tolerance " + Math.round(report.tolerance * 100) + "%)",
  );
  report.rows.forEach(function (r) {
    const value = r.value === null ? "missing" : fmt(r.value);
    let mark = "  ok  ";
    if (r.status === "over") {
      mark = " OVER ";
    } else if (r.status === "under") {
      mark = "UNDER ";
    } else if (r.status === "missing") {
      mark = " MISS ";
    }
    const bound = r.kind === "min" ? "floor " : "budget ";
    lines.push(
      "[" +
        mark +
        "] " +
        r.key +
        ": " +
        value +
        " (" +
        bound +
        r.budget +
        ", allowed " +
        fmt(r.allowed) +
        ")",
    );
  });
  lines.push(
    report.pass
      ? "perf budgets PASSED"
      : "perf budgets FAILED: " + report.failed.length + " metric(s)",
  );
  return lines.join("\n");
}

// per-visit growth between the first and last sample of a series
function perVisit(first, last, visits) {
  if (!visits || visits <= 0) {
    return 0;
  }
  return Math.max(0, (last - first) / visits);
}

function median(values) {
  const sorted = values
    .filter(function (v) {
      return typeof v === "number" && !Number.isNaN(v);
    })
    .slice()
    .sort(function (a, b) {
      return a - b;
    });
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = {
  budgetsForProfile,
  compareToBudgets,
  flatten,
  formatReport,
  median,
  normalizeBudget,
  perVisit,
  selectBudgets,
};
