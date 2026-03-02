/**
 * Prompt Cache Manager
 * Phase 1.1: Prompt caching wrapper for Anthropic API
 *
 * Wraps context with cache_control markers for significant cost reduction.
 * Integrates with existing UnifiedController.buildContext()
 *
 * Expected Impact: 50-90% cost reduction on repeated context
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type {
  CacheControl,
  CacheableTextBlock,
  CacheableSystemPrompt,
  CacheUsageMetrics,
  CachePerformanceMetrics,
} from '../../shared/types/api-features.types';
import {
  calculateCachePerformance,
  getMinCacheableTokens,
  supportsPromptCaching,
} from '../../shared/types/api-features.types';
import { getTokenCounter, TokenCounter } from '../rlm/token-counter';
import { getMetricsCollector } from '../learning/metrics-collector';

const logger = getLogger('PromptCache');

// ============================================
// Types
// ============================================

/**
 * Cacheable context for wrapping with cache_control markers
 */
export interface CacheableContext {
  /** Main system prompt */
  systemPrompt: string;
  /** Project context (CLAUDE.md, rules, etc.) */
  projectContext: string;
  /** Active skill content */
  skills: string[];
  /** Optional tool definitions (can also be cached) */
  toolDefinitions?: string;
}

/**
 * Prompt cache configuration
 */
export interface PromptCacheConfig {
  /** Enable prompt caching (default: true) */
  enabled: boolean;
  /** TTL for cached content (default: '5m', can be '1h' for longer sessions) */
  defaultTtl: '5m' | '1h';
  /** Minimum tokens required for caching (auto-detected from model) */
  minCacheableTokens: number;
  /** Maximum cache breakpoints per request (API limit: 4) */
  maxCacheBreakpoints: number;
  /** Track cache metrics (default: true) */
  trackMetrics: boolean;
}

/**
 * Cache metrics for a single request
 */
export interface CacheMetrics {
  /** Tokens written to cache (costs 125% of base) */
  cacheCreationTokens: number;
  /** Tokens read from cache (costs 10% of base) */
  cacheReadTokens: number;
  /** Regular non-cached input tokens */
  regularTokens: number;
  /** Cache hit rate (0-1) */
  hitRate: number;
  /** Estimated cost savings in percentage */
  costSavingsPercent: number;
}

/**
 * Prompt cache events
 */
export type PromptCacheEvent =
  | { type: 'cache:created'; tokens: number; sessionId: string }
  | { type: 'cache:hit'; tokens: number; hitRate: number; sessionId: string }
  | { type: 'cache:miss'; tokens: number; sessionId: string }
  | { type: 'cache:metrics'; metrics: CacheMetrics; sessionId: string };

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: PromptCacheConfig = {
  enabled: true,
  defaultTtl: '5m',
  minCacheableTokens: 1024,
  maxCacheBreakpoints: 4,
  trackMetrics: true,
};

// ============================================
// Prompt Cache Manager
// ============================================

/**
 * Prompt Cache Manager
 *
 * Wraps context with cache_control markers for the Anthropic API.
 * Integrates with existing context building to add caching without disruption.
 */
export class PromptCacheManager extends EventEmitter {
  private static instance: PromptCacheManager | null = null;

  private config: PromptCacheConfig;
  private tokenCounter: TokenCounter;
  private cumulativeMetrics: {
    totalCreation: number;
    totalRead: number;
    totalRegular: number;
    requestCount: number;
  };

  private constructor(config: Partial<PromptCacheConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = getTokenCounter();
    this.cumulativeMetrics = {
      totalCreation: 0,
      totalRead: 0,
      totalRegular: 0,
      requestCount: 0,
    };
  }

  static getInstance(config?: Partial<PromptCacheConfig>): PromptCacheManager {
    if (!PromptCacheManager.instance) {
      PromptCacheManager.instance = new PromptCacheManager(config);
    }
    return PromptCacheManager.instance;
  }

  static resetInstance(): void {
    PromptCacheManager.instance = null;
  }

  // ============================================
  // Configuration
  // ============================================

  /**
   * Configure the cache manager
   */
  configure(config: Partial<PromptCacheConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config:updated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): PromptCacheConfig {
    return { ...this.config };
  }

  /**
   * Update configuration for a specific model
   */
  configureForModel(model: string): void {
    if (!supportsPromptCaching(model)) {
      this.config.enabled = false;
      logger.warn('Model does not support prompt caching', { model });
      return;
    }

    this.config.minCacheableTokens = getMinCacheableTokens(model);
    this.config.enabled = true;
  }

  // ============================================
  // Context Wrapping
  // ============================================

