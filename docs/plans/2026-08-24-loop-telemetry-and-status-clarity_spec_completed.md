# Loop telemetry and status clarity specification

Status: completed

Session evidence: `13a3a244-a75e-426f-939a-a932583c0dff` / loop `loop-1787573308530-23bd050b`

Implementation plan: [2026-08-24-loop-telemetry-and-status-clarity_plan_completed.md](./2026-08-24-loop-telemetry-and-status-clarity_plan_completed.md)

## Problem

The loop detail UI presents several internally inconsistent or false signals for Codex app-server runs. The incident's aggregate token and cost totals are correct, and the managed worktree remained isolated, but the activity telemetry and labels can mislead an operator about what the child is doing and where it is doing it.

## Required behaviour

1. Codex command and file-change tool events retain their native item identity and material input, so distinct commands and paths produce distinct tool-call hashes.
2. Command classification recognises test, lint, build, typecheck, and equivalent verification commands and reports the `verifying` phase.
3. Every emitted tool start that can be correlated with a Codex item has a corresponding result with the same identity, including successful commands with empty output.
4. Reasoning notifications produce one liveness heartbeat per provider notification, and the renderer coalesces consecutive heartbeat-only activity so useful events are not pushed out of the bounded trace.
5. User-facing iteration labels are one-based everywhere while persisted and protocol sequence numbers remain zero-based.
6. The active-run UI identifies the actual execution directory, preferring `executionCwd` and falling back to `workspaceCwd` only when no managed execution directory exists.
7. A verdict shown while another iteration is running is explicitly labelled as belonging to the last completed iteration.

## Non-goals and invariants

- Do not change persisted sequence numbers, iteration accounting, token totals, or cost totals.
- Do not change loop progress thresholds to mask bad telemetry; repair the event data at its source and retain a defensive capture fallback.
- Do not change managed-worktree lifecycle or promotion behaviour.
- Preserve compatibility with snake_case and camelCase Codex item payloads.

## Acceptance criteria

- Tests reproduce each faulty behaviour before production changes.
- Command/file tool-use records include stable IDs and exact inputs; matching results settle them.
- Empty-output command completions emit a correlation-safe result.
- A verification command produces phase `verifying`.
- Consecutive heartbeats for the same loop/iteration/stage occupy one activity entry.
- Visible active, inspector, and summary iteration labels use human numbering.
- The run configuration/activity surface displays the effective execution path.
- The running verdict pill says it is the last completed iteration's verdict.
- Focused tests and every canonical project gate pass.
- A fresh independent completion-gate review returns `VERDICT: PASS` with no actionable findings.

## As-built status

All required behavior is implemented and regression-covered. The task-owned focused suite, TypeScript checks, lint, main build, and diff check pass. The repository-wide suite passes 18,625 of 18,626 tests; its sole failure belongs to unrelated already-staged session-continuity work. The size ratchet likewise fails only on unrelated already-staged `history-manager.ts`. A genuinely fresh completion review returned `VERDICT: PASS` with no findings.
