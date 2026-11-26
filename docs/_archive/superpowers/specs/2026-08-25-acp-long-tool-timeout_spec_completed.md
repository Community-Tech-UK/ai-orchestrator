# ACP Long-Running Tool Timeout Specification

**Status:** COMPLETED (2026-08-25) — implemented and verified; the real-provider check that
needs a rebuilt app is deferred to
[2026-08-25-acp-long-tool-timeout_livetest.md](../plans/2026-08-25-acp-long-tool-timeout_livetest.md)
and is not claimed as verified.

**Implementation plan:** [2026-08-25-acp-long-tool-timeout_plan_completed.md](../plans/2026-08-25-acp-long-tool-timeout_plan_completed.md)

## Problem

The ACP adapter treats ten minutes without a `session/update` notification as a
hung prompt and sends `session/cancel`. Copilot emits a `tool_call` update before
running a shell command but may emit no further ACP update until the command
finishes. A legitimate command lasting longer than ten minutes is therefore
cancelled even though the provider has explicitly reported active tool work.

Runtime evidence from 2026-08-25 shows this happening twice to
`rtk npm run test:quiet`: each command was cancelled exactly 600,000 ms after
its `tool_call` update.

## Required Behaviour

1. A prompt with no pending or in-progress ACP tool call retains the existing
   ten-minute inactivity timeout.
2. A prompt with at least one ACP tool call in `pending` or `in_progress` state
   uses a separate 60-minute inactivity timeout.
3. Any `session/update` continues to refresh the applicable timeout.
4. A `tool_call_update` with `completed`, `failed`, or `cancelled` status
   immediately restores the ordinary prompt timeout when no other active tool
   remains.
5. The longer tool timeout remains bounded and still sends `session/cancel`
   when it expires.
6. Existing repeating stall warnings remain unchanged so an operator can
   interrupt a long or suspicious tool before the hard timeout.
7. The behaviour applies consistently to ACP-backed providers without
   provider-specific branching.

## Implementation Boundary

The change belongs in `AcpCliAdapter`, which already owns both the request
timeout and the authoritative `toolCalls` state. No renderer, IPC, provider
factory, settings, or protocol type changes are required.

## Verification

- A red-first regression test must prove a pending tool survives beyond the
  ordinary prompt timeout and completes successfully.
- A second test must prove a pending tool is still cancelled at the bounded
  active-tool timeout.
- Existing silent-prompt and update-refresh timeout tests must continue to pass.
- Run the repository canonical verification checklist and the independent
  completion gate before closing this specification.
