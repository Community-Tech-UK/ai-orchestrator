## Snapshot of 2026-10-27-cursor-empty-completed-investigation_history.md

# Cursor empty-completed investigation: round history

## 2026-11-10: tool access restored; genuine failure shapes captured

Decision recorded by James: keep the plan open, retry later, no account or billing change. Done as
instructed: one fresh bounded probe, no login, no account/billing/permission change, browser
opening disabled (`NO_OPEN_BROWSER=1`), permission requests would be cancelled (none arrived).

Evidence: `2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-10-access-restored/`
(`cursor-raw-probe.mjs`, `wire-shapes-first-read-probe.json`, `wire-shapes-two-prompts.json`, check logs).
`cursor-agent 2026.10.22-27dcf5f`, raw ACP over stdio against the existing account. Two sessions,
three prompts in total, every provider PID confirmed gone afterwards; the disposable workspace was
`_scratch/cursor-probe-ws` in the worktree.

Genuine wire shapes (strings redacted to lengths, keys and enums kept):

1. Native read of a missing file: `tool_call {kind: read, status: pending, rawInput {path}, locations}` ->
   `tool_call_update in_progress` -> `tool_call_update completed` with **no `rawOutput` and no `content`**.
   The model's own text then said "Error: File not found". The failure reached only the model;
   the wire carries no failure signal. This is the "empty completed" report, reproduced.
2. Shell `ls --<invalid option>`: `tool_call {kind: execute, rawInput {command}}` -> `in_progress` ->
   `completed` with `rawOutput {exitCode: 1, stdout: '', stderr: <text>}`. It ran without a
   `session/request_permission` request on this account (zero permission requests across all prompts).

Adapter trace (real `AcpCliAdapter.handleToolCallCreated/handleToolCallDelta` replay of those shapes):

- Read: emits `tool_use` (no minable command) and a hidden `tool_outcome {is_error: false}`; no
  visible `tool_result` (nothing rendered). `extractToolInvocations` and `mineCorrections` return [].
  By design (`acp-tool-call-material.ts` `classifyAcpToolOutcome`: non-command tools fail only when
  the server says `failed`) and because the provider gave no signal. Nothing is discarded; inferring
  an error from emptiness would manufacture evidence.
- Shell: visible `tool_result` carries stderr and "(exit code 1)"; metadata `exitCode: 1`,
  `is_error: false` by the shared rule in `shared/tool-outcome.ts` (a status the command supplied is
  neutral; only a failed check, a failed status with no exit, a timeout or a signal is an error). The
  miner extracts the invocation with `isError: false`; `ls` is an exploration command anyway.
- Archive: hidden outcome routed through the side store and `getCompleteInstanceMessages` appears
  once, outside the visible buffer (new spec). Real `HistoryManager` archive/reload over these
  events was not re-run; `history-manager.spec.ts`/`complete-instance-messages.spec.ts` cover it.

Conclusion: no discarded failure signal exists. The only "loss" is on the provider side (Cursor's
terminal update for a failed native read has no output and status `completed`). No production change.
Provider limitation documented here and in the plan Status. Not captured: a cancelled call, a
permission request/denial shape (no request was issued), an eligible fail->fix shell pair with
classifiable error text (the exit-code rule makes a non-check exit neutral by design).

Regression added: `src/main/cli/adapters/acp-cursor-captured-failure-shapes.spec.ts` (3 tests) pins the
two captured shapes through the real adapter, miner and side-store/archive assembly.

Checks (worktree, `npm run checks` via the Windows PC): typecheck, typecheck:spec, lint,
check:ts-max-loc, check:ui-hints, build:main, build:renderer all exit 0 (before the spec's third test
was added; typecheck, typecheck:spec, lint, ts-max-loc re-run after: exit 0). Focused tests (7 files,
338 tests) exit 0. Full suite not run (verifier's job).
