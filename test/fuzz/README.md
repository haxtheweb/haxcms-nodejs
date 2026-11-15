# Outline designer fuzzer

Hundreds of seeded random edits in the real outline designer, inside the real
site editor, saved through the real save path and checked after every save.
Tracks: haxtheweb/issues#3252.

```bash
npm run fuzz:outline                                   # seeds 1-3, 200 edits each
npm run fuzz:outline -- --seeds 1-20 --ops 300         # longer
npm run fuzz:outline -- --size 1000 --save-every 50    # a big outline
npm run fuzz:outline -- --replay test/fuzz/results/outline-7.json
```

## What a session does

1. Builds a fresh copy of the seeded `perf<size>` outline (see `test/perf`) through the API.
2. Logs in, opens the site editor and the outline designer (Site settings > Structure).
3. Makes edits chosen by the seed, through the designer's own handlers:
   - Alt+Up/Down (move), Alt+Right/Left (indent/outdent)
   - add after (typing a name), add at top, rename (F2 + typing)
   - duplicate, lock/unlock
   - delete, delete a selection, undo
4. Every `--save-every` edits, saves the way the Save button does (`getData()` → `haxcms-save-outline` → `@site/updateSiteOutline`) and checks:
   - the save answered 200
   - the server stored exactly what the designer showed: every page expanded, rows in order, each with its parent, deleted pages left out
   - the stored outline is sound: unique ids and slugs, parents exist, no cycles, `indent` equals depth
   - every stored page has its file, and no existing page's contents changed (an outline save never edits page bodies)
   - the designer reloads the saved outline before the next edit

## Failures

- **Report:** a failing session writes `test/fuzz/results/outline-<seed>.json` with the error and the edits up to the failing save.
- **Shrinking:** unless you pass `--no-shrink`, it re-runs shorter edit lists (delta debugging, at most 40 replays) and adds the shortest list that still fails as `minimal`.
- **Replay:** `--replay` runs `minimal` (or every recorded edit) again from a fresh copy of the same outline. Edits are recorded by row position, so a replay repeats them exactly, including edits to pages created during the run.
- **Harness errors:** a broken page or a timeout is reported as a harness error and never treated as a reproduction while shrinking.

## Save equivalence (before changing how the designer renders)

A change to how the outline designer renders (virtualized rows, lighter rows) must not change a single byte of what it saves (haxtheweb/issues#3248). Record what each save sends on the current front end, then replay the same edits on the changed one:

```bash
# 1. on master (or the bundled build)
NODE_ENV=development HAXCMS_WEBCOMPONENTS_ROOT=../webcomponents \
  node test/fuzz/run.cjs --seeds 1-5 --size 1000 --ops 60 --save-every 20 \
  --record-saves /tmp/outline-saves.json
# 2. on the branch
NODE_ENV=development HAXCMS_WEBCOMPONENTS_ROOT=../webcomponents \
  node test/fuzz/run.cjs --compare-saves /tmp/outline-saves.json
```

`--compare-saves` replays the recorded edits exactly (size, seeds and save interval come from the recording) and fails on the first save, item and field that differ. Ids the outline did not start with (pages added or duplicated in the session, and the ids the server gives them) are renamed in order of first appearance, and `created`/`updated` timestamps are zeroed: those differ between any two runs. Everything else must match. The normal checks still run on every save. See `save-equivalence.cjs`.

## Other backends

`--base-url https://haxcms.ddev.site` (with `HAXCMS_PERF_PASSWORD`, and `HAXCMS_PERF_USERNAME` defaulting to admin) runs the same edits against any running backend, haxcms-php included. The page-file checks are skipped there because the site directory isn't known.

## In the e2e suite

`test/e2e/outline-fuzz.e2e.test.cjs` runs one 60-edit session and a self-test. The self-test reorders the payload behind the designer's back, to prove the checks catch a save that doesn't match what was shown.
