# ADR D1: Thin-Client Event API

**Date:** 2026-06-06
**Status:** Completed and verified 2026-06-07 (`tsc`, spec `tsc`, lint, IPC
channel sync, D1 focused tests, full test suite).
**Type:** Architecture Decision Record

---

## Parallel-Agent Ownership Boundary

> Added 2026-06-06 to let this doc be handed to a single agent without clashing
> with the D4 (spawn offload), D5 (plugin sandboxing), or Auxiliary Local Model
> Routing docs. Verified against the live tree: D1/D4/D5 are greenfield; the
> Auxiliary plan is already implemented & committed.

**This doc OWNS (edit freely):**
- `src/main/event-bus/**` — new (`main-event-bus.ts`, transports).
- `src/main/window-manager.ts` — `sendToRenderer` shim.
- `src/main/app/instance-event-forwarding.ts`.
- `src/main/ipc/ipc-main-runtime-wiring.ts`.
- `src/main/ipc/handlers/*` — the ~14 handler files that hold direct
  `webContents.send` calls (mcp, settings, vcs, todo, cost, quota, file,
  supervision, provider, chat, operator, codebase, llm, ecosystem).
- `src/shared/types/workflow-lifecycle.types.ts` (+ its spec).
- `src/shared/types/index.ts` — append **only** the `ThinClientEvent` barrel
  export line (see shared-file note below).

**Shared boundary files — coordinate, do NOT free-edit:**
- `src/shared/types/index.ts`: append-only. Add exactly one
  `export * from './thin-client-event.types';` line; do not touch existing lines.
- `src/main/ipc/ipc-main-handler.ts` (**Phase 4 only**, `STATE_RESYNC`): the
  Auxiliary plan already registered handlers here (committed). Append your
  registration; do not rewrite existing ones.
- `src/main/remote-node/worker-node-connection.ts` (**Phase 5 only**, WS
  transport): currently free, but it is remote-node infrastructure the Auxiliary
  RPC work lives next to (`worker-node-rpc.ts`). Treat as shared.

**Sequencing:** Phases 0–3 are fully isolated and parallel-safe. **Defer Phases
4 (STATE_RESYNC) and 5 (WebSocket transport)** to a follow-up run after the
parallel batch — they are the only places D1 touches files the Auxiliary plan
already owns, and the ADR itself flags them as optional/open questions.

**Do NOT touch (owned by other docs):** `src/main/cli/**` (D4),
`src/main/providers/**` (D4), `src/main/instance/**` (D4),
`src/main/plugins/**` + plugin schemas/SDK (D5), `src/main/rlm/**`,
`src/main/context/**`, `src/main/memory/**`, `src/main/routing/**`,
`src/worker-agent/**`, `src/main/remote-node/worker-node-rpc.ts`,
`src/renderer/app/features/settings/**` (Auxiliary).

---

## 1. Context — current coupling, evidenced

### 1.1 The IPC surface is enormous

The generated channel table at `src/preload/generated/channels.ts:5-47` defines **963 named channels** across the following categories (approximate breakdown):

| Category | Channels | Direction |
|---|---|---|
| Instance lifecycle / control | ~30 | invoke + push |
| Provider runtime events / output | ~15 | push |
| Loop control + events | ~35 | invoke + push |
| Chat management | ~15 | invoke + push |
| Workflows / debates / verification | ~60 | invoke + push |
| Memory / RLM / knowledge graph | ~75 | invoke + push |
| File / VCS / snapshot / editor | ~80 | invoke + push |
| MCP / plugins / settings / CLI | ~75 | invoke + push |
| Cost / quota / stats / logging | ~50 | invoke + push |
| LSP / search / automation / voice | ~55 | invoke + push |
| Remote nodes / FS / observer | ~50 | invoke + push |
| Security / diagnostics / misc | ~60 | invoke + push |
| Browser gateway | ~35 | invoke + push |
| Terminal | ~7 | invoke + push |
| Everything else | ~221 | invoke + push |

Roughly 129 of the 963 channels are push-style event channels (by naming convention: `*:created`, `*:changed`, `*:updated`, `*:event`, `*:started`, `*:completed`, `*:error`, `*:warning`, etc.).

