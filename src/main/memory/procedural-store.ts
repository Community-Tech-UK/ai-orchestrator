/**
 * Procedural Store
 * Specialized store for procedural memories (workflows and strategies)
 * Part of the unified memory system
 */

import { EventEmitter } from 'events';
import type {
  WorkflowMemory,
  StrategyMemory,
  StrategyOutcome,
} from '../../shared/types/unified-memory.types';

export interface ProceduralStoreConfig {
  maxWorkflows: number;
  maxStrategies: number;
  minSuccessRateForPromotion: number;
  minUsageForPromotion: number;
  strategyDecayDays: number;
}

export interface WorkflowQuery {
  contextMatch?: string;
  minSuccessRate?: number;
  includeSteps?: boolean;
  limit?: number;
}

export interface StrategyQuery {
  conditionMatch?: string;
  minSuccessRate?: number;
  minOutcomes?: number;
  limit?: number;
}

export interface ProceduralStats {
  totalWorkflows: number;
  totalStrategies: number;
  avgWorkflowSuccessRate: number;
  avgStrategySuccessRate: number;
  topWorkflows: WorkflowMemory[];
  topStrategies: StrategyMemory[];
}

export interface WorkflowRecommendation {
  workflow: WorkflowMemory;
  confidence: number;
  matchedContexts: string[];
}

export interface StrategyRecommendation {
  strategy: StrategyMemory;
  confidence: number;
  matchedConditions: string[];
  recentSuccessRate: number;
}

export class ProceduralStore extends EventEmitter {
  private static instance: ProceduralStore;
  private config: ProceduralStoreConfig;
  private workflows: WorkflowMemory[] = [];
  private strategies: StrategyMemory[] = [];

  private defaultConfig: ProceduralStoreConfig = {
    maxWorkflows: 200,
    maxStrategies: 500,
    minSuccessRateForPromotion: 0.7,
    minUsageForPromotion: 3,
    strategyDecayDays: 30,
  };

