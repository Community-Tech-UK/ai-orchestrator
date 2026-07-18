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
import type {
  ProviderEventCaptureInput,
  ProviderEventCaptureQuery,
  ProviderEventCaptureRecord,
} from './provider-event-capture.types';
import type {
  ContextEvidenceEventInput,
  ContextEvidenceConversationMetrics,
  ConversationEvidenceDeletionInput,
  ConversationEvidenceDeletionResult,
  EvidenceAccessLogInput,
  EvidenceCardMetadataInput,
  EvidenceCardMetadataRecord,
  EvidenceCardListQuery,
  EvidenceDeletionQueueRecord,
  EvidenceFailureInput,
  EvidenceFinalizeInput,
  EvidenceLedgerRecord,
  EvidenceListQuery,
  EvidenceBlobReferenceQuery,
  EvidenceMaintenanceQuery,
  EvidenceMetadataSearchQuery,
  EvidenceBlobReplacementInput,
  EvidenceRangeAuthorization,
  EvidenceRangeAuthorizationInput,
  EvidenceStageInput,
} from './context-evidence-ledger.types';

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
  appendProviderEventCaptures(captures: ProviderEventCaptureInput[]): Promise<void>;
  listProviderEventCaptures(query: ProviderEventCaptureQuery): Promise<ProviderEventCaptureRecord[]>;
  pruneProviderEventCapturesBefore(before: number): Promise<number>;
  stageEvidence(input: EvidenceStageInput): Promise<EvidenceLedgerRecord>;
  prepareEvidenceBlob(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord>;
  finalizeEvidence(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord>;
  failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord>;
  getEvidence(conversationId: string, evidenceId: string): Promise<EvidenceLedgerRecord | null>;
  listEvidence(conversationId: string, query?: EvidenceListQuery): Promise<EvidenceLedgerRecord[]>;
  listEvidenceForMaintenance(query: EvidenceMaintenanceQuery): Promise<EvidenceLedgerRecord[]>;
  listReferencedEvidenceBlobRefs(query: EvidenceBlobReferenceQuery): Promise<string[]>;
  replaceEvidenceBlob(input: EvidenceBlobReplacementInput): Promise<boolean>;
  searchEvidenceMetadata(
    conversationId: string,
    query: EvidenceMetadataSearchQuery,
  ): Promise<EvidenceLedgerRecord[]>;
  authorizeEvidenceRange(
    input: EvidenceRangeAuthorizationInput,
  ): Promise<EvidenceRangeAuthorization>;
  storeEvidenceCard(input: EvidenceCardMetadataInput): Promise<EvidenceCardMetadataRecord>;
  getEvidenceCard(conversationId: string, cardId: string): Promise<EvidenceCardMetadataRecord | null>;
  listEvidenceCards(
    conversationId: string,
    query?: EvidenceCardListQuery,
  ): Promise<EvidenceCardMetadataRecord[]>;
  getContextEvidenceConversationMetrics(
    conversationId: string,
  ): Promise<ContextEvidenceConversationMetrics>;
  logEvidenceAccess(input: EvidenceAccessLogInput): Promise<void>;
  recordContextEvidenceEvent(input: ContextEvidenceEventInput): Promise<void>;
  softDeleteConversationWithEvidence(
    input: ConversationEvidenceDeletionInput,
  ): Promise<ConversationEvidenceDeletionResult>;
  claimEvidenceDeletions(
    now: number,
    limit: number,
    leaseMs?: number,
  ): Promise<EvidenceDeletionQueueRecord[]>;
  completeEvidenceDeletion(id: string, claimToken: string, completedAt: number): Promise<boolean>;
  failEvidenceDeletion(
    id: string,
    claimToken: string,
    errorCode: string,
    retryAt: number,
  ): Promise<boolean>;
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

  async appendProviderEventCaptures(captures: ProviderEventCaptureInput[]): Promise<void> {
    this.store.appendProviderEventCaptures(captures);
  }

  async listProviderEventCaptures(
    query: ProviderEventCaptureQuery,
  ): Promise<ProviderEventCaptureRecord[]> {
    return this.store.listProviderEventCaptures(query);
  }

  async pruneProviderEventCapturesBefore(before: number): Promise<number> {
    return this.store.pruneProviderEventCapturesBefore(before);
  }

  async stageEvidence(input: EvidenceStageInput): Promise<EvidenceLedgerRecord> {
    return this.store.contextEvidence.stageEvidence(input);
  }

  async prepareEvidenceBlob(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord> {
    return this.store.contextEvidence.prepareEvidenceBlob(input);
  }

  async finalizeEvidence(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord> {
    return this.store.contextEvidence.finalizeEvidence(input);
  }

  async failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord> {
    return this.store.contextEvidence.failEvidence(input);
  }

  async getEvidence(conversationId: string, evidenceId: string): Promise<EvidenceLedgerRecord | null> {
    return this.store.contextEvidence.getEvidence(conversationId, evidenceId);
  }

  async listEvidence(conversationId: string, query?: EvidenceListQuery): Promise<EvidenceLedgerRecord[]> {
    return this.store.contextEvidence.listEvidence(conversationId, query);
  }

  async listEvidenceForMaintenance(query: EvidenceMaintenanceQuery): Promise<EvidenceLedgerRecord[]> {
    return this.store.contextEvidence.listEvidenceForMaintenance(query);
  }

  async listReferencedEvidenceBlobRefs(query: EvidenceBlobReferenceQuery): Promise<string[]> {
    return this.store.contextEvidence.listReferencedEvidenceBlobRefs(query);
  }

  async replaceEvidenceBlob(input: EvidenceBlobReplacementInput): Promise<boolean> {
    return this.store.contextEvidence.replaceEvidenceBlob(input);
  }

  async searchEvidenceMetadata(
    conversationId: string,
    query: EvidenceMetadataSearchQuery,
  ): Promise<EvidenceLedgerRecord[]> {
    return this.store.contextEvidence.searchEvidenceMetadata(conversationId, query);
  }

  async authorizeEvidenceRange(
    input: EvidenceRangeAuthorizationInput,
  ): Promise<EvidenceRangeAuthorization> {
    return this.store.contextEvidence.authorizeEvidenceRange(input);
  }

  async storeEvidenceCard(input: EvidenceCardMetadataInput): Promise<EvidenceCardMetadataRecord> {
    return this.store.contextEvidence.storeEvidenceCard(input);
  }

  async getEvidenceCard(
    conversationId: string,
    cardId: string,
  ): Promise<EvidenceCardMetadataRecord | null> {
    return this.store.contextEvidence.getEvidenceCard(conversationId, cardId);
  }

  async listEvidenceCards(
    conversationId: string,
    query?: EvidenceCardListQuery,
  ): Promise<EvidenceCardMetadataRecord[]> {
    return this.store.contextEvidence.listEvidenceCards(conversationId, query);
  }

  async getContextEvidenceConversationMetrics(
    conversationId: string,
  ): Promise<ContextEvidenceConversationMetrics> {
    return this.store.contextEvidence.getConversationMetrics(conversationId);
  }

  async logEvidenceAccess(input: EvidenceAccessLogInput): Promise<void> {
    this.store.contextEvidence.logEvidenceAccess(input);
  }

  async recordContextEvidenceEvent(input: ContextEvidenceEventInput): Promise<void> {
    this.store.contextEvidence.recordContextEvidenceEvent(input);
  }

  async softDeleteConversationWithEvidence(
    input: ConversationEvidenceDeletionInput,
  ): Promise<ConversationEvidenceDeletionResult> {
    return this.store.contextEvidence.softDeleteConversationWithEvidence(input);
  }

  async claimEvidenceDeletions(
    now: number,
    limit: number,
    leaseMs?: number,
  ): Promise<EvidenceDeletionQueueRecord[]> {
    return this.store.contextEvidence.claimEvidenceDeletions(now, limit, leaseMs);
  }

  async completeEvidenceDeletion(
    id: string,
    claimToken: string,
    completedAt: number,
  ): Promise<boolean> {
    return this.store.contextEvidence.completeEvidenceDeletion(id, claimToken, completedAt);
  }

  async failEvidenceDeletion(
    id: string,
    claimToken: string,
    errorCode: string,
    retryAt: number,
  ): Promise<boolean> {
    return this.store.contextEvidence.failEvidenceDeletion(id, claimToken, errorCode, retryAt);
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
  | 'getLatestCheckpoint'
  | 'appendProviderEventCaptures'
  | 'listProviderEventCaptures'
  | 'pruneProviderEventCapturesBefore'
  | 'stageEvidence'
  | 'prepareEvidenceBlob'
  | 'finalizeEvidence'
  | 'failEvidence'
  | 'getEvidence'
  | 'listEvidence'
  | 'listEvidenceForMaintenance'
  | 'listReferencedEvidenceBlobRefs'
  | 'replaceEvidenceBlob'
  | 'searchEvidenceMetadata'
  | 'authorizeEvidenceRange'
  | 'storeEvidenceCard'
  | 'getEvidenceCard'
  | 'listEvidenceCards'
  | 'getContextEvidenceConversationMetrics'
  | 'logEvidenceAccess'
  | 'recordContextEvidenceEvent'
  | 'softDeleteConversationWithEvidence'
  | 'claimEvidenceDeletions'
  | 'completeEvidenceDeletion'
  | 'failEvidenceDeletion';
