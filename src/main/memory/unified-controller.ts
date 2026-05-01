/**
 * Unified Memory Controller
 * Based on AgeMem pattern (arXiv:2601.01885) for unified long-term and short-term memory
 *
 * Features:
 * - Short-term buffer management with automatic summarization
 * - Long-term storage integration with Memory-R1
 * - Episodic memory for session history
 * - Procedural memory for learned workflows and strategies
 * - Three-stage progressive training support
 */

import { EventEmitter } from 'events';
import { getLLMService } from '../rlm/llm-service';
import { getLogger } from '../logging/logger';
import { getWakeContextBuilder } from './wake-context-builder';

const unifiedLogger = getLogger('UnifiedMemoryController');
const MAX_EPISODIC_SESSIONS = 5000;
const MAX_EPISODIC_PATTERNS = 500;
const MAX_PATTERN_CONTEXTS = 100;
const MEMORY_R1_MUTATION_EVENTS = [
  'entry:added',
  'entry:updated',
  'entry:deleted',
  'state:loaded'
] as const;
import type {
  UnifiedMemoryConfig,
  UnifiedMemoryState,
  SessionMemory,
  LearnedPattern,
  WorkflowMemory,
  StrategyMemory,
  UnifiedMemoryStats,
  UnifiedMemorySnapshot,
  UnifiedRetrievalResult,
  RetrievalOptions,
  SessionOutcome
} from '../../shared/types/unified-memory.types';
import type { MemoryEntry } from '../../shared/types/memory-r1.types';
import {
  MemoryManagerAgent,
  getMemoryManager
} from './r1-memory-manager';
import { RLMContextManager } from '../rlm/context-manager';
import { SkillsLoader, getSkillsLoader } from './skills-loader';
import { getHybridRetrievalManager } from './hybrid-retrieval';
import { getProactiveSurfacer } from './proactive-surfacer';
import { getCrossProjectLearner } from './cross-project-learner';
import { getEpisodicStore } from './episodic-store';
import { getProceduralStore } from './procedural-store';

export class UnifiedMemoryController extends EventEmitter {
  private static instance: UnifiedMemoryController | null = null;
  private config: UnifiedMemoryConfig;
  private state!: UnifiedMemoryState; // Initialized in initializeState()
  private memoryR1: MemoryManagerAgent;
  private rlmContext: RLMContextManager;
  private skillsLoader: SkillsLoader;
  private semanticCache = new Map<
    string,
    { result: UnifiedRetrievalResult; expiresAt: number }
  >();
  private cacheRevision = 0;
  private readonly onMemoryR1Mutation = (): void => {
    this.invalidateSemanticCache('memory-r1-mutation');
  };

  private defaultConfig: UnifiedMemoryConfig = {
    shortTermMaxTokens: 50000,
    shortTermSummarizeAt: 40000,
    longTermMaxEntries: 10000,
    longTermPersistPath: '',
    retrievalBlend: 0.3,
    contextBudgetSplit: {
      shortTerm: 0.6,
      longTerm: 0.3,
      procedural: 0.1
    },
    qualityCostProfile: 'balanced',
    diversityThreshold: 0.35,
    rlmMaxResults: 6,
    semanticCacheMaxEntries: 120,
    semanticCacheTtlMs: 10 * 60 * 1000,
    trainingStage: 1,
    enableGRPO: false
  };

  static getInstance(): UnifiedMemoryController {
    if (!this.instance) {
      this.instance = new UnifiedMemoryController();
      // Initialize ProactiveSurfacer with this controller
      try {
        getProactiveSurfacer().initialize(this.instance);
      } catch {
        // Surfacer is optional — don't block startup
      }
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.cleanup();
      (this as unknown as { instance?: UnifiedMemoryController }).instance = undefined;
    }
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
    this.memoryR1 = getMemoryManager();
    this.rlmContext = RLMContextManager.getInstance();
    this.skillsLoader = getSkillsLoader();
    this.applyQualityCostProfile(this.config.qualityCostProfile);
    this.initializeState();
    this.registerMemoryR1Listeners();
  }

  private registerMemoryR1Listeners(): void {
    for (const eventName of MEMORY_R1_MUTATION_EVENTS) {
      this.memoryR1.on(eventName, this.onMemoryR1Mutation);
    }
  }

  private unregisterMemoryR1Listeners(): void {
    for (const eventName of MEMORY_R1_MUTATION_EVENTS) {
      this.memoryR1.off(eventName, this.onMemoryR1Mutation);
    }
  }

  private cleanup(): void {
    this.unregisterMemoryR1Listeners();
    this.semanticCache.clear();
    this.removeAllListeners();
  }