### 1.2 How the renderer gets state today

The coupling runs in five layers:

**Layer 1 — contextBridge (`src/preload/preload.ts:56-87`)**
`contextBridge.exposeInMainWorld('electronAPI', electronAPI)` composes 25 domain factories (e.g. `createInstanceDomain`, `createChatDomain`, `createLoopDomain`, …). Every factory calls `ipcRenderer.invoke` for request/response and `ipcRenderer.on` for event subscriptions. The entire renderer can only reach the main process through this object.

**Layer 2 — `ElectronIpcService` (`src/renderer/app/core/services/ipc/electron-ipc.service.ts:69-188`)**
A root Angular service that holds `window.electronAPI` and provides typed `invoke(channel, payload)` and `on(channel, callback)` helpers. It converts channel names like `'instance:state-update'` to camelCase method names and calls through to the preload domain methods. It also wraps all callbacks in `NgZone.run()` to trigger Angular's zoneless change detection.

**Layer 3 — 60+ domain IPC services** (`src/renderer/app/core/services/ipc/*.service.ts`)
Each wraps `ElectronIpcService` for a subdomain: `InstanceIpcService`, `ChatIpcService`, `LoopIpcService`, etc. These are injected directly by feature components and stores. `IpcFacadeService` (`src/renderer/app/core/services/ipc/index.ts:99-625`) provides a deprecated flat aggregate of all of them for backward compatibility.

**Layer 4 — `IpcEventBusService` (`src/renderer/app/core/services/ipc/ipc-event-bus.service.ts:97-144`)**
Converts the `ipcRenderer.on`-style subscriptions from `InstanceIpcService` and `InstanceEventsService` into RxJS `Observable` streams (`instanceCreated$`, `instanceOutput$`, `batchUpdate$`, etc.) shared across the app.

**Layer 5 — Feature stores / components**
Signal-based stores inject domain services directly. The renderer has **no local state store** for the full instance graph; it reconstructs all live state from the push events it receives. This means any disconnection loses the view of state entirely.

### 1.3 How events are pushed to the renderer today

All push events reach the renderer through `webContents.send`. There are **63 call sites** across the codebase (counted by `grep`):

- `src/main/window-manager.ts:466` — `sendToRenderer(channel, ...args)` is the sole centralized helper.
- `src/main/app/instance-event-forwarding.ts` — wires `InstanceManager` events to `windowManager.sendToRenderer()` for the high-volume paths (instance lifecycle, `provider:runtime-event` at line 164, batch updates at line 203).
- `src/main/ipc/ipc-main-runtime-wiring.ts:85-343` — `setupIpcEventForwarding()` wires 10 subsystem event forwarders: memory, RLM, debate, verification, training, hot-switch, channels, reactions, knowledge graph, automations. Each calls `windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.XXX, data)` directly.
- Scattered handler files: `mcp-handlers.ts` (5 sends), `settings-handlers.ts` (5 sends), `vcs-handlers.ts` (2 sends), `todo-handlers.ts` (1 send), `cost-handlers.ts` (1 send), `quota-handlers.ts` (1 send), `file-handlers.ts` (4 sends), `supervision-handlers.ts` (1 send), `provider-handlers.ts` (3 sends), `chat-handlers.ts` (1 send), `operator-handlers.ts` (1 send), `codebase-handlers.ts` (1 send), `llm-ipc-handler.ts` (1 send), `ecosystem-handlers.ts` (1 send), plus menu sends in `window-manager.ts`.

**There is no central bus or fan-out adapter.** Every subsystem holds a direct reference to `WindowManager` and calls `webContents.send` independently. This was correctly identified as a structural problem in `docs/_archive/2026-05-28-thin-client-replatform-followup.md:32`: "Fan-out is not a single choke point — event fan-out to WS clients needs a funneling refactor first."

### 1.4 The existing B12 lifecycle projection

