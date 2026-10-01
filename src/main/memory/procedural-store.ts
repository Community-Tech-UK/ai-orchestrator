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
  WorkflowOutcome,
  FailurePattern,
  AvoidanceRule,
  WorkflowVersion,
} from '../../shared/types/unified-memory.types';

export interface ProceduralStoreConfig {
  maxWorkflows: number;
  maxStrategies: number;
  minSuccessRateForPromotion: number;
  minUsageForPromotion: number;
  strategyDecayDays: number;
  // Phase 4.1: Failure Analysis
  failureThresholdForAvoidance: number; // Number of same failures before creating avoidance rule
  maxAvoidanceRules: number;
  // Phase 4.2: Workflow Versioning
  maxVersionsPerWorkflow: number;
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
  // Phase 4.1: Failure Analysis
  totalAvoidanceRules: number;
  // Phase 4.2: Versioning stats
  workflowsWithVersions: number;
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
  private static instance: ProceduralStore | null = null;
  private config: ProceduralStoreConfig;
  private workflows: WorkflowMemory[] = [];
  private strategies: StrategyMemory[] = [];
  // Phase 4.1: Avoidance rules learned from repeated failures
  private avoidanceRules: AvoidanceRule[] = [];

  private defaultConfig: ProceduralStoreConfig = {
    maxWorkflows: 200,
    maxStrategies: 500,
    minSuccessRateForPromotion: 0.7,
    minUsageForPromotion: 3,
    strategyDecayDays: 30,
    // Phase 4.1: Failure Analysis
    failureThresholdForAvoidance: 3,
    maxAvoidanceRules: 100,
    // Phase 4.2: Workflow Versioning
    maxVersionsPerWorkflow: 10,
  };

  static getInstance(): ProceduralStore {
    if (!this.instance) {
      this.instance = new ProceduralStore();
    }
    return this.instance;
  }

  /**
   * Reset singleton instance (for testing only)
   */
  static resetInstance(): void {
    this.instance = undefined as unknown as ProceduralStore;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<ProceduralStoreConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): ProceduralStoreConfig {
    return { ...this.config };
  }

  // ============ Workflow Management ============

  addWorkflow(workflow: WorkflowMemory): void {
    // Check for duplicate
    const existing = this.workflows.find(w => w.name === workflow.name);
    if (existing) {
      // Use updateWorkflow for existing workflows to preserve versioning
      this.updateWorkflow(existing.id, workflow.steps, 'improvement');
      existing.applicableContexts = [
        ...new Set([...existing.applicableContexts, ...workflow.applicableContexts]),
      ];
      this.emit('workflow:updated', existing);
      return;
    }

    // Phase 4.2: Initialize versioning for new workflows
    const initialVersion: WorkflowVersion = {
      version: 1,
      steps: [...workflow.steps],
      createdAt: Date.now(),
      reason: 'initial',
    };
    workflow.versions = [initialVersion];
    workflow.currentVersion = 1;

    this.workflows.push(workflow);

    // Enforce max limit
    if (this.workflows.length > this.config.maxWorkflows) {
      this.workflows.sort((a, b) => b.successRate - a.successRate);
      this.workflows = this.workflows.slice(0, this.config.maxWorkflows);
    }

    this.emit('workflow:added', workflow);
  }

  /**
   * Update workflow with version tracking
   * Phase 4.2: Workflow Versioning
   */
  updateWorkflow(
    workflowId: string,
    newSteps: string[],
    reason: WorkflowVersion['reason']
  ): WorkflowVersion | null {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return null;

    // Initialize versions if not present (for backwards compatibility)
    if (!workflow.versions) {
      workflow.versions = [
        {
          version: 1,
          steps: [...workflow.steps],
          createdAt: Date.now() - 1000, // Slightly in the past
          reason: 'initial',
        },
      ];
      workflow.currentVersion = 1;
    }

    // Create new version
    const newVersion: WorkflowVersion = {
      version: workflow.versions.length + 1,
      steps: [...newSteps],
      createdAt: Date.now(),
      reason,
      parentVersion: workflow.currentVersion,
    };

    workflow.versions.push(newVersion);
    workflow.currentVersion = newVersion.version;
    workflow.steps = [...newSteps];

    // Keep last N versions
    if (workflow.versions.length > this.config.maxVersionsPerWorkflow) {
      workflow.versions = workflow.versions.slice(-this.config.maxVersionsPerWorkflow);
    }

    this.emit('workflow:versionCreated', {
      workflowId,
      version: newVersion,
      totalVersions: workflow.versions.length,
    });

    return newVersion;
  }

