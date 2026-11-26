# Main Process Multicore Offload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop provider-event floods, trace/log writes, synchronous SQLite work, memory ingestion, and codemem warm-up from monopolizing the Electron main process. Keep Electron for the desktop shell, but make the orchestration runtime use multiple JS event loops and CPU cores through worker threads or child processes with explicit backpressure.

**Architecture:** Electron main becomes the coordinator for windows, IPC, process lifecycle, and small in-memory state updates. High-volume provider runtime events go through one bounded event bus. Telemetry/log serialization, RLM/unified-memory ingestion, context retrieval, and codemem indexing run behind worker gateways. Critical events remain lossless and ordered; low-value context/status telemetry is coalesced or dropped with metrics.

**Tech Stack:** Electron 40, Node 22 worker_threads, TypeScript 5.9 CommonJS main build, Angular 21 renderer, better-sqlite3, Zod contracts, OpenTelemetry, Vitest.

---

## Investigation Summary

### Live Hang Evidence From 2026-05-10

- The packaged app main process is still alive, not cleanly crashed:
  - PID: `13209`
  - Launch time: `2026-05-10 09:52:03 +0100`
  - Runtime at last check: over 6 hours
  - CPU: about `97-98%`
  - RSS: about `1.8 GB`
  - State: `R`
- Logs stopped advancing at:
  - `app.log`: `2026-05-10 16:04:22 +0100`
  - `traces.ndjson`: `2026-05-10 16:04:22 +0100`
  - `lifecycle.ndjson`: `2026-05-10 16:03:36 +0100`
- `curl -m 2 http://127.0.0.1:4878/health` accepts the connection but times out with no bytes, which means the process is alive but the main event loop is not servicing app work.
- `sample 13209 5` was saved at `/tmp/ai-orchestrator-main.sample.txt`. The main thread is in Electron/V8/Node timer execution (`uv__run_timers`, `node::Environment::RunTimers`, V8 JS frames), not a native crash frame. The process image includes `better_sqlite3.node`, but the sample does not prove SQLite is the top frame.
- Current userData file sizes:
  - `logs/app.log`: `82 MB`
  - `logs/traces.ndjson`: `23 MB`
  - `logs/lifecycle.ndjson`: `752 KB`
  - `rlm/rlm.db`: `2.0 GB`
  - `codemem.sqlite`: `1.4 GB`
- Recent trace mix from the last 5000 trace records:
  - `output`: 4882
  - `status`: 60
  - `context`: 58
- Recent app log subsystem mix from the last 5000 log records:
  - `CliDetection`: 2025
  - `InstanceCommunication`: 910
  - `App`: 589
  - `InstanceLifecycle`: 172
  - `ClaudeCliAdapter`: 113
  - plus repeated session save slow-operation warnings and codemem warm-up timeouts.

### Main-Thread Hot Paths Read

`src/main/index.ts`
- Owns Electron bootstrap, creates `WindowManager` and `InstanceManager`, registers initialization steps, and keeps most runtime services in the main process.

`src/main/app/initialization-steps.ts`
- Registers event forwarding, IPC handlers, automation, plugins, observation, resource governance, remote nodes, channels, bootstraps, codemem, browser gateway, and cross-project persistence from the same main runtime.

`src/main/instance/instance-manager.ts`
- `emitProviderRuntimeEvent` currently assigns UUID, per-instance sequence, timestamp, provider/session metadata, then synchronously emits `provider:normalized-event`.
- `publishOutput` converts every `OutputMessage` to a normalized runtime event.
- The communication dependency passes `emitProviderRuntimeEvent` directly into `InstanceCommunicationManager`.

`src/main/instance/instance-communication.ts`
- Adapter `output` events do significant inline work before publishing output:
  - hook triggers for tool messages;
  - diff/baseline checks;
  - output buffer dedupe/truncation;
  - token stats writes;
  - RLM ingestion;
  - unified memory ingestion;
  - orchestration output processing.
- Adapter `context` events emit normalized runtime events and log `[CONTEXT_EVENT] applying` at `info` for every update.
- Adapter `status` events compute diff stats on busy-to-idle transitions.

`src/main/app/instance-event-forwarding.ts`
- One `provider:normalized-event` listener does all of this in the same call path:
  - schema parse in non-production;
  - `recordProviderRuntimeEventSpan`;
  - renderer IPC send;
  - remote observer output publication;
  - session continuity state update and conversation history update.
- A second listener feeds cross-model review.
- Batch update handlers also update session continuity and load-balancer metrics inline.

Other `provider:normalized-event` consumers:
- `src/main/plugins/plugin-manager.ts` exports telemetry and emits runtime plugin hooks.
- `src/main/observation/observation-ingestor.ts` summarizes output messages and buffers observations.
- `src/main/automations/automation-runner.ts` accumulates automation output chunks.
- `src/main/chats/chat-transcript-bridge.ts` writes conversation ledger/chat updates.
- `src/main/channels/channel-message-router.ts` adds per-stream listeners for remote channel streaming.

`src/main/observability/otel-setup.ts`
- Uses `SimpleSpanProcessor` for every exporter. That calls exporter work for every span instead of batching.

