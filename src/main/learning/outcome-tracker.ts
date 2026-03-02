/**
 * Outcome Tracker
 * Tracks task outcomes for behavioral self-improvement (Training-Free GRPO)
 *
 * Key insight: Instead of updating model weights, we:
 * 1. Record task outcomes with patterns
 * 2. Identify successful/failure patterns
 * 3. Build experience library for future prompts
 *
 * Now with SQLite persistence layer for data durability
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import {
  TaskOutcome,
  TaskPattern,
  Experience,
  LearningInsight,
  SelfImprovementConfig,
  PatternType,
  ToolUsageRecord,
  ExamplePrompt,
  LearningStats,
  TaskTypeStats,
} from '../../shared/types/self-improvement.types';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';

const logger = getLogger('OutcomeTracker');

export class OutcomeTracker extends EventEmitter {
  private static instance: OutcomeTracker;
  private outcomes: TaskOutcome[] = [];
  private patterns: Map<string, TaskPattern> = new Map();
  private experiences: Map<string, Experience> = new Map();
  private insights: LearningInsight[] = [];
  private config: SelfImprovementConfig;
  private db: RLMDatabase | null = null;
  private persistenceEnabled = true;

  private defaultConfig: SelfImprovementConfig = {
    minSampleSize: 10,
    patternDecayRate: 0.95,
    insightThreshold: 0.8,
    maxExperiences: 1000,
    experienceRetention: 90,
    enableAutoEnhancement: true,
    maxEnhancementTokens: 2000,
    enableABTesting: false,
    minABTestSamples: 30,
  };

  static getInstance(): OutcomeTracker {
    if (!this.instance) {
      this.instance = new OutcomeTracker();
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
      this.loadFromPersistence();
      this.emit('persistence:initialized', { success: true });
    } catch (error) {
      logger.error('Failed to initialize persistence', error instanceof Error ? error : undefined);
      this.persistenceEnabled = false;
      this.emit('persistence:initialized', { success: false, error });
    }
  }

  /**
   * Load persisted data into memory on startup
   */
  private loadFromPersistence(): void {
    if (!this.db) return;

    // Load outcomes
    const outcomeRows = this.db.getOutcomes({ limit: this.config.maxExperiences });
    for (const row of outcomeRows) {
      const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
      const toolsData = row.tools_json ? JSON.parse(row.tools_json) : [];
      const outcome: TaskOutcome = {
        id: row.id,
        instanceId: metadata.instanceId || 'unknown',
        taskType: row.task_type,
        taskDescription: metadata.taskDescription || '',
        prompt: row.prompt_hash || '',
        context: undefined,
        agentUsed: row.agent_id || 'unknown',
        modelUsed: row.model || 'unknown',
        toolsUsed: toolsData.map((t: string) => ({ tool: t, count: 1, avgDuration: 0, errorCount: 0 })),
        success: row.success === 1,
        errorType: row.error_type || undefined,
        duration: row.duration_ms || 0,
        tokensUsed: row.token_usage || 0,
        timestamp: row.timestamp,
        patterns: [],
        userSatisfaction: metadata.userSatisfaction,
      };
      this.outcomes.push(outcome);
    }

    // Load patterns
    const patternRows = this.db.getPatterns();
    for (const row of patternRows) {
      const pattern: TaskPattern = {
        type: row.type as PatternType,
        value: row.key,
        effectiveness: row.effectiveness,
        sampleSize: row.sample_size,
        lastUpdated: row.last_updated,
      };
      this.patterns.set(`${row.type}:${row.key}`, pattern);
    }

    // Load experiences
    const experienceRows = this.db.getAllExperiences();
    for (const row of experienceRows) {
      const experience: Experience = {
        id: row.id,
        taskType: row.task_type,
        description: '',
        successfulPatterns: row.success_patterns_json ? JSON.parse(row.success_patterns_json) : [],
        failurePatterns: row.failure_patterns_json ? JSON.parse(row.failure_patterns_json) : [],
        examplePrompts: row.example_prompts_json ? JSON.parse(row.example_prompts_json) : [],
        sampleSize: row.success_count + row.failure_count,
        avgSuccessRate: row.success_count / Math.max(1, row.success_count + row.failure_count),
        lastUpdated: row.last_updated,
      };
      this.experiences.set(row.task_type, experience);
    }

    // Load insights
    const insightRows = this.db.getInsights();
    for (const row of insightRows) {
      const insight: LearningInsight = {
        id: row.id,
        type: row.type as LearningInsight['type'],
        description: row.description || row.title,
        confidence: row.confidence,
        evidence: row.supporting_patterns_json ? JSON.parse(row.supporting_patterns_json) : [],
        taskTypes: [],
        createdAt: row.created_at,
        appliedCount: 0,
        successRate: 0,
      };
      this.insights.push(insight);
    }

    this.emit('persistence:loaded', {
      outcomes: outcomeRows.length,
      patterns: patternRows.length,
      experiences: experienceRows.length,
      insights: insightRows.length,
    });
  }

  /**
   * Check if persistence is available
   */
  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled && this.db !== null;
  }

  configure(config: Partial<SelfImprovementConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SelfImprovementConfig {
    return { ...this.config };
  }

  // ============ Outcome Recording ============

  recordOutcome(outcome: Omit<TaskOutcome, 'id' | 'patterns' | 'timestamp'>): TaskOutcome {
    const fullOutcome: TaskOutcome = {
      ...outcome,
      id: `outcome-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      patterns: this.extractPatterns(outcome),
      timestamp: Date.now(),
    };

    this.outcomes.push(fullOutcome);
    this.updatePatterns(fullOutcome);
    this.updateExperience(fullOutcome);
    this.checkForInsights();

    // Persist outcome to database
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.addOutcome({
          id: fullOutcome.id,
          taskType: fullOutcome.taskType,
          success: fullOutcome.success,
          timestamp: fullOutcome.timestamp,
          durationMs: fullOutcome.duration,
          tokenUsage: fullOutcome.tokensUsed,
          agentId: fullOutcome.agentUsed,
          model: fullOutcome.modelUsed,
          errorType: fullOutcome.errorType,
          promptHash: this.hashPrompt(fullOutcome.prompt),
          tools: fullOutcome.toolsUsed.map(t => t.tool),
          metadata: {
            taskDescription: fullOutcome.taskDescription,
            userSatisfaction: fullOutcome.userSatisfaction,
          },
        });
      } catch (error) {
        logger.error('Failed to persist outcome', error instanceof Error ? error : undefined);
      }
    }

    this.emit('outcome:recorded', fullOutcome);

    // Cleanup old outcomes
    this.pruneOldData();

    return fullOutcome;
  }

  /**
   * Generate a hash of the prompt for storage (privacy-preserving)
   */
  private hashPrompt(prompt: string): string {
    return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
  }

  private extractPatterns(outcome: Omit<TaskOutcome, 'id' | 'patterns' | 'timestamp'>): TaskPattern[] {
    const patterns: TaskPattern[] = [];
    const now = Date.now();

    // Tool sequence pattern
    if (outcome.toolsUsed.length > 1) {
      const sequence = outcome.toolsUsed
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(t => t.tool)
        .join(' → ');

      patterns.push({
        type: 'tool_sequence',
        value: sequence,
        effectiveness: outcome.success ? 1 : 0,
        sampleSize: 1,
        lastUpdated: now,
      });
    }

    // Agent-task pairing
    patterns.push({
      type: 'agent_task_pairing',
      value: `${outcome.agentUsed}:${outcome.taskType}`,
      effectiveness: outcome.success ? 1 : 0,
      sampleSize: 1,
      lastUpdated: now,
    });

    // Model-task pairing
    patterns.push({
      type: 'model_task_pairing',
      value: `${outcome.modelUsed}:${outcome.taskType}`,
      effectiveness: outcome.success ? 1 : 0,
      sampleSize: 1,
      lastUpdated: now,
    });

    // Error recovery pattern
    if (!outcome.success && outcome.errorType) {
      patterns.push({
        type: 'error_recovery',
        value: `${outcome.taskType}:${outcome.errorType}`,
        effectiveness: 0,
        sampleSize: 1,
        lastUpdated: now,
      });
    }

    // Prompt structure pattern (extract key phrases)
    const promptPatterns = this.extractPromptPatterns(outcome.prompt, outcome.success);
    patterns.push(...promptPatterns);

    return patterns;
  }

  private extractPromptPatterns(prompt: string, success: boolean): TaskPattern[] {
    const patterns: TaskPattern[] = [];
    const now = Date.now();

    // Look for common patterns in prompts
    const patternMatches = [
      { regex: /step[- ]by[- ]step/i, name: 'step-by-step' },
      { regex: /think.*through/i, name: 'think-through' },
      { regex: /first.*then/i, name: 'first-then-sequence' },
      { regex: /be (precise|specific|detailed)/i, name: 'precision-request' },
      { regex: /example/i, name: 'example-included' },
      { regex: /constraint/i, name: 'constraints-specified' },
      { regex: /don't|do not|avoid/i, name: 'negative-constraints' },
    ];

    for (const pattern of patternMatches) {
      if (pattern.regex.test(prompt)) {
        patterns.push({
          type: 'prompt_structure',
          value: pattern.name,
          effectiveness: success ? 1 : 0,
          sampleSize: 1,
          lastUpdated: now,
        });
      }
    }

    return patterns;
  }

  private updatePatterns(outcome: TaskOutcome): void {
    for (const pattern of outcome.patterns) {
      const key = `${pattern.type}:${pattern.value}`;
      const existing = this.patterns.get(key);

      if (existing) {
        // Exponential moving average
        const alpha = 1 / (existing.sampleSize + 1);
        existing.effectiveness =
          (1 - alpha) * existing.effectiveness * this.config.patternDecayRate +
          alpha * pattern.effectiveness;
        existing.sampleSize++;
        existing.lastUpdated = Date.now();

        // Persist pattern update
        if (this.db && this.persistenceEnabled) {
          try {
            this.db.upsertPattern({
              id: `pattern-${key.replace(/[^a-zA-Z0-9]/g, '-')}`,
              type: pattern.type,
              key: pattern.value,
              effectiveness: existing.effectiveness,
              sampleSize: existing.sampleSize,
            });
          } catch (error) {
            logger.error('Failed to persist pattern', error instanceof Error ? error : undefined);
          }
        }
      } else {
        this.patterns.set(key, { ...pattern });

        // Persist new pattern
        if (this.db && this.persistenceEnabled) {
          try {
            this.db.upsertPattern({
              id: `pattern-${key.replace(/[^a-zA-Z0-9]/g, '-')}`,
              type: pattern.type,
              key: pattern.value,
              effectiveness: pattern.effectiveness,
              sampleSize: pattern.sampleSize,
            });
          } catch (error) {
            logger.error('Failed to persist new pattern', error instanceof Error ? error : undefined);
          }
        }
      }
    }
  }

  private updateExperience(outcome: TaskOutcome): void {
    let experience = this.experiences.get(outcome.taskType);

    if (!experience) {
      experience = {
        id: `exp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        taskType: outcome.taskType,
        description: outcome.taskDescription,
        successfulPatterns: [],
        failurePatterns: [],
        examplePrompts: [],
        sampleSize: 0,
        avgSuccessRate: 0,
        lastUpdated: Date.now(),
      };
      this.experiences.set(outcome.taskType, experience);
    }

    // Update patterns
    for (const pattern of outcome.patterns) {
      const targetList = outcome.success ? experience.successfulPatterns : experience.failurePatterns;
      const existingIdx = targetList.findIndex(p => p.type === pattern.type && p.value === pattern.value);

      if (existingIdx >= 0) {
        const existing = targetList[existingIdx];
        const alpha = 1 / (existing.sampleSize + 1);
        existing.effectiveness =
          (1 - alpha) * existing.effectiveness + alpha * pattern.effectiveness;
        existing.sampleSize++;
        existing.lastUpdated = Date.now();
      } else {
        targetList.push({ ...pattern });
      }
    }

    // Add example prompt (limit to 10 per task type)
    if (experience.examplePrompts.length < 10) {
      const example: ExamplePrompt = {
        prompt: outcome.prompt.slice(0, 500), // Truncate for storage
        context: outcome.context?.slice(0, 200),
        outcome: outcome.success ? 'success' : 'failure',
        lessonsLearned: outcome.patterns.map(p => `${p.type}: ${p.value}`),
      };
      experience.examplePrompts.push(example);
    }

    // Update stats
    experience.sampleSize++;
    experience.avgSuccessRate =
      (experience.avgSuccessRate * (experience.sampleSize - 1) + (outcome.success ? 1 : 0)) /
      experience.sampleSize;
    experience.lastUpdated = Date.now();

    // Persist experience to database
    if (this.db && this.persistenceEnabled) {
      try {
        const successCount = Math.round(experience.avgSuccessRate * experience.sampleSize);
        this.db.upsertExperience({
          id: experience.id,
          taskType: experience.taskType,
          successCount,
          failureCount: experience.sampleSize - successCount,
          successPatterns: experience.successfulPatterns.map(p => `${p.type}:${p.value}`),
          failurePatterns: experience.failurePatterns.map(p => `${p.type}:${p.value}`),
          examplePrompts: experience.examplePrompts.map(e => e.prompt.slice(0, 200)),
        });
      } catch (error) {
        logger.error('Failed to persist experience', error instanceof Error ? error : undefined);
      }
    }
  }

  private checkForInsights(): void {
    // Check for patterns that have enough samples and high/low effectiveness
    for (const [key, pattern] of this.patterns) {
      if (pattern.sampleSize < this.config.minSampleSize) continue;

      // Check if this pattern is already captured in an insight
      const existingInsight = this.insights.find(
        i => i.evidence.includes(key) && Date.now() - i.createdAt < 7 * 24 * 60 * 60 * 1000
      );
      if (existingInsight) continue;

      // High effectiveness pattern
      if (pattern.effectiveness >= this.config.insightThreshold) {
        this.createInsight('pattern', pattern, key);
      }

      // Low effectiveness pattern (anti-pattern)
      if (pattern.effectiveness <= 1 - this.config.insightThreshold) {
        this.createInsight('anti-pattern', pattern, key);
      }
    }
  }

  private createInsight(type: LearningInsight['type'], pattern: TaskPattern, key: string): void {
    const [patternType, value] = key.split(':');
    const taskTypes = this.extractTaskTypesFromPattern(pattern);

    const insight: LearningInsight = {
      id: `insight-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      description: this.generateInsightDescription(type, patternType as PatternType, value, pattern),
      confidence: Math.abs(pattern.effectiveness - 0.5) * 2, // 0 at 50%, 1 at 0% or 100%
      evidence: [key],
      taskTypes,
      createdAt: Date.now(),
      appliedCount: 0,
      successRate: 0,
    };

    this.insights.push(insight);

    // Persist insight to database
    if (this.db && this.persistenceEnabled) {
      try {
        this.db.addInsight({
          id: insight.id,
          type: insight.type,
          title: `${type}: ${patternType}`,
          description: insight.description,
          confidence: insight.confidence,
          supportingPatterns: insight.evidence,
        });
      } catch (error) {
        logger.error('Failed to persist insight', error instanceof Error ? error : undefined);
      }
    }

    this.emit('insight:created', insight);
  }

  private generateInsightDescription(
    type: string,
    patternType: PatternType,
    value: string,
    pattern: TaskPattern
  ): string {
    const effectiveness = Math.round(pattern.effectiveness * 100);

    switch (patternType) {
      case 'tool_sequence':
        return type === 'pattern'
          ? `Tool sequence "${value}" has ${effectiveness}% success rate`
          : `Tool sequence "${value}" has low success (${effectiveness}%)`;

      case 'agent_task_pairing':
        const [agent, task] = value.split(':');
        return type === 'pattern'
          ? `Agent "${agent}" is effective for "${task}" tasks (${effectiveness}%)`
          : `Agent "${agent}" struggles with "${task}" tasks (${effectiveness}%)`;

      case 'model_task_pairing':
        const [model, taskType] = value.split(':');
        return type === 'pattern'
          ? `Model "${model}" performs well on "${taskType}" (${effectiveness}%)`
          : `Model "${model}" underperforms on "${taskType}" (${effectiveness}%)`;

      case 'prompt_structure':
        return type === 'pattern'
          ? `Prompt structure "${value}" improves success (${effectiveness}%)`
          : `Prompt structure "${value}" correlates with failure (${effectiveness}%)`;

      case 'error_recovery':
        return `Error pattern "${value}" needs attention (${pattern.sampleSize} occurrences)`;

      default:
        return `${type}: ${value} (${effectiveness}% effectiveness)`;
    }
  }

  private extractTaskTypesFromPattern(pattern: TaskPattern): string[] {
    // Extract task type from pattern value if applicable
    const taskTypes: string[] = [];

    if (pattern.type === 'agent_task_pairing' || pattern.type === 'model_task_pairing') {
      const parts = pattern.value.split(':');
      if (parts.length > 1) {
        taskTypes.push(parts[1]);
      }
    }

    return taskTypes;
  }

  private pruneOldData(): void {
    const retentionMs = this.config.experienceRetention * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;

    // Prune old outcomes
    this.outcomes = this.outcomes.filter(o => o.timestamp > cutoff);

    // Keep within limits
    if (this.outcomes.length > this.config.maxExperiences) {
      this.outcomes = this.outcomes.slice(-this.config.maxExperiences);
    }

    // Prune stale patterns
    for (const [key, pattern] of this.patterns) {
      if (pattern.lastUpdated < cutoff && pattern.sampleSize < this.config.minSampleSize) {
        this.patterns.delete(key);
      }
    }
  }

  // ============ Query Methods ============

  getOutcome(outcomeId: string): TaskOutcome | undefined {
    return this.outcomes.find(o => o.id === outcomeId);
  }

  getRecentOutcomes(limit: number = 50): TaskOutcome[] {
    return this.outcomes.slice(-limit);
  }

  getOutcomesByTaskType(taskType: string, limit: number = 50): TaskOutcome[] {
    return this.outcomes.filter(o => o.taskType === taskType).slice(-limit);
  }

  getExperience(taskType: string): Experience | undefined {
    return this.experiences.get(taskType);
  }

  getAllExperiences(): Experience[] {
    return Array.from(this.experiences.values());
  }

  getInsights(taskType?: string, minConfidence?: number): LearningInsight[] {
    let filtered = this.insights;

    if (taskType) {
      filtered = filtered.filter(i => i.taskTypes.length === 0 || i.taskTypes.includes(taskType));
    }

    if (minConfidence !== undefined) {
      filtered = filtered.filter(i => i.confidence >= minConfidence);
    }

    return filtered.sort((a, b) => b.confidence - a.confidence);
  }

  getPattern(type: PatternType, value: string): TaskPattern | undefined {
    return this.patterns.get(`${type}:${value}`);
  }

  getPatternsByType(type: PatternType): TaskPattern[] {
    const results: TaskPattern[] = [];
    for (const [key, pattern] of this.patterns) {
      if (key.startsWith(`${type}:`)) {
        results.push(pattern);
      }
    }
    return results.sort((a, b) => b.effectiveness - a.effectiveness);
  }

  getTopPatterns(limit: number = 10): TaskPattern[] {
    return Array.from(this.patterns.values())
      .filter(p => p.sampleSize >= this.config.minSampleSize)
      .sort((a, b) => b.effectiveness - a.effectiveness)
      .slice(0, limit);
  }

  // ============ Statistics ============

  getStats(): LearningStats {
    const successfulOutcomes = this.outcomes.filter(o => o.success).length;
    const avgSatisfaction =
      this.outcomes.filter(o => o.userSatisfaction).length > 0
        ? this.outcomes.reduce((sum, o) => sum + (o.userSatisfaction || 0), 0) /
          this.outcomes.filter(o => o.userSatisfaction).length
        : 0;

    return {
      totalOutcomes: this.outcomes.length,
      successRate: this.outcomes.length > 0 ? successfulOutcomes / this.outcomes.length : 0,
      patternCount: this.patterns.size,
      insightCount: this.insights.length,
      experienceCount: this.experiences.size,
      avgSatisfaction,
      topPatterns: this.getTopPatterns(5),
      recentInsights: this.insights.slice(-5),
      activeABTests: 0, // Will be managed by ABTestManager
    };
  }

  getTaskTypeStats(taskType: string): TaskTypeStats | undefined {
    const typeOutcomes = this.outcomes.filter(o => o.taskType === taskType);
    if (typeOutcomes.length === 0) return undefined;

    const successfulOutcomes = typeOutcomes.filter(o => o.success);

    // Agent stats
    const agentStats = new Map<string, { success: number; total: number }>();
    for (const o of typeOutcomes) {
      const stats = agentStats.get(o.agentUsed) || { success: 0, total: 0 };
      stats.total++;
      if (o.success) stats.success++;
      agentStats.set(o.agentUsed, stats);
    }

    // Model stats
    const modelStats = new Map<string, { success: number; total: number }>();
    for (const o of typeOutcomes) {
      const stats = modelStats.get(o.modelUsed) || { success: 0, total: 0 };
      stats.total++;
      if (o.success) stats.success++;
      modelStats.set(o.modelUsed, stats);
    }

    // Error stats
    const errorStats = new Map<string, number>();
    for (const o of typeOutcomes) {
      if (o.errorType) {
        errorStats.set(o.errorType, (errorStats.get(o.errorType) || 0) + 1);
      }
    }

    return {
      taskType,
      totalOutcomes: typeOutcomes.length,
      successRate: successfulOutcomes.length / typeOutcomes.length,
      avgDuration: typeOutcomes.reduce((sum, o) => sum + o.duration, 0) / typeOutcomes.length,
      avgTokens: typeOutcomes.reduce((sum, o) => sum + o.tokensUsed, 0) / typeOutcomes.length,
      topAgents: Array.from(agentStats.entries())
        .map(([agent, stats]) => ({ agent, successRate: stats.success / stats.total }))
        .sort((a, b) => b.successRate - a.successRate)
        .slice(0, 5),
      topModels: Array.from(modelStats.entries())
        .map(([model, stats]) => ({ model, successRate: stats.success / stats.total }))
        .sort((a, b) => b.successRate - a.successRate)
        .slice(0, 5),
      commonErrors: Array.from(errorStats.entries())
        .map(([errorType, count]) => ({ errorType, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    };
  }

  // ============ User Feedback ============

  rateOutcome(outcomeId: string, satisfaction: number): boolean {
    const outcome = this.outcomes.find(o => o.id === outcomeId);
    if (!outcome) return false;

    outcome.userSatisfaction = Math.max(1, Math.min(5, satisfaction));
    this.emit('outcome:rated', outcome);
    return true;
  }

  // ============ Insight Management ============

  markInsightApplied(insightId: string, success: boolean): void {
    const insight = this.insights.find(i => i.id === insightId);
    if (!insight) return;

    insight.appliedCount++;
    const alpha = 1 / insight.appliedCount;
    insight.successRate = (1 - alpha) * insight.successRate + alpha * (success ? 1 : 0);
  }
}