`src/shared/types/workflow-lifecycle.types.ts` already provides the coarse status projection that any thin-client dashboard event must use. The `WorkflowLifecyclePhase` type (`pending | running | paused | blocked | completed | failed | cancelled`) exhaustively covers instances, loops, and automation runs through `instanceStatusToPhase`, `loopStatusToPhase`, and `automationRunStatusToPhase`. The projection is self-maintaining: adding a new status to any source enum is a compile error until it is mapped here.

### 1.5 The seam that naturally exists

`WindowManager.sendToRenderer(channel, ...args)` at `src/main/window-manager.ts:464-468` is the correct insertion point for a thin-client transport layer. Every push event already routes through it (the calls in `ipc-main-runtime-wiring.ts` and `instance-event-forwarding.ts` use this helper). The only exceptions are the 20-odd handler-level `webContents.send` calls that bypass the helper; they would need to be folded in.

### 1.6 What the renderer does NOT have

- **No reconnect/resync logic.** If the window reloads or a remote client reconnects mid-session, there is no mechanism to re-hydrate state. The renderer restores from `listInstances()` + a fresh batch of push events.
- **No structured event envelope with correlation identity.** Events are bare payloads serialized per-channel with heterogeneous shapes. There is no common envelope (no `eventId`, `seq`, `timestamp`, `sourceSubsystem`) that a client could use to detect gaps or deduplicate.
- **No subscription negotiation.** Push channels are always on for any connected renderer. A mobile client wanting only instance lifecycle events still receives all 963 channels' traffic if no filtering is applied at the transport.

---

## 2. Decision

### 2.1 Summary

Introduce a **Thin-Client Event API** as a new transport-level contract that sits between `WindowManager.sendToRenderer()` and any connected client. The design is:

1. A **typed event envelope** — a common envelope schema wrapping every push event.
2. A **classified event taxonomy** — events grouped into tiers by volume and subscriber interest.
3. A **command vocabulary** — a narrow set of typed command messages clients send to mutate state or request data.
4. A **central event bus** in the main process — a single choke point that replaces all scattered `webContents.send` calls, enabling fan-out to multiple transports (Electron IPC, WebSocket, future mobile push).
5. **No changes to the existing preload/IpcService layer** for the Electron client — the Electron renderer continues to receive events exactly as today, translated from the new bus.

### 2.2 Event envelope schema

Every event emitted by the thin-client bus carries this envelope:

```typescript
interface ThinClientEvent<T = unknown> {
  /** Monotonically increasing per-transport sequence number (u32, wraps). */
  seq: number;
  /** Wall-clock timestamp (ms since epoch) from the main process. */
  ts: number;
  /** Event tier — used by clients to subscribe selectively. */
  tier: EventTier;
  /** Domain:verb string matching an existing IPC_CHANNELS value where possible. */
  type: string;
  /** The domain-specific payload. */
  payload: T;
}

type EventTier =
  | 'lifecycle'    // instance/loop/automation state changes (low frequency, always deliver)
  | 'output'       // streamed text/tool output from providers (high frequency)
  | 'status'       // background system status: memory, costs, quotas, CLI health (medium)
  | 'interaction'  // user-facing prompts: input-required, user-action-request (immediate, gated)
  | 'control'      // orchestration flow: workflow phase changes, debate rounds, verifications
  | 'infra'        // settings changes, MCP state, plugin loads, VCS, file watches (low-medium)
```

### 2.3 Event taxonomy — concrete events by tier

**Tier: `lifecycle`** — The minimum viable dashboard set. Every client subscribes.

