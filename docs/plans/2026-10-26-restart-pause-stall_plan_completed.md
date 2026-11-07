# Restart pause stall repair

Status: implemented and verified, uncommitted. Installed-app/provider confirmation is deferred to [the live check](2026-10-26-restart-pause-stall_livetest.md). Request: pause remained at Writing notes 0 of 15 for more than five minutes.

## Evidence and intended behaviour

The running app was restarted during collection: its durable batch remained collecting until startup converted it to ready. No agent note was saved. Historical logs do not establish the exact operation that stalled that batch.

The executing path does establish two reproducible problems: queue pause waits behind landing checks/hooks with fifteen-minute command budgets before ordinary sessions reach note collection; note cancellation aborts a signal but does not bound an awaited provider send that ignores cancellation.

Keep the existing queue ownership and checkpoint rules. Cancel pre-promotion queue checks/hooks, await their child-process cleanup and restore the item checkout before releasing its lock. Finish any promotion already in progress. Keep paused documents resumable without recording a failed round. Request every queue run to pause before awaiting their shared landing queue, and drain every checkpoint attempt even after one fails. Publish the current collection stage so the shared presentation can distinguish stopping background work from writing notes. Bound note dispatch and settling with the existing deadline utility and retain the cleanup proof before ready.

Risks: interrupted hooks must not leave writers running; cancellation must not race promotion; manual session pickup must keep its new turn; failure must never be shown as safe to restart. No installed-app restart, commit, branch or worktree is authorised by this repair.

Independent review reproduced a restoration-error race with a real Git index lock: asynchronous landing-error recovery could queue behind Pause and let Pause return first. Recovery now remains inside the original item lock, and unresolved cleanup makes Pause fail rather than bypass it. The permanent regression checks blocked recovery, persistent failure and successful retry.

A second independent executable check reproduced a retry gap: an engine may have already persisted paused before its checkpoint fails, so discovery of only running engines omitted its unfinished cleanup. Collection now rechecks the current batch's recorded engines on retry, including a paused loop's still-active iteration/adapter. Unrelated previously paused engines remain outside the batch. Verification includes real service/runtime/run-control retry composition, persistent failure followed by successful cleanup, and a paused loop with an unfinished round.

## Work

- [x] Reproduce queue wait and ignored note-cancellation signal; run existing focused tests before edits.
- [x] Cancel queue checks/hooks and preserve resumable work; add regression coverage.
- [x] Bound note cancellation and show truthful stopping progress; verify runtime before updating tests.
- [x] Run focused and canonical project verification, then fresh independent task-completion-gate review.
- [x] Record evidence and any genuine installed-app live check deferral; complete document lifecycle only after verification.

## Verification

Focused: queue process/landing/pause tests, global pause runtime/service tests, Work control component tests. Required final checks: main and spec typechecks, lint, TypeScript size guard, UI hints, main and renderer builds, full quiet tests. Use existing quiet runner and retain logs in ignored scratch storage. No tests may be weakened to obtain a pass.

Final evidence: the focused pause suite passed 114 tests in eight files (`_scratch/test-run.pid-10318.log`); actual service/runtime/run-control retry verification passed (`_scratch/test-run.pid-44338.log`, verified source retained in scratch). The final fresh reviewer independently passed 76 tests in five files plus 110 component/coordinator tests in two files.

All seven non-test canonical gates exited 0 in `_scratch/restart-pause-final-verification.json`, including both builds. The final full command (`AIO_TEST_MAX_FORKS=2 AIO_TEST_OUT_SUFFIX=restart-pause-final AIO_TEST_SUMMARY=0 npm run test:quiet`, through RTK) exited 0: 35,396 passed, zero failed, eight existing pending tests outside this repair; 2,793 passed files and one skipped file. Raw output: `_scratch/test-run.restart-pause-final.log`; JSON: `_scratch/test-results.restart-pause-final.json`; command exit: `_scratch/restart-pause-final-full-result.json`.

Fresh independent verdict: **PASS**, no unresolved actionable findings, in `_scratch/restart-pause-fresh-gate-round3.md`. All 18 reviewed repair files remained unchanged through final verification. Checks used the existing shared dirty checkout and installed dependencies; no clean reinstall is claimed. Earlier interrupted full runs are not passes. An earlier completed full run failed one unrelated plugin-page initialization test in concurrent work; its owner corrected test initialization without removing assertions, and the complete replacement run passed. The prior failure is preserved under `_scratch/restart-pause-plugin-old-*`; this repair did not edit plugin files.

## As-built call paths

- Queue cancellation starts before the item lock wait (`src/main/plan-queue/plan-queue-item-flow.ts:168`); recovery remains within the landing operation (`src/main/plan-queue/plan-queue-item-landing.ts:78`) and strict checkpoint failures propagate (`src/main/plan-queue/plan-queue-item-flow.ts:600`).
- All queue stops are requested before awaiting their shared chain (`src/main/global-pause/global-pause-runtime.ts:156`). Durable recorded engines remain in retry scope (`src/main/global-pause/global-pause-service.ts:122`), and already-paused loops still drain (`src/main/orchestration/loop-work-admission.ts:22`).
- Note dispatch and settling share the existing 180-second bound (`src/main/global-pause/global-pause-runtime.ts:253`), followed by stop verification. Collection stage is published before and after engine cleanup (`src/main/global-pause/global-pause-service.ts:107` and `:135`); the shared presentation renders its plain label (`src/renderer/app/core/state/global-pause/global-pause-presentation.ts:10`).

Installed-only confirmation remains in the linked live-check document. No installed-app restart, deployment, commit or push occurred. Verification processes and their process groups were confirmed stopped.
