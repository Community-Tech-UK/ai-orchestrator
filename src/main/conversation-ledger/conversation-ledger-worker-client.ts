/**
 * ConversationLedgerWorkerClient — main-process LedgerStorePort backed by the
 * conversation-ledger worker thread.
 *
 * Routes every ConversationLedgerStore operation to a worker that solely owns
 * conversation-ledger.db, so the ledger's synchronous SQLite never runs on the
 * Electron main event loop.
 *
 * Contract (differs deliberately from the context worker):
 * - RPCs REJECT on timeout or worker crash rather than resolving null. The
 *   ledger is durable persistence, not best-effort context — a silent null
 *   would lose a write or show an empty transcript. Awaiting callers surface or
 *   handle the error; the transcript bridge re-queues and retries on the next
 *   flush so nothing is lost while the worker restarts.
 * - Rejecting after a timeout is still non-blocking in the event-loop sense:
 *   the loop runs freely during the await.
 * - Worker crash: fail pending RPCs, mark degraded, restart after a backoff up
 *   to MAX_RESTART_ATTEMPTS consecutive crashes (reset to 0 on a healthy reply).
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import type {
  ConversationCheckpointRecord,
  ConversationCheckpointUpsertInput,
  ConversationListQuery,
  ConversationMessageRecord,
  ConversationMessageUpsertInput,
  ConversationMessagesQuery,
  ConversationSyncCursorUpsertInput,
  ConversationThreadRecord,
  ConversationThreadUpsertInput,
  ReconciliationResult,
} from '../../shared/types/conversation-ledger.types';
import type { AppendMessageInput, LedgerStoreMethod, LedgerStorePort } from './ledger-store-port';
import type {
  LedgerWorkerInboundMsg,
  LedgerWorkerOutboundMsg,
} from './conversation-ledger-worker-protocol';

const logger = getLogger('ConversationLedgerWorkerClient');

const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const RESTART_BACKOFF_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 3;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface ConversationLedgerWorkerClientOptions {
  rpcTimeoutMs?: number;
  workerFactory?: (userDataPath: string) => Worker;
  userDataPath?: string;
}

export interface ConversationLedgerWorkerMetrics {
  inFlight: number;
  processed: number;
  failed: number;
  lastError: string | null;
  degraded: boolean;
}

function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

function makeWorker(userDataPath: string): Worker {
  const jsEntry = path.join(__dirname, 'conversation-ledger-worker-main.js');
  if (existsSync(jsEntry)) {
    return new Worker(jsEntry, { workerData: { userDataPath } });
  }
  const tsEntry = path.join(__dirname, 'conversation-ledger-worker-main.ts');
  return new Worker(tsEntry, {
    workerData: { userDataPath },
    execArgv: ['--import', 'tsx'],
  });
}

export class ConversationLedgerWorkerClient implements LedgerStorePort {
  private worker: Worker | null = null;
  private rpcId = 0;
  private pending = new Map<number, PendingRpc>();
  private isDegraded = false;
  private restartAttempts = 0;
  private shuttingDown = false;
  private readonly rpcTimeoutMs: number;
  private readonly workerFactory: (userDataPath: string) => Worker;
  private readonly userDataPath: string;
  private metrics = { processed: 0, failed: 0, lastError: null as string | null };

  constructor(options: ConversationLedgerWorkerClientOptions = {}) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? makeWorker;
    this.userDataPath =
      options.userDataPath ?? getElectronUserDataPath() ?? '/tmp/ai-orchestrator';
    this.startWorker();
  }

  getMetrics(): ConversationLedgerWorkerMetrics {
    return {
      inFlight: this.pending.size,
      processed: this.metrics.processed,
      failed: this.metrics.failed,
      lastError: this.metrics.lastError,
      degraded: this.isDegraded,
    };
  }

  // ── LedgerStorePort ──────────────────────────────────────────────────────────

  async findThreadById(id: string): Promise<ConversationThreadRecord | null> {
    return (await this.call('findThreadById', [id])) as ConversationThreadRecord | null;
  }

  async listThreads(query: ConversationListQuery): Promise<ConversationThreadRecord[]> {
    return (await this.call('listThreads', [query])) as ConversationThreadRecord[];
  }

  async getMessages(
    threadId: string,
    options?: ConversationMessagesQuery,
  ): Promise<ConversationMessageRecord[]> {
    return (await this.call('getMessages', [threadId, options])) as ConversationMessageRecord[];
  }

  async getRecentMessages(threadId: string, limit: number): Promise<ConversationMessageRecord[]> {
    return (await this.call('getRecentMessages', [threadId, limit])) as ConversationMessageRecord[];
  }

  async getMessagesBefore(
    threadId: string,
    beforeSequence: number,
    limit: number,
  ): Promise<ConversationMessageRecord[]> {
    return (await this.call('getMessagesBefore', [
      threadId,
      beforeSequence,
      limit,
    ])) as ConversationMessageRecord[];
  }

  async countMessages(threadId: string): Promise<number> {
    return (await this.call('countMessages', [threadId])) as number;
  }

  async hasMessageWithNativeId(threadId: string, nativeMessageId: string): Promise<boolean> {
    return (await this.call('hasMessageWithNativeId', [threadId, nativeMessageId])) as boolean;
  }

  async upsertThread(input: ConversationThreadUpsertInput): Promise<ConversationThreadRecord> {
    return (await this.call('upsertThread', [input])) as ConversationThreadRecord;
  }

  async upsertMessages(
    threadId: string,
    messages: ConversationMessageUpsertInput[],
  ): Promise<void> {
    await this.call('upsertMessages', [threadId, messages]);
  }

  async appendMessagesWithThreadTouch(
    threadId: string,
    inputs: AppendMessageInput[],
  ): Promise<ConversationMessageRecord[] | null> {
    return (await this.call('appendMessagesWithThreadTouch', [threadId, inputs])) as
      | ConversationMessageRecord[]
      | null;
  }

  async replaceThreadMessagesFromImport(
    threadId: string,
    messages: ConversationMessageUpsertInput[],
    cursor?: ConversationSyncCursorUpsertInput,
  ): Promise<ReconciliationResult> {
    return (await this.call('replaceThreadMessagesFromImport', [
      threadId,
      messages,
      cursor,
    ])) as ReconciliationResult;
  }

  async writeCheckpoint(
    threadId: string,
    input: ConversationCheckpointUpsertInput,
  ): Promise<ConversationCheckpointRecord> {
    return (await this.call('writeCheckpoint', [threadId, input])) as ConversationCheckpointRecord;
  }

  async getLatestCheckpoint(threadId: string): Promise<ConversationCheckpointRecord | null> {
    return (await this.call('getLatestCheckpoint', [threadId])) as
      | ConversationCheckpointRecord
      | null;
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    this.failAllPending(new Error('conversation ledger worker shutting down'));
    if (this.worker) {
      try {
        await this.postRpc({ type: 'shutdown', id: this.nextId() });
      } catch {
        // best-effort
      }
      await this.worker.terminate().catch(() => undefined);
      this.worker = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private call(method: LedgerStoreMethod, args: unknown[]): Promise<unknown> {
    return this.postRpc({ type: 'store-call', id: this.nextId(), method, args });
  }

  private nextId(): number {
    return ++this.rpcId;
  }

  private startWorker(): void {
    if (this.worker) return;
    try {
      const w = this.workerFactory(this.userDataPath);
      w.on('message', (msg: LedgerWorkerOutboundMsg) => this.handleMessage(msg));
      w.on('error', (err) => this.handleWorkerError(err));
      w.on('exit', (code) => {
        if (code !== 0 && !this.shuttingDown) {
          this.handleWorkerError(new Error(`Conversation ledger worker exited with code ${code}`));
        }
      });
      this.worker = w;
      logger.info('Conversation ledger worker started');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        'Failed to start conversation ledger worker; ledger persistence unavailable until restart',
        err instanceof Error ? err : undefined,
      );
      this.markDegraded(reason);
    }
  }

  private handleMessage(msg: LedgerWorkerOutboundMsg): void {
    if (msg.type !== 'rpc-response') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(msg.id);
    if (this.restartAttempts > 0) {
      this.restartAttempts = 0;
      logger.info('Conversation ledger worker recovered after restart');
    }
    if (msg.error) {
      this.metrics.failed++;
      this.metrics.lastError = msg.error;
      pending.reject(new Error(msg.error));
    } else {
      this.metrics.processed++;
      pending.resolve(msg.result ?? null);
    }
  }

  private handleWorkerError(err: Error): void {
    this.metrics.lastError = err.message;
    this.failAllPending(err);
    this.worker = null;
    this.markDegraded(err.message);
    if (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.restartAttempts++;
      logger.warn('Conversation ledger worker crashed; scheduling restart', {
        error: err.message,
        attempt: this.restartAttempts,
        maxAttempts: MAX_RESTART_ATTEMPTS,
      });
      const timer = setTimeout(() => {
        this.isDegraded = false;
        this.startWorker();
      }, RESTART_BACKOFF_MS);
      timer.unref?.();
    } else {
      logger.error(
        'Conversation ledger worker exceeded restart attempts; staying degraded (ledger persistence disabled this session)',
        undefined,
        { error: err.message, maxAttempts: MAX_RESTART_ATTEMPTS },
      );
    }
  }

  private markDegraded(reason: string): void {
    this.isDegraded = true;
    this.metrics.lastError = reason;
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private postRpc(msg: LedgerWorkerInboundMsg): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error('conversation ledger worker unavailable'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.id);
        this.metrics.failed++;
        this.metrics.lastError = `ledger worker RPC timed out: ${msg.type}`;
        reject(new Error(`conversation ledger worker RPC timed out after ${this.rpcTimeoutMs}ms`));
      }, this.rpcTimeoutMs);
      timeout.unref?.();
      this.pending.set(msg.id, { resolve, reject, timeout });
      try {
        this.worker!.postMessage(msg);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(msg.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
