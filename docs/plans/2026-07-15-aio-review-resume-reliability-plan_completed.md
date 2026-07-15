# AIO Review and Resume Reliability Plan

Status: Completed (automated verification complete; restarted-app checks deferred)

## Problem

Two AIO defects combined in the reported Codex session:

1. Cross-model review buffers every normalized assistant event as a new message. Codex streaming emits both an accumulated snapshot and the corresponding raw delta for the same message ID, so the review input repeats prefixes, grows quadratically, is truncated, and can produce irrelevant findings. The review also uses the first retained user prompt rather than the current turn.
2. Static stdio MCP servers copied into Codex configuration have no startup deadline. An unavailable LSP server can therefore hold Codex in MCP tool discovery until AIO's much later stuck-process restart, leaving the submitted turn without an answer.

## Design

### Cross-model review

- Buffer assistant output by stable message ID and replace the content for that ID with `metadata.accumulatedContent` when present.
- Preserve first-seen ordering across distinct assistant messages.
- Bind each review request to the latest non-empty user message and use that message as the task description.
- Before publishing a review result, verify that no newer user message has superseded the request. Discard stale results quietly and clear their context.
- Emit a quiet terminal discard event and correlate every terminal event by review ID and dispatch time, so the renderer clears only the completed review and preserves latest-turn ordering across overlaps and renderer reloads.

### Static Codex MCP configuration

- Preserve explicit Codex MCP startup/tool timeouts when supplied.
- Apply a short bounded startup timeout to static stdio servers when none is supplied, so unavailable optional tools fail open during discovery.
- Keep URL-based servers and explicit settings unchanged.

## Risks

- Message-ID reuse could replace output that should be separate; ordering and fallback behavior require focused tests.
- Stale-result suppression must not drop a review when no newer user turn exists.
- TOML parse/serialize changes must round-trip existing configurations and must not overwrite explicit timeout values.
- The timeout must cover startup only, not legitimate long-running MCP tool calls.

## Verification

- Baseline focused review, event-forwarding, static MCP conversion, and Codex TOML editor tests passed before changes.
- Final focused regression gate: 5 files, 92 tests passed.
- Application and spec TypeScript checks passed.
- Lint, TypeScript max-LOC, IPC channel synchronization, and `git diff --check` passed.
- Final unsharded suite: 1,361 files, 13,410 tests passed.
- Full production build passed for renderer, Electron main/preload, desktop helper, worker distributions, loop-control, and `aio-mcp`. The existing Angular initial-bundle budget warning remains unchanged.
- Independent completion review passed after exercising overlap, duplicate-event, renderer-reload, and stale-publication orderings.
- Restarted-app/provider checks remain in [2026-07-15-aio-review-resume-reliability-plan_livetest.md](./2026-07-15-aio-review-resume-reliability-plan_livetest.md).

## As Built

- Review buffering now stores one canonical entry per provider message ID. Streaming snapshot/delta pairs replace that entry with `accumulatedContent` instead of appending repeated prefixes.
- Review requests use the latest non-empty user message and carry its identity. Results whose source turn was superseded are discarded before history or UI publication.
- Review lifecycle events now carry review ID and dispatch time. Renderer state tracks pending, unavailable, and settled review IDs, rejects duplicates, preserves latest-review ordering across overlaps and reloads, and clears stale visible results when a genuine new review starts.
- Codex TOML parsing/serialization preserves explicit startup and tool timeouts. Static and non-dedicated inline stdio servers receive a 10-second startup timeout when none is configured; URL-only servers remain unchanged.
- No dependencies, manifests, test-runner configuration, compiler configuration, or CI files changed.