  private initializeState(): void {
    this.state = {
      shortTerm: {
        buffer: [],
        summaries: [],
        currentTokens: 0
      },
      longTerm: {
        entries: new Map(),
        index: {
          embeddings: new Map(),
          clusters: new Map(),
          lastRebuilt: 0
        }
      },
      episodic: {
        sessions: [],
        patterns: []
      },
      procedural: {
        workflows: [],
        strategies: []
      }
    };
  }

  configure(config: Partial<UnifiedMemoryConfig>): void {
    this.config = { ...this.config, ...config };
    this.applyQualityCostProfile(this.config.qualityCostProfile);
    this.normalizeConfig();
    this.invalidateSemanticCache('config-updated');
  }

  getConfig(): UnifiedMemoryConfig {
    return { ...this.config };
  }

  private applyQualityCostProfile(
    profile?: UnifiedMemoryConfig['qualityCostProfile']
  ): void {
    if (!profile) return;

    switch (profile) {
      case 'quality':
        this.config.retrievalBlend = 0.5;
        this.config.contextBudgetSplit = {
          shortTerm: 0.7,
          longTerm: 0.2,
          procedural: 0.1
        };
        this.config.shortTermSummarizeAt = Math.floor(
          this.config.shortTermMaxTokens * 0.9
        );
        this.config.diversityThreshold = 0.4;
        this.config.rlmMaxResults = 10;
        break;
      case 'cost':
        this.config.retrievalBlend = 0.2;
        this.config.contextBudgetSplit = {
          shortTerm: 0.5,
          longTerm: 0.3,
          procedural: 0.2
        };
        this.config.shortTermSummarizeAt = Math.floor(
          this.config.shortTermMaxTokens * 0.6
        );
        this.config.diversityThreshold = 0.3;
        this.config.rlmMaxResults = 4;
        break;
      case 'balanced':
      default:
        this.config.retrievalBlend = 0.3;
        this.config.contextBudgetSplit = {
          shortTerm: 0.6,
          longTerm: 0.3,
          procedural: 0.1
        };
        this.config.shortTermSummarizeAt = Math.floor(
          this.config.shortTermMaxTokens * 0.8
        );
        this.config.diversityThreshold = 0.35;
        this.config.rlmMaxResults = 6;
        break;
    }
  }

  private normalizeConfig(): void {
    if (this.config.shortTermMaxTokens < 100) {
      this.config.shortTermMaxTokens = 100;
    }

    if (this.config.shortTermSummarizeAt > this.config.shortTermMaxTokens) {
      this.config.shortTermSummarizeAt = this.config.shortTermMaxTokens;
    }

    if (this.config.shortTermSummarizeAt < 50) {
      this.config.shortTermSummarizeAt = Math.min(
        this.config.shortTermMaxTokens,
        50
      );
    }

    const split = this.config.contextBudgetSplit;
    const shortTerm = Math.max(0, split.shortTerm);
    const longTerm = Math.max(0, split.longTerm);
    const procedural = Math.max(0, split.procedural);
    const total = shortTerm + longTerm + procedural;

    if (total <= 0) {
      this.config.contextBudgetSplit = {
        shortTerm: 0.6,
        longTerm: 0.3,
        procedural: 0.1
      };
      return;
    }

    this.config.contextBudgetSplit = {
      shortTerm: shortTerm / total,
      longTerm: longTerm / total,
      procedural: procedural / total
    };
  }

  // ============ Unified Memory Operations ============

  async processInput(
    input: string,
    sessionId: string,
    taskId: string
  ): Promise<void> {
    const taggedInput = this.ensureSessionTag(input, sessionId);
    const plainInput = this.stripMemoryTags(taggedInput);

    // 1. Add to short-term buffer
    await this.addToShortTerm(taggedInput);

    // 2. Decide if long-term storage needed (Memory-R1)
    if (this.config.trainingStage >= 2) {
      try {
        const decision = await this.memoryR1.decideOperation(
          this.getShortTermContext(),
          taggedInput,
          taskId
        );

        if (decision.operation !== 'NOOP') {
          await this.memoryR1.executeOperation(decision);
        }
      } catch (error) {
        this.emit('longTerm:processError', {
          sessionId,
          taskId,
          error
        });
      }
    }

    // 3. Check for pattern emergence
    await this.detectPatterns(plainInput, sessionId);

    // 4. Trigger summarization if needed
    if (this.state.shortTerm.currentTokens > this.config.shortTermSummarizeAt) {
      await this.summarizeShortTerm();
    }

    this.invalidateSemanticCache('process-input');
    this.emit('input:processed', { input, sessionId, taskId });
  }

