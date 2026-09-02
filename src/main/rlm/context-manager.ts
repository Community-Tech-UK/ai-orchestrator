/** Persistent RLM coordinator delegating storage, search, sessions, and analytics. */
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
import { VectorStore, getVectorStore } from './vector-store';
import { LLMService, getLLMService } from './llm-service';
import { HyDEService, getHyDEService } from './hyde-service';
import {
  buildRlmLoadSummary,
  loadPersistedContextState,
  type RlmStoreHydrationState,
} from './context-persistence-loader';
import {
  ContextResidencyController,
  RlmHydrationError,
  type RlmResidencyStats,
} from './context-residency-controller';
import { SemanticVectorDeltaRepair, type SemanticVectorDeltaResult } from './semantic-vector-delta-repair';
import { listSectionFilterMetadataPage, type ContextSectionFilterMetadataPage } from './context-section-filter-metadata';
import type {
  ExportedStore,
  ImportStoreOptions,
  SectionInput,
  StorageStats
} from './context';
import {
  createStore as createStoreOp,
  addSection as addSectionOp,
  addSectionsBatch as addSectionsBatchOp,
  removeSection as removeSectionOp,
  deleteStore as deleteStoreOp,
  type StorageDependencies,
  searchStoreOptimized,
  startSession as startSessionOp,
  endSession as endSessionOp,
  getSessionStats as getSessionStatsOp,
  updateSessionAfterQuery,
  updateSessionTokens,
  type SessionDependencies,
  rebuildBloomFilterForStore,
  mightContainTerm,
  getTokenSavingsHistory as getTokenSavingsHistoryOp,
  getQueryStats as getQueryStatsOp,
  getStorageStats as getStorageStatsOp,
  getStoreStats as getStoreStatsOp,
  type AnalyticsDependencies,
  exportStore as exportStoreOp,
  importStore as importStoreOp,
  executeQuery as executeQueryOp,
  type QueryEngineDependencies,
  estimateTokens as defaultEstimateTokens
} from './context';
const logger = getLogger('RLMContextManager');
export class RLMContextManager extends EventEmitter {
  private static instance: RLMContextManager | null = null;
  private stores = new Map<string, ContextStore>();
  private sessions = new Map<string, RLMSession>();
  private config: RLMConfig;
  private db: RLMDatabase | null = null;
  private vectorStore: VectorStore | null = null;
  private llmService: LLMService | null = null;
  private hydeService: HyDEService | null = null;
  private residencyController: ContextResidencyController | null = null;
  private semanticVectorDeltaRepair: SemanticVectorDeltaRepair | null = null;
  private observabilityGeneration = 0;
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
  static _resetForTesting(): void {
    this.instance?.cancelHotPrewarm();
    this.instance = null;
  }
  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
    this.initializePersistence();
  }
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
  private initializePersistence(): void {
    try {
      this.db = getRLMDatabase();
      this.vectorStore = getVectorStore();
      this.semanticVectorDeltaRepair = new SemanticVectorDeltaRepair(
        this.db,
        this.vectorStore,
        {
          onSummary: (summary, generation) => {
            if (generation === this.observabilityGeneration) {
              this.residencyController?.accountSemanticDelta(summary);
            }
          },
        },
      );
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
          const response = await this.llmService!.subQueryViaAux('subQueryExecution', {
            requestId: request.callId,
            prompt: request.prompt,
            context: request.context,
            depth: request.depth
          });

          const tokens = {
            input: defaultEstimateTokens(request.context) + defaultEstimateTokens(request.prompt),
            output: defaultEstimateTokens(response)
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
    const persisted = loadPersistedContextState(this.db);
    this.stores = persisted.stores;
    this.sessions = persisted.sessions;
    this.residencyController = new ContextResidencyController({
      db: this.db,
      stores: this.stores,
      sessions: this.sessions,
      hydrationStates: persisted.hydrationStates,
      loadStats: persisted.loadStats,
      onStatsChanged: (stats) => this.emit('residency:stats', stats),
    });
    logger.info('RLM persistence load summary', { ...buildRlmLoadSummary(persisted.loadStats) });
    this.emit('persistence:loaded', {
      storeCount: persisted.loadedStores,
      sectionCount:
        persisted.loadStats.residentMetadataSections
        + persisted.loadStats.deferredMetadataSections,
      ...persisted.loadStats,
    });
  }

  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled && this.db !== null;
  }

  getDatabaseStats(): ReturnType<RLMDatabase['getStats']> | null {
    return this.db?.getStats() || null;
  }
  getResidencyStats(): Readonly<RlmResidencyStats> | null {
    return this.residencyController?.getStats() ?? null;
  }
  getStoreHydrationState(
    storeId: string
  ): Readonly<RlmStoreHydrationState> | undefined {
    return this.residencyController?.getHydrationState(storeId);
  }
  startHotPrewarm(): boolean { return this.residencyController?.startHotPrewarm() ?? false; }
  cancelHotPrewarm(): boolean { return this.residencyController?.cancelHotPrewarm() ?? false; }

  configure(config: Partial<RLMConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): RLMConfig {
    return { ...this.config };
  }

  createStore(instanceId: string, config?: Record<string, unknown>): ContextStore {
    const store = createStoreOp(instanceId, this.stores, this.getStorageDeps(), config);
    this.residencyController?.registerRuntimeStore(store);
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
    this.residencyController?.requireContent(storeId);
    const previousSectionCount = store.sections.length;
    const section = addSectionOp(
      store,
      type,
      name,
      content,
      metadata,
      this.getStorageDeps()
    );
    this.residencyController?.accountSectionsAdded(
      storeId,
      store.sections.slice(previousSectionCount),
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

    this.residencyController?.requireContent(storeId);
    const previousSectionCount = store.sections.length;

    const ids = await addSectionsBatchOp(
      store,
      sections,
      this.getStorageDeps()
    );

    this.residencyController?.accountSectionsAdded(
      storeId,
      store.sections.slice(previousSectionCount),
    );

    this.emit('sections:batch_added', { storeId, count: sections.length, ids });
    return ids;
  }

  async startSession(storeId: string, instanceId: string): Promise<RLMSession> {
    const store = this.stores.get(storeId);
    if (!store) throw new Error(`Store not found: ${storeId}`);

    const session = startSessionOp(
      store,
      instanceId,
      this.sessions,
      this.getSessionDeps()
    );
    this.residencyController?.syncActiveSessions();

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

    if (query.type === 'semantic_search') {
      this.residencyController?.requireMetadata(store.id);
    } else {
      this.residencyController?.requireContent(store.id);
    }

    store.lastAccessed = Date.now();
    store.accessCount++;
    session.lastActivityAt = Date.now();
    this.residencyController?.markAccessed(store.id, store.lastAccessed);

    // Block the first semantic query until this store's lazy index is ready.
    if (query.type === 'semantic_search') {
      await this.ensureStoreIndexedForSemanticSearch(store.id);
    }

    let queryResult = await executeQueryOp(
      session,
      store,
      query,
      depth,
      this.getQueryEngineDeps()
    );

    // Vector matches need section metadata but not resident payloads. If the
    // semantic engine produced no mapped hit, hydrate only then and rerun so
    // its lexical fallback preserves the existing query contract.
    const residency = this.residencyController;
    if (
      query.type === 'semantic_search'
      && queryResult.sectionsAccessed.length === 0
      && residency
      && residency.getHydrationState(store.id)?.content !== 'resident'
    ) {
      residency.requireContent(store.id);
      queryResult = await executeQueryOp(
        session,
        store,
        query,
        depth,
        this.getQueryEngineDeps()
      );
    }

    updateSessionTokens(session, queryResult.tokensUsed, depth);
    session.queries.push(queryResult);

    updateSessionAfterQuery(session, store, this.getSessionDeps());

    this.emit('query:executed', { session, queryResult });
    return queryResult;
  }

  getSectionContentLazy(storeId: string, sectionId: string): string {
    const store = this.stores.get(storeId);
    if (!store) return '';

    this.residencyController?.ensureMetadata(storeId);

    const section = store.sections.find((s) => s.id === sectionId);
    if (section?.content) {
      return section.content;
    }

    if (this.db && this.persistenceEnabled) {
      try {
        const row = this.db.getSection(sectionId);
        if (row?.store_id === storeId) {
          const content = this.db.getSectionContent(row);
          if (
            section
            && this.residencyController?.getHydrationState(storeId)?.content === 'resident'
          ) {
            section.content = content;
            // Content changed after a prior optimized search may have built a
            // Bloom filter over the empty placeholder. Rebuild lazily next use.
            store.bloomFilter = undefined;
          }
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

    this.residencyController?.requireContent(storeId);

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

    this.residencyController?.requireContent(storeId);

    return searchStoreOptimized(
      store,
      terms,
      maxResults,
      this.config.searchWindowSize
    );
  }

  getStore(storeId: string): ContextStore | undefined {
    if (this.stores.has(storeId)) this.residencyController?.requireMetadata(storeId);
    return this.stores.get(storeId);
  }

  getStoreByInstance(instanceId: string): ContextStore | undefined {
    const store = Array.from(this.stores.values()).find(
      (s) => s.instanceId === instanceId
    );
    if (store) this.residencyController?.requireMetadata(store.id);
    return store;
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
    this.residencyController?.requireMetadata(storeId);
    return getStoreStatsOp(store);
  }

  deleteStore(storeId: string): void {
    this.residencyController?.unregisterStore(storeId);
    deleteStoreOp(storeId, this.stores, this.sessions, this.getStorageDeps());
    this.residencyController?.syncActiveSessions();
    this.emit('store:deleted', { storeId });
  }

  endSession(sessionId: string): void {
    const session = endSessionOp(sessionId, this.sessions, this.getSessionDeps());
    if (session) {
      this.residencyController?.syncActiveSessions();
      this.emit('session:ended', session);
    }
  }

  listSections(storeId: string): ContextSection[] {
    const store = this.stores.get(storeId);
    if (!store) return [];
    this.residencyController?.requireMetadata(storeId);
    return store.sections;
  }

  listSectionFilterMetadata(storeId: string, offset: number, limit: number): ContextSectionFilterMetadataPage {
    return listSectionFilterMetadataPage(this.stores.get(storeId), this.db, this.persistenceEnabled, offset, limit);
  }

  removeSection(storeId: string, sectionId: string): boolean {
    const store = this.stores.get(storeId);
    if (!store) return false;

    this.residencyController?.requireMetadata(storeId);

    const section = removeSectionOp(store, sectionId, this.getStorageDeps());
    if (section) {
      this.residencyController?.accountSectionRemoved(storeId, section);
      this.emit('section:removed', { store, section });
      return true;
    }
    return false;
  }

  reloadFromPersistence(): void {
    this.cancelHotPrewarm();
    this.observabilityGeneration += 1;
    this.semanticVectorDeltaRepair?.invalidateForReload();
    this.residencyController?.clear();
    this.residencyController = null;
    this.stores.clear();
    this.sessions.clear();
    this.loadFromPersistence();
  }

  getDatabasePath(): string | null {
    return this.db?.getDatabasePath() || null;
  }

  getVectorStoreStats(): ReturnType<VectorStore['getStats']> | null {
    return this.vectorStore?.getStats() || null;
  }

  async indexStoreForSemanticSearch(
    storeId: string
  ): Promise<SemanticVectorDeltaResult | null> {
    if (!this.semanticVectorDeltaRepair || !this.stores.has(storeId)) return null;
    const hydration = this.residencyController?.getHydrationState(storeId);
    if (hydration && !hydration.contentEligible) {
      throw new RlmHydrationError(storeId, 'content-ineligible');
    }
    return this.semanticVectorDeltaRepair.repairStore(storeId);
  }

  isSemanticSearchAvailable(): boolean {
    return this.vectorStore !== null;
  }

  /** Repair durable vector gaps before semantic search; concurrent calls deduplicate. */
  private ensureStoreIndexedForSemanticSearch(
    storeId: string
  ): Promise<SemanticVectorDeltaResult> | null {
    if (!this.semanticVectorDeltaRepair) return null;

    return this.indexStoreForSemanticSearch(storeId)
      .then((result) => {
        const outcome = result ?? { missing: 0, indexed: 0, skipped: 0, failed: 0, retried: 0 };
        if (outcome.indexed > 0) {
          logger.info('Lazily indexed context store for semantic_search (LT-055)', {
            indexed: outcome.indexed,
            skipped: outcome.skipped,
          });
        }
        return outcome;
      })
      .catch((error: unknown) => {
        logger.warn('Lazy semantic-search indexing failed; this query will fall back to keyword search', {
          failed: 1,
        });
        void error;
        return { missing: 0, indexed: 0, skipped: 0, failed: 0, retried: 0 };
      });
  }

  async isLLMAvailable(): Promise<boolean> {
    return this.llmService?.isAvailable() || false;
  }

  getLLMStatus(): ReturnType<LLMService['getProviderStatus']> | null {
    return this.llmService?.getProviderStatus() || null;
  }

  configureLLM(config: Parameters<LLMService['configure']>[0]): void {
    this.llmService?.configure(config);
  }

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
    const storage = this.residencyController?.getStorageStats() ?? getStorageStatsOp(this.stores);
    const residency = this.getResidencyStats();
    return residency ? { ...storage, residency } : storage;
  }

  exportStore(storeId: string): ExportedStore | null {
    const store = this.stores.get(storeId);
    if (!store) return null;
    this.residencyController?.requireContent(storeId);
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
    const importedStore = this.stores.get(storeId);
    if (importedStore) this.residencyController?.registerRuntimeStore(importedStore);

    this.emit('store:imported', {
      storeId,
      sectionCount: data.store.sections.length,
      merged: options?.merge || false
    });

    return storeId;
  }

  private estimateTokens(text: string): number {
    if (this.llmService) {
      return this.llmService.getTokenCounter().countTokens(text);
    }
    return defaultEstimateTokens(text);
  }
}

export function getRLMContextManager(): RLMContextManager {
  return RLMContextManager.getInstance();
}

export type { ExportedStore } from './context';
