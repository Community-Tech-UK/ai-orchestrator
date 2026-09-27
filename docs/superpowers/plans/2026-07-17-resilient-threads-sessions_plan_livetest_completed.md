# Resilient Threads & Sessions — Live-Test Checks

## Status — completed by consolidation 2026-09-27

Open here: 0 · Closed here: 2 · Transferred: 1 · Failed: 0

Checks 1 and 2 pass. LT-603's exact race has a targeted implementation fix and regression test, but
the required fixed-build multi-process kill-timing run has not yet been repeated. That dedicated,
agent-runnable live check moved intact to consolidated runtime check
[AR-002](../../plans/2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-002--orphaned-orchestration-children-reconcile-during-recovery-respawn),
which also corrects the now-stale no-argument `spawn()` interception recipe. AR-002 is the sole
active owner; no open work remains here.

### Status — 2026-09-21 (superseded)
Open: 1 · Closed: 2 · Failed: 0
Check 3 was re-run live on 2026-09-21 against a rebuilt app (four reproductions). It still fails the
same two sub-assertions, now for a different reason: the LT-215 fix fires but the restart's own
ready-edge redelivery erases the retained record ~25 ms before the reconcile reads it. Filed as
**LT-603**, which supersedes LT-215. Check 3 now needs a code fix, not just a rebuild — see
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-plan-queue-worker--check-3-re-run-after-the-lt-215-fix).

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [`2026-07-17-resilient-threads-sessions_plan_completed.md`](./2026-07-17-resilient-threads-sessions_plan_completed.md)
Date deferred: 2026-07-17

Prerequisites: rebuilt + restarted AIO app, a real provider session (Claude or
Codex), and the ability to induce host load or kill the CLI process. These
checks cannot run in-loop because they need a live provider process and a
restart of the packaged app.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| Check 1 — Slow-but-alive resume survives under load (Phases 1–2) | 2026-08-11 | `app.log`: `resumed: true`, transcript "Session reconnected automatically", background Bash jobs survived the kill; mechanism additionally corroborated 2026-08-25 via unforced production telemetry (81 `Watchdog load multiplier changed` events, traced end-to-end through `system-load-monitor.ts`/`runtime-reconciler.ts:565-585`) |
| Check 2 — Honest degradation preamble on a genuine fresh fallback (Phase 3) | 2026-07-31 | Restarted session quoted the `[SESSION DEGRADATION NOTICE]` block verbatim, matching `fallback-history.ts:184-190` character for character; conversation replay (marker `OBSIDIAN44`) confirmed alongside it |

## Transferred live check

### Check 3 — Orphaned orchestration children reconciled on restart (Phase 4)

**Disposition 2026-09-27:** transferred to AR-002 for one dedicated current-build run. Historical
reproductions, root-cause evidence and the code-level fix verification remain below.

Steps:
1. Have a parent instance spawn two AIO children (orchestration
   `spawn_child`). Terminate one child's process directly so it dies without
   the parent noticing.
2. Force a fresh fallback on the parent (as in Check 2).

Expected:
- Log line `Reconciled orchestration children after restart` with the dead
  child in `dropped` and the live one in `kept`.
- The degradation notice lists the live child as attached and the dead child
  as lost.
- `get_children` from the parent afterwards shows only the live child;
  `get_child_summary` for the dead child still resolves (completed set).

**Current blocker (2026-09-06):** The full scenario has been staged and run to completion once
(2026-08-18, batch S3), using a scoped `CodexCliAdapter.prototype.spawn` monkeypatch over the Node
Inspector to force a decisive fresh fallback without touching any shared Codex store, plus a
precisely-timed simultaneous `kill -9 <parent> <childB>` on the parent's first respawn attempt (a
Codex parent is required — a Claude parent's session JSONL is silently recreated by the CLI via
fork-resume semantics, so the fresh-fallback branch never fires). That run found 3 of 5
sub-assertions passing (live-child listing in the degradation notice, `get_children`,
`get_child_summary`) and 2 failing on a genuine race: the live child-exit reap
(`notifyChildTerminated`) structurally outraces the parent's own restart-time
`reconcileChildrenAfterRestart()` by over a second in every timing tested, so the `"Reconciled
orchestration children after restart"` log line never fires and the notice's "lost in the restart"
section stays empty. Filed as **LT-215**.