`src/main/observability/local-trace-exporter.ts`
- Serializes each span batch with `JSON.stringify` in the main process before async append.

`src/main/observability/otel-spans.ts`
- Creates and ends a provider runtime span for every normalized provider event.

`src/main/logging/logger.ts`
- Sanitizes log objects and `JSON.stringify`s every log entry synchronously before async file append.
- `currentFileSize` starts at `0` and does not stat an existing log file on app start. A pre-existing large `app.log` can keep growing until the process writes another `maxFileSize` worth of logs after startup.
- Rotation uses synchronous `existsSync`, `unlinkSync`, and `renameSync` inside the queued write callback.

`src/main/instance/instance-context.ts`
- `ingestToRLM` is synchronous from the provider output handler. It calls RLM add-section logic, which updates in-memory store state, sync SQLite tables, sync search index rows, and starts vector indexing.
- `ingestToUnifiedMemory` starts async memory work from the main process. The work can include Memory-R1 decision logic, embeddings, short-term buffer updates, pattern detection, and RLM reads.
- `buildRlmContext` and `buildUnifiedMemoryContext` run during `sendInput` and can query large in-memory stores and SQLite-backed indexes.

`src/main/rlm/context/context-storage.ts`
- `addSection` persists to SQLite, indexes terms, updates an in-memory search index, and schedules vector indexing.
- Large sections split into chunks, repeating the same operations per chunk.

`src/main/rlm/embedding-service.ts`
- Local fallback embedding is CPU-bound JS over words, bigrams, trigrams, hash projection, and normalization.

`src/main/memory/token-stats.ts`
- `record` writes synchronously through `better-sqlite3` from the output-buffer path.

`src/main/session/session-continuity.ts`
- `updateState` and `addConversationEntry` mutate session state from event listeners.
- `saveStateAsync` serializes the entire state synchronously via `JSON.stringify` in `serializePayload` before async atomic file write.
- Live logs show `session.save` slow-operation warnings around 217-530 ms.

`src/main/codemem/index.ts` and `src/main/instance/warm-codemem.ts`
- Codemem has an LSP worker for language-server calls, but `CodememService.ensureWorkspace` and `CodeIndexManager` indexing run from the main-side service.
- `warmCodememWithTimeout` prevents spawn from waiting forever, but after timeout the warm-up continues in the background and can still consume main-process work.

`src/main/lsp-worker/gateway-rpc.ts`
- Existing worker-thread pattern to reuse. It resolves `worker-main.js` from `__dirname` in built output, and falls back to `worker-main.ts` with `tsx` in dev.

`src/main/util/buffered-writer.ts`
- Existing batched writer can be reused or adapted for lower-risk file append coalescing.

`src/main/db/better-sqlite3-driver.ts`
- The only production import of `better-sqlite3`. Worker processes must use this same driver factory from inside the worker, not share a `Database` object across threads.

### Root-Cause Hypothesis

The immediate beachball is a main-process event-loop starvation, not an Electron-wide single-core limitation and not a clean native crash. Electron already has multiple OS processes, but the app's orchestration-critical JS is concentrated on one main-process event loop. Provider output bursts amplify through several synchronous listeners and file/DB/memory side effects. Once the main event loop is saturated, renderer IPC, health checks, log writes, diagnostics, timers, and recovery logic all stop making progress.

This plan intentionally does not replace Electron. Replacing the shell would not fix the failure if orchestration, tracing, persistence, and memory ingestion remain on one JS event loop.

## Non-Goals

- Do not replace Electron or Angular in this change.
- Do not change provider-runtime IPC contracts unless a later task explicitly introduces an additive diagnostic field.
- Do not move renderer state management to a worker.
- Do not move every SQLite-backed store in the app at once. Start with provider-event hot paths and instance-context memory paths.
- Do not commit this unfinished plan. Project rules require unfinished plans/specs to stay uncommitted until implemented and verified.

## Target Architecture

### Runtime Boundaries

Main process responsibilities after this work:
- Electron app lifecycle.
- BrowserWindow creation and renderer IPC.
- Child CLI process lifecycle and adapter event subscription.
- Small in-memory instance state.
- Scheduling and routing to background gateways.
- User-visible critical events.

Worker or child-process responsibilities after this work:
- Provider runtime trace serialization and NDJSON file writes.
- High-volume log file serialization and rotation.
- RLM/unified-memory ingestion and context retrieval.
- CPU-heavy embedding and vector similarity work used by memory/context.
- Codemem workspace indexing and warm-up.
- Hang watchdog file output when main misses heartbeats.

### Event Priority Model

Critical, lossless events:
- `output`
- `tool_use`
- `tool_result`
- `error`
- `exit`
- `spawned`
- `complete`

Coalescible events:
- `context`: keep latest per instance within each flush window.
- duplicate `status`: suppress repeated same-status updates per instance unless a minimum interval has elapsed.

Important rule: assign `eventId` and `seq` only when an envelope is actually emitted. Coalesced or dropped low-priority source events must not create renderer sequence gaps.

### Worker Packaging Pattern

Use the LSP worker precedent:

