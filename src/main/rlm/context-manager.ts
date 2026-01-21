/**
 * RLM Context Manager
 * Based on arXiv:2512.24601 from MIT OASYS Lab
 *
 * Treats context as external environment for programmatic manipulation
 * Achieves 85%+ token savings vs direct context feeding
 *
 * Now with SQLite persistence layer for data durability
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  ContextStore,
  ContextSection,
  ContextQuery,
  ContextQueryResult,
  SearchIndex,
  SummaryIndex,
  RLMSession,
  RLMConfig,
  RecursiveCall,
  TermLocation,
  SummaryLevel,
  RLMStoreStats,
  RLMSessionStats,
  BloomFilter,
} from '../../shared/types/rlm.types';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import { ContextSectionRow } from '../persistence/rlm-database.types';
import { VectorStore, getVectorStore } from './vector-store';
import { LLMService, getLLMService } from './llm-service';

export class RLMContextManager extends EventEmitter {
  private static instance: RLMContextManager;
  private stores: Map<string, ContextStore> = new Map();
  private sessions: Map<string, RLMSession> = new Map();
  private config: RLMConfig;
  private db: RLMDatabase | null = null;
  private vectorStore: VectorStore | null = null;
  private llmService: LLMService | null = null;
  private persistenceEnabled = true;

  private defaultConfig: RLMConfig = {
    maxSectionTokens: 8000,
    summaryThreshold: 50000,
    searchWindowSize: 2000,
    maxRecursionDepth: 3,
    maxSubQueries: 10,
    subQueryTimeout: 30000,
    summaryTargetRatio: 0.2,
    enableCostTracking: true,
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

  /**
   * Initialize database persistence and load existing data
   */
  private initializePersistence(): void {
    try {
      this.db = getRLMDatabase();
      this.vectorStore = getVectorStore();
      this.llmService = getLLMService();
      this.loadFromPersistence();
      this.setupLLMHandlers();
      this.emit('persistence:initialized', { success: true });
    } catch (error) {
      console.error('[RLM] Failed to initialize persistence:', error);
      this.persistenceEnabled = false;
      this.emit('persistence:initialized', { success: false, error });
    }
  }

  /**
   * Setup handlers for LLM-based operations
   */
  private setupLLMHandlers(): void {
    if (!this.llmService) return;

    // Handle summarization requests
    this.on('summarize:request', async (request: {
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
          preserveKeyPoints: true,
        });

        request.callback(summary);
      } catch (error) {
        console.error('[RLM] LLM summarization failed:', error);
        // Fallback handled internally by LLMService
      }
    });

    // Handle sub-query requests
    this.on('sub_query:request', async (request: {
      sessionId: string;
      callId: string;
      prompt: string;
      context: string;
      depth: number;
      callback: (response: string, tokens: { input: number; output: number }) => void;
    }) => {
      try {
        const response = await this.llmService!.subQuery({
          requestId: request.callId,
          prompt: request.prompt,
          context: request.context,
          depth: request.depth,
        });

        const tokens = {
          input: Math.ceil((request.context.length + request.prompt.length) / 4),
          output: Math.ceil(response.length / 4),
        };

        request.callback(response, tokens);
      } catch (error) {
        console.error('[RLM] LLM sub-query failed:', error);
        request.callback('[Sub-query failed]', { input: 0, output: 0 });
      }
    });
  }

  /**
   * Load persisted data into memory on startup
   */
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
        sections: sectionRows.map(s => this.rowToSection(s)),
        totalTokens: row.total_tokens,
        totalSize: row.total_size,
        searchIndex: { terms: new Map(), sectionBoundaries: [], lastRebuilt: Date.now() },
        createdAt: row.created_at,
        lastAccessed: row.last_accessed,
        accessCount: row.access_count,
      };

      // Rebuild in-memory search index
      for (const section of store.sections) {
        if (section.depth === 0) {
          this.updateSearchIndex(store, section);
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
          recursiveCalls: row.recursive_calls_json ? JSON.parse(row.recursive_calls_json) : [],
          totalRootTokens: row.total_root_tokens,
          totalSubQueryTokens: row.total_sub_query_tokens,
          estimatedDirectTokens: row.estimated_direct_tokens,
          tokenSavingsPercent: row.token_savings_percent,
          startedAt: row.started_at,
          lastActivityAt: row.last_activity_at,
        };
        this.sessions.set(row.id, session);
      }
    }

    this.emit('persistence:loaded', { storeCount: loadedStores, sectionCount: loadedSections });
  }

  /**
   * Convert database row to ContextSection
   */
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
      summarizes: row.summarizes_json ? JSON.parse(row.summarizes_json) : undefined,
      parentSummaryId: row.parent_summary_id || undefined,
    };
  }

  /**
   * Check if persistence is available
   */
  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled && this.db !== null;
  }

  /**
   * Get database statistics
   */
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
    // Check if store already exists for this instance
    const existing = this.getStoreByInstance(instanceId);
    if (existing) {
      return existing;
    }

    const store: ContextStore = {
      id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      instanceId,
      sections: [],
      totalTokens: 0,
      totalSize: 0,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
    };

    // Persist to database
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.createStore({
          id: store.id,
          instanceId: store.instanceId,
        });
      } catch (error) {
        console.error('[RLM] Failed to persist store:', error);
      }
    }

    this.stores.set(store.id, store);
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

    const tokens = this.estimateTokens(content);

    // Check if we need to split large sections
    if (tokens > this.config.maxSectionTokens) {
      return this.addLargeSection(store, type, name, content, metadata);
    }

    const section: ContextSection = {
      id: `sec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      name,
      content,
      tokens,
      startOffset: store.totalSize,
      endOffset: store.totalSize + content.length,
      checksum: this.computeChecksum(content),
      depth: 0,
      ...metadata,
    };

    store.sections.push(section);
    store.totalTokens += tokens;
    store.totalSize += content.length;

    // Persist section to database
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.addSection({
          id: section.id,
          storeId,
          type: section.type,
          name: section.name,
          startOffset: section.startOffset,
          endOffset: section.endOffset,
          tokens: section.tokens,
          checksum: section.checksum,
          depth: section.depth,
          summarizes: section.summarizes,
          parentSummaryId: section.parentSummaryId,
          filePath: section.filePath,
          language: section.language,
          sourceUrl: section.sourceUrl,
          content: section.content,
        });
        // Also index the section for search
        this.db.indexSection(storeId, section.id, section.content);
      } catch (error) {
        console.error('[RLM] Failed to persist section:', error);
      }
    }

    // Rebuild search index incrementally (in-memory)
    this.updateSearchIndex(store, section);

    // Add vector for semantic search (async, don't await)
    if (this.vectorStore) {
      this.vectorStore.addSection(storeId, section.id, section.content, {
        type: section.type,
        name: section.name,
        filePath: section.filePath,
        language: section.language,
      }).catch(error => {
        console.error('[RLM] Failed to add vector for section:', error);
      });
    }

    // Check if summarization needed
    if (store.totalTokens > this.config.summaryThreshold) {
      this.prepareSummaryLevel(store);
    }

    this.emit('section:added', { store, section });
    return section;
  }

  private addLargeSection(
    store: ContextStore,
    type: ContextSection['type'],
    name: string,
    content: string,
    metadata?: Partial<ContextSection>
  ): ContextSection {
    // Split by logical boundaries (paragraphs, code blocks, etc.)
    const chunks = this.splitContent(content);
    const sections: ContextSection[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkSection: ContextSection = {
        id: `sec-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 6)}`,
        type,
        name: `${name} (part ${i + 1}/${chunks.length})`,
        content: chunks[i],
        tokens: this.estimateTokens(chunks[i]),
        startOffset: store.totalSize,
        endOffset: store.totalSize + chunks[i].length,
        checksum: this.computeChecksum(chunks[i]),
        depth: 0,
        ...metadata,
      };

      store.sections.push(chunkSection);
      store.totalTokens += chunkSection.tokens;
      store.totalSize += chunks[i].length;

      // Persist each chunk to database
      if (this.db && this.persistenceEnabled) {
        try {
          this.db.addSection({
            id: chunkSection.id,
            storeId: store.id,
            type: chunkSection.type,
            name: chunkSection.name,
            startOffset: chunkSection.startOffset,
            endOffset: chunkSection.endOffset,
            tokens: chunkSection.tokens,
            checksum: chunkSection.checksum,
            depth: chunkSection.depth,
            filePath: chunkSection.filePath,
            language: chunkSection.language,
            sourceUrl: chunkSection.sourceUrl,
            content: chunkSection.content,
          });
          this.db.indexSection(store.id, chunkSection.id, chunkSection.content);
        } catch (error) {
          console.error('[RLM] Failed to persist chunk section:', error);
        }
      }

      // Add vector for semantic search (async, don't await)
      if (this.vectorStore) {
        this.vectorStore.addSection(store.id, chunkSection.id, chunkSection.content, {
          type: chunkSection.type,
          name: chunkSection.name,
          filePath: chunkSection.filePath,
          language: chunkSection.language,
        }).catch(error => {
          console.error('[RLM] Failed to add vector for chunk section:', error);
        });
      }

      this.updateSearchIndex(store, chunkSection);
      sections.push(chunkSection);
    }

    // Return first section as reference
    return sections[0];
  }

  private splitContent(content: string): string[] {
    const maxChunkTokens = this.config.maxSectionTokens;
    const chunks: string[] = [];

    // Try to split by double newlines (paragraphs)
    const paragraphs = content.split(/\n\n+/);
    let currentChunk = '';

    for (const para of paragraphs) {
      const combined = currentChunk + (currentChunk ? '\n\n' : '') + para;
      if (this.estimateTokens(combined) > maxChunkTokens) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = para;
      } else {
        currentChunk = combined;
      }
    }

    if (currentChunk) chunks.push(currentChunk);

    // If still too large, force split
    return chunks.flatMap(chunk => {
      if (this.estimateTokens(chunk) > maxChunkTokens) {
        return this.forceSplit(chunk, maxChunkTokens);
      }
      return [chunk];
    });
  }

  private forceSplit(content: string, maxTokens: number): string[] {
    const chunks: string[] = [];
    const lines = content.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      const combined = currentChunk + (currentChunk ? '\n' : '') + line;
      if (this.estimateTokens(combined) > maxTokens) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = line;
      } else {
        currentChunk = combined;
      }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  // ============ Query Engine (RLM Pattern) ============

  async startSession(storeId: string, instanceId: string): Promise<RLMSession> {
    const store = this.stores.get(storeId);
    if (!store) throw new Error(`Store not found: ${storeId}`);

    const session: RLMSession = {
      id: `rlm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      storeId,
      instanceId,
      queries: [],
      recursiveCalls: [],
      totalRootTokens: 0,
      totalSubQueryTokens: 0,
      estimatedDirectTokens: store.totalTokens,
      tokenSavingsPercent: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    // Persist session to database
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.createSession({
          id: session.id,
          storeId: session.storeId,
          instanceId: session.instanceId,
          estimatedDirectTokens: session.estimatedDirectTokens,
        });
      } catch (error) {
        console.error('[RLM] Failed to persist session:', error);
      }
    }

    this.sessions.set(session.id, session);
    this.emit('session:started', session);
    return session;
  }

  async executeQuery(
    sessionId: string,
    query: ContextQuery,
    depth: number = 0
  ): Promise<ContextQueryResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const store = this.stores.get(session.storeId);
    if (!store) throw new Error(`Store not found: ${session.storeId}`);

    store.lastAccessed = Date.now();
    store.accessCount++;
    session.lastActivityAt = Date.now();

    const startTime = Date.now();
    let result: string;
    let sectionsAccessed: string[] = [];
    let subQueries: ContextQueryResult[] = [];

    switch (query.type) {
      case 'grep':
        ({ result, sectionsAccessed } = this.executeGrep(
          store,
          query.params as { pattern: string; maxResults?: number }
        ));
        break;

      case 'slice':
        ({ result, sectionsAccessed } = this.executeSlice(
          store,
          query.params as { start: number; end: number }
        ));
        break;

      case 'get_section':
        ({ result, sectionsAccessed } = this.getSection(
          store,
          query.params as { sectionId: string }
        ));
        break;

      case 'summarize':
        result = await this.executeSummarize(
          session,
          store,
          query.params as { sectionIds: string[] }
        );
        sectionsAccessed = (query.params as { sectionIds: string[] }).sectionIds;
        break;

      case 'sub_query':
        const subResult = await this.executeSubQuery(
          session,
          store,
          query.params as { prompt: string; contextHints?: string[] },
          depth
        );
        result = subResult.result;
        sectionsAccessed = subResult.sectionsAccessed;
        subQueries = subResult.subQueries || [];
        break;

      case 'semantic_search':
        ({ result, sectionsAccessed } = await this.executeSemanticSearch(
          store,
          query.params as { query: string; topK?: number }
        ));
        break;

      default:
        throw new Error(`Unknown query type: ${query.type}`);
    }

    const tokensUsed = query.type === 'sub_query' ? 0 : this.estimateTokens(result);
    const queryResult: ContextQueryResult = {
      query,
      result,
      tokensUsed,
      sectionsAccessed,
      duration: Date.now() - startTime,
      subQueries,
      depth,
    };

    // Track costs
    if (depth === 0) {
      session.totalRootTokens += tokensUsed;
    } else {
      session.totalSubQueryTokens += tokensUsed;
    }

    const totalUsed = session.totalRootTokens + session.totalSubQueryTokens;
    session.tokenSavingsPercent = Math.max(
      0,
      ((session.estimatedDirectTokens - totalUsed) / session.estimatedDirectTokens) * 100
    );

    session.queries.push(queryResult);

    // Persist session updates
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.updateSession(session.id, {
          totalQueries: session.queries.length,
          totalRootTokens: session.totalRootTokens,
          totalSubQueryTokens: session.totalSubQueryTokens,
          tokenSavingsPercent: session.tokenSavingsPercent,
          queriesJson: JSON.stringify(session.queries),
          recursiveCallsJson: JSON.stringify(session.recursiveCalls),
        });
        // Also update store access stats
        this.db.updateStoreStats(store.id, {
          accessCount: store.accessCount,
        });
      } catch (error) {
        console.error('[RLM] Failed to persist session update:', error);
      }
    }

    this.emit('query:executed', { session, queryResult });

    return queryResult;
  }

  private executeGrep(
    store: ContextStore,
    params: { pattern: string; maxResults?: number }
  ): { result: string; sectionsAccessed: string[] } {
    const { pattern, maxResults = 10 } = params;

    // Validate regex pattern to prevent crashes
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch (error) {
      console.warn('[RLM] Invalid regex pattern, falling back to literal search:', error);
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, 'gi');
    }

    const matches: { section: ContextSection; match: RegExpMatchArray; context: string }[] = [];
    const sectionsAccessed: string[] = [];

    for (const section of store.sections) {
      if (section.depth > 0) continue; // Skip summaries

      const sectionMatches = [...section.content.matchAll(regex)];

      for (const match of sectionMatches) {
        if (matches.length >= maxResults) break;

        // Extract context around match
        const windowSize = this.config.searchWindowSize;
        const start = Math.max(0, match.index! - windowSize);
        const end = Math.min(section.content.length, match.index! + match[0].length + windowSize);
        const context = section.content.slice(start, end);

        matches.push({ section, match, context });
        if (!sectionsAccessed.includes(section.id)) {
          sectionsAccessed.push(section.id);
        }
      }

      if (matches.length >= maxResults) break;
    }

    const result = matches
      .map((m, i) => `[Match ${i + 1}] ${m.section.name} (${m.section.type}):\n...${m.context}...`)
      .join('\n\n---\n\n');

    return { result: result || 'No matches found.', sectionsAccessed };
  }

  private executeSlice(
    store: ContextStore,
    params: { start: number; end: number }
  ): { result: string; sectionsAccessed: string[] } {
    const { start, end } = params;
    const sectionsAccessed: string[] = [];
    let result = '';

    for (const section of store.sections) {
      if (section.depth > 0) continue;
      if (section.endOffset < start) continue;
      if (section.startOffset > end) break;

      const sliceStart = Math.max(0, start - section.startOffset);
      const sliceEnd = Math.min(section.content.length, end - section.startOffset);

      result += section.content.slice(sliceStart, sliceEnd);
      sectionsAccessed.push(section.id);
    }

    return { result, sectionsAccessed };
  }

  private getSection(
    store: ContextStore,
    params: { sectionId: string }
  ): { result: string; sectionsAccessed: string[] } {
    const section = store.sections.find(s => s.id === params.sectionId);
    if (!section) {
      return { result: `Section not found: ${params.sectionId}`, sectionsAccessed: [] };
    }

    return {
      result: `[${section.name}] (${section.tokens} tokens)\n\n${section.content}`,
      sectionsAccessed: [section.id],
    };
  }

  private async executeSummarize(
    session: RLMSession,
    store: ContextStore,
    params: { sectionIds: string[] }
  ): Promise<string> {
    const sections = store.sections.filter(s => params.sectionIds.includes(s.id));
    const content = sections.map(s => `## ${s.name}\n${s.content}`).join('\n\n---\n\n');

    const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
    const targetTokens = Math.ceil(totalTokens * this.config.summaryTargetRatio);

    // Emit event for LLM to summarize
    return new Promise(resolve => {
      let resolved = false;

      this.emit('summarize:request', {
        sessionId: session.id,
        content,
        targetTokens,
        callback: (summary: string) => {
          if (resolved) return;
          resolved = true;

          // Store the summary as a new section
          this.persistSummary(store, summary, params.sectionIds, sections);

          resolve(summary);
        },
      });

      // Fallback if not handled
      setTimeout(() => {
        if (resolved) return;
        resolved = true;

        const fallbackSummary = `[Summary of ${sections.length} sections, ~${totalTokens} tokens → ~${targetTokens} target tokens]\n\nKey content from: ${sections.map(s => s.name).join(', ')}`;

        // Store even the fallback summary
        this.persistSummary(store, fallbackSummary, params.sectionIds, sections);

        resolve(fallbackSummary);
      }, 5000);
    });
  }

  /**
   * Persist a summary as a new section in the store
   */
  private persistSummary(
    store: ContextStore,
    summaryContent: string,
    summarizedSectionIds: string[],
    summarizedSections: ContextSection[]
  ): void {
    try {
      const summaryTokens = this.estimateTokens(summaryContent);

      const summaryDepth = Math.max(1, ...summarizedSections.map(s => s.depth + 1));
      const summarySection: ContextSection = {
        id: `sum-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'summary',
        name: `Summary of ${summarizedSections.length} sections`,
        content: summaryContent,
        tokens: summaryTokens,
        startOffset: store.totalSize,
        endOffset: store.totalSize + summaryContent.length,
        checksum: this.computeChecksum(summaryContent),
        depth: summaryDepth,
        summarizes: summarizedSectionIds,
      };

      store.sections.push(summarySection);
      store.totalTokens += summaryTokens;
      store.totalSize += summaryContent.length;

      // Persist to database
      if (this.db && this.persistenceEnabled) {
        this.db.addSection({
          id: summarySection.id,
          storeId: store.id,
          type: summarySection.type,
          name: summarySection.name,
          startOffset: summarySection.startOffset,
          endOffset: summarySection.endOffset,
          tokens: summarySection.tokens,
          checksum: summarySection.checksum,
          depth: summarySection.depth,
          summarizes: summarySection.summarizes,
          content: summarySection.content,
        });
      }

      // Update summary index
      if (!store.summaryIndex) {
        store.summaryIndex = { levels: [], sectionToSummary: new Map() };
      }
      for (const sectionId of summarizedSectionIds) {
        store.summaryIndex.sectionToSummary.set(sectionId, summarySection.id);
      }

      this.emit('summary:created', { storeId: store.id, section: summarySection });
      console.log(`[RLM] Created summary section ${summarySection.id} for ${summarizedSectionIds.length} sections`);
    } catch (error) {
      console.error('[RLM] Failed to persist summary:', error);
    }
  }

  private async executeSubQuery(
    session: RLMSession,
    store: ContextStore,
    params: { prompt: string; contextHints?: string[] },
    depth: number
  ): Promise<{ result: string; sectionsAccessed: string[]; subQueries?: ContextQueryResult[] }> {
    if (depth >= this.config.maxRecursionDepth) {
      return {
        result: '[Max recursion depth reached. Please refine your query.]',
        sectionsAccessed: [],
      };
    }

    // Build context window from hints or use summaries
    let contextWindow = '';
    let sectionsAccessed: string[] = [];

    if (params.contextHints && params.contextHints.length > 0) {
      // Search for relevant context based on hints
      for (const hint of params.contextHints.slice(0, 3)) {
        const grepResult = this.executeGrep(store, { pattern: hint, maxResults: 3 });
        contextWindow += grepResult.result + '\n\n';
        sectionsAccessed.push(...grepResult.sectionsAccessed);
      }
    } else {
      // Use top-level summaries if available
      const summaries = store.sections.filter(s => s.type === 'summary' && s.depth === 1);
      if (summaries.length > 0) {
        contextWindow = summaries.map(s => s.content).join('\n\n---\n\n');
        sectionsAccessed = summaries.map(s => s.id);
      } else {
        // Fall back to section names overview
        const overview = store.sections
          .filter(s => s.depth === 0)
          .map(s => `- ${s.name} (${s.tokens} tokens, ${s.type})`)
          .join('\n');
        contextWindow = `Available sections:\n${overview}`;
      }
    }

    // Create recursive call record
    const recursiveCall: RecursiveCall = {
      id: `rc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      parentId:
        session.recursiveCalls.length > 0
          ? session.recursiveCalls[session.recursiveCalls.length - 1].id
          : undefined,
      depth: depth + 1,
      prompt: params.prompt,
      contextWindow: contextWindow.slice(0, 2000), // Store sample
      tokens: { input: 0, output: 0 },
      duration: 0,
      status: 'pending',
    };
    session.recursiveCalls.push(recursiveCall);

    // Emit event for recursive LLM call
    return new Promise(resolve => {
      recursiveCall.status = 'running';
      const startTime = Date.now();

      this.emit('sub_query:request', {
        sessionId: session.id,
        callId: recursiveCall.id,
        prompt: params.prompt,
        context: contextWindow,
        depth: depth + 1,
        callback: (response: string, tokens: { input: number; output: number }) => {
          recursiveCall.response = response;
          recursiveCall.tokens = tokens;
          recursiveCall.duration = Date.now() - startTime;
          recursiveCall.status = 'completed';

          session.totalSubQueryTokens += tokens.input + tokens.output;

          resolve({
            result: response,
            sectionsAccessed,
          });
        },
      });

      // Timeout handler
      setTimeout(() => {
        if (recursiveCall.status === 'running') {
          recursiveCall.status = 'failed';
          resolve({
            result: '[Sub-query timed out]',
            sectionsAccessed,
          });
        }
      }, this.config.subQueryTimeout);
    });
  }

  private async executeSemanticSearch(
    store: ContextStore,
    params: { query: string; topK?: number; minSimilarity?: number }
  ): Promise<{ result: string; sectionsAccessed: string[] }> {
    const { query, topK = 5, minSimilarity = 0.5 } = params;

    // Use vector store for semantic search if available
    if (this.vectorStore) {
      try {
        const searchResults = await this.vectorStore.search(store.id, query, {
          topK,
          minSimilarity,
        });

        if (searchResults.length > 0) {
          const sectionsAccessed: string[] = [];
          const matches: string[] = [];

          for (const result of searchResults) {
            const section = store.sections.find(s => s.id === result.entry.sectionId);
            if (section) {
              sectionsAccessed.push(section.id);
              matches.push(
                `[Similarity: ${(result.similarity * 100).toFixed(1)}%] ${section.name} (${section.type}):\n...${result.entry.contentPreview}...`
              );
            }
          }

          return {
            result: matches.join('\n\n---\n\n') || 'No matches found.',
            sectionsAccessed,
          };
        }
      } catch (error) {
        console.error('[RLM] Semantic search failed, falling back to keyword search:', error);
      }
    }

    // Fall back to keyword search if vector store unavailable or returned no results
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3);
    const pattern = keywords.join('|');

    return this.executeGrep(store, { pattern, maxResults: topK });
  }

  // ============ Indexing ============

  private updateSearchIndex(store: ContextStore, section: ContextSection): void {
    if (!store.searchIndex) {
      store.searchIndex = {
        terms: new Map(),
        sectionBoundaries: [],
        lastRebuilt: Date.now(),
      };
    }

    // Simple word tokenization and indexing
    const words = section.content.toLowerCase().match(/\b\w{3,}\b/g) || [];
    const contentLower = section.content.toLowerCase(); // Use lowercase for searching
    let lineNumber = 1;
    let charIndex = 0;

    for (const word of words) {
      const locations = store.searchIndex.terms.get(word) || [];
      // Search in lowercase content to match lowercase word
      const nextIndex = contentLower.indexOf(word, charIndex);

      if (nextIndex >= 0) {
        lineNumber += (section.content.slice(charIndex, nextIndex).match(/\n/g) || []).length;
        const location: TermLocation = {
          sectionId: section.id,
          offset: nextIndex,
          lineNumber,
        };
        locations.push(location);
        store.searchIndex.terms.set(word, locations);
        charIndex = nextIndex + word.length;
      }
    }

    store.searchIndex.sectionBoundaries.push(section.endOffset);
  }

  private prepareSummaryLevel(store: ContextStore): void {
    // Initialize summary index if needed
    if (!store.summaryIndex) {
      store.summaryIndex = {
        levels: [],
        sectionToSummary: new Map(),
      };
    }

    // Group original sections for potential summarization
    // (Actual summarization is lazy - done only when needed)
    const originalSections = store.sections.filter(s => s.depth === 0);
    const groupSize = 10;

    for (let i = 0; i < originalSections.length; i += groupSize) {
      const group = originalSections.slice(i, i + groupSize);
      const groupTokens = group.reduce((sum, s) => sum + s.tokens, 0);

      // Only create placeholder if group is large enough
      if (groupTokens > this.config.maxSectionTokens * 2) {
        const placeholder: ContextSection = {
          id: `summary-placeholder-${Date.now()}-${i}`,
          type: 'summary',
          name: `Summary: ${group[0].name} - ${group[group.length - 1].name}`,
          content: `[Pending summary of ${group.length} sections, ~${groupTokens} tokens]`,
          tokens: 100, // Placeholder estimate
          startOffset: 0,
          endOffset: 0,
          checksum: '',
          summarizes: group.map(s => s.id),
          depth: 1,
        };

        // Track in summary index
        const level: SummaryLevel = {
          depth: 1,
          sections: [placeholder],
          totalTokens: 100,
          compressionRatio: groupTokens / 100,
        };
        store.summaryIndex.levels.push(level);

        for (const s of group) {
          store.summaryIndex.sectionToSummary.set(s.id, placeholder.id);
        }
      }
    }
  }

  // ============ Utilities ============

  private estimateTokens(text: string): number {
    if (this.llmService) {
      return this.llmService.getTokenCounter().countTokens(text);
    }
    // Rough estimate: 1 token ≈ 4 characters for English
    return Math.ceil(text.length / 4);
  }

  private computeChecksum(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
  }

  // ============ Performance Optimizations ============

  /**
   * Simple Bloom Filter implementation for fast negative lookups
   * Uses multiple hash functions to minimize false positives
   */
  private createBloomFilter(expectedItems: number = 10000): BloomFilter {
    const size = Math.max(1000, expectedItems * 10); // ~10 bits per item
    const hashCount = 4;
    return {
      bits: new Uint8Array(Math.ceil(size / 8)),
      size,
      hashCount,
    };
  }

  private bloomAdd(filter: BloomFilter, item: string): void {
    const hashes = this.getBloomHashes(item, filter.hashCount, filter.size);
    for (const hash of hashes) {
      const byteIndex = Math.floor(hash / 8);
      const bitIndex = hash % 8;
      filter.bits[byteIndex] |= (1 << bitIndex);
    }
  }

  private bloomMightContain(filter: BloomFilter, item: string): boolean {
    const hashes = this.getBloomHashes(item, filter.hashCount, filter.size);
    for (const hash of hashes) {
      const byteIndex = Math.floor(hash / 8);
      const bitIndex = hash % 8;
      if (!(filter.bits[byteIndex] & (1 << bitIndex))) {
        return false;
      }
    }
    return true;
  }

  private getBloomHashes(item: string, count: number, size: number): number[] {
    const hashes: number[] = [];
    // Simple hash function using DJB2 with different seeds
    for (let i = 0; i < count; i++) {
      let hash = 5381 + i * 33;
      for (let j = 0; j < item.length; j++) {
        hash = ((hash << 5) + hash) ^ item.charCodeAt(j);
      }
      hashes.push(Math.abs(hash) % size);
    }
    return hashes;
  }

  /**
   * Batch add multiple sections with deferred index rebuild
   * Much faster than adding sections one by one
   */
  async addSectionsBatch(
    storeId: string,
    sections: Array<{
      type: ContextSection['type'];
      name: string;
      content: string;
      metadata?: Partial<ContextSection>;
    }>
  ): Promise<string[]> {
    const store = this.stores.get(storeId);
    if (!store) throw new Error(`Store not found: ${storeId}`);

    const ids: string[] = [];
    const addedSections: ContextSection[] = [];

    // Process all sections without rebuilding index each time
    for (const input of sections) {
      const tokens = this.estimateTokens(input.content);
      const section: ContextSection = {
        id: `sec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: input.type,
        name: input.name,
        content: input.content,
        tokens,
        startOffset: store.totalSize,
        endOffset: store.totalSize + input.content.length,
        checksum: this.computeChecksum(input.content),
        depth: 0,
        ...input.metadata,
      };

      store.sections.push(section);
      store.totalTokens += tokens;
      store.totalSize += input.content.length;
      ids.push(section.id);
      addedSections.push(section);

      // Persist section to database
      if (this.db && this.persistenceEnabled) {
        try {
          this.db.addSection({
            id: section.id,
            storeId,
            type: section.type,
            name: section.name,
            startOffset: section.startOffset,
            endOffset: section.endOffset,
            tokens: section.tokens,
            checksum: section.checksum,
            depth: section.depth,
            filePath: section.filePath,
            language: section.language,
            sourceUrl: section.sourceUrl,
            content: section.content,
          });
        } catch (error) {
          console.error('[RLM] Failed to persist batch section:', error);
        }
      }
    }

    // Rebuild search index once for all sections
    for (const section of addedSections) {
      this.updateSearchIndex(store, section);
    }

    // Batch index sections in database
    if (this.db && this.persistenceEnabled) {
      for (const section of addedSections) {
        try {
          this.db.indexSection(storeId, section.id, section.content);
        } catch (error) {
          console.error('[RLM] Failed to index batch section:', error);
        }
      }
    }

    // Batch generate embeddings for semantic search
    if (this.vectorStore) {
      try {
        await this.vectorStore.indexStore(
          storeId,
          addedSections.map(s => ({ id: s.id, content: s.content }))
        );
      } catch (error) {
        console.error('[RLM] Failed to batch index vectors:', error);
      }
    }

    this.emit('sections:batch_added', { storeId, count: addedSections.length, ids });
    return ids;
  }

  /**
   * Get section content with lazy loading support
   * Content is loaded from DB only when accessed
   */
  getSectionContentLazy(storeId: string, sectionId: string): string {
    const store = this.stores.get(storeId);
    if (!store) return '';

    const section = store.sections.find(s => s.id === sectionId);
    if (!section) return '';

    // If content is already loaded, return it
    if (section.content) {
      return section.content;
    }

    // Load from database if available
    if (this.db && this.persistenceEnabled) {
      try {
        const row = this.db.getSection(sectionId);
        if (row) {
          const content = this.db.getSectionContent(row);
          // Cache the loaded content
          section.content = content;
          return content;
        }
      } catch (error) {
        console.error('[RLM] Failed to lazy load section content:', error);
      }
    }

    return '';
  }

  /**
   * Quick check if a term might exist in the store using bloom filter
   * Returns false if definitely not present, true if possibly present
   */
  mightContainTerm(storeId: string, term: string): boolean {
    const store = this.stores.get(storeId);
    if (!store || !store.bloomFilter) return true; // If no filter, assume might contain

    return this.bloomMightContain(store.bloomFilter, term.toLowerCase());
  }

  /**
   * Rebuild the bloom filter for a store
   */
  rebuildBloomFilter(storeId: string): void {
    const store = this.stores.get(storeId);
    if (!store) return;

    const filter = this.createBloomFilter(store.sections.length * 100);

    for (const section of store.sections) {
      if (section.depth > 0) continue; // Skip summaries
      const words = section.content.toLowerCase().match(/\b\w{3,}\b/g) || [];
      for (const word of words) {
        this.bloomAdd(filter, word);
      }
    }

    store.bloomFilter = filter;
    this.emit('bloom_filter:rebuilt', { storeId, termCount: filter.size });
  }

  /**
   * Optimized search using bloom filter for fast negative lookups
   */
  searchStoreOptimized(
    storeId: string,
    terms: string[],
    maxResults: number = 10
  ): { result: string; sectionsAccessed: string[] } {
    const store = this.stores.get(storeId);
    if (!store) return { result: '', sectionsAccessed: [] };

    // Quick check with bloom filter
    if (store.bloomFilter) {
      const possibleTerms = terms.filter(term =>
        this.bloomMightContain(store.bloomFilter!, term.toLowerCase())
      );

      // If none of the terms might be present, return early
      if (possibleTerms.length === 0) {
        return { result: 'No matches found.', sectionsAccessed: [] };
      }
    }

    // Proceed with actual search
    const pattern = terms.join('|');
    return this.executeGrep(store, { pattern, maxResults });
  }

  // ============ Queries ============

  getStore(storeId: string): ContextStore | undefined {
    return this.stores.get(storeId);
  }

  getStoreByInstance(instanceId: string): ContextStore | undefined {
    return Array.from(this.stores.values()).find(s => s.instanceId === instanceId);
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

    const avgDuration =
      session.queries.length > 0
        ? session.queries.reduce((sum, q) => sum + q.duration, 0) / session.queries.length
        : 0;

    return {
      totalQueries: session.queries.length,
      totalRecursiveCalls: session.recursiveCalls.length,
      rootTokens: session.totalRootTokens,
      subQueryTokens: session.totalSubQueryTokens,
      estimatedSavings: session.tokenSavingsPercent,
      avgQueryDuration: avgDuration,
    };
  }

  getStoreStats(storeId: string): RLMStoreStats | undefined {
    const store = this.stores.get(storeId);
    if (!store) return undefined;

    const originalSections = store.sections.filter(s => s.depth === 0).length;
    const summaries = store.sections.filter(s => s.depth > 0).length;
    const maxDepth = Math.max(0, ...store.sections.map(s => s.depth));

    return {
      sections: store.sections.length,
      originalSections,
      summaries,
      totalTokens: store.totalTokens,
      summaryLevels: maxDepth + 1,
      indexedTerms: store.searchIndex?.terms.size || 0,
    };
  }

  // ============ Cleanup ============

  deleteStore(storeId: string): void {
    // Delete from database first (cascades to sections, search index, sessions)
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.deleteStore(storeId);
      } catch (error) {
        console.error('[RLM] Failed to delete store from database:', error);
      }
    }

    // Clear vectors for this store
    if (this.vectorStore) {
      try {
        this.vectorStore.clearStore(storeId);
      } catch (error) {
        console.error('[RLM] Failed to clear vectors for store:', error);
      }
    }

    this.stores.delete(storeId);
    // Also clean up related sessions from memory
    for (const [sessionId, session] of this.sessions) {
      if (session.storeId === storeId) {
        this.sessions.delete(sessionId);
      }
    }
    this.emit('store:deleted', { storeId });
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Mark session as ended in database
      if (this.db && this.persistenceEnabled) {
        try {
          this.db.endSession(sessionId);
        } catch (error) {
          console.error('[RLM] Failed to end session in database:', error);
        }
      }

      this.emit('session:ended', session);
      this.sessions.delete(sessionId);
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

    const index = store.sections.findIndex(s => s.id === sectionId);
    if (index === -1) return false;

    const section = store.sections[index];

    // Remove from database
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.removeSection(sectionId);
      } catch (error) {
        console.error('[RLM] Failed to remove section from database:', error);
      }
    }

    // Remove from vector store
    if (this.vectorStore) {
      try {
        this.vectorStore.removeSection(sectionId);
      } catch (error) {
        console.error('[RLM] Failed to remove section from vector store:', error);
      }
    }

    store.sections.splice(index, 1);
    store.totalTokens -= section.tokens;

    this.emit('section:removed', { store, section });
    return true;
  }

  /**
   * Force reload data from persistence layer
   */
  reloadFromPersistence(): void {
    this.stores.clear();
    this.sessions.clear();
    this.loadFromPersistence();
  }

  /**
   * Get persistence database path for debugging
   */
  getDatabasePath(): string | null {
    return this.db?.getDatabasePath() || null;
  }

  /**
   * Get vector store statistics
   */
  getVectorStoreStats(): ReturnType<VectorStore['getStats']> | null {
    return this.vectorStore?.getStats() || null;
  }

  /**
   * Index all sections in a store for semantic search
   */
  async indexStoreForSemanticSearch(storeId: string): Promise<{ indexed: number; skipped: number } | null> {
    if (!this.vectorStore) return null;

    const store = this.stores.get(storeId);
    if (!store) return null;

    const sections = store.sections
      .filter(s => s.depth === 0) // Only index original sections, not summaries
      .map(s => ({ id: s.id, content: s.content }));

    return this.vectorStore.indexStore(storeId, sections);
  }

  /**
   * Check if semantic search is available
   */
  isSemanticSearchAvailable(): boolean {
    return this.vectorStore !== null;
  }

  /**
   * Check if LLM service is available for summarization/sub-queries
   */
  async isLLMAvailable(): Promise<boolean> {
    return this.llmService?.isAvailable() || false;
  }

  /**
   * Get LLM service status
   */
  getLLMStatus(): ReturnType<LLMService['getProviderStatus']> | null {
    return this.llmService?.getProviderStatus() || null;
  }

  /**
   * Configure LLM service
   */
  configureLLM(config: Parameters<LLMService['configure']>[0]): void {
    this.llmService?.configure(config);
  }

  // ============================================
  // Analytics Methods
  // ============================================

  /**
   * Get token savings history for analytics
   */
  getTokenSavingsHistory(days: number): {
    date: string;
    directTokens: number;
    actualTokens: number;
    savingsPercent: number;
  }[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const history: Map<string, { direct: number; actual: number }> = new Map();

    const sessionRows = this.db && this.persistenceEnabled ? this.db.listSessions() : [];

    if (sessionRows.length > 0) {
      for (const row of sessionRows) {
        if (row.started_at < cutoff) continue;
        const date = new Date(row.started_at).toISOString().split('T')[0];
        const existing = history.get(date) || { direct: 0, actual: 0 };

        existing.direct += row.estimated_direct_tokens || 0;
        existing.actual += (row.total_root_tokens || 0) + (row.total_sub_query_tokens || 0);
        history.set(date, existing);
      }
    } else {
      for (const session of this.sessions.values()) {
        if (session.startedAt < cutoff) continue;

        const date = new Date(session.startedAt).toISOString().split('T')[0];
        const existing = history.get(date) || { direct: 0, actual: 0 };

        existing.direct += session.estimatedDirectTokens;
        existing.actual += session.totalRootTokens + session.totalSubQueryTokens;
        history.set(date, existing);
      }
    }

    return Array.from(history.entries())
      .map(([date, data]) => ({
        date,
        directTokens: data.direct,
        actualTokens: data.actual,
        savingsPercent: data.direct > 0
          ? ((data.direct - data.actual) / data.direct) * 100
          : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get query statistics for analytics
   */
  getQueryStats(days: number): {
    type: string;
    count: number;
    avgDuration: number;
    avgTokens: number;
  }[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stats: Map<string, { count: number; totalDuration: number; totalTokens: number }> = new Map();

    const sessionRows = this.db && this.persistenceEnabled ? this.db.listSessions() : [];

    if (sessionRows.length > 0) {
      for (const row of sessionRows) {
        if (row.started_at < cutoff) continue;
        if (!row.queries_json) continue;
        const queries = JSON.parse(row.queries_json) as ContextQueryResult[];

        for (const queryResult of queries) {
          const queryType = queryResult.query.type;
          const existing = stats.get(queryType) || { count: 0, totalDuration: 0, totalTokens: 0 };
          existing.count++;
          existing.totalDuration += queryResult.duration || 0;
          existing.totalTokens += queryResult.tokensUsed || 0;
          stats.set(queryType, existing);
        }
      }
    } else {
      for (const session of this.sessions.values()) {
        if (session.startedAt < cutoff) continue;

        for (const queryResult of session.queries) {
          const queryType = queryResult.query.type;
          const existing = stats.get(queryType) || { count: 0, totalDuration: 0, totalTokens: 0 };
          existing.count++;
          existing.totalDuration += queryResult.duration || 0;
          existing.totalTokens += queryResult.tokensUsed || 0;
          stats.set(queryType, existing);
        }
      }
    }

    return Array.from(stats.entries())
      .map(([type, data]) => ({
        type,
        count: data.count,
        avgDuration: data.count > 0 ? data.totalDuration / data.count : 0,
        avgTokens: data.count > 0 ? data.totalTokens / data.count : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get storage statistics for analytics
   */
  getStorageStats(): {
    totalStores: number;
    totalSections: number;
    totalTokens: number;
    totalSizeBytes: number;
    byType: { type: string; count: number; tokens: number }[];
  } {
    let totalSections = 0;
    let totalTokens = 0;
    let totalSize = 0;
    const byType: Map<string, { count: number; tokens: number }> = new Map();

    for (const store of this.stores.values()) {
      for (const section of store.sections) {
        totalSections++;
        totalTokens += section.tokens;
        totalSize += section.content.length;

        const existing = byType.get(section.type) || { count: 0, tokens: 0 };
        existing.count++;
        existing.tokens += section.tokens;
        byType.set(section.type, existing);
      }
    }

    return {
      totalStores: this.stores.size,
      totalSections,
      totalTokens,
      totalSizeBytes: totalSize,
      byType: Array.from(byType.entries())
        .map(([type, data]) => ({ type, ...data }))
        .sort((a, b) => b.tokens - a.tokens),
    };
  }

  // ============================================
  // Export/Import Methods
  // ============================================

  /**
   * Export store to portable format
   */
  exportStore(storeId: string): ExportedStore | null {
    const store = this.stores.get(storeId);
    if (!store) return null;

    return {
      version: '1.0',
      exportedAt: Date.now(),
      store: {
        id: store.id,
        instanceId: store.instanceId,
        sections: store.sections.map(s => ({
          id: s.id,
          type: s.type,
          name: s.name,
          content: s.content,
          tokens: s.tokens,
          startOffset: s.startOffset,
          endOffset: s.endOffset,
          checksum: s.checksum,
          depth: s.depth,
          summarizes: s.summarizes,
          parentSummaryId: s.parentSummaryId,
          filePath: s.filePath,
          language: s.language,
          sourceUrl: s.sourceUrl,
        })),
        totalTokens: store.totalTokens,
        totalSize: store.totalSize,
        createdAt: store.createdAt,
        accessCount: store.accessCount,
      },
    };
  }

  /**
   * Import store from exported format
   */
  importStore(data: ExportedStore, options?: {
    newId?: boolean;
    merge?: boolean;
    targetStoreId?: string;
    instanceId?: string;
  }): string {
    const storeId = options?.newId
      ? `store-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      : options?.targetStoreId || data.store.id;

    if (options?.merge && this.stores.has(storeId)) {
      // Merge into existing store
      const existing = this.stores.get(storeId)!;
      for (const section of data.store.sections) {
        const exists = existing.sections.some(s => s.id === section.id);
        if (!exists) {
          this.addSection(storeId, section.type, section.name, section.content, {
            filePath: section.filePath,
            language: section.language,
            sourceUrl: section.sourceUrl,
          } as Partial<ContextSection>);
        }
      }
      this.emit('store:imported', { storeId, sectionCount: data.store.sections.length, merged: true });
      return storeId;
    }

    // Create new store using the existing createStore method
    const instanceId = options?.instanceId || data.store.instanceId;
    const store = this.createStore(instanceId);

    // If newId was requested, use the generated ID
    // Otherwise, we need to update the store ID
    if (!options?.newId && storeId !== store.id) {
      // Remove the auto-generated store and recreate with correct ID
      this.stores.delete(store.id);

      const newStore: ContextStore = {
        id: storeId,
        instanceId,
        sections: [],
        totalTokens: 0,
        totalSize: 0,
        searchIndex: { terms: new Map(), sectionBoundaries: [], lastRebuilt: Date.now() },
        accessCount: 0,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
      };

      this.stores.set(storeId, newStore);

      // Persist the store
      if (this.db && this.persistenceEnabled) {
        try {
          this.db.createStore({
            id: storeId,
            instanceId,
          });
        } catch (error) {
          console.error('[RLM] Failed to persist imported store:', error);
        }
      }
    }

    const finalStoreId = options?.newId ? store.id : storeId;

    // Add sections
    for (const section of data.store.sections) {
      this.addSection(finalStoreId, section.type, section.name, section.content, {
        filePath: section.filePath,
        language: section.language,
        sourceUrl: section.sourceUrl,
      } as Partial<ContextSection>);
    }

    this.emit('store:imported', { storeId: finalStoreId, sectionCount: data.store.sections.length, merged: false });
    return finalStoreId;
  }
}

// ============================================
// Export/Import Types
// ============================================

export interface ExportedStore {
  version: string;
  exportedAt: number;
  store: {
    id: string;
    instanceId: string;
    sections: Array<{
      id: string;
      type: ContextSection['type'];
      name: string;
      content: string;
      tokens: number;
      startOffset: number;
      endOffset: number;
      checksum: string;
      depth: number;
      summarizes?: string[];
      parentSummaryId?: string;
      filePath?: string;
      language?: string;
      sourceUrl?: string;
    }>;
    totalTokens: number;
    totalSize: number;
    createdAt: number;
    accessCount: number;
  };
}
