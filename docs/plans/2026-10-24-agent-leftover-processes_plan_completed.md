# AIO stops programs that agents leave running — plan

**Status:** COMPLETE (2026-10-24). All agent-runnable work is implemented and verified:
- `tsc`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `check:ui-hints`, `build:main` and
  `build:renderer` all exit 0;
- the full `test:quiet` suite passes (2,749 files, 35,023 tests);
- the fresh-eyes completion gate returned `VERDICT: PASS` on round 3, after rounds 1 and 2 found
  defects that are now fixed.

Checks that need the rebuilt app are deferred to
[2026-10-24-agent-leftover-processes_livetest.md](2026-10-24-agent-leftover-processes_livetest.md).

**Spec:** [2026-10-24-agent-leftover-processes_spec_completed.md](2026-10-24-agent-leftover-processes_spec_completed.md)
(read its "Amendments" block first).
**Findings:** [2026-10-24-agent-leftover-processes_report.md](2026-10-24-agent-leftover-processes_report.md).

Concurrent sessions have uncommitted work in this tree. Leave files outside this plan alone. In
particular, `late-runtime-initialization-steps.ts` and `idle-hibernation-sweep.ts` are modified by
other sessions.

## Tasks

1. **Shared process-table helpers.**
   - In `host-process-inspector.ts`, export what the sweeper reuses: `parseEnvMarkers` and
     `parseElapsedSeconds` (already exported) and the env-marker snapshot.
   - New `parseCpuSeconds` for the ps `time` column, accepting both `[DD-]HH:MM:SS` and `MMM:SS.ss`.
2. **Lineage recorder.** New `src/main/process/session-process-lineage.ts`.
   - A pure class: rows (pid, ppid, pgid, uid, start) plus live roots (pid → instanceId) produce a
     record of `pgid → {instanceId, earliestStartSec, lastSeenSec}`.
   - `attribute(pgid, startSec)` applies the pid-reuse window: start ≥ earliestStart − 2 s and
     start ≤ lastSeen + 2 × interval.
   - Prune after 24 h without members. Serialise to and from JSON.
3. **Sweeper.** New `src/main/process/leftover-process-sweeper.ts`.
   - Singleton `getLeftoverProcessSweeper()` and `_resetForTesting()`.
   - Each 10 s tick reads the table and updates lineage while sessions are live.
   - Every 60 s it also reads the env table, finds candidates, measures subtree CPU deltas, and
     applies the rules for the current setting:
     - R1: stop when `stop-cpu-hogs` or `stop-all`; notify only when `notify`.
     - R2: notify, or stop when `stop-all`, once the owner has been seen dead for 60 min.
     - Hibernated and errored owners count as live.
   - Stopping sends SIGTERM to the subtree, deepest first, then SIGKILL after 10 s to survivors whose
     pid and start time still match.
   - One coalesced notice per sweep, and no repeat notice for the same program.
   - Lineage is persisted to `userData/process-lineage.json`, throttled to at most once a minute.
   - An initial sweep runs at start. The timers are `unref`'d and stopped through the cleanup
     registry. The sweeper is disabled on Windows (phase 2).
4. **Hooks.** In `host-process-instance-hooks.ts`, add `getLiveSessionRoots(): Map<pid, instanceId>`.
5. **Setting.** Add `leftoverProcessCleanup` across:
   - `settings.types.ts` (one line);
   - `settings-defaults.ts` (`'stop-cpu-hogs'`);
   - `settings-metadata-runtime.ts` (select, category `memory`);
   - `settings-surfacing.ts` (`tab`);
   - `settings-control-policy.ts` (open enum).
6. **Wiring.** A `Leftover process sweeper` step in `initialization-steps.ts` calls
   `startLeftoverProcessSweeper` (`leftover-process-sweeper-wiring.ts`). See the as-built notes for why
   it is not in `orchestrator-tools-step.ts`.
7. **Runner fixes.**
   - (a) `plan-queue-process.ts`: on `close` after `exit`, group-kill if anything remains.
   - (b) `loop-spawn-verify.ts`: `detached` on POSIX, and a group kill after close, timeout and
     cancel.
   - (c) `plan-queue-worktree.ts` `removeWithProof`: before deleting, ask the sweeper to stop
     attributed orphans whose cwd is inside the worktree. Use a new
     `listFolderProcessPids` in `leftover-worktree-processes.ts`, parsing lsof `-F0pn`.
8. **Guidance.**
   - Add `PROCESS_HYGIENE_SYSTEM_PROMPT` and the block kind `adapter-process-hygiene`.
   - Register the kind in the context-manifest type and order list and in the renderer label map.