```ts
const jsEntry = path.join(__dirname, 'worker-main.js');
if (existsSync(jsEntry)) return new Worker(jsEntry);

const tsEntry = path.join(__dirname, 'worker-main.ts');
if (existsSync(tsEntry)) return new Worker(tsEntry, { execArgv: ['--import', 'tsx'] });
```

Each new worker needs:
- `*-protocol.ts` with clone-safe request/response types.
- `*-gateway.ts` client with timeout, pending request map, crash recovery, and metrics.
- `*-worker-main.ts` entrypoint.
- Unit tests using injectable worker factories where possible.

### Backpressure Contract

Every async queue/gateway must expose:
- `queued`
- `inFlight`
- `processed`
- `dropped`
- `coalesced`
- `lastError`
- `oldestQueuedAgeMs`

Critical queues should fail closed for dropped critical events in tests. Runtime should log and surface metrics if a critical queue ever reaches capacity.

Low-priority queues may drop/coalesce, but every drop must increment metrics and emit at most one throttled warning per interval.

## File Map

### New Runtime Utilities

- Create `src/main/runtime/bounded-async-queue.ts`
- Create `src/main/runtime/__tests__/bounded-async-queue.spec.ts`
- Create `src/main/runtime/event-loop-lag-monitor.ts`
- Create `src/main/runtime/__tests__/event-loop-lag-monitor.spec.ts`
- Create `src/main/runtime/main-process-watchdog.ts`
- Create `src/main/runtime/main-process-watchdog-worker.ts`
- Create `src/main/runtime/main-process-watchdog-protocol.ts`
- Create `src/main/runtime/__tests__/main-process-watchdog.spec.ts`

### Provider Runtime Event Backpressure

- Create `src/main/providers/provider-runtime-event-bus.ts`
- Create `src/main/providers/provider-runtime-event-bus.spec.ts`
- Modify `src/main/instance/instance-manager.ts`
- Modify `src/main/instance/__tests__/instance-manager.normalized-event.spec.ts`
- Modify `src/main/instance/__tests__/instance-manager.spec.ts`
- Modify `src/main/instance/instance-communication.ts`
- Modify `src/main/instance/instance-communication.spec.ts`
- Modify `src/main/app/instance-event-forwarding.ts`
- Add `src/main/app/instance-event-forwarding.spec.ts` if no current focused coverage exists for forwarding behavior.

### Telemetry Offload

- Create `src/main/observability/provider-runtime-trace-sink.ts`
- Create `src/main/observability/provider-runtime-trace-worker.ts`
- Create `src/main/observability/provider-runtime-trace-protocol.ts`
- Create `src/main/observability/provider-runtime-trace-sink.spec.ts`
- Modify `src/main/observability/otel-setup.ts`
- Modify `src/main/observability/otel-spans.ts`
- Modify `src/main/observability/__tests__/otel-spans.spec.ts`
- Modify `src/main/observability/local-trace-exporter.ts`
- Modify `src/main/observability/__tests__/local-trace-exporter.spec.ts`

### Logging Offload

- Create `src/main/logging/log-writer-worker.ts`
- Create `src/main/logging/log-writer-protocol.ts`
- Create `src/main/logging/log-writer-client.ts`
- Create `src/main/logging/__tests__/log-writer-client.spec.ts`
- Modify `src/main/logging/logger.ts`
- Modify `src/main/logging/__tests__/logger.spec.ts`
- Modify `src/main/util/buffered-writer.ts` only if it is reused directly by logging.

### Session Persistence Hygiene

- Create `src/main/session/session-persistence-queue.ts`
- Create `src/main/session/session-persistence-queue.spec.ts`
- Modify `src/main/session/session-continuity.ts`
- Modify `src/main/session/session-continuity.spec.ts`
- Modify `src/main/session/autosave-coordinator.ts`
- Modify `src/main/session/autosave-coordinator.spec.ts`

### Context And Memory Worker

- Create `src/main/instance/instance-context-port.ts`
- Create `src/main/instance/context-worker-protocol.ts`
- Create `src/main/instance/context-worker-client.ts`
- Create `src/main/instance/context-worker-main.ts`
- Create `src/main/instance/__tests__/context-worker-client.spec.ts`
- Create `src/main/instance/__tests__/instance-context-port.spec.ts`
- Modify `src/main/instance/instance-context.ts`
- Modify `src/main/instance/instance-manager.ts`
- Modify `src/main/instance/instance-communication.ts`
- Modify `src/main/rlm/context-manager.ts` if worker lifecycle needs explicit database path/config injection.
- Modify `src/main/persistence/rlm-database.ts` to add `busy_timeout` and expose clone-safe config where needed.
- Modify `src/main/memory/unified-controller.ts` only behind the worker boundary, not for renderer-facing memory IPC in the first slice.

### Codemem Worker

- Create `src/main/codemem/index-worker-protocol.ts`
- Create `src/main/codemem/index-worker-gateway.ts`
- Create `src/main/codemem/index-worker-main.ts`
- Create `src/main/codemem/__tests__/index-worker-gateway.spec.ts`
- Modify `src/main/codemem/index.ts`
- Modify `src/main/instance/warm-codemem.ts`
- Modify `src/main/instance/warm-codemem.spec.ts`

### CLI Detection Hygiene