  async retrieve(
    query: string,
    taskId: string,
    options?: RetrievalOptions
  ): Promise<UnifiedRetrievalResult> {
    const types = options?.types || ['short_term', 'long_term', 'procedural'];
    const maxTokens = options?.maxTokens || this.config.shortTermMaxTokens;
    const filterTags = this.getFilterTags(options);

    const cacheKey = this.buildCacheKey(query, options, this.cacheRevision);
    const cached = this.getCachedResult(cacheKey);
    if (cached) {
      return cached;
    }

    const results: UnifiedRetrievalResult = {
      shortTerm: [],
      longTerm: [],
      procedural: [],
      skills: [],
      wakeContext: undefined,
      totalTokens: 0
    };

    // Calculate token budgets
    const budgets = {
      shortTerm: Math.floor(
        maxTokens * this.config.contextBudgetSplit.shortTerm
      ),
      longTerm: Math.floor(maxTokens * this.config.contextBudgetSplit.longTerm),
      procedural: Math.floor(
        maxTokens * this.config.contextBudgetSplit.procedural
      )
    };

    // Short-term fetching (recency-based + keyword match)
    if (types.includes('short_term')) {
      results.shortTerm = this.fetchShortTerm(
        query,
        budgets.shortTerm,
        filterTags
      );
    }

    // Long-term fetching (hybrid retrieval: semantic + BM25 + trajectory learning)
    if (types.includes('long_term') && this.config.trainingStage >= 2) {
      try {
        const hybridManager = getHybridRetrievalManager();
        const hybridResults = await hybridManager.retrieve(query, taskId);
        // Extract the underlying MemoryEntry objects from hybrid results
        const entries = hybridResults
          .map(r => r.entry)
          .filter((e): e is MemoryEntry => !!e);
        const filteredEntries = this.filterEntriesByTags(
          entries,
          filterTags,
          options
        );
        results.longTerm = filteredEntries.map((e) =>
          this.stripMemoryTags(e.content)
        );
      } catch (error) {
        // Fallback to direct Memory-R1 if hybrid fails
        try {
          const entries = await this.memoryR1.retrieve(query, taskId);
          const filteredEntries = this.filterEntriesByTags(
            entries,
            filterTags,
            options
          );
          results.longTerm = filteredEntries.map((e) =>
            this.stripMemoryTags(e.content)
          );
        } catch (fallbackError) {
          this.emit('retrieve:sourceError', {
            source: 'long_term',
            query,
            taskId,
            error: fallbackError
          });
        }
      }
    }

    // Procedural fetching (matching workflows/strategies)
    if (types.includes('procedural')) {
      results.procedural = this.fetchProcedural(query, budgets.procedural);
    }

    // Skills fetching (embedding-based skill detection)
    if (types.includes('skills')) {
      results.skills = await this.fetchSkills(query);
    }

    const includeWakeContext =
      options?.includeWakeContext ??
      Boolean(options?.sessionId || options?.instanceId);

    if (includeWakeContext) {
      try {
        results.wakeContext = getWakeContextBuilder().getWakeUpText(
          options?.wakeContextWing
        );
      } catch (error) {
        this.emit('retrieve:sourceError', {
          source: 'wake_context',
          query,
          taskId,
          error
        });
      }
    }

    // RLM integration (tiered by section type/depth)
    try {
      const rlmResults = this.fetchRlmContext(query, budgets, options);
      if (types.includes('short_term') && rlmResults.shortTerm.length > 0) {
        results.shortTerm = this.mergeResults(
          results.shortTerm,
          rlmResults.shortTerm,
          budgets.shortTerm
        );
      }
      if (types.includes('long_term') && rlmResults.longTerm.length > 0) {
        results.longTerm = this.mergeResults(
          results.longTerm,
          rlmResults.longTerm,
          budgets.longTerm
        );
      }
      if (types.includes('procedural') && rlmResults.procedural.length > 0) {
        results.procedural = this.mergeResults(
          results.procedural,
          rlmResults.procedural,
          budgets.procedural
        );
      }
    } catch (error) {
      this.emit('retrieve:sourceError', {
        source: 'rlm',
        query,
        taskId,
        error
      });
    }

    // Position-bias mitigation (place top chunk at both ends)
    results.shortTerm = this.applyPositionBiasMitigation(results.shortTerm);
    results.longTerm = this.applyPositionBiasMitigation(results.longTerm);
    results.procedural = this.applyPositionBiasMitigation(results.procedural);
    results.skills = this.applyPositionBiasMitigation(results.skills);

    results.totalTokens =
      this.estimateTokens(results.shortTerm.join(' ')) +
      this.estimateTokens(results.longTerm.join(' ')) +
      this.estimateTokens(results.procedural.join(' ')) +
      this.estimateTokens(results.skills.join(' ')) +
      this.estimateTokens(results.wakeContext || '');

    this.emit('fetch:completed', { query, taskId, results });
    this.setCachedResult(cacheKey, results);
    return this.cloneRetrievalResult(results);
  }

  // ============ Short-term Memory ============

  private async addToShortTerm(content: string): Promise<void> {
    const tokens = this.estimateTokens(content);

    this.state.shortTerm.buffer.push(content);
    this.state.shortTerm.currentTokens += tokens;

    // Evict oldest if over budget
    while (
      this.state.shortTerm.currentTokens > this.config.shortTermMaxTokens
    ) {
      const removed = this.state.shortTerm.buffer.shift();
      if (removed) {
        this.state.shortTerm.currentTokens -= this.estimateTokens(removed);
      }
    }
  }