9. **Tests.** Unit tests for the parser, lineage, and sweeper rules (fixture tables). Real-process
   integration tests use `sleep` only:
   - the incident replay (an exit-0 shell with backgrounded `sleep`s attributed by lineage);
   - the plan-queue closed-output leftover;
   - a loop-verify leftover after pass and after timeout;
   - removeWithProof stopping a leftover.

   Update the guidance-block tests.
10. **Gates.** The canonical checklist in `AGENTS.md`. Then the fresh-eyes completion gate. Then a
    livetest doc for the rebuilt-app checks.

## Progress

- [x] 1  - [x] 2  - [x] 3  - [x] 4  - [x] 5  - [x] 6  - [x] 7a  - [x] 7b  - [x] 7c  - [x] 8  - [x] 9  - [x] 10

Live checks: see [the livetest doc](2026-10-24-agent-leftover-processes_livetest.md) (6 open).

## As-built notes

**Wiring.** The sweeper starts as the `Leftover process sweeper` step in
`src/main/app/initialization-steps.ts`, not in `orchestrator-tools-step.ts`, because that file is two
lines under its hard 700-line limit. The wiring lives in `leftover-process-sweeper-wiring.ts`.

**Owner states.** These are `live`, `ended` and `unknown`.
- Harness deletes a session when it is closed (`instance-termination.ts` → `deleteInstance`).
- So the sweeper remembers the ids it saw live, along with their names, and treats "seen live, now
  unknown" as `ended`.
- An id never seen live in this run stays `unknown`. That covers a crashed earlier run and another
  Harness app on the same Mac.

**CPU windows.**
- `ended`: 10 min.
- `live` or `unknown`: 60 min.
- Idle leftovers are reported after 60 min. Under `stop-all` they are stopped only when the owner is
  `ended`.

**Tracking.** Candidates are tracked by pid, with a ±3 s start-time tolerance, and the clock is read
after `ps` returns. `ps` derives start times from its own clock, so they wobble by a second between
reads, and a clock read before a slow `ps` would shift them further. Found by the first and second
completion-gate reviews.

**CPU window for closed sessions.** Only samples taken after the session was seen closed count toward
the 10-minute window, so a burner is stopped 10 minutes after its session closes, never at the first
sweep after (second review).

**Runners.**
- `plan-queue-process.ts` and `loop-spawn-verify.ts` use a new `killProcessGroupOnly`
  (`base-cli-process-utils.ts`) on their after-exit paths. The leader has been reaped by then, so the
  single-pid fallback could hit a reused pid.
- On timeout, loop verify walks the process tree before killing the group, so a `setsid` descendant
  is still found.
- Loop verify kills its group on `exit`, not `close`, so a leftover that still holds the output
  cannot turn a passing verify into a timeout (second review).

**Notices.**
- One coalesced notice per sweep, naming each session by its current title. Titles are refreshed each
  tick and remembered after a session closes (second review).
- Idle leftovers are reported with their process numbers and "quit it in Activity Monitor". The
  agent tool `stop_leftover_processes` is marker-only, so it cannot stop Apple binaries that were
  attributed by lineage.
- Unknown owners get their own wording: "started by a session that Harness no longer has open ...
  possibly from before Harness restarted".
- The first `ps` table read logs its row count and cost (`Leftover process table read`), and again
  whenever a read takes over 500 ms. This is the spec's cost measurement, checked live in LS-1.

**Verification.**
- In-loop real-process proof: `_scratch/proc-cleanup/real-replay.ts`. It uses real processes and a
  libproc stand-in for `ps`, which this agent sandbox blocks.
- `leftover-process-sweeper.real.spec.ts` runs the same scenario against real `ps` wherever `ps` is
  usable.

**Dropped.** Spec 4.3 item 4 (the final SIGKILL in `terminate()`); see the spec amendments.

**Follow-ups (non-blocking observations from the round-3 review, not built):**
1. `leftover-process-sweeper.real.spec.ts` waits for `ppid == 1`. A Linux subreaper would make it time
   out rather than skip.
2. A `ps` call slower than 3 s can reset a burner's CPU window. This fails safe.
3. `ps` failures log a warning every 10 s, with no back-off.
4. Escalation reads one `ps` table per stopped program. These could be batched.
5. Persisted lineage can lag by up to about 2 minutes after a crash.
6. The spec body's "on demand from the existing MCP tool" was not built. `stop_leftover_processes`
   stays marker-only. The `sweep()` comment's "on-demand path" refers only to tests and worktree
   removal.
7. Loop verify's own group is not killed on Harness quit. This is not a regression.
