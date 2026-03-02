/**
 * RLM Context Manager
 * Based on arXiv:2512.24601 from MIT OASYS Lab
 *
 * Treats context as external environment for programmatic manipulation
 * Achieves 85%+ token savings vs direct context feeding
 *
 * Now with SQLite persistence layer for data durability
 *
 * This is the main coordinator class that delegates to sub-modules:
 * - context-storage: Store and section CRUD operations
 * - context-search: Grep, semantic search operations
 * - context-session: Session lifecycle management
 * - context-cache: Bloom filter and search indexing
 * - context-analytics: Statistics and metrics
 * - context-serialization: Import/export functionality
 * - context-query-engine: Query execution
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type {
  ContextStore,
  ContextSection,
  ContextQuery,
  ContextQueryResult,
  RLMSession,
  RLMConfig,
  RLMStoreStats,
  RLMSessionStats
} from '../../shared/types/rlm.types';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import type { ContextSectionRow } from '../persistence/rlm-database.types';
import { VectorStore, getVectorStore } from './vector-store';
import { LLMService, getLLMService } from './llm-service';
import { HyDEService, getHyDEService } from './hyde-service';

// Import from decomposed modules
import type {
  ExportedStore,
  ImportStoreOptions,
  SectionInput,
  StorageStats
} from './context';
import {
  // Storage
  createStore as createStoreOp,
  addSection as addSectionOp,
  addSectionsBatch as addSectionsBatchOp,
  removeSection as removeSectionOp,
  deleteStore as deleteStoreOp,
  type StorageDependencies,
  // Search
  executeGrep,
  searchStoreOptimized,
  getSection as getSectionOp,
  // Session
  startSession as startSessionOp,
  endSession as endSessionOp,
  getSessionStats as getSessionStatsOp,
  updateSessionAfterQuery,
  updateSessionTokens,
  type SessionDependencies,
  // Cache
  rebuildBloomFilterForStore,
  mightContainTerm,
  updateSearchIndex,
  createSearchIndex,
  // Analytics
  getTokenSavingsHistory as getTokenSavingsHistoryOp,
  getQueryStats as getQueryStatsOp,
  getStorageStats as getStorageStatsOp,
  getStoreStats as getStoreStatsOp,
  type AnalyticsDependencies,
  // Serialization
  exportStore as exportStoreOp,
  importStore as importStoreOp,
  // Query engine
  executeQuery as executeQueryOp,
  type QueryEngineDependencies,
  // Utilities
  estimateTokens as defaultEstimateTokens
} from './context';

const logger = getLogger('RLMContextManager');

export class RLMContextManager extends EventEmitter {
  private static instance: RLMContextManager;
  private stores = new Map<string, ContextStore>();
  private sessions = new Map<string, RLMSession>();
  private config: RLMConfig;
  private db: RLMDatabase | null = null;
  private vectorStore: VectorStore | null = null;
  private llmService: LLMService | null = null;
  private hydeService: HyDEService | null = null;
  private persistenceEnabled = true;

  private defaultConfig: RLMConfig = {
    maxSectionTokens: 8000,
    summaryThreshold: 50000,
    searchWindowSize: 2000,
    maxRecursionDepth: 3,
    maxSubQueries: 10,
    subQueryTimeout: 30000,
    summaryTargetRatio: 0.2,
    enableCostTracking: true
  };

  static getInstance(): RLMContextManager {
    if (!this.instance) {
      this.instance = new RLMContextManager();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
    this.initializePersistence();
  }

  // ============ Dependencies ============

  private getStorageDeps(): StorageDependencies {
    return {
      db: this.db,
      vectorStore: this.vectorStore,
      persistenceEnabled: this.persistenceEnabled,
      maxSectionTokens: this.config.maxSectionTokens,
      summaryThreshold: this.config.summaryThreshold,
      tokenEstimator: this.estimateTokens.bind(this)
    };
  }

  private getSessionDeps(): SessionDependencies {
    return {
      db: this.db,
      persistenceEnabled: this.persistenceEnabled
    };
  }

  private getAnalyticsDeps(): AnalyticsDependencies {
    return {
      db: this.db,
      persistenceEnabled: this.persistenceEnabled
    };
  }

  private getQueryEngineDeps(): QueryEngineDependencies {
    return {
      vectorStore: this.vectorStore,
      hydeService: this.hydeService,
      config: this.config,
      tokenEstimator: this.estimateTokens.bind(this),
      onSummarizeRequest: (request) => this.emit('summarize:request', request),
      onSubQueryRequest: (request) => this.emit('sub_query:request', request),
      onHyDE: (event) => this.emit('semantic:hyde', event),
      storageDeps: this.getStorageDeps()
    };
  }

  // ============ Initialization ============

  private initializePersistence(): void {
    try {
      this.db = getRLMDatabase();
      this.vectorStore = getVectorStore();
      this.llmService = getLLMService();
      this.hydeService = getHyDEService();
      this.loadFromPersistence();
      this.setupLLMHandlers();
      this.emit('persistence:initialized', { success: true });
    } catch (error) {
      logger.error('Failed to initialize persistence', error instanceof Error ? error : undefined);
      this.persistenceEnabled = false;
      this.emit('persistence:initialized', { success: false, error });
    }
  }

  private setupLLMHandlers(): void {
    if (!this.llmService) return;

    this.on(
      'summarize:request',
      async (request: {
        sessionId: string;
        content: string;
        targetTokens: number;
        callback: (summary: string) => void;
      }) => {
        try {
          const summary = await this.llmService!.summarize({
            requestId: `sum-${Date.now()}`,
            content: request.content,
            targetTokens: request.targetTokens,
            preserveKeyPoints: true
          });
          request.callback(summary);
        } catch (error) {
          logger.error('LLM summarization failed', error instanceof Error ? error : undefined);
        }
      }
    );

    this.on(
      'sub_query:request',
      async (request: {
        sessionId: string;
        callId: string;
        prompt: string;
        context: string;
        depth: number;
        callback: (
          response: string,
          tokens: { input: number; output: number }
        ) => void;
      }) => {
        try {
          const response = await this.llmService!.subQuery({
            requestId: request.callId,
            prompt: request.prompt,
            context: request.context,
            depth: request.depth
          });

          const tokens = {
            input: Math.ceil(
              (request.context.length + request.prompt.length) / 4
            ),
            output: Math.ceil(response.length / 4)
          };

          request.callback(response, tokens);
        } catch (error) {
          logger.error('LLM sub-query failed', error instanceof Error ? error : undefined);
          request.callback('[Sub-query failed]', { input: 0, output: 0 });
        }
      }
    );
  }

  private loadFromPersistence(): void {
    if (!this.db) return;

    const storeRows = this.db.listStores();
    let loadedStores = 0;
    let loadedSections = 0;

    for (const row of storeRows) {
      const sectionRows = this.db.getSections(row.id);

      const store: ContextStore = {
        id: row.id,
        instanceId: row.instance_id,
        sections: sectionRows.map((s) => this.rowToSection(s)),
        totalTokens: row.total_tokens,
        totalSize: row.total_size,
        searchIndex: createSearchIndex(),
        createdAt: row.created_at,
        lastAccessed: row.last_accessed,
        accessCount: row.access_count
      };

      // Rebuild in-memory search index
      for (const section of store.sections) {
        if (section.depth === 0) {
          updateSearchIndex(store.searchIndex!, section);
        }
      }

      this.stores.set(row.id, store);
      loadedStores++;
      loadedSections += sectionRows.length;
    }

    // Load active sessions
    const sessionRows = this.db.listSessions();
    for (const row of sessionRows) {
      if (!row.ended_at) {
        const session: RLMSession = {
          id: row.id,
          storeId: row.store_id,
          instanceId: row.instance_id,
          queries: row.queries_json ? JSON.parse(row.queries_json) : [],
          recursiveCalls: row.recursive_calls_json
            ? JSON.parse(row.recursive_calls_json)
            : [],
          totalRootTokens: row.total_root_tokens,
          totalSubQueryTokens: row.total_sub_query_tokens,
          estimatedDirectTokens: row.estimated_direct_tokens,
          tokenSavingsPercent: row.token_savings_percent,
          startedAt: row.started_at,
          lastActivityAt: row.last_activity_at
        };
        this.sessions.set(row.id, session);
      }
    }

    this.emit('persistence:loaded', {
      storeCount: loadedStores,
      sectionCount: loadedSections
    });
  }

  private rowToSection(row: ContextSectionRow): ContextSection {
    const content = this.db ? this.db.getSectionContent(row) : '';

    return {
      id: row.id,
      type: row.type as ContextSection['type'],
      name: row.name,
      content,
      tokens: row.tokens,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      checksum: row.checksum || '',
      depth: row.depth,
      filePath: row.file_path || undefined,
      language: row.language || undefined,
      sourceUrl: row.source_url || undefined,
      summarizes: row.summarizes_json
        ? JSON.parse(row.summarizes_json)
        : undefined,
      parentSummaryId: row.parent_summary_id || undefined
    };
  }

  // ============ Configuration ============

  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled && this.db !== null;
  }

  getDatabaseStats(): ReturnType<RLMDatabase['getStats']> | null {
    return this.db?.getStats() || null;
  }

  configure(config: Partial<RLMConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): RLMConfig {
    return { ...this.config };
  }

  // ============ Store Management ============

  createStore(instanceId: string): ContextStore {
    const store = createStoreOp(instanceId, this.stores, this.getStorageDeps());
    this.emit('store:created', store);
    return store;
  }

  addSection(
    storeId: string,
    type: ContextSection['type'],
    name: string,
    content: string,
    metadata?: Partial<ContextSection>
  ): ContextSection {
    const store = this.stores.get(storeId);
    if (!store) throw new Error(`Store not found: ${storeId}`);

    const section = addSectionOp(
      store,
      type,
      name,
      content,
      metadata,
      this.getStorageDeps()
    );

    this.emit('section:added', { store, section });
    return section;
  }

  async addSectionsBatch(
    storeId: string,
    sections: SectionInput[]
  ): Promise<string[]> {
    const store = this.stores.get(storeId);
    if (!store) throw new Error(`Store not found: ${storeId}`);

    const ids = await addSectionsBatchOp(
      store,
      sections,
      this.getStorageDeps()
    );

    this.emit('sections:batch_added', { storeId, count: sections.length, ids });
    return ids;
  }

  // ============ Query Engine ============

  async startSession(storeId: string, instanceId: string): Promise<RLMSession> {
    const store = this.stores.get(storeId);
    if (!store) throw new Error(`Store not found: ${storeId}`);

    const session = startSessionOp(
      store,
      instanceId,
      this.sessions,
      this.getSessionDeps()
    );

    this.emit('session:started', session);
    return session;
  }

  async executeQuery(
    sessionId: string,
    query: ContextQuery,
    depth = 0
  ): Promise<ContextQueryResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const store = this.stores.get(session.storeId);
    if (!store) throw new Error(`Store not found: ${session.storeId}`);

    store.lastAccessed = Date.now();
    store.accessCount++;
    session.lastActivityAt = Date.now();

    const queryResult = await executeQueryOp(
      session,
      store,
      query,
      depth,
      this.getQueryEngineDeps()
    );

    // Update session token tracking
    updateSessionTokens(session, queryResult.tokensUsed, depth);
    session.queries.push(queryResult);

    // Persist session updates
    updateSessionAfterQuery(session, store, this.getSessionDeps());

    this.emit('query:executed', { session, queryResult });
    return queryResult;
  }

  // ============ Search Operations ============

  getSectionContentLazy(storeId: string, sectionId: string): string {
    const store = this.stores.get(storeId);
    if (!store) return '';

    const section = store.sections.find((s) => s.id === sectionId);
    if (!section) return '';

    if (section.content) {
      return section.content;
    }

    if (this.db && this.persistenceEnabled) {
      try {
        const row = this.db.getSection(sectionId);
        if (row) {
          const content = this.db.getSectionContent(row);
          section.content = content;
          return content;
        }
      } catch (error) {
        logger.error('Failed to lazy load section content', error instanceof Error ? error : undefined);
      }
    }

    return '';
  }

  mightContainTerm(storeId: string, term: string): boolean {
    const store = this.stores.get(storeId);
    if (!store) return true;
    return mightContainTerm(store, term);
  }

  rebuildBloomFilter(storeId: string): void {
    const store = this.stores.get(storeId);
    if (!store) return;

    store.bloomFilter = rebuildBloomFilterForStore(store);
    this.emit('bloom_filter:rebuilt', {
      storeId,
      termCount: store.bloomFilter.size
    });
  }

  searchStoreOptimized(
    storeId: string,
    terms: string[],
    maxResults = 10
  ): { result: string; sectionsAccessed: string[] } {
    const store = this.stores.get(storeId);
    if (!store) return { result: '', sectionsAccessed: [] };

    return searchStoreOptimized(
      store,
      terms,
      maxResults,
      this.config.searchWindowSize
    );
  }

  // ============ Queries ============

  getStore(storeId: string): ContextStore | undefined {
    return this.stores.get(storeId);
  }

  getStoreByInstance(instanceId: string): ContextStore | undefined {
    return Array.from(this.stores.values()).find(
      (s) => s.instanceId === instanceId
    );
  }

  listStores(): ContextStore[] {
    return Array.from(this.stores.values());
  }

  getSession(sessionId: string): RLMSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): RLMSession[] {
    return Array.from(this.sessions.values());
  }

  getSessionStats(sessionId: string): RLMSessionStats | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return getSessionStatsOp(session);
  }

  getStoreStats(storeId: string): RLMStoreStats | undefined {
    const store = this.stores.get(storeId);
    if (!store) return undefined;
    return getStoreStatsOp(store);
  }

  // ============ Cleanup ============

  deleteStore(storeId: string): void {
    deleteStoreOp(storeId, this.stores, this.sessions, this.getStorageDeps());
    this.emit('store:deleted', { storeId });
  }

  endSession(sessionId: string): void {
    const session = endSessionOp(sessionId, this.sessions, this.getSessionDeps());
    if (session) {
      this.emit('session:ended', session);
    }
  }

  // ============ Section Management ============

  listSections(storeId: string): ContextSection[] {
    const store = this.stores.get(storeId);
    if (!store) return [];
    return store.sections;
  }

  removeSection(storeId: string, sectionId: string): boolean {
    const store = this.stores.get(storeId);
    if (!store) return false;

    const section = removeSectionOp(store, sectionId, this.getStorageDeps());
    if (section) {
      this.emit('section:removed', { store, section });
      return true;
    }
    return false;
  }

  reloadFromPersistence(): void {
    this.stores.clear();
    this.sessions.clear();
    this.loadFromPersistence();
  }

  getDatabasePath(): string | null {
    return this.db?.getDatabasePath() || null;
  }

  // ============ Vector Store ============

  getVectorStoreStats(): ReturnType<VectorStore['getStats']> | null {
    return this.vectorStore?.getStats() || null;
  }

  async indexStoreForSemanticSearch(
    storeId: string
  ): Promise<{ indexed: number; skipped: number } | null> {
    if (!this.vectorStore) return null;

    const store = this.stores.get(storeId);
    if (!store) return null;

    const sections = store.sections
      .filter((s) => s.depth === 0)
      .map((s) => ({ id: s.id, content: s.content }));

    return this.vectorStore.indexStore(storeId, sections);
  }

  isSemanticSearchAvailable(): boolean {
    return this.vectorStore !== null;
  }

  // ============ LLM Service ============

  async isLLMAvailable(): Promise<boolean> {
    return this.llmService?.isAvailable() || false;
  }

  getLLMStatus(): ReturnType<LLMService['getProviderStatus']> | null {
    return this.llmService?.getProviderStatus() || null;
  }

  configureLLM(config: Parameters<LLMService['configure']>[0]): void {
    this.llmService?.configure(config);
  }

  // ============ Analytics ============

  getTokenSavingsHistory(
    days: number
  ): {
    date: string;
    directTokens: number;
    actualTokens: number;
    savingsPercent: number;
  }[] {
    return getTokenSavingsHistoryOp(days, this.sessions, this.getAnalyticsDeps());
  }

  getQueryStats(
    days: number
  ): {
    type: string;
    count: number;
    avgDuration: number;
    avgTokens: number;
  }[] {
    return getQueryStatsOp(days, this.sessions, this.getAnalyticsDeps());
  }

  getStorageStats(): StorageStats {
    return getStorageStatsOp(this.stores);
  }

  // ============ Import/Export ============

  exportStore(storeId: string): ExportedStore | null {
    const store = this.stores.get(storeId);
    if (!store) return null;
    return exportStoreOp(store);
  }

  importStore(data: ExportedStore, options?: ImportStoreOptions): string {
    const storeId = importStoreOp(
      data,
      options,
      this.stores,
      (store, type, name, content, metadata) =>
        addSectionOp(store, type, name, content, metadata, this.getStorageDeps()),
      { db: this.db, persistenceEnabled: this.persistenceEnabled }
    );

    this.emit('store:imported', {
      storeId,
      sectionCount: data.store.sections.length,
      merged: options?.merge || false
    });

    return storeId;
  }

  // ============ Utilities ============

  private estimateTokens(text: string): number {
    if (this.llmService) {
      return this.llmService.getTokenCounter().countTokens(text);
    }
    return defaultEstimateTokens(text);
  }
}

// Re-export types for backwards compatibility
export type { ExportedStore } from './context';