  private fetchShortTerm(
    query: string,
    maxTokens: number,
    filterTags: string[]
  ): string[] {
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    const buffer = this.filterShortTermBuffer(
      this.state.shortTerm.buffer,
      filterTags
    );

    // Prioritize recent and keyword-matching entries with diversity
    const scored = buffer.map((content, index) => {
      const sanitized = this.stripMemoryTags(content);
      const lowerContent = sanitized.toLowerCase();
      const matches = queryTerms.filter((term) =>
        lowerContent.includes(term)
      ).length;
      const recency = buffer.length > 0 ? (index + 1) / buffer.length : 0; // 0-1
      return {
        content: sanitized,
        score: matches * 0.65 + recency * 0.35,
        tokens: this.estimateTokens(sanitized)
      };
    });

    return this.selectDiverseCandidates(scored, maxTokens).map(
      (candidate) => candidate.content
    );
  }

  getShortTermContext(): string {
    return this.state.shortTerm.buffer
      .slice(-10)
      .map((entry) => this.stripMemoryTags(entry))
      .join('\n\n');
  }

  private async summarizeShortTerm(): Promise<void> {
    // Take oldest 50% of buffer
    const toSummarize = this.state.shortTerm.buffer.splice(
      0,
      Math.floor(this.state.shortTerm.buffer.length / 2)
    );

    const content = toSummarize
      .map((entry) => this.stripMemoryTags(entry))
      .join('\n\n');

    // Call summarization (placeholder - actual impl uses LLM)
    const summary = await this.callSummarizer(content);

    this.state.shortTerm.summaries.push(summary);
    this.state.shortTerm.currentTokens = this.estimateTokens(
      this.state.shortTerm.buffer.join(' ')
    );

    this.emit('shortTerm:summarized', {
      originalTokens: this.estimateTokens(content)
    });
  }

  // ============ Episodic Memory ============

  async recordSessionEnd(
    sessionId: string,
    outcome: SessionOutcome,
    summary: string,
    lessons: string[]
  ): Promise<void> {
    const sessionMemory: SessionMemory = {
      sessionId,
      summary,
      keyEvents: this.extractKeyEvents(),
      outcome,
      lessonsLearned: lessons,
      timestamp: Date.now()
    };

    this.state.episodic.sessions.push(sessionMemory);
    // Cap sessions to prevent unbounded growth
    if (this.state.episodic.sessions.length > MAX_EPISODIC_SESSIONS) {
      this.state.episodic.sessions = this.state.episodic.sessions.slice(-MAX_EPISODIC_SESSIONS);
    }

    // Delegate to EpisodicStore for richer session tracking
    try {
      getEpisodicStore().addSession(sessionMemory);
    } catch {
      // EpisodicStore is optional — don't block session recording
    }

    // Learn patterns from successful sessions
    if (outcome === 'success') {
      await this.extractPatterns(sessionMemory);
    }

    // Persist
    await this.save();

    // Promote patterns to cross-project learning (gated behind enabled: false by default)
    if (outcome === 'success') {
      try {
        const learner = getCrossProjectLearner();
        if (learner.isEnabled()) {
          for (const pattern of this.state.episodic.patterns.slice(-3)) {
            await learner.promoteLearnedPattern(pattern);
          }
        }
      } catch {
        // Cross-project learning is optional
      }
    }

    this.invalidateSemanticCache('record-session-end');
    this.emit('session:recorded', sessionMemory);
  }

  private extractKeyEvents(): string[] {
    // Extract significant events from short-term buffer
    return this.state.shortTerm.buffer
      .filter((b) => b.length > 100)
      .slice(-5)
      .map((entry) => this.stripMemoryTags(entry));
  }

  private async extractPatterns(session: SessionMemory): Promise<void> {
    // Pattern extraction would use LLM in production
    const pattern: LearnedPattern = {
      id: `pattern-${Date.now()}`,
      pattern: session.summary,
      successRate: 1.0,
      usageCount: 1,
      contexts: [session.sessionId]
    };

    // Check for similar patterns
    const existing = this.state.episodic.patterns.find(
      (p) => this.patternSimilarity(p.pattern, pattern.pattern) > 0.8
    );

    if (existing) {
      existing.usageCount++;
      existing.successRate =
        (existing.successRate * (existing.usageCount - 1) + 1) /
        existing.usageCount;
      existing.contexts.push(session.sessionId);
      if (existing.contexts.length > MAX_PATTERN_CONTEXTS) {
        existing.contexts = existing.contexts.slice(-MAX_PATTERN_CONTEXTS);
      }
    } else {
      this.state.episodic.patterns.push(pattern);
    }
    // Cap patterns - keep highest usage count
    if (this.state.episodic.patterns.length > MAX_EPISODIC_PATTERNS) {
      this.state.episodic.patterns.sort((a, b) => b.usageCount - a.usageCount);
      this.state.episodic.patterns = this.state.episodic.patterns.slice(0, MAX_EPISODIC_PATTERNS);
    }
  }

