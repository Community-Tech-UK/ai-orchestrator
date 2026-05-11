/**
 * Clone-safe message types for the codemem index worker boundary.
 *
 * The index worker owns CasStore, CodeIndexManager, PeriodicScan, and its own
 * codemem.sqlite connection. No Database or SqliteDriver objects cross thread
 * boundaries.
 */

// ── Inbound messages (main → worker) — RPC (have `id`) ───────────────────────

export interface WarmWorkspaceMsg {
  type: 'warm-workspace';
  id: number;
  workspacePath: string;
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

export interface StopWorkspaceWatcherMsg {
  type: 'stop-workspace-watcher';
  workspacePath: string;
}

export type IndexWorkerRpcMsg = WarmWorkspaceMsg | GetStatsMsg | ShutdownMsg;
export type IndexWorkerFireForgetMsg = StopWorkspaceWatcherMsg;
export type IndexWorkerInboundMsg = IndexWorkerRpcMsg | IndexWorkerFireForgetMsg;

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

export type IndexWorkerOutboundMsg = WorkerReadyMsg | WorkerRpcResponseMsg;

// ── Shared result types ───────────────────────────────────────────────────────

/** Returned by the worker after completing a warm-workspace RPC. */
export interface WarmWorkspaceResult {
  /** True when an existing index was found or a cold index completed. */
  indexed: boolean;
  /** Resolved absolute workspace path. */
  absPath: string;
  /** Primary language detected by the indexer (defaults to 'typescript'). */
  primaryLanguage: string;
}
