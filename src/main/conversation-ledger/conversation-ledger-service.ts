import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type {
  ConversationDiscoveryScope,
  ConversationLedgerConversation,
  ConversationListQuery,
  ConversationProvider,
  ConversationThreadRecord,
  NativeThreadStartRequest,
  NativeTurnRequest,
  ReconciliationResult,
} from '../../shared/types/conversation-ledger.types';
import { ConversationLedgerStore } from './conversation-ledger-store';
import { runConversationLedgerMigrations } from './conversation-ledger-schema';
import { getNativeConversationRegistry, NativeConversationRegistry } from './native-conversation-registry';
import type { NativeConversationAdapter } from './native-conversation-adapter';
import { CodexNativeConversationAdapter } from './codex/codex-native-conversation-adapter';

const logger = getLogger('ConversationLedgerService');

export interface ConversationLedgerServiceConfig {
  dbPath?: string;
  enableWAL?: boolean;
  cacheSize?: number;
  driverFactory?: SqliteDriverFactory;
  store?: ConversationLedgerStore;
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
  private readonly store: ConversationLedgerStore;
  private readonly registry: NativeConversationRegistry;
  private readonly db: SqliteDriver | null;

  static getInstance(config?: ConversationLedgerServiceConfig): ConversationLedgerService {
    this.instance ??= new ConversationLedgerService(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.close();
    this.instance = null;
  }

  constructor(config: ConversationLedgerServiceConfig = {}) {
    this.registry = config.registry ?? getNativeConversationRegistry();
    if (config.store) {
      this.store = config.store;
      this.db = null;
    } else {
      const dbPath = config.dbPath ?? defaultConversationLedgerDbPath();
      mkdirSync(dirname(dbPath), { recursive: true });
      const factory = config.driverFactory ?? defaultDriverFactory;
      this.db = factory(dbPath);
      if (config.enableWAL ?? true) {
        this.db.pragma('journal_mode = WAL');
      }
      this.db.pragma(`cache_size = -${(config.cacheSize ?? 64) * 1024}`);
      this.db.pragma('foreign_keys = ON');
      runConversationLedgerMigrations(this.db);
      this.store = new ConversationLedgerStore(this.db);
    }

    const adapters = config.adapters ?? [new CodexNativeConversationAdapter()];
    for (const adapter of adapters) {
      this.registry.register(adapter, { override: true });
    }
    logger.info('ConversationLedgerService initialized');
  }

  listConversations(query: ConversationListQuery = {}): ConversationThreadRecord[] {
    return this.store.listThreads(query);
  }

  getConversation(threadId: string): ConversationLedgerConversation {
    const thread = this.store.findThreadById(threadId);
    if (!thread) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} not found`, 'CONVERSATION_NOT_FOUND');
    }
    return {
      thread,
      messages: this.store.getMessages(threadId),
    };
  }

  async discoverNativeConversations(scope: ConversationDiscoveryScope): Promise<ConversationThreadRecord[]> {
    const providers = scope.provider ? [scope.provider] : this.registry.listCapabilities().map(cap => cap.provider);
    const imported: ConversationThreadRecord[] = [];
    for (const provider of providers) {
      const adapter = this.getAdapter(provider);
      const threads = await adapter.discover({ ...scope, provider });
      for (const thread of threads) {
        imported.push(this.store.upsertThread({
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
    const thread = this.store.findThreadById(threadId);
    if (!thread?.nativeThreadId) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} cannot be reconciled`, 'CONVERSATION_NOT_RECONCILABLE');
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
      const result = this.store.replaceThreadMessagesFromImport(threadId, snapshot.messages, cursor);
      this.store.upsertThread({
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
      this.store.upsertThread({
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
    if (request.provider !== 'codex') {
      throw new ConversationLedgerServiceError(`Provider ${request.provider} is not supported yet`, 'PROVIDER_UNSUPPORTED');
    }
    const adapter = this.getAdapter(request.provider);
    const handle = await adapter.startThread({ ...request, ephemeral: request.ephemeral ?? false });
    return this.store.upsertThread({
      provider: request.provider,
      nativeThreadId: handle.nativeThreadId,
      nativeSessionId: handle.nativeSessionId ?? null,
      nativeSourceKind: 'appServer',
      sourceKind: 'orchestrator',
      sourcePath: handle.sourcePath ?? null,
      workspacePath: handle.workspacePath ?? request.workspacePath,
      title: request.title ?? handle.title ?? null,
      writable: true,
      nativeVisibilityMode: 'app-server-durable',
      syncStatus: 'synced',
      conflictStatus: 'none',
      metadata: handle.metadata ?? {},
    });
  }

  async sendTurn(threadId: string, request: NativeTurnRequest) {
    const thread = this.store.findThreadById(threadId);
    if (!thread?.nativeThreadId) {
      throw new ConversationLedgerServiceError(`Conversation ${threadId} cannot be sent to`, 'CONVERSATION_NOT_WRITABLE');
    }
    const adapter = this.getAdapter(thread.provider);
    const existingCount = this.store.getMessages(threadId).length;
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
    this.store.upsertMessages(threadId, messages);
    this.store.upsertThread({
      id: thread.id,
      provider: thread.provider,
      nativeThreadId: thread.nativeThreadId,
      sourceKind: thread.sourceKind,
      updatedAt: Date.now(),
      syncStatus: 'dirty',
      writable: thread.writable,
      nativeVisibilityMode: thread.nativeVisibilityMode,
      conflictStatus: thread.conflictStatus,
    });
    return {
      ...result,
      messages: this.store.getMessages(threadId),
    };
  }

  close(): void {
    this.db?.close();
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