  private async detectPatterns(
    input: string,
    sessionId: string
  ): Promise<void> {
    // Simple pattern detection - look for matching patterns
    for (const pattern of this.state.episodic.patterns) {
      if (this.patternSimilarity(input, pattern.pattern) > 0.6) {
        pattern.usageCount++;
        if (!pattern.contexts.includes(sessionId)) {
          pattern.contexts.push(sessionId);
          // Cap pattern contexts to prevent unbounded per-pattern growth
          if (pattern.contexts.length > MAX_PATTERN_CONTEXTS) {
            pattern.contexts = pattern.contexts.slice(-MAX_PATTERN_CONTEXTS);
          }
        }
      }
    }
  }

  // ============ Procedural Memory ============

  private fetchProcedural(query: string, maxTokens: number): string[] {
    const queryLower = query.toLowerCase();
    const candidates: {
      content: string;
      score: number;
      tokens: number;
    }[] = [];

    // Find matching workflows
    for (const workflow of this.state.procedural.workflows) {
      if (this.workflowMatches(workflow, query)) {
        const content = `Workflow: ${workflow.name}\nSteps:\n${workflow.steps.join('\n')}`;
        const relevance = queryLower.includes(workflow.name.toLowerCase())
          ? 1
          : 0.6;
        const score = relevance + workflow.successRate;
        candidates.push({
          content,
          score,
          tokens: this.estimateTokens(content)
        });
      }
    }

    // Find matching strategies
    for (const strategy of this.state.procedural.strategies) {
      if (this.strategyMatches(strategy, query)) {
        const content = `Strategy: ${strategy.strategy}\nConditions: ${strategy.conditions.join(', ')}`;
        const outcomes = strategy.outcomes || [];
        const successRate =
          outcomes.length === 0
            ? 0.5
            : outcomes.filter((outcome) => outcome.success).length /
              outcomes.length;
        const score = 0.6 + successRate;
        candidates.push({
          content,
          score,
          tokens: this.estimateTokens(content)
        });
      }
    }

    return this.selectDiverseCandidates(candidates, maxTokens).map(
      (candidate) => candidate.content
    );
  }

  // ============ Skills Memory ============

  /**
   * Fetch relevant skills using embedding-based detection.
   * Returns skill content as strings for context injection.
   */
  private async fetchSkills(query: string): Promise<string[]> {
    try {
      const detectedSkills = await this.skillsLoader.detectRelevantSkills(query);

      if (detectedSkills.length === 0) {
        return [];
      }

      // Load skill content with a reasonable budget (5000 tokens per skill max)
      const maxTokensPerSkill = 5000;
      const totalBudget = maxTokensPerSkill * detectedSkills.length;

      const { content } = await this.skillsLoader.loadSkillsWithBudget(
        detectedSkills,
        totalBudget
      );

      return content;
    } catch (error) {
      this.emit('skills:fetchError', { query, error });
      return [];
    }
  }

  /**
   * Initialize the skills loader with the project root.
   * Call this during startup to enable skill detection.
   */
  async initializeSkills(projectRoot: string): Promise<void> {
    await this.skillsLoader.initialize(projectRoot);
    this.emit('skills:initialized', { projectRoot });
  }

  async recordWorkflow(
    name: string,
    steps: string[],
    applicableContexts: string[]
  ): Promise<WorkflowMemory> {
    const workflow: WorkflowMemory = {
      id: `wf-${Date.now()}`,
      name,
      steps,
      successRate: 0,
      applicableContexts
    };

    this.state.procedural.workflows.push(workflow);

    // Delegate to ProceduralStore for richer workflow tracking
    try {
      getProceduralStore().addWorkflow(workflow);
    } catch {
      // ProceduralStore is optional
    }

    this.invalidateSemanticCache('record-workflow');
    this.emit('workflow:recorded', workflow);
    return workflow;
  }

  async recordStrategy(
    strategy: string,
    conditions: string[],
    taskId: string,
    success: boolean,
    score: number
  ): Promise<StrategyMemory> {
    // Find existing or create new
    let existing = this.state.procedural.strategies.find(
      (s) =>
        s.strategy === strategy &&
        s.conditions.join(',') === conditions.join(',')
    );

    if (!existing) {
      existing = {
        id: `strat-${Date.now()}`,
        strategy,
        conditions,
        outcomes: []
      };
      this.state.procedural.strategies.push(existing);

      // Delegate to ProceduralStore
      try {
        getProceduralStore().addStrategy(existing);
      } catch {
        // ProceduralStore is optional
      }
    }

    existing.outcomes.push({
      taskId,
      success,
      score,
      timestamp: Date.now()
    });

    // Record outcome in ProceduralStore
    try {
      getProceduralStore().recordStrategyOutcome(existing.id, taskId, success, score);
    } catch {
      // ProceduralStore is optional
    }

    this.invalidateSemanticCache('record-strategy');
    this.emit('strategy:recorded', existing);
    return existing;
  }