- Modify `src/main/cli/cli-detection.ts`
- Modify or add `src/main/cli/cli-detection.spec.ts`
- Modify call sites only where they intentionally need forced refresh:
  - `src/main/cli/cli-update-poll-service.ts`
  - `src/main/ipc/cli-verification-ipc-handler.ts`
  - `src/main/providers/provider-instance-manager.ts`
  - `src/main/orchestration/cross-model-review-service.ts`
  - `src/main/orchestration/consensus-coordinator.ts`

### Build And Verification

- No new `@contracts/...` subpaths are expected. If one is added anyway, update `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts`.
- Modify `scripts/electron-smoke-check.js` if worker entrypoint existence should be checked.
- Create `scripts/provider-event-stress-smoke.ts`
- Add script in `package.json`, for example `"smoke:provider-events": "tsx scripts/provider-event-stress-smoke.ts"`.

## Implementation Plan

### Task 1: Establish A Reproducible Main-Thread Load Baseline

Files:
- Create `src/main/runtime/event-loop-lag-monitor.ts`
- Create `src/main/runtime/__tests__/event-loop-lag-monitor.spec.ts`
- Create `scripts/provider-event-stress-smoke.ts`

- [x] Read current `src/main/app/runtime-diagnostics.ts`, `src/main/util/slow-operations.ts`, and `src/main/instance/instance-state.ts` again before editing.
- [x] Add an event-loop lag monitor using `perf_hooks.monitorEventLoopDelay` where available, with fallback interval drift measurement.
- [x] Add a fake provider-event stress harness that can publish a configurable mix of output/context/status events through the same bus API the app will use.
- [x] The stress harness must report:
  - event count by kind;
  - wall-clock duration;
  - max event-loop lag;
  - p95 event-loop lag;
  - renderer-forwarded count;
  - telemetry queued/dropped/coalesced counts.
- [x] Write Vitest coverage for monitor start/stop, lag snapshot reset, and no timer leaks.
- [x] Verification:

```bash
rtk npx vitest run src/main/runtime/__tests__/event-loop-lag-monitor.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
```

Expected baseline before later tasks: the harness will show high lag or unbounded synchronous work when all listeners run inline. Capture the output in the implementation notes, not in code comments.

### Task 2: Add A Generic Bounded Async Queue

Files:
- Create `src/main/runtime/bounded-async-queue.ts`
- Create `src/main/runtime/__tests__/bounded-async-queue.spec.ts`

- [x] Define queue options:

```ts
interface BoundedAsyncQueueOptions<T> {
  name: string;
  maxSize: number;
  concurrency?: number;
  process: (item: T) => Promise<void> | void;
  onDrop?: (item: T, reason: 'capacity' | 'shutdown') => void;
}
```

- [x] Support enqueue result:

```ts
type EnqueueResult =
  | { accepted: true }
  | { accepted: false; reason: 'capacity' | 'shutdown' };
```

- [x] Add metrics:
  - `queued`
  - `inFlight`
  - `processed`
  - `failed`
  - `dropped`
  - `oldestQueuedAgeMs`
- [x] Add `flush(timeoutMs?)` and `shutdown({ drain: boolean })`.
- [x] Tests:
  - preserves FIFO order at concurrency 1;
  - honors concurrency > 1;
  - drops when capacity is exceeded;
  - exposes metrics;
  - shutdown without drain rejects new work and drops queued items;
  - shutdown with drain processes existing work.
- [x] Verification:

```bash
rtk npx vitest run src/main/runtime/__tests__/bounded-async-queue.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
```

### Task 3: Introduce ProviderRuntimeEventBus With Coalescing And Stable Sequences

Files:
- Create `src/main/providers/provider-runtime-event-bus.ts`
- Create `src/main/providers/provider-runtime-event-bus.spec.ts`
- Modify `src/main/instance/instance-manager.ts`
- Modify `src/main/instance/__tests__/instance-manager.normalized-event.spec.ts`
- Modify `src/main/instance/__tests__/instance-manager.spec.ts`

- [x] Move per-instance sequence assignment into the event bus so only emitted envelopes receive sequence numbers.
- [x] Keep critical event kinds lossless and synchronous-to-enqueue.
- [x] Coalesce `context` events by `instanceId`, keeping only the latest event within a short flush interval such as 100 ms.
- [x] Suppress duplicate `status` events per `instanceId` when the status string has not changed inside a short interval.
- [x] Preserve public `InstanceManager` emission name `provider:normalized-event` for compatibility, but route all emissions through the bus.
- [x] Add metrics for emitted, coalesced, dropped, and current pending context/status events.
- [x] Tests:
  - output events preserve order and contiguous `seq`;
  - context events are coalesced and do not create sequence gaps;
  - status duplicates are suppressed and do not create sequence gaps;
  - error/exit/complete are never dropped when the low-priority queue is full;
  - existing normalized-event tests still observe envelopes with provider, model, session, adapter generation, and turn ID.
- [x] Verification:

