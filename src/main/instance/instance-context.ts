/**
 * Instance Context Manager - RLM and Unified Memory context building
 *
 * Enhanced with Just-in-Time context loading for efficient resource management.
 */

import { RLMContextManager } from '../rlm/context-manager';
import { getLogger } from '../logging/logger';
import { getUnifiedMemory } from '../memory';
import { getSettingsManager } from '../core/config/settings-manager';
import {
  JITContextLoader,
  getJITLoader,
  ResourceIdentifier,
  LoadedResource,
  FileSystemLoader,
  MemoryStoreLoader,
} from '../context/jit-loader';
import type {
  ContextQuery,
  ContextSection,
  ContextStore
} from '../../shared/types/rlm.types';
import type {
  MemoryType,
  UnifiedRetrievalResult
} from '../../shared/types/unified-memory.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  RlmContextInfo,
  ContextBudget,
  RankedSection,
  UnifiedMemoryContextInfo
} from './instance-types';

const logger = getLogger('InstanceContext');

/**
 * Configuration for context building
 */
export interface ContextConfig {
  rlmContextMinChars: number;
  rlmContextMaxTokens: number;
  rlmContextTopK: number;
  rlmContextMinSimilarity: number;
  rlmQueryTimeoutMs: number;
  contextBudgetMinTokens: number;
  contextBudgetMaxTokens: number;
  rlmHybridSemanticWeight: number;
  rlmHybridLexicalWeight: number;
  rlmHybridOverlapBoost: number;
  rlmSectionSummaryMinTokens: number;
  rlmSectionMinTokens: number;
  rlmSectionMaxCount: number;
  toolOutputSummaryMinTokens: number;
  unifiedMemoryMinChars: number;
  unifiedMemoryContextMinChars: number;
  unifiedMemoryContextMaxTokens: number;
  unifiedMemoryQueryTimeoutMs: number;
}

