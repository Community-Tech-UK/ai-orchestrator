/**
 * A/B Testing Engine for Prompt Variations
 *
 * Tracks which prompt variations produce better outcomes through:
 * - Weighted random variant selection
 * - Outcome tracking with statistical analysis
 * - Automatic winner detection with confidence thresholds
 * - Session-based assignment for consistency
 */

import { EventEmitter } from 'events';
import { getRLMDatabase, RLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';

const logger = getLogger('ABTesting');

// ============================================
// Types
// ============================================

export interface Variant {
  id: string;
  name: string;
  template: string;
  weight: number; // 0-1, for weighted random selection
  metadata?: Record<string, unknown>;
}

export interface Experiment {
  id: string;
  name: string;
  description?: string;
  taskType: string;
  variants: Variant[];
  status: 'draft' | 'running' | 'paused' | 'completed';
  startedAt?: number;
  endedAt?: number;
  minSamples: number;
  confidenceThreshold: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExperimentResult {
  variantId: string;
  samples: number;
  successes: number;
  successRate: number;
  avgDuration: number;
  avgTokens: number;
  totalDuration: number;
  totalTokens: number;
}

export interface ExperimentOutcome {
  experimentId: string;
  variantId: string;
  success: boolean;
  duration?: number;
  tokens?: number;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ABTestingConfig {
  autoAssign: boolean;
  minSamplesPerVariant: number;
  confidenceThreshold: number;
  maxConcurrentExperiments: number;
  persistResults: boolean;
}

export interface ExperimentWinner {
  variant: Variant;
  confidence: number;
  improvement: number; // Percentage improvement over second best
}

export interface ExperimentStats {
  totalExperiments: number;
  running: number;
  completed: number;
  draft: number;
  paused: number;
  totalOutcomes: number;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: ABTestingConfig = {
  autoAssign: true,
  minSamplesPerVariant: 30,
  confidenceThreshold: 0.95,
  maxConcurrentExperiments: 5,
  persistResults: true,
};

// ============================================
// A/B Testing Engine
// ============================================

export class ABTestingEngine extends EventEmitter {
  private static instance: ABTestingEngine;
  private config: ABTestingConfig;
  private experiments: Map<string, Experiment> = new Map();
  private results: Map<string, Map<string, ExperimentResult>> = new Map();
  private outcomes: Map<string, ExperimentOutcome[]> = new Map();
  private assignments: Map<string, Map<string, string>> = new Map(); // experimentId -> sessionId -> variantId
  private db: RLMDatabase | null = null;

  private constructor(config: Partial<ABTestingConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializePersistence();
  }

  static getInstance(config?: Partial<ABTestingConfig>): ABTestingEngine {
    if (!this.instance) {
      this.instance = new ABTestingEngine(config);
    }
    return this.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    this.instance = undefined as unknown as ABTestingEngine;
  }

  // ============================================
  // Configuration
  // ============================================

  configure(config: Partial<ABTestingConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config:updated', this.config);
  }

  getConfig(): ABTestingConfig {
    return { ...this.config };
  }

  // ============================================
  // Persistence
  // ============================================

  private initializePersistence(): void {
    if (!this.config.persistResults) return;

    try {
      this.db = getRLMDatabase();
      this.loadFromPersistence();
    } catch (error) {
      logger.error('Failed to initialize persistence', error instanceof Error ? error : undefined);
    }
  }

  private loadFromPersistence(): void {
    if (!this.db) return;

    try {
      // Load experiments from patterns table with type='ab_experiment'
      const patterns = this.db.getPatterns('ab_experiment');
      for (const pattern of patterns) {
        try {
          const experiment = JSON.parse(pattern.metadata_json || '{}') as Experiment;
          if (experiment.id) {
            this.experiments.set(experiment.id, experiment);
            this.initializeResults(experiment);
          }
        } catch {
          // Skip malformed entries
        }
      }

      // Load outcomes from outcomes table with task_type starting with 'ab_'
      const outcomes = this.db.getOutcomes({ taskType: 'ab_outcome' });
      for (const outcome of outcomes) {
        try {
          const data = JSON.parse(outcome.metadata_json || '{}') as {
            experimentId: string;
            variantId: string;
          };
          if (data.experimentId && data.variantId) {
            const experimentOutcome: ExperimentOutcome = {
              experimentId: data.experimentId,
              variantId: data.variantId,
              success: outcome.success === 1,
              duration: outcome.duration_ms || undefined,
              tokens: outcome.token_usage || undefined,
              timestamp: outcome.timestamp,
            };
            this.addOutcomeToMemory(experimentOutcome);
          }
        } catch {
          // Skip malformed entries
        }
      }

      this.emit('persistence:loaded', {
        experiments: this.experiments.size,
        outcomes: Array.from(this.outcomes.values()).reduce((sum, arr) => sum + arr.length, 0),
      });
    } catch (error) {
      logger.error('Failed to load from persistence', error instanceof Error ? error : undefined);
    }
  }

  private persistExperiment(experiment: Experiment): void {
    if (!this.db || !this.config.persistResults) return;

    try {
      this.db.upsertPattern({
        id: `ab-exp-${experiment.id}`,
        type: 'ab_experiment',
        key: experiment.id,
        effectiveness: experiment.status === 'completed' ? 1 : 0,
        sampleSize: this.getTotalSamples(experiment.id),
        metadata: experiment as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error('Failed to persist experiment', error instanceof Error ? error : undefined);
    }
  }

  private persistOutcome(outcome: ExperimentOutcome): void {
    if (!this.db || !this.config.persistResults) return;

    try {
      this.db.addOutcome({
        id: `ab-out-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        taskType: 'ab_outcome',
        success: outcome.success,
        timestamp: outcome.timestamp,
        durationMs: outcome.duration,
        tokenUsage: outcome.tokens,
        metadata: {
          experimentId: outcome.experimentId,
          variantId: outcome.variantId,
        },
      });
    } catch (error) {
      logger.error('Failed to persist outcome', error instanceof Error ? error : undefined);
    }
  }

  // ============================================
  // Experiment Management
  // ============================================

  /**
   * Create a new experiment
   */
  createExperiment(params: {
    name: string;
    description?: string;
    taskType: string;
    variants: Omit<Variant, 'id'>[];
    minSamples?: number;
    confidenceThreshold?: number;
  }): Experiment {
    const id = `exp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Generate IDs for variants and normalize weights
    const totalWeight = params.variants.reduce((sum, v) => sum + v.weight, 0);
    const variants: Variant[] = params.variants.map((v, i) => ({
      ...v,
      id: `var-${id}-${i}`,
      weight: totalWeight > 0 ? v.weight / totalWeight : 1 / params.variants.length,
    }));

    const experiment: Experiment = {
      id,
      name: params.name,
      description: params.description,
      taskType: params.taskType,
      variants,
      status: 'draft',
      minSamples: params.minSamples || this.config.minSamplesPerVariant,
      confidenceThreshold: params.confidenceThreshold || this.config.confidenceThreshold,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.experiments.set(id, experiment);
    this.initializeResults(experiment);
    this.persistExperiment(experiment);

    this.emit('experiment:created', experiment);
    return experiment;
  }

  /**
   * Initialize result tracking for an experiment
   */
  private initializeResults(experiment: Experiment): void {
    const resultMap = new Map<string, ExperimentResult>();

    for (const variant of experiment.variants) {
      resultMap.set(variant.id, {
        variantId: variant.id,
        samples: 0,
        successes: 0,
        successRate: 0,
        avgDuration: 0,
        avgTokens: 0,
        totalDuration: 0,
        totalTokens: 0,
      });
    }

    this.results.set(experiment.id, resultMap);
    this.outcomes.set(experiment.id, []);
    this.assignments.set(experiment.id, new Map());
  }

  /**
   * Update an experiment
   */
  updateExperiment(
    experimentId: string,
    updates: Partial<Pick<Experiment, 'name' | 'description' | 'minSamples' | 'confidenceThreshold'>>
  ): Experiment | null {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    // Only allow updates to draft or paused experiments
    if (experiment.status === 'running' || experiment.status === 'completed') {
      this.emit('error', {
        code: 'INVALID_STATE',
        message: `Cannot update experiment in ${experiment.status} state`,
      });
      return null;
    }

    Object.assign(experiment, updates, { updatedAt: Date.now() });
    this.persistExperiment(experiment);

    this.emit('experiment:updated', experiment);
    return experiment;
  }

  /**
   * Start an experiment
   */
  startExperiment(experimentId: string): boolean {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      this.emit('error', { code: 'NOT_FOUND', message: 'Experiment not found' });
      return false;
    }

    if (experiment.status === 'running') {
      return true; // Already running
    }

    if (experiment.status === 'completed') {
      this.emit('error', { code: 'INVALID_STATE', message: 'Cannot restart completed experiment' });
      return false;
    }

    // Check concurrent experiment limit
    const runningCount = Array.from(this.experiments.values()).filter(
      (e) => e.status === 'running'
    ).length;

    if (runningCount >= this.config.maxConcurrentExperiments) {
      this.emit('error', {
        code: 'LIMIT_REACHED',
        message: `Maximum concurrent experiments (${this.config.maxConcurrentExperiments}) reached`,
      });
      return false;
    }

    experiment.status = 'running';
    experiment.startedAt = experiment.startedAt || Date.now();
    experiment.updatedAt = Date.now();
    this.persistExperiment(experiment);

    this.emit('experiment:started', experiment);
    return true;
  }

  /**
   * Pause an experiment
   */
  pauseExperiment(experimentId: string): boolean {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return false;

    if (experiment.status !== 'running') return false;

    experiment.status = 'paused';
    experiment.updatedAt = Date.now();
    this.persistExperiment(experiment);

    this.emit('experiment:paused', experiment);
    return true;
  }

  /**
   * Complete an experiment manually
   */
  completeExperiment(experimentId: string): { experiment: Experiment; winner: ExperimentWinner | null } | null {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    experiment.status = 'completed';
    experiment.endedAt = Date.now();
    experiment.updatedAt = Date.now();
    this.persistExperiment(experiment);

    const winner = this.getWinner(experimentId);

    this.emit('experiment:completed', { experiment, winner });
    return { experiment, winner };
  }

  /**
   * Delete an experiment
   */
  deleteExperiment(experimentId: string): boolean {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return false;

    this.experiments.delete(experimentId);
    this.results.delete(experimentId);
    this.outcomes.delete(experimentId);
    this.assignments.delete(experimentId);

    this.emit('experiment:deleted', { experimentId });
    return true;
  }

  // ============================================
  // Variant Selection
  // ============================================

  /**
   * Get a variant for a task type, with optional session-based assignment
   */
  getVariant(taskType: string, sessionId?: string): { experiment: Experiment; variant: Variant } | null {
    // Find running experiment for this task type
    const experiment = Array.from(this.experiments.values()).find(
      (e) => e.taskType === taskType && e.status === 'running'
    );

    if (!experiment) return null;

    // Check for existing assignment
    if (sessionId) {
      const experimentAssignments = this.assignments.get(experiment.id);
      if (experimentAssignments?.has(sessionId)) {
        const variantId = experimentAssignments.get(sessionId)!;
        const variant = experiment.variants.find((v) => v.id === variantId);
        if (variant) {
          return { experiment, variant };
        }
      }
    }

    // Weighted random selection
    const variant = this.selectWeightedVariant(experiment.variants);

    // Store assignment for session consistency
    if (sessionId) {
      let experimentAssignments = this.assignments.get(experiment.id);
      if (!experimentAssignments) {
        experimentAssignments = new Map();
        this.assignments.set(experiment.id, experimentAssignments);
      }
      experimentAssignments.set(sessionId, variant.id);
    }

    this.emit('variant:assigned', { experiment, variant, sessionId });
    return { experiment, variant };
  }

  /**
   * Get a specific variant by ID
   */
  getVariantById(experimentId: string, variantId: string): Variant | null {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;
    return experiment.variants.find((v) => v.id === variantId) || null;
  }

  /**
   * Select a variant using weighted random selection
   */
  private selectWeightedVariant(variants: Variant[]): Variant {
    const random = Math.random();
    let cumulative = 0;

    for (const variant of variants) {
      cumulative += variant.weight;
      if (random <= cumulative) {
        return variant;
      }
    }

    // Fallback to last variant (shouldn't normally happen)
    return variants[variants.length - 1];
  }

  // ============================================
  // Outcome Recording
  // ============================================

  /**
   * Record an outcome for a variant
   */
  recordOutcome(
    experimentId: string,
    variantId: string,
    outcome: { success: boolean; duration?: number; tokens?: number; metadata?: Record<string, unknown> }
  ): void {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      this.emit('error', { code: 'NOT_FOUND', message: 'Experiment not found' });
      return;
    }

    const experimentResults = this.results.get(experimentId);
    if (!experimentResults) return;

    const result = experimentResults.get(variantId);
    if (!result) {
      this.emit('error', { code: 'NOT_FOUND', message: 'Variant not found' });
      return;
    }

    // Update result statistics
    result.samples++;
    if (outcome.success) {
      result.successes++;
    }
    result.successRate = result.samples > 0 ? result.successes / result.samples : 0;

    if (outcome.duration !== undefined) {
      result.totalDuration += outcome.duration;
      result.avgDuration = result.totalDuration / result.samples;
    }

    if (outcome.tokens !== undefined) {
      result.totalTokens += outcome.tokens;
      result.avgTokens = result.totalTokens / result.samples;
    }

    // Store the outcome
    const experimentOutcome: ExperimentOutcome = {
      experimentId,
      variantId,
      success: outcome.success,
      duration: outcome.duration,
      tokens: outcome.tokens,
      metadata: outcome.metadata,
      timestamp: Date.now(),
    };

    this.addOutcomeToMemory(experimentOutcome);
    this.persistOutcome(experimentOutcome);

    this.emit('outcome:recorded', { experimentId, variantId, result, outcome: experimentOutcome });

    // Check if experiment should auto-complete
    this.checkExperimentCompletion(experimentId);
  }

  private addOutcomeToMemory(outcome: ExperimentOutcome): void {
    let experimentOutcomes = this.outcomes.get(outcome.experimentId);
    if (!experimentOutcomes) {
      experimentOutcomes = [];
      this.outcomes.set(outcome.experimentId, experimentOutcomes);
    }
    experimentOutcomes.push(outcome);

    // Also update results from loaded outcomes
    const experimentResults = this.results.get(outcome.experimentId);
    if (experimentResults) {
      const result = experimentResults.get(outcome.variantId);
      if (result && !this.experiments.get(outcome.experimentId)) {
        // Only update if this is from persistence load
        result.samples++;
        if (outcome.success) result.successes++;
        result.successRate = result.samples > 0 ? result.successes / result.samples : 0;
        if (outcome.duration !== undefined) {
          result.totalDuration += outcome.duration;
          result.avgDuration = result.totalDuration / result.samples;
        }
        if (outcome.tokens !== undefined) {
          result.totalTokens += outcome.tokens;
          result.avgTokens = result.totalTokens / result.samples;
        }
      }
    }
  }

  // ============================================
  // Results & Analysis
  // ============================================

  /**
   * Get results for an experiment
   */
  getResults(experimentId: string): ExperimentResult[] {
    const experimentResults = this.results.get(experimentId);
    if (!experimentResults) return [];
    return Array.from(experimentResults.values());
  }

  /**
   * Get all outcomes for an experiment
   */
  getOutcomes(experimentId: string): ExperimentOutcome[] {
    return this.outcomes.get(experimentId) || [];
  }

  /**
   * Get total samples across all variants
   */
  private getTotalSamples(experimentId: string): number {
    const results = this.getResults(experimentId);
    return results.reduce((sum, r) => sum + r.samples, 0);
  }

  /**
   * Get the winning variant if statistically significant
   */
  getWinner(experimentId: string): ExperimentWinner | null {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    const results = this.getResults(experimentId);
    if (results.length < 2) return null;

    // Sort by success rate (descending)
    const sorted = [...results].sort((a, b) => b.successRate - a.successRate);
    const best = sorted[0];
    const secondBest = sorted[1];

    // Check minimum samples
    if (best.samples < experiment.minSamples || secondBest.samples < experiment.minSamples) {
      return null;
    }

    // Calculate confidence using Wilson score interval approximation
    const confidence = this.calculateConfidence(best, secondBest);

    if (confidence < experiment.confidenceThreshold) {
      return null;
    }

    const variant = experiment.variants.find((v) => v.id === best.variantId);
    if (!variant) return null;

    const improvement =
      secondBest.successRate > 0
        ? ((best.successRate - secondBest.successRate) / secondBest.successRate) * 100
        : best.successRate * 100;

    return { variant, confidence, improvement };
  }

  /**
   * Calculate statistical confidence between two results
   * Uses a simplified Z-test approximation
   */
  private calculateConfidence(best: ExperimentResult, secondBest: ExperimentResult): number {
    const p1 = best.successRate;
    const p2 = secondBest.successRate;
    const n1 = best.samples;
    const n2 = secondBest.samples;

    if (n1 === 0 || n2 === 0) return 0;

    // Pooled proportion
    const pPool = (best.successes + secondBest.successes) / (n1 + n2);

    // Standard error
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));

    if (se === 0) return p1 > p2 ? 0.99 : 0;

    // Z-score
    const z = Math.abs(p1 - p2) / se;

    // Convert Z-score to confidence (using normal CDF approximation)
    // For z > 3, confidence is essentially 1
    const confidence = 1 - 2 * (1 - this.normalCDF(z));

    return Math.min(0.99, Math.max(0, confidence));
  }

  /**
   * Standard normal cumulative distribution function (approximation)
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Check if experiment should auto-complete
   */
  private checkExperimentCompletion(experimentId: string): void {
    const experiment = this.experiments.get(experimentId);
    if (!experiment || experiment.status !== 'running') return;

    const results = this.getResults(experimentId);
    const allHaveMinSamples = results.every((r) => r.samples >= experiment.minSamples);

    if (allHaveMinSamples) {
      const winner = this.getWinner(experimentId);
      if (winner) {
        experiment.status = 'completed';
        experiment.endedAt = Date.now();
        experiment.updatedAt = Date.now();
        this.persistExperiment(experiment);

        this.emit('experiment:completed', { experiment, winner });
      }
    }
  }

  // ============================================
  // Queries
  // ============================================

  /**
   * Get an experiment by ID
   */
  getExperiment(experimentId: string): Experiment | null {
    return this.experiments.get(experimentId) || null;
  }

  /**
   * List all experiments
   */
  listExperiments(filter?: { status?: Experiment['status']; taskType?: string }): Experiment[] {
    let experiments = Array.from(this.experiments.values());

    if (filter?.status) {
      experiments = experiments.filter((e) => e.status === filter.status);
    }

    if (filter?.taskType) {
      experiments = experiments.filter((e) => e.taskType === filter.taskType);
    }

    return experiments.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Get experiments by task type
   */
  getExperimentsByTaskType(taskType: string): Experiment[] {
    return Array.from(this.experiments.values()).filter((e) => e.taskType === taskType);
  }

  /**
   * Get running experiment for task type
   */
  getRunningExperiment(taskType: string): Experiment | null {
    return (
      Array.from(this.experiments.values()).find(
        (e) => e.taskType === taskType && e.status === 'running'
      ) || null
    );
  }

  /**
   * Get overall statistics
   */
  getStats(): ExperimentStats {
    const experiments = Array.from(this.experiments.values());

    return {
      totalExperiments: experiments.length,
      running: experiments.filter((e) => e.status === 'running').length,
      completed: experiments.filter((e) => e.status === 'completed').length,
      draft: experiments.filter((e) => e.status === 'draft').length,
      paused: experiments.filter((e) => e.status === 'paused').length,
      totalOutcomes: Array.from(this.outcomes.values()).reduce((sum, arr) => sum + arr.length, 0),
    };
  }

  /**
   * Clear session assignment
   */
  clearAssignment(experimentId: string, sessionId: string): void {
    const experimentAssignments = this.assignments.get(experimentId);
    if (experimentAssignments) {
      experimentAssignments.delete(sessionId);
    }
  }

  /**
   * Clear all assignments for an experiment
   */
  clearAllAssignments(experimentId: string): void {
    this.assignments.set(experimentId, new Map());
  }
}

// ============================================
// Singleton Getter
// ============================================

export function getABTestingEngine(config?: Partial<ABTestingConfig>): ABTestingEngine {
  return ABTestingEngine.getInstance(config);
}
