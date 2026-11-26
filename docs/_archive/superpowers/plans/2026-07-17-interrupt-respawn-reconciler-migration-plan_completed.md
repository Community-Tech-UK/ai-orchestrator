# Interrupt-respawn migration onto RuntimeReconciler — implementation plan

**Status:** COMPLETED 2026-07-17 — implemented and verified (handler specs 31/31 with the
fallback-ordering E2E driving the REAL reconciler core; `runtime-reconciler.recovery.spec.ts`
9/9; acceptance grep: `respawnAfterInterrupt` contains zero direct adapter
create/spawn/terminate calls; tsc ×2 / lint / LOC clean; full quiet suite run as the final
gate — result recorded in the loop iteration notes). As-built deviations are recorded inline
in the Tasks list (sibling `applyRecoveryRespawn` instead of a premature shared core;
handler-held lock + reconciler lock-assert; `postSpawnProviderSessionId` for the fork case).
Live checks: [`2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest.md`](2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest.md).
**Date:** 2026-07-17
**Spec:** [`2026-07-16-runtime-reconciler-migration_spec_planned.md`](../specs/2026-07-16-runtime-reconciler-migration_spec_planned.md), scope item 2 only
("Migrate interrupt-respawn (one change)"). Item 3 (unexpected-exit) is the SAME handler's
exit-driven entry point and gets its own follow-up plan after this one lands — never bundled.
**Prereq landed:** item 1 (yolo) — see `2026-07-17-yolo-mode-reconciler-migration-plan_completed.md`.

> For agentic workers: execute inline with test-first cycles. Do not commit or push. Do not
> commit this plan or the spec until fully implemented and verified.

## Goal

`interrupt-respawn-handler.ts` `respawnAfterInterrupt()` (~683-1075) becomes a reconciler call
with an **identity diff** (same provider/model/yolo) and a **recovery continuity plan**, so the
incident-prone respawn machinery has one owner. The handler keeps everything that is
interrupt-*specific*; the reconciler absorbs only the terminate→plan→spawn→fallback→persist core.

## Investigated behavior to preserve (verified 2026-07-17; re-verify at execution)

`respawnAfterInterrupt` is NOT a simple respawn — it layers, in order:
1. **Circuit breaker** exponential backoff with `waitReason: {kind:'backoff'}` surfacing
   (`respawn-circuit-breaker.ts`, §6.3) BEFORE the session lock.
2. **Session lock with recovery metadata** (`acquireSessionLock(..., {operation:'respawn',
   recoveryReason, turnId, adapterGeneration})`) — richer than the reconciler's plain
   `getSessionMutex().acquire(id, 'runtime-change')`.
3. **Abort checks** (`shouldAbortRespawn`) at multiple points (post-lock, post-CLI-resolution)
   — an instance terminated mid-respawn must not be resurrected (the A7 race class).
4. **Pre-respawn snapshot** (`createSnapshot(..., 'pre-respawn', ...)`, C5).
5. **`planSessionRecovery`** — a strictly richer continuity planner than `planContinuity`:
   consumes `sessionResumeBlacklisted`, `providerSessionPersisted`, `resumeCursor`, and a
   `computeResumeConfigFingerprint` guard; yields `native-resume | provider-fork | fresh-*`.
6. **Interrupt boundary events + waitReason** (`emitInterruptBoundary`, `queueUpdate` with
   `interruptPhase`/`recoveryMethod`/`strategy`) — renderer-visible interrupt phases.
7. **Fresh-fallback ordering** identical to the reconciler's (terminate → fresh options →
   `writeThroughIdentityLocked` → readiness → replay history), plus a premature-restore block
   while the fresh session is not yet persisted.

## Design

