/**
 * LedgerStorePort — async façade over ConversationLedgerStore's persistence.
 *
 * The conversation ledger's SQLite work must not run on the Electron main event
 * loop, so ConversationLedgerService talks to its storage through this async
 * port rather than to a ConversationLedgerStore directly. Two implementations
 * exist:
 *
 *  - InProcessLedgerStorePort: wraps a synchronous ConversationLedgerStore and
 *    resolves immediately. Used in tests and for `:memory:` databases, where
 *    spinning up a worker thread is unnecessary.
 *  - ConversationLedgerWorkerClient: posts each call to the conversation worker
 *    that solely owns the on-disk conversation-ledger.db (production default).
 *
 * Only the operations ConversationLedgerService actually needs are exposed;
 * adapter / registry work stays in the service on the main thread.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
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
import type { ConversationLedgerStore } from './conversation-ledger-store';

/** A message to append with its sequence assigned by the store, not the caller. */
export type AppendMessageInput =
  Omit<ConversationMessageUpsertInput, 'sequence'> & { sequence?: number };

export interface LedgerStorePort {
  findThreadById(id: string): Promise<ConversationThreadRecord | null>;
  listThreads(query: ConversationListQuery): Promise<ConversationThreadRecord[]>;
  getMessages(
    threadId: string,
    options?: ConversationMessagesQuery,
  ): Promise<ConversationMessageRecord[]>;
  getRecentMessages(threadId: string, limit: number): Promise<ConversationMessageRecord[]>;
  getMessagesBefore(
    threadId: string,
    beforeSequence: number,
    limit: number,
  ): Promise<ConversationMessageRecord[]>;
  countMessages(threadId: string): Promise<number>;
  hasMessageWithNativeId(threadId: string, nativeMessageId: string): Promise<boolean>;
  upsertThread(input: ConversationThreadUpsertInput): Promise<ConversationThreadRecord>;
  upsertMessages(
    threadId: string,
    messages: ConversationMessageUpsertInput[],
  ): Promise<void>;
  appendMessagesWithThreadTouch(
    threadId: string,
    inputs: AppendMessageInput[],
  ): Promise<ConversationMessageRecord[] | null>;
  replaceThreadMessagesFromImport(
    threadId: string,
    messages: ConversationMessageUpsertInput[],
    cursor?: ConversationSyncCursorUpsertInput,
  ): Promise<ReconciliationResult>;
  writeCheckpoint(
    threadId: string,
    input: ConversationCheckpointUpsertInput,
  ): Promise<ConversationCheckpointRecord>;
  getLatestCheckpoint(threadId: string): Promise<ConversationCheckpointRecord | null>;
  /** Release resources (close the DB / terminate the worker). */
  close(): Promise<void>;
}

/**
 * Synchronous store wrapped in an async port. Owns the SQLite driver it was
 * given so `close()` can release it (the worker uses its own driver instead).
 */
export class InProcessLedgerStorePort implements LedgerStorePort {
  constructor(
    private readonly store: ConversationLedgerStore,
    private readonly db?: SqliteDriver,
  ) {}

  async findThreadById(id: string): Promise<ConversationThreadRecord | null> {
    return this.store.findThreadById(id);
  }

  async listThreads(query: ConversationListQuery): Promise<ConversationThreadRecord[]> {
    return this.store.listThreads(query);
  }

  async getMessages(
    threadId: string,
    options?: ConversationMessagesQuery,
  ): Promise<ConversationMessageRecord[]> {
    return this.store.getMessages(threadId, options);
  }

  async getRecentMessages(threadId: string, limit: number): Promise<ConversationMessageRecord[]> {
    return this.store.getRecentMessages(threadId, limit);
  }

  async getMessagesBefore(
    threadId: string,
    beforeSequence: number,
    limit: number,
  ): Promise<ConversationMessageRecord[]> {
    return this.store.getMessagesBefore(threadId, beforeSequence, limit);
  }

  async countMessages(threadId: string): Promise<number> {
    return this.store.countMessages(threadId);
  }

  async hasMessageWithNativeId(threadId: string, nativeMessageId: string): Promise<boolean> {
    return this.store.hasMessageWithNativeId(threadId, nativeMessageId);
  }

  async upsertThread(input: ConversationThreadUpsertInput): Promise<ConversationThreadRecord> {
    return this.store.upsertThread(input);
  }

  async upsertMessages(
    threadId: string,
    messages: ConversationMessageUpsertInput[],
  ): Promise<void> {
    this.store.upsertMessages(threadId, messages);
  }

  async appendMessagesWithThreadTouch(
    threadId: string,
    inputs: AppendMessageInput[],
  ): Promise<ConversationMessageRecord[] | null> {
    return this.store.appendMessagesWithThreadTouch(threadId, inputs);
  }

  async replaceThreadMessagesFromImport(
    threadId: string,
    messages: ConversationMessageUpsertInput[],
    cursor?: ConversationSyncCursorUpsertInput,
  ): Promise<ReconciliationResult> {
    return this.store.replaceThreadMessagesFromImport(threadId, messages, cursor);
  }

  async writeCheckpoint(
    threadId: string,
    input: ConversationCheckpointUpsertInput,
  ): Promise<ConversationCheckpointRecord> {
    return this.store.writeCheckpoint(threadId, input);
  }

  async getLatestCheckpoint(threadId: string): Promise<ConversationCheckpointRecord | null> {
    return this.store.getLatestCheckpoint(threadId);
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}

/** The store methods exposed across the worker boundary, as a closed union. */
export type LedgerStoreMethod =
  | 'findThreadById'
  | 'listThreads'
  | 'getMessages'
  | 'getRecentMessages'
  | 'getMessagesBefore'
  | 'countMessages'
  | 'hasMessageWithNativeId'
  | 'upsertThread'
  | 'upsertMessages'
  | 'appendMessagesWithThreadTouch'
  | 'replaceThreadMessagesFromImport'
  | 'writeCheckpoint'
  | 'getLatestCheckpoint';