| Event type | Existing IPC_CHANNEL | Payload key fields | WorkflowLifecyclePhase use |
|---|---|---|---|
| `instance:created` | `INSTANCE_CREATED` | `instanceId`, `displayName`, `provider`, `workingDirectory` | `instanceStatusToPhase(status)` |
| `instance:removed` | `INSTANCE_REMOVED` | `instanceId` | terminal |
| `instance:phase-changed` | synthetic (derived from `INSTANCE_STATE_UPDATE` + B12) | `instanceId`, `phase: WorkflowLifecyclePhase`, `status` | direct |
| `loop:phase-changed` | synthetic (derived from `LOOP_STATE_CHANGED` + B12) | `loopRunId`, `chatId`, `phase: WorkflowLifecyclePhase`, `status` | direct |
| `automation:phase-changed` | synthetic (derived from `AUTOMATION_RUN_CHANGED` + B12) | `runId`, `automationId`, `phase: WorkflowLifecyclePhase`, `status` | direct |
| `instance:context-warning` | `CONTEXT_WARNING` | `instanceId`, `pct`, `remaining` | n/a |
| `instance:compact-status` | `INSTANCE_COMPACT_STATUS` | `instanceId`, `status` | n/a |
| `memory:pressure` | `MEMORY_WARNING` / `MEMORY_CRITICAL` | `level: 'warning' | 'critical'`, `heapUsedMB` | n/a |

Note: The three `*:phase-changed` events are the only new synthetic events in this ADR. They replace the need for clients to subscribe to the full `instance:state-update` + batch-update storm to determine coarse lifecycle status. They use B12 projections directly.

**Tier: `output`** — High-frequency streaming. Clients subscribe per-instance.

| Event type | Existing IPC_CHANNEL | Notes |
|---|---|---|
| `provider:output-chunk` | `PROVIDER_RUNTIME_EVENT` (kind=`output`) | Streamed per turn |
| `provider:turn-complete` | `PROVIDER_RUNTIME_EVENT` (kind=`complete`) | One per agent turn |
| `instance:transcript-chunk` | `INSTANCE_TRANSCRIPT_CHUNK` | Serialized history chunk |

Clients that don't need live streaming (mobile summary view, remote status dashboard) subscribe to `lifecycle` only and poll for transcript on demand.

**Tier: `interaction`** — User-facing prompts requiring response. Always deliver, never drop.

| Event type | Existing IPC_CHANNEL | Notes |
|---|---|---|
| `instance:input-required` | `INPUT_REQUIRED` | Permission prompt from CLI |
| `instance:user-action-request` | `USER_ACTION_REQUEST` | Orchestrator asking operator a question |
| `workflow:gate-pending` | `WORKFLOW_GATE_PENDING` | Workflow awaiting approval |
| `plan:update` | `PLAN_MODE_UPDATE` | Plan mode state requiring response |

**Tier: `control`** — Orchestration mechanics. Subscribed by full-featured clients only.

| Event type | Existing IPC_CHANNEL |
|---|---|
| `workflow:phase-changed` | `WORKFLOW_PHASE_CHANGED` |
| `debate:round-complete` | `DEBATE_EVENT_ROUND_COMPLETE` |
| `verification:progress` | `VERIFICATION_EVENT_PROGRESS` |
| `verification:completed` | `VERIFICATION_EVENT_COMPLETED` |
| `orchestration:activity` | `ORCHESTRATION_ACTIVITY` |
| `loop:iteration-complete` | `LOOP_ITERATION_COMPLETE` |
| `loop:intervention-applied` | `LOOP_INTERVENTION_APPLIED` |
| `supervision:health-changed` | `SUPERVISION_HEALTH_CHANGED` |

**Tier: `status`** — Background telemetry.

| Event type | Existing IPC_CHANNEL |
|---|---|
| `cost:usage-recorded` | `COST_USAGE_RECORDED` |
| `quota:updated` | `QUOTA_UPDATED` |
| `quota:warning` | `QUOTA_WARNING` |
| `todo:list-changed` | `TODO_LIST_CHANGED` |
| `settings:changed` | `SETTINGS_CHANGED` |
| `mcp:server-status-changed` | `MCP_SERVER_STATUS_CHANGED` |

**Tier: `infra`** — Infrastructure events. Subscribed selectively.

| Event type | Existing IPC_CHANNEL |
|---|---|
| `vcs:status-changed` | `VCS_STATUS_CHANGED` |
| `watcher:file-changed` | `WATCHER_FILE_CHANGED` |
| `plugins:loaded` | `PLUGINS_LOADED` |
| `codebase:auto-status-changed` | `CODEBASE_AUTO_STATUS_CHANGED` |

### 2.4 Command vocabulary

