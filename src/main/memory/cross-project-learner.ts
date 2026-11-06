/**
 * Cross-Project Learner
 * Phase 4.3: Share patterns that work across projects with strict privacy controls
 *
 * Privacy-First Design:
 * - Disabled by default - must be explicitly enabled
 * - Anonymization strips file paths, variable names, project identifiers
 * - Whitelist controls what pattern types can be shared
 * - Never stores which project a pattern came from
 */

import { EventEmitter } from 'events';
import { EmbeddingService } from '../rlm/embedding-service';
import type {
  CrossProjectConfig,
  GlobalPattern,
  AnonymizedPattern,
  CrossProjectPatternType,
  LearnedPattern,
  WorkflowMemory,
  StrategyMemory,
} from '../../shared/types/unified-memory.types';

export interface CrossProjectLearnerConfig extends CrossProjectConfig {
  minProjectCountForSuggestion: number; // Minimum projects a pattern must appear in
  minSuccessRateForSuggestion: number; // Minimum success rate for suggestions
  maxSuggestionsPerQuery: number;
  maxGlobalPatterns: number;
}

/**
 * Source pattern that can be promoted to global scope
 */
export interface PromotablePattern {
  id: string;
  type: CrossProjectPatternType;
  description: string;
  steps: string[];
  metadata: Record<string, unknown>;
  successRate: number;
  contexts?: string[];
}

const DEFAULT_CONFIG: CrossProjectLearnerConfig = {
  enabled: false, // PRIVACY: Disabled by default
  isolationMode: 'disabled',
  allowedPatternTypes: [], // PRIVACY: No pattern types allowed by default
  minProjectCountForSuggestion: 2,
  minSuccessRateForSuggestion: 0.7,
  maxSuggestionsPerQuery: 5,
  maxGlobalPatterns: 500,
};

export class CrossProjectLearner extends EventEmitter {
  private static instance: CrossProjectLearner | null = null;
  private config: CrossProjectLearnerConfig;
  private globalPatterns: Map<string, GlobalPattern> = new Map();
  private embeddingService: EmbeddingService;
  private patternEmbeddings: Map<string, number[]> = new Map();

  private constructor(config: Partial<CrossProjectLearnerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingService = EmbeddingService.getInstance();

    if (!this.config.enabled) {
      this.emit('disabled', { reason: 'Cross-project learning is disabled by default' });
    }
  }

  static getInstance(config?: Partial<CrossProjectLearnerConfig>): CrossProjectLearner {
    if (!this.instance) {
      this.instance = new CrossProjectLearner(config);
    }
    return this.instance;
  }

