# Plan: use the other computers first, and this Mac last

## Status

On main: yes (this landing commit)
Active. Built and committed: Stages 1 to 4 and 6.1 to 6.5; Stage 5 except 5.3; Stage 2 (its boxes were only unticked, and are verified wired this round: `npm run checks` ran all 7 on the test Mac, passing, and the hooks and the queue use `checks.js`). This round: 5.3 (a "Set up for tests and checks" guide on each paired computer without a test machine; specs, type checks, lint and builds pass) and 7.2 (the detailed plan, [2026-11-11-agent-sessions-on-other-computers_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-11-agent-sessions-on-other-computers_plan.md)). Still open, all recorded in [the livetest doc](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-07-computers-remote-first_livetest.md): 6.6 (edits Undistilled, another repository), 7.1 (James signs in), keyboard and real-data checks. Not pushed. Evidence: the history file.

**Spec:** [2026-11-07-computers-remote-first_spec_completed.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/specs/2026-11-07-computers-remote-first_spec_completed.md)
**Builds on:** [2026-11-06-offload-heavy-work_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-06-offload-heavy-work_plan.md) (the test machine, its scripts and its run log).

## James's decisions (7 November 2026, confirmed in his review on 8 November)

1. **Sign the AI tools in on the PC: yes, and plan it now.** Stage 7's detailed plan is written without waiting for a week of
   Stage 1's record; that record still informs it. The sign-in itself is James's to do, once per tool.
2. **Add the test Mac: yes, Mac-only tests, on straight away** (not paused).
3. **The spec: approved, every section.**

## How it fits together

- **Two ways to reach a computer, one list.** Today the Windows PC is reached twice: as a paired helper (Windows, for
  browser, Android and sessions) and as the test machine (the Linux space on the same PC, over SSH, for tests). The list shows
  one "Windows PC" with both. The test machine's settings name the paired helper they belong to, which is how the two join up.
- **The scripts keep working with Harness closed.** Commits, pushes and agents' own runs don't go through Harness. So the
  test-machine settings file (`~/.ai-orchestrator/remote-checks/config.json`) is the one record of the test machine's choices:
  the scripts read it, and the Computers page reads and writes it. Choices for paired computers, and the order, are a Harness
  setting. (Changed from "Harness writes the file from a setting" on 7 November: one record can't drift, and needs no sync.)
- **Order decides, then room, then load.** For anything that can go elsewhere: walk the list in order and take the first
  computer that takes this kind of work, isn't paused, has room and can be reached. This Mac is the last entry. Falling to the
  Mac always says why.

## Stages

Each stage lands on its own, with its own tests, a fresh review and the project gates. Order matters: 1 gives the numbers
the others are judged by.

### Stage 1 — Record every run

- [x] 1.1 `scripts/run-tests-quiet.js` logs every run to `runs.jsonl`, not only routed ones: small targeted runs get
  `kind: "local"` and `ranOn: "mac"`, with the number of spec files (it covers any run that never tries the PC, not
  only small ones). Queue health leaves these lines out, so they can't clear its "can't be reached" notice. Logging never fails a run (as `appendRunLog` already
  promises).
- [x] 1.2 The checks route (Stage 2) logs `kind: "checks"` with each check's name, result and time.
- [x] 1.3 A short report, `npm run report:where-work-ran -- --since <date>`, gives per day: runs and minutes by kind and
  computer, and fall-back reasons. Stage 3 and Stage 7 are decided from it.
- **Checks:** spec for the small-run line, and that a logging fault can't fail a run.
- **As built (7 November):** `report.js` and `npm run report:where-work-ran`; the local line is `kind: "local"` with
  `specFiles`; Queue health ignores it. Independent review passed. Its one note, that the log grows for ever, is 4.5.

### Stage 2 — Send the other checks to the PC

- [x] 2.1 **The PC side.** `remote-run.sh` gets a checks job beside the test job, in the same slots, store and install: it
  takes a list of check names, runs each in turn in the snapshot, and writes one result line with every check's exit code,
  time and a 2 KB output tail. Only names on a fixed list run, each mapped to its real command, so the Mac can't send an
  arbitrary command line.
