/**
 * Model Router - Intelligent model selection based on task complexity
 *
 * Implements cost-optimized routing that can save 40-85% on API costs by
 * routing simple tasks to faster, cheaper models (Haiku) while reserving
 * expensive models (Opus/Sonnet) for complex tasks.
 */

import { getModelDiscoveryService, type DiscoveredModel, type ModelPricing } from '../providers/model-discovery';

/**
 * Task complexity level
 */
export type TaskComplexity = 'simple' | 'moderate' | 'complex';

/**
 * Model tier for routing decisions
 */
export type ModelTier = 'fast' | 'balanced' | 'powerful';

/**
 * Model routing configuration
 */
export interface ModelRoutingConfig {
  /** Enable automatic model routing (default: true) */
  enabled: boolean;
  /** Default model when routing is disabled */
  defaultModel: string;
  /** Model to use for simple tasks (fast tier) */
  fastModel: string;
  /** Model to use for moderate tasks (balanced tier) */
  balancedModel: string;
  /** Model to use for complex tasks (powerful tier) */
  powerfulModel: string;
  /** Minimum task description length to consider for routing (chars) */
  minTaskLength: number;
  /** Keywords that indicate complex tasks */
  complexKeywords: string[];
  /** Keywords that indicate simple tasks */
  simpleKeywords: string[];
}

/**
 * Default routing configuration
 */
export const DEFAULT_ROUTING_CONFIG: ModelRoutingConfig = {
  enabled: true,
  defaultModel: 'claude-sonnet-4-20250514',
  fastModel: 'claude-3-5-haiku-20241022',
  balancedModel: 'claude-sonnet-4-20250514',
  powerfulModel: 'claude-opus-4-20250514',
  minTaskLength: 20,
  complexKeywords: [
    // Architecture & Design
    'architect', 'design', 'refactor', 'restructure', 'migrate',
    'redesign', 'overhaul', 'rewrite',
    // Analysis requiring deep understanding
    'analyze', 'audit', 'review', 'evaluate', 'assess',
    'investigate', 'diagnose', 'debug complex',
    // Multi-step operations
    'implement feature', 'build', 'create system', 'develop',
    'integrate', 'orchestrate', 'coordinate',
    // Security & Performance
    'security', 'vulnerability', 'performance optimization',
    'scalability', 'reliability',
    // Documentation requiring understanding
    'document architecture', 'write specification', 'design doc',
    // Complex reasoning
    'trade-off', 'pros and cons', 'compare approaches',
    'best practice', 'recommendation',
  ],
  simpleKeywords: [
    // File operations
    'find', 'search', 'locate', 'list', 'show',
    'read', 'get', 'fetch', 'retrieve',
    // Simple queries
    'what is', 'where is', 'how many', 'count',
    'check', 'verify', 'confirm',
    // Formatting & simple edits
    'format', 'rename', 'move', 'copy', 'delete',
    'add comment', 'fix typo', 'update version',
    // Status checks
    'status', 'health', 'ping', 'test connection',
    // Simple generation
    'generate id', 'create uuid', 'timestamp',
  ],
};

/**
 * Result of a routing decision
 */
export interface RoutingDecision {
  /** Selected model ID */
  model: string;
  /** Detected task complexity */
  complexity: TaskComplexity;
  /** Model tier used */
  tier: ModelTier;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reasoning for the decision */
  reason: string;
  /** Estimated cost savings vs always using powerful model */
  estimatedSavingsPercent?: number;
}

/**
 * Task analysis result
 */
interface TaskAnalysis {
  complexity: TaskComplexity;
  confidence: number;
  matchedKeywords: string[];
  factors: string[];
}

/**
 * Model Router - Selects optimal model based on task complexity
 */
export class ModelRouter {
  private config: ModelRoutingConfig;
  private modelCache: Map<string, DiscoveredModel> = new Map();

  constructor(config: Partial<ModelRoutingConfig> = {}) {
    this.config = { ...DEFAULT_ROUTING_CONFIG, ...config };
  }

  /**
   * Route a task to the optimal model
   */
  route(task: string, explicitModel?: string): RoutingDecision {
    // If explicit model specified, use it
    if (explicitModel) {
      return {
        model: explicitModel,
        complexity: 'moderate',
        tier: 'balanced',
        confidence: 1.0,
        reason: 'Explicit model specified by caller',
      };
    }

    // If routing disabled, use default
    if (!this.config.enabled) {
      return {
        model: this.config.defaultModel,
        complexity: 'moderate',
        tier: 'balanced',
        confidence: 1.0,
        reason: 'Model routing disabled, using default',
      };
    }

    // Analyze task complexity
    const analysis = this.analyzeTask(task);

    // Select model based on complexity
    const { model, tier } = this.selectModel(analysis.complexity);

    // Calculate estimated savings
    const estimatedSavingsPercent = this.calculateSavings(tier);

    return {
      model,
      complexity: analysis.complexity,
      tier,
      confidence: analysis.confidence,
      reason: this.buildReason(analysis),
      estimatedSavingsPercent,
    };
  }

