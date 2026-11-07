# Perf + memory harness

Repeatable front-end performance and memory checks for HAXcms sites, run
against a real server and system Chrome (the same setup as `test/e2e`).
Tracks: haxtheweb/issues#3245.

Lighthouse alone does not catch memory problems: a page can score well while
every visit leaves components, MobX reactions or observers behind. This
harness counts what stays reachable per visit, measures cold loads, and times
the outline designer, on seeded fixture sites of any size.

## Quick start

```bash
npm run perf:memory -- --short      # ~1.5 min: leaks per visit, reader + editor
npm run perf:lighthouse -- --short  # ~1 min: cold load on a throttled phone
npm run perf:check                  # ~10 min: everything, compared to budgets.json
npm run perf:scale -- --sizes 100,500,1000   # growth with page count
```

Each run writes `test/perf/results/<command>-<profile>.json` and a markdown
report next to it (`--out` / `--report` to choose). With no `--base-url`, the
harness boots an isolated server (temp `HAXCMS_ROOT`, ephemeral port, real
auth) and builds the fixture site in it, then throws it away.

## Commands

| command         | what it does                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `all` (default) | site + memory + lighthouse + outline on one fixture                                                |
| `memory`        | client-side navigation churn as a reader, then as an editor (edit mode every 5th visit), then idle |
| `lighthouse`    | cold loads, phone (4x CPU, slow 4G) and desktop, home and deep page                                |
| `outline`       | log in and open the outline designer (Site settings > Structure)                                   |
| `scale`         | site + reader memory + load + outline at each of `--sizes`, with a growth report                   |
| `site`          | only build the fixture (use with `--base-url` to keep it on a dev server)                          |

Options: `--short` (fewer visits, one load run), `--size <n>` (default 500),
`--sizes a,b,c`, `--check`, `--out`, `--report`, `--base-url`.

## Fixtures

`perf<N>` is a seeded course outline of exactly N pages: modules of 4 lessons
x 5 pages, page bodies built from the kinds of blocks real pages have
(headings, lists, collapses, self-checks, grid-plate, accent-card). Same N,
same site, so runs compare across machines. Sites are created through the API
(`createSite`, then bulk item creates of about 250 pages per request), so
10,000 pages works the same way as 500.

## What gets measured

Memory (`reader.<fixture>`, `editor.<fixture>`). GC is forced before every
sample; growth is over the measured visits after 10 warmup visits:

- `heapKBPerVisit`, `nodesPerVisit`, `listenersPerVisit`
- `reactionsPerVisit`: MobX reactions created and never disposed (a
  `Reaction.prototype.schedule_` hook records each one)
- `detachedObserved`: ResizeObserver / IntersectionObserver targets that left
  the document but are still observed (the observer keeps them alive)
- `i18nDeadEntries`: i18n-manager registrations whose element is gone
- `idleRequests`, `idleTimers`, `idleGrowthKB`: work done while nobody touches
  the tab
- `navMsMedian`: click to page content in the store; `navTimeouts` must be 0

Load (`mobile.deep.<fixture>` etc.), median of the runs, cold cache:
`lcpMs`, `fcpMs`, `blockingMs` (long tasks after FCP, minus 50 ms each),
`requests`, `transferKB`, `elements` (including shadow roots), `heapMB`.

Lighthouse is large, so it is not a dependency. When it can be loaded, load
scenarios also report `lighthouseScore`, `lighthouseLcpMs`, `lighthouseTbtMs`:

```bash
npm install --prefix /tmp/lh lighthouse@13
HAXCMS_PERF_LIGHTHOUSE_DIR=/tmp/lh npm run perf:lighthouse
```

Outline designer (`outline.<fixture>`): `outlineOpenMs` (click to rows on
screen and stable), `outlineRows`, `outlineHeapMB`, `outlineNodes`.

Site (`site.<fixture>`): `siteJsonKB`, `siteJsonGzipKB`, `siteJsonMs`,
`pageHtmlKB`, `pageHtmlMs` (what the server sends before any script runs).

## Budgets

`budgets.json` has a `full` and a `short` profile. A budget is a number (a
ceiling), `{ "max": n, "slack": s }` (a ceiling plus an absolute allowance,
for metrics that should sit near 0) or `{ "min": n }` (a floor, for scores).
Every limit is widened by `tolerance` (15%). A budgeted metric that is
missing from the run fails, so a scenario can't silently stop running.

The budgets are the measured values of `main` at the time they were set
(bundled front end 26.8.0). Counts (reactions, observed nodes, elements,
requests, bytes) carry little slack because they don't depend on the machine.
Timings (LCP, blocking time, navigation, outline open) carry wide slack because
CI runners are slower than a developer machine; if the nightly job's timings
sit far from these numbers, re-baseline the timing budgets from its artifact.
When a fix lands and its front end ships, lower them to the new numbers in the
same PR that updates the build, so the improvement can't quietly regress.

## Measuring a webcomponents branch

The harness measures whatever front end the server serves. To measure the
monorepo instead of the bundled build:

```bash
NODE_ENV=development HAXCMS_WEBCOMPONENTS_ROOT=../webcomponents \
  npm run perf:memory -- --short
```

Run it on the branch and on `main` and compare the two JSON files.

## Scale runs

`scale` reports each metric across sizes with its growth: the log-log slope
of value against page count (about 0 flat, about 1 linear, above 1.15
super-linear) and a projection to 10,000 pages along that slope. The
projection is a line, not a measurement; use it to rank where to look, then
run the size you care about. Super-linear metrics are listed at the end.

## When to run it

Run `npm run perf:memory -- --short` before a PR that touches
haxcms-elements core, the store, the site menu, i18n or a theme, and attach
the numbers if they moved. CI runs `perf:check` nightly against `main` and on
PRs labeled `perf`.