  /**
   * Rollback workflow to a previous version
   * Phase 4.2: Workflow Versioning
   */
  rollbackWorkflow(workflowId: string, targetVersion?: number): WorkflowVersion | null {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow || !workflow.versions || workflow.versions.length < 2) {
      return null;
    }

    // Find target version
    let target: WorkflowVersion | undefined;

    if (targetVersion !== undefined) {
      target = workflow.versions.find(v => v.version === targetVersion);
    } else {
      // Default: rollback to previous version
      target = workflow.versions[workflow.versions.length - 2];
    }

    if (!target) return null;

    // Update workflow to use target version's steps
    workflow.steps = [...target.steps];
    workflow.currentVersion = target.version;

    this.emit('workflow:rolledBack', {
      workflowId,
      fromVersion: workflow.versions[workflow.versions.length - 1].version,
      toVersion: target.version,
    });

    return target;
  }

  /**
   * Get version history for a workflow
   * Phase 4.2: Workflow Versioning
   */
  getWorkflowVersions(workflowId: string): WorkflowVersion[] {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow || !workflow.versions) return [];
    return [...workflow.versions];
  }

  /**
   * Get a specific version of a workflow
   * Phase 4.2: Workflow Versioning
   */
  getWorkflowVersion(workflowId: string, version: number): WorkflowVersion | null {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow || !workflow.versions) return null;
    return workflow.versions.find(v => v.version === version) || null;
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

  /**
   * Record workflow usage with optional failure analysis
   * Phase 4.1: Extended to track failure patterns
   */
  recordWorkflowUsage(workflowId: string, success: boolean): void;
  recordWorkflowUsage(workflowId: string, outcome: WorkflowOutcome): void;
  recordWorkflowUsage(workflowId: string, successOrOutcome: boolean | WorkflowOutcome): void {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) return;

    // Normalize input to WorkflowOutcome
    const outcome: WorkflowOutcome =
      typeof successOrOutcome === 'boolean'
        ? { taskId: '', success: successOrOutcome, score: successOrOutcome ? 1 : 0, timestamp: Date.now() }
        : successOrOutcome;

    // Update success rate using moving average
    const prevWeight = 0.9;
    workflow.successRate = workflow.successRate * prevWeight + (outcome.success ? 1 : 0) * (1 - prevWeight);

    // Initialize outcomes array if needed
    if (!workflow.outcomes) {
      workflow.outcomes = [];
    }
    workflow.outcomes.push(outcome);

    // Keep outcomes manageable
    if (workflow.outcomes.length > 100) {
      workflow.outcomes = workflow.outcomes.slice(-100);
    }

    // Phase 4.1: Track failure patterns
    if (!outcome.success && outcome.failureReason) {
      this.trackFailurePattern(workflow, outcome);
    }

    this.emit('workflow:used', {
      workflowId,
      success: outcome.success,
      newSuccessRate: workflow.successRate,
      outcome,
    });
  }

  /**
   * Track failure pattern for a workflow
   * Phase 4.1: Failure Analysis
   */
  private trackFailurePattern(workflow: WorkflowMemory, outcome: WorkflowOutcome): void {
    if (!workflow.failurePatterns) {
      workflow.failurePatterns = [];
    }

    const pattern: FailurePattern = {
      reason: outcome.failureReason!,
      pattern: outcome.errorPattern,
      feedback: outcome.userFeedback,
      timestamp: outcome.timestamp,
    };

    workflow.failurePatterns.push(pattern);

    // Keep failure patterns manageable
    if (workflow.failurePatterns.length > 50) {
      workflow.failurePatterns = workflow.failurePatterns.slice(-50);
    }

    this.emit('workflow:failureTracked', { workflowId: workflow.id, pattern });

    // Learn from failure
    this.learnFromFailure(workflow, outcome);
  }

  /**
   * Learn from workflow failures - creates avoidance rules when patterns repeat
   * Phase 4.1: Failure Analysis
   */
  private learnFromFailure(workflow: WorkflowMemory, outcome: WorkflowOutcome): void {
    if (!outcome.errorPattern) return;

    // Count recent occurrences of this error pattern
    const recentFailures = (workflow.failurePatterns || [])
      .filter(f => f.pattern === outcome.errorPattern)
      .slice(-this.config.failureThresholdForAvoidance);

    if (recentFailures.length >= this.config.failureThresholdForAvoidance) {
      this.createAvoidanceRule(workflow.id, outcome.errorPattern, outcome.userFeedback);
    }
  }

  /**
   * Create an avoidance rule when an error pattern repeats too often
   * Phase 4.1: Failure Analysis
   */
  createAvoidanceRule(
    workflowId: string,
    errorPattern: string,
    feedback?: string
  ): AvoidanceRule | null {
    // Check if rule already exists
    const existing = this.avoidanceRules.find(
      r => r.workflowId === workflowId && r.errorPattern === errorPattern
    );

    if (existing) {
      existing.occurrenceCount++;
      existing.learnedAt = Date.now();
      if (feedback) {
        existing.avoidanceStrategy = feedback;
      }
      this.emit('avoidanceRule:updated', existing);
      return existing;
    }

    const rule: AvoidanceRule = {
      id: `avoid-${workflowId}-${Date.now()}`,
      workflowId,
      errorPattern,
      avoidanceStrategy: feedback || `Avoid: ${errorPattern}`,
      learnedAt: Date.now(),
      occurrenceCount: this.config.failureThresholdForAvoidance,
    };

    this.avoidanceRules.push(rule);

    // Enforce max limit
    if (this.avoidanceRules.length > this.config.maxAvoidanceRules) {
      // Remove oldest rules
      this.avoidanceRules.sort((a, b) => b.learnedAt - a.learnedAt);
      this.avoidanceRules = this.avoidanceRules.slice(0, this.config.maxAvoidanceRules);
    }

    this.emit('avoidanceRule:created', rule);
    return rule;
  }

  /**
   * Get avoidance rules for a workflow or all rules
   * Phase 4.1: Failure Analysis
   */
  getAvoidanceRules(workflowId?: string): AvoidanceRule[] {
    if (workflowId) {
      return this.avoidanceRules.filter(r => r.workflowId === workflowId);
    }
    return [...this.avoidanceRules];
  }

  /**
   * Check if an error pattern should be avoided for a workflow
   * Phase 4.1: Failure Analysis
   */
  shouldAvoid(workflowId: string, context: string): AvoidanceRule | null {
    const rules = this.getAvoidanceRules(workflowId);
    const contextLower = context.toLowerCase();

    for (const rule of rules) {
      if (contextLower.includes(rule.errorPattern.toLowerCase())) {
        return rule;
      }
    }

    return null;
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

    // Phase 4.2: Count workflows with version history
    const workflowsWithVersions = this.workflows.filter(
      w => w.versions && w.versions.length > 1
    ).length;

    return {
      totalWorkflows: this.workflows.length,
      totalStrategies: this.strategies.length,
      avgWorkflowSuccessRate,
      avgStrategySuccessRate,
      topWorkflows,
      topStrategies,
      // Phase 4.1
      totalAvoidanceRules: this.avoidanceRules.length,
      // Phase 4.2
      workflowsWithVersions,
    };
  }

  // ============ Persistence ============

  exportState(): {
    workflows: WorkflowMemory[];
    strategies: StrategyMemory[];
    avoidanceRules: AvoidanceRule[];
  } {
    return {
      workflows: this.workflows,
      strategies: this.strategies,
      avoidanceRules: this.avoidanceRules,
    };
  }

  importState(state: {
    workflows?: WorkflowMemory[];
    strategies?: StrategyMemory[];
    avoidanceRules?: AvoidanceRule[];
  }): void {
    if (state.workflows) {
      this.workflows = state.workflows;
    }
    if (state.strategies) {
      this.strategies = state.strategies;
    }
    if (state.avoidanceRules) {
      this.avoidanceRules = state.avoidanceRules;
    }

    this.emit('state:imported');
  }

  clear(): void {
    this.workflows = [];
    this.strategies = [];
    this.avoidanceRules = [];
    this.emit('store:cleared');
  }
}

// Export singleton getter
export function getProceduralStore(): ProceduralStore {
  return ProceduralStore.getInstance();
}