Commands flow from client → main process. The current IPC has ~834 invoke-style channels. The thin-client command set is intentionally narrow — it covers only what a remote or mobile client needs to drive the orchestrator without having access to every handler:

```typescript
interface ThinClientCommand<T = unknown> {
  /** Unique command correlation ID (UUID) chosen by the client. */
  cmdId: string;
  /** Command name. */
  cmd: CommandName;
  /** Command payload. */
  payload: T;
}

type CommandName =
  // --- Instance control ---
  | 'instance:create'           // maps to INSTANCE_CREATE
  | 'instance:send-input'       // maps to INSTANCE_SEND_INPUT
  | 'instance:terminate'        // maps to INSTANCE_TERMINATE
  | 'instance:interrupt'        // maps to INSTANCE_INTERRUPT
  | 'instance:hibernate'        // maps to INSTANCE_HIBERNATE
  | 'instance:wake'             // maps to INSTANCE_WAKE
  | 'instance:list'             // maps to INSTANCE_LIST (query)
  | 'instance:respond-input'    // maps to INPUT_REQUIRED_RESPOND
  | 'instance:respond-action'   // maps to USER_ACTION_RESPOND
  // --- Loop control ---
  | 'loop:start'                // maps to LOOP_START
  | 'loop:pause'                // maps to LOOP_PAUSE
  | 'loop:resume'               // maps to LOOP_RESUME
  | 'loop:cancel'               // maps to LOOP_CANCEL
  | 'loop:intervene'            // maps to LOOP_INTERVENE
  | 'loop:accept-completion'    // maps to LOOP_ACCEPT_COMPLETION
  // --- Chat ---
  | 'chat:list'                 // maps to CHAT_LIST
  | 'chat:get'                  // maps to CHAT_GET
  | 'chat:create'               // maps to CHAT_CREATE
  | 'chat:send-message'         // maps to CHAT_SEND_MESSAGE
  // --- Snapshot / session ---
  | 'snapshot:take'             // maps to SNAPSHOT_TAKE
  | 'session:list-resumable'    // maps to SESSION_LIST_RESUMABLE
  // --- State sync ---
  | 'state:subscribe'           // Subscribe to specified tiers; replaces channel-per-event model
  | 'state:resync'              // Request full state snapshot (instance list + loop list)
```

Command responses follow the existing `IpcResponse<T>` shape, correlated by `cmdId`.

### 2.5 The central event bus

A new `MainEventBus` singleton in `src/main/event-bus/main-event-bus.ts` becomes the single owner of all push-event fan-out:

```typescript
class MainEventBus {
  /** Emit an event to all registered transports. */
  emit<T>(tier: EventTier, type: string, payload: T): void;
  /** Register a transport (Electron window, WS server, mobile push adapter). */
  addTransport(transport: EventTransport): void;
  removeTransport(transport: EventTransport): void;
}

interface EventTransport {
  /** Transports may filter by tier. */
  tiers: Set<EventTier> | 'all';
  send(event: ThinClientEvent): void;
}
```

`WindowManager.sendToRenderer()` becomes a one-line shim: `this.mainEventBus.emit('infra', channel, data)` with tier resolved from a lookup table. All 63 scattered `webContents.send` call sites are replaced by `mainEventBus.emit(tier, type, payload)`. The `ElectronWindowTransport` adapter (wrapping `webContents.send`) is the only transport active today.

### 2.6 State snapshot on (re)connect

Any client connecting to the thin-client transport (or the Electron window reloading) sends `state:resync`. The server responds with:

```typescript
interface StateSyncSnapshot {
  /** All active instances, serialized. */
  instances: SerializedInstance[];
  /** All active loop runs with their WorkflowLifecyclePhase. */
  loopRuns: LoopRunSummary[];
  /** All active automation runs with their WorkflowLifecyclePhase. */
  automationRuns: AutomationRunSummary[];
  /** Current pause state. */
  pauseState: PauseState;
  /** Current memory pressure level. */
  memoryPressure: 'normal' | 'warning' | 'critical';
  /** Snapshot seq (events after this seq are the live stream). */
  seq: number;
}
```

This eliminates the current "reload = cold start = re-invoke listInstances manually" behavior.

