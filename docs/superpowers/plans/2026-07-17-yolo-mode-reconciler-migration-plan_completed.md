# YOLO-mode migration onto RuntimeReconciler — implementation plan

**Status:** COMPLETED 2026-07-17 — all tasks implemented and verified (integration spec 9/9;
instance + chats + renderer-store suites 941 tests green; tsc ×2 / lint / LOC clean; **full
quiet suite green: 1438 files / 14,238 tests, exit 0**, 2026-07-17). Renderer-visual checks deferred to
[`2026-07-17-yolo-mode-reconciler-migration-plan_livetest.md`](2026-07-17-yolo-mode-reconciler-migration-plan_livetest.md).
As-built deviations: (1) the reconciler emits `yolo-toggled` with `{instanceId, yoloMode}`
(no `pendingYoloMode` key — the wrapper's own emit carries the queued value for the renderer's
convenience field); (2) a yolo-only change suppresses the reconciler's `model-changed` emit to
match the old toggle's behavior; (3) `setYoloMode`'s no-op branch clears only the `yoloMode`
key of a queued desired runtime via `clearQueuedYoloKey` (shared with the deferred-permission
path), preserving co-queued model changes.
**Date:** 2026-07-17
**Spec:** [`2026-07-16-runtime-reconciler-migration_spec_planned.md`](../specs/2026-07-16-runtime-reconciler-migration_spec_planned.md), scope item 1 only
(**"Migrate `toggleYoloMode` onto the reconciler"**). Items 2–6 of that spec (interrupt-respawn,
unexpected-exit, history-restore fallback, maintained handoff state, remote/worker provider-swap
support) are **not** covered here and need their own follow-up plans — see the spec's Scope
section, unchanged.

> For agentic workers: execute inline with test-first cycles. Do not commit or push without
> James's explicit authorization. Do not commit this plan or the spec until this migration is
> fully implemented and verified (project plan-lifecycle rule).

## Goal

