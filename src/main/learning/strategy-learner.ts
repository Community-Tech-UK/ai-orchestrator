/**
 * Strategy Learner
 * Learns optimal strategies for task execution based on outcomes
 *
 * Provides recommendations for:
 * - Agent selection
 * - Model selection
 * - Workflow selection
 * - Tool ordering
 */

import { EventEmitter } from 'events';
import {
  TaskOutcome,
  TaskPattern,
  Experience,
  StrategyRecommendation,
  AlternativeStrategy,
  PatternType,
} from '../../shared/types/self-improvement.types';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import { OutcomeTracker } from './outcome-tracker';

interface StrategyScore {
  agent: string;
  model: string;
  workflow?: string;
  score: number;
  sampleSize: number;
  reasoning: string[];
}

export class StrategyLearner extends EventEmitter {
  private static instance: StrategyLearner;
  private outcomeTracker: OutcomeTracker;

  // Cache for quick lookups
  private recommendationCache: Map<string, { recommendation: StrategyRecommendation; timestamp: number }> =
    new Map();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes

  static getInstance(): StrategyLearner {
    if (!this.instance) {
      this.instance = new StrategyLearner();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.outcomeTracker = OutcomeTracker.getInstance();

    // Listen for new outcomes to invalidate cache
    this.outcomeTracker.on('outcome:recorded', (outcome: TaskOutcome) => {
      this.invalidateCacheForTaskType(outcome.taskType);
    });

    // Listen for observation events to invalidate cache (lazy binding)
    // ObserverAgent may not be initialized yet, so defer the binding
    setTimeout(() => {
      import('../observation/observer-agent')
        .then(({ getObserverAgent }) => {
          const observer = getObserverAgent();
          observer.on('observer:observation-created', () => {
            // Clear entire cache since observations may affect any task type
            this.recommendationCache.clear();
          });
        })
        .catch(() => {
          // Observation system not available - graceful degradation
        });
    }, 0);
  }

  private invalidateCacheForTaskType(taskType: string): void {
    for (const [key] of this.recommendationCache) {
      if (key.includes(taskType)) {
        this.recommendationCache.delete(key);
      }
    }
  }

  // ============ Strategy Recommendation ============

  getRecommendation(
    taskType: string,
    taskDescription?: string,
    context?: string
  ): StrategyRecommendation {
    const cacheKey = `${taskType}:${taskDescription?.slice(0, 50) || ''}`;

    // Check cache
    const cached = this.recommendationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.recommendation;
    }

    // Get experience for this task type
    const experience = this.outcomeTracker.getExperience(taskType);

    // Get relevant patterns
    const agentPatterns = this.outcomeTracker.getPatternsByType('agent_task_pairing');
    const modelPatterns = this.outcomeTracker.getPatternsByType('model_task_pairing');

    // Calculate strategy scores
    const strategies = this.calculateStrategyScores(taskType, agentPatterns, modelPatterns, experience);

    if (strategies.length === 0) {
      // No data - return default recommendation
      return this.getDefaultRecommendation(taskType);
    }

    // Sort by score
    strategies.sort((a, b) => b.score - a.score);

    const best = strategies[0];
    const alternatives: AlternativeStrategy[] = strategies.slice(1, 4).map(s => ({
      agent: s.agent,
      model: s.model,
      successRate: s.score,
      sampleSize: s.sampleSize,
    }));

    const recommendation: StrategyRecommendation = {
      taskType,
      recommendedAgent: best.agent,
      recommendedModel: best.model,
      suggestedWorkflow: best.workflow,
      confidence: this.calculateConfidence(best, strategies),
      reasoning: best.reasoning,
      alternatives,
    };

    // Cache the recommendation
    this.recommendationCache.set(cacheKey, {
      recommendation,
      timestamp: Date.now(),
    });

    this.emit('recommendation:generated', recommendation);
    return recommendation;
  }