  /**
   * Reset singleton instance (for testing only)
   */
  static resetInstance(): void {
    this.instance = undefined as unknown as CrossProjectLearner;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Configure the cross-project learner
   */
  configure(config: Partial<CrossProjectLearnerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', { enabled: this.config.enabled });
  }

  /**
   * Get current configuration
   */
  getConfig(): CrossProjectLearnerConfig {
    return { ...this.config };
  }

  /**
   * Check if cross-project learning is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && this.config.isolationMode !== 'disabled';
  }

  /**
   * Check if a pattern type is allowed for sharing
   */
  isPatternTypeAllowed(type: CrossProjectPatternType): boolean {
    return this.config.allowedPatternTypes.includes(type);
  }

  // ============ Pattern Promotion ============

  /**
   * Promote a pattern to global scope
   * PRIVACY: Only promotes ANONYMIZED patterns
   */
  async promoteToGlobal(pattern: PromotablePattern): Promise<GlobalPattern | null> {
    if (!this.isEnabled()) {
      this.emit('promotion:blocked', { reason: 'Cross-project learning disabled' });
      return null;
    }

    if (!this.isPatternTypeAllowed(pattern.type)) {
      this.emit('promotion:blocked', {
        reason: 'Pattern type not in allowed list',
        type: pattern.type,
      });
      return null;
    }

    // CRITICAL: Anonymize before storing globally
    const anonymized = this.anonymizePattern(pattern);

    // Check for similar existing pattern
    const existing = await this.findSimilarGlobal(anonymized);

    if (existing) {
      // Merge with existing pattern
      existing.projectCount++;
      existing.totalSuccessRate = this.weightedAverage(
        existing.totalSuccessRate,
        anonymized.successRate,
        existing.projectCount
      );
      existing.lastUpdated = Date.now();

      this.emit('pattern:merged', {
        patternId: existing.id,
        projectCount: existing.projectCount,
      });

      return existing;
    }

    // Create new global pattern
    const globalPattern: GlobalPattern = {
      id: `global-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type: anonymized.type,
      description: anonymized.description,
      steps: anonymized.steps,
      metadata: anonymized.metadata,
      totalSuccessRate: anonymized.successRate,
      projectCount: 1,
      isGlobal: true,
      lastUpdated: Date.now(),
    };

    this.globalPatterns.set(globalPattern.id, globalPattern);

    // Compute and cache embedding for similarity search
    const embedding = await this.getPatternEmbedding(globalPattern.description);
    this.patternEmbeddings.set(globalPattern.id, embedding);

    // Enforce max limit
    if (this.globalPatterns.size > this.config.maxGlobalPatterns) {
      this.pruneOldPatterns();
    }

    this.emit('pattern:promoted', {
      patternId: globalPattern.id,
      type: globalPattern.type,
    });

    return globalPattern;
  }

  /**
   * Promote a workflow to global scope
   */
  async promoteWorkflow(workflow: WorkflowMemory): Promise<GlobalPattern | null> {
    return this.promoteToGlobal({
      id: workflow.id,
      type: 'workflow',
      description: workflow.name,
      steps: workflow.steps,
      metadata: { applicableContexts: this.anonymizeContexts(workflow.applicableContexts) },
      successRate: workflow.successRate,
      contexts: workflow.applicableContexts,
    });
  }

  /**
   * Promote a strategy to global scope
   */
  async promoteStrategy(strategy: StrategyMemory): Promise<GlobalPattern | null> {
    const successRate = this.calculateStrategySuccessRate(strategy);
    return this.promoteToGlobal({
      id: strategy.id,
      type: 'strategy',
      description: strategy.strategy,
      steps: [strategy.strategy],
      metadata: { conditions: this.anonymizeContexts(strategy.conditions) },
      successRate,
      contexts: strategy.conditions,
    });
  }

  /**
   * Promote a learned pattern to global scope
   */
  async promoteLearnedPattern(pattern: LearnedPattern): Promise<GlobalPattern | null> {
    return this.promoteToGlobal({
      id: pattern.id,
      type: 'workflow', // LearnedPatterns map to workflow type
      description: pattern.pattern,
      steps: [pattern.pattern],
      metadata: { contexts: this.anonymizeContexts(pattern.contexts) },
      successRate: pattern.successRate,
      contexts: pattern.contexts,
    });
  }

  // ============ Anonymization ============

  /**
   * Anonymize a pattern for global storage
   * Strips: file paths, variable names, project-specific identifiers
   * Keeps: general workflow structure, success metrics
   */
  anonymizePattern(pattern: PromotablePattern): AnonymizedPattern {
    return {
      id: pattern.id,
      type: pattern.type,
      description: this.generalizeDescription(pattern.description),
      steps: pattern.steps.map(step => this.anonymizeStep(step)),
      metadata: this.stripProjectIdentifiers(pattern.metadata),
      successRate: pattern.successRate,
    };
  }

  /**
   * Anonymize a single step
   */
  private anonymizeStep(step: string): string {
    let anonymized = step;

    // Remove URLs FIRST (before path regex which could partially match URL paths)
    anonymized = anonymized.replace(
      /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
      '<URL>'
    );

    // Remove file paths (Unix and Windows) - but not things that look like protocol remainders
    anonymized = anonymized.replace(
      /(?:^|[^:])(?:\/[a-zA-Z0-9._-]+){2,}(?:\/[a-zA-Z0-9._-]*)?/g,
      match => match.startsWith('/') ? '<PATH>' : match[0] + '<PATH>'
    );
    anonymized = anonymized.replace(/[A-Za-z]:\\(?:[^\\:*?"<>|\r\n]+\\)*[^\\:*?"<>|\r\n]*/g, '<PATH>');

    // Remove email addresses
    anonymized = anonymized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<EMAIL>');

    // Remove UUIDs
    anonymized = anonymized.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<UUID>'
    );

    // Remove hex strings (like commit hashes)
    anonymized = anonymized.replace(/\b[0-9a-f]{40}\b/gi, '<HASH>');
    anonymized = anonymized.replace(/\b[0-9a-f]{7,8}\b/gi, '<SHORT_HASH>');

    // Remove specific variable names (camelCase or snake_case patterns with numbers)
    anonymized = anonymized.replace(/\b[a-z][a-zA-Z0-9_]*[0-9]+[a-zA-Z0-9_]*\b/g, '<VAR>');

    // Remove IP addresses
    anonymized = anonymized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>');

    // Remove port numbers
    anonymized = anonymized.replace(/:(\d{4,5})\b/g, ':<PORT>');

    return anonymized;
  }

  /**
   * Generalize a description by removing project-specific terms
   */
  private generalizeDescription(description: string): string {
    let generalized = description;

    // Apply step anonymization
    generalized = this.anonymizeStep(generalized);

    // Remove common project-specific prefixes/suffixes
    generalized = generalized.replace(/\b(my|our|your|the)\s+/gi, '');

    // Keep the description meaningful but generic
    return generalized.trim();
  }

  /**
   * Strip project identifiers from metadata
   */
  private stripProjectIdentifiers(metadata: Record<string, unknown>): Record<string, unknown> {
    const stripped: Record<string, unknown> = {};

    const sensitiveKeys = [
      'projectId',
      'projectName',
      'projectPath',
      'userId',
      'userName',
      'repoUrl',
      'apiKey',
      'token',
      'secret',
      'password',
      'credential',
    ];

    for (const [key, value] of Object.entries(metadata)) {
      // Skip sensitive keys
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
        continue;
      }

      // Recursively strip nested objects
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        stripped[key] = this.stripProjectIdentifiers(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        stripped[key] = value.map(item => {
          if (typeof item === 'string') {
            return this.anonymizeStep(item);
          }
          return item;
        });
      } else if (typeof value === 'string') {
        stripped[key] = this.anonymizeStep(value);
      } else {
        stripped[key] = value;
      }
    }

    return stripped;
  }

  /**
   * Anonymize context strings
   */
  private anonymizeContexts(contexts: string[]): string[] {
    return contexts.map(ctx => this.anonymizeStep(ctx));
  }

  // ============ Pattern Suggestions ============

  /**
   * Suggest relevant global patterns for a new project
   */
  async suggestForNewProject(projectContext: string): Promise<GlobalPattern[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const { embedding: contextEmbedding } = await this.embeddingService.embed(projectContext, 'query');
    const relevanceFloor = await this.embeddingService.similarityFloor('pattern-relevance');

    const suggestions: Array<{ pattern: GlobalPattern; similarity: number }> = [];

    for (const pattern of this.globalPatterns.values()) {
      // Only suggest patterns proven in multiple projects
      if (pattern.projectCount < this.config.minProjectCountForSuggestion) {
        continue;
      }

      // Only suggest patterns with good success rates
      if (pattern.totalSuccessRate < this.config.minSuccessRateForSuggestion) {
        continue;
      }

      // Check relevance via embedding similarity
      const patternEmbedding = this.patternEmbeddings.get(pattern.id);
      if (!patternEmbedding) continue;

      const similarity = this.embeddingService.cosineSimilarity(contextEmbedding, patternEmbedding);

      if (similarity >= relevanceFloor) {
        suggestions.push({ pattern, similarity });
      }
    }

    // Sort by relevance and success rate
    suggestions.sort((a, b) => {
      const scoreA = a.similarity * 0.6 + a.pattern.totalSuccessRate * 0.4;
      const scoreB = b.similarity * 0.6 + b.pattern.totalSuccessRate * 0.4;
      return scoreB - scoreA;
    });

    const result = suggestions.slice(0, this.config.maxSuggestionsPerQuery).map(s => s.pattern);

    this.emit('suggestions:generated', {
      context: projectContext.substring(0, 100),
      count: result.length,
    });

    return result;
  }

  /**
   * Get all global patterns (for debugging/admin)
   */
  getGlobalPatterns(): GlobalPattern[] {
    return [...this.globalPatterns.values()];
  }

  /**
   * Get a specific global pattern
   */
  getGlobalPattern(patternId: string): GlobalPattern | undefined {
    return this.globalPatterns.get(patternId);
  }

  // ============ Similarity & Deduplication ============

  /**
   * Find a similar global pattern for deduplication
   */
  private async findSimilarGlobal(pattern: AnonymizedPattern): Promise<GlobalPattern | null> {
    const embedding = await this.getPatternEmbedding(pattern.description);
    const duplicateFloor = await this.embeddingService.similarityFloor('pattern-duplicate');

    for (const [id, existingEmbedding] of this.patternEmbeddings.entries()) {
      const similarity = this.embeddingService.cosineSimilarity(embedding, existingEmbedding);

      if (similarity >= duplicateFloor) {
        const existingPattern = this.globalPatterns.get(id);
        if (existingPattern && existingPattern.type === pattern.type) {
          return existingPattern;
        }
      }
    }

    return null;
  }

  /**
   * Get embedding for a pattern description
   */
  private async getPatternEmbedding(description: string): Promise<number[]> {
    const result = await this.embeddingService.embed(description, 'document');
    return result.embedding;
  }

  // ============ Utilities ============

  /**
   * Calculate weighted average for success rate
   */
  private weightedAverage(existing: number, newValue: number, count: number): number {
    return (existing * (count - 1) + newValue) / count;
  }

  /**
   * Calculate success rate for a strategy
   */
  private calculateStrategySuccessRate(strategy: StrategyMemory): number {
    if (strategy.outcomes.length === 0) return 0;
    const successful = strategy.outcomes.filter(o => o.success).length;
    return successful / strategy.outcomes.length;
  }

  /**
   * Prune old patterns when over limit
   */
  private pruneOldPatterns(): void {
    // Sort by last updated and project count
    const sorted = [...this.globalPatterns.entries()].sort((a, b) => {
      const scoreA = a[1].projectCount * 1000 + a[1].lastUpdated / 1000000;
      const scoreB = b[1].projectCount * 1000 + b[1].lastUpdated / 1000000;
      return scoreB - scoreA;
    });

    // Keep only max patterns
    const toKeep = new Set(sorted.slice(0, this.config.maxGlobalPatterns).map(([id]) => id));

    for (const id of this.globalPatterns.keys()) {
      if (!toKeep.has(id)) {
        this.globalPatterns.delete(id);
        this.patternEmbeddings.delete(id);
      }
    }

    this.emit('patterns:pruned', {
      remaining: this.globalPatterns.size,
    });
  }

  // ============ Statistics ============

  /**
   * Get statistics about global patterns
   */
  getStats(): {
    totalPatterns: number;
    patternsByType: Record<CrossProjectPatternType, number>;
    avgProjectCount: number;
    avgSuccessRate: number;
    enabled: boolean;
  } {
    const patterns = [...this.globalPatterns.values()];

    const patternsByType: Record<CrossProjectPatternType, number> = {
      workflow: 0,
      strategy: 0,
      error_recovery: 0,
      tool_sequence: 0,
      prompt_structure: 0,
    };

    for (const pattern of patterns) {
      patternsByType[pattern.type]++;
    }

    const avgProjectCount =
      patterns.length > 0
        ? patterns.reduce((sum, p) => sum + p.projectCount, 0) / patterns.length
        : 0;

    const avgSuccessRate =
      patterns.length > 0
        ? patterns.reduce((sum, p) => sum + p.totalSuccessRate, 0) / patterns.length
        : 0;

    return {
      totalPatterns: patterns.length,
      patternsByType,
      avgProjectCount,
      avgSuccessRate,
      enabled: this.isEnabled(),
    };
  }

  // ============ Persistence ============

  /**
   * Export state for persistence
   */
  exportState(): {
    patterns: GlobalPattern[];
    config: CrossProjectLearnerConfig;
  } {
    return {
      patterns: [...this.globalPatterns.values()],
      config: this.config,
    };
  }

  /**
   * Import state from persistence
   */
  async importState(state: {
    patterns?: GlobalPattern[];
    config?: Partial<CrossProjectLearnerConfig>;
  }): Promise<void> {
    if (state.config) {
      this.config = { ...this.config, ...state.config };
    }

    if (state.patterns) {
      this.globalPatterns.clear();
      this.patternEmbeddings.clear();

      for (const pattern of state.patterns) {
        this.globalPatterns.set(pattern.id, pattern);

        // Recompute embeddings
        const embedding = await this.getPatternEmbedding(pattern.description);
        this.patternEmbeddings.set(pattern.id, embedding);
      }
    }

    this.emit('state:imported', { patternCount: this.globalPatterns.size });
  }

  /**
   * Clear all global patterns
   */
  clear(): void {
    this.globalPatterns.clear();
    this.patternEmbeddings.clear();
    this.emit('store:cleared');
  }
}

// Export singleton getter
export function getCrossProjectLearner(
  config?: Partial<CrossProjectLearnerConfig>
): CrossProjectLearner {
  return CrossProjectLearner.getInstance(config);
}
