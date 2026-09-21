# ACP transport recovery

Status: Implemented and verified, 8 September 2026. Independent completion gate: PASS.

## Problem and scope

The 8 September Cursor Angular-upgrade turn ended with an HTTP/2 CANCEL error serialized as assistant text and a successful ACP end_turn. Harness displayed a notice and left the regular root session idle. Existing files and tool work must survive recovery.

## Design

Extend the existing regular-session continuation coordinator with a bounded transport-recovery policy. Eligibility requires Cursor, the exact captured HTTP/2 CANCEL serializer line, adapter truncation metadata, end_turn, and estimated rather than measured usage. Generic error discussion, unclosed code examples, and provider refusals do not qualify. Other transport signatures remain notice-only. Resume the same session with a continuation instruction, never replay the original request. Permit at most two recovery sends per manual user-turn chain, with 2s and 5s backoff. Keep accounting and completion events in the normal sendInput path.

Respect newer user input, Stop (including while idle during backoff), pause, removal, shutdown, request-count fences, context budgets, native asynchronous work, and managed-loop/child ownership. Recheck session ID, provider, and adapter generation before transport recovery dispatch. The coordinator remains the single owner of regular automatic continuation. Emit a visible recovery note when dispatching and a bounded-exhaustion note when appropriate.

## Acceptance and verification

- [x] Reproduce the existing dropped-stream idle behavior through the real coordinator.
- [x] Implement transport policy and bounded continuation with cancellation fences.
- [x] Verify runtime behavior with synthetic completion events before updating tests.
- [x] Cover successful recovery, exhaustion, manual reset, duplicate events, refusal/quoted error rejection, Stop/backoff/preflight, pause, async work, and loop ownership.
- [x] Run focused tests and canonical typechecks, lint, LOC check, main/renderer builds, full quiet suite.
- [x] Fresh independent task-completion-gate review returns PASS; resolve every actionable finding.

No branch/worktree, commit, push, deployment, or running-app restart is part of this task. Unrelated automation edits in the working tree are preserved.

## Final evidence and limits

- `_scratch/acp-transport-recovery/reproduce.ts --expect-recovery` against the real coordinator: before implementation exit 1 with 0 continuation sends; after implementation exit 0 with 1 continuation send and preserved-work instructions.
- Focused suite: 3 files, 83 tests passed, exit 0; `_scratch/test-run.pid-16573.log`.
- No adapter-internal replay: regular input admission, history, accounting, context budget, and settlement remain owned by the existing InstanceManager/InstanceCommunication path.
- Stop emits a synchronous safe-observer event before the lifecycle handler, even if the idle handler rejects interruption. The next manual input resets suppression.
- Both typechecks, lint, LOC and main build: exit 0; `_scratch/acp-transport-recovery/{typecheck,spec-typecheck,lint,loc,build-main}-final.log`. Renderer build: exit 0; `build-renderer.log` in the same directory, with the existing bundle-size warning.
- Final full suite: exit 0; 2,027 files, 22,496 tests passed, zero failures, one existing platform-specific skip. `_scratch/acp-transport-recovery/full-tests-final.log`, raw `_scratch/test-run.pid-44891.log`, JSON `_scratch/test-results.pid-44891.json`. Command used installed NVM Node 24.15.0 with `AIO_TEST_NO_CACHE=1 AIO_TEST_MAX_FORKS=6 npm run test:quiet`.
- Earlier attempts remain recorded: initial run encountered in-process stale transforms during implementation and concurrent title changes, plus Homebrew Node binaries lacking the SEA injection fuse. Targeted SEA/title/recovery rerun with NVM Node passed 69 tests. A subsequent serial full run was explicitly interrupted (exit 130) before the final six-worker run; it is not passing evidence.
- Fresh reviewer `/root/transport_completion_gate`: VERDICT PASS, no unresolved actionable findings. Independently exercised the built coordinator, 83 focused tests, two communication cancellation tests and four budget tests; independently inspected full-suite JSON and canonical logs. Review preserved the dirty shared checkout and existing dependencies rather than resetting/reinstalling them.
- The updated compiled coordinator also passed `_scratch/acp-transport-recovery/reproduce-built.ts --expect-recovery`, exit 0. These deterministic runtime checks do not claim live Cursor fault injection or activation in the installed running app. The installed Harness must use an updated build on a later relaunch to receive this behavior.
