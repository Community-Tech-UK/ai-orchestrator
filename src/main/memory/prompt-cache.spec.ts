/**
 * Prompt Cache Manager Tests
 * Phase 1.1 unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PromptCacheManager,
  getPromptCacheManager,
  CacheableContext,
} from './prompt-cache';
import type { CacheUsageMetrics } from '../../shared/types/api-features.types';

// Mock token counter
vi.mock('../rlm/token-counter', () => ({
  getTokenCounter: () => ({
    countTokens: (text: string) => Math.ceil(text.length / 4), // Rough estimate
  }),
}));

// Mock metrics collector
vi.mock('../learning/metrics-collector', () => ({
  getMetricsCollector: () => ({
    recordPromptCache: vi.fn(),
  }),
}));

describe('PromptCacheManager', () => {
  let manager: PromptCacheManager;

  beforeEach(() => {
    PromptCacheManager.resetInstance();
    manager = getPromptCacheManager({ trackMetrics: false });
  });

  afterEach(() => {
    PromptCacheManager.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getPromptCacheManager();
      const instance2 = getPromptCacheManager();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', () => {
      const instance1 = getPromptCacheManager();
      PromptCacheManager.resetInstance();
      const instance2 = getPromptCacheManager();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const config = manager.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.defaultTtl).toBe('5m');
      expect(config.maxCacheBreakpoints).toBe(4);
      expect(config.minCacheableTokens).toBe(1024);
    });

    it('should allow configuration updates', () => {
      manager.configure({ defaultTtl: '1h' });
      const config = manager.getConfig();
      expect(config.defaultTtl).toBe('1h');
    });

    it('should configure for model', () => {
      manager.configureForModel('claude-sonnet-4-5-20250929');
      const config = manager.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.minCacheableTokens).toBe(1024);
    });

    it('should disable for unsupported models', () => {
      manager.configureForModel('unsupported-model');
      const config = manager.getConfig();
      expect(config.enabled).toBe(false);
    });
  });

  describe('Context Wrapping', () => {
    it('should wrap context with cache_control when enabled', () => {
      // Create content large enough to be cacheable
      const largeContent = 'x'.repeat(5000);
      const context: CacheableContext = {
        systemPrompt: largeContent,
        projectContext: largeContent,
        skills: [largeContent],
      };

      const blocks = manager.wrapForCaching(context);

      expect(blocks.length).toBe(3);
      expect(blocks[0].cache_control).toBeDefined();
      expect(blocks[0].cache_control?.type).toBe('ephemeral');
    });

    it('should not add cache_control when disabled', () => {
      manager.configure({ enabled: false });
      const largeContent = 'x'.repeat(5000);
      const context: CacheableContext = {
        systemPrompt: largeContent,
        projectContext: '',
        skills: [],
      };

      const blocks = manager.wrapForCaching(context);

      expect(blocks.length).toBe(1);
      expect(blocks[0].cache_control).toBeUndefined();
    });

    it('should not add cache_control for small content', () => {
      const smallContent = 'Hello world';
      const context: CacheableContext = {
        systemPrompt: smallContent,
        projectContext: '',
        skills: [],
      };

      const blocks = manager.wrapForCaching(context);

      expect(blocks.length).toBe(1);
      expect(blocks[0].cache_control).toBeUndefined();
    });

    it('should respect max cache breakpoints', () => {
      const largeContent = 'x'.repeat(5000);
      const context: CacheableContext = {
        systemPrompt: largeContent,
        projectContext: largeContent,
        skills: [largeContent, largeContent, largeContent],
        toolDefinitions: largeContent,
      };

      const blocks = manager.wrapForCaching(context);

      // Count blocks with cache_control
      const cachedBlocks = blocks.filter((b) => b.cache_control);
      expect(cachedBlocks.length).toBeLessThanOrEqual(4);
    });

    it('should add ttl when configured for 1h', () => {
      manager.configure({ defaultTtl: '1h' });
      const largeContent = 'x'.repeat(5000);
      const context: CacheableContext = {
        systemPrompt: largeContent,
        projectContext: '',
        skills: [],
      };

      const blocks = manager.wrapForCaching(context);

      expect(blocks[0].cache_control?.ttl).toBe('1h');
    });
  });

  describe('Metrics Extraction', () => {
    it('should extract cache metrics from usage', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
      };

      const metrics = manager.extractMetrics(usage, 'test-session');

      expect(metrics.cacheCreationTokens).toBe(5000);
      expect(metrics.cacheReadTokens).toBe(0);
      expect(metrics.regularTokens).toBe(100);
      expect(metrics.hitRate).toBe(0);
    });

    it('should calculate cache hit rate correctly', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 9000,
        input_tokens: 1000,
        output_tokens: 50,
      };

      const metrics = manager.extractMetrics(usage, 'test-session');

      expect(metrics.hitRate).toBe(0.9); // 9000 / 10000
    });

    it('should calculate cost savings correctly', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10000,
        input_tokens: 0,
        output_tokens: 50,
      };

      const metrics = manager.extractMetrics(usage, 'test-session');

      // Cache reads save 90% compared to regular pricing
      expect(metrics.costSavingsPercent).toBeGreaterThan(0);
    });

    it('should emit cache:hit event on cache read', () => {
      const hitSpy = vi.fn();
      manager.on('cache:hit', hitSpy);

      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5000,
        input_tokens: 100,
        output_tokens: 50,
      };

      manager.extractMetrics(usage, 'test-session');

      expect(hitSpy).toHaveBeenCalled();
    });

    it('should emit cache:created event on cache creation', () => {
      const createdSpy = vi.fn();
      manager.on('cache:created', createdSpy);

      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
      };

      manager.extractMetrics(usage, 'test-session');

      expect(createdSpy).toHaveBeenCalled();
    });
  });

  describe('Cumulative Metrics', () => {
    it('should track cumulative metrics across requests', () => {
      const usage1: CacheUsageMetrics = {
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
      };

      const usage2: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5000,
        input_tokens: 100,
        output_tokens: 50,
      };

      manager.extractMetrics(usage1, 'session-1');
      manager.extractMetrics(usage2, 'session-2');

      const cumulative = manager.getCumulativeMetrics();

      expect(cumulative.totalCreation).toBe(5000);
      expect(cumulative.totalRead).toBe(5000);
      expect(cumulative.totalRegular).toBe(200);
      expect(cumulative.requestCount).toBe(2);
    });

    it('should calculate overall hit rate', () => {
      const usage1: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 8000,
        input_tokens: 2000,
        output_tokens: 50,
      };

      manager.extractMetrics(usage1, 'session-1');

      const cumulative = manager.getCumulativeMetrics();

      expect(cumulative.overallHitRate).toBe(0.8); // 8000 / 10000
    });

    it('should reset cumulative metrics', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
      };

      manager.extractMetrics(usage, 'session-1');
      manager.resetCumulativeMetrics();

      const cumulative = manager.getCumulativeMetrics();

      expect(cumulative.totalCreation).toBe(0);
      expect(cumulative.requestCount).toBe(0);
    });
  });

  describe('Cleanup', () => {
    it('should clean up on destroy', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
      };

      manager.extractMetrics(usage, 'session-1');
      manager.destroy();

      // After destroy, getting instance should create new one
      const newManager = getPromptCacheManager();
      const cumulative = newManager.getCumulativeMetrics();

      expect(cumulative.totalCreation).toBe(0);
    });
  });
});
