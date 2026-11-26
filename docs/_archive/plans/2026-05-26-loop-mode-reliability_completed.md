# Loop Mode Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix loop-mode completion and no-progress failures so loops can finish after valid work, fail with actionable feedback when verification rejects completion, and avoid silent hangs.

**Architecture:** Keep the existing loop coordinator, completion detector, progress detector, and default invoker boundaries. The immediate implementation focuses on the death spiral visible in May 2026 logs: null test-count stagnation, intervention completion lockout, and missing rejection feedback. Larger hardening items remain in this plan as follow-up tasks with clear acceptance criteria.

**Tech Stack:** Electron main process, TypeScript 5.9, Vitest, Zod IPC schemas.

---

## Source Merge

This plan merges:

- `claude_loops.md`: detailed diagnosis of loop completion/progress death spirals.
- `copilot_loops.md`: timeout, idle, startup-validation, restart-protection, and weak-signal hardening concerns.

The source files are removed after this plan is created so this file is the single active loop reliability plan.

## Diagnosis

The loop is not missing broad orchestration features. It is failing inside its safety gates:

- Signal D-prime treats all-null `testPassCount` windows as usable, causing false "Tests unchanged at null pass" WARN/CRITICAL decisions.
- A completion declaration made while consuming an intervention is deferred and then lost because the loop-control importer already archived the terminal intent file.
- The coordinator refuses completion whenever `consumedInterventions.length > 0`, even if verify passes and completion signals are sufficient.
- Several completion rejection paths emit UI events but do not feed concrete failure instructions back to the child.
- Per-iteration child invocation uses the total loop wall-clock cap as a single-iteration timeout.
- `streamIdleTimeoutMs` is not load-bearing enough to explain or abort idle children.
- Loop startup can allow configurations that cannot ever auto-complete.
- Restart recovery does not yet detect repeated crashed live loops.
- Some no-progress decisions rely too heavily on weak heuristic signals.

## Immediate Implementation Scope

### Task 1: Fix D-prime all-null test-count false positives

**Files:**

- Modify: `src/main/orchestration/loop-progress-detector.ts`
- Test: `src/main/orchestration/loop-progress-detector.spec.ts`

- [x] Add a regression spec proving `signalDPrime_testStagnationWithWrites` returns `null` when every iteration has `testPassCount: null`.
- [x] Run the focused spec and confirm the new test fails before implementation.
- [x] Change D-prime usable-window slicing so an all-null window produces an empty usable set.
- [x] Run the focused spec and confirm it passes.

### Task 2: Accept valid completion after consumed interventions

**Files:**

- Modify: `src/main/orchestration/loop-coordinator.ts`
- Test: `src/main/orchestration/loop-coordinator-terminal-intents.spec.ts`

- [x] Replace the old "deferred complete intent from an intervention-consuming iteration" expectation.
- [x] Add a regression spec proving a complete terminal intent can be accepted in the same iteration that consumes an intervention when verify passes and belt-and-braces gates pass.
- [x] Run the focused spec and confirm the new behavior fails before implementation.
- [x] Remove the completion lockout based solely on `consumedInterventions.length`.
- [x] Stop silently deferring complete intents only because the iteration consumed an intervention.
- [x] Run the focused spec and confirm it passes.

### Task 3: Push completion rejection feedback back to the agent

**Files:**

- Modify: `src/main/orchestration/loop-coordinator.ts`
- Test: `src/main/orchestration/loop-coordinator-terminal-intents.spec.ts`

- [x] Add specs for first verify failure, second verify failure, and completed-file rename gate failure.
- [x] Confirm each spec fails because `state.pendingInterventions` lacks concrete rejection feedback.
- [x] Add helper logic that rejects a pending complete intent and pushes one concrete intervention message per rejection.
- [x] Keep fresh-eyes blocking behavior as-is because it already pushes review findings into `pendingInterventions`.
- [x] Run focused specs and confirm they pass.

### Task 4: Split single-iteration timeout from total loop wall-clock cap

**Files:**

- Modify: `src/main/orchestration/loop-coordinator.ts`
- Test: `src/main/orchestration/loop-coordinator-terminal-intents.spec.ts` or a focused coordinator timeout spec.