  /**
   * Analyze task complexity
   */
  private analyzeTask(task: string): TaskAnalysis {
    const lowerTask = task.toLowerCase();
    const factors: string[] = [];
    const matchedKeywords: string[] = [];

    // Check task length
    const taskLength = task.trim().length;
    if (taskLength < this.config.minTaskLength) {
      return {
        complexity: 'simple',
        confidence: 0.9,
        matchedKeywords: [],
        factors: ['Task description very short'],
      };
    }

    // Score based on keyword matching
    let complexScore = 0;
    let simpleScore = 0;

    // Check complex keywords
    for (const keyword of this.config.complexKeywords) {
      if (lowerTask.includes(keyword.toLowerCase())) {
        complexScore += 2;
        matchedKeywords.push(keyword);
        factors.push(`Complex keyword: "${keyword}"`);
      }
    }

    // Check simple keywords
    for (const keyword of this.config.simpleKeywords) {
      if (lowerTask.includes(keyword.toLowerCase())) {
        simpleScore += 2;
        matchedKeywords.push(keyword);
        factors.push(`Simple keyword: "${keyword}"`);
      }
    }

    // Factor in task length (longer = potentially more complex)
    if (taskLength > 500) {
      complexScore += 1;
      factors.push('Long task description (>500 chars)');
    } else if (taskLength > 200) {
      // Moderate length, slight complexity boost
      complexScore += 0.5;
    } else if (taskLength < 100) {
      simpleScore += 1;
      factors.push('Short task description (<100 chars)');
    }

    // Check for code blocks (indicates technical complexity)
    if (task.includes('```')) {
      complexScore += 1;
      factors.push('Contains code blocks');
    }

    // Check for multiple questions/requirements
    const questionMarks = (task.match(/\?/g) || []).length;
    if (questionMarks > 2) {
      complexScore += 1;
      factors.push(`Multiple questions (${questionMarks})`);
    }

    // Check for numbered lists (multiple steps)
    const numberedItems = (task.match(/^\s*\d+\./gm) || []).length;
    if (numberedItems > 3) {
      complexScore += 1;
      factors.push(`Multiple numbered items (${numberedItems})`);
    }

    // Determine complexity
    const netScore = complexScore - simpleScore;
    let complexity: TaskComplexity;
    let confidence: number;

    if (netScore >= 3) {
      complexity = 'complex';
      confidence = Math.min(0.95, 0.7 + netScore * 0.05);
    } else if (netScore <= -2) {
      complexity = 'simple';
      confidence = Math.min(0.95, 0.7 + Math.abs(netScore) * 0.05);
    } else {
      complexity = 'moderate';
      confidence = 0.6 + Math.abs(netScore) * 0.05;
    }

    return {
      complexity,
      confidence,
      matchedKeywords,
      factors,
    };
  }

  /**
   * Select model based on complexity
   */
  private selectModel(complexity: TaskComplexity): { model: string; tier: ModelTier } {
    switch (complexity) {
      case 'simple':
        return { model: this.config.fastModel, tier: 'fast' };
      case 'moderate':
        return { model: this.config.balancedModel, tier: 'balanced' };
      case 'complex':
        return { model: this.config.powerfulModel, tier: 'powerful' };
    }
  }

  /**
   * Calculate estimated cost savings
   */
  private calculateSavings(tier: ModelTier): number {
    // Approximate pricing ratios (Haiku is ~5x cheaper than Sonnet, ~15x cheaper than Opus)
    const tierMultipliers: Record<ModelTier, number> = {
      fast: 0.2,      // ~80% savings vs powerful
      balanced: 0.6,  // ~40% savings vs powerful
      powerful: 1.0,  // baseline
    };

    const savings = (1 - tierMultipliers[tier]) * 100;
    return Math.round(savings);
  }

  /**
   * Build human-readable reason for decision
   */
  private buildReason(analysis: TaskAnalysis): string {
    const parts: string[] = [];

    parts.push(`Detected ${analysis.complexity} complexity (${Math.round(analysis.confidence * 100)}% confidence)`);

    if (analysis.matchedKeywords.length > 0) {
      const keywords = analysis.matchedKeywords.slice(0, 3).join(', ');
      parts.push(`Matched keywords: ${keywords}`);
    }

    if (analysis.factors.length > 0 && analysis.factors.length <= 3) {
      parts.push(analysis.factors.join('; '));
    }

    return parts.join('. ');
  }

  /**
   * Update routing configuration
   */
  updateConfig(config: Partial<ModelRoutingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): ModelRoutingConfig {
    return { ...this.config };
  }

  /**
   * Get model tier from model ID
   */
  getModelTier(modelId: string): ModelTier {
    const lowerModel = modelId.toLowerCase();

    if (lowerModel.includes('haiku')) {
      return 'fast';
    } else if (lowerModel.includes('opus')) {
      return 'powerful';
    } else {
      return 'balanced';
    }
  }

  /**
   * Check if a model is available for routing
   */
  async isModelAvailable(modelId: string): Promise<boolean> {
    const discovery = getModelDiscoveryService();
    return discovery.isModelAvailable({ type: 'anthropic' }, modelId);
  }
}

// Singleton instance
let modelRouter: ModelRouter | null = null;

/**
 * Get the model router singleton
 */
export function getModelRouter(): ModelRouter {
  if (!modelRouter) {
    modelRouter = new ModelRouter();
  }
  return modelRouter;
}

/**
 * Convenience function for quick routing decisions
 */
export function routeTask(task: string, explicitModel?: string): RoutingDecision {
  return getModelRouter().route(task, explicitModel);
}