```bash
rtk npx vitest run src/main/providers/provider-runtime-event-bus.spec.ts src/main/instance/__tests__/instance-manager.normalized-event.spec.ts src/main/instance/__tests__/instance-manager.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 4: Stop High-Volume Inline Work In Instance Event Forwarding

Files:
- Modify `src/main/app/instance-event-forwarding.ts`
- Add `src/main/app/instance-event-forwarding.spec.ts`
- Modify `src/main/instance/instance-communication.ts`
- Modify `src/main/instance/instance-communication.spec.ts`

- [x] Replace the inline `recordProviderRuntimeEventSpan(enrichedEnvelope)` call with an enqueue to the provider runtime trace sink from Task 5.
- [x] Keep renderer IPC forwarding for emitted events, but make it the only synchronous operation in that listener besides cheap enrichment.
- [x] Move session continuity updates into a bounded queue:
  - state metadata updates can coalesce per instance;
  - conversation entries for user/assistant/tool output remain ordered per instance.
- [x] Ensure ignored promise rejections from `continuity.updateState` and `continuity.addConversationEntry` are caught and logged once per interval.
- [x] Reduce `[CONTEXT_EVENT] applying` from `info` to `debug`, and skip the log when `used` and `total` are unchanged.
- [x] Tests:
  - provider event forwarding still sends `IPC_CHANNELS.PROVIDER_RUNTIME_EVENT`;
  - trace sink is called asynchronously or via queue, not inline;
  - continuity failures are caught;
  - duplicate context updates do not log at `info`;
  - context usage state update still reaches `InstanceStateManager`.
- [x] Verification:

```bash
rtk npx vitest run src/main/app/instance-event-forwarding.spec.ts src/main/instance/instance-communication.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 5: Offload Provider Runtime Trace Writing

Files:
- Create `src/main/observability/provider-runtime-trace-sink.ts`
- Create `src/main/observability/provider-runtime-trace-worker.ts`
- Create `src/main/observability/provider-runtime-trace-protocol.ts`
- Create `src/main/observability/provider-runtime-trace-sink.spec.ts`
- Modify `src/main/observability/otel-setup.ts`
- Modify `src/main/observability/otel-spans.ts`
- Modify `src/main/observability/__tests__/otel-spans.spec.ts`
- Modify `src/main/observability/local-trace-exporter.ts`
- Modify `src/main/observability/__tests__/local-trace-exporter.spec.ts`

- [x] Add a provider runtime trace sink that accepts clone-safe `ProviderRuntimeEventEnvelope` records.
- [x] The main process should build only a compact plain object and post it to the trace worker.
- [x] The worker should:
  - batch records;
  - serialize to NDJSON;
  - append to `traces.ndjson`;
  - rotate when size exceeds configured threshold;
  - report metrics back to the main process.
- [x] Keep OpenTelemetry for lower-volume orchestration spans, but stop creating one OTel span per provider output chunk.
- [x] Change non-provider OTel file export from `SimpleSpanProcessor` to `BatchSpanProcessor` if tests confirm package support.
- [x] Preserve tests proving provider diagnostics attributes are still represented in trace records for error/complete/context events.
- [x] Tests:
  - sink enqueue returns quickly for 10,000 events;
  - worker writes valid NDJSON;
  - rotation caps file sizes;
  - worker crash increments error metrics and restarts or degrades without crashing main;
  - no unbounded queue growth under sustained output.
- [x] Verification:

```bash
rtk npx vitest run src/main/observability/provider-runtime-trace-sink.spec.ts src/main/observability/__tests__/local-trace-exporter.spec.ts src/main/observability/__tests__/otel-spans.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 6: Fix Log Rotation And Move Heavy Log Writes Off Main

Files:
- Create `src/main/logging/log-writer-worker.ts`
- Create `src/main/logging/log-writer-protocol.ts`
- Create `src/main/logging/log-writer-client.ts`
- Create `src/main/logging/__tests__/log-writer-client.spec.ts`
- Modify `src/main/logging/logger.ts`
- Modify `src/main/logging/__tests__/logger.spec.ts`

- [x] On `LogManager` initialization, stat the existing `app.log` and initialize `currentFileSize` from disk.
- [x] If existing `app.log` is already larger than `maxFileSize`, rotate on startup before appending.
- [x] Move file append and rotation into `LogWriterClient`.
- [x] Use a worker for file serialization/rotation. If a worker cannot be started, fall back to the current async write queue with fixed file-size initialization.
- [x] Keep recent in-memory logs in main for diagnostics, but cap entry data exactly as current sanitizer does.
- [x] Throttle repetitive high-volume warnings.
- [x] Tests:
  - existing oversized log rotates on startup;
  - existing smaller log resumes with correct file size;
  - log worker batches appends;
  - worker failure falls back without throwing;
  - recent logs remain available when file writing is disabled.
- [x] Verification:

```bash
rtk npx vitest run src/main/logging/__tests__/logger.spec.ts src/main/logging/__tests__/log-writer-client.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 7: Defer And Batch Session Continuity Persistence

Files:
- Create `src/main/session/session-persistence-queue.ts`
- Create `src/main/session/session-persistence-queue.spec.ts`
- Modify `src/main/session/session-continuity.ts`
- Modify `src/main/session/session-continuity.spec.ts`
- Modify `src/main/session/autosave-coordinator.ts`
- Modify `src/main/session/autosave-coordinator.spec.ts`

