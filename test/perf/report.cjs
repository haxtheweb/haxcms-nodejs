"use strict";

// Markdown reports for perf runs: one table per run, and for `scale` runs a
// size x metric table with how each metric grows with page count.
//
// Growth is the slope of log(value) against log(pages) (least squares over
// every measured size): about 0 means flat, about 1 grows with page count,
// above 1 grows faster than page count. The 10,000 page column extends that
// line; it is a projection, not a measurement.
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const PROJECT_TO = 10000;
const NOT_MEASURED = ["visits", "runs"];
const SCORE_PATTERN = /Score$/;

function fmt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  if (Math.abs(value) >= 100) {
    return String(Math.round(value));
  }
  return String(Math.round(value * 10) / 10);
}

// points: [[pages, value], ...]. Null when there aren't two positive points.
function scalingExponent(points) {
  const usable = points.filter(function (p) {
    return p[0] > 0 && typeof p[1] === "number" && p[1] > 0;
  });
  if (usable.length < 2) {
    return null;
  }
  const xs = usable.map(function (p) {
    return Math.log(p[0]);
  });
  const ys = usable.map(function (p) {
    return Math.log(p[1]);
  });
  const n = xs.length;
  const mx =
    xs.reduce(function (a, b) {
      return a + b;
    }, 0) / n;
  const my =
    ys.reduce(function (a, b) {
      return a + b;
    }, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  if (den === 0) {
    return null;
  }
  return num / den;
}

function growthLabel(k) {
  if (k === null) {
    return "-";
  }
  if (k < -0.15) {
    return "falling";
  }
  if (k < 0.15) {
    return "flat";
  }
  if (k < 0.85) {
    return "sub-linear";
  }
  if (k <= 1.15) {
    return "linear";
  }
  return "super-linear";
}

// value at `target` pages if the fitted power law held
function project(points, k, target) {
  if (k === null) {
    return null;
  }
  const usable = points.filter(function (p) {
    return p[0] > 0 && typeof p[1] === "number" && p[1] > 0;
  });
  const last = usable[usable.length - 1];
  return last[1] * Math.pow(target / last[0], k);
}

function table(header, rows) {
  const lines = [];
  lines.push("| " + header.join(" | ") + " |");
  lines.push(
    "| " +
      header
        .map(function (h, i) {
          return i === 0 ? "---" : "---:";
        })
        .join(" | ") +
      " |",
  );
  rows.forEach(function (row) {
    lines.push("| " + row.join(" | ") + " |");
  });
  return lines.join("\n");
}

function metaLines(meta) {
  const m = meta || {};
  return [
    "- front end: " + (m.frontEnd || "unknown"),
    "- chrome: " + (m.chrome || "unknown") + ", node " + (m.node || "unknown"),
    "- profile: " +
      (m.profile || "-") +
      ", lighthouse scores: " +
      (m.lighthouse ? "yes" : "no"),
    "- started: " +
      (m.startedAt || "-") +
      ", took " +
      (m.durationS || 0) +
      " s",
  ];
}

// One table per scenario.
function formatResultsMarkdown(results) {
  const out = ["# HAXcms perf run", ""].concat(metaLines(results.meta), [""]);
  const scenarios = results.scenarios || {};
  Object.keys(scenarios).forEach(function (name) {
    const metrics = scenarios[name];
    out.push("## " + name, "");
    out.push(
      table(
        ["metric", "value"],
        Object.keys(metrics).map(function (key) {
          return [key, fmt(metrics[key])];
        }),
      ),
    );
    out.push("");
  });
  return out.join("\n");
}

// results.sizes: [100, 500, ...]; scenario keys end in ".perf<size>".
function scaleRows(results) {
  const sizes = results.sizes || [];
  const scenarios = results.scenarios || {};
  const byMetric = {};
  const order = [];
  Object.keys(scenarios).forEach(function (key) {
    const match = /^(.*)\.perf([0-9]+)$/.exec(key);
    if (!match) {
      return;
    }
    const base = match[1];
    const size = parseInt(match[2], 10);
    const metrics = scenarios[key];
    Object.keys(metrics).forEach(function (metric) {
      // run settings, not measurements
      if (
        typeof metrics[metric] !== "number" ||
        NOT_MEASURED.indexOf(metric) !== -1
      ) {
        return;
      }
      const id = base + "." + metric;
      if (!byMetric[id]) {
        byMetric[id] = {};
        order.push(id);
      }
      byMetric[id][size] = metrics[metric];
    });
  });
  return order.map(function (id) {
    const points = sizes.map(function (size) {
      return [
        size,
        Object.prototype.hasOwnProperty.call(byMetric[id], size)
          ? byMetric[id][size]
          : null,
      ];
    });
    // a 0-100 score falls as things get worse; fit what it loses instead
    // (100 - score), so "growth" reads the same way as every other row
    const isScore = SCORE_PATTERN.test(id);
    const fitted = isScore
      ? points.map(function (p) {
          return [p[0], typeof p[1] === "number" ? 100 - p[1] : null];
        })
      : points;
    const k = scalingExponent(fitted);
    let projected = project(fitted, k, PROJECT_TO);
    if (isScore && projected !== null) {
      projected = Math.max(0, 100 - projected);
    }
    return {
      metric: isScore ? id + " (fit on 100 - score)" : id,
      values: points.map(function (p) {
        return p[1];
      }),
      exponent: k,
      growth: growthLabel(k),
      projected: projected,
    };
  });
}

function formatScaleMarkdown(results) {
  const sizes = results.sizes || [];
  const rows = scaleRows(results);
  const out = ["# HAXcms scale run: " + sizes.join(", ") + " pages", ""].concat(
    metaLines(results.meta),
    [
      "",
      "Growth is the log-log slope across sizes: flat ~0, linear ~1, super-linear > 1.15.",
      "The " +
        PROJECT_TO.toLocaleString("en-US") +
        " page column extends that slope; it is a projection, not a measurement.",
      "",
    ],
  );
  const header = ["metric"]
    .concat(
      sizes.map(function (s) {
        return s + " pages";
      }),
    )
    .concat([
      "growth",
      "slope",
      "~" + PROJECT_TO.toLocaleString("en-US") + " (projected)",
    ]);
  out.push(
    table(
      header,
      rows.map(function (r) {
        return [r.metric]
          .concat(r.values.map(fmt))
          .concat([
            r.growth,
            r.exponent === null ? "-" : fmt(r.exponent),
            fmt(r.projected),
          ]);
      }),
    ),
  );
  const steep = rows.filter(function (r) {
    return r.growth === "super-linear";
  });
  out.push("");
  if (steep.length) {
    out.push("Super-linear (look here first):");
    steep.forEach(function (r) {
      out.push("- " + r.metric + " (slope " + fmt(r.exponent) + ")");
    });
  } else {
    out.push("Nothing grew faster than page count.");
  }
  out.push("");
  return out.join("\n");
}

module.exports = {
  formatResultsMarkdown,
  formatScaleMarkdown,
  growthLabel,
  project,
  scaleRows,
  scalingExponent,
};
