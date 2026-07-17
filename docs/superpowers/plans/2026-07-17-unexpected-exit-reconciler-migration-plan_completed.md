# Unexpected-exit respawn migration onto RuntimeReconciler — implementation plan

**Status:** COMPLETED 2026-07-17 — both recovery entry points now run through
`RuntimeReconciler.applyRecoveryRespawn`; the handler contains zero direct adapter
create/spawn/terminate calls outside `cleanupAbortedRespawnAdapter` and the interrupt
force-abort net (acceptance grep). 40/40 recovery tests green with the REAL core wired;
tsc ×2 / lint / LOC clean; full quiet suite as final gate (loop record). Live checks:
[`2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md`](2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md).
**Date:** 2026-07-17
**Spec:** [`2026-07-16-runtime-reconciler-migration_spec_planned.md`](../specs/2026-07-16-runtime-reconciler-migration_spec_planned.md), scope item 3 only.
**Prereq landed:** item 2 — `RuntimeReconciler.applyRecoveryRespawn` owns the recovery spawn
core (see `2026-07-17-interrupt-respawn-reconciler-migration-plan_completed.md`). This change
is the second client of that core and deletes the handler's last duplicated spawn block.

> For agentic workers: execute inline with test-first cycles. Do not commit or push.

## Goal

`respawnAfterUnexpectedExit()` delegates its spawn core to `applyRecoveryRespawn`, exactly as
the interrupt path does. The handler keeps: breaker/backoff, session lock (+metadata), abort
decisions, pre-respawn snapshot, capability read + `deleteAdapter` of the crashed adapter,
`planSessionRecovery`, respawning waitReason, and all post-respawn bookkeeping (status
transition, auto-respawn transcript message, queueUpdate payloads, error handling).

## Verified differences vs the interrupt path (2026-07-17 read)

1. The crashed adapter is `deleteAdapter`'d BEFORE the replacement is created (the exit handler
   no longer deletes it; capabilities are read first). Stays handler-side, before delegation.
2. Fallback-history reason is `'auto-respawn-fallback'` (interrupt uses
   `'resume-failed-fallback'`) → `RecoveryRespawnRequest` gains `fallbackReason` and the core
   stops hardcoding it; the interrupt call site passes `'resume-failed-fallback'` explicitly
   (behavior-identical).
3. Replay reason `'auto-respawn'` → existing `replayReason` field.
4. No `resolveRespawnPromise` in `finally` (interrupt-specific) — unchanged.
5. Post-respawn status/message/queueUpdate wording differs — all handler-side, unchanged.

## Tasks

- [x] `RecoveryRespawnRequest.fallbackReason` + core uses it; interrupt call site passes the
      old literal (no behavior change; interrupt specs stay green untouched).
- [x] Delegate `respawnAfterUnexpectedExit`'s spawn block to `applyRecoveryRespawn`; delete the
      duplicated block. Acceptance grep: zero direct adapter create/spawn/terminate calls in
      the whole handler outside `cleanupAbortedRespawnAdapter`/interrupt-force paths.
- [x] `__tests__/interrupt-respawn-handler.spec.ts`: replace the throws-if-called
      `applyRecoveryRespawn` fake with a real RuntimeReconciler wired over the same fakes
      (same pattern as the sibling spec) so the existing unexpected-exit scenarios keep
      exercising the real core.
- [x] Canonical verification checklist (tsc ×2 clean, lint clean, LOC clean, 40/40 recovery specs, instance lifecycle 238 green; full suite as final gate — result in the loop record). BONUS: the handler's now-dead private `createRuntimeAdapter` + its two orphaned imports removed; the spec wrapper mirrors the lifecycle creator (harness env + session durability) so the env-passthrough assertion still verifies real behavior.
- [x] Livetest doc per the spec's item-3 line: kill the CLI process mid-turn; verify no
      send-swallowing wedge (respawn-wedge incident) and prompt recovery.

## Acceptance

- Both recovery entry points run through `applyRecoveryRespawn`; the handler contains no
  duplicated spawn/fallback logic.
- Existing unexpected-exit spec scenarios pass against the real core (not fakes).
- Canonical checklist green; livetest doc written; plan renamed `_completed` last.
