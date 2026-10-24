# Codex exec progress repair

Status: source implementation and in-loop verification completed on 15 October 2026. Second fresh independent completion gate: PASS, no unresolved actionable findings. Work remains uncommitted in the original checkout; no branches or worktrees were created.

## Evidence and scope

Before repair, the reported Myshellarts session selected exec because hardened mode was enabled. Its native rollout contained assistant progress messages absent from Harness. Exec stdout published only legacy item.created command starts; stderr diagnostics published immediately. The mode-selection log incorrectly called deliberate hardened selection unavailable.

## Acceptance and tasks

- [x] Trace the affected session, native rollout, transport selection and output path.
- [x] Reproduce missing live output using a real local child process before editing production code.
- [x] Publish completed assistant/reasoning items, current and legacy command starts, tool results, edits and MCP activity during exec; keep complete request/response transcripts and prevent close-time duplication.
- [x] Keep accepted-input, cancellation, timeout and resume behavior intact; test split lines and output before close.
- [x] Correct selection diagnostics without changing hardened-mode policy.
- [x] Verify the real process path, then add regression tests. Run focused tests and all canonical project gates, retaining logs.
- [x] Obtain a fresh independent task-completion-gate PASS; fix findings and repeat with a fresh reviewer.
- [x] Record actual evidence and any genuine restarted-app check in a livetest document, then close this plan.

## Risks and verification

Verified risks: duplicate final messages, lost tool pairing, treating progress as turn completion, output after cancellation, and buffering around stdin acceptance. Native child fixtures prove output arrives while the child is still alive and exactly once after completion. Existing input/cancellation/timeout suites cover lifecycle safety. No provider API calls or changes to the Myshellarts project were made.

Installed-app validation is deferred to [the live-check document](2026-10-15-codex-exec-progress_livetest.md).

## As built

- `codex/exec-output.ts` maps native item boundaries to assistant/thinking/tool output, pairs tool IDs, marks failed commands/edits, deduplicates items, and preserves multiline legacy fallback blocks with the canonical parser.
- `codex/exec-process-runner.ts` owns one projector per child, processes only accepted-input output, flushes close/partial-timeout tails, and labels fully published responses.
- `codex-exec-adapter.ts` retains full response/usage/completion data while avoiding close-time replay of published output.
- `codex-app-server-adapter.ts` logs deliberate hardened subprocess isolation accurately; transport and sandbox policies remain unchanged.
- `codex/codex-exec-progress.spec.ts` covers native before-close publication, completion deduplication, failure flags, split/unterminated lines, reasoning, legacy tool/thinking/text results and JSON/legacy timeout tails.

## Verification evidence

- `_scratch/codex-exec-progress/reproduce.ts` failed before production changes (no progress before child close), passed afterward (progress before close, full response retained).
- Focused suites pass: `_scratch/test-run.pid-53309.log`; native child output, split/unterminated lines, reasoning, tool error flags, no duplicate close output, prior cancellation/input acceptance/resume cases.
- Timeout-tail regression first failed in `_scratch/test-run.pid-51973.log`, then passed after flushing the buffered final item on partial timeout.
- Initial canonical gates and their exit results are retained in `_scratch/codex-exec-progress/verification.json`; intermediate changed-file checks in `final-verification.json`. Corrected-version evidence below supersedes those initial runs.
- Native rollout cross-check: the two screenshot errors occur in child-agent tool outputs at 08:58:45.045Z (duplicate target) and 09:04:14.009Z (expected text missing). The root rollout continued producing assistant updates afterward. They are rejected patch attempts, separate from the Harness output-publication defect; no patch validator bypass or rewriting is part of this repair.
- First independent completion review returned FAIL with two compatibility findings: multiline plain-text tool/thinking blocks were split during projection; dynamic-tool results carried in `text` were replaced by a summary. Reproduced in `review-probe.log` and `review-native-probe.log`. Repaired by buffering only legacy plain text until a native event boundary/close (including partial timeout), parsing each complete fallback block with the canonical parser, and restoring the supported `text` result field. Native rechecks pass; added native-child regression cases. Both findings were cleared by the second fresh review.
- Corrected-version focused tests: 5 files / 32 tests pass in `_scratch/test-run.pid-64054.log`. All seven canonical gates pass in `_scratch/codex-exec-progress/verification-round2.json`; full suite: 2,533 files, 32,302 passed, 7 existing skipped, exit 0 (`_scratch/test-run.pid-68601.log`). Source and compiled native probes also pass for before-close JSON output and legacy multiline tools. Corrected source hashes are in `review-scope-round2.json`.
- First review dependency qualification: read-only `npm ls` exited 1 for existing nested constraints on development tools. Installed versions match both lockfiles; this task changed no manifest, lockfile or installed package. No clean-install claim is made. Required canonical build/lint/type/test gates pass.
- Second fresh independent completion gate returned **VERDICT: PASS** with no unresolved actionable findings. It independently ran all seven canonical commands, all exit 0 (`review2-verification.json`), including the unfiltered full suite: 2,533 files, 32,302 passed, 7 existing skipped (`_scratch/test-run.pid-48660.log`). Source and compiled native probes, mixed legacy/native boundary/unterminated-close checks, scoped credential scan and a 10,000-message projection smoke also pass. Report: `_scratch/codex-exec-progress/review2-report.md`.
- After independent verification, all five scoped source hashes still matched `review-scope-round2.json`. Unrelated dirty work was preserved; no staging, commits, pushes, app installation or restarts were performed.
