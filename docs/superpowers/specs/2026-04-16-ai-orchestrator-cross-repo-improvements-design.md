# AI Orchestrator: Cross-Repo Improvements Design

**Date:** 2026-04-16
**Status:** Design — awaiting user review
**Scope:** Ten concrete improvements borrowed from `t3code`, `claw-code-parity`, `agent-orchestrator`, and related siblings, mapped to the existing WS1–WS6 remediation plan
**Related:** `docs/plans/2026-04-15-ai-orchestrator-improvement-plan.md` (augments, does not replace)

---

## 0. Executive Summary

AI Orchestrator is a mature Electron + Angular app with rich features but weak **contracts and determinism** between subsystems. The sibling projects in `~/work/orchestrat0r/` have each solved a slice of this problem in a different runtime:

| Source | Contribution |
|---|---|
| **t3code** (Bun/Effect/React) | Event-sourced orchestration, provider adapter pattern, DrainableWorker/ReceiptBus for deterministic async, remote pairing auth, monorepo subpath hygiene |
| **claw-code-parity** (Rust) | Worker lifecycle state machine, typed lane events + failure taxonomy, permission tiers, MCP lifecycle hardening, recovery recipes, policy engine, stale-branch detection, auto-compaction |
| **agent-orchestrator** (TS) | 8-slot plugin architecture, activity detection cascade, git-worktree workspace isolation, hash-namespaced flat-file layout |
| **openclaw / nanoclaw** (TS) | Plugin boundary discipline (already cited in WS4) |

This document proposes **10 improvements**, each concretized down to TypeScript interfaces, migration path, and test strategy. They fit inside WS1–WS6 (they are, in spirit, the "copy from inspiration" tasks already called out in those workstreams), with four additions that extend the plan.

**Explicit non-goal:** These 10 items are **not** one implementation plan. Each is a separate spec → plan → PR unit. This document is the shared architectural vision that governs how they relate and sequence.

---

## 1. Design Principles

Extracted from the sibling projects, ordered by what AI Orchestrator most needs:

1. **State machines, not conditionals.** Every long-lived runtime object (worker, session, MCP server, plugin) declares a finite state enum + transition map. Observed in claw-code-parity `WorkerStatus`, t3code orchestration commands, agent-orchestrator `SessionStatus`. Today AI Orchestrator has `InstanceStateMachine` (93 LOC, well-designed) but `instance-lifecycle.ts` (~3595 LOC, ~140 KB) threads transitions through conditional chains rather than using it everywhere.

2. **Typed events over parsed prose.** All state changes and failures emit structured events with enum `status` + enum `failureClass` + optional structured `data` blob, not log strings. Observed in claw-code-parity `LaneEvent`, t3code `ProviderRuntimeEvent`.

3. **One canonical envelope per boundary.** Provider-agnostic runtime events, schema-validated IPC messages, schema-validated plugin manifests. Each provider / plugin / channel maps into the canonical shape at its boundary, once. This is exactly WS3/WS4 restated.

4. **Partial success is first class.** `McpDegradedReport`, `RecoveryResult::PartialRecovery`, per-server failure classification. No "everything or nothing" error models.

5. **Recovery before escalation.** Known failures get one structured auto-recovery attempt before notifying the human. Escalation is an explicit policy choice, not a default.

6. **Deterministic async primitives for tests.** `DrainableWorker` (t3code), mock-anthropic-service (claw-code-parity). Tests `await bus.drain()` or replay fixtures instead of `await sleep(1000)`. This is exactly WS5 restated.

7. **Registries over context threading.** Singletons via `getXxx()` or `global_*_registry()` patterns with clean `_resetForTesting()` — AI Orchestrator already does this well, and should extend it consistently to new subsystems introduced here.

---

## 2. Current State Anchor Points

One-screen summary of where AI Orchestrator is today (cross-reference for every section below):

- **Contracts (WS1)**: Migrated. `packages/contracts/src/channels/` is the source of truth (~689 channels across 10 domain files); `src/shared/validation/ipc-schemas.ts` is a 15-line deprecation shim that re-exports. Remaining task: split `workspace.schemas.ts` per-domain, add a lint guard against shim imports.
- **Instance lifecycle (WS2)**: `src/main/instance/instance-lifecycle.ts` is 3595 lines. `InstanceStateMachine` exists at `src/main/instance/instance-state-machine.ts` (93 LOC) with 16 states and a declarative transition map — but is not the source of truth for transitions across all call sites. Session layer: `src/main/session/session-continuity.ts` has `SessionSnapshot` (v2 schema), `ResumeCursor`, `SessionState`.
- **Providers (WS3)**: `src/main/cli/adapters/base-cli-adapter.ts` (635 LOC) + Claude/Codex/Gemini/Copilot/Remote adapters. Event types: `'output' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'complete' | 'exit' | 'spawned'`. A `normalizeAdapterEvent()` exists (`src/main/providers/event-normalizer`) — referenced from `instance-communication.ts:29` — but each adapter still emits a different raw shape downstream.
- **Plugins/Skills (WS4)**: `src/main/plugins/plugin-manager.ts` already uses Zod (`PluginManifestSchema` from `@contracts/schemas`). Good. Skills have `SkillFrontmatterSchema`. Gaps are on hook payload validation and runtime SDK alignment.
- **Bootstrap (WS6)**: `src/main/index.ts` is ~350+ lines wiring ~40 singletons in ~22 sequential steps. `bootstrapAll()` exists (`src/main/bootstrap/registry.ts`) and is partially adopted via `registerOrchestrationBootstrap` / `registerLearningBootstrap` / `registerMemoryBootstrap` / `registerInfrastructureBootstrap`.
- **IPC**: Code-generated preload (`scripts/generate-preload-channels.js`) + verification (`scripts/verify-ipc-channels.js`). Solid.
- **Security**: `src/main/security/` — path validator, bash command parser, evasion detector, mode validator, permission manager, decision store. Today there is no unified "permission tier" abstraction — tool gating is scattered.
- **Checkpoints**: `src/main/session/checkpoint-manager.ts` — **not** git-backed; uses transaction log + file snapshots. `TransactionType` enum covers FILE_OPERATION, TOOL_EXECUTION, MODEL_SWITCH, PROVIDER_FAILOVER, CONTEXT_COMPACTION, SESSION_STATE, CHILD_SPAWN, MEMORY_OPERATION, CONFIG_CHANGE, RECOVERY_ACTION.
- **MCP**: Only codemem-specific (`src/main/codemem/mcp-*.ts`). No generic MCP framework.
- **Recovery**: `SessionRecoveryHandler` (two-phase: native-resume → replay-fallback), `builtin-recovery-recipes.ts`, `recovery-recipe-engine.ts`, `error-recovery.ts`. Already exists — just needs state-machine / event-driven rework.
- **Worker Agent**: `src/worker-agent/worker-agent.ts` — WebSocket RPC agent for remote nodes with critical-message queue and monotonic seq.

---

## 3. The Ten Improvements

Each section follows the same template so the doc is skimmable:

**Current state → Friction → Source pattern → Proposed shape → Migration path → WS alignment → Tests → Risks.**

Items 1–10 are numbered to match the prior research summary the user approved.

---

### Item 1 — Normalize Provider Runtime Events (WS3)

**Current state.** `BaseCliAdapter` emits adapter-specific events. Claude emits `'output' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'complete' | 'exit' | 'spawned'` with payloads typed as `CliResponse`, `CliToolCall`, `CliUsage`, and a raw `RawCliPayload` escape hatch. Codex has a near-parallel set (`CodexCliAdapterEvents`) with `context`, `error`, `exit`, `output`, `spawned`, `status`, plus `CodexDiagnostic` for structured errors. `normalizeAdapterEvent()` exists (imported at `instance-communication.ts:29`) but downstream code still special-cases per provider in several places (see `src/main/orchestration/`, telemetry exporters, `instance-communication.ts` branching).

**Friction.** Adding a new provider means editing telemetry, orchestration, UI event dispatch, and the state machine. Bug fixes for one provider silently miss others.

**Source pattern.** `t3code/packages/contracts/src/providerRuntime.ts` defines a single discriminated union of ~46 event variants keyed by `type`. `t3code/apps/server/src/provider/Services/ProviderAdapter.ts` is the `ProviderAdapterShape<TError>` interface every adapter implements. `ProviderAdapterRegistry` routes by `ProviderKind`. Both Claude and Codex adapters emit into `Stream.Stream<ProviderRuntimeEvent>` after normalization at their own boundary.

Key shape (translated to our stack):

```typescript
// packages/contracts/src/providerRuntime.ts
import { z } from 'zod';

export const ProviderKind = z.enum(['claude', 'codex', 'gemini', 'copilot', 'remote']);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ProviderRuntimeEventBase = z.object({
  eventId: z.string().uuid(),
  provider: ProviderKind,
  instanceId: z.string(),         // Our equivalent of t3code's threadId
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  requestId: z.string().optional(),
  createdAt: z.string().datetime(),
  raw: z.unknown().optional(),    // Provider-native payload for debugging
});
export type ProviderRuntimeEventBase = z.infer<typeof ProviderRuntimeEventBase>;
```

**Proposed shape.** A discriminated union grouped into five families (mirrors t3code's organization but narrower — we don't need their full 46 event types on day one):

```typescript
// packages/contracts/src/providerRuntime.ts (continued)

// Session family — session start/exit, configuration
export const ProviderRuntimeSessionEvent = z.discriminatedUnion('type', [
  ProviderRuntimeEventBase.extend({ type: z.literal('session.started'),
    payload: z.object({ sessionId: z.string(), resumeHint: z.unknown().optional() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('session.configured'),
    payload: z.object({ model: z.string(), permissionMode: z.string() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('session.exited'),
    payload: z.object({ exitCode: z.number().nullable(), reason: z.string() }) }),
]);

// Turn family — turn start/complete/abort
export const ProviderRuntimeTurnEvent = z.discriminatedUnion('type', [
  ProviderRuntimeEventBase.extend({ type: z.literal('turn.started'),
    payload: z.object({ turnId: z.string(), input: z.string() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('turn.completed'),
    payload: z.object({ turnId: z.string(), usage: UsageSchema }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('turn.aborted'),
    payload: z.object({ turnId: z.string(), reason: z.string() }) }),
]);

// Content family — streaming deltas
export const ProviderRuntimeContentEvent = z.discriminatedUnion('type', [
  ProviderRuntimeEventBase.extend({ type: z.literal('content.delta'),
    payload: z.object({ kind: z.enum(['assistant_text', 'reasoning_text', 'tool_use']),
                         delta: z.string() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('content.complete'),
    payload: z.object({ kind: z.string(), itemId: z.string() }) }),
]);

// Request family — permission requests, input requests
export const ProviderRuntimeRequestEvent = z.discriminatedUnion('type', [
  ProviderRuntimeEventBase.extend({ type: z.literal('request.permission'),
    payload: z.object({ requestId: z.string(), tool: z.string(), input: z.unknown() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('request.userInput'),
    payload: z.object({ requestId: z.string(), prompt: z.string(),
                         options: z.array(z.string()).optional() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('request.resolved'),
    payload: z.object({ requestId: z.string(), decision: z.unknown() }) }),
]);

// Runtime family — warnings, errors, meta
export const ProviderRuntimeRuntimeEvent = z.discriminatedUnion('type', [
  ProviderRuntimeEventBase.extend({ type: z.literal('runtime.warning'),
    payload: z.object({ category: z.string(), message: z.string() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('runtime.error'),
    payload: z.object({ category: z.string(), message: z.string(), fatal: z.boolean(),
                         raw: z.unknown().optional() }) }),
  ProviderRuntimeEventBase.extend({ type: z.literal('auth.status'),
    payload: z.object({ status: z.enum(['authenticated', 'expired', 'missing']) }) }),
]);

export const ProviderRuntimeEvent = z.union([
  ProviderRuntimeSessionEvent, ProviderRuntimeTurnEvent,
  ProviderRuntimeContentEvent, ProviderRuntimeRequestEvent,
  ProviderRuntimeRuntimeEvent,
]);
export type ProviderRuntimeEvent = z.infer<typeof ProviderRuntimeEvent>;
```

