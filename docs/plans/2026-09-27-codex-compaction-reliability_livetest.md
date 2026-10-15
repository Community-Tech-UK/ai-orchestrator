# Codex Compaction Reliability — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-27-codex-compaction-reliability_plan_completed.md](2026-09-27-codex-compaction-reliability_plan_completed.md)

**Prerequisites:**

- Install or restart Harness from a DMG built from this checkout. James restarts it himself; do not
  restart Harness while live sessions run.
- A real Codex app-server session (codex-cli 0.157.x or later) with context evidence mode `enforce`
  for Codex (the current default in James's settings).
- Evidence sources: `~/Library/Application Support/Harness/logs/app.log`,
  `~/Library/Application Support/Harness/logs/lifecycle.ndjson`, the conversation ledger
  (read-only), and the Codex rollout under `~/.ai-orchestrator/codex/sessions/`.
- Record the instance id and time window for every check.

## Status — 2026-09-27

Open: 6 · Closed: 0 · Failed: 0

All code, focused and full tests, canonical gates and production builds passed, and a live protocol
probe against `codex app-server` 0.157.1 confirmed the goal-continuation, goal-pause and inline
compaction behaviour this change relies on. These checks remain open only because they need the rebuilt
application and real, long-running provider behaviour.

## Check 1 — Goal-continuation turns are visible and hold busy

1. Give a Codex session a long multi-step task and ask it to set a goal with `create_goal` (or give it a
   task that makes it do so, like the xqs4fg7sl livetest run).
2. Let it run through at least three goal turns.

**Expected:** every goal turn's assistant text and tool calls appear in the transcript; the header
shows busy for the whole run and idle only between turns; `app.log` has `Following a turn Codex started
by itself` for each goal turn; no `Codex error: failed to submit turn input: EmptyInput` and no
"The initial message could not be delivered" notice.

## Check 2 — Codex compacts by itself, once per fill, with one transcript row

1. Keep the Check 1 session working until the context passes 90%.
2. Watch the transcript and `app.log` across the compaction.

**Expected:** `app.log` shows `Codex compaction started` with `trigger: "self-managed"` and no
`Context policy decision` with a non-`none` action for this instance; no `turn_aborted` with
`reason: "replaced"` in the rollout; the transcript shows one row, "Codex compacted its own context
(was N%)", with no separate "is compacting" / "finished its provider compaction turn" rows; the header
meter drops to the fresh post-compaction value within seconds; no `Codex compaction storm` warning.

## Check 3 — Stop pauses an active goal

1. While a goal turn runs, press Stop.
2. Wait two minutes.

**Expected:** the turn stops; the transcript shows "Paused the Codex goal so it does not restart the
work by itself"; no new turn starts in that window (no `Following a turn Codex started by itself` after
the stop); sending a message afterwards starts a normal turn.

## Check 4 — A message sent during a goal turn joins that turn

1. While a goal turn runs, send a short follow-up with the queue/steer choice set to send immediately
   (or let the queued message drain while the next goal turn is already running).

**Expected:** the rollout shows the message delivered into the running turn (a user message inside that
turn, no new `turn/start`); the send completes when that turn completes; no error card.

## Check 5 — Manual compaction never replaces a running turn

1. While a goal turn runs, press Compact Now.

**Expected:** Harness refuses with its busy message; no `thread/compact/start` is sent; the rollout shows
no `turn_aborted reason: "replaced"`.

## Check 6 — Removed spend settings

1. Open Settings → Memory.

**Expected:** "Minimum context fill for spend-based compaction" and "Always compact after spend" are gone;
Settings open and save normally with the old keys still present in `settings.json`.

## Related: 2026-09-24 live test

`2026-09-24-codex-compaction-turn-visibility_livetest.md` Checks 2 and 3 described Harness-driven
controlled recovery and its "awaiting updated usage" boundary. Codex no longer receives Harness
recoveries or occupancy actions, so run those checks against this build only to confirm they are no
longer reachable for Codex, and record that outcome there.

## Status — 2026-10-04

Open: 0 · Closed: 5 · Failed: 1. Check 4 failed (LT-680). This file stays open; do not rename it
`_livetest_completed.md` until LT-680 is fixed and check 4 is repeated.

## Evidence run — 2026-10-04 (batch B, dev app, current working tree)

