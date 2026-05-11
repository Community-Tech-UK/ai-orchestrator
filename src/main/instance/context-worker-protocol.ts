/**
 * Clone-safe message types for the context worker boundary.
 *
 * All types must be structured-clone safe: no functions, EventEmitters, or
 * native handles. Full Instance objects are never posted; only the fields
 * required by context operations are included in the snapshots.
 */

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

export type ContextWorkerRpcMsg =
  | InitializeRlmMsg
  | BuildRlmContextMsg
  | BuildUnifiedMemoryContextMsg
  | CompactContextMsg
  | IngestInitialOutputMsg
  | GetStatsMsg
  | ShutdownMsg;

export type ContextWorkerFireForgetMsg =
  | EndRlmSessionMsg
  | IngestRlmMsg
  | IngestUnifiedMemoryMsg;

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

export type ContextWorkerOutboundMsg = WorkerReadyMsg | WorkerRpcResponseMsg;
