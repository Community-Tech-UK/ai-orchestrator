# Loop turn timeout recovery specification

Status: completed. Plan: [2026-09-24-loop-turn-timeout_plan_completed.md](../plans/2026-09-24-loop-turn-timeout_plan_completed.md).

## Incident

Session `xdl3a32l2` ran an active first review-driven iteration past its 30-minute checkpoint. The 60-minute wall limit rejected before the interrupted provider could return the workspace observation. The loop paused with unknown effects, zero completed iterations, and zero recorded usage despite visible work.

## Requirements

1. Prompts tell each child to finish a coherent, bounded work slice and return a resumable handoff before the iteration deadline. Review-driven first turns omit later-iteration directives.
2. Timeout requests provider interruption and gives its callback a short bounded grace to return workspace evidence and usage. A timed-out response is always degraded, even if the adapter returns a success-shaped partial response. Missing evidence stays unknown and pauses safely.
3. The UI explains that the configured iteration timeout is an activity checkpoint with a hard wall cap at twice that value. Terminal summaries distinguish recorded usage from work done when a failed attempt has no usage snapshot.
4. Preserve existing loop ownership, no-replay safety, unrelated workspace edits, and normal accounting for completed turns.

## Acceptance

- [x] Focused tests cover first-turn/later-turn prompt placement, timeout settlement with and without evidence, aggregate-only usage retention, and failed-attempt summary wording.
- [x] Main and spec TypeScript, lint, the TypeScript LOC ratchet, main and renderer production builds, and the full quiet test suite pass.
- [x] A genuinely fresh independent completion review reproduced the focused and canonical gates and returned `VERDICT: PASS` with no findings.
- [x] No restarted-app, human, or external-service check is required for this change.

## As built

- Child prompts require bounded, coherent slices and a resumable handoff; the first review-driven turn retains the goal while omitting later-only instructions.
- Timeouts interrupt both owned and borrowed adapters, wait no more than 30 seconds for settlement evidence, preserve returned evidence and usage, and remain failed/degraded. Missing evidence remains unknown and pauses safely.
- Aggregate-only usage is merged into timeout error evidence before failed-attempt charging, while detailed usage keeps model pricing and estimation semantics.
- UI copy describes the twice-checkpoint hard cap plus settlement grace, and summaries distinguish recorded zero usage from an absence of work evidence.
- Focused verification passed 8 files / 182 tests. The final local and independent full suites each passed 2,223 files / 26,480 tests; the independent log is `_scratch/test-run.pid-86453.log`.