  /**
   * Wrap context with cache_control markers for the Anthropic API
   *
   * @param context - The context to wrap
   * @returns Array of cacheable text blocks for the system parameter
   */
  wrapForCaching(context: CacheableContext): CacheableSystemPrompt {
    if (!this.config.enabled) {
      // Return without cache markers
      return this.buildSystemPromptWithoutCache(context);
    }

    const blocks: CacheableTextBlock[] = [];
    const cacheControl: CacheControl = {
      type: 'ephemeral',
      ...(this.config.defaultTtl !== '5m' && { ttl: this.config.defaultTtl }),
    };

    let breakpointsUsed = 0;

    // 1. System prompt - always cache if large enough
    if (context.systemPrompt && this.isCacheable(context.systemPrompt)) {
      blocks.push({
        type: 'text',
        text: context.systemPrompt,
        cache_control: breakpointsUsed < this.config.maxCacheBreakpoints ? cacheControl : undefined,
      });
      if (breakpointsUsed < this.config.maxCacheBreakpoints) breakpointsUsed++;
    } else if (context.systemPrompt) {
      blocks.push({
        type: 'text',
        text: context.systemPrompt,
      });
    }

    // 2. Project context - cache if large enough
    if (context.projectContext && this.isCacheable(context.projectContext)) {
      blocks.push({
        type: 'text',
        text: context.projectContext,
        cache_control: breakpointsUsed < this.config.maxCacheBreakpoints ? cacheControl : undefined,
      });
      if (breakpointsUsed < this.config.maxCacheBreakpoints) breakpointsUsed++;
    } else if (context.projectContext) {
      blocks.push({
        type: 'text',
        text: context.projectContext,
      });
    }

    // 3. Skills - combine if needed, cache if large enough
    if (context.skills && context.skills.length > 0) {
      const combinedSkills = context.skills.join('\n\n---\n\n');
      if (this.isCacheable(combinedSkills)) {
        blocks.push({
          type: 'text',
          text: combinedSkills,
          cache_control: breakpointsUsed < this.config.maxCacheBreakpoints ? cacheControl : undefined,
        });
        if (breakpointsUsed < this.config.maxCacheBreakpoints) breakpointsUsed++;
      } else {
        blocks.push({
          type: 'text',
          text: combinedSkills,
        });
      }
    }

    // 4. Tool definitions - cache if large enough
    if (context.toolDefinitions && this.isCacheable(context.toolDefinitions)) {
      blocks.push({
        type: 'text',
        text: context.toolDefinitions,
        cache_control: breakpointsUsed < this.config.maxCacheBreakpoints ? cacheControl : undefined,
      });
      // Don't increment breakpointsUsed - this is the last one
    } else if (context.toolDefinitions) {
      blocks.push({
        type: 'text',
        text: context.toolDefinitions,
      });
    }

    return blocks;
  }

  /**
   * Build system prompt without cache markers
   */
  private buildSystemPromptWithoutCache(context: CacheableContext): CacheableTextBlock[] {
    const blocks: CacheableTextBlock[] = [];

    if (context.systemPrompt) {
      blocks.push({ type: 'text', text: context.systemPrompt });
    }

    if (context.projectContext) {
      blocks.push({ type: 'text', text: context.projectContext });
    }

    if (context.skills && context.skills.length > 0) {
      blocks.push({ type: 'text', text: context.skills.join('\n\n---\n\n') });
    }

    if (context.toolDefinitions) {
      blocks.push({ type: 'text', text: context.toolDefinitions });
    }

    return blocks;
  }

  /**
   * Check if content meets minimum token requirement for caching
   */
  private isCacheable(content: string): boolean {
    const tokens = this.tokenCounter.countTokens(content);
    return tokens >= this.config.minCacheableTokens;
  }

  // ============================================
  // Metrics Extraction & Tracking
  // ============================================