- [x] 2.2 **The Mac side.** `scripts/remote-checks/checks.js [--set default|push | command...]` (built under this name; the plan first called it `run-checks.js`): one snapshot (the same `snapshot.js`), one
  trip, results printed check by check in the same words the commands print locally, then `Ran on <label> in ...`. If the PC
  is away, full or fails to set up, it runs the same checks here and says why. Exit code: the first failing check's, as a
  plain local run would give.
- [x] 2.3 **One command for agents:** `npm run checks` runs the project checklist this way (both type checks, lint,
  `check:ts-max-loc`, `check:ui-hints`, both builds). `AGENTS.md`'s checklist names it, and the separate commands still work
  on their own, on this Mac.
- [x] 2.4 **The Plan Queue.** `PlanQueueGateRunner.executeCommands` sends the checks it recognises as one batch through
  `run-checks.js` and still makes one receipt per command, each with `ranOn`. Commands it doesn't recognise run as now. The
  base comparison keeps its rule that both sides run on the same computer.
- [x] 2.5 **Commit and push hooks:** the pre-push checks use the same route. The commit hook's fast checks stay here.
- **Stays here:** packaging, `rebuild:native`, `smoke:electron`, anything needing macOS.
- **As built (7 November):** `scripts/remote-checks/checks.js` holds the list (9 commands) and two named sets, `default` and
  `push`, so the hook passes no commands with spaces through a shell. The far side's `known_check` and the Plan Queue's
  `BATCHED_CHECKS` hold the same list, and a spec compares all three. The queue batches only in a worktree that has
  `checks.js`, so jobs on older branches run as before. Real runs: all 7 default checks on the PC in 2m 31s, passing; an
  earlier one fell back here because every slot was busy, said so, and logged it. That run also caught a real type error
  in a new spec, which the main type check doesn't see.
- **Review fixes:** the queue announced a checklist run twice when the batch's answer was unusable; a run with no test
  machine set up said "the Mac", which stopped the queue reusing its comparison runs on main. Both fixed, with specs.
  Results now print as each check finishes when they run here.
- **Known change:** lint and build receipts now carry where they ran, so the queue's rule that a failure is compared with
  main on the same computer covers them as it covers the tests.
- **Checks:** specs for the name list (an unknown name is refused on both sides), per-check results, fall-back with the reason,
  and the queue's receipts; a Linux spec runs the real checks job against a stub project, as the Stage 5 work did; a real run
  of `npm run checks` on the PC and one forced to this Mac.

### Stage 3 — Lower the bar for test runs

- [x] 3.1 Measure, from Stage 1's record plus timed runs: the fixed cost of a PC run (snapshot, connection, install check) and
  the same 1, 5, 10, 20 and 50-file runs here, busy and quiet.
- [x] 3.2 Set the bar where the PC is no slower overall, in `route.js` (`LARGE_TARGETED_SPECS` today) and the commit route.
- **Checks:** existing route specs updated to the new number; the measurements written up here.
- **Result (7 November, 15:45 to 16:05, Mac load 7 to 20 on 18 cores):** the same seeded random lists of spec files.

  | Spec files | This Mac | The PC |
  |---|---|---|
  | 1 | 2 s | 91 s |
  | 5 | 6 s | 133 s |
  | 10 | 6.5 s | 104 s, after 168 s waiting for a slot |
  | 20 | 9 s | 109 s |
  | 50 | 41 s | 155 s |

  The PC costs about 1½ minutes before a test starts: the snapshot, the install check and building `dist`, which a few
  specs need and which therefore runs every time. **The bar stays at 50.** Below it the PC is slower by a minute or more,
  and the Mac would save a few seconds per run. Halving the fixed cost wouldn't change that, and skipping `dist` for some
  runs would mean guessing which specs read it (about 20 mention it). Revisit only if the Mac gets busy enough that short
  runs there take minutes, which Stage 1's record will show.