  private calculateStrategyScores(
    taskType: string,
    agentPatterns: TaskPattern[],
    modelPatterns: TaskPattern[],
    experience?: Experience
  ): StrategyScore[] {
    const strategies: StrategyScore[] = [];
    const relevantAgentPatterns = agentPatterns.filter(p => p.value.endsWith(`:${taskType}`));
    const relevantModelPatterns = modelPatterns.filter(p => p.value.endsWith(`:${taskType}`));

    // Build combinations from patterns
    const agents = new Set<string>();
    const models = new Set<string>();

    for (const p of relevantAgentPatterns) {
      agents.add(p.value.split(':')[0]);
    }
    for (const p of relevantModelPatterns) {
      models.add(p.value.split(':')[0]);
    }

    // If no specific patterns, use general patterns
    if (agents.size === 0) {
      for (const p of agentPatterns) {
        if (p.effectiveness > 0.5) {
          agents.add(p.value.split(':')[0]);
        }
      }
    }
    if (models.size === 0) {
      for (const p of modelPatterns) {
        if (p.effectiveness > 0.5) {
          models.add(p.value.split(':')[0]);
        }
      }
    }

    // Calculate scores for each combination
    for (const agent of agents) {
      for (const model of models) {
        const score = this.calculateCombinationScore(agent, model, taskType, experience);
        if (score) {
          strategies.push(score);
        }
      }
    }

    return strategies;
  }

  private calculateCombinationScore(
    agent: string,
    model: string,
    taskType: string,
    experience?: Experience
  ): StrategyScore | null {
    const reasoning: string[] = [];
    let totalScore = 0;
    let weights = 0;

    // Agent effectiveness for this task type
    const agentPattern = this.outcomeTracker.getPattern('agent_task_pairing', `${agent}:${taskType}`);
    if (agentPattern && agentPattern.sampleSize >= 3) {
      totalScore += agentPattern.effectiveness * 0.4;
      weights += 0.4;
      reasoning.push(
        `Agent "${agent}" has ${Math.round(agentPattern.effectiveness * 100)}% success rate for ${taskType}`
      );
    }

    // Model effectiveness for this task type
    const modelPattern = this.outcomeTracker.getPattern('model_task_pairing', `${model}:${taskType}`);
    if (modelPattern && modelPattern.sampleSize >= 3) {
      totalScore += modelPattern.effectiveness * 0.3;
      weights += 0.3;
      reasoning.push(
        `Model "${model}" has ${Math.round(modelPattern.effectiveness * 100)}% success rate for ${taskType}`
      );
    }

    // General agent effectiveness (across all task types)
    const generalAgentPatterns = this.outcomeTracker
      .getPatternsByType('agent_task_pairing')
      .filter(p => p.value.startsWith(`${agent}:`));
    if (generalAgentPatterns.length > 0) {
      const avgEffectiveness =
        generalAgentPatterns.reduce((sum, p) => sum + p.effectiveness, 0) / generalAgentPatterns.length;
      totalScore += avgEffectiveness * 0.15;
      weights += 0.15;
    }

    // General model effectiveness
    const generalModelPatterns = this.outcomeTracker
      .getPatternsByType('model_task_pairing')
      .filter(p => p.value.startsWith(`${model}:`));
    if (generalModelPatterns.length > 0) {
      const avgEffectiveness =
        generalModelPatterns.reduce((sum, p) => sum + p.effectiveness, 0) / generalModelPatterns.length;
      totalScore += avgEffectiveness * 0.15;
      weights += 0.15;
    }

    if (weights === 0) return null;

    const normalizedScore = totalScore / weights;
    const sampleSize = (agentPattern?.sampleSize || 0) + (modelPattern?.sampleSize || 0);

    return {
      agent,
      model,
      score: normalizedScore,
      sampleSize,
      reasoning,
    };
  }

  private calculateConfidence(best: StrategyScore, all: StrategyScore[]): number {
    // Confidence based on:
    // 1. Sample size (more data = higher confidence)
    // 2. Gap to alternatives (bigger gap = higher confidence)
    // 3. Absolute score (higher score = higher confidence)

    const sampleConfidence = Math.min(1, best.sampleSize / 30); // Max confidence at 30 samples
    const scoreConfidence = best.score;

    let gapConfidence = 1;
    if (all.length > 1) {
      const gap = best.score - all[1].score;
      gapConfidence = Math.min(1, gap * 5); // 20% gap = full confidence
    }

    return (sampleConfidence * 0.3 + scoreConfidence * 0.4 + gapConfidence * 0.3);
  }