/**
 * Default context configuration - tuned for better context retention
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  rlmContextMinChars: 50,
  rlmContextMaxTokens: 2000,
  rlmContextTopK: 8,
  rlmContextMinSimilarity: 0.5,
  rlmQueryTimeoutMs: 1500,
  contextBudgetMinTokens: 500,
  contextBudgetMaxTokens: 4000,
  rlmHybridSemanticWeight: 0.7,
  rlmHybridLexicalWeight: 0.3,
  rlmHybridOverlapBoost: 0.15,
  rlmSectionSummaryMinTokens: 400,
  rlmSectionMinTokens: 80,
  rlmSectionMaxCount: 10,
  toolOutputSummaryMinTokens: 500,
  unifiedMemoryMinChars: 30,
  unifiedMemoryContextMinChars: 40,
  unifiedMemoryContextMaxTokens: 1000,
  unifiedMemoryQueryTimeoutMs: 1000
};

export class InstanceContextManager {
  private rlm: RLMContextManager;
  private unifiedMemory = getUnifiedMemory();
  private settings = getSettingsManager();
  private config: ContextConfig;
  private jitLoader: JITContextLoader;

  // Instance to RLM store/session mappings
  private instanceRlmStores = new Map<string, string>();
  private instanceRlmSessions = new Map<string, string>();

  // Instance to registered JIT resources
  private instanceResources = new Map<string, Set<string>>();

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
    this.rlm = RLMContextManager.getInstance();
    this.jitLoader = getJITLoader();
    this.initializeJITLoaders();
  }

  /**
   * Initialize default JIT loaders
   */
  private initializeJITLoaders(): void {
    // Register file system loader
    this.jitLoader.registerLoader('file', new FileSystemLoader());

    // Register memory loader (integrates with unified memory)
    this.jitLoader.registerLoader('memory', new MemoryStoreLoader(
      async (query: string) => {
        const result = await this.unifiedMemory.retrieve(query, 'jit-load', {
          types: ['long_term', 'procedural'],
          maxTokens: 2000,
        });
        if (!result) return null;
        const parts: string[] = [];
        if (result.procedural.length > 0) {
          parts.push(...result.procedural);
        }
        if (result.longTerm.length > 0) {
          parts.push(...result.longTerm);
        }
        return parts.length > 0 ? parts.join('\n') : null;
      }
    ));
  }

  // ============================================
  // RLM Store/Session Management
  // ============================================

  /**
   * Initialize RLM store and session for an instance
   */
  async initializeRlm(instance: Instance): Promise<void> {
    try {
      const rlmStore = this.rlm.createStore(instance.sessionId);
      this.instanceRlmStores.set(instance.id, rlmStore.id);
      logger.info('Created RLM store for session', { storeId: rlmStore.id, sessionId: instance.sessionId });

      const rlmSession = await this.rlm.startSession(
        rlmStore.id,
        instance.sessionId
      );
      this.instanceRlmSessions.set(instance.id, rlmSession.id);
      logger.info('Started RLM session', { rlmSessionId: rlmSession.id, sessionId: instance.sessionId });
    } catch (error) {
      logger.error('Failed to initialize RLM for instance', error instanceof Error ? error : undefined);
    }
  }

  /**
   * End RLM session for an instance
   */
  endRlmSession(instanceId: string): void {
    const rlmSessionId = this.instanceRlmSessions.get(instanceId);
    if (rlmSessionId) {
      try {
        this.rlm.endSession(rlmSessionId);
        logger.info('Ended RLM session', { rlmSessionId, instanceId });
      } catch (error) {
        logger.error('Failed to end RLM session', error instanceof Error ? error : undefined, { instanceId });
      }
      this.instanceRlmSessions.delete(instanceId);
    }
    this.instanceRlmStores.delete(instanceId);
  }

  /**
   * Get RLM store ID for an instance
   */
  getRlmStoreId(instanceId: string): string | undefined {
    return this.instanceRlmStores.get(instanceId);
  }

  /**
   * Get RLM session ID for an instance
   */
  getRlmSessionId(instanceId: string): string | undefined {
    return this.instanceRlmSessions.get(instanceId);
  }

  /**
   * Compact context for an instance by summarizing older messages.
   * This is called when context overflow is detected.
   *
   * Strategy:
   * 1. Summarize older sections in the RLM store
   * 2. Clear JIT cache for this instance
   * 3. Trim the instance's output buffer to only recent messages
   *
   * @param instanceId The instance to compact
   * @param instance The instance object (for buffer access)
   */
  async compactContext(instanceId: string, instance: Instance): Promise<void> {
    logger.info('Starting context compaction', { instanceId });

    const rlmSessionId = this.instanceRlmSessions.get(instanceId);
    const rlmStoreId = this.instanceRlmStores.get(instanceId);

    // 1. Summarize older RLM sections if available
    if (rlmSessionId && rlmStoreId) {
      try {
        const store = this.rlm.getStore(rlmStoreId);
        if (store && store.sections.length > 20) {
          // Get IDs of older sections to summarize (all but last 20)
          const sectionsToSummarize = store.sections
            .slice(0, -20)
            .filter(s => s.type !== 'summary') // Don't re-summarize summaries
            .map(s => s.id);

          if (sectionsToSummarize.length > 0) {
            const query: ContextQuery = {
              type: 'summarize',
              params: {
                sectionIds: sectionsToSummarize
              }
            };
            await this.rlm.executeQuery(rlmSessionId, query);
            logger.info('Summarized RLM sections during compaction', { instanceId, sectionCount: sectionsToSummarize.length });
          }
        }
      } catch (error) {
        logger.warn('RLM summarization failed during compaction, continuing', { instanceId });
        // Continue with other compaction strategies
      }
    }

    // 2. Clear JIT cache for this instance
    this.cleanupInstanceJIT(instanceId);
    logger.info('JIT cache cleared during compaction', { instanceId });

    // 3. Trim the output buffer to keep only recent messages
    const maxRecentMessages = 50; // Keep last 50 messages
    if (instance.outputBuffer.length > maxRecentMessages) {
      const trimCount = instance.outputBuffer.length - maxRecentMessages;
      logger.info('Trimming older messages from buffer during compaction', { instanceId, trimCount });

      // Keep only the most recent messages
      instance.outputBuffer = instance.outputBuffer.slice(-maxRecentMessages);
    }

    logger.info('Context compaction complete', { instanceId });
  }

  // ============================================
  // Context Budget Calculation
  // ============================================

  /**
   * Calculate context budget based on instance state
   */
  calculateContextBudget(instance: Instance, message: string): ContextBudget {
    const usagePct = instance.contextUsage?.percentage ?? 0;
    const isChildInstance = !!instance.parentId;

    // Skip context injection entirely when context is critically high
    const criticalThreshold = isChildInstance ? 95 : 90;
    if (usagePct >= criticalThreshold) {
      logger.info('Skipping context injection due to high usage', { usagePct });
      return {
        totalTokens: 0,
        rlmMaxTokens: 0,
        unifiedMaxTokens: 0,
        rlmTopK: 0
      };
    }

    const messageTokens = this.estimateTokens(message);

    // Child instances get a higher base budget since they start with less context
    const budgetMultiplier = isChildInstance ? 1.5 : 1.0;
    const baseBudget = Math.round(
      Math.min(
        this.config.contextBudgetMaxTokens * budgetMultiplier,
        Math.max(this.config.contextBudgetMinTokens, messageTokens * 1.5)
      )
    );

    // Context scaling - child instances maintain full budget longer
    let usageMultiplier: number;
    if (isChildInstance) {
      usageMultiplier =
        usagePct >= 90
          ? 0.5
          : usagePct >= 85
            ? 0.7
            : usagePct >= 80
              ? 0.85
              : 1;
    } else {
      usageMultiplier =
        usagePct >= 85
          ? 0.4
          : usagePct >= 75
            ? 0.6
            : usagePct >= 65
              ? 0.75
              : usagePct >= 55
                ? 0.9
                : 1;
    }

    const totalTokens = Math.max(
      this.config.contextBudgetMinTokens,
      Math.round(baseBudget * usageMultiplier)
    );

    if (totalTokens < 50) {
      return {
        totalTokens: 0,
        rlmMaxTokens: 0,
        unifiedMaxTokens: 0,
        rlmTopK: 0
      };
    }

    const rlmShare =
      messageTokens > 350 ? 0.45 : messageTokens > 150 ? 0.55 : 0.65;
    let rlmMaxTokens = Math.min(
      this.config.rlmContextMaxTokens,
      Math.round(totalTokens * rlmShare)
    );
    let unifiedMaxTokens = Math.min(
      this.config.unifiedMemoryContextMaxTokens,
      Math.max(0, totalTokens - rlmMaxTokens)
    );

    if (unifiedMaxTokens < this.config.rlmSectionMinTokens) {
      rlmMaxTokens = Math.min(
        this.config.rlmContextMaxTokens,
        rlmMaxTokens + unifiedMaxTokens
      );
      unifiedMaxTokens = 0;
    }

    const rlmTopK = Math.max(
      1,
      Math.min(this.config.rlmSectionMaxCount, Math.round(rlmMaxTokens / 150))
    );

    return {
      totalTokens,
      rlmMaxTokens,
      unifiedMaxTokens,
      rlmTopK
    };
  }

  // ============================================
  // RLM Context Building
  // ============================================

  /**
   * Build RLM context for a message
   */
  async buildRlmContext(
    instanceId: string,
    message: string,
    maxTokens: number = this.config.rlmContextMaxTokens,
    topK: number = this.config.rlmContextTopK
  ): Promise<RlmContextInfo | null> {
    if (message.trim().length < this.config.rlmContextMinChars) return null;

    const sessionId = this.instanceRlmSessions.get(instanceId);
    const storeId = this.instanceRlmStores.get(instanceId);
    if (!sessionId || !storeId) return null;

    const store = this.rlm.getStore(storeId);
    if (!store) return null;

    const semanticQuery: ContextQuery = {
      type: 'semantic_search',
      params: {
        query: message,
        topK,
        minSimilarity: this.config.rlmContextMinSimilarity
      }
    };

    const terms = this.extractQueryTerms(message);
    const lexicalPattern =
      terms.length > 0 ? this.buildLexicalPattern(terms) : '';
    const lexicalQuery: ContextQuery | null = lexicalPattern
      ? {
          type: 'grep',
          params: {
            pattern: lexicalPattern,
            maxResults: Math.max(2, topK)
          }
        }
      : null;

    const startTime = Date.now();

    try {
      const [semanticResult, lexicalResult] = await Promise.all([
        this.withTimeout(
          this.rlm.executeQuery(sessionId, semanticQuery),
          this.config.rlmQueryTimeoutMs
        ),
        lexicalQuery
          ? this.withTimeout(
              this.rlm.executeQuery(sessionId, lexicalQuery),
              this.config.rlmQueryTimeoutMs
            )
          : Promise.resolve(null)
      ]);

      const semanticIds = semanticResult?.sectionsAccessed ?? [];
      const lexicalIds = lexicalResult?.sectionsAccessed ?? [];
      const candidateIds = new Set<string>([...semanticIds, ...lexicalIds]);

      if (candidateIds.size === 0) {
        return null;
      }

      const ranked = this.rankRlmSections(
        store,
        candidateIds,
        semanticIds,
        lexicalIds,
        topK
      );
      const payload = this.buildRlmContextPayload(
        ranked,
        store,
        Math.min(maxTokens, this.config.rlmContextMaxTokens)
      );

      if (!payload.context) return null;

      return {
        context: payload.context,
        tokens: this.estimateTokens(payload.context),
        sectionsAccessed: payload.sectionIds,
        durationMs: Date.now() - startTime,
        source:
          semanticIds.length > 0 && lexicalIds.length > 0
            ? 'hybrid'
            : semanticIds.length > 0
              ? 'semantic'
              : 'lexical'
      };
    } catch (error) {
      logger.error('Failed to retrieve RLM context', error instanceof Error ? error : undefined, { instanceId });
      return null;
    }
  }

  /**
   * Format RLM context for injection
   */
  formatRlmContextBlock(context: RlmContextInfo | null): string | null {
    if (!context) return null;

    const sourceLabel =
      context.source === 'hybrid'
        ? 'RLM hybrid search'
        : context.source === 'lexical'
          ? 'RLM lexical search'
          : 'RLM semantic search';

    return [
      '[Retrieved Context]',
      `Source: ${sourceLabel}`,
      context.context,
      '[End Retrieved Context]'
    ].join('\n');
  }

  // ============================================
  // Unified Memory Context Building
  // ============================================

  /**
   * Build unified memory context for a message
   */
  async buildUnifiedMemoryContext(
    instance: Instance,
    message: string,
    taskId: string,
    maxTokens: number = this.config.unifiedMemoryContextMaxTokens
  ): Promise<UnifiedMemoryContextInfo | null> {
    if (message.trim().length < this.config.unifiedMemoryContextMinChars) return null;

    const effectiveMaxTokens = Math.min(
      this.config.unifiedMemoryContextMaxTokens,
      maxTokens
    );
    if (effectiveMaxTokens <= 0) return null;

    const types: MemoryType[] = ['procedural', 'long_term'];
    const startTime = Date.now();

    try {
      const result = await this.withTimeout(
        this.unifiedMemory.retrieve(message, taskId, {
          types,
          maxTokens: effectiveMaxTokens,
          sessionId: instance.sessionId,
          instanceId: instance.id
        }),
        this.config.unifiedMemoryQueryTimeoutMs
      );

      if (!result) return null;

      const contextPayload = this.formatUnifiedMemoryPayload(result);
      if (!contextPayload) return null;

      const trimmed = this.trimToTokens(contextPayload, effectiveMaxTokens);
      if (!trimmed) return null;

      return {
        context: trimmed,
        tokens: this.estimateTokens(trimmed),
        longTermCount: result.longTerm.length,
        proceduralCount: result.procedural.length,
        durationMs: Date.now() - startTime
      };
    } catch (error) {
      logger.error('Failed to retrieve unified memory context', error instanceof Error ? error : undefined, { instanceId: instance.id });
      return null;
    }
  }

  /**
   * Format unified memory context for injection
   */
  formatUnifiedMemoryContextBlock(
    context: UnifiedMemoryContextInfo | null
  ): string | null {
    if (!context) return null;

    return [
      '[Unified Memory Context]',
      'Source: Unified Memory',
      context.context,
      '[End Unified Memory Context]'
    ].join('\n');
  }

  // ============================================
  // RLM Ingestion
  // ============================================

  /**
   * Ingest a message into RLM context store
   */
  ingestToRLM(instanceId: string, message: OutputMessage): void {
    const storeId = this.instanceRlmStores.get(instanceId);
    if (!storeId) return;

    if (!message.content || message.content.trim().length === 0) return;
    if (message.content.length < 20) return;

    try {
      let sectionType:
        | 'conversation'
        | 'tool_output'
        | 'file'
        | 'external'
        | 'summary';
      let sectionName: string;

      switch (message.type) {
        case 'user':
          sectionType = 'conversation';
          sectionName = `User message at ${new Date(message.timestamp).toISOString()}`;
          break;
        case 'assistant':
          sectionType = 'conversation';
          sectionName = `Assistant response at ${new Date(message.timestamp).toISOString()}`;
          break;
        case 'tool_use':
          sectionType = 'tool_output';
          const toolName = message.metadata?.['name'] || 'unknown';
          sectionName = `Tool use: ${toolName}`;
          break;
        case 'tool_result':
          sectionType = 'tool_output';
          sectionName = `Tool result at ${new Date(message.timestamp).toISOString()}`;
          break;
        case 'system':
          return;
        case 'error':
          sectionType = 'external';
          sectionName = `Error at ${new Date(message.timestamp).toISOString()}`;
          break;
        default:
          sectionType = 'external';
          sectionName = `Message at ${new Date(message.timestamp).toISOString()}`;
      }

      const store = this.rlm.getStore(storeId);
      const startOffset = store?.totalSize ?? null;

      const section = this.rlm.addSection(
        storeId,
        sectionType,
        sectionName,
        message.content,
        {
          filePath: message.metadata?.['filePath'] as string | undefined,
          language: message.metadata?.['language'] as string | undefined
        }
      );

      if (sectionType === 'tool_output') {
        const newSections =
          store && startOffset !== null
            ? store.sections.filter((entry) => entry.startOffset >= startOffset)
            : [section];
        this.maybeSummarizeToolOutput(instanceId, store, newSections);
      }
    } catch (error) {
      logger.error('Failed to ingest message into RLM', error instanceof Error ? error : undefined, { instanceId });
    }
  }

  /**
   * Batch ingest initial output buffer into RLM for child instances
   */
  async ingestInitialOutputToRlm(
    instance: Instance,
    messages: OutputMessage[]
  ): Promise<void> {
    try {
      const batchSize = 20;
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        for (const msg of batch) {
          this.ingestToRLM(instance.id, msg);
        }
        if (i + batchSize < messages.length) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      logger.info('Completed ingesting initial messages', { instanceId: instance.id, messageCount: messages.length });
    } catch (error) {
      logger.error('Failed to ingest initial output', error instanceof Error ? error : undefined, { instanceId: instance.id });
    }
  }

  /**
   * Ingest a message into unified memory
   */
  ingestToUnifiedMemory(instance: Instance, message: OutputMessage): void {
    if (!message.content || message.content.trim().length === 0) return;
    if (message.content.length < this.config.unifiedMemoryMinChars) return;
    if (message.type === 'system') return;

    const taggedContent = `[instance:${instance.id}] [session:${instance.sessionId}] [${message.type}] ${message.content}`;

    this.unifiedMemory
      .processInput(taggedContent, instance.sessionId, message.id)
      .catch((error) => {
        logger.error('Failed to ingest message into unified memory', error instanceof Error ? error : undefined, { instanceId: instance.id });
      });
  }

  // ============================================
  // JIT Context Loading
  // ============================================

  /**
   * Register a file for JIT loading
   */
  registerFileResource(
    instanceId: string,
    filePath: string,
    metadata?: { language?: string; estimatedTokens?: number }
  ): string {
    const resourceId = `file:${instanceId}:${filePath}`;
    const identifier: ResourceIdentifier = {
      id: resourceId,
      type: 'file',
      path: filePath,
      metadata: {
        language: metadata?.language,
        estimatedTokens: metadata?.estimatedTokens,
      },
    };

    this.jitLoader.register(identifier);
    this.trackInstanceResource(instanceId, resourceId);

    return resourceId;
  }

  /**
   * Register a URL for JIT loading
   */
  registerUrlResource(
    instanceId: string,
    url: string,
    metadata?: { mimeType?: string; estimatedTokens?: number }
  ): string {
    const resourceId = `url:${instanceId}:${url}`;
    const identifier: ResourceIdentifier = {
      id: resourceId,
      type: 'url',
      path: url,
      metadata: {
        mimeType: metadata?.mimeType,
        estimatedTokens: metadata?.estimatedTokens,
      },
    };

    this.jitLoader.register(identifier);
    this.trackInstanceResource(instanceId, resourceId);

    return resourceId;
  }

  /**
   * Register a memory query for JIT loading
   */
  registerMemoryResource(
    instanceId: string,
    query: string,
    metadata?: { estimatedTokens?: number }
  ): string {
    const resourceId = `memory:${instanceId}:${query.substring(0, 50)}`;
    const identifier: ResourceIdentifier = {
      id: resourceId,
      type: 'memory',
      path: query,
      metadata: {
        estimatedTokens: metadata?.estimatedTokens,
      },
    };

    this.jitLoader.register(identifier);
    this.trackInstanceResource(instanceId, resourceId);

    return resourceId;
  }

  /**
   * Load a resource on demand
   */
  async loadResource(resourceId: string): Promise<LoadedResource | null> {
    return this.jitLoader.load(resourceId);
  }

  /**
   * Load multiple resources in parallel
   */
  async loadResources(resourceIds: string[]): Promise<Map<string, LoadedResource | null>> {
    return this.jitLoader.loadBatch(resourceIds);
  }

  /**
   * Check if a resource is cached
   */
  isResourceCached(resourceId: string): boolean {
    return this.jitLoader.isCached(resourceId);
  }

  /**
   * Prefetch resources that might be needed soon
   */
  async prefetchResources(resourceIds: string[]): Promise<void> {
    return this.jitLoader.prefetch(resourceIds);
  }

  /**
   * Get related resources based on access patterns
   */
  getRelatedResources(resourceId: string, limit = 5): string[] {
    return this.jitLoader.getRelatedResources(resourceId, limit);
  }

  /**
   * Invalidate a cached resource
   */
  invalidateResource(resourceId: string): void {
    this.jitLoader.invalidate(resourceId);
  }

  /**
   * Invalidate all resources for an instance
   */
  invalidateInstanceResources(instanceId: string): void {
    const resources = this.instanceResources.get(instanceId);
    if (resources) {
      this.jitLoader.invalidateBatch(Array.from(resources));
    }
  }

  /**
   * Get JIT loader statistics
   */
  getJITStats(): ReturnType<JITContextLoader['getStats']> {
    return this.jitLoader.getStats();
  }

  /**
   * Build context with JIT-loaded resources
   *
   * This method loads resources on demand and builds context
   * based on relevance to the query.
   */
  async buildJITContext(
    instanceId: string,
    query: string,
    maxTokens = 2000
  ): Promise<{
    context: string | null;
    tokens: number;
    resourcesLoaded: number;
    cacheHits: number;
  }> {
    const resources = this.instanceResources.get(instanceId);
    if (!resources || resources.size === 0) {
      return { context: null, tokens: 0, resourcesLoaded: 0, cacheHits: 0 };
    }

    // Get related resources based on query
    const queryTerms = this.extractQueryTerms(query);
    const resourceIds = Array.from(resources);

    // Score resources by relevance to query
    const scored: { id: string; score: number }[] = [];
    for (const id of resourceIds) {
      const identifier = this.jitLoader.getIdentifier(id);
      if (!identifier) continue;

      // Simple relevance scoring based on path/query overlap
      const pathTerms = this.extractQueryTerms(identifier.path);
      const overlap = this.computeSetOverlap(queryTerms, pathTerms);
      scored.push({ id, score: overlap });
    }

    // Sort by relevance
    scored.sort((a, b) => b.score - a.score);

    // Load top resources within token budget
    const toLoad = scored.slice(0, 10).map(s => s.id);
    const loadedMap = await this.loadResources(toLoad);

    let usedTokens = 0;
    let cacheHits = 0;
    const parts: string[] = [];

    for (const [id, resource] of loadedMap) {
      if (!resource) continue;

      if (usedTokens + resource.tokens > maxTokens) {
        // Truncate last resource if needed
        const remaining = maxTokens - usedTokens;
        if (remaining > 100) {
          const truncated = this.trimToTokens(resource.content, remaining);
          parts.push(`[Resource: ${resource.identifier.path}]\n${truncated}`);
          usedTokens += remaining;
        }
        break;
      }

      parts.push(`[Resource: ${resource.identifier.path}]\n${resource.content}`);
      usedTokens += resource.tokens;

      if (resource.source === 'cache') {
        cacheHits++;
      }
    }

    if (parts.length === 0) {
      return { context: null, tokens: 0, resourcesLoaded: 0, cacheHits: 0 };
    }

    return {
      context: parts.join('\n\n---\n\n'),
      tokens: usedTokens,
      resourcesLoaded: parts.length,
      cacheHits,
    };
  }

  /**
   * Clean up JIT resources for an instance
   */
  cleanupInstanceJIT(instanceId: string): void {
    const resources = this.instanceResources.get(instanceId);
    if (resources) {
      this.jitLoader.invalidateBatch(Array.from(resources));
      this.instanceResources.delete(instanceId);
    }
  }

  /**
   * Track resource registration for an instance
   */
  private trackInstanceResource(instanceId: string, resourceId: string): void {
    let resources = this.instanceResources.get(instanceId);
    if (!resources) {
      resources = new Set();
      this.instanceResources.set(instanceId, resources);
    }
    resources.add(resourceId);
  }

  /**
   * Compute set overlap ratio (Jaccard similarity)
   */
  private computeSetOverlap(set1: string[], set2: string[]): number {
    const s1 = new Set(set1);
    const s2 = new Set(set2);
    let intersection = 0;

    for (const item of s1) {
      if (s2.has(item)) intersection++;
    }

    const union = s1.size + s2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  // ============================================
  // Private Helpers
  // ============================================

  private formatUnifiedMemoryPayload(
    result: UnifiedRetrievalResult
  ): string | null {
    const sections: string[] = [];

    if (result.wakeContext?.trim()) {
      sections.push('Wake Context:');
      sections.push(result.wakeContext.trim());
    }

    if (result.procedural.length > 0) {
      sections.push('Procedural Memory:');
      sections.push(...result.procedural.map((item) => `- ${item}`));
    }

    if (result.longTerm.length > 0) {
      sections.push('Long-term Memory:');
      sections.push(...result.longTerm.map((item) => `- ${item}`));
    }

    if (sections.length === 0) return null;
    return sections.join('\n');
  }

  private extractQueryTerms(message: string): string[] {
    const matches = message.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    const unique = Array.from(
      new Set(matches.filter((term) => term.length >= 4))
    );
    return unique.slice(0, 12);
  }

  private buildLexicalPattern(terms: string[]): string {
    return terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
  }

  private buildRankMap(
    sectionIds: string[],
    topK: number
  ): Map<string, number> {
    const rankMap = new Map<string, number>();
    const denom = Math.max(sectionIds.length, topK, 1);

    sectionIds.forEach((id, index) => {
      const score = Math.max(0.05, (denom - index) / denom);
      rankMap.set(id, score);
    });

    return rankMap;
  }

  private rankRlmSections(
    store: ContextStore,
    candidateIds: Set<string>,
    semanticIds: string[],
    lexicalIds: string[],
    topK: number
  ): RankedSection[] {
    const semanticRank = this.buildRankMap(semanticIds, topK);
    const lexicalRank = this.buildRankMap(lexicalIds, topK);
    const ranked: RankedSection[] = [];

    for (const id of candidateIds) {
      const section = store.sections.find((entry) => entry.id === id);
      if (!section) continue;

      const semanticScore = semanticRank.get(id) ?? 0;
      const lexicalScore = lexicalRank.get(id) ?? 0;
      let score =
        semanticScore * this.config.rlmHybridSemanticWeight +
        lexicalScore * this.config.rlmHybridLexicalWeight;

      if (semanticScore > 0 && lexicalScore > 0) {
        score += this.config.rlmHybridOverlapBoost;
      }

      if (section.type === 'tool_output') {
        score *= 0.85;
      }
      if (section.depth > 0) {
        score *= 0.9;
      }

      ranked.push({ section, score, semanticScore, lexicalScore });
    }

    return ranked.sort((a, b) => b.score - a.score);
  }

  private buildRlmContextPayload(
    ranked: RankedSection[],
    store: ContextStore,
    maxTokens: number
  ): { context: string | null; sectionIds: string[] } {
    if (ranked.length === 0 || maxTokens <= 0) {
      return { context: null, sectionIds: [] };
    }

    const targetCount = Math.min(
      ranked.length,
      Math.max(
        1,
        Math.min(this.config.rlmSectionMaxCount, Math.round(maxTokens / 220))
      )
    );
    const sectionBudget = Math.max(
      this.config.rlmSectionMinTokens,
      Math.floor(maxTokens / targetCount)
    );
    const parts: string[] = [];
    const sectionIds: string[] = [];
    let usedTokens = 0;

    for (let index = 0; index < targetCount; index += 1) {
      if (usedTokens >= maxTokens) break;

      const entry = ranked[index];
      if (!entry) break;

      const { content, usedSummary } = this.selectRlmSectionContent(
        store,
        entry.section,
        sectionBudget
      );
      if (!content) continue;

      const label = usedSummary
        ? `${entry.section.type} summary`
        : entry.section.type;
      const source = entry.section.filePath || entry.section.sourceUrl;
      const header = `[Match ${index + 1}] ${entry.section.name}${source ? ` - ${source}` : ''} (${label})`;
      const block = `${header}\n${content}`;
      const blockTokens = this.estimateTokens(block);

      if (parts.length > 0 && usedTokens + blockTokens > maxTokens) {
        break;
      }

      parts.push(block);
      sectionIds.push(entry.section.id);
      usedTokens += blockTokens;
    }

    if (parts.length === 0) {
      return { context: null, sectionIds: [] };
    }

    return {
      context: this.trimToTokens(parts.join('\n\n---\n\n'), maxTokens),
      sectionIds
    };
  }

  private selectRlmSectionContent(
    store: ContextStore,
    section: ContextSection,
    maxTokens: number
  ): { content: string; usedSummary: boolean } {
    let selected = section;
    let usedSummary = false;
    const summaryId = store.summaryIndex?.sectionToSummary.get(section.id);

    if (summaryId) {
      const summary = store.sections.find((entry) => entry.id === summaryId);
      if (
        summary &&
        summary.tokens < section.tokens &&
        (section.tokens > this.config.rlmSectionSummaryMinTokens ||
          section.tokens > maxTokens)
      ) {
        selected = summary;
        usedSummary = true;
      }
    }

    return {
      content: this.trimToTokens(selected.content, maxTokens),
      usedSummary
    };
  }

  private maybeSummarizeToolOutput(
    instanceId: string,
    store: ContextStore | undefined,
    newSections: ContextSection[]
  ): void {
    if (!store || newSections.length === 0) return;

    const totalTokens = newSections.reduce(
      (sum, section) => sum + section.tokens,
      0
    );
    if (totalTokens < this.config.toolOutputSummaryMinTokens) return;

    const sessionId = this.instanceRlmSessions.get(instanceId);
    if (!sessionId) return;

    const summaryIndex = store.summaryIndex?.sectionToSummary;
    if (
      summaryIndex &&
      newSections.every((section) => summaryIndex.has(section.id))
    ) {
      return;
    }

    const query: ContextQuery = {
      type: 'summarize',
      params: {
        sectionIds: newSections.map((section) => section.id)
      }
    };

    this.rlm.executeQuery(sessionId, query).catch((error) => {
      logger.error('Failed to summarize tool output', error instanceof Error ? error : undefined, { instanceId });
    });
  }

  private trimToTokens(text: string, maxTokens: number): string {
    if (this.estimateTokens(text) <= maxTokens) return text.trim();

    const maxChars = maxTokens * 4;
    return `${text.slice(0, maxChars).trim()}...`;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T | null> {
    type TimeoutResult =
      | { type: 'timeout' }
      | { type: 'value'; value: T }
      | { type: 'error'; error: unknown };

    let timeoutId: NodeJS.Timeout | undefined;

    const timeout = new Promise<TimeoutResult>((resolve) => {
      timeoutId = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
    });

    const guarded: Promise<TimeoutResult> = promise
      .then((value) => ({ type: 'value', value }) as const)
      .catch((error) => ({ type: 'error', error }) as const);

    const result = await Promise.race([guarded, timeout]);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (result.type === 'timeout') {
      return null;
    }

    if (result.type === 'error') {
      throw result.error;
    }

    return result.value as T;
  }
}