- **Found while measuring, and fixed:** since the upgrade to Vitest 5, a run mixing main and renderer specs on a busy Mac
  could stop in 2 s with "different 'maxWorkers'". The config is read once per project and each read sampled the load
  again. `vitest.pool.ts` now keeps the first count for the process.

### Stage 4 — One list of computers, behind the scenes

- [x] 4.1 **A setting for the paired computers:** order, and per computer: paused and agent sessions on or off. This Mac
  is always last. Browser and Android keep their existing switches (one paired computer has them today), shown on the
  computer that has them. Types in `src/shared/types/settings.types.ts`, defaults, the agent write policy, export.
- [x] 4.2 **The test machine's choices live in its file:** `paused`, `testRuns` and `checks` (on unless turned off),
  `slots` (1 to 8, 3 by default) and `nodeName`, the paired computer it belongs to. `route.js` and `checks.js` keep work here,
  saying why, when it's paused or that kind is off; Queue health counts those as chosen, not as falling back. `remote-run.sh`
  takes the slot count. Harness reads and writes the file atomically, keeping fields it doesn't own.
- [x] 4.3 **Choosing a computer for sessions** (`worker-node-registry.ts`) also respects the order, paused, and the kinds-of-work
  switches, and uses the load each computer reports, not only memory and free slots. The capability reporter sends a load
  reading.
- [x] 4.5 **Keep the run log small.** Every small run is now a line (Stage 1), and Queue health and the page read the whole file each
  time. Start a new file once it passes about 1 MB, keeping the last one for the report.
- [x] 4.4 **The two faults:** remove the unused GPU setting (stored values are ignored, not migrated), and make the Start/Stop
  state come from the server, not a flag that resets on reload. Moved into Stage 5, which rewrites the same screens.
- **Checks:** specs for the file write, each new route rule, and placement order.
- **As built (7 November):**
  - `src/main/computers/test-machine-file.ts` reads the file the way `route.js` does and changes only `paused`,
    `testRuns`, `checks` and `slots`, replacing the file in one step. Queue health takes its label from it.
  - Kept here by the page, a run says why ("the Windows PC is paused", "checks are turned off for the Windows PC"), and
    Queue health counts it as chosen. The slot count reaches the PC as `AIO_SLOT_COUNT`.
  - The real file now names its paired computer, `nodeName: "windows-pc"`.
  - Placement: a paused computer, or one with agent sessions off, is never Harness's own choice; each place in the order
    is worth 90, more than memory, slots, latency and an idle processor together (85); workers report `busyCores`
    (from per-core ticks, so Windows works too), worth up to 20. Sessions sent by name or capability, and resuming
    ones, are untouched, so pausing never strands work.
  - The log starts again past 1 MB, keeping `runs.old.jsonl`; Queue health and the report read both.

### Stage 5 — The Computers page

- [x] 5.1 Settings › **Computers** replaces "Other computers": the ordered list (drag, plus Move up / Move down), switches per
  kind of work, room, pause, now, and today's work from the run log. Pairing and the advanced settings move below the list,
  unchanged in what they do.
- [x] 5.2 The Control Center page shows the same list live. Queue health links to it.
- [x] 5.3 "Add a computer": pair it, then offer to set it up for tests and checks, with the steps it needs in plain words.
- **Rules:** `docs/screen-and-wording-guide.md` (and its section 6 when reviewing); `docs/angular-conventions.md`; no welcome
  wizard. From the guide: a computer that is up and idle shows no status (healthy is invisible); only busy, away and
  paused show, in words, never colour alone. The Control Center page explains and links to Settings; it changes nothing. **Checks:** component specs; `build:renderer`; a real check in the dev app, with seeded state for "away", "busy" and
  "paused", keyboard only as well.
