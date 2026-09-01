/**
 * Clone-safe message types for the context worker boundary.
 *
 * All types must be structured-clone safe: no functions, EventEmitters, or
 * native handles. Full Instance objects are never posted; only the fields
 * required by context operations are included in the snapshots.
 */

import type {
  MCPToolSearchSnapshot,
  McpRuntimeToolContextSelection,
} from '../mcp/mcp-runtime-tool-context';
import type {
  HabitTrackerStateSnapshot,
  MetricsCollectorStateSnapshot,
  OutcomeTrackerStateSnapshot,
} from '../learning/learning-state.types';
import type { SkillActivation } from '../skills/skill-attribution-service';
import type {
  ProjectMemoryBrief,
  ProjectMemoryBriefRequest,
} from '../memory/project-memory-brief';

// ── Clone-safe snapshots ──────────────────────────────────────────────────────

/** Clone-safe subset of Instance used by context operations in the worker. */
export interface ContextWorkerInstanceSnapshot {
  id: string;
  sessionId?: string;
  parentId?: string | null;
  contextUsage: { used: number; total: number; percentage: number };
}

/** Clone-safe subset of OutputMessage. */
export interface ContextWorkerOutputMsg {
  id: string;
  type: string;
  content?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Inbound messages (main → worker) — RPC (have `id`) ───────────────────────

export interface InitializeRlmMsg {
  type: 'initialize-rlm';
  id: number;
  snapshot: ContextWorkerInstanceSnapshot;
}

export interface BuildRlmContextMsg {
  type: 'build-rlm-context';
  id: number;
  instanceId: string;
  query: string;
  maxTokens?: number;
  topK?: number;
}

export interface BuildUnifiedMemoryContextMsg {
  type: 'build-unified-memory-context';
  id: number;
  snapshot: ContextWorkerInstanceSnapshot;
  query: string;
  taskId: string;
  maxTokens?: number;
}

export interface BuildWakeContextTextMsg {
  type: 'build-wake-context-text';
  id: number;
  wing?: string;
  bypassCache?: boolean;
}

export interface BuildObservationContextMsg {
  type: 'build-observation-context';
  id: number;
  taskContext: string;
  instanceId?: string;
  taskType?: string;
}

export interface BuildProjectMemoryBriefMsg {
  type: 'build-project-memory-brief';
  id: number;
  request: ProjectMemoryBriefRequest;
}

export interface BuildMcpRuntimeToolContextMsg {
  type: 'build-mcp-runtime-tool-context';
  id: number;
  snapshot: MCPToolSearchSnapshot;
  query?: string;
  maxTools?: number;
}

export interface LoadOutcomeTrackerStateMsg {
  type: 'load-outcome-tracker-state';
  id: number;
  maxExperiences: number;
}

export interface LoadMetricsCollectorStateMsg {
  type: 'load-metrics-collector-state';
  id: number;
}

export interface LoadHabitTrackerStateMsg {
  type: 'load-habit-tracker-state';
  id: number;
  trackingWindowDays: number;
}

export interface CompactContextMsg {
  type: 'compact-context';
  id: number;
  snapshot: ContextWorkerInstanceSnapshot;
}

export interface IngestInitialOutputMsg {
  type: 'ingest-initial-output';
  id: number;
  snapshot: ContextWorkerInstanceSnapshot;
  messages: ContextWorkerOutputMsg[];
}

export interface GetStatsMsg {
  type: 'get-stats';
  id: number;
}

export interface ReloadRlmPersistenceMsg {
  type: 'reload-rlm-persistence';
  id: number;
}

export interface StartHotPrewarmMsg {
  type: 'start-hot-prewarm';
  id: number;
}

export interface ShutdownMsg {
  type: 'shutdown';
  id: number;
}

// ── Inbound messages — fire-and-forget (no `id`) ──────────────────────────────

export interface EndRlmSessionMsg {
  type: 'end-rlm-session';
  instanceId: string;
}

export interface IngestRlmMsg {
  type: 'ingest-rlm';
  instanceId: string;
  message: ContextWorkerOutputMsg;
}

export interface IngestUnifiedMemoryMsg {
  type: 'ingest-unified-memory';
  snapshot: ContextWorkerInstanceSnapshot;
  message: ContextWorkerOutputMsg;
}

export interface CancelHotPrewarmMsg {
  type: 'cancel-hot-prewarm';
}

export type ContextWorkerRpcMsg =
  | InitializeRlmMsg
  | BuildRlmContextMsg
  | BuildUnifiedMemoryContextMsg
  | BuildObservationContextMsg
  | BuildProjectMemoryBriefMsg
  | BuildWakeContextTextMsg
  | BuildMcpRuntimeToolContextMsg
  | LoadOutcomeTrackerStateMsg
  | LoadMetricsCollectorStateMsg
  | LoadHabitTrackerStateMsg
  | CompactContextMsg
  | IngestInitialOutputMsg
  | GetStatsMsg
  | ReloadRlmPersistenceMsg
  | StartHotPrewarmMsg
  | ShutdownMsg;

export type ContextWorkerFireForgetMsg =
  | EndRlmSessionMsg
  | IngestRlmMsg
  | IngestUnifiedMemoryMsg
  | CancelHotPrewarmMsg;

export type ContextWorkerInboundMsg =
  | ContextWorkerRpcMsg
  | ContextWorkerFireForgetMsg;

// ── Outbound messages (worker → main) ────────────────────────────────────────

export interface WorkerReadyMsg {
  type: 'ready';
}

export interface WorkerRpcResponseMsg {
  type: 'rpc-response';
  id: number;
  result?: unknown;
  error?: string;
}

/**
 * Fire-and-forget: a skill activation was recorded by the worker's own
 * (process-local) `SkillAttributionService` singleton.
 *
 * LT-170: `SkillAttributionService` is a per-process singleton (same
 * constraint as LT-169's `controlCache`), and `recordActivation()` runs
 * inside this worker's own `UnifiedMemoryController`
 * (`unified-controller.ts`), not the main process. Its `emit('activation',
 * …)` therefore fires on an `EventEmitter` instance the main process never
 * subscribes to — `registerSkillAttributionHandlers()`'s `attribution.on(
 * 'activation', …)` listens on the *main* process's own singleton, a
 * different object in a different OS process. Node's `EventEmitter` cannot
 * cross a process boundary on its own, so the DB row always lands correctly
 * (the row is written by this worker's own SQLite connection to the shared
 * file) while the renderer never saw a live push — only a manual re-fetch
 * (`skillsActivationsRecent`/`refreshActivations()`) ever picked it up. This
 * message explicitly re-establishes that missing hop over the existing
 * worker↔main channel.
 */
export interface WorkerSkillActivationMsg {
  type: 'skill-activation';
  activation: SkillActivation;
}

/**
 * Fire-and-forget: a clone-safe event emitted by a per-process singleton
 * inside the worker, re-broadcast here for main to re-emit on its own
 * separate instance of the same class.
 *
 * LT-206: `RLMContextManager` and `WakeContextBuilder` are per-process
 * singletons exactly like `SkillAttributionService` (LT-169/LT-170) — see
 * `WorkerSkillActivationMsg` above for the cross-process `EventEmitter`
 * mechanics this reuses. Production RLM store/section activity and the
 * per-turn wake-context build both happen inside this worker (via
 * `InstanceContextManager`/`ContextWorkerClient.buildWakeContextText`), so
 * `main`'s own `RLMContextManager.getInstance()`/`getWakeContextBuilder()`
 * never observes them directly and the renderer's live-update channels
 * (`RLM_STORE_UPDATED` et al., `WAKE_EVENT_CONTEXT_GENERATED`) went dead.
 * `wake:hint-added` is NOT included: `addHint()` has no worker call path in
 * production, so it already fires correctly from main today.
 *
 * See `context-worker-event-forwarding.ts` for the worker-side subscription
 * allowlist and the main-side re-emit dispatch — the single place that owns
 * both directions of this mechanism so a future emitter of this shape is a
 * one-line addition there instead of a new bespoke message type.
 */
export interface WorkerForwardedEventMsg {
  type: 'worker-event';
  source: 'rlm-context' | 'wake-context';
  event: string;
  payload: unknown;
}

export type ContextWorkerOutboundMsg =
  | WorkerReadyMsg
  | WorkerRpcResponseMsg
  | WorkerSkillActivationMsg
  | WorkerForwardedEventMsg;

export type {
  HabitTrackerStateSnapshot,
  MCPToolSearchSnapshot,
  McpRuntimeToolContextSelection,
  MetricsCollectorStateSnapshot,
  OutcomeTrackerStateSnapshot,
  ProjectMemoryBrief,
  ProjectMemoryBriefRequest,
};