As of 2026-08-31, LT-215 is fixed in code: the repair retains the child/admission record from the
exact event where a completion can't be delivered while the parent is unavailable, drains it once
into fresh-fallback `droppedChildIds`, and clears on successful same-session redelivery. A
failing-first regression test covers the reaped-child and one-shot-cleanup behaviour. **What remains
is a live re-run of the original multi-process scenario above against a rebuilt app** — the fix has
not yet been exercised end-to-end the way the 2026-08-18 run exercised the bug. Reproduction recipe
for the next attempt: fresh two-child Codex parent, both children running a genuine multi-minute
bash loop (not a short essay — it finishes before the collision window), `CodexCliAdapter.prototype.spawn`
monkeypatch scoped to that parent's `workingDir`+`resume===true`, and `kill -9 <parent> <childB>` in
one shell invocation on the parent's *first* respawn attempt (a later attempt loses time to
`RespawnCircuitBreaker`'s 10s backoff).

Blocker class: **B** — needs only a rebuilt + relaunched app; the staging technique itself is fully
agent-runnable (kill-safety gates, monkeypatch, timing) and already proven twice.

**Superseded 2026-09-21.** That re-run has now happened — see the evidence section below. The
blocker class is now **A**: the check needs the LT-603 fix before it can pass.

---

## Evidence run — 2026-09-21 (Plan Queue worker) — Check 3 re-run after the LT-215 fix

**Outcome: Check 3 stays OPEN. 3 of 5 sub-assertions pass; the same 2 fail as on 2026-08-18, for a
new reason. Filed as LT-603, which supersedes LT-215.**

### Environment