Every existing adapter implements an adapter-boundary `emit(event: ProviderRuntimeEvent)` call. Downstream consumers (orchestration, telemetry, UI) subscribe only to this shape.

**Adapter interface** (supersedes the event-specific part of `BaseCliAdapter`):

```typescript
// packages/sdk/src/providers.ts
import type { Observable } from 'rxjs';

export interface ProviderAdapterCapabilities {
  readonly sessionModelSwitch: 'in-session' | 'restart-session' | 'unsupported';
  readonly nativeCompaction: boolean;
  readonly deferPermissions: boolean;
}

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;

  startSession(input: ProviderSessionStartInput): Promise<ProviderSession>;
  sendTurn(input: ProviderSendTurnInput): Promise<void>;
  interruptTurn(instanceId: string, turnId?: string): Promise<void>;
  respondToRequest(instanceId: string, requestId: string, decision: unknown): Promise<void>;
  stopSession(instanceId: string): Promise<void>;

  /** Canonical event stream — every adapter normalizes into this. */
  readonly events$: Observable<ProviderRuntimeEvent>;
}

export interface ProviderAdapterRegistry {
  get(provider: ProviderKind): ProviderAdapter;
  list(): ReadonlyArray<ProviderKind>;
}
```

**Migration path.**

1. Land `packages/contracts/src/providerRuntime.ts` with the union and Zod validators.
2. Add `ProviderAdapter` to `packages/sdk/src/providers.ts`, aligning with existing SDK types.
3. For each adapter, add a `private emit(event: ProviderRuntimeEvent)` helper and a per-event translator. Start with Claude (most used), then Codex, Gemini, Copilot.
4. Maintain the legacy `EventEmitter` API in parallel during migration: each translator fires both the new event and the legacy event, so downstream consumers can be migrated incrementally.
5. Migrate downstream consumers one at a time: `instance-communication.ts`, orchestration, telemetry exporters, the renderer event dispatchers.
6. Once all downstream paths consume the normalized stream, remove the legacy emit calls and the `CliEvent` union.

**WS alignment.** This **is** WS3 per the existing plan. This design adds a concrete shape instead of "we'll figure it out."

**Tests.**
- Parity tests per provider: given a recorded fixture of raw output, assert the adapter emits the expected `ProviderRuntimeEvent[]` in order.
- Contract tests: any event emitted must parse against `ProviderRuntimeEvent` schema (Zod validator in dev builds).
- Scenario tests feed into WS5 harness (Item 3).

**Risks / open questions.**
- **Q:** Do we keep the legacy `CliEvent` emitter permanently for backward compat with external tools that may observe adapter events? Recommendation: deprecate with a 2-release window, logged on use.
- **Q:** Do `MCP tool events` live inside `content.delta` / `content.complete` (`kind: tool_use`) or a separate `tool.*` family? t3code uses a separate `item.*` and `tool.*` family — recommend we do the same once MCP is generalized (see Item 6).

---

### Item 2 — Explicit Worker/Instance State Machine with Typed Events (supports WS2 + WS5)

**Current state.** `InstanceStateMachine` exists at `src/main/instance/instance-state-machine.ts` (93 LOC) with 16 states (`initializing`, `ready`, `idle`, `busy`, `processing`, `thinking_deeply`, `waiting_for_input`, `waiting_for_permission`, `respawning`, `hibernating`, `hibernated`, `waking`, `error`, `degraded`, `failed`, `terminated`) and a declarative `TRANSITION_MAP`. This is **good design** — it's just underused. The 3595-line `instance-lifecycle.ts` threads state through conditional chains instead of routing every mutation through `stateMachine.transition(next)`.

**Friction.** WS2 is literally "extract lifecycle submodules." Without a central event + state spine, every extracted module has to re-learn what transitions are legal. With one, each submodule can subscribe to events and the lifecycle module shrinks into a sequencer that emits typed events.

**Source pattern.** `claw-code-parity/rust/crates/runtime/src/worker_boot.rs:34-163`:

```rust
pub enum WorkerStatus { Spawning, TrustRequired, ReadyForPrompt, Running, Finished, Failed }
pub enum WorkerEventKind {
    Spawning, TrustRequired, TrustResolved, ReadyForPrompt, PromptMisdelivery,
    PromptReplayArmed, Running, Restarted, Finished, Failed,
}
pub struct WorkerEvent {
    pub seq: u64, pub kind: WorkerEventKind, pub status: WorkerStatus,
    pub detail: Option<String>, pub payload: Option<WorkerEventPayload>, pub timestamp: u64,
}
```

Plus `lane_events.rs:5-91` — the higher-level "lane" events (`Started/Ready/Blocked/Red/Green/CommitCreated/PrOpened/MergeReady/Finished/Failed/Reconciled/Merged/Superseded/Closed/BranchStaleAgainstMain`) with a separate `LaneFailureClass` enum (`PromptDelivery, TrustGate, BranchDivergence, Compile, Test, PluginStartup, McpStartup, McpHandshake, GatewayRouting, ToolRuntime, Infra`).

**Proposed shape.** We already have the state enum. What we add is:

```typescript
// packages/contracts/src/instanceEvents.ts
import { z } from 'zod';
import { InstanceStatus } from './instance-status';

export const InstanceFailureClass = z.enum([
  'trust_gate',       // permission/consent not resolved
  'prompt_delivery',  // CLI did not receive prompt
  'provider',         // provider-level error (rate limit, auth)
  'protocol',         // malformed output, MCP handshake
  'tool_runtime',     // tool execution failed
  'plugin_startup',   // plugin failed to register
  'mcp_startup',      // MCP server failed to start
  'compile',          // project verification failed to compile
  'test',             // project tests failed
  'branch_divergence',// git branch diverged from main
  'infra',            // filesystem, process, network
]);
export type InstanceFailureClass = z.infer<typeof InstanceFailureClass>;

export const InstanceEventKind = z.enum([
  'lifecycle.spawning', 'lifecycle.trust_required', 'lifecycle.trust_resolved',
  'lifecycle.ready', 'lifecycle.running', 'lifecycle.idle', 'lifecycle.busy',
  'lifecycle.waiting_for_input', 'lifecycle.waiting_for_permission',
  'lifecycle.hibernating', 'lifecycle.hibernated', 'lifecycle.waking',
  'lifecycle.respawning', 'lifecycle.degraded', 'lifecycle.failed',
  'lifecycle.finished', 'lifecycle.terminated',
  'lane.started', 'lane.ready', 'lane.blocked', 'lane.red', 'lane.green',
  'lane.pr_opened', 'lane.merge_ready', 'lane.finished', 'lane.failed',
  'lane.reconciled', 'lane.merged', 'lane.superseded', 'lane.closed',
  'lane.branch_stale_against_main',
]);
export type InstanceEventKind = z.infer<typeof InstanceEventKind>;

export const InstanceEvent = z.object({
  seq: z.number().int().nonnegative(),
  instanceId: z.string(),
  kind: InstanceEventKind,
  status: InstanceStatus,                         // state at time of emit
  failureClass: InstanceFailureClass.optional(),  // only on failure kinds
  detail: z.string().optional(),
  data: z.record(z.unknown()).optional(),         // typed per-kind by consumers
  timestamp: z.string().datetime(),
});
export type InstanceEvent = z.infer<typeof InstanceEvent>;
```

**Routed through `InstanceStateMachine`:**

```typescript
// src/main/instance/instance-state-machine.ts (extended)
export class InstanceStateMachine {
  private _current: InstanceStatus;
  private _events: InstanceEvent[] = [];
  private _bus: InstanceEventBus;     // injected — emits to listeners

  transition(next: InstanceStatus, options?: {
    kind?: InstanceEventKind;
    failureClass?: InstanceFailureClass;
    detail?: string;
    data?: Record<string, unknown>;
  }): void {
    if (!this.canTransition(next)) {
      throw new IllegalTransitionError(this._current, next);
    }
    const prev = this._current;
    this._current = next;
    const event: InstanceEvent = {
      seq: this._events.length,
      instanceId: this.instanceId,
      kind: options?.kind ?? inferKindFromStatus(next),
      status: next,
      failureClass: options?.failureClass,
      detail: options?.detail,
      data: options?.data,
      timestamp: new Date().toISOString(),
    };
    this._events.push(event);
    this._bus.emit(event);
  }

  get events(): ReadonlyArray<InstanceEvent> { return this._events; }
}
```

The `InstanceEventBus` is per-instance, with a central aggregator (`src/main/instance/instance-event-aggregator.ts`) that forwards into IPC channels, telemetry, and the recovery engine.

**Migration path.**

1. Land `packages/contracts/src/instanceEvents.ts` (no runtime impact).
2. Extend `InstanceStateMachine` to optionally accept a `bus` and record events on transition.
3. Wire an `InstanceEventBus` singleton consumed by telemetry + renderer IPC (`instance:event-emitted` channel).
4. Route the easiest transition call sites first — instance spawner, session recovery, termination gate — through `stateMachine.transition(x, { kind, failureClass?, detail })` instead of direct status writes.
5. Each time `instance-lifecycle.ts` loses code to a focused module (per WS2 Tasks 1-2), verify that module interacts with state only via `stateMachine.transition(...)`.
6. Turn on a runtime assertion in dev builds: "instance status was mutated without passing through the state machine" (track via a Proxy wrapper on the `_state` field).

**WS alignment.** Directly enables WS2. Because `instance-lifecycle.ts` gets decomposed into focused modules that all speak the same event language, the extractions stop being stylistic and become structural. Also feeds WS5: deterministic recovery tests can assert on an `InstanceEvent[]` sequence.