  // ============ Training Integration ============

  recordTaskOutcome(taskId: string, success: boolean, score: number): void {
    // Propagate to Memory-R1
    this.memoryR1.recordTaskOutcome(taskId, success, score);

    // Update procedural memory
    for (const strategy of this.state.procedural.strategies) {
      const outcome = strategy.outcomes.find((o) => o.taskId === taskId);
      if (outcome) {
        outcome.success = success;
        outcome.score = score;
      }
    }

    this.invalidateSemanticCache('record-task-outcome');
    this.emit('outcome:recorded', { taskId, success, score });
  }

  // ============ Utilities ============

  private buildCacheKey(
    query: string,
    options?: RetrievalOptions,
    revision: number = this.cacheRevision
  ): string {
    const keyPayload = {
      query,
      types: options?.types || ['short_term', 'long_term', 'procedural'],
      maxTokens: options?.maxTokens || this.config.shortTermMaxTokens,
      sessionId: options?.sessionId || null,
      instanceId: options?.instanceId || null,
      includeWakeContext: options?.includeWakeContext ?? null,
      wakeContextWing: options?.wakeContextWing || null,
      revision
    };

    return JSON.stringify(keyPayload);
  }

  private getCachedResult(key: string): UnifiedRetrievalResult | null {
    const cached = this.semanticCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this.semanticCache.delete(key);
      return null;
    }
    return this.cloneRetrievalResult(cached.result);
  }

  private setCachedResult(key: string, result: UnifiedRetrievalResult): void {
    const maxEntries = this.config.semanticCacheMaxEntries ?? 0;
    const ttlMs = this.config.semanticCacheTtlMs ?? 0;
    if (maxEntries <= 0 || ttlMs <= 0) return;

    if (this.semanticCache.size >= maxEntries) {
      const oldestKey = this.semanticCache.keys().next().value;
      if (oldestKey) {
        this.semanticCache.delete(oldestKey);
      }
    }

    this.semanticCache.set(key, {
      result: this.cloneRetrievalResult(result),
      expiresAt: Date.now() + ttlMs
    });
  }

  private cloneRetrievalResult(
    result: UnifiedRetrievalResult
  ): UnifiedRetrievalResult {
    return {
      shortTerm: [...result.shortTerm],
      longTerm: [...result.longTerm],
      procedural: [...result.procedural],
      skills: [...result.skills],
      wakeContext: result.wakeContext,
      totalTokens: result.totalTokens
    };
  }

  private invalidateSemanticCache(reason: string): void {
    this.cacheRevision += 1;
    this.semanticCache.clear();
    this.emit('cache:invalidated', { reason, revision: this.cacheRevision });
  }

  private applyPositionBiasMitigation(items: string[]): string[] {
    if (items.length <= 2) return items;
    const [first, second, ...rest] = items;
    return [first, ...rest, second];
  }

  private selectDiverseCandidates(
    candidates: { content: string; score: number; tokens: number }[],
    maxTokens: number,
    maxItems?: number
  ): { content: string; score: number; tokens: number }[] {
    const threshold = this.config.diversityThreshold ?? 0.35;
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const selected: { content: string; score: number; tokens: number }[] = [];
    let usedTokens = 0;

    for (const candidate of sorted) {
      if (maxItems && selected.length >= maxItems) break;
      if (usedTokens + candidate.tokens > maxTokens) continue;

      const similarity = this.maxSimilarity(
        candidate.content,
        selected.map((s) => s.content)
      );
      if (similarity > threshold && selected.length > 0) {
        continue;
      }

      selected.push(candidate);
      usedTokens += candidate.tokens;
    }

    return selected;
  }

  private maxSimilarity(content: string, others: string[]): number {
    let max = 0;
    for (const other of others) {
      max = Math.max(max, this.patternSimilarity(content, other));
    }
    return max;
  }

  private mergeResults(
    existing: string[],
    incoming: string[],
    maxTokens: number
  ): string[] {
    const merged: string[] = [...existing];
    const seen = new Set(existing);
    let usedTokens = this.estimateTokens(existing.join(' '));

    for (const item of incoming) {
      if (seen.has(item)) continue;
      const tokens = this.estimateTokens(item);
      if (usedTokens + tokens > maxTokens) break;
      merged.push(item);
      seen.add(item);
      usedTokens += tokens;
    }

    return merged;
  }

  private fetchRlmContext(
    query: string,
    budgets: { shortTerm: number; longTerm: number; procedural: number },
    options?: RetrievalOptions
  ): { shortTerm: string[]; longTerm: string[]; procedural: string[] } {
    const instanceKey = options?.sessionId || options?.instanceId;
    if (!instanceKey) {
      return { shortTerm: [], longTerm: [], procedural: [] };
    }

    const store = this.rlmContext.getStoreByInstance(instanceKey);
    if (!store) {
      return { shortTerm: [], longTerm: [], procedural: [] };
    }

    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    const totalSections = store.sections.length || 1;
    const maxItems = this.config.rlmMaxResults ?? 6;

    const tierCandidates = {
      shortTerm: [] as {
        content: string;
        score: number;
        tokens: number;
      }[],
      longTerm: [] as { content: string; score: number; tokens: number }[],
      procedural: [] as {
        content: string;
        score: number;
        tokens: number;
      }[]
    };

    store.sections.forEach((section, index) => {
      const content = section.content;
      if (!content) return;

      const lowerContent = content.toLowerCase();
      const matches = queryTerms.filter((term) =>
        lowerContent.includes(term)
      ).length;
      const recency = (index + 1) / totalSections;
      const baseScore =
        matches * 0.7 + recency * 0.3 + (section.depth > 0 ? 0.05 : 0);
      const candidate = {
        content,
        score: baseScore,
        tokens: this.estimateTokens(content)
      };

      if (section.depth > 0 || section.type === 'summary') {
        tierCandidates.longTerm.push(candidate);
      } else if (section.type === 'file') {
        tierCandidates.procedural.push(candidate);
      } else {
        tierCandidates.shortTerm.push(candidate);
      }
    });

    return {
      shortTerm: this.selectDiverseCandidates(
        tierCandidates.shortTerm,
        budgets.shortTerm,
        maxItems
      ).map((candidate) => candidate.content),
      longTerm: this.selectDiverseCandidates(
        tierCandidates.longTerm,
        budgets.longTerm,
        maxItems
      ).map((candidate) => candidate.content),
      procedural: this.selectDiverseCandidates(
        tierCandidates.procedural,
        budgets.procedural,
        maxItems
      ).map((candidate) => candidate.content)
    };
  }

  private ensureSessionTag(input: string, sessionId: string): string {
    if (/^\s*\[(?:instance|session):/i.test(input)) {
      return input;
    }

    return `[session:${sessionId}] ${input}`;
  }

  private getFilterTags(options?: RetrievalOptions): string[] {
    const tags: string[] = [];

    if (options?.instanceId) {
      tags.push(`[instance:${options.instanceId}]`);
    }

    if (options?.sessionId) {
      tags.push(`[session:${options.sessionId}]`);
    }

    return tags;
  }

  private filterShortTermBuffer(buffer: string[], tags: string[]): string[] {
    if (tags.length === 0) return buffer;
    return buffer.filter((content) => this.matchesFilterTags(content, tags));
  }

  private filterEntriesByTags(
    entries: MemoryEntry[],
    tags: string[],
    options?: RetrievalOptions
  ): MemoryEntry[] {
    if (tags.length === 0) return entries;

    return entries.filter((entry) => {
      if (options?.sessionId && entry.sourceSessionId === options.sessionId) {
        return true;
      }
      return this.matchesFilterTags(entry.content, tags);
    });
  }

  private matchesFilterTags(content: string, tags: string[]): boolean {
    return tags.every((tag) => content.includes(tag));
  }

  private stripMemoryTags(content: string): string {
    return content
      .replace(/^\s*(\[(?:instance|session):[^\]]+\]\s*)+/i, '')
      .trim();
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private patternSimilarity(a: string, b: string): number {
    // Simple Jaccard similarity
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private workflowMatches(workflow: WorkflowMemory, query: string): boolean {
    const queryLower = query.toLowerCase();
    return (
      workflow.applicableContexts.some((ctx) =>
        queryLower.includes(ctx.toLowerCase())
      ) || queryLower.includes(workflow.name.toLowerCase())
    );
  }

  private strategyMatches(strategy: StrategyMemory, query: string): boolean {
    const queryLower = query.toLowerCase();
    return strategy.conditions.some((cond) =>
      queryLower.includes(cond.toLowerCase())
    );
  }

  private async callSummarizer(content: string): Promise<string> {
    const estimatedTokens = Math.ceil(content.length / 4);
    const targetTokens = Math.max(200, Math.floor(estimatedTokens * 0.3));

    try {
      const llmService = getLLMService();
      const summary = await llmService.summarize({
        requestId: `unified-summary-${Date.now()}`,
        content,
        targetTokens,
        preserveKeyPoints: true,
      });
      return summary;
    } catch (error) {
      unifiedLogger.warn('LLM summarization failed, using local fallback', {
        error: (error as Error).message,
        contentLength: content.length,
      });
      // Fallback: extract key sentences heuristically
      const sentences = content.split(/[.!?\n]+/).filter(s => s.trim().length > 20);
      const selected = sentences.slice(0, Math.max(3, Math.floor(sentences.length * 0.2)));
      return `[Auto-summary] ${selected.join('. ').slice(0, targetTokens * 4)}`;
    }
  }

  // ============ Persistence ============

  async save(): Promise<UnifiedMemorySnapshot> {
    const snapshot: UnifiedMemorySnapshot = {
      version: '1.0',
      timestamp: Date.now(),
      shortTerm: {
        buffer: this.state.shortTerm.buffer,
        summaries: this.state.shortTerm.summaries
      },
      episodic: {
        sessions: this.state.episodic.sessions,
        patterns: this.state.episodic.patterns
      },
      procedural: {
        workflows: this.state.procedural.workflows,
        strategies: this.state.procedural.strategies
      }
    };

    this.emit('state:saved', snapshot);
    return snapshot;
  }

  async load(snapshot: UnifiedMemorySnapshot): Promise<void> {
    this.state.shortTerm.buffer = snapshot.shortTerm.buffer;
    this.state.shortTerm.summaries = snapshot.shortTerm.summaries;
    this.state.shortTerm.currentTokens = this.estimateTokens(
      snapshot.shortTerm.buffer.join(' ')
    );

    this.state.episodic.sessions = snapshot.episodic.sessions.slice(
      -MAX_EPISODIC_SESSIONS
    );
    this.state.episodic.patterns = snapshot.episodic.patterns.slice(
      0,
      MAX_EPISODIC_PATTERNS
    );

    this.state.procedural.workflows = snapshot.procedural.workflows;
    this.state.procedural.strategies = snapshot.procedural.strategies;

    this.invalidateSemanticCache('load');
    this.emit('state:loaded', snapshot);
  }

  // ============ Introspection ============

  getStats(): UnifiedMemoryStats {
    return {
      shortTermTokens: this.state.shortTerm.currentTokens,
      longTermEntries: this.memoryR1.getStats().totalEntries,
      episodicSessions: this.state.episodic.sessions.length,
      learnedPatterns: this.state.episodic.patterns.length,
      workflows: this.state.procedural.workflows.length,
      strategies: this.state.procedural.strategies.length
    };
  }

  getSessionHistory(limit?: number): SessionMemory[] {
    // Merge inline state with EpisodicStore
    const sessionMap = new Map<string, SessionMemory>();
    for (const s of this.state.episodic.sessions) {
      sessionMap.set(s.sessionId, s);
    }
    try {
      for (const s of getEpisodicStore().getRecentSessions(limit ?? 100)) {
        if (!sessionMap.has(s.sessionId)) {
          sessionMap.set(s.sessionId, s);
        }
      }
    } catch {
      // EpisodicStore is optional
    }
    const sessions = [...sessionMap.values()];
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sessions.slice(0, limit) : sessions;
  }

  getPatterns(minSuccessRate?: number): LearnedPattern[] {
    // Merge inline patterns with EpisodicStore patterns
    const patternMap = new Map<string, LearnedPattern>();
    for (const p of this.state.episodic.patterns) {
      patternMap.set(p.id, p);
    }
    try {
      for (const p of getEpisodicStore().queryPatterns({})) {
        if (!patternMap.has(p.id)) {
          patternMap.set(p.id, p);
        }
      }
    } catch {
      // EpisodicStore is optional
    }
    const patterns = [...patternMap.values()];
    if (minSuccessRate !== undefined) {
      return patterns.filter((p) => p.successRate >= minSuccessRate);
    }
    return patterns;
  }

  getWorkflows(): WorkflowMemory[] {
    // Merge inline state with ProceduralStore
    const workflowMap = new Map<string, WorkflowMemory>();
    for (const w of this.state.procedural.workflows) {
      workflowMap.set(w.id, w);
    }
    try {
      for (const w of getProceduralStore().queryWorkflows({})) {
        if (!workflowMap.has(w.id)) {
          workflowMap.set(w.id, w);
        }
      }
    } catch {
      // ProceduralStore is optional
    }
    return [...workflowMap.values()];
  }

  getStrategies(): StrategyMemory[] {
    // Merge inline state with ProceduralStore
    const strategyMap = new Map<string, StrategyMemory>();
    for (const s of this.state.procedural.strategies) {
      strategyMap.set(s.id, s);
    }
    try {
      for (const s of getProceduralStore().queryStrategies({})) {
        if (!strategyMap.has(s.id)) {
          strategyMap.set(s.id, s);
        }
      }
    } catch {
      // ProceduralStore is optional
    }
    return [...strategyMap.values()];
  }
}

// Export singleton getter
export function getUnifiedMemory(): UnifiedMemoryController {
  return UnifiedMemoryController.getInstance();
}