Retire the bespoke `YoloModeQueue` + `Instance.pendingYoloMode` + duplicate 198-line
`setYoloMode` respawn implementation. Route all three yolo entry points (`requestYoloModeToggle`
UI toggle, `setYoloMode` explicit-target used by `ChatService.setYolo`, and the deferred-apply
that fires when a queued toggle settles) through the existing `DesiredRuntimeQueue` +
`RuntimeReconciler` that already own provider/model/reasoning changes — exactly the pattern
`changeModel`/`requestModelChange` already establish. No change to the chats surface's calling
code (`ChatService.setYolo` keeps calling `instanceManager.setYoloMode(id, yolo)` — the spec's
non-goals exclude chats-surface changes; only `setYoloMode`'s internals move).

## Investigated behavior to preserve (read in full before editing)

- `src/main/instance/instance-lifecycle.ts:2870-3068` (`setYoloMode`) — the 198-line
  respawn-with-fresh-fallback implementation being retired. Resume decision:
  `hasConversation && capabilities.supportsResume` — **no provider/cliType exclusion**.
- `src/main/instance/lifecycle/runtime-reconciler.ts` (`applyRuntimeChange`) — the target host.
  Its `planContinuity` (via `runtime-reconciler-plan.ts`) forces `replay` for **any** Claude
  change (`cliType !== 'claude'` gate), regardless of what changed. That rule exists so a Claude
  *model* change actually takes effect (native resume reconnects to a session still bound to the
  old model). It must **not** apply to a pure yolo toggle — Claude native-resume is safe there
  since the model never changes. Blindly reusing `planContinuity` for yolo would silently drop
  Claude's native-resume-on-yolo-toggle behavior — a real regression `planContinuity`'s existing
  tests/callers would never catch (they only exercise model/provider changes).
- `src/main/instance/lifecycle/desired-runtime-queue.ts` — the generic queue `requestYoloModeToggle`
  moves onto. Gate is `isModelSwitchAllowedStatus` (idle/ready/waiting_for_input) —
  intentionally broader than the old `YoloModeQueue`'s `isSettled` (idle/ready only). Adopting
  the shared gate is a deliberate consistency improvement (single gate for all runtime changes),
  not an accidental behavior change; no existing yolo test pins the narrower set.
- Renderer read sites of `pendingYoloMode`/`desiredRuntime` (`instance-list.store.ts`,
  `instance-header.component.ts`, `instance.store.ts`, `instance-detail.component.ts`) — the
  renderer keeps its own local `pendingYoloMode` convenience field (fed by the existing
  `yolo-toggled` IPC event, unchanged wire format) rather than being rewired to read
  `desiredRuntime` directly, to keep this migration's blast radius inside the main process.
  Exception: `desiredRuntimeLabel`'s chip must not fire for a yolo-only queued change (see Task 4).
- No dedicated `runtime-reconciler.spec.ts` exists yet — model/provider-swap behavior is covered
  at the integration level in `src/main/instance/__tests__/instance-manager.change-model.spec.ts`
  (real `InstanceManager`, mocked CLI adapter factory). New yolo coverage follows that same
  pattern in a sibling file, superseding the unit-level `yolo-mode-queue.spec.ts`.

## Design

1. **`DesiredRuntime` gains `yoloMode?: boolean`.** `computeRuntimeDiff` gains `yoloModeChanged`
   (`desired.yoloMode !== undefined && desired.yoloMode !== instance.yoloMode`), included in
   `hasChanges`. Added to `RuntimeDiff` in `runtime-reconciler.types.ts`.
2. **`RuntimeReconciler.applyRuntimeChange`** computes `nextYoloMode` (desired.yoloMode ??
   instance.yoloMode), uses it everywhere `instance.yoloMode` was read for permissions/spawn
   options, and sets `instance.yoloMode = nextYoloMode` alongside the other pre-spawn field
   writes (before the try/spawn block, matching existing optimistic-set behavior for
   provider/model). Detects `isYoloOnlyChange` (yoloModeChanged with every other diff flag
   false) and for that case only, computes continuity with the **old setYoloMode formula**
   (`hasConversation && capabilities.supportsResume` → fork if supported, else plain resume;
   else replay) instead of `planContinuity`, so Claude keeps native-resume on a pure toggle.
   Any other diff shape (including a yolo change bundled with a model/provider change — see
   Task 3) uses the existing `planContinuity` untouched. Notice message: yolo-only sends the old
   exact `[System: YOLO mode enabled/disabled...]` text; otherwise sends the existing
   model/provider notice, plus the yolo notice appended if `yoloModeChanged` was also true in a
   combined change. Reconciler emits `emitYoloToggled` (new dep, wired to `this.emit('yolo-toggled', ...)`
   in the lifecycle's reconciler getter) whenever `diff.yoloModeChanged`, so the deferred
   auto-apply path (which never goes through the toggle wrapper) still notifies the renderer.
3. **`requestYoloModeToggle`** (instance-lifecycle.ts) becomes a thin wrapper: read
   `instance.desiredRuntime`, flip `yoloMode` off the *effective* value (queued-or-live), spread
   any other already-queued fields through unchanged, call `desiredRuntimeQueue.requestChange`.
   This preserves a concurrently-queued model swap instead of clobbering it (and vice versa —
   `requestModelChange` gains `yoloMode: request.yoloMode ?? instance.desiredRuntime?.yoloMode`
   so a model-change request doesn't drop an already-queued yolo flip). Emits `yolo-toggled`
   itself after the call (covers queue/cancel branches the reconciler never sees; harmlessly
   redundant with the reconciler's own emit on the immediate-apply branch).
4. **`setYoloMode`** (explicit-target, used by `ChatService.setYolo`) becomes a thin shim over
   `runtimeReconciler.applyRuntimeChange({ provider: instance.provider, yoloMode: desiredYoloMode })`
   — no queueing, matching `changeModel`'s existing shim pattern. Its busy-guard changes from a
   literal `status === 'busy'` throw to the reconciler's `isModelSwitchAllowedStatus` gate — a
   strictly more precise upfront check; `ChatService.setYolo`'s catch-and-flip-flag-locally
   fallback doesn't inspect the error text, so this is behavior-invisible to the chats surface.
5. **`resumeAfterDeferredPermission`**'s stale-queue cleanup (instance-lifecycle.ts ~3142-3152)
   moves from clearing `pendingYoloMode` to clearing only the `yoloMode` key of
   `instance.desiredRuntime` (preserving any other still-queued field; dropping the whole object
   only if nothing else remains queued), using `computeRuntimeDiff` to decide.
6. **Renderer:** `instance-list.store.ts`'s `toggleYoloMode` response handler falls back to
   `data?.desiredRuntime?.yoloMode` for the immediate-feedback `pendingYoloMode` (the field no
   longer exists on the wire `Instance`, only `desiredRuntime` does). `instance-header.component.ts`'s
   `desiredRuntimeLabel` computed gains a guard so a queued change that's *only* a yolo flip
   doesn't render a misleading "Provider · default model" chip.
7. **Delete** `src/main/instance/lifecycle/yolo-mode-queue.ts` and its spec (dead code; the
   `YoloModeQueue` import/field/getter in `instance-lifecycle.ts` and the
   `this.yoloQueue.onSettled(instance)` call are removed too). Remove `pendingYoloMode` from
   `shared/types/instance.types.ts`.

## Tasks

- [x] Read every file listed above in full (done during investigation).
- [x] `shared/types/instance.types.ts`: add `DesiredRuntime.yoloMode`, remove `Instance.pendingYoloMode`.
- [x] `runtime-reconciler.types.ts` / `runtime-reconciler-plan.ts`: `yoloModeChanged` diff field.
- [x] `runtime-reconciler.ts`: yolo-aware `applyRuntimeChange` per Design §2, `emitYoloToggled` dep.
- [x] `instance-lifecycle.ts`: rewritten `requestYoloModeToggle`, `setYoloMode`,
      `requestModelChange` yolo-preservation, `resumeAfterDeferredPermission` cleanup, remove
      `YoloModeQueue` wiring.
- [x] Delete `yolo-mode-queue.ts` + spec.
- [x] Renderer: `instance-list.store.ts` fallback, `instance-header.component.ts` guard.
- [x] New integration coverage: `src/main/instance/__tests__/instance-manager.yolo-mode.spec.ts`
      (immediate apply, busy-queue + auto-apply-on-settle, cancel, Claude native-resume
      preserved for yolo-only, notice-message text, combined model+yolo queue, explicit
      `setYoloMode` via the chats-style call, busy-status rejection message).
- [x] Canonical verification checklist (tsc main + spec, lint, LOC ratchet, targeted specs, full
      quiet suite).
- [x] Livetest doc for the one thing that can't run headless: the renderer chip/pending-indicator
      behavior in the real app.

## Acceptance

- No remaining reference to `Instance.pendingYoloMode` or `YoloModeQueue` anywhere in `src/`.
- `computeRuntimeDiff` and `applyRuntimeChange` handle yolo-only, model-only, and combined
  yolo+model diffs correctly (new integration spec).
- Claude instances keep native-resume on a pure yolo toggle (regression guard test).
- `ChatService.setYolo`'s call site and behavior are unchanged (no test edits needed there).
- Full quiet suite green; tsc (main + spec) clean; lint clean; LOC ratchet clean.
