# Loop auto-unstick (bounded self-steer)

Status: completed 2026-09-20. Live checks deferred to [2026-09-02-loop-auto-unstick_livetest.md](./2026-09-02-loop-auto-unstick_livetest.md) (2 open).
Date: 2026-09-02

## Problem

A running CRITICAL (especially signal G — same tool, same args, dozens of
times) currently asks the operator for a hint. That is the wrong first move.

User-started loops are review-driven. They skip the structural no-progress
pause because quiet convergence looks like a stall. The review-driven stall
guard also resets whenever any production file changes — so a 43× `Edit`
thrash never pauses, never terminalizes, and the HUD just sits on "Give a
hint" while the next iteration repeats the same call.

Opt-in escapes (branch-and-select, plan regen) are off by default. Mid-iteration
steering is not available: no loop provider accepts live input. The cheapest
always-on recovery is a bounded next-iteration nudge.

## Decision

On a fixable CRITICAL, inject one orchestrator intervention for the next
iteration before asking the operator. Cap at 2 attempts per stall streak.
Reset the count on an OK verdict or a passing verification. Yield to an
already-queued human hint.
Do not treat review-driven signal A (identical work hash / quiet
convergence) as stuck.

Eligible CRITICAL ids: `G`, `B`, `E`, `I`, `D`, `D-prime`, `H`. Signal `A`
(identical work hash) is left to pause, plan-regen, and branch-select.

After the cap, existing behaviour remains: gated loops pause; review-driven
loops keep running and the card asks for a hint.

The HUD, while an auto-unstick is in flight for the last completed
iteration, says the loop is already changing approach. Hint stays available
but is not primary.

Live HUD checks that need a rebuilt app are in
[2026-09-02-loop-auto-unstick_livetest.md](./2026-09-02-loop-auto-unstick_livetest.md).

## Files

- `src/main/orchestration/loop-auto-unstick.ts` — decide + inject
- `src/main/orchestration/loop-coordinator.ts` — call before the CRITICAL pause;
  restore the attempt count from persisted `state.autoUnstick`
- `src/main/orchestration/loop-completion-context-store.ts` — in-memory streak
- `src/shared/types/loop-state.types.ts` — `auto-unstick` source + `autoUnstick`
- `packages/contracts/src/schemas/loop-auto-unstick.schemas.ts` — extracted so
  `loop.schemas.ts` stays inside the LOC ratchet
- `src/renderer/app/features/loop/loop-issue-diagnosis.util.ts` — card copy

## As-built

`runLoopAutoUnstick` runs after the review-driven stall guard and before the
gated CRITICAL pause. A successful inject emits `loop:auto-unstick`, writes
`state.autoUnstick`, and skips pause. Signal A is never eligible, so
plan-regen and branch-select keep that path.

The attempt count lives in `LoopCompletionContextStore` and is restored from
`state.autoUnstick.attempt` on checkpoint load so a restart cannot inject two
extra nudges. The count is not a separate checkpoint column; `LoopState` is
already in `state_json`. Recovery emits a post-decision `loop:state-changed`
event so checkpoint persistence cannot retain the previous attempt cap.

HUD: `autoUnstick.seq === lastIteration.seq` means in flight. The card then
says the loop is changing approach and leads with **See why**.

## Reopened verification finding (2026-09-03)

The initial implementation reset the attempt streak and erased the persisted
`autoUnstick` state when a CRITICAL contained only an ineligible signal such as
signal A. That contradicted the two-attempt-per-stall-streak rule and allowed an
alternating G → A → G sequence to bypass the cap, especially after restart.
The plan is active again until regression coverage, canonical verification, and
the independent completion gate all pass.

The first fresh completion-gate pass also found that recovery cleared the
attempt only in memory after the ordinary per-iteration checkpoint event. The
coordinator now broadcasts whenever `state.autoUnstick` changes, including the
clear path. A coordinator integration test captures immutable event-time values
and verifies that the recovered state is visible to checkpoint listeners.

The second fresh completion-gate pass confirmed that persistence fix, then
found that a successful nudge was logged as `verify-passed`. The coordinator
now records the suppression reason as `auto-unstick`, with an integration
regression covering the event. The live-test document also links to this active
plan filename until completion verification permits the `_completed` rename.

The third fresh completion-gate pass found an early pause path: passing verify
followed by a fresh-eyes infrastructure error paused for operator review before
the recovery reset ran. Recovery reset and its persistence broadcast now happen
before that pause, without allowing a non-recovery pause to inject a nudge. A
coordinator regression covers the passing-verify/reviewer-error combination.

## Current verification (2026-09-03)

- Focused auto-unstick surface: 6 files, 108 tests passed.
- Renderer and spec TypeScript checks: passed.
- Lint, TypeScript LOC ratchet, and `build:main`: passed.
- Repository-wide `test:quiet`: 20,788 of 20,791 tests passed. The remaining
  failures are two Node 26 SEA/postject repeatability tests and the
  context-worker import-closure ceiling, all outside the auto-unstick surface.
  The two transport-classifier failures seen in an earlier run passed both in
  isolation and in the final post-fix full run.

The plan remains active because the repository-wide gate is not green. Those
unrelated failures have not been modified as part of this implementation.
The fourth fresh completion-gate review found no remaining actionable issue in
the auto-unstick scope; its strict verdict remains blocked by that same
repository-wide Gate 0 failure.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.