- [x] Add a per-instance persistence queue that coalesces state updates and preserves conversation-entry ordering.
- [x] Ensure `addConversationEntry` does not trigger synchronous serialization or disk write in the provider event call path.
- [x] Move large `JSON.stringify` work for session payloads behind the queue. If full workerization is too large for this task, measure and isolate serialization first, then move serialization/encryption in the next task.
- [x] Keep final shutdown save behavior intact. The existing sync cleanup requirement must still save dirty states during Electron quit.
- [x] Tests:
  - multiple `updateState` calls coalesce to one persistence task;
  - conversation entries preserve order;
  - final shutdown drains dirty states;
  - save failures keep instance dirty for retry;
  - system resume grace period still defers autosave.
- [x] Verification:

```bash
rtk npx vitest run src/main/session/session-persistence-queue.spec.ts src/main/session/session-continuity.spec.ts src/main/session/autosave-coordinator.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 8: Introduce An InstanceContextPort Before Workerization

Files:
- Create `src/main/instance/instance-context-port.ts`
- Create `src/main/instance/__tests__/instance-context-port.spec.ts`
- Modify `src/main/instance/instance-context.ts`
- Modify `src/main/instance/instance-manager.ts`
- Modify `src/main/instance/instance-communication.ts`

- [x] Define a narrow `InstanceContextPort` interface for the methods `InstanceManager` and `InstanceCommunicationManager` actually use.
- [x] Replace direct dependency on concrete `InstanceContextManager` in orchestration code with the interface.
- [x] Define `InstanceContextSnapshot` as clone-safe data only:

```ts
interface InstanceContextSnapshot {
  id: string;
  sessionId: string;
  historyThreadId?: string;
  provider?: string;
  workingDirectory: string;
  displayName: string;
  currentModel?: string;
  contextUsage: { used: number; total: number; percentage: number };
}
```

- [x] Update callers to pass snapshots into context methods instead of full `Instance` objects where workerization will need it.
- [x] Tests:
  - existing main-process `InstanceContextManager` satisfies `InstanceContextPort`;
  - `InstanceManager` can be constructed with a fake context port;
  - output ingestion dependencies still call the port.
- [x] Verification:

```bash
rtk npx vitest run src/main/instance/__tests__/instance-context-port.spec.ts src/main/instance/__tests__/instance-manager.spec.ts src/main/instance/instance-communication.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 9: Move RLM And Unified Memory Context Work To A Worker

Files:
- Create `src/main/instance/context-worker-protocol.ts`
- Create `src/main/instance/context-worker-client.ts`
- Create `src/main/instance/context-worker-main.ts`
- Create `src/main/instance/__tests__/context-worker-client.spec.ts`
- Modify `src/main/instance/instance-context.ts`
- Modify `src/main/persistence/rlm-database.ts`
- Modify `src/main/rlm/context-manager.ts` if explicit DB config injection is needed.

- [x] Implement `ContextWorkerClient` as an `InstanceContextPort`.
- [x] Worker owns its own `RLMContextManager`, `UnifiedMemoryController`, `VectorStore`, `EmbeddingService`, and better-sqlite3 connection.
- [x] Do not pass a better-sqlite3 `Database` or `SqliteDriver` across worker boundaries.
- [x] Add `PRAGMA busy_timeout = 5000` to production SQLite connections used by RLM and codemem to reduce cross-connection write failures.
- [x] Worker messages:
  - `initialize-rlm`
  - `end-rlm-session`
  - `ingest-rlm`
  - `ingest-unified-memory`
  - `build-rlm-context`
  - `build-unified-memory-context`
  - `compact-context`
  - `ingest-initial-output`
  - `get-stats`
  - `shutdown`
- [x] Ingestion requests are fire-and-forget with bounded queue metrics.
- [x] Context retrieval requests are RPC with timeouts. On timeout, return `null` context and continue sending user input rather than blocking.
- [x] Worker crash behavior:
  - mark context as degraded;
  - restart once with backoff;
  - drop low-priority queued ingestion;
  - never crash the Electron main process.
- [x] Tests:
  - worker client resolves RPC responses by ID;
  - timeouts reject and clean pending maps;
  - ingestion queue drops low-priority messages under capacity;
  - context retrieval degrades to `null` on worker crash;
  - no non-cloneable `Instance` object is posted to worker.
- [x] Verification:

```bash
rtk npx vitest run src/main/instance/__tests__/context-worker-client.spec.ts src/main/instance/__tests__/instance-context-port.spec.ts src/main/instance/instance-communication.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 10: Move Codemem Indexing And Warm-Up Behind A Worker Gateway

Files:
- Create `src/main/codemem/index-worker-protocol.ts`
- Create `src/main/codemem/index-worker-gateway.ts`
- Create `src/main/codemem/index-worker-main.ts`
- Create `src/main/codemem/__tests__/index-worker-gateway.spec.ts`
- Modify `src/main/codemem/index.ts`
- Modify `src/main/instance/warm-codemem.ts`
- Modify `src/main/instance/warm-codemem.spec.ts`

- [x] Add a codemem index worker that owns `CodeIndexManager`, `PeriodicScan`, `CasStore`, and its own `codemem.sqlite` connection.
- [x] Keep the existing LSP worker for language-server operations; do not merge LSP and indexing into one worker.
- [x] Main `CodememService.warmWorkspace` should call the gateway. If the gateway is unavailable, return degraded `{ ready: false, filePath: null }`.
- [x] `warmCodememWithTimeout` should cancel or detach the worker request cleanly after timeout, not leave unbounded main-side continuation work.
- [x] Tests:
  - warm workspace timeout returns promptly;
  - worker request eventually resolves without unhandled rejection;
  - indexing disabled setting bypasses worker;
  - worker crash marks workspace LSP state as unavailable.
- [x] Verification:

```bash
rtk npx vitest run src/main/codemem/__tests__/index-worker-gateway.spec.ts src/main/instance/warm-codemem.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 11: Add CLI Detection In-Flight Dedupe And Log Throttling

