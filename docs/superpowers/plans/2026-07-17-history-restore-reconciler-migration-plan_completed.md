# History-restore ladder × RuntimeReconciler — implementation plan (spec item 4)

**Status:** COMPLETED 2026-07-17 — the investigation finding stands as the as-built
architecture (the ladder already flows through the shared `planSessionRecovery` planner at
the create seam; no spawn-core duplication exists to migrate — forcing it through
`applyRecoveryRespawn` would conflate create and respawn lifecycles for zero dedup). The
item's code deliverables landed: `browserToolsMode` archive→restore persistence (entry
builder + both restore rungs) and three ladder regression locks (post-swap targeting,
blacklist skip, mode passthrough). Coordinator spec 10/10; tsc ×2 / lint / LOC clean; full
quiet suite as final gate (loop record). Live checks:
[`2026-07-17-history-restore-reconciler-migration-plan_livetest.md`](2026-07-17-history-restore-reconciler-migration-plan_livetest.md).
**Date:** 2026-07-17
**Spec:** [`2026-07-16-runtime-reconciler-migration_spec_planned.md`](../specs/2026-07-16-runtime-reconciler-migration_spec_planned.md), scope item 4 only.

> For agentic workers: execute inline with test-first cycles. Do not commit or push.

## Investigation finding (2026-07-17, full read of `history-restore-coordinator.ts`)

The spec asked for the native-resume / resume-unconfirmed / replay-fallback ladder to be
"re-expressed as reconciler continuity plans". The as-built code is already there in the way
that matters:

- The coordinator owns **no spawn core at all** — it is a create-path orchestrator. Both rungs
  go through `instanceManager.createInstance(...)` on NEW instance records (native rung with
  `resume: true`, fallback rung fresh). There is no duplicated terminate→spawn→fallback block
  to migrate onto `applyRecoveryRespawn` (which operates on an EXISTING locked instance).
- The continuity DECISION already flows through the shared recovery planner: the coordinator
  calls `planSessionRecovery({reason: 'history-restore', …})` (coordinator :135-153) — the same
  planner the migrated interrupt/unexpected-exit paths consume. One planner family owns
  continuity decisions across all recovery-shaped paths; the reconciler owns respawn execution;
  `createInstance` owns creation. Forcing the restore ladder through the respawn core would
  conflate create and respawn lifecycles for zero dedup (orphan-primitives lesson: surface,
  don't force).

Item 4's remaining substance is therefore: (a) regression-lock the ladder's contract at the
planner seam, including the spec's provider-swap scenario; (b) close the real continuity gap
found in review — per-instance `browserToolsMode` does not survive archive→restore.

## Tasks

- [x] `ConversationHistoryEntry.browserToolsMode?: BrowserToolsMode` (history.types), written
      by the history-manager entry builder from the live instance (with previous-entry
      carry-over across re-archival, like `runtimeSummary`), passed through BOTH coordinator
      `createInstance` calls (native rung + fallback rung). Closes the OUTSTANDING item
      "browserToolsMode not persisted across restore".
- [x] Coordinator spec regression locks (10/10 incl. 3 new): (1) a post-provider-swap-shaped entry (new provider,
      fresh post-swap sessionId, no `nativeResumeFailedAt`) attempts native resume against the
      entry's CURRENT provider/session only — and lands on the ladder's fallback rung cleanly
      when that resume dies; (2) an entry with `nativeResumeFailedAt` set skips the native rung
      entirely (blacklist respected end-to-end, not just in the helper); (3) `browserToolsMode`
      passthrough on both rungs.
- [x] Record the yolo-restore posture as reviewed: restores intentionally come back with
      `yoloMode: false` (`planSessionRecovery` gets `yolo: false`; `createInstance` gets no
      yoloMode) — safe-by-default; keep, documented in OUTSTANDING with recommendation.
- [x] Canonical verification checklist (tsc ×2 clean, lint clean, LOC ratchet clean after compressing the entry-builder addition, history suite 85 green; full suite as final gate — loop record).
- [x] Livetest doc per the spec's item-4 line: restore with a resumable session, restore with a
      dead session (replay), restore of a provider-swapped instance.

## Acceptance

- Entry builder records `browserToolsMode`; both restore rungs pass it through (spec-proven).
- The three ladder regression locks pass against the real coordinator.
- No change to ladder semantics or the planner seam (behavior preservation; existing 9
  coordinator tests pass unchanged).
- Canonical checklist green; livetest written; plan renamed `_completed` last.
