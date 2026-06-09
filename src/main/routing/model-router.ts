/**
 * Model Router - Intelligent model selection based on task complexity
 *
 * Implements cost-optimized routing that can save 40-85% on API costs by
 * routing simple tasks to faster, cheaper models (Haiku) while reserving
 * expensive models (Opus/Sonnet) for complex tasks.
 */

import { getModelDiscoveryService, type DiscoveredModel } from '../providers/model-discovery';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';

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
  defaultModel: CLAUDE_MODELS.BALANCED,
  fastModel: CLAUDE_MODELS.FAST,
  balancedModel: CLAUDE_MODELS.BALANCED,
  powerfulModel: CLAUDE_MODELS.POWERFUL,
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
  /** Detailed explanation for UI display */
  explanation?: RoutingExplanation;
}

/**
 * Detailed routing explanation for UI display
 */
export interface RoutingExplanation {
  /** Summary of the decision */
  summary: string;
  /** Detected task complexity with color hint */
  complexityDisplay: {
    level: TaskComplexity;
    label: string;
    color: 'success' | 'warning' | 'info';
  };
  /** Confidence as percentage */
  confidencePercent: number;
  /** Matched keywords that influenced the decision */
  matchedKeywords: {
    keyword: string;
    type: 'complex' | 'simple';
  }[];
  /** Analysis factors that influenced the decision */
  factors: {
    description: string;
    impact: 'increases_complexity' | 'decreases_complexity' | 'neutral';
  }[];
  /** Alternative routing options */
  alternatives: {
    model: string;
    tier: ModelTier;
    reason: string;
  }[];
  /** Cost comparison */
  costComparison: {
    selectedTier: ModelTier;
    selectedCostMultiplier: number;
    savingsVsPowerful: number;
    savingsVsBalanced: number;
  };
}

/**
 * Task analysis result
 */
export interface TaskAnalysis {
  complexity: TaskComplexity;
  confidence: number;
  matchedKeywords: string[];
  factors: string[];
  complexScore: number;
  simpleScore: number;
}

/**
 * Word-boundary keyword matcher (compiled-regex cache). Substring matching
 * produced false positives that skewed complexity scoring: 'find' fired on
 * "findings", 'list' on "checklist", 'get' on "together". Multi-word keywords
 * ('implement feature') match as a bounded phrase.
 */
const keywordRegexCache = new Map<string, RegExp>();

function keywordMatches(lowerTask: string, keyword: string): boolean {
  const key = keyword.toLowerCase();
  let regex = keywordRegexCache.get(key);
  if (!regex) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`\\b${escaped}\\b`);
    keywordRegexCache.set(key, regex);
  }
  return regex.test(lowerTask);
}

/**
 * Model Router - Selects optimal model based on task complexity
 */
export class ModelRouter {
  private config: ModelRoutingConfig;
  private modelCache = new Map<string, DiscoveredModel>();

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

    const decision: RoutingDecision = {
      model,
      complexity: analysis.complexity,
      tier,
      confidence: analysis.confidence,
      reason: this.buildReason(analysis),
      estimatedSavingsPercent,
    };

    // Add detailed explanation
    decision.explanation = this.getRoutingExplanation(task, decision);

    return decision;
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
        complexScore: 0,
        simpleScore: 1,
      };
    }

    // Score based on keyword matching
    let complexScore = 0;
    let simpleScore = 0;

    // Check complex keywords (word-boundary match, not substring)
    for (const keyword of this.config.complexKeywords) {
      if (keywordMatches(lowerTask, keyword)) {
        complexScore += 2;
        matchedKeywords.push(keyword);
        factors.push(`Complex keyword: "${keyword}"`);
      }
    }

    // Check simple keywords (word-boundary match, not substring)
    for (const keyword of this.config.simpleKeywords) {
      if (keywordMatches(lowerTask, keyword)) {
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
      complexScore,
      simpleScore,
    };
  }

  /**
   * Get detailed task analysis (public method for UI)
   */
  getTaskAnalysis(task: string): TaskAnalysis {
    return this.analyzeTask(task);
  }

  /**
   * Get detailed routing explanation for UI display
   */
  getRoutingExplanation(task: string, decision: RoutingDecision): RoutingExplanation {
    const analysis = this.analyzeTask(task);

    // Build complexity display
    const complexityDisplay = {
      level: analysis.complexity,
      label: analysis.complexity.charAt(0).toUpperCase() + analysis.complexity.slice(1),
      color: analysis.complexity === 'simple' ? 'success' as const :
             analysis.complexity === 'complex' ? 'warning' as const : 'info' as const,
    };

    // Build matched keywords with types
    const matchedKeywords = analysis.matchedKeywords.map(keyword => ({
      keyword,
      type: this.config.complexKeywords.some(k => k.toLowerCase() === keyword.toLowerCase())
        ? 'complex' as const
        : 'simple' as const,
    }));

    // Build factors with impact
    const factors = analysis.factors.map(desc => {
      let impact: 'increases_complexity' | 'decreases_complexity' | 'neutral' = 'neutral';
      if (desc.toLowerCase().includes('complex') || desc.includes('>')) {
        impact = 'increases_complexity';
      } else if (desc.toLowerCase().includes('simple') || desc.includes('<')) {
        impact = 'decreases_complexity';
      }
      return { description: desc, impact };
    });

    // Build alternatives
    const alternatives: RoutingExplanation['alternatives'] = [];
    const tiers: ModelTier[] = ['fast', 'balanced', 'powerful'];

    for (const tier of tiers) {
      if (tier === decision.tier) continue;

      const tierModel = tier === 'fast' ? this.config.fastModel :
                        tier === 'balanced' ? this.config.balancedModel :
                        this.config.powerfulModel;

      const reason = tier === 'fast' ? 'Lower cost, faster response, may miss nuance' :
                     tier === 'balanced' ? 'Good balance of cost and capability' :
                     'Maximum capability, higher cost';

      alternatives.push({ model: tierModel, tier, reason });
    }

    // Build cost comparison
    const tierMultipliers: Record<ModelTier, number> = {
      fast: 0.2,
      balanced: 0.6,
      powerful: 1.0,
    };

    const selectedMultiplier = tierMultipliers[decision.tier];
    const costComparison = {
      selectedTier: decision.tier,
      selectedCostMultiplier: selectedMultiplier,
      savingsVsPowerful: Math.round((1 - selectedMultiplier) * 100),
      savingsVsBalanced: decision.tier === 'fast'
        ? Math.round((1 - selectedMultiplier / 0.6) * 100)
        : 0,
    };

    // Build summary
    const summary = `Using ${decision.tier} tier model (${decision.model}) for ${analysis.complexity} task. ` +
      `Confidence: ${Math.round(analysis.confidence * 100)}%. ` +
      (costComparison.savingsVsPowerful > 0
        ? `Saving ~${costComparison.savingsVsPowerful}% vs powerful model.`
        : 'Using most capable model.');

    return {
      summary,
      complexityDisplay,
      confidencePercent: Math.round(analysis.confidence * 100),
      matchedKeywords,
      factors,
      alternatives,
      costComparison,
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