**Tests.**
- `InstanceStateMachine` transition table: every legal transition emits exactly one event with expected kind + status. Illegal transitions throw.
- Event replay: given an `InstanceEvent[]` from a failed session, a reconstructor can rebuild the final status. Feeds WS5.
- Contract guards: every hardcoded `this._state = 'foo'` outside the state machine fails a lint rule (grep-based script in `scripts/verify-state-machine-discipline.js`).

**Risks / open questions.**
- **Q:** Are the 16 states currently defined sufficient, or do we collapse some (e.g., `ready` vs `idle`)? Audit usage before changing — keep current 16 as-is for WS2 scope.
- **Q:** Do Angular UI components subscribe to `InstanceEvent` directly or via a store? Use a signal-based store in `src/renderer/app/core/state/instance/` — WS6 will shrink the existing container components.

---

### Item 3 — Event-Sourced Orchestration Core (supports WS5)

**Current state.** Orchestration today is imperative: `OrchestrationEngine` (if named that — actually in `src/main/orchestration/`) owns 27 files covering debate, verification, consensus, synthesis, workflows, invokers. Events flow via `EventEmitter`s and ad-hoc callbacks. There is no central log of commands/events.

**Friction.** WS5 requires deterministic scenario tests. That is much easier against a command → event → projection log than against mutable state with side effects. Also: session recovery currently falls back to "replay" meaning "replay provider output," which is fragile. Replaying a command log is deterministic.

**Source pattern.** `t3code/apps/server/src/orchestration/Services/OrchestrationEngine.ts` + `Layers/OrchestrationEngine.ts`. Commands are enqueued onto an unbounded queue, serialized through a decider, projected into read models, persisted, and broadcast. Reactors (`ProviderRuntimeIngestion`, `ProviderCommandReactor`, `CheckpointReactor`) subscribe to the event stream and emit further commands. Critically: tests call `drain` on every reactor/queue and then assert — no `sleep`.

```typescript
// Key t3code shapes (from research):
interface OrchestrationEngineShape {
  getReadModel(): Effect<OrchestrationReadModel>;
  readEvents(fromSequenceExclusive: number): Stream<OrchestrationEvent>;
  dispatch(command: OrchestrationCommand): Effect<{ sequence: number }, OrchestrationDispatchError>;
  streamDomainEvents: Stream<OrchestrationEvent>;
}
```

**Proposed shape.** We don't need Effect — RxJS + a small `CommandBus` gets us there. The contract:

```typescript
// packages/contracts/src/orchestration.ts
export type OrchestrationCommand =
  | { type: 'session.create'; instanceId: string; config: SessionConfig }
  | { type: 'session.delete'; instanceId: string }
  | { type: 'turn.start'; instanceId: string; input: string }
  | { type: 'turn.interrupt'; instanceId: string; turnId: string }
  | { type: 'permission.respond'; instanceId: string; requestId: string; decision: PermissionDecision }
  | { type: 'checkpoint.revert'; instanceId: string; turnCount: number }
  // Internal (emitted by reactors, not clients):
  | { type: '_internal.provider.event'; instanceId: string; event: ProviderRuntimeEvent }
  | { type: '_internal.checkpoint.finalized'; instanceId: string; ref: CheckpointRef };

export type OrchestrationEvent = {
  sequence: number;
  eventId: string;
  aggregateKind: 'instance' | 'session' | 'workspace';
  aggregateId: string;
  occurredAt: string;
  commandId: string | null;
  causationEventId: string | null;
  correlationId: string | null;
  type: string;         // domain-specific event type
  payload: unknown;     // validated by domain-specific Zod schema
};
```

```typescript
// src/main/orchestration/orchestration-engine.ts (new, replaces ad-hoc dispatch)
export class OrchestrationEngine {
  constructor(
    private eventStore: OrchestrationEventStore,
    private decider: OrchestrationDecider,
    private projector: OrchestrationProjector,
    private domainBus: DomainEventBus,
  ) {}

  async dispatch(cmd: OrchestrationCommand): Promise<{ sequence: number }>;
  getReadModel(): OrchestrationReadModel;
  readEvents(fromSequence: number): AsyncIterable<OrchestrationEvent>;
  streamDomainEvents(): Observable<OrchestrationEvent>;
  async drain(): Promise<void>;    // test-only hook
}
```

**Projections** (read models):

```typescript
export interface InstanceProjection {
  instanceId: string;
  status: InstanceStatus;
  currentTurn?: { turnId: string; startedAt: string; state: 'running' | 'awaiting_permission' | 'awaiting_input' };
  checkpointCount: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  lastEventSeq: number;
}
```

**Reactors** (small classes with `start(): Promise<void>` and `drain(): Promise<void>`):

```typescript
// src/main/orchestration/reactors/provider-ingestion-reactor.ts
export class ProviderIngestionReactor {
  // Subscribes to ProviderAdapter.events$ for every active instance,
  // wraps each event in { type: '_internal.provider.event', ... }, dispatches.
  start(): Promise<void>;
  drain(): Promise<void>;
}

// src/main/orchestration/reactors/checkpoint-reactor.ts  (connects to Item 5)
export class CheckpointReactor {
  // Subscribes to domain events; on turn.completed, creates git checkpoint ref,
  // dispatches _internal.checkpoint.finalized when done.
  start(): Promise<void>;
  drain(): Promise<void>;
}

// src/main/orchestration/reactors/recovery-reactor.ts  (connects to Item 6 + Item 7)
export class RecoveryReactor {
  // Subscribes to lifecycle.failed events, runs recovery recipe, dispatches
  // restart / escalation commands.
  start(): Promise<void>;
  drain(): Promise<void>;
}
```

**Persistence.** `OrchestrationEventStore` is a better-sqlite3 table `orchestration_events(sequence INTEGER PK AUTOINCREMENT, event_id TEXT UNIQUE, aggregate_kind TEXT, aggregate_id TEXT, type TEXT, payload_json TEXT, occurred_at TEXT, command_id TEXT, causation_event_id TEXT, correlation_id TEXT)`. Append-only. Projections are built in-memory on startup and updated synchronously in the dispatch pipeline.

**Migration path.** This is the largest of the 10 items. Phased:

1. **Phase A (read-only, low risk):** Add the event store and event log emission for existing orchestration paths — debate coordinator, verification coordinator, session continuity. Every imperative action also emits an `OrchestrationEvent`. Nothing consumes these yet; they are a shadow log.
2. **Phase B:** Add `drain()` hooks on the event store and on `InstanceEventBus`. Convert a few unit tests to use them instead of `sleep`. Validate that event order is stable.
3. **Phase C:** Introduce the `CommandBus` + decider + projections for **one** aggregate (instance). Route `session.create` / `turn.start` / `turn.interrupt` through it. Keep the old paths as fallbacks, gated by a feature flag.
4. **Phase D:** Wire reactors. Provider ingestion reactor (depends on Item 1). Checkpoint reactor (depends on Item 5). Recovery reactor (depends on Item 7).
5. **Phase E:** Retire the imperative paths. WS5 deterministic tests are now the primary coverage.

**WS alignment.** This **is** WS5. WS5 as currently written lists scenarios to cover; this design proposes the mechanism that makes writing those scenarios tractable.

**Tests.**
- Scenario tests under `src/tests/harness/`: each scenario is a script of `OrchestrationCommand[]` + recorded provider fixtures, asserting on the emitted `OrchestrationEvent[]` sequence. Matches the WS5 required coverage list: streaming roundtrip, permission approve/deny, native resume, resume failure → replay, interrupt + respawn, MCP tool lifecycle, plugin hook roundtrip.
- Replay determinism: same command log + same fixtures ⇒ byte-identical event log across runs.

**Risks / open questions.**
- **Q:** Event store size — do we cap history? Recommend rolling archive at 100k events per instance with summary snapshot (fits with Item 4 — auto-compaction).
- **Q:** Can better-sqlite3 handle the write rate during heavy streaming? Benchmark before Phase C. Fallback: batch writes (buffer + flush every 100ms).
- **Q:** What happens if an event fails to persist? t3code's answer is to re-reconcile the in-memory read model from the persisted log. Adopt the same.

---

### Item 4 — Session Persistence with Auto-Compaction (extends WS2)

**Current state.** `src/main/session/session-continuity.ts` handles snapshot persistence (v2 schema with migration chain), archive, import/export. Compaction exists — `src/main/session/compact/` — and there's a `CONTEXT_COMPACTION` transaction type. Format today appears to be JSON snapshots + transaction logs.

**Friction.** Long sessions grow unboundedly unless someone clicks "compact." There's no token-threshold-driven automatic compaction. Recovery and diffing are harder because the format isn't a pure append-only log.

**Source pattern.** `claw-code-parity/rust/crates/runtime/src/compact.rs`:

```rust
pub struct CompactionConfig {
    pub preserve_recent_messages: usize,  // default 4
    pub max_estimated_tokens: usize,      // default 10_000
}
pub fn should_compact(session: &Session, config: CompactionConfig) -> bool { ... }
pub fn compact_session(session: &Session, config: CompactionConfig) -> CompactionResult { ... }
```

Logic: estimate tokens on all but the already-compacted prefix; if count ≥ threshold AND compactable messages > `preserve_recent_messages`, summarize the older messages via LLM, preserve the recent tail, emit a continuation message that instructs the assistant to "Continue without asking questions."

Session storage: JSONL with rotation — 256KB per file, 3 rotated files max (per earlier research).

**Proposed shape.**

```typescript
// src/main/session/compaction-policy.ts (new)
export interface CompactionPolicy {
  readonly preserveRecentMessages: number;     // default 4
  readonly maxEstimatedTokens: number;          // default 50_000 (vs claw's 10_000 — we have bigger contexts)
  readonly minCompactableMessages: number;      // default 10
}

export interface CompactionDecision {
  shouldCompact: boolean;
  estimatedTokens: number;
  compactableMessageCount: number;
  reason?: string;
}

export interface Compactor {
  decide(session: SessionState, policy: CompactionPolicy): CompactionDecision;
  compact(session: SessionState, policy: CompactionPolicy): Promise<CompactionResult>;
}

export interface CompactionResult {
  summary: string;
  formattedContinuation: string;
  compactedSession: SessionState;
  removedMessageCount: number;
  tokensBeforeCompact: number;
  tokensAfterCompact: number;
}
```

**Storage format.** Keep existing JSON snapshot on disk, but *also* add an append-only JSONL event stream per session:

```
~/Library/Application Support/ai-orchestrator/sessions/
  {instanceId}/
    session.json            # current full snapshot (latest)
    events.jsonl            # append-only event log (current rotation)
    events-1.jsonl          # rotated (256KB cap per file)
    events-2.jsonl
    events-3.jsonl          # max 3 rotations; oldest merged into snapshot on rotate
    compactions.jsonl       # history of compaction decisions + summaries
```

