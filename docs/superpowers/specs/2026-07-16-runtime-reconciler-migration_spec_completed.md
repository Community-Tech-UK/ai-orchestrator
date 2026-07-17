# Runtime Reconciler migration + maintained handoff state — spec

**Date:** 2026-07-16
**Status:** COMPLETED 2026-07-17 — every scope item is resolved:

1. **Yolo-mode migration** — implemented & verified:
   [`2026-07-17-yolo-mode-reconciler-migration-plan_completed.md`](../plans/2026-07-17-yolo-mode-reconciler-migration-plan_completed.md)
   (+ `_livetest.md` for the renderer-visual checks).
2. **Interrupt-respawn migration** — implemented & verified; the reconciler owns the recovery
   spawn core via `applyRecoveryRespawn` (caller-holds-lock contract, asserted):
   [`2026-07-17-interrupt-respawn-reconciler-migration-plan_completed.md`](../plans/2026-07-17-interrupt-respawn-reconciler-migration-plan_completed.md)
   (+ `_livetest.md`).
3. **Unexpected-exit migration** — implemented & verified; both recovery entry points share the
   core, the handler is spawn-free:
   [`2026-07-17-unexpected-exit-reconciler-migration-plan_completed.md`](../plans/2026-07-17-unexpected-exit-reconciler-migration-plan_completed.md)
   (+ `_livetest.md`).
4. **History-restore** — resolved investigation-backed: the ladder is a create-path orchestrator
   already on the shared `planSessionRecovery` planner; deliverables were ladder regression
   locks + `browserToolsMode` archive→restore persistence:
   [`2026-07-17-history-restore-reconciler-migration-plan_completed.md`](../plans/2026-07-17-history-restore-reconciler-migration-plan_completed.md)
   (+ `_livetest.md` covering this item's three mandated scenarios).
5. **Maintained rolling handoff state** — implemented (code complete), default OFF pending the
   livetest quality comparison that decides the default:
   [`2026-07-17-rolling-handoff-state-plan_completed.md`](../plans/2026-07-17-rolling-handoff-state-plan_completed.md)
   (+ `_livetest.md`).
6. **Remote/worker provider-swap** — N/A: the swap plan's decision 6 resolved as "supported when
   the node advertises the CLI" (`docs/plans/2026-07-16-session-provider-model-swap-plan_completed.md:36`),
   so the trigger condition never occurred.

Every migration shipped one-per-change with the canonical checklist and its own `_livetest.md`,
per this spec's Constraints. Pending live validation is tracked exclusively in those livetest
docs (searchable via `*_livetest.md`).

**Depends on:** `docs/plans/2026-07-16-session-provider-model-swap-plan.md` (creates the
RuntimeReconciler module with provider/model swap as its first clients; must land first) —
**landed**, see `docs/plans/2026-07-16-session-provider-model-swap-plan_completed.md`.

---

## Why

The long-term architecture agreed on 2026-07-16: the conversation is the durable entity the
orchestrator owns; a provider/model is a replaceable runtime attachment; provider-native
sessions are a cache, never the authority. All runtime changes should flow through one
RuntimeReconciler (diff desired vs actual config → continuity plan → execution under one
mutex) instead of today's five near-duplicate terminate-respawn paths.

The provider/model-swap plan creates the reconciler and proves it with two clients. This spec
covers everything deliberately deferred from that plan because the remaining paths are the
most incident-prone code in the app (SessionMutex self-deadlock → dead sessions; 22-minute
respawn wedge swallowing user sends; init-time rollback deleting instances; respawn-promise
race in recovery). Each migration must be its own change with its own livetest gate — never
bundled.

## Scope

### 1. Migrate `toggleYoloMode` onto the reconciler
First migration; simplest path and structurally closest to `changeModel`. Retire
`pendingYoloMode` in favour of the general `desiredRuntime` field. Behavior-preservation
gate: existing yolo tests pass unchanged before any cleanup.

### 2. Migrate interrupt-respawn (one change)
`interrupt-respawn-handler.ts` `respawnAfterInterrupt` becomes a reconciler call with an
identity diff (same runtime, recovery continuity). Must preserve: interrupt phases,
`waitForResumeHealth`, fresh-fallback ordering, `writeThroughIdentityLocked` semantics.
Livetest: interrupt mid-turn, double-Escape force path, interrupt during respawn.

### 3. Migrate unexpected-exit respawn (one change)
Same handler, exit-driven entry point. Livetest: kill the CLI process mid-turn; verify no
send-swallowing wedge (see respawn-wedge incident) and prompt recovery.

### 4. Migrate history-restore fallback
`history-restore-coordinator.ts` native-resume / resume-unconfirmed / replay-fallback ladder
re-expressed as reconciler continuity plans. Livetest: restore with resumable session,
restore with dead session (replay), restore of a provider-swapped instance.

### 5. Maintained rolling handoff state
Replace the swap-time `buildReplayContinuityMessage` construction with a per-instance handoff
document maintained incrementally as turns complete: compaction-style summary + recent
verbatim turns + unresolved items + key workspace facts. Consumed by provider swaps,
compaction recovery, and history restore alike (one hydration ladder: native resume →
full-history injection where a CLI supports it → handoff document). Redaction rules follow
`context-compaction-prompt.ts`. Pull this item forward if provider-swap live testing shows
noticeable context loss.

### 6. Remote/worker provider-swap support
Only if the swap plan's decision 6 ends up rejecting provider swaps on remote instances:
add worker-side CLI availability validation and enable the path.

## Constraints

- One migration per change/PR, each with the canonical verification checklist plus its own
  `_livetest.md` before rename to `_completed`.
- Behavior preservation first, cleanup second: each migration lands as extract/delegate with
  existing tests green before dead code is removed.
- The reconciler stays the single mutex owner; no caller may hold the session mutex across a
  reconciler call (non-reentrant mutex — see SessionMutex deadlock incident).

## Non-goals

- Mid-turn swapping.
- Native cross-provider resume.
- Changes to the chats surface or mobile gateway.