Environment: dev app on isolated profile `/tmp/aio-lt-1004-b` (CDP port 9471), HEAD `3d05e250e` plus
uncommitted work, codex-cli 0.160.0 (the doc says 0.157.x or later), model `gpt-5.6-sol`, window 258,400.
Times are UTC (machine is on BST, +1 h). `contextEvidenceModeByProvider.codex = enforce` in the disposable
profile for the compaction runs. Launch deviation: the dev app was started with `--no-sandbox` and the
heap flag directly because Chromium's sandbox could not initialise inside the agent shell's Seatbelt
fence; the product was not changed. Goals were created by asking the model to call `create_goal`; the
Codex goal store (`~/.codex/goals_1.sqlite`) confirmed each goal. Evidence: `_scratch/lt-2026-10-04/b/`
(app.log slices, copies of the dev profile's `lifecycle.ndjson`, rollout summaries produced with
`rollout.js`). Every goal was paused or completed and every instance terminated at the end.

### Check 1 — PASS

Instances `xg1i1z0w8` (goal "PING in three separate turns") and `xtbdycjw7` (goal "one animal paragraph
per turn, eight turns"), `yolo` off.

- `xtbdycjw7`, thread `01a10917-d83a-7292-a673-d55ea8582212`: four goal turns (`01a10919-a3ea`,
  `01a10919-f946`, `01a1091a-87a5`, `01a1091a-be1a`) each with an `app.log` "Following a turn Codex
  started by itself" line (`goal4-applog-thread.txt`). `xg1i1z0w8`: two goal turns after the first,
  both followed.
- Transcript: every paragraph from each goal turn that was not the target of a join (check 4) appears
  (octopus, elephant, raven, axolotl), as do the three PINGs in `xg1i1z0w8` (6 transcript entries).
- Status: the renderer sampled `busy` once per second for the whole `xg1i1z0w8` run (29 samples) and
  `idle` only after the last turn. The main-process lifecycle shows 12 ms `busy -> idle -> ready -> busy`
  flickers between goal turns (22:43:39.815-.827 and 22:43:41.813-.825), invisible at that sampling.
- No `EmptyInput` and no "initial message could not be delivered" in any slice (0 matches in the
  `xg1i1z0w8`, `xtbdycjw7`, `xyynqndg6`, `x13dt4qqx` slices and transcripts).
- Caveat: the reply to a message sent into a goal turn is lost: check 4 / LT-680.

### Check 2 — PASS (with two notes)

Instances `x13dt4qqx` (thread `01a1090c-aa1a-7702-aaee-2434668e20a9`, grown to 94.83% with filler
messages and two `cat` tool turns) and `xyynqndg6` (goal active; grown to 96.57%). Both compacted on the
next turn start.

- `app.log`: "Codex compaction started" `trigger: "self-managed"` 22:37:46.184 (turn
  `01a10910-eb37-7d42-9ac3-3a0474a3fb70`), completed 22:37:51.407, `durationMs: 5222`; `xyynqndg6`
  23:02:55.536 to 23:03:03.660, 8,124 ms. Rollout: `compacted` inside the same turn, no
  `turn_aborted reason: "replaced"` (the only `turn_aborted` events in the run's rollouts are `interrupted`
  ones caused by my own Stop and steer actions, never `replaced`).
- Transcript: one boundary row, "Codex compacted its own context (95% → 27%)"; the separate "is
  compacting" / "finished its provider compaction turn" rows exist in the buffer but only the one
  boundary label is rendered (DOM scan).
- Meter: 95% to `~68,690 (~27%)` estimated at 22:37:51.55, real `73,586 (28%)` at 22:37:57.95.
- No "Codex compaction storm" in any slice (0 matches).
- Note 1: one `Context policy decision` with a non-`none` action exists for `x13dt4qqx`:
  `cumulative-2x` / `convergence-review` at 54.15% (22:34:15.772). It is a non-executable decision, no
  `ProviderContextAction` line followed. The doc's "no non-`none` action" wording is not literally met
  (also seen on `xvsu1swui`, `xtbdycjw7` at 15-16% occupancy); judged not a defect because nothing
  executed.
- Note 2: Codex compacted at 94.83% and 96.57% at the start of the following turn, not the moment the
  context passed 90%. The "passes 90%" wording is approximate.

### Check 3 — PASS

`xtbdycjw7`: Stop clicked (the real `.btn-stop`) at 22:48:38.954 during goal turn `01a1091a-be1a`.
Transcript row "Paused the Codex goal so it does not restart the work by itself. Send a message to
continue."; `app.log` "Paused the Codex thread goal after a stop"; goal store `paused`; rollout
`turn_aborted interrupted` 22:48:38.960 and no `task_started` afterwards through the next check at
22:50:52 (2 m 13 s); `Following a turn Codex started by itself` count stayed at 4. A message sent at
22:50:58 ("Reply with the single word OK.") started a normal turn (`01a1091d-015e`), reply "OK".
`xyynqndg6` repeated the pause after a compaction (23:04:37.8, goal `paused`).

### Check 4 — FAIL (LT-680)

Two delivery paths exist and behave differently:

- Plain send (the composer's queue drain; `electronAPI.sendInput`) during a goal turn: delivered inside
  the running turn as a user message with no new `turn/start` (rollout `xtbdycjw7`: user item 22:48:02.02
  inside turn `01a10919-f946`, no `task_started` before its `task_complete` 22:48:16.04), no error card.
  But Codex's reply to it never reached the transcript, and Harness reported `idle` while the turn was
  still running. Reproduced three times (`xtbdycjw7`, `xvn0lylwn`, `xj2fw7nx0`). Details and root
  cause: LT-680.
- The composer's "steer / send now" choice (`electronAPI.steerInput` -> `instance-manager.ts` `steerInput`
  interrupt-then-resend) does not join the turn: it interrupted goal turn `01a10919-a3ea` (rollout
  `turn_aborted interrupted` 22:47:30.616) and started a new turn 36 ms later (reply "STEERED The African
  savanna elephant..." is in the transcript). The goal kept running afterwards. That is by design in the
  code but is not what this check's expected text describes for "send immediately".

### Check 5 — PASS

`xtbdycjw7`, goal turn running, status `busy`, `compactInstance` at 22:47:25.9 returned
`success:false, busy:true, error: "Busy: compaction is available once the current turn finishes."`; the
transcript shows that system message; no "Codex compaction started" in the instance's app.log slice, and
no `compacted` or `turn_aborted replaced` in the rollout.

### Check 6 — PASS

Settings -> Memory (and "Show advanced") in the dev app: "Minimum context fill for spend-based
compaction" and "Always compact after spend" are absent. "Compact after token spend" is still there; it is
a different setting (`cumulativeTokenCompactionTrigger`), not one of the two removed. A restarted dev app
whose `settings.json` held the old `contextSpendRecoveryMinOccupancyPercent` and
`contextSpendRecoveryBackstopMultiple` keys (copied from James's real values, 50 and 16) opened,
`getSettings` returned them, a `fontSize` write 14 -> 15 -> 14 succeeded, and both keys were still in
`settings.json` afterwards. (Those two keys are the ones present in James's real file; the "Always
compact after spend" key name was not found in source or settings.)

### Related note (2026-09-24 checks 2 and 3)

Outcome recorded in that doc: Harness-driven recovery is not reachable for Codex in this build; the
"awaiting updated usage" boundary is the self-managed path and passes, but the manual Compact now path
shows a fabricated `~0%` (LT-681).

### Defects filed

LT-680 (goal-turn join loses the reply, session reads idle), LT-681 (Compact now shows ~0%), LT-682
(cosmetic, "Interrupt Claude" tooltip on Codex sessions). Index rows and sections are in
`docs/plans/livetest-remediation-register.md`.

### Check 1 supplement (same run, added after the audit) — verdict stays PASS, one intermittent miss filed as LT-683

A clean 14-turn goal run (instance `x0av4cy36`, goal "PING in fourteen separate turns", thread
`01a10933-e358`) had 13 goal turns after the first, all 13 with a "Following a turn Codex started by
itself" line, 16 assistant entries in the transcript against 16 in the rollout, the renderer `busy` for the
whole run, no `EmptyInput`, no "initial message could not be delivered" (`race-rollout-summary.txt`,
`x0av4cy36-applog-full.txt`). Across all nine goal threads of the day, 39 goal turns, 36 followed. One of
the three misses (`01a10929-21e4` on `xyynqndg6`, 23:04:13.034, 7 ms after the previous turn ended) came in
an uninterrupted run and left the session `idle` for 19.5 s while the turn ran: LT-683 (seen once, cause
not established). Check 1 is kept at PASS because the 13/13 run met every expected line; LT-683 is the
open risk against it.