On rotation, the oldest rotated file is folded into `session.json` via an idempotent projection — same mechanism as the orchestration event store (Item 3), so this is "free" once Item 3 lands.

**Auto-compaction integration.** A `SessionCompactionReactor` subscribes to `turn.completed` events:

```typescript
export class SessionCompactionReactor {
  constructor(
    private compactor: Compactor,
    private policy: CompactionPolicy,
    private commandBus: CommandBus,
    private telemetry: Telemetry,
  ) {}

  async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    const session = await this.sessionStore.get(event.instanceId);
    const decision = this.compactor.decide(session, this.policy);
    if (!decision.shouldCompact) return;
    const result = await this.compactor.compact(session, this.policy);
    await this.commandBus.dispatch({
      type: 'session.compacted',
      instanceId: event.instanceId,
      result,
    });
    this.telemetry.recordCompaction(event.instanceId, {
      tokensBefore: result.tokensBeforeCompact,
      tokensAfter: result.tokensAfterCompact,
      removedCount: result.removedMessageCount,
    });
  }
}
```

Provider adapters with `capabilities.nativeCompaction === true` (Claude) delegate to the CLI's native `/compact`; those without use the provider-agnostic LLM-summary fallback.

**Migration path.**

1. Introduce `CompactionPolicy` and `Compactor` interfaces. Wrap the existing compaction code as the `LlmSummaryCompactor` implementation.
2. Add config to settings: per-provider auto-compaction toggle + thresholds.
3. Add JSONL event stream per session in parallel with current JSON snapshot. Dual-write for one release; use the JSONL stream read-only for diagnostics and replay.
4. Wire `SessionCompactionReactor` once the `CommandBus` from Item 3 exists.
5. Flip compaction to auto by default on new sessions; user can opt out.
6. Once JSONL is proven, treat `session.json` as a projection-only cache rebuildable from JSONL, not a source of truth.

**WS alignment.** Extends WS2 — session compaction is one of the "session responsibilities" WS2 Task 2 lists for extraction ("replay/native resume coordination"). Also contributes to WS5 (deterministic replay from event log).

**Tests.**
- `Compactor.decide()` returns correct decisions at thresholds (boundary tests).
- LLM-summary compactor produces a valid continuation message that passes through `SessionState` validators.
- Given a session + a series of turns exceeding threshold, auto-compaction fires once per threshold-crossing, not per turn.