---

## 3. Granularity rationale — the key risk

### Too fine: channel-per-event-type (the current design)

963 channels means a remote client must either subscribe to all 963 or build a hand-maintained allowlist. Adding any new channel requires updating every non-Electron client. The current preload already has **60 domain service files** for 60 facets of the surface. For a mobile app or web dashboard this is untenable.

The current `PROVIDER_RUNTIME_EVENT` channel (a single channel carrying all provider events typed by `envelope.event.kind`) is an example of the right approach: one channel, typed payload. The rest of the system should follow this pattern, not the 963-channel approach.

### Too coarse: single multiplexed channel

One channel with `{ type: string; payload: unknown }` loses the ability for the transport layer to do tier-based filtering without parsing every payload. It also makes Zod schema validation harder (the type discriminant must be checked before payload validation).

### The right level: 6 tiers, ~40 typed event kinds

The tier model allows:
- A mobile summary client to subscribe to `lifecycle` + `interaction` only (~10 event types, manageable bandwidth).
- The Electron renderer to subscribe to all tiers (existing behavior, no regression).
- The WebSocket transport to filter by tier without parsing payloads.

The synthetic `*:phase-changed` events are the key addition: they let any client determine "is this instance/loop still live, and did it succeed or fail?" without implementing B12 projections themselves. B12 lives in `src/shared/types/workflow-lifecycle.types.ts` — zero new runtime dependencies needed since that file "has zero runtime dependencies beyond the type-only imports" (file comment, line 29).

---

## 4. Migration strategy — incremental, one subsystem at a time

### Phase 0: Central bus (no behavior change)

**Target:** `src/main/event-bus/main-event-bus.ts` + `WindowManager` shim.
**Work:** Create `MainEventBus` singleton. Register `ElectronWindowTransport` as the sole transport. Make `WindowManager.sendToRenderer()` delegate to `mainEventBus.emit()`. All existing behavior is identical; this is a pure refactor.
**Verify:** Existing test suite passes. Zero changes to `src/renderer/` or `src/preload/`.

### Phase 1: Fold the 20 handler-level `webContents.send` bypasses

**Target:** `src/main/ipc/handlers/mcp-handlers.ts`, `settings-handlers.ts`, `vcs-handlers.ts`, etc.
**Work:** Replace each direct `mainWindow.webContents.send(IPC_CHANNELS.X, data)` with `windowManager.sendToRenderer(IPC_CHANNELS.X, data)`. All these handlers already have `windowManager` in scope.
**Verify:** All event-driven IPC tests pass. The preload contract test (`src/preload/__tests__/ipc-channel-contract.spec.ts`) passes.

### Phase 2: Envelope wrapping + tier annotations

**Target:** `MainEventBus.emit()`.
**Work:** Add `seq` counter and `tier` field to the envelope as the bus emits. The `ElectronWindowTransport` strips the envelope and calls `webContents.send(type, payload)` as before, so the renderer sees no change. Add a tier lookup table mapping every `IPC_CHANNEL` value to a tier.
**Verify:** Existing behavior identical. New `ThinClientEvent` type is exported from `src/shared/`.

### Phase 3: Synthetic lifecycle phase events

**Target:** `MainEventBus` + `InstanceEventForwarding`.
**Work:** When `instance:state-update`, `loop:state-changed`, or `automation:run-changed` passes through the bus, derive the `WorkflowLifecyclePhase` via B12 projections and additionally emit `instance:phase-changed` / `loop:phase-changed` / `automation:phase-changed` on the `lifecycle` tier. Existing raw events continue to flow unchanged for the Electron renderer.
**Verify:** B12 projection unit tests (`src/shared/types/workflow-lifecycle.types.ts` — add spec if not present). Electron renderer continues to work; it ignores the new synthetic events.

### Phase 4: `state:resync` command + snapshot handler

**Target:** New IPC handler `STATE_RESYNC` + snapshot builder.
**Work:** Add a `state:resync` invoke handler that builds `StateSyncSnapshot` from `InstanceManager.listInstances()`, `LoopRunStore.listActive()`, etc. The Electron renderer can call this on window load instead of its current manual `listInstances()` + subscribe pattern.
**Verify:** New handler test. Renderer behavior unchanged (it can call either the old or new handler).

