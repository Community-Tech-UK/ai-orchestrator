import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriverFactory } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type {
  ConversationCheckpointRecord,
  ConversationCheckpointUpsertInput,
  ConversationDiscoveryScope,
  ConversationLedgerConversation,
  ConversationMessagePage,
  ConversationListQuery,
  ConversationMessageRecord,
  ConversationProvider,
  ConversationThreadRecord,
  NativeThreadStartRequest,
  NativeTurnRequest,
  ReconciliationResult,
} from '../../shared/types/conversation-ledger.types';
import { ConversationLedgerStore } from './conversation-ledger-store';
import { runConversationLedgerMigrations } from './conversation-ledger-schema';
import {
  InProcessLedgerStorePort,
  type AppendMessageInput,
  type LedgerStorePort,
} from './ledger-store-port';
import { ConversationLedgerWorkerClient } from './conversation-ledger-worker-client';
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
  LegacyMarkerCompareAndSwapInput,
  LegacyOutputCacheMarkerRecord,
} from './context-evidence-ledger.types';
import { getNativeConversationRegistry, NativeConversationRegistry } from './native-conversation-registry';
import type { NativeConversationAdapter } from './native-conversation-adapter';
import { CodexNativeConversationAdapter } from './codex/codex-native-conversation-adapter';
import { InternalOrchestratorConversationAdapter } from './internal-orchestrator-conversation-adapter';

const logger = getLogger('ConversationLedgerService');
const DEFAULT_CONVERSATION_WINDOW_LIMIT = 200;
/**
 * Hard ceiling on how many messages `getFullConversation` will materialize.
 * Beyond this, we return the most recent window (with the true total) rather
 * than loading the entire transcript — an unbounded read that can exhaust the
 * conversation worker's V8 heap and abort the whole process. Callers fetch
 * older messages via `getConversationPageBefore`.
 */
const MAX_FULL_CONVERSATION_MESSAGES = 1000;

export interface ConversationLedgerServiceConfig {
  dbPath?: string;
  enableWAL?: boolean;
  cacheSize?: number;
  driverFactory?: SqliteDriverFactory;
  store?: ConversationLedgerStore;
  /**
   * Pre-built storage port. Lets callers inject a fake or the worker client
   * directly. When omitted, the service picks a port itself: an in-process port
   * for an injected `store`/`dbPath` (tests, `:memory:`), otherwise a
   * worker-backed port that owns the on-disk DB off the main thread (production).
   */
  port?: LedgerStorePort;
  registry?: NativeConversationRegistry;
  adapters?: NativeConversationAdapter[];
}

export class ConversationLedgerServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ConversationLedgerServiceError';
  }
}

export class ConversationLedgerService {
  private static instance: ConversationLedgerService | null = null;
  private readonly port: LedgerStorePort;
  private readonly registry: NativeConversationRegistry;