**Risks / open questions.**
- **Q:** Token estimation fidelity — claw-code-parity uses a naive `estimate_message_tokens`. We need a better estimator (tiktoken-js or per-provider counters from `turn.completed` usage).
- **Q:** How do we preserve tool-call chains during compaction (don't drop a partial `tool_use` without its `tool_result`)? Policy: never split an open tool pair; round up `preserveRecentMessages` to the nearest complete turn.

---

### Item 5 — Git-Backed Checkpoint System (new — extends WS2 and WS5)

**Current state.** `src/main/session/checkpoint-manager.ts` stores checkpoints as file snapshots + transaction log. Works, but:
- Snapshots are opaque — you can't `git diff` them.
- No native integration with user's own git history.
- Revert is an application-specific operation, not a familiar git move.

**Friction.** Users already think in git refs. When an agent makes a destructive change, they want `git show` and `git diff` against a checkpoint, not a proprietary viewer. Also: checkpoint restore is currently coupled to the app; if the app dies, the user can still open the repo and get their data via git.

**Source pattern.** `t3code/apps/server/src/orchestration/Services/CheckpointReactor.ts` + the `OrchestrationCheckpointSummary` contract. Every `thread.turn-diff-completed` event triggers creation of a git ref like `refs/checkpoints/{threadId}/{turnId}`. File diffs (additions/deletions per path) are stored in the event log for fast UI; full content is reachable via the git ref.

```typescript
// t3code shape (from research):
const OrchestrationCheckpointSummary = Schema.Struct({
  turnId, checkpointTurnCount, checkpointRef, status,
  files: Array(OrchestrationCheckpointFile),   // path, kind, additions, deletions
  assistantMessageId: MessageId | null,
  completedAt: IsoDateTime,
});
const OrchestrationCheckpointStatus = Literals(['ready', 'missing', 'error']);
```

**Proposed shape.**

```typescript
// packages/contracts/src/checkpoints.ts
export const CheckpointStatus = z.enum(['ready', 'missing', 'error']);
export const CheckpointFileKind = z.enum(['added', 'modified', 'deleted', 'renamed']);

export const CheckpointFile = z.object({
  path: z.string(),
  kind: CheckpointFileKind,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const CheckpointSummary = z.object({
  checkpointId: z.string(),
  instanceId: z.string(),
  turnId: z.string(),
  turnCount: z.number().int().nonnegative(),
  checkpointRef: z.string(),           // full git ref, e.g. refs/orchestrator/checkpoints/{instanceId}/{turnId}
  gitSha: z.string(),                  // resolved commit sha
  status: CheckpointStatus,
  files: z.array(CheckpointFile),
  assistantMessageId: z.string().nullable(),
  completedAt: z.string().datetime(),
});
export type CheckpointSummary = z.infer<typeof CheckpointSummary>;
```

**Runtime API.**

```typescript
// src/main/session/git-checkpoint-store.ts
export interface GitCheckpointStore {
  /** Snapshot the current working tree as a git ref. */
  create(opts: {
    instanceId: string;
    turnId: string;
    assistantMessageId: string | null;
    workspaceRoot: string;
  }): Promise<CheckpointSummary>;

  /** List checkpoints for an instance. */
  list(instanceId: string): Promise<ReadonlyArray<CheckpointSummary>>;

  /** Restore the working tree to a checkpoint ref. */
  restore(checkpointId: string, opts: { strategy: 'hard' | 'stash-then-hard' }): Promise<void>;

  /** Compute diff between two checkpoints (or checkpoint ↔ working tree). */
  diff(aRef: string, bRef: string | 'WORKTREE'): Promise<CheckpointFile[]>;

  /** Garbage-collect checkpoints older than a policy threshold. */
  gc(opts: { instanceId: string; keepMostRecent: number; keepWithinDays: number }): Promise<number>;
}
```

**Implementation sketch.** Uses libgit2 bindings or plain `git` subprocess. Ref namespace: `refs/orchestrator/checkpoints/{instanceId}/{turnId}`. Each checkpoint is a real commit whose tree is the worktree state at turn end, parent = previous checkpoint (or working tree's HEAD if first). This gives us `git log refs/orchestrator/checkpoints/{instanceId}/HEAD` out of the box.

For workspaces that are not git repos: create a hidden `.git` shadow inside the app's session dir; never commit from the shadow back to the user's repo.

**Wiring.** `CheckpointReactor` (from Item 3) subscribes to `turn.completed` → creates checkpoint → emits `_internal.checkpoint.finalized` → decider emits domain event `thread.turn-diff-completed`.

**Migration path.**

1. Land `GitCheckpointStore` behind a feature flag. Implement for git-backed workspaces only.
2. Add a shadow-git fallback for non-git workspaces (later).
3. Wire `CheckpointReactor` once Item 3 Phase D lands.
4. Parallel-run with existing `checkpoint-manager.ts` for one release — always create both checkpoint types and compare.
5. UI: add "Open in Git" action alongside existing checkpoint viewer. Once parity is proven, migrate viewer to read from git refs.
6. Deprecate `checkpoint-manager.ts`'s file snapshot path (keep transaction log — that's still useful for non-file actions like MODEL_SWITCH).

**WS alignment.** Not an explicit WS item but touches WS2 (session module decomposition) and is required infrastructure for WS5 scenario 5 ("Native resume failure followed by replay fallback"): replay lands users at a specific checkpoint.

**Tests.**
- Checkpoint creation round-trip: create checkpoint → modify files → restore → `git status` clean matches original.
- GC policy: `gc({ keepMostRecent: 10, keepWithinDays: 7 })` on 100 checkpoints leaves exactly the expected set.
- Non-git workspace: shadow-git creation works and is isolated from any user-level git state.
- Concurrent turns in worktrees (agent-orchestrator pattern): checkpoints per worktree are isolated.

**Risks / open questions.**
- **Q:** Do we intrude on the user's git repo at all? **Strongly recommend no** — use refs under `refs/orchestrator/` that never appear in `git log` without explicit selection, never touch the user's branches, never push.
- **Q:** Repo size bloat from checkpoint tree commits? Run `git gc` on the user's repo is out of scope; we `git gc` our own namespace on `gc()` calls.
- **Q:** Interaction with the existing `TransactionType.FILE_OPERATION` log. Recommend: transaction log continues to record non-file actions (model switch, config change); file state is served from git checkpoints.

---

### Item 6 — Degraded-Mode MCP / Plugin Lifecycle Hardening (WS4)

**Current state.** Generic MCP infrastructure does not exist in AI Orchestrator. `src/main/codemem/mcp-*.ts` is codemem-specific. Plugins are Zod-validated at manifest level (`PluginManifestSchema`) but hook payload validation is lighter and there's no "this plugin's MCP server is down, keep going with the others" reporting.

**Friction.** Multi-MCP configurations fail atomically today. One misbehaving MCP server takes down the whole feature set. WS4's "harden plugins and skills" task is about manifest validation, but the deeper robustness win is lifecycle hardening.

**Source pattern.** `claw-code-parity/rust/crates/runtime/src/mcp_lifecycle_hardened.rs:15-253`:

```rust
pub enum McpLifecyclePhase {
    ConfigLoad, ServerRegistration, SpawnConnect, InitializeHandshake,
    ToolDiscovery, ResourceDiscovery, Ready, Invocation,
    ErrorSurfacing, Shutdown, Cleanup,
}
pub struct McpErrorSurface {
    pub phase: McpLifecyclePhase, pub server_name: Option<String>,
    pub message: String, pub context: BTreeMap<String, String>,
    pub recoverable: bool, pub timestamp: u64,
}
pub enum McpPhaseResult {
    Success { phase, duration },
    Failure { phase, error },
    Timeout { phase, waited, error },
}
pub struct McpDegradedReport {
    pub working_servers: Vec<String>, pub failed_servers: Vec<McpFailedServer>,
    pub available_tools: Vec<String>, pub missing_tools: Vec<String>,
}
```

**Proposed shape.**

```typescript
// packages/contracts/src/mcp.ts
export const McpLifecyclePhase = z.enum([
  'config_load', 'server_registration', 'spawn_connect', 'initialize_handshake',
  'tool_discovery', 'resource_discovery', 'ready', 'invocation',
  'error_surfacing', 'shutdown', 'cleanup',
]);
export type McpLifecyclePhase = z.infer<typeof McpLifecyclePhase>;

export const McpErrorSurface = z.object({
  phase: McpLifecyclePhase,
  serverName: z.string().nullable(),
  message: z.string(),
  context: z.record(z.string()),
  recoverable: z.boolean(),
  timestamp: z.string().datetime(),
});
export type McpErrorSurface = z.infer<typeof McpErrorSurface>;

export const McpPhaseResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('success'), phase: McpLifecyclePhase, durationMs: z.number() }),
  z.object({ outcome: z.literal('failure'), phase: McpLifecyclePhase, error: McpErrorSurface }),
  z.object({ outcome: z.literal('timeout'), phase: McpLifecyclePhase, waitedMs: z.number(), error: McpErrorSurface }),
]);
export type McpPhaseResult = z.infer<typeof McpPhaseResult>;

export const McpFailedServer = z.object({
  serverName: z.string(),
  phase: McpLifecyclePhase,
  error: McpErrorSurface,
});

export const McpDegradedReport = z.object({
  workingServers: z.array(z.string()),
  failedServers: z.array(McpFailedServer),
  availableTools: z.array(z.string()),
  missingTools: z.array(z.string()),
});
export type McpDegradedReport = z.infer<typeof McpDegradedReport>;
```

**Manager API.**

```typescript
// src/main/mcp/mcp-lifecycle-manager.ts (new)
export interface McpLifecycleManager {
  /** Start N MCP servers. Any that fail are reported but do not block others. */
  startAll(configs: McpServerConfig[]): Promise<McpDegradedReport>;

  /** Emits per-phase results as each server transitions. */
  readonly phaseResults$: Observable<McpPhaseResult & { serverName: string }>;

  /** Current degraded report (null if no servers started yet). */
  getCurrentDegradedReport(): McpDegradedReport | null;

  /** Attempt recovery for a failed server (one attempt, then escalate via recovery recipe). */
  recoverServer(serverName: string): Promise<McpPhaseResult>;

  /** Shutdown all servers cleanly. */
  shutdownAll(): Promise<void>;
}
```

**Plugin lifecycle follows the same pattern.** Each plugin has phases `manifest_load → validate → instantiate → register_hooks → ready → error_surfacing → shutdown`. A `PluginLifecycleManager` reuses the same shape with a different phase enum, emitting a `PluginDegradedReport`.

**Migration path.**

1. Land the contracts (no runtime impact).
2. Introduce `McpLifecycleManager` as a no-op wrapper that currently starts one MCP server (codemem) — emit degraded reports trivially.
3. Generalize to N MCP servers. Externalize MCP server configs into settings.
4. Refactor `PluginManager` (`src/main/plugins/plugin-manager.ts`) to use the same phased model. Align with WS4 Task 3 "Narrow plugin hook payload translators."
5. Surface degraded reports in the UI — a small banner: "3 of 4 MCP servers running. codemem-failed: initialize_handshake timeout. [retry]".
6. Wire recovery recipes (Item 7) for `mcp_handshake_failure` and `partial_plugin_startup` scenarios.

**WS alignment.** This is the structural upgrade that makes WS4's "harden plugins and skills" durable. WS4 as written addresses manifest validation; this item extends to runtime lifecycle.

**Tests.**
- Given N server configs where server[i] fails: report has N-1 working, 1 failed, and shows the right phase.
- Timeout handling: if a phase exceeds its per-phase timeout, result is `timeout` (not `failure`), with `waitedMs` populated.
- Recovery: a failed server can be recovered via one automatic retry; if that fails, it's marked unrecoverable.

**Risks / open questions.**
- **Q:** What per-phase timeouts? Defaults: config_load 1s, spawn_connect 5s, initialize_handshake 10s, tool_discovery 5s. Configurable per server.
- **Q:** If codemem's tools are in `missingTools`, does the UI auto-hide codemem-dependent features? Yes, bubble up to a capability-probe subsystem.

---

### Item 7 — Structured Permission Tiers + Recovery Recipes + Stale-Branch (extends security + new recovery subsystem)

**Current state.** Permissions are enforced across several files (`path-validator.ts`, `bash-validation/*`, `permission-manager.ts`, `permission-mapper.ts`, `PermissionDecisionStore`). There is no single "tier" abstraction — the various validators decide yes/no per tool without a unified mode concept. Recovery: `SessionRecoveryHandler`, `builtin-recovery-recipes.ts`, `recovery-recipe-engine.ts`, `error-recovery.ts` — substantial existing work, but not event-driven and not classifier-based.

**Friction.** Users can't say "this session is read-only" and trust it. Adding a new tool means threading validation logic through multiple validators. Recovery is reactive (on-error fallbacks) rather than structurally classified.

**Source pattern (permissions).** `claw-code-parity/rust/crates/runtime/src/permission_enforcer.rs:9-120`:

```rust
pub enum EnforcementResult {
    Allowed,
    Denied { tool: String, active_mode: String, required_mode: String, reason: String },
}
pub enum PermissionMode { ReadOnly, WorkspaceWrite, Allow, Prompt, DangerFullAccess }
// per-tool-type methods:
pub fn check(&self, tool_name: &str, input: &str) -> EnforcementResult
pub fn check_file_write(&self, path: &str, workspace_root: &str) -> EnforcementResult
pub fn check_bash(&self, command: &str) -> EnforcementResult
```

**Source pattern (recovery).** `claw-code-parity/rust/crates/runtime/src/recovery_recipes.rs:17-224`:

```rust
pub enum FailureScenario {
    TrustPromptUnresolved, PromptMisdelivery, StaleBranch, CompileRedCrossCrate,
    McpHandshakeFailure, PartialPluginStartup, ProviderFailure,
}
pub enum RecoveryStep {
    AcceptTrustPrompt, RedirectPromptToAgent, RebaseBranch, CleanBuild,
    RetryMcpHandshake { timeout: u64 }, RestartPlugin { name: String },
    RestartWorker, EscalateToHuman { reason: String },
}
pub enum EscalationPolicy { AlertHuman, LogAndContinue, Abort }
pub struct RecoveryRecipe {
    pub scenario: FailureScenario, pub steps: Vec<RecoveryStep>,
    pub max_attempts: u32, pub escalation_policy: EscalationPolicy,
}
pub fn recipe_for(scenario: &FailureScenario) -> RecoveryRecipe { /* mappings */ }
pub fn attempt_recovery(scenario: &FailureScenario, ctx: &mut RecoveryContext) -> RecoveryResult
```

Key invariant: **one automatic attempt, then escalate.** Each attempt emits `RecoveryEvent::RecoveryAttempted { scenario, recipe, result }`.

**Source pattern (stale branch).** `claw-code-parity/rust/crates/runtime/src/stale_branch.rs`:

```rust
pub enum BranchFreshness {
    Fresh,
    Stale { commits_behind: usize, missing_fixes: Vec<String> },
    Diverged { ahead: usize, behind: usize, missing_fixes: Vec<String> },
}
pub enum StaleBranchPolicy { AutoRebase, AutoMergeForward, WarnOnly, Block }
pub fn check_freshness(branch: &str, main_ref: &str) -> BranchFreshness
pub fn apply_policy(freshness: &BranchFreshness, policy: StaleBranchPolicy) -> StaleBranchAction
```

**Proposed shape (permissions).**

```typescript
// packages/contracts/src/permissions.ts
export const PermissionMode = z.enum([
  'read_only',           // no writes, no exec, no network
  'workspace_write',     // writes inside workspaceRoot only; safe bash
  'allow',               // unrestricted writes; any bash
  'prompt',              // every action requires UI confirmation
  'danger_full_access',  // no checks — warns aggressively
]);

export const EnforcementResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('allowed') }),
  z.object({
    outcome: z.literal('denied'),
    tool: z.string(),
    activeMode: PermissionMode,
    requiredMode: PermissionMode,
    reason: z.string(),
  }),
  z.object({
    outcome: z.literal('prompt_required'),
    tool: z.string(),
    input: z.unknown(),
    requestId: z.string(),
  }),
]);
export type EnforcementResult = z.infer<typeof EnforcementResult>;
```

```typescript
// src/main/security/permission-enforcer.ts (new — wraps existing validators)
export class PermissionEnforcer {
  constructor(
    private policy: PermissionPolicy,     // existing PermissionManager refactored
    private pathValidator: PathValidator, // existing
    private bashValidator: BashValidator, // existing
  ) {}

  check(toolName: string, input: unknown): EnforcementResult;
  checkFileWrite(path: string, workspaceRoot: string): EnforcementResult;
  checkBash(command: string): EnforcementResult;
  isAllowed(toolName: string, input: unknown): boolean;
  activeMode(): PermissionMode;
}
```

**Proposed shape (recovery recipes).**

```typescript
// packages/contracts/src/recovery.ts
export const FailureScenario = z.enum([
  'trust_prompt_unresolved', 'prompt_misdelivery', 'stale_branch',
  'compile_failure', 'mcp_handshake_failure', 'partial_plugin_startup',
  'provider_failure', 'session_resume_failure', 'permission_denied_retry',
]);

export const RecoveryStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept_trust_prompt') }),
  z.object({ kind: z.literal('rebase_branch'), baseRef: z.string() }),
  z.object({ kind: z.literal('merge_forward'), baseRef: z.string() }),
  z.object({ kind: z.literal('retry_mcp_handshake'), serverName: z.string(), timeoutMs: z.number() }),
  z.object({ kind: z.literal('restart_plugin'), name: z.string() }),
  z.object({ kind: z.literal('restart_instance') }),
  z.object({ kind: z.literal('replay_last_turn') }),
  z.object({ kind: z.literal('escalate_to_human'), reason: z.string() }),
]);

export const EscalationPolicy = z.enum(['alert_human', 'log_and_continue', 'abort']);

export const RecoveryRecipe = z.object({
  scenario: FailureScenario,
  steps: z.array(RecoveryStep),
  maxAttempts: z.number().int().positive(),
  escalationPolicy: EscalationPolicy,
});

export const RecoveryResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recovered'), stepsTaken: z.number() }),
  z.object({ kind: z.literal('partial'),
    recovered: z.array(RecoveryStep), remaining: z.array(RecoveryStep) }),
  z.object({ kind: z.literal('escalation_required'), reason: z.string() }),
]);
```

```typescript
// src/main/recovery/recovery-engine.ts (replaces pieces of recovery-recipe-engine.ts)
export class RecoveryEngine {
  constructor(
    private recipes: Map<FailureScenario, RecoveryRecipe>,
    private executor: RecoveryStepExecutor,  // dispatches each step to the right subsystem
    private bus: DomainEventBus,
  ) {}

  recipeFor(scenario: FailureScenario): RecoveryRecipe;
  async attempt(scenario: FailureScenario, ctx: RecoveryContext): Promise<RecoveryResult>;
}
```

**Proposed shape (stale branch).**

```typescript
// src/main/git/branch-freshness.ts (new)
export const BranchFreshness = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fresh') }),
  z.object({ kind: z.literal('stale'), commitsBehind: z.number(), missingFixes: z.array(z.string()) }),
  z.object({ kind: z.literal('diverged'), ahead: z.number(), behind: z.number(), missingFixes: z.array(z.string()) }),
]);
export const StaleBranchPolicy = z.enum(['auto_rebase', 'auto_merge_forward', 'warn_only', 'block']);

export interface BranchFreshnessChecker {
  check(workspaceRoot: string, branch: string, mainRef: string): Promise<BranchFreshness>;
  applyPolicy(freshness: BranchFreshness, policy: StaleBranchPolicy): StaleBranchAction;
}
```

**Migration path.**

1. **Permissions.** Land `PermissionMode` + `EnforcementResult` contracts. Refactor `PermissionManager` to expose `check(toolName, input): EnforcementResult`. Wrap existing validators as strategies. UI exposes mode switcher in session settings.
2. **Recovery.** Move recipes from `builtin-recovery-recipes.ts` into typed `RecoveryRecipe` objects with the structured step enum. `RecoveryEngine` uses the existing `recovery-recipe-engine.ts` as the step executor. Recovery reactor (Item 3) subscribes to failure events and invokes the engine.
3. **Stale branch.** Add `BranchFreshnessChecker`. Add a new failure scenario to `RecoveryEngine`. Wire as a pre-flight check before running broad verification tests in the worker agent. Emit `InstanceEvent.lane.branch_stale_against_main`.

**WS alignment.** Permissions: not explicit in WS1–WS6 but complements WS4 (tool surface hardening). Recovery recipes: directly supports WS5 scenarios 2, 3, 4, 5, 6. Stale branch: bonus — addresses a class of failures that currently surface as generic test failures.

**Tests.**
- Permissions: matrix of `PermissionMode × tool × inputShape → expected EnforcementResult`. For each mode, at least one `allowed` + one `denied` case.
- Recovery: `max_attempts=1` enforced — second call returns `escalation_required`. Mocked step executor validates event emission order.
- Stale branch: fresh / stale / diverged branches detected via git fixtures. Policy mapping is exhaustive.

**Risks / open questions.**
- **Q:** Does `prompt` mode flood users? Mitigation: per-tool-per-session "remember this decision" option stored in `PermissionDecisionStore`.
- **Q:** Can recovery recipes cascade (e.g., stale_branch recipe fails → escalate → recovery for escalation)? No — one scenario per attempt. Cascading is the human's job.
- **Q:** Stale-branch applies only when workspace has git. Behavior in non-git workspace: checker returns `fresh` sentinel + a one-time warning.

---

### Item 8 — Remote Pairing Protocol for Remote Nodes

**Current state.** `src/worker-agent/worker-agent.ts` already implements a WebSocket RPC agent with critical-message queue, auto-discovery, reconnect. What's missing is a principled **pairing** flow: today, trust between coordinator and worker node is either pre-shared-secret or discovery-LAN-only. Your dependency list (`discord.js`, `whatsapp-web.js`) hints you also want multi-channel human-facing trust (pair a phone to orchestrate a machine).

**Friction.** Long-lived shared secrets don't work for ad-hoc pairing (give a tablet access to a laptop's orchestrator). QR codes + one-time tokens are the standard in this space.