### Phase 5: WebSocket transport (enables web/mobile)

**Target:** `src/main/event-bus/ws-event-transport.ts` + wire into `MainEventBus`.
**Work:** Implement `WsEventTransport` using the existing worker-node WebSocket infrastructure (`src/main/remote/worker-node-connection.ts`). Re-use `ipcAuthToken` authentication. Clients send a `state:subscribe` command to choose their tier set, then receive `ThinClientEvent` envelopes.
**Verify:** New integration test. Existing Electron transport unaffected.

**First subsystem to migrate:** Instance lifecycle. It is the highest-value, lowest-complexity path — one `InstanceManager` event source, already centralized in `instance-event-forwarding.ts`, used by every conceivable client. The Loop subsystem follows (already has `LOOP_STATE_CHANGED` as a single channel), then the interaction tier (input-required + user-action-request).

**Do not migrate:** File watchers, LSP, snapshot, RLM, training, A/B, knowledge graph, and other deep-backend channels. Those remain invoke-only for non-Electron clients (reachable via the command vocabulary only when explicitly added).

---

## 5. Risks and tradeoffs

### Risk 1: Duplicate event emission during migration

During the transition, both the old `webContents.send` path and the new bus will coexist for some subsystems. The `ProviderOutputRendererGate` (`src/main/ipc/provider-output-renderer-gate.ts`) already handles exactly this deduplication pattern for `provider:runtime-event`. The same gate pattern can be applied to any subsystem where Phase 0-2 introduces a temporary double-send.

### Risk 2: The `output` tier is extremely high volume

`PROVIDER_RUNTIME_EVENT` can fire hundreds of times per second per active instance. The thin-client bus must not buffer `output`-tier events in memory. The `ElectronWindowTransport` continues to send these synchronously (current behavior). A WebSocket transport must implement backpressure (drop or pause the sender) rather than queue. This is not a problem to solve in Phases 0-3; it is a Phase 5 constraint.

### Risk 3: The 40-command vocabulary gaps

The 22-command vocabulary above covers the mobile control use case (from `docs/_archive` mobile plan). It does not cover the full Electron renderer's needs — the renderer will continue to use the full 963-channel IPC surface for local-only features (settings UI, LSP, VCS diff, file explorer, snapshot, etc.). This is correct: the thin-client command set is not a replacement for the full IPC surface, only a portable subset.

### Risk 4: Reconnect/resync correctness

The `state:resync` snapshot solves the "reload loses state" problem but introduces a TOCTOU gap: events between snapshot build and subscriber registration may be lost. The `seq` field in the envelope allows a client to detect this gap. Filling the gap (replay from `seq`) is a Phase 5+ concern and requires an event log, which does not exist today. For now, re-syncing on reconnect means "get current state and start receiving from now" — the same semantics the Electron renderer has today.

### Risk 5: Security — the existing trust gate

As noted in `docs/_archive/2026-05-28-thin-client-replatform-followup.md:31`, the existing `ipc-main-handler.ts` trust gate rejects non-window senders. The `MainEventBus` / `WsEventTransport` approach bypasses this because it is a separate send path, not a handler registration. The `ipcAuthToken` (issued at `app:ready`) must be required on the `state:subscribe` command and validated before any events are sent. Command payloads entering the main process via WebSocket must go through the same Zod schema validation as `ipcMain.handle` payloads.

### Tradeoff: Not replacing the full IPC surface

This ADR deliberately does not replace the 963-channel Electron IPC surface with the thin-client API. The full IPC is the right tool for the Electron renderer (strongly typed, process-local, fast). The thin-client API is additive — it provides a portable event+command projection suitable for clients that cannot use `contextBridge`. This is not the "strong thin client" described in the archived re-platform doc (that requires replacing the full IPC surface, which the archive doc correctly deferred).

---

## 6. Open decisions for James

