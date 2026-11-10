/**
 * Markdown summary of a Stryker mutation report, for the job summary of the
 * weekly mutation-testing workflow (and for reading a local run).
 *
 *   node scripts/mutation-summary.js [reports/mutation/mutation.json]
 *
 * Prints the mutation score, the count per mutant status and the surviving
 * mutants (file:line, mutator, replacement). A surviving mutant is a change
 * to the save-critical code that no test noticed: a gap in the tests.
 * Report-only: always exits 0, also when the report is missing.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_REPORT = path.join("reports", "mutation", "mutation.json");
const MAX_LISTED = 50;
const MAX_REPLACEMENT = 80;

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

function oneLine(text) {
  const flat = String(text === undefined || text === null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  const short =
    flat.length > MAX_REPLACEMENT
      ? flat.substring(0, MAX_REPLACEMENT) + "…"
      : flat;
  // keep the markdown table intact
  return short.replace(/\|/g, "\\|").replace(/`/g, "'");
}

function summarize(report) {
  const counts = {};
  const survivors = [];
  const files = report && report.files ? report.files : {};
  Object.keys(files)
    .sort()
    .forEach((fileName) => {
      const mutants = files[fileName].mutants || [];
      mutants.forEach((mutant) => {
        counts[mutant.status] = (counts[mutant.status] || 0) + 1;
        if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
          survivors.push({
            file: fileName,
            line:
              mutant.location && mutant.location.start
                ? mutant.location.start.line
                : 0,
            status: mutant.status,
            mutator: mutant.mutatorName,
            replacement: mutant.replacement,
          });
        }
      });
    });
  const count = (status) => counts[status] || 0;
  const detected = count("Killed") + count("Timeout");
  const undetected = count("Survived") + count("NoCoverage");
  const valid = detected + undetected;
  const covered = detected + count("Survived");
  return {
    counts: counts,
    survivors: survivors,
    score: valid ? (100 * detected) / valid : null,
    coveredScore: covered ? (100 * detected) / covered : null,
    total: Object.keys(counts).reduce((sum, key) => sum + counts[key], 0),
  };
}

function percent(value) {
  return value === null ? "n/a" : value.toFixed(2) + "%";
}

function render(file, report) {
  const lines = ["## Mutation testing (saveOutline write path)", ""];
  if (!report || report.error || !report.files) {
    lines.push(
      "No mutation report at `" +
        file +
        "`" +
        (report && report.error ? ": " + oneLine(report.error) : "") +
        ". Check the Stryker step log.",
    );
    return lines.join("\n") + "\n";
  }
  const s = summarize(report);
  lines.push("Report-only: this never fails the build.", "");
  lines.push("| | |", "|---|---|");
  lines.push("| Mutation score | **" + percent(s.score) + "** |");
  lines.push("| Score on covered code | " + percent(s.coveredScore) + " |");
  lines.push("| Mutants | " + s.total + " |");
  lines.push(
    "| Surviving (incl. no coverage) | **" + s.survivors.length + "** |",
  );
  Object.keys(s.counts)
    .sort()
    .forEach((status) => {
      lines.push("| " + status + " | " + s.counts[status] + " |");
    });
  lines.push("");
  if (s.survivors.length) {
    lines.push(
      "### Surviving mutants" +
        (s.survivors.length > MAX_LISTED
          ? " (first " + MAX_LISTED + "; all are in the HTML report artifact)"
          : ""),
      "",
      "| Where | Status | Mutator | Replaced with |",
      "|---|---|---|---|",
    );
    s.survivors.slice(0, MAX_LISTED).forEach((m) => {
      lines.push(
        "| `" +
          m.file +
          ":" +
          m.line +
          "` | " +
          m.status +
          " | " +
          oneLine(m.mutator) +
          " | `" +
          oneLine(m.replacement) +
          "` |",
      );
    });
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

if (require.main === module) {
  const file = process.argv[2] || DEFAULT_REPORT;
  process.stdout.write(render(file, readReport(file)));
}

module.exports = { summarize, render };