Dev app built and launched from the queue worktree
`.worktrees/queue/2026-07-17-resilient-threads-s-d4428b` (HEAD `b8fcbe88`), isolated profile
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-f4d4428b`, renderer served from
`dist/renderer-dev/browser` on `:4567`, CDP `--remote-debugging-port=9803`, main-process Node
inspector `--inspect=9804`. Focus emulation (`Emulation.setFocusEmulationEnabled` +
`setPageVisibilityOverride`) enabled on every CDP connection before any assertion. `npm run
build:main` exit 0 and `ng build --configuration development` exit 0 immediately before launch, so
`dist/main` carried the 2026-08-31 LT-215 fix.

### Scenario, as specified in the check

Reproduced four times end to end (runs 1-4). Each run: a fresh `codex` parent in
`/tmp/aio-lt-queue-rt3` spawning two orchestration children via real `:::ORCHESTRATOR_COMMAND:::`
`spawn_child` blocks, each child running a genuine `for i in $(seq 1 600); do echo tick $i; sleep 1;
done` loop (verified present in `ps` before proceeding, so neither child could finish inside the
collision window); a `CodexCliAdapter.prototype.spawn` monkeypatch installed over the Node inspector,
scoped to `cliConfig.workingDir === '/tmp/aio-lt-queue-rt3' && cliConfig.resume === true`, to force a
decisive fresh fallback without touching any shared Codex store; then a single
`kill -9 <parentPid> <childBPid>` on the parent's first respawn attempt.

Kill-safety gates were checked before every kill: each pid absent from the pre-campaign
`ps -Ao pid,ppid,command` snapshot, `ppid == 54541` (this run's dev-app main process), and command
line matching `node .../codex ... app-server`. The packaged Harness app was not running at any point.

### Results

| Sub-assertion | Result |
| --- | --- |
| `Reconciled orchestration children after restart` logged with dead child in `dropped`, live child in `kept` | **FAIL** — 0 occurrences across 4 runs |
| Degradation notice lists the live child as attached | **PASS** |
| Degradation notice lists the dead child as lost | **FAIL** — no "lost in the restart" line at all |
| `get_children` afterwards shows only the live child | **PASS** |
| `get_child_summary` for the dead child still resolves | **PASS** |

Run 1 (parent `xs70jgibb`, child A `x0o4uvtzr`, child B `xz7h0vdkg`, kill at 05:46:31.312). The
parent quoted its own session context back verbatim when asked:

```text
[SESSION DEGRADATION NOTICE]
A brand-new provider session was started because the previous one could not be resumed (auto-respawn-fallback).
Background and in-flight work from the prior session — subagents, running tools, pending tasks — was NOT carried over and no longer exists.
Re-establish the current state (re-check files, task status, and outputs) before continuing; do not assume prior background work finished.
Orchestration child instances still alive and attached to you:
- x0o4uvtzr (## Child Instance, busy)
[END SESSION DEGRADATION NOTICE]
```

`get_children` returned `**Active children:** - ## Child Instance (x0o4uvtzr) - busy`, and
`get_child_summary` for the dead `xz7h0vdkg` resolved normally.

Across all four runs `app.log` recorded 4× `Auto-respawning after unexpected exit`, 4× `Resume failed
during recovery respawn, falling back to fresh session`, 4× `Child exited, parent notified`, 4×
`Recovery respawn complete`, and **0×** `Reconciled orchestration children after restart`.

### Why it still fails — the LT-215 fix fires and is then undone

The 2026-08-31 repair works: `notifyChildTerminated` retained the reaped child in
`suppressedChildCompletions` on every run, and `SessionAdmissionService` logged `Automated write
suppressed {reason:"respawning"}` for `action: "child_completed"` each time. The record is erased
before the reconcile can drain it. Prototype-level trace from run 4 (parent `x4qbhmni2`, child A
`xbspqtb2k`, child B `xeql4igyx`, kill at 05:57:37.543):

```
05:57:37.551  transitionStatePublic  idle -> respawning
05:57:37.575  notifyChildTerminated  childrenIds=[xbspqtb2k]  suppressed=[xeql4igyx]
05:57:37.857  transitionStatePublic  respawning -> idle
              CodexCliAdapter.spawn -> transitionAdapterStatus, inside
              RuntimeReconciler.applyRecoveryRespawn (runtime-reconciler.ts:689)
05:57:37.857  SessionAdmissionService.handleStateUpdate {status:'idle'} -> tryRefire
              -> OrchestrationResponseDelivery.handleRedelivery
              -> onChildCompletionRedelivered -> forgetSuppressedChildCompletion
                 before: {childrenIds:[xbspqtb2k], suppressed:[xeql4igyx]}
05:57:37.885  reconcileChildrenAfterRestart
                 before: {childrenIds:[xbspqtb2k], suppressed:null}
                 result: {kept:[xbspqtb2k], dropped:[]}
05:57:37.885  buildFreshFallbackDegradationNotice
                 info: {activeChildren:[xbspqtb2k], droppedChildIds:[]}
```

The 28 ms gap is structural, not luck: `buildFallbackHistory` is only called after
`await hooks.waitReady(adapter)` (`runtime-reconciler.ts:710-716`), while the fresh adapter's own
`spawn()` already emitted the ready transition at `runtime-reconciler.ts:689`. Run 2 measured the
same ordering with a 20 ms gap.

The redelivered completion is not an acceptable substitute for the missing notice line. It replays
the dead child's *pre-kill* self-summary under a completion banner — in run 1 the parent received
"**Child Completed:** ... **Status:** Failed / The command is running normally and has begun emitting
the requested ticks. I'll keep it attached until all 600 iterations finish." — and concluded the
child should be treated as still running. Nothing told it the process was gone.

`src/main/orchestration/orchestration-handler.spec.ts` passes 21/21 on this build. Its LT-215 case
calls `notifyChildTerminated` and `reconcileChildrenAfterRestart` back to back against a mocked
admission service, so no ready edge fires between them and `forgetSuppressedChildCompletion` is
never reached — the mechanism is correct in isolation and the test does not model the ordering the
real restart imposes.

Filed as **LT-603** in `docs/plans/livetest-remediation-register.md`, with a status section in
`docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. LT-215's status was corrected in both
documents from "fixed in code, live re-check pending" to "live re-check failed, superseded by
LT-603".

### Residual

Check 3 remains open and now has a code prerequisite again, not just a rebuild. Blocker class:
**A** — needs the LT-603 fix. The reproduction recipe above is fully agent-runnable and proven five
times in total (once on 2026-08-18, four times here); scripts and traces are preserved under
`_scratch/lt-queue-rts/` in the queue worktree (`run2-trace.json`, `run3-trace.json`,
`run4-trace.json`, `evidence-app-log-2026-09-21.log`).

Nothing in this run needs James.

> Plan Queue parked work: `queue/2026-07-17-resilient-threads-s-d4428b` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (resume batch)

**Result: code-level and unit-test-level re-check only. A targeted fix for LT-603's exact documented
race is present and passes a new regression test that models the previously-missing scenario. The
full live multi-process reproduction was not re-attempted this batch — see "Why the live
reproduction was not re-run" below.**

### What changed since 2026-09-21

`git log --since=2026-09-21` on the relevant files shows commit `9efc4871` ("Fixing codex",
2026-09-23 21:09:53 +0100), which touches `src/main/session/session-admission-service.ts` and
`src/main/instance/lifecycle/runtime-reconciler.ts` — exactly the two files the 2026-09-21 trace
named as the race's location.

**The fix**, read at `session-admission-service.ts:220-244`:

```ts
holdRespawningChildCompletions(instanceId: string): () => void {
  this.heldRespawningChildCompletions.set(instanceId, (...) + 1);
  return () => { /* decrement; on last release, delete + tryRefire(instanceId) */ };
}
```

and `tryRefire` (further down) now skips a candidate when
`this.heldRespawningChildCompletions.has(instanceId) && entry.suppressionReason === 'respawning' &&
entry.origin === 'orchestration' && entry.sourceMetadata?.['action'] === 'child_completed'`.

**Where it's wired**, read at `runtime-reconciler.ts:585-594`:

```ts
async applyRecoveryRespawn(instanceId, request, hooks): Promise<RecoveryRespawnOutcome> {
  ...
  const releaseChildCompletions = getSessionAdmissionService().holdRespawningChildCompletions(instanceId);
  try {
    return await this.runRecoveryRespawn(instanceId, instance, request, hooks);
  } finally {
    releaseChildCompletions();
  }
}
```

This wraps the **entire** recovery respawn — `adapter.spawn()`, the resume-health check, and
`hooks.waitReady(adapter)` (where `buildFallbackHistory`/`reconcileChildrenAfterRestart` run) — in
one hold, released only in the `finally`. The 2026-09-21 trace showed the ready-edge state update
firing *inside* this exact window (at `runtime-reconciler.ts:689`, before `waitReady` even started),
28 ms before `reconcileChildrenAfterRestart` read the suppressed record. With the hold in place, that
same ready-edge update can no longer trigger `forgetSuppressedChildCompletion`/redelivery early — the
completion stays suppressed until reconciliation (running inside the held window) has had its chance
to call `markFailed` on it, or the hold is released after the whole respawn settles.

**New regression test**, `session-admission-service.spec.ts` ("redelivery on ready edge" describe
block, two new `it`s added in the same commit): the first explicitly reproduces the previously-missing
ordering — `holdRespawningChildCompletions('i1')`, THEN a ready-edge `emitStateUpdate('i1', 'idle')`
(confirms the redelivery handler is **not** called while held), THEN `service.markFailed(...)`
(simulating what reconciliation does), THEN `release()` (confirms it still is **not** redelivered —
state stays `'failed'`, not re-fired as a stale completion). This is precisely the scenario the
2026-09-21 evidence said the old test suite was missing ("the mechanism is correct in isolation and
the test does not model the ordering the real restart imposes"). The second new test confirms an
unrelated `'reaction'`-origin write on the same instance is *not* blocked by the hold — the fix is
scoped, not a blanket freeze.

Ran both spec files fresh on this checkout: `npm run test:quiet -- session-admission-service.spec.ts
orchestration-handler.spec.ts` → **2 files · 61 tests passed in 5.3s**, including the two new tests.

### Why the live reproduction was not re-run

The 2026-09-21 method monkeypatched `CodexCliAdapter.prototype.spawn` scoped by
`cliConfig.workingDir === ... && cliConfig.resume === true`. Reading the current
`runtime-reconciler.ts:596-620`, the adapter's `spawn()` method now takes **no arguments** at all
(`async spawn(): Promise<number>`, confirmed identically across every CLI adapter file, e.g.
`codex-app-server-adapter.ts:332`) — the `cliConfig`/`resume` values that used to be spawn's own
parameters are now resolved earlier and passed into `createRuntimeAdapter(request.cliType,
request.spawnOptions, ...)` instead. The exact 2026-09-21 monkeypatch technique no longer applies to
this code shape, so reproducing it would mean re-deriving a new scoped interception point from
scratch (most likely on `createRuntimeAdapter` or on the adapter instance's own config field) — on
top of the already-substantial cost of staging two real multi-minute Codex orchestration children and
a millisecond-precision simultaneous `kill -9` on the parent's first respawn attempt, a combination
the original evidence needed **four live attempts across two sessions** to nail down cleanly. I set up
the main-process Node inspector connection for this (`--inspect=9712`, confirmed reachable, main pid
recorded) but did not attempt the full choreography — the risk of a rushed, low-confidence
reproduction of the single most timing-fragile check in this campaign outweighed pushing through on a
technique that would need to be redeveloped rather than replayed.

### Residual disposition

The dedicated fixed-build live re-check moved to AR-002 on 2026-09-27. This source retains the
historical failure and code-verification evidence, but no longer owns an open check.

### Cleanup

The dev app was relaunched with `--inspect=9712` for this investigation only (no adapter code was
patched, no instance was created, no kill was issued); it is stopped along with the rest of this
batch's dev app at the end of the run (see final report).
