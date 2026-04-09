# Remote Session Latency Fixes — Design Spec

## Problem

Remote sessions feel much slower than local sessions. During extended thinking (deep reasoning tasks), the UI shows zero output for the entire thinking duration — sometimes minutes. After thinking completes, the burst of output messages is further slowed by per-message RPC overhead.

## Root Cause Analysis

### 1. Zero output during extended thinking

Claude CLI uses `--output-format stream-json` which emits complete NDJSON conversation-turn messages. During extended thinking, the CLI accumulates all API `thinking_delta` events internally and only emits the complete `{"type": "assistant", ...}` NDJSON line after the entire turn finishes. Between `sendInput` and turn completion, zero bytes arrive on stdout.

**Local sessions**: user sees CPU activity and trusts the process is working.
**Remote sessions**: zero data flows through the pipeline — no status changes, no output, no heartbeat. The UI shows a stale "busy" state with no indication of progress.

### 2. Per-message RPC round-trip on output

Every `instance.output` message from the worker to the coordinator is an RPC request (has `id`, expects `{ ok: true }` response). Each requires:
- JSON serialization on the worker
- WebSocket frame transmission
- Auth token validation on coordinator
- Zod schema validation on coordinator
- Response serialization and transmission back

For a typical Claude response with ~40 output chunks after thinking completes, this adds `N × network_RTT` cumulative latency.

### 3. No batching of high-frequency output

Each output event generates a separate WebSocket frame, even when dozens arrive within milliseconds of each other.

## Solution — Four Stacked Changes

### Change 1: Worker-Side Activity Heartbeat

**Goal**: Give the UI feedback that the remote instance is alive and processing, even when no stdout output is arriving.

**Mechanism**:
- `LocalInstanceManager` adds a per-instance activity watchdog timer (default: 5 seconds)
- Timer resets on every `adapter.on('output')` and `adapter.on('status')` event (any sign of life from the CLI process). Does NOT reset on `stream:idle` — that event signals prolonged silence, not activity.
- When the timer fires AND the adapter's process is still alive: emit `instance:stateChange` → `'processing'`
- This propagates through the existing pipeline: `WorkerAgent` → RPC → `RpcEventRouter` → `registry.emit('remote:instance-state-change')` → `RemoteCliAdapter.handleRemoteStateChange` → `adapter.emit('status')` → `InstanceCommunicationManager` → renderer

**New status value**: Add `'processing'` to the `InstanceStatus` union in `src/shared/types/instance.types.ts`. Semantics: "the CLI process is alive and has received input, but hasn't produced output recently." The renderer treats it identically to `'busy'` for state machine purposes but can display a distinct label (e.g., "Processing...").

**Timer lifecycle**:
- Created when `adapter.spawn()` completes
- Reset on `output` and `status` events
- Cleared on `exit` event or when instance is terminated
- Uses `unref()` so it doesn't keep the worker process alive

**Files**:
- `src/worker-agent/local-instance-manager.ts` — add watchdog timer per `ManagedInstance`
- `src/shared/types/instance.types.ts` — add `'processing'` to `InstanceStatus`

### Change 2: Handle `stream:idle` Event

**Goal**: Surface a "thinking deeply" indicator when the CLI process has produced no stdout for 90 seconds (the existing watchdog timeout).

**Mechanism**:
- In `LocalInstanceManager.spawn()`, wire `adapter.on('stream:idle')` alongside the existing `output`, `exit`, `status`, and `input_required` listeners
- On `stream:idle`: emit `instance:stateChange` → `'thinking_deeply'`
- This provides a stronger signal than the 5s heartbeat: "not just silent, but silent for a long time"
- The renderer can show "Model is thinking deeply..." or similar when it sees this state

**New status value**: Add `'thinking_deeply'` to the `InstanceStatus` union. The renderer treats it identically to `'busy'`/`'processing'` for state machine purposes. The activity debouncer will flush this state through since it's a distinct value from the current activity.

**Note**: `stream:idle` is only emitted by `BaseCliAdapter` (local adapters). The `RemoteCliAdapter` does not have a local process and does not emit this event. This is fine — the event fires on the worker node's local adapter, and the worker forwards the state change to the coordinator.

**Files**:
- `src/worker-agent/local-instance-manager.ts` — wire `stream:idle` listener
- `src/shared/types/instance.types.ts` — add `'thinking_deeply'` to `InstanceStatus`

### Change 3: Switch `instance.output` to Fire-and-Forget Notifications

**Goal**: Eliminate the per-message RPC round-trip for output messages.

**Current flow** (request-response):
1. Worker sends `{ jsonrpc: "2.0", id: "out-...", method: "instance.output", params: {...} }`
2. Coordinator receives as RPC request → validates auth → validates schema → emits on registry → sends `{ ok: true }` response
3. Worker receives response (and ignores it)

**New flow** (notification):
1. Worker sends `{ jsonrpc: "2.0", method: "instance.output", params: {...} }` (no `id` field)
2. Coordinator receives as RPC notification → emits on registry → done (no response)

