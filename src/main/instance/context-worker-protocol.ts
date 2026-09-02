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
import type {
  RlmContextQueryResultDto,
  RlmContextSectionDto,
  RlmContextStoreDto,
  RlmWorkerRequest,
} from './rlm-worker-port';
import type { UnifiedMemoryWorkerRequest } from './unified-memory-worker-port';
import type { RlmResidencySnapshot } from '../rlm/context/context.types';

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

export interface RlmRequestMsg {
  type: 'rlm-request';
  id: number;
  request: RlmWorkerRequest;
}

export interface UnifiedMemoryRequestMsg {
  type: 'unified-memory-request';
  id: number;
  request: UnifiedMemoryWorkerRequest;
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

export interface RecordTaskOutcomeMsg {
  type: 'record-task-outcome';
  taskId: string;
  success: boolean;
  score: number;
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
  | RlmRequestMsg
  | UnifiedMemoryRequestMsg
  | ShutdownMsg;

export type ContextWorkerFireForgetMsg =
  | EndRlmSessionMsg
  | IngestRlmMsg
  | IngestUnifiedMemoryMsg
  | RecordTaskOutcomeMsg
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

export interface WorkerMetricsMsg {
  type: 'worker-metrics';
  residency: RlmResidencySnapshot;
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
 * Fire-and-forget: a clone-safe event emitted inside the worker and carried to
 * main. RLM DTOs publish to the manager-independent relay; wake-context events
 * retain their existing main-process WakeContextBuilder re-emission.
 *
 * LT-206: `RLMContextManager` and `WakeContextBuilder` are per-process
 * singletons exactly like `SkillAttributionService` (LT-169/LT-170) — see
 * `WorkerSkillActivationMsg` above for the cross-process `EventEmitter`
 * mechanics this reuses. Production RLM store/section activity and the
 * per-turn wake-context build both happen inside this worker (via
 * `InstanceContextManager`/`ContextWorkerClient.buildWakeContextText`). Main
 * therefore needs the explicit relay/dispatch hop to observe them without
 * constructing a second RLM manager.
 * `wake:hint-added` is NOT included: `addHint()` has no worker call path in
 * production, so it already fires correctly from main today.
 *
 * See `context-worker-event-forwarding.ts` for worker-side normalization and
 * `context-worker-event-relay.ts` for main-side dispatch.
 */
export interface RlmStoreCreatedWorkerEventMsg {
  type: 'worker-event';
  source: 'rlm-context';
  event: 'store:created';
  payload: RlmContextStoreDto;
}

export interface RlmSectionAddedWorkerEventMsg {
  type: 'worker-event';
  source: 'rlm-context';
  event: 'section:added';
  payload: {
    storeId: string;
    section: RlmContextSectionDto;
    highVolume: boolean;
    store: RlmContextStoreDto;
  };
}

export interface RlmSectionRemovedWorkerEventMsg {
  type: 'worker-event';
  source: 'rlm-context';
  event: 'section:removed';
  payload: {
    storeId: string;
    sectionId: string;
    highVolume: boolean;
    store: RlmContextStoreDto;
  };
}

export interface RlmQueryExecutedWorkerEventMsg {
  type: 'worker-event';
  source: 'rlm-context';
  event: 'query:executed';
  payload: {
    sessionId: string;
    queryResult: RlmContextQueryResultDto;
  };
}

export type RlmWorkerEventMsg =
  | RlmStoreCreatedWorkerEventMsg
  | RlmSectionAddedWorkerEventMsg
  | RlmSectionRemovedWorkerEventMsg
  | RlmQueryExecutedWorkerEventMsg;

export interface WakeContextWorkerEventMsg {
  type: 'worker-event';
  source: 'wake-context';
  event: 'wake:context-generated';
  payload: unknown;
}

export type WorkerForwardedEventMsg = RlmWorkerEventMsg | WakeContextWorkerEventMsg;

export type ContextWorkerOutboundMsg =
  | WorkerReadyMsg
  | WorkerRpcResponseMsg
  | WorkerMetricsMsg
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