**Reconciler grows a second entry point, not a bigger first one:**
`applyRecoveryRespawn(instanceId, plan: RecoveryRespawnPlan)` in `runtime-reconciler.ts`, where
`RecoveryRespawnPlan` = `{ continuity: 'native-resume'|'provider-fork'|'fresh', sessionId,
newSessionId, hasConversation, replayReason, lockMetadata, onPhase?: (phase) => void }`.
- The handler stays the owner of: breaker/backoff, abort checks, `planSessionRecovery`,
  interrupt-phase bookkeeping, and post-respawn turn bookkeeping. It computes the plan, then
  delegates the terminate→spawn→fallback→persist core to the reconciler.
- The reconciler core extracted from today's `applyRuntimeChange` spawn block into a shared
  private `executeRespawn(...)` used by BOTH `applyRuntimeChange` and `applyRecoveryRespawn`
  (behavior-preservation first: extract, keep `applyRuntimeChange` tests green, then delegate
  the handler).
- The session-mutex ownership rule stands: the handler must NOT hold the mutex when calling the
  reconciler (non-reentrant; SessionMutex deadlock incident). The lock acquisition moves into
  `applyRecoveryRespawn` via an injected `acquireLock` so the handler's richer lock metadata is
  preserved.
- No behavior change to `respawnAfterUnexpectedExit` in this change (item 3).

## Tasks

- [x] Re-read in full at execution time: `interrupt-respawn-handler.ts`, `runtime-reconciler.ts`,
      `session-recovery-planner.ts` (planSessionRecovery), `respawn-circuit-breaker.ts`, and the
      existing interrupt specs (`interrupt-respawn-handler.spec.ts` orbit).
- [x] ~~Extract `executeRespawn` core~~ **Deviation (as-built):** `applyRuntimeChange` was left untouched this change; `applyRecoveryRespawn` is a sibling entry point owning the recovery spawn core. Unifying the two cores is deliberately deferred until item 3 puts both recovery shapes side by side (behavior-preservation-first; a premature shared core needed ~10 injection points).
- [x] Add `applyRecoveryRespawn` consuming the handler-computed request + 4 injected hooks (shouldAbort/onAborted/waitReady/deliverContinuity). **Deviation:** the session lock stays acquired by the HANDLER (it needs pre-lock breaker + post-lock abort/snapshot/plan work); the reconciler ASSERTS the lock is held (loud-fail recovery-entry contract) instead of re-acquiring the non-reentrant mutex.
- [x] Delegate `respawnAfterInterrupt`'s spawn core; breaker/abort/phase logic kept; duplicated spawn block deleted. `postSpawnProviderSessionId` added to the request so the provider-fork case records the NEW forked id (matches original line-858 behavior).
- [x] Specs: handler spec wires `applyRecoveryRespawn` to a REAL RuntimeReconciler over the same fake state (fallback-ordering E2E still exercises real logic, 31/31); new `runtime-reconciler.recovery.spec.ts` (9 tests: lock contract, native success flags, listener-strip-before-terminate ordering, fresh identity + writeThroughIdentityLocked(null cursor), no-conversation, replay preamble, error propagation, 3 abort checkpoints, identity-write tolerance, inline-send). Original ask was: extend the handler spec matrix (native resume, fork, blacklist→fresh, fresh-fallback
      on spawn error, abort-mid-respawn, writeThroughIdentity failure tolerated) against the
      delegated path; reconciler-level spec for `applyRecoveryRespawn` with a stub lock.
- [x] Canonical verification checklist (tsc ×2 clean, lint clean, LOC clean, instance dir 853 green; full quiet suite as final gate — see loop record).
- [x] Livetest doc written: `2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest.md`.

## Acceptance

- `respawnAfterInterrupt` contains no direct adapter create/spawn/terminate calls — the
  reconciler core is the single spawn owner for this path.
- Interrupt phases, waitReason surfacing, breaker backoff, abort semantics, and
  `writeThroughIdentityLocked` ordering are behavior-identical (spec matrix green unchanged
  BEFORE cleanup, per the spec's behavior-preservation-first constraint).
- Canonical checklist green; livetest doc written; plan renamed `_completed` last.