**Worker side** (`worker-agent.ts`):
- In `wireInstanceEvents`, change the `instance:output` handler to omit the `id` field from the message. The existing `send()` helper works for both requests and notifications.

**Coordinator side** (`rpc-event-router.ts`):
- Move `instance.output` handling from `handleRpcRequest` to `handleRpcNotification`
- The handler logic is identical (validate node exists, emit on registry) except it does not call `sendResponse()`
- Add `instance.output` to a `trustedNotificationMethods` set that skips per-message auth validation. The WebSocket was authenticated during `node.register` — re-validating on every output notification is wasteful CPU overhead for high-frequency messages.
- Remove `instance.output` from `RPC_PARAM_SCHEMAS` (no schema validation for notifications since we're optimizing for throughput; the coordinator already handles malformed data gracefully via try/catch)

**What stays as RPC request-response**:
- `instance.stateChange` — needs delivery confirmation, low frequency
- `instance.permissionRequest` — needs delivery confirmation, critical for UX
- `node.register`, `node.heartbeat` — need responses

**Files**:
- `src/worker-agent/worker-agent.ts` — remove `id` from output messages
- `src/main/remote-node/rpc-event-router.ts` — handle output in notification path, add trusted methods set
- `src/main/remote-node/rpc-schemas.ts` — remove `instance.output` schema entry

### Change 4: Worker-Side Output Batching

**Goal**: Reduce WebSocket frame count during output bursts by batching messages.

**Mechanism**:
- In `WorkerAgent`, replace the direct `send()` in the `instance:output` handler with a batching buffer
- Buffer collects output events for up to 50ms (matching `LIMITS.OUTPUT_BATCH_INTERVAL_MS`)
- Flush conditions:
  - Timer fires (50ms elapsed since first buffered message)
  - Buffer reaches 10 messages (prevent unbounded accumulation)
- If only 1 message is in the buffer at flush time, send it as a regular `instance.output` notification (no overhead for single messages)
- If 2+ messages are buffered, send as `instance.outputBatch` notification with `params: { items: [{instanceId, message}, ...] }`

**New RPC method**: `instance.outputBatch` in `NODE_TO_COORDINATOR` constants.

**Coordinator handling** (`rpc-event-router.ts`):
- Add `handleInstanceOutputBatch` in the notification dispatcher
- Iterates `items` array and emits `remote:instance-output` for each item (reuses existing per-message handling)
- Add `instance.outputBatch` to `trustedNotificationMethods` set (same as single output)

**Timer lifecycle**:
- Created lazily on first buffered message
- Cleared after flush
- Uses `unref()` so it doesn't keep the process alive
- Flushed immediately on `disconnect()` to avoid message loss

**Files**:
- `src/worker-agent/worker-agent.ts` — add output batcher
- `src/main/remote-node/worker-node-rpc.ts` — add `INSTANCE_OUTPUT_BATCH` constant
- `src/main/remote-node/rpc-event-router.ts` — handle `instance.outputBatch` notification

## Constants Summary

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| Activity watchdog interval | 5000ms | `local-instance-manager.ts` | Heartbeat frequency during silence |
| Stream idle timeout | 90000ms | `base-cli-adapter.ts` (existing) | Deep thinking detection |
| Output batch interval | 50ms | `worker-agent.ts` | Batch window for output messages |
| Output batch max size | 10 | `worker-agent.ts` | Flush trigger for large bursts |

## Status Values Added

| Status | Meaning | When Emitted |
|--------|---------|-------------|
| `'processing'` | CLI process alive, no output for 5s | Worker activity watchdog timer |
| `'thinking_deeply'` | CLI process alive, no output for 90s | Worker `stream:idle` handler |

## Files Changed (Complete List)

| File | Changes |
|------|---------|
| `src/shared/types/instance.types.ts` | Add `'processing'` and `'thinking_deeply'` to `InstanceStatus` |
| `src/worker-agent/local-instance-manager.ts` | Activity watchdog timer, `stream:idle` listener |
| `src/worker-agent/worker-agent.ts` | Output notification (no `id`), output batcher |
| `src/main/remote-node/worker-node-rpc.ts` | Add `INSTANCE_OUTPUT_BATCH` constant |
| `src/main/remote-node/rpc-event-router.ts` | Handle output as notification, batch handler, trusted methods set |
| `src/main/remote-node/rpc-schemas.ts` | Remove `instance.output` schema entry |

## Testing Strategy

- Unit tests for output batcher (flush on timer, flush on count, single-message passthrough)
- Unit tests for activity watchdog (fires after interval, resets on output, clears on exit)
- Update existing `rpc-event-router.spec.ts` to test notification-based output handling
- Update existing `worker-agent.spec.ts` to verify notification format and batch output

## Out of Scope

- Renderer UI changes (showing "Processing..." or "Thinking deeply..." labels) — the status values propagate through existing infrastructure; UI polish is a follow-up
- Changing the coordinator-side batching (`instance-state.ts`, `update-batcher.service.ts`) — these apply equally to local and remote and are not the bottleneck
- Changing how Claude CLI emits NDJSON — this is upstream behavior we can't control