- [x] Add a spec proving the child-invocation backstop uses `config.iterationTimeoutMs`, not `config.caps.maxWallTimeMs`.
- [x] Confirm the spec fails before implementation.
- [x] Change the timeout calculation and error message to report the per-iteration timeout.
- [x] Run the focused timeout spec and confirm it passes.

## Follow-Up Hardening Scope

These items are lower priority than the completion death spiral and can be implemented after the immediate tasks are verified:

- [x] Make `streamIdleTimeoutMs` activity-based by tracking meaningful stdout, stderr, tool, and provider progress events. (FU-1 — `base-cli-adapter` resets the watchdog on stderr and `heartbeat`; the loop invoker calls `adapter.noteActivity()` on meaningful adapter events.)
- [x] Reject or explicitly mark manual-review-only loop starts when no verify command exists and automatic completion is impossible. (FU-2 — `LoopState.manualReviewOnly` is set at `startLoop` and surfaced in the iteration prompt so the agent learns the constraint upfront.)
- [x] Persist restart-failure counters for live runs and pause/cancel repeated crash loops with an explainable reason. (FU-3 — migration #3 adds `restart_failure_count`; `markRunningAsInterruptedOnBoot` increments per crash and marks the loop `failed` with `crash-loop` reason at threshold; coordinator's iteration hook resets the count after a successful iteration.)
- [x] Add a confirmation/detecting phase for weak no-progress signals so one noisy heuristic cannot force a terminal-looking pause. (FU-4 — signals G/H are downgraded to WARN on first occurrence unless a strong signal also fires; standard warn-escalation confirms.)
- [x] Populate `testPassCount`, `testFailCount`, `errors`, and `toolCalls` from real CLI/verify output instead of hardcoded null or empty values. (FU-5 — `parseTestCounts` recognises jest/vitest/pytest/mocha/cargo summaries; `classifyIterationErrors` buckets common error patterns; tool calls are collected from the adapter's activity stream.)
- [x] Cover failed-only test summaries so failure counts are not lost when there are zero passes. (FU-5 follow-up — jest/vitest/pytest/mocha failed-only forms now parse as `pass: 0` with real fail counts.)
- [x] Add quick-verify versus full-verify support so routine completion attempts do not run the entire heavyweight verify pipeline twice. (FU-6 — `LoopCompletionConfig.quickVerifyCommand` + `LoopCompletionDetector.runQuickVerify`; coordinator runs quick-verify first and short-circuits the full verify on failure; renderer config can now submit the quick-verify command.)
- [x] Make fresh-eyes review opt-in rather than auto-enabled for uncompleted plan files. (FU-7 — coordinator no longer auto-enables `crossModelReview`; callers must pass `{ enabled: true }`; renderer config can now opt into the gate; source prompt/type comments no longer claim auto-enable.)
- [x] Await adapter termination on loop terminal paths to avoid orphaned children. (FU-8 — `LoopCoordinator.setAdapterCleanupHook` + `awaitTerminalCleanup`; `cancelLoop` awaits cleanup before returning.)
- [x] Clear completed-file rename observation if the rename is undone during a run. (FU-9 — `CompletedFileWatcher.onUndone` listens for unlinks of previously-observed completed files; coordinator clears `state.completedFileRenameObserved` and emits `loop:completed-file-undone`.)

## Acceptance Criteria

- [x] All-null `testPassCount` windows do not fire D-prime WARN or CRITICAL.
- [x] D-prime evaluates the latest contiguous measured suffix after an older null test count.
- [x] Failed-only test runner summaries populate `testFailCount`.
- [x] Loop config UI can submit `quickVerifyCommand` and explicit fresh-eyes review settings.
- [x] A loop that finishes immediately after consuming an intervention does not lose or defer its completion path.
- [x] Verify failures and rename-gate failures become concrete pending interventions for the next child iteration.
- [x] A single child iteration uses the per-iteration timeout, not the total loop wall-time budget.
- [x] Focused Vitest specs for modified loop behavior pass.
- [x] `npx tsc --noEmit` passes.
- [x] `npx tsc --noEmit -p tsconfig.spec.json` passes.
- [x] Lint passes for the modified files.
- [x] Full `npm run test` passes.
