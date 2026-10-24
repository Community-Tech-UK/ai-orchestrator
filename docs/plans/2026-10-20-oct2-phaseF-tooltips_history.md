# Phase F implementation evidence

Plan: [2026-10-20-oct2-phaseF-tooltips_plan.md](2026-10-20-oct2-phaseF-tooltips_plan.md)

## Worker scope

Worker checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-20-oct2-phasef-tooltip-094153`.
Planning documents stay in the root checkout. No commits, branch changes, merges, stashes or worktrees are authorised.
The queue coordinator owns independent verification and document completion. The worker runs targeted tests and static
checks; the full suite is reserved for the verifier.

## Task checklist

- [ ] Step 1 / H6: blocked by Phase B part 1 landing; no `scripts/check-ui-hints.ts`, baseline, wording ledger or CI hook exists here.
- [ ] Step 2 / H3: blocked by Step 1 and the missing `appIconButton` foundation. No sweep ahead of the ratchet.
- [ ] Step 3 / H4: blocked by Phase B parts 1–3 landing; the action-id tooltip inputs and part 3's literal helper are absent here.
- [ ] Step 4 / H5: blocked by Step 1 and missing `appTooltipDisabledReason`; preserve current event handling until the shared primitive lands.
- [ ] Step 5 / H7: blocked by Step 1 and the absent glossary/help-drawer foundation; avoid introducing a competing glossary.
- [ ] Step 6 / H8: blocked by Step 5 and the absent D8/D9 foundation; extend the landed guide and review angle together.
- [x] Step 7 / H9: independently implemented and worker-tested against the existing tooltip directive. Windows inspection remains open. Effort/Codex settings belong to Phase E.
- [x] Targeted tests and worker static/build gates.
- [x] Worker self-review and report/seal/command receipts; independent fresh-eyes gate remains coordinator-owned.
- [ ] Full-plan independent completion gate and full test suite (coordinator/verifier; cannot pass acceptance while Steps 1–6 are missing).

## Dependency evidence and rulings

1. Phase B's root plan Status explicitly records all seven Step 8 landings as unperformed. Its Phase 4 stack requires
   queue-owned integration of parts 1, 2 and 3 in order. `git diff --stat HEAD...queue/2026-10-10-oct-phase4-tooltips-1b2e67`
   shows a separate 125-file implementation, not an already-landed dependency. Source inspection confirms that this
   checkout has the D1 `appTooltip` primitive but none of the named ratchet, icon-button, disabled-reason, glossary,
   help-drawer, or review-guide foundations. This is a code dependency, not a human live-test deferral.
2. Ruling: do not replay or merge another AIO-managed queue branch. The explicit lifecycle restriction leaves those
   landings to the coordinator. Cost if wrong: Phase F cannot finish until that integration is supplied.
3. Ruling: implement the independent H9 copy slice now. Use the current call path as authority for timing, rather than
   copying the stale Phase 4b strings. `PlanQueueRunControl.control()` calls `holdRun()` on Pause; `holdItem()` stops writers
   before checkpointing and preserves the branch. Resume waits for pending hold cleanup before rescheduling. Cancel
   parks in-flight work and skips unstarted documents.
4. Ruling: do not promise that all agents read steering after the next tool call. Typed steering reaches
   `InstanceManager.steerInput()`, which interrupts active statuses except during provider compaction, then sends input.
   Promoting a queued message uses `InstanceMessagingStore.steerQueuedMessage()`, placing it ahead of passive messages
   and requesting an interrupt. Copy must describe this distinction. Cost if wrong: misleading delivery timing.

## As-built H9

- `tooltip-copy-plan-queue.ts` supplies centrally registered copy for Pause, Resume, Cancel, Pause all, Resume all, Skip
  and reconciler Refresh. All consumers import the real standalone tooltip directive. Existing confirmation paths and
  inline destructive consequences are retained. The older branch's five-entry module was inspected, not copied wholesale:
  its delayed-pause wording contradicts the current coordinator.
- Composer typed steering, queued steering, pending-steer state, editing and cancel/restore use the central copy registry.
  The pending-steer badge is keyboard-focusable. Typed and queued steering get different explanations because their
  delivery call paths differ. Startup copy does not suggest a Steer button which is absent; recovery copy only suggests
  Steer where `canSteerActiveTurn()` actually renders it.
- New DOM checks open real CDK tooltips and verify `aria-describedby` links for plan controls, queued steering and typed
  steering across Claude, Codex, Gemini and Copilot renderer selections. This is renderer coverage, not live-provider
  delivery certification. Three existing main/store tests confirm the shared interrupt/send, compaction and queue-promotion
  semantics. All providers use the common `InstanceManager.steerInput()` / `adapter.interrupt()` path on typed steering.
- The input-panel test override now retains `AioTooltipDirective` rather than treating its bindings as inert attributes.
  No tests, assertions or production guards were removed or suppressed. Other mocked-child unknown-property/getApi
  warnings remain visible in the retained test logs; the direct tooltip assertions and AOT build establish the new wiring.
- No standalone spec is linked by this plan. The H3–H9 backlog source was read as the acceptance context. No duplicate
  plan/spec was placed in the worktree. No dependencies were installed, and no browser, desktop app or provider login ran.

## Next coordinator action

Land Phase B's Phase 4 stack through the queue, then resynchronise this worker through AIO and resume Steps 1–6 here.
Do not accept this worker as full Phase F completion. Its source edits are uncommitted as required: a fresh verifier must
include the working-tree/new-file diff, or wait for the coordinator's commit before reviewing merge-base-to-HEAD.
No fresh-agent PASS has been claimed, and neither the plan nor this history has been renamed.

## Verification

All command receipts and full logs are under the worker's `_scratch/phasef-handoff-094153/`. The folder contains
`report.md`, `seal.json`, and individual `*.receipt.json` files. The test runner's complete per-test output is retained in
the log paths printed by its receipts. Final outputs:

```text
targeted-final: ✓ 9 files · 131 tests passed in 58.7s
steering-behavior: ✓ 2 files · 3 tests passed in 49.4s
npx tsc --noEmit: exit 0
npm run typecheck:spec (final): exit 0
npm run lint (final): All files pass linting.
npm run check:ts-max-loc: TypeScript file size ratchet passed.
npm run build:main: exit 0; Preload bundled -> dist/preload/preload.js
npm run build:renderer: exit 0; Application bundle generation complete.
npm run generate:aliases: exit 0; no generated diff
npm run generate:ipc: exit 0; no generated diff
git diff --check: exit 0
npm run check:ui-hints: exit 1
npm error Missing script: "check:ui-hints"
```

The renderer build reports an initial bundle of 1.35 MB against the 1 MB warning budget; the build exits 0. The LOC gate
passes with the repository's existing legacy tolerance; this worker did not raise any ceiling. No full suite ran, per the
queue-worker instruction. The worker's separate diff review found no further actionable issue in this slice; this is
author self-review, not the mandatory independent completion gate.

Windows keyboard/hover, screen-reader and layout checks for H9 remain unverified in the sibling
[livetest document](2026-10-20-oct2-phaseF-tooltips_livetest.md). The six missing implementation steps are code dependencies,
not deferred live tests. Build output created by this worker is removed after sealing; pre-provisioned `node_modules`
and its shared `.vite` link are preserved. No database cluster, browser binary or copied checkout was created.
