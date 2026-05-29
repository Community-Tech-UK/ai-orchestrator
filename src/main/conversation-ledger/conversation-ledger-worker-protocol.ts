/**
 * Clone-safe message types for the conversation-ledger worker boundary.
 *
 * The worker solely owns the on-disk conversation-ledger.db connection and its
 * ConversationLedgerStore. No Database / SqliteDriver objects cross the thread
 * boundary — only plain store arguments and record results, which are all
 * structured-clone safe.
 *
 * Calls are dispatched generically by store-method name (`store-call`); the
 * worker validates the name against a closed allowlist (LedgerStoreMethod)
 * before invoking, so no arbitrary method can be called.
 */

import type { LedgerStoreMethod } from './ledger-store-port';

// ── Inbound messages (main → worker) — RPC (have `id`) ───────────────────────

export interface StoreCallMsg {
  type: 'store-call';
  id: number;
  method: LedgerStoreMethod;
  /** Positional arguments for the store method; all structured-clone safe. */
  args: unknown[];
}

export interface ShutdownMsg {
  type: 'shutdown';
  id: number;
}

export type LedgerWorkerInboundMsg = StoreCallMsg | ShutdownMsg;

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

export type LedgerWorkerOutboundMsg = WorkerReadyMsg | WorkerRpcResponseMsg;