**Source pattern.** `t3code/REMOTE.md` + `apps/server/src/auth/Services/ServerAuth.ts` + `BootstrapCredentialService.ts`:

> 1. `t3 serve` issues a one-time owner pairing token.
> 2. The remote device exchanges that token with the server.
> 3. The server creates an authenticated session for that device.
> After pairing, future access is session-based.

The t3code types (paraphrased):

```typescript
type BootstrapCredentialRole = 'owner' | 'client';
interface BootstrapGrant {
  method: ServerAuthBootstrapMethod;  // 'bootstrap' | 'bearer' | 'session'
  role: BootstrapCredentialRole;
  subject: string;
  label?: string;
  expiresAt: DateTime;
}
interface ServerAuth {
  issuePairingCredential(input): Promise<PairingCredentialResult>;
  exchangeBootstrapCredential(credential, metadata): Promise<{ response, sessionToken }>;
  authenticateWebSocketUpgrade(request): Promise<AuthenticatedSession>;
  issueWebSocketToken(session): Promise<WebSocketTokenResult>;
  revokePairingLink(id): Promise<boolean>;
  listClientSessions(currentSessionId): Promise<ReadonlyArray<ClientSession>>;
  revokeOtherClientSessions(currentSessionId): Promise<number>;
}
```

**Proposed shape.**

```typescript
// packages/contracts/src/remoteAuth.ts
export const BootstrapRole = z.enum(['owner', 'client']);
export const BootstrapMethod = z.enum(['pairing_token', 'bearer_token', 'session']);

export const PairingCredential = z.object({
  id: z.string().uuid(),
  role: BootstrapRole,
  token: z.string(),                // one-time, 32 random bytes base64url
  label: z.string().optional(),     // "Pixel 8 Pro", "Sophia's iPad"
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const AuthenticatedSession = z.object({
  sessionId: z.string().uuid(),
  subject: z.string(),              // device fingerprint / hostname
  method: BootstrapMethod,
  role: BootstrapRole,
  expiresAt: z.string().datetime().optional(),
  issuedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

export const PairingPayload = z.object({
  pairingUrl: z.string().url(),     // ao://pair?server=10.0.0.5&port=4567&token=...
  qrCodePng: z.string().optional(), // base64 PNG for UI display
  expiresAt: z.string().datetime(),
});
```

```typescript
// src/main/auth/remote-auth.ts (new)
export interface RemoteAuth {
  issuePairingCredential(opts?: { role?: BootstrapRole; label?: string; ttlSec?: number }):
    Promise<{ credential: PairingCredential; payload: PairingPayload }>;

  exchangePairingToken(token: string, deviceMeta: DeviceMetadata):
    Promise<{ session: AuthenticatedSession; sessionToken: string }>;

  authenticateWebSocketUpgrade(request: IncomingMessage):
    Promise<AuthenticatedSession>;

  listPairingLinks(): Promise<ReadonlyArray<PairingCredential>>;
  listClientSessions(): Promise<ReadonlyArray<AuthenticatedSession>>;
  revokeClientSession(sessionId: string): Promise<boolean>;
  revokeOtherClientSessions(currentSessionId: string): Promise<number>;
}
```

**UI.** A settings panel "Remote devices" shows:
- Current pairings + last-seen timestamps.
- "Pair a device" button → QR code modal with 5-minute expiry countdown.
- "Revoke" per device + "Revoke all others."

**Integration.** `WorkerAgent` (existing) gains:
- Reads stored session token on startup; if present, connects directly.
- If no session token: prompts user to scan a QR code or paste a pairing URL. On submission, calls `exchangePairingToken` and stores the session token in OS keychain.
- WebSocket handshake: sends session token in an `Authorization: Bearer ...` header or `?token=...` query param.

Storage: session tokens in `electron-store` or OS keychain (`keytar`). Pairing tokens live only in memory on the coordinator and expire in TTL (default 5 min).

**Migration path.**

1. Land contracts.
2. Implement `RemoteAuth` in the main process. Store pairing links in-memory + expire; store AuthenticatedSessions in sqlite (better-sqlite3).
3. Add `pair` IPC channel for coordinator → renderer flow (QR code generation).
4. Modify `worker-agent.ts` handshake to send bearer token.
5. Modify coordinator WebSocket server to validate via `authenticateWebSocketUpgrade`.
6. Add settings UI panels.
7. Document for users in `docs/remote-nodes.md`.

**WS alignment.** Not in WS1–WS6. Independent addition — but aligns with the existing `2026-04-06-remote-nodes-ux-design.md` and `2026-04-09-remote-session-latency-design.md` specs that indicate active remote-nodes work.

**Tests.**
- One-time token invalidation: consumed once; second exchange returns `InvalidCredential`.
- TTL enforcement: expired tokens return `ExpiredCredential`.
- Session revocation: revoked session cannot re-establish WebSocket.
- Role separation: `client` role cannot call owner-only RPCs.

**Risks / open questions.**
- **Q:** Where do we store session tokens client-side? Recommendation: macOS Keychain via `keytar`; Windows Credential Manager; Linux libsecret.
- **Q:** Replay protection on pairing URLs shared over screen? Short TTL + HTTPS-equivalent for LAN (TLS self-signed with fingerprint in URL) or rely on physical-scan assumption for QR codes.
- **Q:** Does Discord/WhatsApp bot auth use the same flow? Recommend yes — `client` role tokens, revocable per bot.

---

### Item 9 — Plugin Architecture: 8 Slots + Uniform Module Contract (WS4)

**Current state.** `PluginManager` (`src/main/plugins/plugin-manager.ts`) loads plugins from `~/.orchestrator/plugins/**.js` and `<cwd>/.orchestrator/plugins/**.js` with `PluginManifestSchema` Zod validation. Skills live in `src/main/skills/` with `SkillFrontmatterSchema`. Hooks are bound via `hooks.ts`. Works, but:
- There is no **plugin slot** taxonomy — a plugin is just "a thing with hooks."
- No typed contract per slot (e.g., "if you're a provider plugin, you implement `ProviderAdapter`; if you're a notifier plugin, you implement `Notifier`").
- `detect()` capability doesn't exist.

**Friction.** Without slot taxonomy, plugin discovery is flat. The WS4 goal is manifest validation + SDK/runtime alignment; adding slot typing makes the SDK payload contracts meaningful.

**Source pattern.** `agent-orchestrator/packages/core/src/types.ts:1334-1461`:

```typescript
export interface PluginManifest {
  name: string; slot: PluginSlot;
  description: string; version: string; displayName?: string;
}
export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
  detect?(): boolean;     // e.g., is this plugin's binary installed?
}
```

The 8 slots (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal, Lifecycle) map poorly to AI Orchestrator's domain, but the **uniform module contract** does. Our slots would be:

| Slot | Purpose | Existing analog |
|---|---|---|
| `provider` | CLI/API adapter (Claude, Codex, Gemini, Copilot, custom) | `cli/adapters/` |
| `channel` | Communication channel (Discord, WhatsApp, Slack, email) | `discord.js`/`whatsapp-web.js` usage |
| `mcp` | MCP server binding | (new per Item 6) |
| `skill` | Prompt/workflow skill | `src/main/skills/` |
| `hook` | Lifecycle hook responder | `src/main/hooks/` |
| `tracker` | Issue/PR tracker (GitHub, Linear, Jira) | (none — new) |
| `notifier` | Outbound notification channel | (embedded in orchestration today) |
| `telemetry_exporter` | Custom OTLP exporter / metric sink | `observability/` |

**Proposed shape.**

