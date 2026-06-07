# ADR D4: Offloading CLI/Agent Process Spawning to a Utility Process Worker

- **Date:** 2026-06-06
- **Status:** Completed and verified 2026-06-07 (`tsc`, spec `tsc`, lint, D4
  focused tests, full test suite).
- **Author:** D4 design task

---

## Parallel-Agent Ownership Boundary

> Added 2026-06-06 so this doc can be handed to a single agent without clashing
> with D1 (thin-client event API), D5 (plugin sandboxing), or the Auxiliary
> Local Model Routing doc. Verified against the live tree: this work is
> greenfield and its file set is disjoint from the others.

**This doc OWNS (edit freely):**
- `src/main/cli/spawn-worker/**` — new (`cli-spawn-worker-main.ts`,
  `CliSpawnWorkerGateway`, `CliAdapterWorkerProxy`) + isolation/parity specs.
- `src/main/cli/adapters/base-cli-adapter.ts` and the three top-level-electron
  importers it must isolate: `src/main/cli/adapters/codex/app-server-broker.ts`,
  `src/main/cli/rtk/rtk-runtime.ts`, `src/main/cli/hooks/hook-path-resolver.ts`,
  plus `src/main/cli/adapters/adapter-spawn-helpers.ts`.
- `src/main/providers/provider-runtime-service.ts` — the single
  `createAdapter()` gate.
- `src/main/instance/instance-lifecycle.ts` — warm-start / createRuntimeAdapter.
- `src/main/security/env-filter*`, `src/main/cli/cli-environment*` (read/extend).

**Shared boundary file — coordinate, do NOT free-edit:**
- `src/shared/types/settings.types.ts`: append **only** the
  `enableSpawnWorkerOffload: boolean` flag to `AppSettings` and its `false`
  default to `DEFAULT_SETTINGS`. The Auxiliary plan already added its keys here
  (committed); add yours in a separate hunk, do not touch existing lines.

**Do NOT touch (owned by other docs):** `src/main/event-bus/**`,
`src/main/window-manager.ts`, `src/main/app/instance-event-forwarding.ts`,
`src/main/ipc/**` (D1); `src/main/plugins/**` + plugin schemas/SDK (D5);
`src/main/rlm/**`, `src/main/context/**`, `src/main/memory/**`,
`src/main/remote-node/**`, `src/worker-agent/**` (Auxiliary).
Note: `src/main/background-jobs/process-lane-gateway.ts` and
`worker-thread-lane-gateway.ts` are **read-only templates** — reference, never edit.

---

## Context

### Current spawn path (main-thread cost)

Today every CLI adapter extends `BaseCliAdapter` (`src/main/cli/adapters/base-cli-adapter.ts`) and calls `this.spawnProcess()` (line 383) directly on the Electron main process. That function:

1. Builds a sanitized environment via `getSafeEnvForTrustedProcess()` and `buildCliSpawnOptions()`.
2. Calls `child_process.spawn()` with `stdio: ['pipe', 'pipe', 'pipe']` and `detached: !options.shell` (line 397).
3. Wires stdin/stdout/stderr handlers and the stream-idle watchdog timer (lines 433–465) on the main event loop.
4. Adds the `ChildProcess` handle to the static `BaseCliAdapter.activeProcesses` set (line 418) for orphan cleanup.

`InstanceLifecycleManager.createRuntimeAdapter()` (line 498 of `instance-lifecycle.ts`) calls `getProviderRuntimeService().createAdapter()`, which constructs the concrete adapter (ClaudeCliAdapter, GeminiCliAdapter, CopilotCliAdapter, etc.) and then calls `adapter.spawn()` — still on the main thread. The spawn call itself is synchronous (the kernel fork) but all subsequent I/O event plumbing (`stdout.on('data', ...)`, `stdin.write()`, close handlers, idle timers) continuously pins callbacks on the main-process event loop for the entire session lifetime.

With many concurrent AI instances (loop mode can spawn 4–8+ agents simultaneously), this results in:

- **Continuous I/O event pressure**: each agent's stdout/stderr data events run on the main loop, dispatching chunks up through the output pipeline. Heavy streaming (Gemini's token-by-token SSE, Codex exec-mode JSON lines, large tool outputs) causes cumulative latency on every main-loop turn.
- **Blocking stdin writes**: `safeStdinWrite()` (line 573) performs a synchronous-style write with a drain await; in a slow kernel buffer path this occupies a main-thread microtask slot non-trivially.
- **Signal delivery**: `killProcessGroup()` (line 312 in `base-cli-adapter.ts`) is synchronous; with many processes this is a tight loop on the main thread during shutdown.
- **Process-group tracking**: `BaseCliAdapter.activeProcesses` (static Set, line 104) is mutated from every adapter instance on every spawn and exit.

The prior offload work (`2026-05-29-main-thread-offload-architecture_completed.md`) moved SQLite, RLM, code-index, and context work off the main thread. CLI process I/O is the remaining heavy continuous load.

### The electron-import isolation hazard

The memory file `worker-electron-import-isolation.md` and the two existing guardrail specs document a critical constraint: **any file whose transitive value-import graph touches a top-level `import ... from 'electron'` crashes a worker thread at load** because `electron` is not resolvable in a non-main thread. The crash is silent at startup — the worker process exits, the gateway falls back to degraded, and the feature silently disappears for the session.

Known top-level electron importers in the CLI adapter tree:

| File | Import |
|---|---|
| `src/main/cli/adapters/codex/app-server-broker.ts:26` | `import { app } from 'electron'` |
| `src/main/cli/rtk/rtk-runtime.ts:19` | `import { app } from 'electron'` |
| `src/main/cli/hooks/hook-path-resolver.ts:6` | `import { app } from 'electron'` |

`src/main/cli/adapters/adapter-spawn-helpers.ts` already uses the lazy guarded pattern (line 96: `require('electron')` inside a try/catch), which survives in a worker. The three files above do not.

Barrels amplify the hazard: any barrel that re-exports any of these files contaminates the entire import graph of anything that imports that barrel. The `src/main/cli/adapters/index.ts` barrel re-exports all adapters, making it safe only from the main thread.

This is the hardest design constraint: a spawn worker cannot simply `import` the existing adapter classes without first surgically removing the three top-level electron imports.

---

## Decision

### What runs in the spawn worker vs. main thread

**The spawn worker** (`cli-spawn-worker-main.ts`, analogous to `conversation-ledger-worker-main.ts`) owns:

- Child process creation (`child_process.spawn()`).
- All stdin/stdout/stderr stream piping for the spawned CLI process.
- The stream-idle watchdog timer (setTimeout logic currently in `BaseCliAdapter`).
- Signal delivery: `killProcessGroup()` for SIGTERM/SIGKILL/SIGINT.
- The `activeProcesses` set tracking (moved into the worker's own scope; orphan cleanup at app quit becomes a worker-shutdown message).

**The main thread** retains:

- `InstanceLifecycleManager` and `InstanceCommunicationManager` as the coordination layer.
- The `CliAdapter` interface as an in-process abstraction. The main thread holds a lightweight **proxy adapter** (`CliAdapterWorkerProxy`) that translates every adapter method call into a structured RPC message to the worker.
- All orchestration, state-machine transitions, IPC to the renderer, and hook calls (hook-path-resolver, rtk-runtime, etc.) — these import electron freely.
- The `PermissionRegistry`, `PauseCoordinator`, and other main-process singletons that adapters currently access directly.

### Where the pty handle lives

The `ChildProcess` handle (stdin/stdout/stderr streams, `pid`, exit signal) is **not transferable** across a process or thread boundary. It is an OS-level file descriptor triple. This is the hard constraint that rules out naive serialization.

**Decision: the ChildProcess lives entirely in the spawn worker. The main thread never holds the handle.**

The proxy adapter owns the adapter's semantic interface (sendInput, interrupt, terminate, getSessionId, etc.) but the actual OS handle is in the worker. Input flows as messages main → worker; output flows as messages worker → main.

The `node-pty` `IPty` handle (`src/worker-agent/worker-terminal-handler.ts`) is already being managed this way in the remote-node worker agent — the PTY is owned by the worker, and output is relayed over the WebSocket. The same pattern applies here to the simpler `ChildProcess` stdio case.

### Adapter type split

Not all adapters are equal. The design distinguishes three tiers:

| Tier | Adapter(s) | Spawn model | Worker feasibility |
|---|---|---|---|
| **A — stdio one-shot** | ClaudeCliAdapter (non-ACP), GeminiCliAdapter, Codex exec-mode | `child_process.spawn` per turn; stdin→message, stdout→NDJSON stream | Straightforward. No persistent handle across turns. |
| **B — persistent session** | ClaudeCliAdapter ACP mode (`AcpCliAdapter`), CopilotCliAdapter, CursorCliAdapter | Single long-lived process; stdin used for multi-turn conversation; stdin stays open | More complex. The `ChildProcess.stdin` WritableStream and `ChildProcess.stdout` ReadableStream both live in the worker. Multi-turn writes require queued send-to-worker RPCs. Interrupt (SIGINT) is a fire-and-forget RPC. |
| **C — HTTP/app-server** | CodexCliAdapter app-server mode, `codex/app-server-broker.ts` | Uses HTTP socket, no stdio. The `CodexBrokerManager` uses `app from 'electron'` at the top level. | The broker itself is not a stdio process; broker lifecycle can remain on the main thread or in a dedicated utility process. Spawn-worker is not the right primitive here. |

**Pilot target: Tier A — ClaudeCliAdapter in `--print --input-format stream-json` (non-ACP) mode.** This is the most used adapter, fully stateless per-turn, and the easiest to model as a worker RPC. Gemini is structurally identical.

---

## Communication Protocol

The spawn worker uses the same `node:worker_threads` `parentPort.postMessage` / `worker.postMessage` pattern established by the ledger worker and context worker. A `MessageChannel` pair is not needed because all messages share one round-trip path.

### Message types (inbound to worker)

```typescript
type SpawnWorkerInboundMsg =
  | { type: 'spawn'; id: number; instanceId: string; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { type: 'stdin-write'; id: number; instanceId: string; data: string }
  | { type: 'signal'; instanceId: string; signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' }
  | { type: 'terminate'; id: number; instanceId: string; graceful: boolean }
  | { type: 'shutdown' };
```

### Message types (outbound from worker)

```typescript
type SpawnWorkerOutboundMsg =
  | { type: 'rpc-response'; id: number; result?: unknown; error?: string }
  | { type: 'ready' }
  | { type: 'spawned'; instanceId: string; pid: number }
  | { type: 'stdout-chunk'; instanceId: string; chunk: string }
  | { type: 'stderr-chunk'; instanceId: string; chunk: string }
  | { type: 'exited'; instanceId: string; code: number | null; signal: string | null }
  | { type: 'stream-idle'; instanceId: string; timeoutMs: number }
  | { type: 'epipe'; instanceId: string; pipe: 'stdin' | 'stdout' };
```

`stdout-chunk` messages are the hot path. The worker **does not** do any NDJSON parsing — it ships raw string chunks to the main thread, which continues to run `NdjsonParser` and `processCliMessage()` exactly as today. This avoids moving the parsing logic into the worker (which would pull in more of the adapter graph) and keeps the round-trip overhead per chunk bounded to one `postMessage` call.

### Backpressure

`parentPort.postMessage` is non-blocking. Stdout chunk volume from a busy Claude session can exceed several hundred KB/s. The worker **coalesces** chunks using the same `bufferOutput` / `OUTPUT_FLUSH_INTERVAL_MS` / `OUTPUT_FLUSH_MAX_CHARS` pattern from `WorkerTerminalHandler` (lines 274–288 in `worker-terminal-handler.ts`): buffer up to 16KB or 30ms, whichever comes first, then send one `stdout-chunk` message. This trades per-byte latency (negligible for AI CLI output) for message-count reduction of ~100x.

The main thread proxy queues `stdin-write` RPCs sequentially (one in-flight at a time) per instance to preserve write ordering and respect the drain signal, which the worker reports back as the RPC response.

### Instance isolation

Each logical adapter/instance gets its own `instanceId` key in the worker's session map. Multiple concurrent instances share the single worker thread; this is appropriate because:

1. All the work in the worker is I/O-bound (wait for stdout data → postMessage), not CPU-bound.
2. Under N instances, a single worker is still far less overhead than N × main-thread I/O polling.

If a single worker cannot keep up under peak load (e.g., 8+ streaming agents simultaneously), the gateway can **shard by instanceId** across a small fixed pool (2–4 workers). This is analogous to the `background-jobs/process-lane-gateway.ts` approach.

---

## Electron-Import Isolation: How This Design Avoids the Hazard

The worker entry file (`cli-spawn-worker-main.ts`) must satisfy the same guardrail enforced for `conversation-ledger-worker-main.ts` and `context-worker-main.ts`: its value-import closure must not contain any top-level `import ... from 'electron'`.

The spawn worker needs to import only:

- `node:child_process` (spawn)
- `node:worker_threads` (parentPort, isMainThread, workerData)
- `../security/env-filter` (getSafeEnvForTrustedProcess) — no electron import
- `../cli/cli-environment` (buildCliSpawnOptions) — no electron import
- `./base-cli-process-utils` (killProcessGroup) — no electron import
- `../logging/logger` — no electron import

It does **not** import `BaseCliAdapter`, any concrete adapter class, `app-server-broker.ts`, `rtk-runtime.ts`, or `hook-path-resolver.ts`. Those all stay in the main process.

The three files with top-level electron imports remain main-process-only:

- **`app-server-broker.ts`**: already main-process-only (Codex app-server mode is Tier C above).
- **`rtk-runtime.ts`**: RTK binary path resolution can be done on the main thread before the spawn RPC is sent. The resolved binary path is included in the `spawn` message's `env` payload, so the worker never needs to call `app.getPath()`.
- **`hook-path-resolver.ts`**: Hook paths are resolved on the main thread in `buildSettingsOverlay()` (ClaudeCliAdapter constructor) and the resolved hook command string is already embedded in the CLI args array before the spawn call. The worker only receives the final `args` array, never the hook path resolver.

The existing pattern from `adapter-spawn-helpers.ts` line 96 (lazy guarded `require('electron')`) is the fallback for any main-process utility that needs `app.getPath()` but might be imported in a context that later gets used in a worker. The spawn worker does not import `adapter-spawn-helpers.ts` at all — all path resolution happens on the main thread before the RPC.

A sibling isolation spec (`cli-spawn-worker-import-isolation.spec.ts`) should be added, following the exact same static-analysis pattern as `conversation-ledger-worker-import-isolation.spec.ts` (lines 1–145), with a `CLOSURE_SIZE_CEILING` of ~30 modules.

---

## Migration Strategy

### Phase 1: Pilot — ClaudeCliAdapter, behind a feature flag

1. **Implement `cli-spawn-worker-main.ts`** under `src/main/cli/spawn-worker/`. The worker manages a `Map<instanceId, ManagedSpawn>` where `ManagedSpawn` holds the `ChildProcess`, its buffer, and the flush timer.

2. **Implement `CliSpawnWorkerGateway`** (main process) following `ConversationLedgerWorkerClient` as the template:
   - Creates the worker thread (`.js` in packaged build, `.ts` with `tsx` in dev).
   - Maintains pending RPC map with timeouts.
   - Handles worker crash → restart with backoff (same `MAX_RESTART_ATTEMPTS` pattern).
   - Exposes `spawnInstance()`, `writeStdin()`, `sendSignal()`, `terminate()`, and registers a `stdout-chunk` / `stderr-chunk` / `exited` / `stream-idle` event callback per instance.

3. **Implement `CliAdapterWorkerProxy`** which implements the same interface as `BaseCliAdapter` but routes every call through `CliSpawnWorkerGateway`. It does NOT extend `BaseCliAdapter` (to avoid pulling in the full EventEmitter-and-ChildProcess graph). It extends `EventEmitter` and emits `output`, `complete`, `error`, `spawned`, `stream:idle`, `stderr`, `heartbeat` events by translating incoming worker messages.

4. **Gate in `ProviderRuntimeService.createAdapter()`** behind `settings.get('enableSpawnWorkerOffload', false)`. When the flag is on, return a `CliAdapterWorkerProxy` for `claude-cli` (non-ACP) and `gemini-cli`; otherwise return the existing concrete adapter. This is a single-call-site change.

5. **Write the isolation spec** for the worker's import closure.

6. **Write a parity spec** comparing the proxy's emitted events against the existing adapter's emitted events (extend the existing `adapter-parity.spec.ts` pattern in `src/main/cli/__tests__/`).

### Phase 2: Extend to Gemini and Codex exec-mode (Tier A adapters)

Gemini and Codex exec-mode are structurally identical to Claude non-ACP: one spawn per turn, stdio, no persistent handle. They can be added to the proxy by extending the `spawn` message's `command`/`args` vocabulary.

### Phase 3: Tier B persistent-session adapters

ACP, Copilot, Cursor all share a single long-lived process with continuous stdin writes. The protocol is the same but the session lifetime spans many turns. Additional protocol messages:

- `stdin-write` becomes the hot path (one per turn) rather than one-shot at spawn time.
- `getSessionId` / `setSessionId` are state that the worker maintains per-instanceId.
- `interrupt()` maps to a `signal` message (SIGINT).
- The `formatter` (InputFormatter / stdin wrapping logic) moves into the worker.

The main thread loses direct access to the `ChildProcess.pid` for resume logic; the `spawned` message carries the pid and the proxy caches it.

Tier B migration carries more risk (state leakage on worker crash, resume coordination) and should be done in a dedicated phase after Tier A is stable in production.

---

## Risks

### 1. PTY handle ownership on worker crash

In the current design, if the spawn worker crashes mid-session (e.g., an uncaught exception in the worker's I/O plumbing), the CLI child processes it was managing **may be orphaned**: the worker's cleanup code does not run, the `ChildProcess.on('exit')` callbacks are lost, and the child PIDs are no longer tracked.

**Mitigation:** The worker must install an `uncaughtException` handler that SIGTERMs every managed PID before exiting. The `killProcessGroup()` call is synchronous and survives even a crash handler. On the main thread, the gateway's `worker.on('exit', ...)` handler must attempt SIGKILL on any PIDs that were reported via `spawned` messages but have not yet received `exited` messages. The gateway tracks `liveInstancePids: Map<instanceId, number>` for exactly this purpose.

### 2. Backpressure: stdout flooding main thread

If a CLI produces output faster than the main thread can process `postMessage` events (e.g., Gemini token-by-token SSE of 50K tokens), the worker's `postMessage` queue depth can grow unboundedly. Node.js worker message queues have no built-in backpressure.

**Mitigation:** The coalescing flush (30ms / 16KB) described above reduces message count ~100x. For pathological cases, the worker can implement a soft cap: if the unsent buffer exceeds `OUTPUT_FLUSH_MAX_CHARS * 4` (64KB), apply a short sleep before the next `postMessage`. This is acceptable because the CLI's own pipe buffer will absorb the pause. A hard cap would drop output, which is never acceptable for correctness.

### 3. stdin ordering and EPIPE handling

With async `stdin-write` RPCs, two rapid sends from the main thread (e.g., initial message + immediate interrupt recovery) could arrive out of order or race with process exit. The `ChildProcess.stdin` write and the EPIPE guard logic (lines 455–465 of `base-cli-adapter.ts`) must be reproduced faithfully in the worker. EPIPE must not propagate as a worker crash.

**Mitigation:** The worker processes stdin-write messages serially (one-at-a-time queue per instanceId, same as `safeStdinWrite()`). EPIPE on stdin is caught and reported as an `epipe` notification message (not an error), consistent with the existing `err.code === 'EPIPE'` guard in `BaseCliAdapter`.

### 4. Process-generation counter and stale watchdog

`BaseCliAdapter` uses a `processGeneration` counter (line 184) to prevent stale watchdog callbacks from firing on a new process after respawn. This state lives in the worker as part of `ManagedSpawn`. The main-thread proxy is stateless with respect to generation; it simply forwards `stream-idle` events as they arrive. If a stale idle fires in the worker (between the `exited` message and the main thread's cleanup), the main thread must ignore `stream-idle` events for an instance after it has received `exited`.

### 5. Resume and session ID handoff

ClaudeCliAdapter (ACP), Codex, and other session-bearing adapters carry `sessionId` state. In the worker design, `sessionId` is reported back in the `spawn` RPC response and cached on the proxy. On respawn, the proxy includes the `sessionId` in the new `spawn` message. This is mechanical but must be verified end-to-end — a lost session ID causes a full new session instead of a resume.

### 6. Warm-start adapter compatibility

`InstanceLifecycleManager` (line 1403) checks for pre-warmed adapters before spawning. Warm-start adapters are concrete `CliAdapter` instances constructed and spawned in advance. If the spawn worker is enabled, warm-start adapters must be proxies backed by the worker (i.e., the warm-start manager must also go through the worker). A simpler interim approach: disable warm-start when the spawn-worker flag is on, which is safe (warm-start is a latency optimization, not a correctness requirement).

### 7. `BaseCliAdapter.activeProcesses` orphan cleanup

The static `activeProcesses` set (line 104) is used by `killAllActiveProcesses()` and `killAllActiveProcessesGraceful()` on app quit (called from Electron `before-quit`). When the spawn worker owns the handles, this static set is empty on the main thread. The `before-quit` path must be updated to send a `shutdown` RPC to the worker, which then performs the graceful drain itself before calling `process.exit(0)`.

---

## Open Decisions for James

1. **`worker_thread` vs. `utilityProcess`**: The existing worker pattern uses `node:worker_threads` (shared memory, postMessage, parentPort). Electron's `utilityProcess.fork()` is also used in `ProcessLaneGateway` (`process-lane-gateway.ts:201`) and provides a separate OS process (stronger isolation, independent crash domain). For spawn offload, `worker_thread` is simpler (no separate binary, no inter-process socket). `utilityProcess` would be correct if we want true crash isolation from the main process — a crashed spawn thread cannot corrupt Electron's main heap. Recommendation: start with `worker_thread` to match the existing pattern; evaluate `utilityProcess` if worker crashes prove problematic. `ProcessLaneGateway` already demonstrates how to switch transparently (it tries `utilityProcess.fork` first and falls back to `node:child_process.fork`).

2. **Sharding threshold**: How many concurrent streaming instances justify adding a second spawn worker? Current max tested is ~8 loop-mode agents. A single worker thread should handle this without saturation. No sharding needed for Phase 1; revisit if profiling shows the worker event loop above ~20% CPU under peak load.

3. **Whether to keep `BaseCliAdapter.activeProcesses` for non-proxied adapters**: During Phase 1 the flag may be off by default, leaving direct adapters in use. The static set is still needed for those. In the long run (Phase 3 complete), the static set can be removed from `BaseCliAdapter` entirely once all adapters go through the proxy.

4. **Codex Tier C / app-server broker**: `app-server-broker.ts` uses `import { app } from 'electron'` at line 26 for `app.getPath('userData')`. This is called in `CodexBrokerManager.getSessionDir()`. It cannot move into a worker without the lazy-guarded require conversion. Whether this broker should eventually move to a dedicated `utilityProcess` (for stronger crash isolation, since a broker crash kills all Codex sessions) is a separate design decision and out of scope for D4.

5. **Testing approach for proxy parity**: The existing `out-of-process-fixture-adapter.spec.ts` already exercises adapter behavior via a fixture subprocess. The `CliAdapterWorkerProxy` should be testable via the same fixture mechanism with the worker injected via the `workerFactory` option, following the `ConversationLedgerWorkerClient` injectable-factory pattern.

---

## Summary

The design keeps the `ChildProcess` handle entirely inside a `worker_thread`-based spawn worker. The main thread retains all orchestration, state management, and IPC, interacting with CLI processes through a lightweight proxy adapter. The electron-import hazard is avoided by not importing any of the three top-level electron importers (`app-server-broker.ts`, `rtk-runtime.ts`, `hook-path-resolver.ts`) into the worker — path and hook resolution happens on the main thread before the `spawn` RPC is sent. Migration starts with ClaudeCliAdapter non-ACP (Tier A) behind a feature flag, following the established ledger/context worker pattern with a companion isolation spec.