1. **Tier names and boundaries.** The `status` vs `infra` split is somewhat arbitrary. Should they merge into one? The distinction is: `status` events directly affect cost/budget decisions (quota exhausted, budget alert) while `infra` events are structural configuration state. If a mobile app wants quota warnings, it subscribes to `status`. Worth a quick pass to confirm this split is intuitive.

2. **The `interaction` tier guarantee.** User-facing prompts (`input-required`, `user-action-request`) block agent progress if not responded to. The bus must guarantee these are delivered even if the subscriber briefly disconnects. This implies a small persistent store (one row per pending interaction, cleared on response). Is this worth building in Phase 5, or should interactions remain Electron-only for now?

3. **WebSocket transport: new server or reuse worker-node WS?** The existing `src/main/remote/worker-node-connection.ts` WebSocket is designed for machine-to-machine orchestration, not UI clients. Building a separate `ws-event-transport.ts` on a different port is cleaner but adds a second WS server. The mobile gateway already runs its own server (`src/main/mobile-gateway/`). Is this third WS server acceptable, or should the event transport ride the mobile gateway?

4. **Sequence number scope.** Should `seq` be per-transport (reset on reconnect) or global (persistent across restarts)? Per-transport is simpler. Global requires a persisted counter (e.g. in better-sqlite3). Global is needed only if replay-from-seq is a goal.

5. **`state:resync` in the Electron renderer.** The renderer today calls `listInstances()` manually on load (`InstanceIpcService.listInstances()`). Should Phase 4 wire the renderer to use `state:resync` instead? This would be the first consumer of the new shape, a good validation path, and simplifies the renderer's boot sequence — but it is a renderer change (touches `src/renderer/`) which this ADR's migration plan otherwise avoids until Phase 5.

6. **B12 synthetic events in the renderer.** Once `instance:phase-changed` events exist, the renderer's `IpcEventBusService` could listen to them instead of computing the phase from raw `instance:state-update`. This is a simplification but requires updating the renderer's existing subscription pattern. Low urgency since the renderer currently works; worth doing if the phase-changed event proves useful for the mobile client first.

7. **`output` tier delivery to non-Electron clients.** The mobile app's plan (`MEMORY.md: mobile-control-app-plan.md`) explicitly deferred streaming. Should the thin-client API mark `output`-tier events as opt-in and off by default for WebSocket clients, requiring an explicit `state:subscribe { tiers: [..., 'output'] }` command? This prevents the mobile gateway from accidentally becoming a streaming video pipe.

---

## Appendix: File:line evidence summary

| Claim | Location |
|---|---|
| 963 named channels | `src/preload/generated/channels.ts:5-47` |
| 25 preload domain factories | `src/preload/preload.ts:57-81` |
| contextBridge.exposeInMainWorld | `src/preload/preload.ts:103` |
| ElectronIpcService invoke/on pattern | `src/renderer/app/core/services/ipc/electron-ipc.service.ts:122-164` |
| NgZone wrapping of callbacks | `src/renderer/app/core/services/ipc/electron-ipc.service.ts:157` |
| IpcFacadeService (deprecated aggregate) | `src/renderer/app/core/services/ipc/index.ts:99-625` |
| IpcEventBusService RxJS observables | `src/renderer/app/core/services/ipc/ipc-event-bus.service.ts:102-143` |
| sendToRenderer central helper | `src/main/window-manager.ts:464-468` |
| 63 webContents.send call sites | grep count, confirmed |
| PROVIDER_RUNTIME_EVENT hot path | `src/main/app/instance-event-forwarding.ts:164` |
| setupIpcEventForwarding 10 subsystems | `src/main/ipc/ipc-main-runtime-wiring.ts:85-96` |
| ProviderOutputRendererGate dedup pattern | `src/main/ipc/provider-output-renderer-gate.ts:10-55` |
| WorkflowLifecyclePhase + projections | `src/shared/types/workflow-lifecycle.types.ts:52-158` |
| "zero runtime dependencies" B12 claim | `src/shared/types/workflow-lifecycle.types.ts:29` |
| Fan-out scatter problem (prior art) | `docs/_archive/2026-05-28-thin-client-replatform-followup.md:32` |