```typescript
// packages/contracts/src/plugins.ts
export const PluginSlot = z.enum([
  'provider', 'channel', 'mcp', 'skill', 'hook',
  'tracker', 'notifier', 'telemetry_exporter',
]);
export type PluginSlot = z.infer<typeof PluginSlot>;

export const PluginManifest = z.object({
  name: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  slot: PluginSlot,
  displayName: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  author: z.string().max(200).optional(),
  requiresOrchestratorVersion: z.string().optional(),
  capabilities: z.record(z.unknown()).optional(),  // slot-specific
});
export type PluginManifest = z.infer<typeof PluginManifest>;
```

```typescript
// packages/sdk/src/plugins.ts (aligned with runtime)
export interface PluginModule<T = unknown> {
  readonly manifest: PluginManifest;
  /** Factory — receives validated config, returns slot-specific instance. */
  create(config?: unknown): T;
  /** Optional — detect if dependencies (binaries, env) are available. */
  detect?(): boolean | Promise<boolean>;
}

// Per-slot interfaces that the factory result must satisfy:
export type ProviderPluginResult = ProviderAdapter;          // from Item 1
export type ChannelPluginResult = Channel;                   // communication channel
export type McpPluginResult = McpServer;                     // from Item 6
export type SkillPluginResult = Skill;                       // existing
export type HookPluginResult = HookHandlers;                 // existing
export type TrackerPluginResult = Tracker;                   // new
export type NotifierPluginResult = Notifier;                 // new
export type TelemetryExporterPluginResult = SpanExporter;    // @opentelemetry/sdk-trace-base
```

```typescript
// src/main/plugins/plugin-registry.ts (new — supersedes part of plugin-manager.ts)
export class PluginRegistry {
  register<T>(module: PluginModule<T>, config?: unknown): void;
  get<T>(slot: PluginSlot, name: string): T | undefined;
  getAll<T>(slot: PluginSlot): ReadonlyArray<{ name: string; instance: T }>;
  loadBuiltins(): Promise<void>;
  loadFromDisk(path: string): Promise<LoadReport>;
  loadFromNpm(packageName: string): Promise<LoadReport>;
}

export interface LoadReport {
  loaded: string[];     // plugin names
  failed: Array<{ name: string; error: string; phase: string }>;  // phased model from Item 6
}
```

**Migration path.**