  /**
   * Extract cache metrics from API response usage
   *
   * @param usage - The usage object from the API response
   * @param sessionId - Session ID for event emission
   * @returns Calculated cache metrics
   */
  extractMetrics(usage: CacheUsageMetrics, sessionId: string = 'unknown'): CacheMetrics {
    const performance = calculateCachePerformance(usage);

    const metrics: CacheMetrics = {
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      regularTokens: usage.input_tokens || 0,
      hitRate: performance.hitRate,
      costSavingsPercent: performance.costSavingsPercent,
    };

    // Update cumulative metrics
    this.cumulativeMetrics.totalCreation += metrics.cacheCreationTokens;
    this.cumulativeMetrics.totalRead += metrics.cacheReadTokens;
    this.cumulativeMetrics.totalRegular += metrics.regularTokens;
    this.cumulativeMetrics.requestCount++;

    // Emit appropriate events
    if (metrics.cacheReadTokens > 0) {
      this.emitEvent({
        type: 'cache:hit',
        tokens: metrics.cacheReadTokens,
        hitRate: metrics.hitRate,
        sessionId,
      });
    } else if (metrics.cacheCreationTokens > 0) {
      this.emitEvent({
        type: 'cache:created',
        tokens: metrics.cacheCreationTokens,
        sessionId,
      });
    } else {
      this.emitEvent({
        type: 'cache:miss',
        tokens: metrics.regularTokens,
        sessionId,
      });
    }

    this.emitEvent({
      type: 'cache:metrics',
      metrics,
      sessionId,
    });

    // Report to metrics collector if enabled
    if (this.config.trackMetrics) {
      try {
        const metricsCollector = getMetricsCollector();
        metricsCollector.recordPromptCache(
          metrics.cacheCreationTokens,
          metrics.cacheReadTokens,
          this.calculateCostSavings(metrics)
        );
      } catch {
        // Metrics collector not available - ignore
      }
    }

    return metrics;
  }

  /**
   * Calculate actual cost savings in dollars (approximate)
   * Based on Claude Sonnet 4.5 pricing: $3/1M input tokens
   * Cache reads: 10% of base = $0.30/1M
   * Cache writes: 125% of base = $3.75/1M
   */
  private calculateCostSavings(metrics: CacheMetrics, model?: string): number {
    // Model-aware pricing per 1M input tokens
    const pricingMap: Record<string, number> = {
      'haiku': 1.0,
      'sonnet': 3.0,
      'opus': 15.0,
    };

    const lowerModel = (model || '').toLowerCase();
    let baseCostPerMillion = 3.0; // Default to Sonnet pricing
    for (const [key, price] of Object.entries(pricingMap)) {
      if (lowerModel.includes(key)) {
        baseCostPerMillion = price;
        break;
      }
    }

    // Cost if everything was regular
    const regularCost =
      ((metrics.cacheCreationTokens + metrics.cacheReadTokens + metrics.regularTokens) / 1_000_000) *
      baseCostPerMillion;

    // Actual cost with caching
    const creationCost = (metrics.cacheCreationTokens / 1_000_000) * baseCostPerMillion * 1.25;
    const readCost = (metrics.cacheReadTokens / 1_000_000) * baseCostPerMillion * 0.1;
    const regularTokenCost = (metrics.regularTokens / 1_000_000) * baseCostPerMillion;
    const actualCost = creationCost + readCost + regularTokenCost;

    return Math.max(0, regularCost - actualCost);
  }

  // ============================================
  // Aggregate Metrics
  // ============================================

  /**
   * Get cumulative cache performance metrics
   */
  getCumulativeMetrics(): {
    totalCreation: number;
    totalRead: number;
    totalRegular: number;
    requestCount: number;
    overallHitRate: number;
    estimatedTotalSavings: number;
  } {
    const total =
      this.cumulativeMetrics.totalCreation +
      this.cumulativeMetrics.totalRead +
      this.cumulativeMetrics.totalRegular;

    return {
      ...this.cumulativeMetrics,
      overallHitRate: total > 0 ? this.cumulativeMetrics.totalRead / total : 0,
      estimatedTotalSavings: this.calculateCostSavings({
        cacheCreationTokens: this.cumulativeMetrics.totalCreation,
        cacheReadTokens: this.cumulativeMetrics.totalRead,
        regularTokens: this.cumulativeMetrics.totalRegular,
        hitRate: 0, // Not used in calculation
        costSavingsPercent: 0, // Not used in calculation
      }),
    };
  }

  /**
   * Reset cumulative metrics
   */
  resetCumulativeMetrics(): void {
    this.cumulativeMetrics = {
      totalCreation: 0,
      totalRead: 0,
      totalRegular: 0,
      requestCount: 0,
    };
    this.emit('metrics:reset');
  }

  // ============================================
  // Event Emission
  // ============================================

  private emitEvent(event: PromptCacheEvent): void {
    this.emit(event.type, event);
    this.emit('cache_event', event);
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up resources
   */
  destroy(): void {
    this.resetCumulativeMetrics();
    this.removeAllListeners();
    PromptCacheManager.instance = null;
  }
}

// ============================================
// Singleton Getter
// ============================================

export function getPromptCacheManager(config?: Partial<PromptCacheConfig>): PromptCacheManager {
  return PromptCacheManager.getInstance(config);
}

export default PromptCacheManager;