  static getInstance(): ProceduralStore {
    if (!this.instance) {
      this.instance = new ProceduralStore();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<ProceduralStoreConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Workflow Management ============

  addWorkflow(workflow: WorkflowMemory): void {
    // Check for duplicate
    const existing = this.workflows.find(w => w.name === workflow.name);
    if (existing) {
      // Update existing workflow
      existing.steps = workflow.steps;
      existing.applicableContexts = [
        ...new Set([...existing.applicableContexts, ...workflow.applicableContexts]),
      ];
      this.emit('workflow:updated', existing);
      return;
    }

    this.workflows.push(workflow);

    // Enforce max limit
    if (this.workflows.length > this.config.maxWorkflows) {
      this.workflows.sort((a, b) => b.successRate - a.successRate);
      this.workflows = this.workflows.slice(0, this.config.maxWorkflows);
    }

    this.emit('workflow:added', workflow);
  }

  getWorkflow(workflowId: string): WorkflowMemory | undefined {
    return this.workflows.find(w => w.id === workflowId);
  }

  getWorkflowByName(name: string): WorkflowMemory | undefined {
    return this.workflows.find(w => w.name.toLowerCase() === name.toLowerCase());
  }

  queryWorkflows(query: WorkflowQuery): WorkflowMemory[] {
    let results = [...this.workflows];

    if (query.contextMatch) {
      const match = query.contextMatch.toLowerCase();
      results = results.filter(w =>
        w.applicableContexts.some(c => c.toLowerCase().includes(match)) ||
        w.name.toLowerCase().includes(match)
      );
    }

    if (query.minSuccessRate !== undefined) {
      results = results.filter(w => w.successRate >= query.minSuccessRate!);
    }

    results.sort((a, b) => b.successRate - a.successRate);

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  recommendWorkflows(context: string): WorkflowRecommendation[] {
    const contextKeywords = this.extractKeywords(context);

    const recommendations: WorkflowRecommendation[] = [];

    for (const workflow of this.workflows) {
      const matchedContexts: string[] = [];
      let totalScore = 0;

      for (const wfContext of workflow.applicableContexts) {
        const contextWords = this.extractKeywords(wfContext);
        const score = this.calculateOverlap(contextKeywords, contextWords);

        if (score > 0.2) {
          matchedContexts.push(wfContext);
          totalScore += score;
        }
      }

      // Also check workflow name
      const nameScore = this.calculateOverlap(contextKeywords, this.extractKeywords(workflow.name));
      totalScore += nameScore * 2; // Weight name matches higher

      if (matchedContexts.length > 0 || nameScore > 0.3) {
        recommendations.push({
          workflow,
          confidence: Math.min(1, (totalScore / Math.max(matchedContexts.length, 1)) * workflow.successRate),
          matchedContexts,
        });
      }
    }

    recommendations.sort((a, b) => b.confidence - a.confidence);
    return recommendations.slice(0, 5);
  }

  recordWorkflowUsage(workflowId: string, success: boolean): void {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    // Update success rate using moving average
    const prevWeight = 0.9;
    workflow.successRate = workflow.successRate * prevWeight + (success ? 1 : 0) * (1 - prevWeight);

    this.emit('workflow:used', { workflowId, success, newSuccessRate: workflow.successRate });
  }

  // ============ Strategy Management ============

  addStrategy(strategy: StrategyMemory): void {
    // Check for similar strategy
    const existing = this.findSimilarStrategy(strategy);
    if (existing) {
      // Merge outcomes
      existing.outcomes.push(...strategy.outcomes);
      existing.conditions = [...new Set([...existing.conditions, ...strategy.conditions])];
      this.emit('strategy:merged', existing);
      return;
    }

    this.strategies.push(strategy);

    // Enforce max limit
    if (this.strategies.length > this.config.maxStrategies) {
      // Remove strategies with poor performance or low usage
      this.strategies.sort((a, b) => {
        const scoreA = this.calculateStrategyScore(a);
        const scoreB = this.calculateStrategyScore(b);
        return scoreB - scoreA;
      });
      this.strategies = this.strategies.slice(0, this.config.maxStrategies);
    }

    this.emit('strategy:added', strategy);
  }

  private findSimilarStrategy(strategy: StrategyMemory): StrategyMemory | undefined {
    const stratKeywords = this.extractKeywords(strategy.strategy);

    for (const existing of this.strategies) {
      const existingKeywords = this.extractKeywords(existing.strategy);
      const similarity = this.calculateOverlap(stratKeywords, existingKeywords);

      if (similarity > 0.7) {
        return existing;
      }
    }

    return undefined;
  }

  private calculateStrategyScore(strategy: StrategyMemory): number {
    const successRate = this.getStrategySuccessRate(strategy);
    const usageCount = strategy.outcomes.length;
    const recency = this.getStrategyRecency(strategy);

    return successRate * 0.5 + Math.min(usageCount / 10, 1) * 0.3 + recency * 0.2;
  }

  getStrategy(strategyId: string): StrategyMemory | undefined {
    return this.strategies.find(s => s.id === strategyId);
  }

  queryStrategies(query: StrategyQuery): StrategyMemory[] {
    let results = [...this.strategies];

    if (query.conditionMatch) {
      const match = query.conditionMatch.toLowerCase();
      results = results.filter(s => s.conditions.some(c => c.toLowerCase().includes(match)));
    }

    if (query.minSuccessRate !== undefined) {
      results = results.filter(s => this.getStrategySuccessRate(s) >= query.minSuccessRate!);
    }

    if (query.minOutcomes !== undefined) {
      results = results.filter(s => s.outcomes.length >= query.minOutcomes!);
    }

    results.sort((a, b) => this.getStrategySuccessRate(b) - this.getStrategySuccessRate(a));

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  recommendStrategies(conditions: string[]): StrategyRecommendation[] {
    const conditionKeywords = new Set<string>();
    for (const condition of conditions) {
      for (const keyword of this.extractKeywords(condition)) {
        conditionKeywords.add(keyword);
      }
    }

    const recommendations: StrategyRecommendation[] = [];

    for (const strategy of this.strategies) {
      const matchedConditions: string[] = [];

      for (const stratCondition of strategy.conditions) {
        const condWords = this.extractKeywords(stratCondition);
        const score = this.calculateOverlap(conditionKeywords, condWords);

        if (score > 0.3) {
          matchedConditions.push(stratCondition);
        }
      }

      if (matchedConditions.length > 0) {
        const successRate = this.getStrategySuccessRate(strategy);
        const recentSuccessRate = this.getRecentSuccessRate(strategy, 5);
        const matchRatio = matchedConditions.length / Math.max(strategy.conditions.length, 1);

        recommendations.push({
          strategy,
          confidence: matchRatio * successRate * 0.7 + recentSuccessRate * 0.3,
          matchedConditions,
          recentSuccessRate,
        });
      }
    }

    recommendations.sort((a, b) => b.confidence - a.confidence);
    return recommendations.slice(0, 5);
  }

  recordStrategyOutcome(strategyId: string, taskId: string, success: boolean, score: number): void {
    const strategy = this.strategies.find(s => s.id === strategyId);
    if (!strategy) return;

    const outcome: StrategyOutcome = {
      taskId,
      success,
      score,
      timestamp: Date.now(),
    };

    strategy.outcomes.push(outcome);

    // Keep outcomes manageable
    if (strategy.outcomes.length > 100) {
      strategy.outcomes = strategy.outcomes.slice(-100);
    }

    this.emit('strategy:outcomeRecorded', { strategyId, outcome });

    // Check for promotion to workflow
    this.checkStrategyPromotion(strategy);
  }

  private checkStrategyPromotion(strategy: StrategyMemory): void {
    const successRate = this.getStrategySuccessRate(strategy);
    const usageCount = strategy.outcomes.length;

    if (
      successRate >= this.config.minSuccessRateForPromotion &&
      usageCount >= this.config.minUsageForPromotion
    ) {
      // Promote to workflow
      const workflow: WorkflowMemory = {
        id: `wf-from-strat-${strategy.id}`,
        name: strategy.strategy,
        steps: [strategy.strategy], // Single-step workflow
        successRate,
        applicableContexts: strategy.conditions,
      };

      this.addWorkflow(workflow);
      this.emit('strategy:promoted', { strategyId: strategy.id, workflowId: workflow.id });
    }
  }

  // ============ Success Rate Calculation ============

  private getStrategySuccessRate(strategy: StrategyMemory): number {
    if (strategy.outcomes.length === 0) return 0;

    const successful = strategy.outcomes.filter(o => o.success).length;
    return successful / strategy.outcomes.length;
  }

  private getRecentSuccessRate(strategy: StrategyMemory, count: number): number {
    const recent = strategy.outcomes.slice(-count);
    if (recent.length === 0) return 0;

    const successful = recent.filter(o => o.success).length;
    return successful / recent.length;
  }

  private getStrategyRecency(strategy: StrategyMemory): number {
    if (strategy.outcomes.length === 0) return 0;

    const lastOutcome = strategy.outcomes[strategy.outcomes.length - 1];
    const daysSinceUse = (Date.now() - lastOutcome.timestamp) / (24 * 60 * 60 * 1000);

    return Math.max(0, 1 - daysSinceUse / this.config.strategyDecayDays);
  }

  // ============ Utilities ============

  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'and', 'or', 'but', 'if',
      'this', 'that', 'these', 'those', 'it', 'its',
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    return new Set(words);
  }

  private calculateOverlap(set1: Set<string>, set2: Set<string>): number {
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  // ============ Statistics ============

  getStats(): ProceduralStats {
    const avgWorkflowSuccessRate =
      this.workflows.length > 0
        ? this.workflows.reduce((sum, w) => sum + w.successRate, 0) / this.workflows.length
        : 0;

    const avgStrategySuccessRate =
      this.strategies.length > 0
        ? this.strategies.reduce((sum, s) => sum + this.getStrategySuccessRate(s), 0) /
          this.strategies.length
        : 0;

    const topWorkflows = this.queryWorkflows({ limit: 5, minSuccessRate: 0 });
    const topStrategies = this.queryStrategies({ limit: 5, minOutcomes: 0 });

    return {
      totalWorkflows: this.workflows.length,
      totalStrategies: this.strategies.length,
      avgWorkflowSuccessRate,
      avgStrategySuccessRate,
      topWorkflows,
      topStrategies,
    };
  }

  // ============ Persistence ============

  exportState(): {
    workflows: WorkflowMemory[];
    strategies: StrategyMemory[];
  } {
    return {
      workflows: this.workflows,
      strategies: this.strategies,
    };
  }

  importState(state: { workflows?: WorkflowMemory[]; strategies?: StrategyMemory[] }): void {
    if (state.workflows) {
      this.workflows = state.workflows;
    }
    if (state.strategies) {
      this.strategies = state.strategies;
    }

    this.emit('state:imported');
  }

  clear(): void {
    this.workflows = [];
    this.strategies = [];
    this.emit('store:cleared');
  }
}

// Export singleton getter
export function getProceduralStore(): ProceduralStore {
  return ProceduralStore.getInstance();
}