  private getDefaultRecommendation(taskType: string): StrategyRecommendation {
    // Default recommendations based on task type
    const defaults: Record<string, { agent: string; model: string; workflow?: string }> = {
      'feature-development': {
        agent: 'default',
        model: CLAUDE_MODELS.SONNET,
        workflow: 'feature-development',
      },
      'bug-fix': {
        agent: 'default',
        model: CLAUDE_MODELS.SONNET,
        workflow: 'bug-investigation',
      },
      review: {
        agent: 'review-specialist',
        model: CLAUDE_MODELS.SONNET,
        workflow: 'code-review',
      },
      'security-review': {
        agent: 'security-specialist',
        model: CLAUDE_MODELS.SONNET,
      },
      refactor: {
        agent: 'default',
        model: CLAUDE_MODELS.SONNET,
        workflow: 'refactoring',
      },
      testing: {
        agent: 'test-specialist',
        model: CLAUDE_MODELS.SONNET,
      },
    };

    const defaultConfig = defaults[taskType] || {
      agent: 'default',
      model: CLAUDE_MODELS.SONNET,
    };

    return {
      taskType,
      recommendedAgent: defaultConfig.agent,
      recommendedModel: defaultConfig.model,
      suggestedWorkflow: defaultConfig.workflow,
      confidence: 0.3, // Low confidence for defaults
      reasoning: ['No historical data available; using default configuration'],
      alternatives: [],
    };
  }

  // ============ Tool Sequence Recommendations ============

  getRecommendedToolSequence(taskType: string): string[] | null {
    const toolPatterns = this.outcomeTracker.getPatternsByType('tool_sequence');

    // Filter by sample size and effectiveness
    const effectivePatterns = toolPatterns.filter(p => p.sampleSize >= 5 && p.effectiveness > 0.7);

    if (effectivePatterns.length === 0) return null;

    // Return the most effective sequence
    const best = effectivePatterns[0];
    return best.value.split(' → ');
  }

  // ============ Error Recovery Recommendations ============

  getErrorRecoveryAdvice(taskType: string, errorType: string): string[] {
    const advice: string[] = [];

    // Look for recovery patterns
    const errorPatterns = this.outcomeTracker.getPatternsByType('error_recovery');
    const relevantPatterns = errorPatterns.filter(p => p.value === `${taskType}:${errorType}`);

    if (relevantPatterns.length > 0) {
      const pattern = relevantPatterns[0];
      advice.push(`This error has occurred ${pattern.sampleSize} times before.`);

      // Look for successful patterns after similar errors
      const experience = this.outcomeTracker.getExperience(taskType);
      if (experience) {
        const successfulAfterError = experience.successfulPatterns.filter(
          p => p.type === 'tool_sequence' && p.effectiveness > 0.8
        );
        if (successfulAfterError.length > 0) {
          advice.push(`Successful recovery often involves: ${successfulAfterError[0].value}`);
        }
      }
    }

    // Generic advice based on error type
    const genericAdvice: Record<string, string[]> = {
      timeout: [
        'Consider breaking the task into smaller subtasks',
        'Try a faster model for initial exploration',
      ],
      rate_limit: ['Reduce parallel agent count', 'Add delay between requests'],
      context_overflow: [
        'Summarize previous context before continuing',
        'Focus on most relevant files only',
      ],
      permission: ['Check tool permissions', 'Request elevated permissions if needed'],
    };

    if (genericAdvice[errorType]) {
      advice.push(...genericAdvice[errorType]);
    }

    return advice;
  }

  // ============ Statistics ============

  getStrategyStats(): {
    totalRecommendations: number;
    avgConfidence: number;
    topAgents: { agent: string; avgScore: number }[];
    topModels: { model: string; avgScore: number }[];
  } {
    const agentScores = new Map<string, { total: number; count: number }>();
    const modelScores = new Map<string, { total: number; count: number }>();

    for (const [, cached] of this.recommendationCache) {
      const rec = cached.recommendation;

      const agentStats = agentScores.get(rec.recommendedAgent) || { total: 0, count: 0 };
      agentStats.total += rec.confidence;
      agentStats.count++;
      agentScores.set(rec.recommendedAgent, agentStats);

      const modelStats = modelScores.get(rec.recommendedModel) || { total: 0, count: 0 };
      modelStats.total += rec.confidence;
      modelStats.count++;
      modelScores.set(rec.recommendedModel, modelStats);
    }

    const totalRecommendations = this.recommendationCache.size;
    const avgConfidence =
      totalRecommendations > 0
        ? Array.from(this.recommendationCache.values()).reduce(
            (sum, c) => sum + c.recommendation.confidence,
            0
          ) / totalRecommendations
        : 0;

    return {
      totalRecommendations,
      avgConfidence,
      topAgents: Array.from(agentScores.entries())
        .map(([agent, stats]) => ({ agent, avgScore: stats.total / stats.count }))
        .sort((a, b) => b.avgScore - a.avgScore)
        .slice(0, 5),
      topModels: Array.from(modelScores.entries())
        .map(([model, stats]) => ({ model, avgScore: stats.total / stats.count }))
        .sort((a, b) => b.avgScore - a.avgScore)
        .slice(0, 5),
    };
  }
}