1. Land slot enum + `PluginManifest` in contracts.
2. Widen `PluginManager` to read `manifest.slot` and dispatch into slot-specific registries. Back-compat: plugins without `slot` default to `'hook'`.
3. Promote existing provider adapters to the `provider` slot (same interface as Item 1 `ProviderAdapter`).
4. Promote skills to the `skill` slot.
5. Define `Channel`, `Tracker`, `Notifier` interfaces and offer them in the SDK. Existing Discord/WhatsApp code becomes built-in `channel` plugins.
6. Add `detect()` support for binary-dependent plugins (e.g., Codex adapter's `detect()` checks `codex --version`).
7. Deprecate the single-name plugin model in a future release.

**WS alignment.** This **is** WS4 with more structural depth. WS4 as written lists schema-validated manifests + SDK/runtime alignment. This design adds slot typing to give the alignment a concrete shape.

**Tests.**
- Plugin manifest validation rejects malformed slots, names, versions.
- A provider-slot plugin whose factory returns a non-`ProviderAdapter` fails load.
- `detect()` returning false reports the plugin in `LoadReport.failed` with phase `detect`.
- Back-compat: plugins without `slot` still load with a deprecation warning.

**Risks / open questions.**
- **Q:** Migration cost for existing skills — do we rename the directory from `src/main/skills/` to `src/main/plugins/skills/`? No — keep existing paths, just classify them by slot.
- **Q:** Channel plugins currently run as first-class modules; converting them to plugins shouldn't change their hot-path. Start by converting one (Discord) to validate the SDK.

---

### Item 10 — Monorepo Subpath Exports Discipline (WS1 hygiene)

**Current state.** `packages/contracts` and `packages/sdk` exist. Imports across `src/main/` and `src/renderer/` use mixed patterns: some `@contracts/schemas`, some `../../shared/validation/ipc-schemas` (deprecated shim), some deep relative imports into `packages/contracts/src/...`. WS1 Task 1 calls for splitting `workspace.schemas.ts` into domain-focused files — perfect trigger to formalize subpath exports.

**Friction.** Drift risk: without explicit subpath exports, internal restructures silently break downstream code. Barrel indexes cause circular dependencies. Deep relative paths tie callers to internal layout.

**Source pattern.** `t3code/packages/shared/package.json` exports field (paraphrased):

```json
{
  "name": "@t3tools/shared",
  "exports": {
    "./model": { "types": "./src/model.ts", "import": "./src/model.ts" },
    "./git": { "types": "./src/git.ts", "import": "./src/git.ts" },
    "./logging": { ... },
    "./DrainableWorker": { ... },
    // ... no "." barrel
  }
}
```

**No barrel index** prevents circular deps. Every consumer writes `import { DrainableWorker } from '@t3tools/shared/DrainableWorker'` — explicit, discoverable, grep-able.

**Proposed shape.** Rewrite `packages/contracts/package.json` and `packages/sdk/package.json`:

```json
// packages/contracts/package.json
{
  "name": "@orchestrator/contracts",
  "exports": {
    "./channels/instance":       { "types": "./src/channels/instance.channels.ts", "import": "./src/channels/instance.channels.ts" },
    "./channels/session":        { "types": "./src/channels/session.channels.ts", "import": "./src/channels/session.channels.ts" },
    "./channels/provider":       { "types": "./src/channels/provider.channels.ts", "import": "./src/channels/provider.channels.ts" },
    // ... per-domain channel files
    "./schemas/instance":        { "types": "./src/schemas/instance.schemas.ts", "import": "./src/schemas/instance.schemas.ts" },
    "./schemas/session":         { "types": "./src/schemas/session.schemas.ts", "import": "./src/schemas/session.schemas.ts" },
    "./schemas/provider":        { "types": "./src/schemas/provider.schemas.ts", "import": "./src/schemas/provider.schemas.ts" },
    "./schemas/plugin":          { "types": "./src/schemas/plugin.schemas.ts", "import": "./src/schemas/plugin.schemas.ts" },
    // ... per-domain schema files
    "./providerRuntime":         { "types": "./src/providerRuntime.ts", "import": "./src/providerRuntime.ts" },
    "./instanceEvents":          { "types": "./src/instanceEvents.ts", "import": "./src/instanceEvents.ts" },
    "./checkpoints":             { "types": "./src/checkpoints.ts", "import": "./src/checkpoints.ts" },
    "./mcp":                     { "types": "./src/mcp.ts", "import": "./src/mcp.ts" },
    "./permissions":             { "types": "./src/permissions.ts", "import": "./src/permissions.ts" },
    "./recovery":                { "types": "./src/recovery.ts", "import": "./src/recovery.ts" },
    "./remoteAuth":              { "types": "./src/remoteAuth.ts", "import": "./src/remoteAuth.ts" },
    "./plugins":                 { "types": "./src/plugins.ts", "import": "./src/plugins.ts" }
  }
}
```

```json
// packages/sdk/package.json (same pattern)
{
  "name": "@orchestrator/sdk",
  "exports": {
    "./providers": { ... },
    "./plugins":   { ... },
    "./tools":     { ... },
    "./hooks":     { ... }
  }
}
```

Consumer style:

```typescript
// Good — explicit subpath
import { ProviderRuntimeEvent } from '@orchestrator/contracts/providerRuntime';
import { InstanceStatus } from '@orchestrator/contracts/instanceEvents';
import { PluginManifest } from '@orchestrator/contracts/plugins';

// Bad — barrel, no longer legal
import { ProviderRuntimeEvent, InstanceStatus } from '@orchestrator/contracts';
```

**Migration path.**

1. Split `packages/contracts/src/schemas/workspace.schemas.ts` into per-domain files (part of WS1 Task 1 already).
2. Rewrite `packages/contracts/package.json` `exports` field. Remove the top-level `.` barrel.
3. Codemod pass: find all `from '@contracts'` or `from '@contracts/schemas'` deep imports; rewrite to subpath imports. Lint rule to prevent new barrels.
4. Repeat for `packages/sdk`.
5. Add `scripts/verify-package-exports.js` that greps for any `from '@orchestrator/contracts'` without a subpath and fails CI.
6. Update `tsconfig.json` `paths` field to point at new subpaths for dev-time resolution.

**WS alignment.** Tightens WS1. WS1 calls out splitting `workspace.schemas.ts` — this item adds the exports hygiene on top so the split is load-bearing, not cosmetic.

**Tests.**
- Node resolution: `require.resolve('@orchestrator/contracts/providerRuntime')` works from any consumer.
- Lint guard: `from '@orchestrator/contracts';` without a subpath is flagged.
- Tree-shaking benchmarks: renderer bundle size before/after for a representative page.

**Risks / open questions.**
- **Q:** TypeScript `moduleResolution` — we use `node16` or `bundler`? Confirm `exports`-aware resolution.
- **Q:** Electron preload can't import from `packages/` at runtime (the generate-preload-channels script exists for this reason). Keep preload out of the subpath-export world — it imports from generated `src/preload/generated/channels.ts` which the script maintains.

---

## 4. Consolidated Roadmap

The 10 items have real dependency structure. Here's a suggested sequencing that respects both that structure and your WS1–WS6 plan order.

```
       ┌─────────────────────────────────────────────────────────┐
       │ Wave 1 — Contracts Foundation (WS1 + Item 10)          │
       │   - Split workspace.schemas.ts per-domain              │
       │   - Rewrite packages/contracts exports field            │
       │   - Lint rule: no barrel imports                        │
       └─────────────┬───────────────────────────────────────────┘
                     │
       ┌─────────────▼───────────────────────────────────────────┐
       │ Wave 2 — Provider Normalization (WS3 + Item 1)          │
       │   - ProviderRuntimeEvent contract                       │
       │   - ProviderAdapter interface in SDK                    │
       │   - Translate Claude, Codex, Gemini, Copilot adapters   │
       └─────────────┬───────────────────────────────────────────┘
                     │
       ┌─────────────▼───────────────────────────────────────────┐
       │ Wave 3 — State Machine + Event Log (WS2 + Item 2)       │
       │   - InstanceEvent contract                              │
       │   - Extend InstanceStateMachine with event emission     │
       │   - Wire InstanceEventBus                               │
       │   - Route existing transitions through state machine    │
       │   - Extract lifecycle submodules (per WS2 tasks)        │
       └─────────────┬───────────────────────────────────────────┘
                     │
       ┌─────────────▼───────────────────────────────────────────┐
       │ Wave 4 — Orchestration Event Source (WS5 + Item 3)      │
       │   - OrchestrationEvent store (shadow log first)         │
       │   - CommandBus + decider + projections                  │
       │   - ProviderIngestionReactor                            │
       │   - drain() primitives for tests                        │
       │   - Scenario harness per WS5 coverage list              │
       └─────┬───────────────┬───────────────────┬───────────────┘
             │               │                   │
       ┌─────▼─────┐   ┌─────▼─────┐       ┌─────▼─────┐
       │ Wave 5A   │   │ Wave 5B   │       │ Wave 5C   │
       │ Item 4    │   │ Item 5    │       │ Item 6    │
       │ Auto-     │   │ Git       │       │ MCP +     │
       │ compaction│   │ checkpoint│       │ plugin    │
       │ (WS2)     │   │ store     │       │ lifecycle │
       │           │   │           │       │ (WS4)     │
       └─────┬─────┘   └─────┬─────┘       └─────┬─────┘
             │               │                   │
             └───────────────┼───────────────────┘
                             │
       ┌─────────────────────▼───────────────────────────────────┐
       │ Wave 6 — Safety + Recovery (Item 7)                     │
       │   - PermissionMode + EnforcementResult                  │
       │   - RecoveryEngine with typed recipes                   │
       │   - BranchFreshnessChecker                              │
       └─────────────┬───────────────────────────────────────────┘
                     │
       ┌─────────────▼───────────────────────────────────────────┐
       │ Wave 7 — Plugin Architecture (WS4 + Item 9)              │
       │   - PluginSlot taxonomy                                 │
       │   - PluginModule uniform contract                       │
       │   - Slot-specific SDK interfaces                        │
       │   - Convert channel/provider/skill to typed slots       │
       └─────────────┬───────────────────────────────────────────┘
                     │
       ┌─────────────▼───────────────────────────────────────────┐
       │ Wave 8 — Remote Pairing (Item 8)                        │
       │   - RemoteAuth with one-time tokens                     │
       │   - WorkerAgent handshake migration                     │
       │   - Settings UI for pairings                            │
       └─────────────┬───────────────────────────────────────────┘
                     │
       ┌─────────────▼───────────────────────────────────────────┐
       │ Wave 9 — Bootstrap + UI Decomposition (WS6)             │
       │   - Use bootstrapAll() consistently                     │
       │   - Split instance-list, instance-detail containers     │
       │   - Presenter + store selectors pattern                 │
       └─────────────────────────────────────────────────────────┘
```

**Why this order:**
- **Wave 1 first** because every other wave adds contracts — shipping the subpath-exports discipline early prevents every later wave from creating new barrel-index debt.
- **Wave 2 (providers) before Wave 3 (state machine events)** because the state machine events reference provider events; co-designing them in the right order is clean, otherwise we'd migrate twice.
- **Wave 4 (orchestration event source) is the keystone.** It depends on Waves 1–3 but enables Waves 5A/5B/5C/6/7.
- **Waves 5A/5B/5C run in parallel.** Each builds on the Wave 4 foundation and is independently useful.
- **Wave 6 (safety/recovery) depends on Wave 4** (it subscribes to events) and Wave 5C (MCP failures).
- **Wave 7 (plugins)** touches every prior wave because plugins live across slots — best sequenced after provider/MCP/skill subsystems are stable.
- **Wave 8 (remote pairing)** is mostly independent; can be done any time after Wave 1.
- **Wave 9 (WS6)** comes last because it's decomposition, not structural — it benefits from every prior wave's clean contracts.

**Total effort estimate:** Each wave is a multi-week PR series. Waves 1–3 likely 1–2 weeks each. Wave 4 is the biggest (4–6 weeks). Waves 5A/5B/5C are 1–3 weeks each. Waves 6–8 are 1–2 weeks each. Wave 9 is 2–3 weeks.

---

## 5. Open Questions Across All Items

These are not resolved in this design. User (or design review) should weigh in:

1. **Phased rollout vs. big-bang.** This doc assumes phased with feature flags. Do we instead branch off `main` into a `remediation` branch and merge back at the end?
2. **Legacy compatibility windows.** When we deprecate shapes (e.g., the `CliEvent` union in Item 1), how many releases do we support both? Recommend two.
3. **Telemetry opt-out during migration.** Shadow logs and double-writes generate significant telemetry. Add a dev-time flag to suppress duplicate spans?
4. **better-sqlite3 scale.** Orchestration event store + checkpoint summaries + session JSONL are all new disk-writers. Do we benchmark before committing to sqlite, or switch to a pluggable event-store interface up front? Recommend pluggable — costs little, gives us a swap path.
5. **Plugin authorship story.** Item 9 expands the plugin surface. Do we ship a `create-orchestrator-plugin` CLI scaffolding tool? Not in-scope for these items but will be asked.
6. **Scope of WS6 UI decomposition.** WS6 as written is "split the biggest Angular containers." This design respects that but Item 2's new `InstanceEventBus` is a natural trigger to redesign state flow. Keep that redesign out-of-scope or fold it in?
7. **Testing time budget.** WS5 scenario tests plus per-item contract tests plus rebuilding test doubles for Item 1's adapters will roughly double the test suite's runtime. Acceptable?

---

## 6. Alignment Summary with WS1–WS6

| WS | Item(s) | Role |
|---|---|---|
| WS0 (baseline) | — | Setup precedes all items |
| WS1 (contracts/IPC) | Item 10 (subpath exports) | Extends — makes the split load-bearing |
| WS2 (lifecycle/session) | Item 2 (state machine), Item 4 (compaction), Item 5 (checkpoints) | Item 2 is the structural enabler for WS2's extractions; Items 4 and 5 are concrete session-submodule extractions |
| WS3 (provider events) | Item 1 (provider runtime events) | **Is** WS3 |
| WS4 (plugin/skill contracts) | Item 6 (MCP lifecycle), Item 9 (plugin slots) | Item 9 is WS4's structural expansion; Item 6 extends to runtime lifecycle hardening |
| WS5 (parity/recovery) | Item 3 (event sourcing), Item 7 (permissions/recovery/stale-branch) | Item 3 is the mechanism; Item 7 is the content |
| WS6 (bootstrap/UI) | Wave 9 above | Not explicitly in the 10 items — finishes the series |
| (none) | Item 8 (remote pairing) | Aligns with existing remote-nodes work but outside WS1–WS6 scope |

---

## 7. What This Design Does NOT Cover

- UI redesign. WS6 explicitly forbids UI redesign during infrastructure work. Same here.
- A new plugin marketplace. Item 9 only defines the contract.
- Multi-tenant / cloud hosting. Item 8 is LAN/machine-local pairing only.
- Replacing Electron or Angular. Confirmed non-goal per WS plan.
- Formal verification of state machine transitions. Lint + runtime assertions only.
- Telemetry backend changes. OTLP stays OTLP.
- Adding new AI providers. Item 1 makes that trivial afterwards but we don't add providers here.

---

## 8. Reference Citations

For implementers — where to look in source during implementation:

**t3code** (`/Users/suas/work/orchestrat0r/t3code/`):
- `apps/server/src/provider/Services/ProviderAdapter.ts` — adapter interface (Item 1)
- `apps/server/src/provider/Services/ProviderAdapterRegistry.ts` — registry pattern (Item 1)
- `apps/server/src/provider/Services/{ClaudeAdapter,CodexAdapter}.ts` — reference adapter implementations (Item 1)
- `packages/contracts/src/providerRuntime.ts` — 46-variant event union (Item 1)
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts` — command→event→projection (Item 3)
- `apps/server/src/orchestration/Services/CheckpointReactor.ts` — checkpoint pattern (Item 5)
- `packages/shared/src/DrainableWorker.ts` — deterministic async primitive (Item 3)
- `apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` — test quiescence (Item 3)
- `apps/server/src/auth/Services/{ServerAuth,BootstrapCredentialService}.ts` — remote pairing (Item 8)
- `packages/shared/package.json` — subpath exports (Item 10)
- `REMOTE.md` — pairing protocol philosophy (Item 8)

**claw-code-parity** (`/Users/suas/work/orchestrat0r/claw-code-parity/`):
- `rust/crates/runtime/src/worker_boot.rs:34-163` — worker lifecycle state machine (Item 2)
- `rust/crates/runtime/src/lane_events.rs:5-91` — typed lane events + failure taxonomy (Item 2)
- `rust/crates/runtime/src/permission_enforcer.rs:9-120` — permission tiers (Item 7)
- `rust/crates/runtime/src/mcp_lifecycle_hardened.rs:15-253` — MCP lifecycle + degraded mode (Item 6)
- `rust/crates/runtime/src/recovery_recipes.rs:17-224` — recovery recipes (Item 7)
- `rust/crates/runtime/src/policy_engine.rs:1-216` — policy engine (supports Item 7)
- `rust/crates/runtime/src/stale_branch.rs:1-100` — branch freshness (Item 7)
- `rust/crates/runtime/src/compact.rs:1-120` — session compaction (Item 4)
- `rust/crates/runtime/src/hooks.rs:18-160` — hook system (supports Item 9)
- `rust/crates/mock-anthropic-service/` — deterministic test harness (supports Item 3)
- `PHILOSOPHY.md`, `ROADMAP.md` — design rationale (all items)

**agent-orchestrator** (`/Users/suas/work/orchestrat0r/agent-orchestrator/`):
- `packages/core/src/types.ts:244-899` — 8 plugin slot interfaces (Item 9)
- `packages/core/src/types.ts:1334-1461` — PluginModule uniform contract (Item 9)
- `packages/core/src/plugin-registry.ts` — plugin loader (Item 9)
- `packages/core/src/lifecycle-manager.ts:358-500` — session state cascade (Item 2 reference)
- `packages/core/src/activity-log.ts:139-207` — activity detection fallback (future work)
- `plugins/workspace-worktree/src/index.ts:90-157` — git worktree creation (Item 5 reference)
- `packages/core/src/paths.ts:84-128` — hash-namespaced flat-file layout (reference for Item 4 storage)

**AI Orchestrator current-state anchors** (for rewriting):
- `packages/contracts/src/channels/*.channels.ts` — WS1 current state
- `src/shared/validation/ipc-schemas.ts` — deprecation shim (15 LOC)
- `src/main/instance/instance-lifecycle.ts` — 3595-line extraction target (WS2)
- `src/main/instance/instance-state-machine.ts` — 93 LOC, ready to extend (Item 2)
- `src/main/session/session-continuity.ts` — session continuity v2 (WS2)
- `src/main/session/checkpoint-manager.ts` — transaction-log checkpoint (Item 5 parallel)
- `src/main/cli/adapters/base-cli-adapter.ts` — 635 LOC, normalization target (Item 1)
- `src/main/plugins/plugin-manager.ts` — plugin loader (Item 9)
- `src/main/codemem/mcp-config.ts` — codemem MCP (Item 6)
- `src/worker-agent/worker-agent.ts` — remote node agent (Item 8)
- `src/main/index.ts` — bootstrap wiring (WS6)
- `docs/plans/2026-04-15-ai-orchestrator-improvement-plan.md` — WS1–WS6 source of truth

---

**End of design.**