Files:
- Modify `src/main/cli/cli-detection.ts`
- Modify or add `src/main/cli/cli-detection.spec.ts`

- [x] Add an `inFlightDetectAll` promise so simultaneous `detectAll(false)` calls share one scan.
- [x] Add separate in-flight handling for `detectAll(true)` so explicit force refreshes do not spawn multiple concurrent version probes.
- [x] Keep current 1-minute cache, but make call sites use `forceRefresh` only when explicitly user-triggered or scheduled by the daily update poll.
- [x] Lower per-CLI `CLI detected` logs from `info` to `debug`, or throttle them. Keep one `CLI detection complete` info log per actual scan.
- [x] Tests:
  - concurrent `detectAll()` calls spawn each CLI probe once;
  - concurrent `detectAll(true)` calls share a forced scan;
  - cached calls do not log per-CLI detection;
  - explicit `clearCache` still forces a later scan.
- [x] Verification:

```bash
rtk npx vitest run src/main/cli/cli-detection.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 12: Add A Worker-Based Main-Process Watchdog

Files:
- Create `src/main/runtime/main-process-watchdog.ts`
- Create `src/main/runtime/main-process-watchdog-worker.ts`
- Create `src/main/runtime/main-process-watchdog-protocol.ts`
- Create `src/main/runtime/__tests__/main-process-watchdog.spec.ts`
- Modify `src/main/app/runtime-diagnostics.ts`
- Modify `src/main/app/initialization-steps.ts`

- [x] Main sends heartbeat messages to a watchdog worker every second.
- [x] The watchdog worker writes a small JSON status file under userData diagnostics when heartbeat age exceeds threshold.
- [x] Main heartbeat payload includes:
  - timestamp;
  - event-loop lag snapshot;
  - provider event bus metrics;
  - trace/log/context worker queue metrics;
  - active instance count.
- [x] On next app start, `installRuntimeDiagnostics` reads the last watchdog report and logs a single warning if the previous run had a main-thread stall.
- [x] Tests:
  - heartbeat clears stale warning state;
  - missing heartbeat writes report;
  - report is read once on next startup;
  - worker shutdown removes timers.
- [x] Verification:

```bash
rtk npx vitest run src/main/runtime/__tests__/main-process-watchdog.spec.ts
rtk npx tsc --noEmit -p tsconfig.electron.json
rtk npx tsc --noEmit -p tsconfig.spec.json
```

### Task 13: Full Stress And Regression Verification

Files:
- Modify `scripts/provider-event-stress-smoke.ts`
- Modify `package.json` if adding a script.
- Modify `scripts/electron-smoke-check.js` if checking worker entrypoints.

- [x] Run the provider-event stress harness before and after offload.
- [x] Acceptance thresholds under 10,000 synthetic provider events:
  - no dropped critical events;
  - no renderer sequence gaps;
  - provider event bus reports coalesced context/status events;
  - main event-loop p95 lag under 50 ms;
  - main event-loop max lag under 250 ms;
  - `traces.ndjson` and `app.log` remain under configured active-file size after rotation;
  - health endpoint responds in under 500 ms during the stress test.
- [x] Run targeted tests from every task.
- [x] Run full project verification after multi-file changes:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run test
rtk npm run build
rtk npm run smoke:electron
```

- [ ] Manual packaged validation:
  - build packaged app with `rtk npm run localbuild`;
  - launch packaged app;
  - start at least one Claude/Codex session and one cross-model review;
  - confirm renderer receives output;
  - confirm provider diagnostics panel receives context/error/complete fields;
  - confirm log and trace files rotate;
  - confirm no worker entrypoint path failures in packaged logs.

## Rollout Plan

### Slice 1: Low-Risk Stabilization

Implement Tasks 1-7 first.

Expected value:
- Main no longer creates one OTel span per provider output.
- Context/status noise is coalesced.
- Log rotation is fixed.
- Session persistence is deferred.
- Stress harness exists.

This slice should be shippable without the context worker.

### Slice 2: Context And Memory Worker

Implement Tasks 8-9 after Slice 1 is stable.

Expected value:
- RLM ingestion and memory retrieval no longer run in the provider output and send-input main paths.
- CPU-heavy embedding fallback can use another core.
- Large RLM database writes no longer monopolize the main event loop.

### Slice 3: Codemem Worker And Watchdog

Implement Tasks 10-12 after the context worker pattern has passed packaged validation.