  static getInstance(config?: ConversationLedgerServiceConfig): ConversationLedgerService {
    this.instance ??= new ConversationLedgerService(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    void this.instance?.close();
    this.instance = null;
  }

  constructor(config: ConversationLedgerServiceConfig = {}) {
    this.registry = config.registry ?? getNativeConversationRegistry();
    this.port = ConversationLedgerService.createPort(config);

    const adapters = config.adapters ?? [
      new CodexNativeConversationAdapter(),
      new InternalOrchestratorConversationAdapter(),
    ];
    for (const adapter of adapters) {
      this.registry.register(adapter, { override: true });
    }
    logger.info('ConversationLedgerService initialized');
  }

  /**
   * Choose the storage port. An explicit `port` wins; an injected `store` or a
   * `dbPath`/`driverFactory` (tests, `:memory:`) builds a synchronous in-process
   * port; otherwise production gets a worker-backed port that owns the on-disk
   * conversation-ledger.db off the main thread.
   */
  private static createPort(config: ConversationLedgerServiceConfig): LedgerStorePort {
    if (config.port) {
      return config.port;
    }
    if (config.store) {
      return new InProcessLedgerStorePort(config.store);
    }
    if (config.dbPath !== undefined || config.driverFactory) {
      const dbPath = config.dbPath ?? defaultConversationLedgerDbPath();
      mkdirSync(dirname(dbPath), { recursive: true });
      const factory = config.driverFactory ?? defaultDriverFactory;
      const db = factory(dbPath);
      if (config.enableWAL ?? true) {
        db.pragma('journal_mode = WAL');
      }
      db.pragma(`cache_size = -${(config.cacheSize ?? 64) * 1024}`);
      db.pragma('foreign_keys = ON');
      runConversationLedgerMigrations(db);
      return new InProcessLedgerStorePort(new ConversationLedgerStore(db), db);
    }
    return new ConversationLedgerWorkerClient();
  }

  async listConversations(query: ConversationListQuery = {}): Promise<ConversationThreadRecord[]> {
    return this.port.listThreads(query);
  }

  async getConversation(
    threadId: string,
    limit?: number,
  ): Promise<ConversationLedgerConversation> {
    if (typeof limit === 'number') {
      return this.getRecentConversation(threadId, limit);
    }
    return this.getFullConversation(threadId);
  }

  async getFullConversation(threadId: string): Promise<ConversationLedgerConversation> {
    const thread = await this.port.findThreadById(threadId);
    if (!thread) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} not found`, 'CONVERSATION_NOT_FOUND');
    }
    const totalMessages = await this.port.countMessages(threadId);
    if (totalMessages > MAX_FULL_CONVERSATION_MESSAGES) {
      logger.warn(
        `Conversation ${threadId} has ${totalMessages} messages; returning the most recent ` +
        `${MAX_FULL_CONVERSATION_MESSAGES} to avoid exhausting the worker heap. ` +
        `Use pagination (getConversationPageBefore) for older messages.`,
      );
      const recent = await this.port.getRecentMessages(threadId, MAX_FULL_CONVERSATION_MESSAGES);
      return this.buildConversation(thread, recent, totalMessages);
    }
    const messages = await this.port.getMessages(threadId);
    return this.buildConversation(thread, messages, totalMessages);
  }

  async getRecentConversation(
    threadId: string,
    limit: number = DEFAULT_CONVERSATION_WINDOW_LIMIT,
  ): Promise<ConversationLedgerConversation> {
    const thread = await this.port.findThreadById(threadId);
    if (!thread) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} not found`, 'CONVERSATION_NOT_FOUND');
    }
    const bounded = Math.max(1, Math.min(limit, 1000));
    const [messages, totalMessages] = await Promise.all([
      this.port.getRecentMessages(threadId, bounded),
      this.port.countMessages(threadId),
    ]);
    return this.buildConversation(thread, messages, totalMessages);
  }

  async getConversationPageBefore(
    threadId: string,
    beforeSequence: number,
    limit: number = DEFAULT_CONVERSATION_WINDOW_LIMIT,
  ): Promise<ConversationMessagePage> {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const [messages, totalMessages] = await Promise.all([
      this.port.getMessagesBefore(threadId, beforeSequence, bounded),
      this.port.countMessages(threadId),
    ]);
    const oldestSequence = messages[0]?.sequence ?? null;
    return {
      threadId,
      messages,
      totalMessages,
      hasMore: oldestSequence !== null && oldestSequence > 1,
      nextBeforeSequence: oldestSequence,
    };
  }

  /** Fetch just a thread record — no messages. Cheap existence/metadata check. */
  async getThread(threadId: string): Promise<ConversationThreadRecord | null> {
    return this.port.findThreadById(threadId);
  }

  async updateThreadMetadata(
    threadId: string,
    metadata: Record<string, unknown>,
  ): Promise<ConversationThreadRecord> {
    const thread = await this.port.findThreadById(threadId);
    if (!thread) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} not found`, 'CONVERSATION_NOT_FOUND');
    }
    return this.port.upsertThread({
      id: thread.id,
      provider: thread.provider,
      nativeThreadId: thread.nativeThreadId,
      sourceKind: thread.sourceKind,
      metadata: {
        ...thread.metadata,
        ...metadata,
      },
    });
  }

  async hasMessages(threadId: string): Promise<boolean> {
    return (await this.port.countMessages(threadId)) > 0;
  }

  /** Whether a message with the given native id already exists on a thread —
   *  used to dedupe idempotent system events without loading the transcript. */
  async hasMessage(threadId: string, nativeMessageId: string): Promise<boolean> {
    return this.port.hasMessageWithNativeId(threadId, nativeMessageId);
  }

  /**
   * Persist a durable compaction checkpoint (§4.4) — a summarized digest of all
   * thread messages up to `upToSequence`. Lets a context rebuild stay bounded by
   * walking `[checkpoint summary] + [verbatim tail]` instead of dropping older
   * turns. The verbatim messages are never deleted, so the checkpoint is always
   * regenerable.
   */
  async writeCheckpoint(
    threadId: string,
    input: ConversationCheckpointUpsertInput,
  ): Promise<ConversationCheckpointRecord> {
    return this.port.writeCheckpoint(threadId, input);
  }

  /** The checkpoint covering the largest message prefix for a thread, or null. */
  async getLatestCheckpoint(threadId: string): Promise<ConversationCheckpointRecord | null> {
    return this.port.getLatestCheckpoint(threadId);
  }

  /**
   * Ascending window of messages with `sequence > afterSequence`. Used by the
   * checkpoint producer to read the uncheckpointed tail, and by checkpoint-aware
   * rebuild to replay the verbatim turns after the latest checkpoint.
   */
  async getMessagesAfter(
    threadId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ConversationMessageRecord[]> {
    return this.port.getMessages(threadId, { afterSequence, limit });
  }

  async discoverNativeConversations(scope: ConversationDiscoveryScope): Promise<ConversationThreadRecord[]> {
    const providers = scope.provider ? [scope.provider] : this.registry.listCapabilities().map(cap => cap.provider);
    const imported: ConversationThreadRecord[] = [];
    for (const provider of providers) {
      const adapter = this.getAdapter(provider);
      const threads = await adapter.discover({ ...scope, provider });
      for (const thread of threads) {
        imported.push(await this.port.upsertThread({
          provider: thread.provider,
          nativeThreadId: thread.nativeThreadId,
          nativeSessionId: thread.nativeSessionId ?? null,
          nativeSourceKind: thread.nativeSourceKind ?? null,
          sourceKind: 'provider-native',
          sourcePath: thread.sourcePath ?? null,
          workspacePath: thread.workspacePath ?? null,
          title: thread.title ?? null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          writable: thread.writable ?? false,
          nativeVisibilityMode: thread.nativeVisibilityMode ?? 'best-effort',
          syncStatus: 'imported',
          conflictStatus: 'none',
          metadata: thread.metadata ?? {},
        }));
      }
    }
    return imported;
  }

  async reconcileConversation(threadId: string): Promise<ReconciliationResult> {
    const thread = await this.port.findThreadById(threadId);
    if (!thread?.nativeThreadId) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} cannot be reconciled`, 'CONVERSATION_NOT_RECONCILABLE');
    }
    if (thread.provider === 'orchestrator') {
      await this.port.upsertThread({
        id: thread.id,
        provider: thread.provider,
        nativeThreadId: thread.nativeThreadId,
        sourceKind: thread.sourceKind,
        syncStatus: 'synced',
        conflictStatus: 'none',
        updatedAt: Date.now(),
      });
      return {
        threadId,
        provider: thread.provider,
        nativeThreadId: thread.nativeThreadId,
        addedMessages: 0,
        updatedMessages: 0,
        deletedMessages: 0,
        syncStatus: 'synced',
        conflictStatus: 'none',
        warnings: [],
      };
    }
    const adapter = this.getAdapter(thread.provider);
    try {
      const snapshot = await adapter.readThread({
        provider: thread.provider,
        threadId,
        nativeThreadId: thread.nativeThreadId,
        sourcePath: thread.sourcePath,
        workspacePath: thread.workspacePath,
      });
      const cursor = snapshot.cursor ? { ...snapshot.cursor, threadId } : undefined;
      const result = await this.port.replaceThreadMessagesFromImport(threadId, snapshot.messages, cursor);
      await this.port.upsertThread({
        id: thread.id,
        provider: thread.provider,
        nativeThreadId: thread.nativeThreadId,
        nativeSessionId: snapshot.thread.nativeSessionId ?? thread.nativeSessionId,
        nativeSourceKind: snapshot.thread.nativeSourceKind ?? thread.nativeSourceKind,
        sourceKind: thread.sourceKind,
        sourcePath: snapshot.thread.sourcePath ?? thread.sourcePath,
        workspacePath: snapshot.thread.workspacePath ?? thread.workspacePath,
        title: snapshot.thread.title ?? thread.title,
        createdAt: snapshot.thread.createdAt ?? thread.createdAt,
        updatedAt: snapshot.thread.updatedAt ?? Date.now(),
        lastSyncedAt: Date.now(),
        writable: thread.writable,
        nativeVisibilityMode: snapshot.thread.nativeVisibilityMode ?? thread.nativeVisibilityMode,
        syncStatus: 'synced',
        conflictStatus: result.conflictStatus,
        metadata: snapshot.thread.metadata ?? {},
      });
      return result;
    } catch (error) {
      await this.port.upsertThread({
        id: thread.id,
        provider: thread.provider,
        nativeThreadId: thread.nativeThreadId,
        sourceKind: thread.sourceKind,
        syncStatus: 'error',
        conflictStatus: thread.conflictStatus,
        metadata: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async startConversation(request: NativeThreadStartRequest): Promise<ConversationThreadRecord> {
    const adapter = this.getAdapter(request.provider);
    const handle = await adapter.startThread({ ...request, ephemeral: request.ephemeral ?? false });
    return this.port.upsertThread({
      provider: request.provider,
      nativeThreadId: handle.nativeThreadId,
      nativeSessionId: handle.nativeSessionId ?? null,
      nativeSourceKind: request.provider === 'orchestrator' ? 'internal' : 'appServer',
      sourceKind: 'orchestrator',
      sourcePath: handle.sourcePath ?? null,
      workspacePath: handle.workspacePath ?? request.workspacePath ?? null,
      title: request.title ?? handle.title ?? null,
      writable: true,
      nativeVisibilityMode: request.provider === 'orchestrator' ? 'none' : 'app-server-durable',
      syncStatus: 'synced',
      conflictStatus: 'none',
      parentConversationId: request.parentConversationId ?? null,
      metadata: handle.metadata ?? {},
    });
  }

  async sendTurn(threadId: string, request: NativeTurnRequest) {
    const thread = await this.port.findThreadById(threadId);
    if (!thread?.nativeThreadId) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} cannot be sent to`, 'CONVERSATION_NOT_WRITABLE');
    }
    const adapter = this.getAdapter(thread.provider);
    const existingCount = await this.port.countMessages(threadId);
    const result = await adapter.sendTurn({
      provider: thread.provider,
      threadId,
      nativeThreadId: thread.nativeThreadId,
      workspacePath: thread.workspacePath,
      sourcePath: thread.sourcePath,
    }, request);
    const messages = result.messages.map((message, index) => ({
      ...message,
      sequence: existingCount + index + 1,
    }));
    await this.port.upsertMessages(threadId, messages);
    await this.port.upsertThread({
      id: thread.id,
      provider: thread.provider,
      nativeThreadId: thread.nativeThreadId,
      sourceKind: thread.sourceKind,
      updatedAt: Date.now(),
      syncStatus: thread.provider === 'orchestrator' ? 'synced' : 'dirty',
      writable: thread.writable,
      nativeVisibilityMode: thread.nativeVisibilityMode,
      conflictStatus: thread.conflictStatus,
    });
    return {
      ...result,
      messages: (await this.getRecentConversation(threadId)).messages,
    };
  }

  async appendMessage(
    threadId: string,
    message: AppendMessageInput,
  ): Promise<ConversationLedgerConversation> {
    const records = await this.port.appendMessagesWithThreadTouch(threadId, [message]);
    if (records === null) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} not found`, 'CONVERSATION_NOT_FOUND');
    }
    return this.getRecentConversation(threadId);
  }

  /**
   * Append a single message and return only that record, never the full
   * conversation. Keeps the live transcript path O(1) per append — the caller
   * broadcasts the delta instead of re-reading the whole transcript.
   */
  async appendMessageReturningRecord(
    threadId: string,
    message: AppendMessageInput,
  ): Promise<ConversationMessageRecord> {
    const records = await this.port.appendMessagesWithThreadTouch(threadId, [message]);
    if (records === null) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} not found`, 'CONVERSATION_NOT_FOUND');
    }
    const record = records[0];
    if (!record) {
      throw new ConversationLedgerServiceError(`Failed to append message to ${threadId}`, 'CONVERSATION_APPEND_FAILED');
    }
    return record;
  }

  /**
   * Append a batch of messages in a single off-thread transaction and return the
   * freshly-appended records (with their assigned sequences). This is the write
   * path the live transcript bridge uses for its coalesced flush — one worker
   * round-trip + one transaction per flush instead of per provider event.
   */
  async appendMessagesReturningRecords(
    threadId: string,
    messages: AppendMessageInput[],
  ): Promise<ConversationMessageRecord[]> {
    if (messages.length === 0) {
      return [];
    }
    const records = await this.port.appendMessagesWithThreadTouch(threadId, messages);
    if (records === null) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} not found`, 'CONVERSATION_NOT_FOUND');
    }
    return records;
  }

  /** Persist a batch of raw-backed canonical provider events off the main thread. */
  async appendProviderEventCaptures(captures: ProviderEventCaptureInput[]): Promise<void> {
    if (captures.length === 0) return;
    await this.port.appendProviderEventCaptures(captures);
  }

  async listProviderEventCaptures(
    query: ProviderEventCaptureQuery,
  ): Promise<ProviderEventCaptureRecord[]> {
    return this.port.listProviderEventCaptures(query);
  }

  async pruneProviderEventCapturesBefore(before: number): Promise<number> {
    return this.port.pruneProviderEventCapturesBefore(before);
  }

  async stageEvidence(input: EvidenceStageInput): Promise<EvidenceLedgerRecord> {
    return this.port.stageEvidence(input);
  }

  async prepareEvidenceBlob(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord> {
    return this.port.prepareEvidenceBlob(input);
  }

  async finalizeEvidence(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord> {
    return this.port.finalizeEvidence(input);
  }

  async failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord> {
    return this.port.failEvidence(input);
  }

  async getEvidence(
    conversationId: string,
    evidenceId: string,
  ): Promise<EvidenceLedgerRecord | null> {
    return this.port.getEvidence(conversationId, evidenceId);
  }

  async listEvidence(
    conversationId: string,
    query?: EvidenceListQuery,
  ): Promise<EvidenceLedgerRecord[]> {
    return this.port.listEvidence(conversationId, query);
  }

  async listEvidenceForMaintenance(query: EvidenceMaintenanceQuery): Promise<EvidenceLedgerRecord[]> {
    return this.port.listEvidenceForMaintenance(query);
  }

  async listReferencedEvidenceBlobRefs(query: EvidenceBlobReferenceQuery): Promise<string[]> {
    return this.port.listReferencedEvidenceBlobRefs(query);
  }

  async replaceEvidenceBlob(input: EvidenceBlobReplacementInput): Promise<boolean> {
    return this.port.replaceEvidenceBlob(input);
  }

  async searchEvidenceMetadata(
    conversationId: string,
    query: EvidenceMetadataSearchQuery,
  ): Promise<EvidenceLedgerRecord[]> {
    return this.port.searchEvidenceMetadata(conversationId, query);
  }

  async authorizeEvidenceRange(
    input: EvidenceRangeAuthorizationInput,
  ): Promise<EvidenceRangeAuthorization> {
    return this.port.authorizeEvidenceRange(input);
  }

  async storeEvidenceCard(input: EvidenceCardMetadataInput): Promise<EvidenceCardMetadataRecord> {
    return this.port.storeEvidenceCard(input);
  }

  async getEvidenceCard(
    conversationId: string,
    cardId: string,
  ): Promise<EvidenceCardMetadataRecord | null> {
    return this.port.getEvidenceCard(conversationId, cardId);
  }

  async listEvidenceCards(
    conversationId: string,
    query?: EvidenceCardListQuery,
  ): Promise<EvidenceCardMetadataRecord[]> {
    return this.port.listEvidenceCards(conversationId, query);
  }

  async getContextEvidenceConversationMetrics(
    conversationId: string,
  ): Promise<ContextEvidenceConversationMetrics> {
    return this.port.getContextEvidenceConversationMetrics(conversationId);
  }

  async logEvidenceAccess(input: EvidenceAccessLogInput): Promise<void> {
    await this.port.logEvidenceAccess(input);
  }

  async recordContextEvidenceEvent(input: ContextEvidenceEventInput): Promise<void> {
    await this.port.recordContextEvidenceEvent(input);
  }

  async softDeleteConversationWithEvidence(
    input: ConversationEvidenceDeletionInput,
  ): Promise<ConversationEvidenceDeletionResult> {
    return this.port.softDeleteConversationWithEvidence(input);
  }

  async claimEvidenceDeletions(
    now: number,
    limit: number,
    leaseMs?: number,
  ): Promise<EvidenceDeletionQueueRecord[]> {
    return this.port.claimEvidenceDeletions(now, limit, leaseMs);
  }

  async completeEvidenceDeletion(
    id: string,
    claimToken: string,
    completedAt: number,
  ): Promise<boolean> {
    return this.port.completeEvidenceDeletion(id, claimToken, completedAt);
  }

  async failEvidenceDeletion(
    id: string,
    claimToken: string,
    errorCode: string,
    retryAt: number,
  ): Promise<boolean> {
    return this.port.failEvidenceDeletion(id, claimToken, errorCode, retryAt);
  }

  async compareAndSwapLegacyOutputMarker(input: LegacyMarkerCompareAndSwapInput): Promise<boolean> {
    return this.port.compareAndSwapLegacyOutputMarker(input);
  }

  async listLegacyOutputCacheMarkers(): Promise<LegacyOutputCacheMarkerRecord[]> {
    return this.port.listLegacyOutputCacheMarkers();
  }

  async close(): Promise<void> {
    await this.port.close();
  }

  private buildConversation(
    thread: ConversationThreadRecord,
    messages: ConversationMessageRecord[],
    totalMessages: number,
  ): ConversationLedgerConversation {
    return {
      thread,
      messages,
      window: {
        totalMessages,
        hasOlder: totalMessages > messages.length,
        oldestSequence: messages[0]?.sequence ?? null,
        newestSequence: messages[messages.length - 1]?.sequence ?? null,
      },
    };
  }

  private getAdapter(provider: ConversationProvider): NativeConversationAdapter {
    const adapter = this.registry.get(provider);
    if (!adapter) {
      throw new ConversationLedgerServiceError(`No native conversation adapter for ${provider}`, 'ADAPTER_UNAVAILABLE');
    }
    return adapter;
  }
}

function defaultConversationLedgerDbPath(): string {
  const userDataPath = app?.getPath?.('userData') || join(process.cwd(), '.conversation-ledger');
  return join(userDataPath, 'conversation-ledger', 'conversation-ledger.db');
}

export function getConversationLedgerService(config?: ConversationLedgerServiceConfig): ConversationLedgerService {
  return ConversationLedgerService.getInstance(config);
}