- **As built (7 November):**
  - `computers-list.model.ts` (rows, moves, words) and `computers-list.component.*`: the ordered list with Move up and
    Move down, Agent sessions, Test runs, Checks, how many at once, Pause (pausing a computer pauses its test machine
    too), the other work it takes, and Today. Read-only on the Control Center page, with "Change these in Settings".
    Queue health has "Choose where work runs" when a test machine is set up.
  - The tab opens on Computers (sections now Computers, Pairing, Overview, Advanced) and shows the list even with
    connections off, because the test machine doesn't need them.
  - Two channels, `computers:get-test-machine` and `computers:change-test-machine`, read the file and today's runs and
    change the switches. Errors show a plain sentence with the raw text under Details (`presentError`).
  - The GPU switch is gone everywhere it was shown or saved; the tab's wording now names tests and checks. The Control
    Center's Start/Stop reads the server's real state.
  - **No dragging:** Move up and Move down do the job by mouse and keyboard alike; dragging can come later if wanted.
  - **Not renamed:** the page is still called "Other computers". Another session's agent-pairing work, uncommitted in the
    same files, tells agents and people to use "the Other computers page" in several places. Renaming now would clash
    with it; do it once that work lands.
  - **5.3 (11 November):** done as a guide, not an automatic setup. Each paired computer with no test machine has
    "Set up for tests and checks" (Settings only), with the steps in words: Ubuntu and `setup-linux.sh` for Windows and Linux,
    Homebrew for a Mac, then the line to add to the list (`describeSetup` in `computers-list.model.ts`). Harness doesn't run
    them: the steps change another computer and this Mac's SSH setup, which need James's keys. Keyboard use is a live check.
  - **Checked for real:** both screens rendered from a development build in a hidden window, with the stores seeded
    (a busy Windows PC with its test machine, a laptop away since 14:03, today's counts); the screenshots read correctly.
    That check moved the pause explanation to the top, once, and replaced the GPU wording. Not checked: keyboard-only
    use in the real app, and the page with real data after a rebuild (live checks).

### Stage 6 — The test Mac

**Revised 8 November, before any code.** Measured first: the Mac-only tests that run here after every PC run took 63 s
(load 17); at about 60 full runs a day that is roughly an hour of this Mac's time daily, and Undistilled adds under an hour
(about 2 min a run, about 5 runs a day). So the test Mac earns its place mostly as a second test machine in the same
ordered list, not only as the home of Mac-only tests: it takes full runs and checks when the PC is full or away, before
anything falls back to this Mac, and runs the Mac-only part beside the PC run rather than after it.

- [x] 6.1 **One far-side script for Linux and macOS.** `remote-run.sh` keeps its commands and gains a macOS path for its
  Linux-only parts: a process group with a time limit and a stop-on-disconnect in place of the systemd scope; a Perl lock in
  place of `flock` (the lock then reaches the run's children, which `flock -o` avoided; said in a comment); `shasum` for
  `sha256sum`; Perl for millisecond times; a plain `tail` stopped after the run in place of `tail --pid`; the darwin-arm64
  Node download. Its own folder on the test Mac, reached through the `ct-test-mac` SSH setup.
- [x] 6.2 **A list of test machines.** The first machine stays at `config.json`'s top level, where older copies of the
  scripts (Plan Queue worktrees on older bases) and an older Harness build still read it; further machines go in
  `moreMachines`, in the order to try them. The file is never rewritten into another shape. Each machine
  keeps its own paused, test runs, checks, slots and paired computer. Full runs, long lists, checks and commit-time runs try
  each machine in order that takes that kind of work and has a free slot, then this Mac, saying why.
- [x] 6.3 **Mac-only tests on a Mac in the list,** started beside the PC run instead of after it; this Mac when there is none.
- [x] 6.4 **The page shows each test machine** with its own switches (the Settings list and the read-only one).
- **As built (8 November), 6.1–6.4:** done and committed. The far-side spec passes on macOS (20) and on the PC; the full suite passes on the PC (47,023 tests); two independent reviews, the second PASS. Fixed on review: only `AIO_SLOT_WAIT=0` is honoured (a leading zero broke the arithmetic); a Mac-only run started beside the main one is always waited for, since the runner ends with `process.exit`. A second opinion caught that a list-only file would hide the first machine from older copies of the scripts and Harness, so the first machine stays at the top level and the rest go in `moreMachines`.
- [x] 6.5 **Set up the test Mac and turn it on** (James, 8 November: on straight away).
  - **As built (8 November):** the test Mac is `moreMachines[0]` in the real config, after the Windows PC (the old file is kept
    beside it as `config.json.before-test-mac`). Proven with real runs: the full suite there (47,027 passed, 8 min); a real
    run that went there because the PC had three runs going (47,029 passed); checks there (all 7); a first machine that can't
    be reached passing a run to the test Mac; neither reachable, so here, naming both; the Mac-only specs there beside a PC
    run (95 tests, the same single skip as this Mac).
  - **Set-up it needed, now in docs/testing.md:** Homebrew's folder on the search path (ssh reads no login profile), for
    `rg` and `flock` (`flock` installed with Homebrew; without it 5 work-finding tests failed there); a copy of
    `~/.config/git/hooks/plan-spec-guard.sh` (without it 3 history-landing tests skipped). Work-finding then passed in full
    there (8,701 tests, 6 min).
- [ ] 6.6 **Then Undistilled:** measure it on the test Mac and add its recipe if it passes there.
  - **Measured 8 November, not switched on.** About 30 s there against 51 s here, and a real round trip of 69 s. The recipe,
    `needsMac` (it goes only to a Mac, and runs here when none takes test runs) and their tests are committed. But two of its
    browser tests ("failure output of a browser test") pass only in James's working copy and fail in any fresh checkout,
    this Mac's included, with identical Playwright files; so a run on the test Mac would report them. Its runner was left
    as it was. **To finish (deferred to the livetest doc: it edits Undistilled, another repository):** fix those two tests in Undistilled, then have `scripts/test-quiet.mjs` call
    `~/.ai-orchestrator/remote-checks/harness-remote-check.js` first on a run with no arguments, as work-finding's does.
- **Limits:** no credentials on the test Mac (it has none by design). After a restart it's away until someone logs in
  (FileVault), and work goes to the next computer, saying why.
- **Checks:** the far-side spec run on macOS (this Mac is macOS too, so it runs here); specs for the list, its order, the old
  file shape and each fall-back; a real full run and a Mac-only run on the test Mac; a forced fall-back.

### Stage 7 — Agent sessions on other computers

James chose to plan this now (8 November) rather than after a week. Stage 1's record still shows whether this Mac stays busy and the AI tools a real share
of what's left. Then:

- [ ] 7.1 **James signs Claude and Codex in on the PC,** once each. Login files are never copied between machines. Deferred to the livetest doc (a person must do it).
- [x] 7.2 **Write the detailed plan for it.** Written 11 November: [2026-11-11-agent-sessions-on-other-computers_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-11-agent-sessions-on-other-computers_plan.md). Queue jobs need their repository, worktree and landing on the PC, which is a large
  change with its own risks. Loops and automations are smaller. It gets its own plan before any code.
- **Checks:** set out in that plan.

## Verification for every stage

- Targeted specs while building; then the project checklist in `AGENTS.md` (tsc, typecheck:spec, lint, check:ts-max-loc,
  check:ui-hints, build:main, build:renderer, test:quiet).
- The run log shows where the work ran, and each route is proven both on the other computer and falling back here.
- A fresh reviewer for each stage before it lands.

## Targets

- After a week of Stages 2 and 3: this Mac's share of check and test time below 10%, with no rise in failed queue rounds.
- Falling back to the Mac stays rare and always says why.

## Noticed along the way

- **A test that fails on the PC every time (7 November):** `src/main/vcs/turn-file-baseline.spec.ts` "rejects an immediate
  post-settlement deletion as uncertain instead of counting it" failed in 2 of 3 full runs on the PC today (expected 0,
  got 1, line 531) and passes on the Mac, so it is intermittent there. It came in with another session's commits about 21 hours earlier (`5d4f722f8`,
  `a410de8ad`). Not this plan's code; left for that work.

## Not in this plan

Unchanged from the spec: renting a machine, Noah's computers, a virtual machine on the PC, splitting one run across computers,
and widening `exec_on_node`.

> Closure history: `2026-11-07-computers-remote-first_plan_history_51dacc4ee5c942049cf8bc66ea632c4ee0962260c73aea75b1436a24b0db4328_completed.md`.
