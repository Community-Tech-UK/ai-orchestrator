# Loop telemetry and status clarity implementation plan

Status: completed

Specification: [2026-08-24-loop-telemetry-and-status-clarity_spec_completed.md](./2026-08-24-loop-telemetry-and-status-clarity_spec_completed.md)

## Scope

Repair the seven confirmed telemetry and presentation defects observed in session `13a3a244-a75e-426f-939a-a932583c0dff` without changing correct aggregate accounting or worktree isolation.

## Implementation tasks

1. Add failing Codex app-server notification tests for verification-phase detection, native item metadata, start/result correlation, and empty-output command completion.
2. Add a failing loop-capture test proving distinct fallback activity messages cannot collapse to one tool-call hash when an adapter omits input.
3. Add a failing renderer-store test for consecutive heartbeat coalescing without suppressing meaningful events.
4. Add failing formatter/component tests for one-based iteration labels, effective execution path, and last-completed verdict wording.
5. Update Codex notification mapping to carry item IDs and exact material inputs through both tool-use and tool-result events; correct command classification and remove the duplicate reasoning heartbeat.
6. Harden invocation capture's missing-input hash fallback with the activity message.
7. Coalesce consecutive heartbeat activity in the renderer store.
8. Centralise user-facing sequence conversion and effective path/verdict labels in pure formatter helpers, then wire the loop component to them.
9. Run focused tests after each layer, followed by both TypeScript checks, lint, max-LOC, main build, and the full quiet test suite.
10. Run the required fresh independent completion gate; resolve every actionable finding and repeat until PASS.
11. Record as-built evidence, rename this plan and its specification to `_completed`, and leave all changes uncommitted unless James separately requests a commit.

## Verification evidence (final)

- Focused regression suite: 13 files, 381 tests passed.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run build:main`: passed, including `sync-dist.js`.
- `npm run check:ts-max-loc`: every task-owned file is within tolerance; the command fails only for the unrelated, already-staged `src/main/history/history-manager.ts` (1572 lines versus 1478 + 50 tolerance).
- `npm run test:quiet`: 18,625 of 18,626 tests passed on the final snapshot. The sole failure is the unrelated `src/main/session/session-continuity.spec.ts` redaction-state assertion against already-staged session-continuity changes. The ACP stall-warning test that flaked in an earlier full run passed here as well as in its focused rerun.
- First fresh review found three additional gaps: the persisted iteration-start message remained zero-based, distinct Codex review-mode items were incorrectly modelled as one tool lifecycle, and runtime heartbeat ownership lacked direct coverage. All three now have regression tests and focused verification.
- Second fresh review found that the adapter-to-activity bridge normalised distinct missing-input tool messages before the hardened capture fallback could hash them. A bridge-level regression reproduced the collision; the translator now preserves both the display content and unsummarised fallback source content.
- Third fresh review found a zero-based persisted attempt-review end reason outside the initial UI files. The real degraded-retry path now proves a first-iteration pause is stored as `Iteration 1` while its numeric `seq` evidence remains zero-based.
- Fourth fresh review found that native multi-file Codex `fileChange.changes[]` input was collapsed to its first path. Telemetry now preserves every ordered path and available change kind, and an adapter-to-capture regression proves items that share a first path but differ later produce distinct hashes.
- Fifth fresh review corrected the native fixture further: camel file changes use object-valued `kind` plus `diff`, snake fallback uses `change_type`, and command/file terminal status can be `failed` or `declined`. The accessor now preserves those real shapes and both terminal result paths persist unsuccessful evidence.
- Sixth fresh review found that failed MCP, dynamic, and collaboration tool calls still persisted as successful; `ITERATION_LOG.md` still rendered a zero-based heading; and prior-verdict wording depended on receiving a transient iteration-start event. All status-bearing tool result paths now share the failure mapping, durable headings use one-based display numbering, and running state remains unambiguous after renderer hydration.
- Seventh fresh review found the last zero-based durable label in commit-ratchet Git messages. Ratchet commits now display `iteration.seq + 1`, with a hook-level regression proving sequence 2 becomes “iteration 3.”
- Final fresh completion review returned `VERDICT: PASS` with no critical findings, warnings, or suggestions.

## As built

- Codex app-server tool telemetry now preserves native IDs and material inputs for command, file, MCP, dynamic, and collaboration calls, including real camelCase and snake_case file-change variants.
- Every correlated terminal tool event now records failed or declined outcomes truthfully, including empty-output commands.
- Heartbeat ownership is singular, consecutive same-scope heartbeats coalesce, and review-mode transitions no longer create unresolved tool calls.
- Operator-facing and durable iteration wording is one-based across activity, pause reasons, iteration logs, ratchet commits, and renderer views; numeric protocol/evidence sequence fields remain unchanged.
- The active UI shows the effective execution directory and attributes a running loop's verdict to the last completed iteration, including state-only hydration.
- No live-test deferral is required: all requested behavior is covered by deterministic adapter, orchestration, store, formatter, and Angular component tests.

## Risk and verification notes

- Tool-result emission can affect outstanding-call tracking, so tests must cover matching IDs and empty output.
- Heartbeat coalescing must only replace an immediately preceding heartbeat with the same loop, sequence, and stage; it must never reorder or remove meaningful activity.
- One-based numbering is presentation-only. No schema or persistence migration is permitted.
- Path display must not affect execution configuration; it is a read-only projection of `executionCwd ?? workspaceCwd`.