Expected value:
- Codemem warm-up/indexing cannot starve Electron main.
- Next startup has explicit diagnostic evidence if main was wedged.

### Slice 4: Full Verification

Implement Task 13 and keep the stress smoke script as a permanent regression check.

## Risk Matrix

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Renderer sequence gaps after event coalescing | Output UI warnings and possible state drift | Assign `seq` only when emitting envelopes; test coalesced events do not consume sequence numbers. |
| Dropping critical events under load | Lost output or missed exits/errors | Critical events use lossless queue; tests fail if critical drops occur. |
| Worker structured-clone failures | Runtime errors when posting `Instance`, `Error`, functions, or DB handles | Define clone-safe protocol types and add tests that post representative payloads. |
| SQLite write contention across main and worker connections | Busy failures or slow writes | WAL remains enabled; add `busy_timeout`; move one hot domain at a time; monitor queue errors. |
| Worker crash loses context ingestion | Reduced memory quality | Fire-and-forget ingestion is best-effort; expose degraded state; restart with backoff; never block main. |
| Worker packaging failure in DMG | Packaged app cannot start worker | Follow LSP worker path resolution; add smoke check for built worker files; run packaged validation. |
| Increased memory footprint from worker-owned RLM/Vector caches | Higher RSS | Start with one context worker, bounded caches, and explicit stats; avoid per-instance workers. |
| Plugin hooks observe output later than before | Runtime plugin behavior changes | Critical output events remain emitted in order; plugin calls are still async fire-and-forget as today. |
| Trace format drift breaks diagnostics | Tooling stops parsing traces | Keep provider trace record fields equivalent to existing provider span attributes; update trace tests. |
| Shutdown exits before queues flush | Lost final logs/session state | Add `flush()` to all gateways and register cleanup handlers; keep sync final session save fallback. |

## Success Criteria

- The app can process 10,000 synthetic provider runtime events without freezing renderer IPC.
- Main event-loop p95 lag stays under 50 ms during the stress harness.
- Main event-loop max lag stays under 250 ms during the stress harness.
- `http://127.0.0.1:4878/health` responds within 500 ms during synthetic provider output flood.
- No critical provider events are dropped.
- Renderer sees contiguous per-instance provider event sequences.
- Low-priority coalescing metrics are visible in logs/diagnostics.
- Active `app.log` and `traces.ndjson` obey configured rotation size.
- Context retrieval timeouts degrade gracefully to no injected memory context rather than blocking send.
- Packaged app can start all new workers from `dist/main/**`.

## Verification Checklist

- [ ] `rtk npx vitest run src/main/runtime/__tests__/bounded-async-queue.spec.ts`
- [ ] `rtk npx vitest run src/main/providers/provider-runtime-event-bus.spec.ts`
- [ ] `rtk npx vitest run src/main/app/instance-event-forwarding.spec.ts`
- [ ] `rtk npx vitest run src/main/observability/provider-runtime-trace-sink.spec.ts`
- [ ] `rtk npx vitest run src/main/logging/__tests__/logger.spec.ts`
- [ ] `rtk npx vitest run src/main/session/session-persistence-queue.spec.ts`
- [ ] `rtk npx vitest run src/main/instance/__tests__/context-worker-client.spec.ts`
- [ ] `rtk npx vitest run src/main/codemem/__tests__/index-worker-gateway.spec.ts`
- [ ] `rtk npx vitest run src/main/cli/cli-detection.spec.ts`
- [ ] `rtk npx vitest run src/main/runtime/__tests__/main-process-watchdog.spec.ts`
- [ ] `rtk npx tsc --noEmit`
- [ ] `rtk npx tsc --noEmit -p tsconfig.spec.json`
- [ ] `rtk npm run lint`
- [ ] `rtk npm run test`
- [ ] `rtk npm run build`
- [ ] `rtk npm run smoke:electron`
- [ ] `rtk npm run localbuild`
- [ ] Manual packaged smoke with real provider output.

## Plan Self-Review

- The implementation steps cover the observed live-hang evidence: provider-event fanout, synchronous trace/log serialization, sync SQLite writes, session persistence serialization, RLM/unified-memory work, codemem warm-up, CLI detection churn, and missing out-of-band watchdog evidence.
- The path inventory was checked after writing. Existing `Modify` targets are real files; `scripts/provider-event-stress-smoke.ts` is intentionally created in Task 1 and then modified in Task 13.
- Placeholder scan found no unresolved marker strings.
- Verification is staged from focused unit tests through full typecheck, lint, build, stress smoke, and packaged-app validation.
- The plan does not include a commit step. Per project rules, the unfinished plan must remain uncommitted unless James explicitly asks for a commit.

## Notes For Implementers

- Keep every slice small enough to verify independently.
- Do not introduce a worker per instance. Use one bounded worker per heavy subsystem unless metrics prove otherwise.
- Do not pass class instances, Electron objects, child process handles, `SqliteDriver`, or full `Instance` objects across worker boundaries.
- Do not rely on TypeScript path aliases for runtime worker entrypoints. Built workers run from `dist/main/**`.
- Keep existing dirty working-tree changes untouched unless they are directly part of this plan.
- Do not commit this plan or implementation changes unless James explicitly asks for a commit.
