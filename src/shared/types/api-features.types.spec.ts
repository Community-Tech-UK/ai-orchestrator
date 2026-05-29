/**
 * API Features Types Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  supportsPromptCaching,
  supportsContextEditing,
  getMinCacheableTokens,
  calculateCachePerformance,
  CONTEXT_MANAGEMENT_BETA,
  PROMPT_CACHING_MODELS,
  MIN_CACHEABLE_TOKENS,
  type CacheUsageMetrics,
  type CacheControl,
  type ClearToolUsesStrategy,
  type ClearThinkingStrategy,
  type ContextManagement,
} from './api-features.types';

describe('API Features Types', () => {
  describe('supportsPromptCaching', () => {
    it('should return true for supported models', () => {
      expect(supportsPromptCaching('claude-sonnet-4-5-20250929')).toBe(true);
      expect(supportsPromptCaching('claude-opus-4-5-20251101')).toBe(true);
      expect(supportsPromptCaching('claude-haiku-4-5-20251001')).toBe(true);
    });

    it('should return true for model variants', () => {
      expect(supportsPromptCaching('claude-sonnet-4-5')).toBe(true);
      expect(supportsPromptCaching('claude-opus-4-1')).toBe(true);
    });

    it('should return false for unsupported models', () => {
      expect(supportsPromptCaching('gpt-4')).toBe(false);
      expect(supportsPromptCaching('claude-2.1')).toBe(false);
    });
  });

  describe('supportsContextEditing', () => {
    it('should return same as prompt caching support', () => {
      expect(supportsContextEditing('claude-sonnet-4-5-20250929')).toBe(true);
      expect(supportsContextEditing('gpt-4')).toBe(false);
    });
  });

  describe('getMinCacheableTokens', () => {
    it('should return correct minimum tokens for Sonnet', () => {
      expect(getMinCacheableTokens('claude-sonnet-4-5-20250929')).toBe(1024);
    });

    it('should return correct minimum tokens for Opus 4.5', () => {
      expect(getMinCacheableTokens('claude-opus-4-5-20251101')).toBe(4096);
    });

    it('should return correct minimum tokens for Haiku 4.5', () => {
      expect(getMinCacheableTokens('claude-haiku-4-5-20251001')).toBe(4096);
    });

    it('should return default for unknown models', () => {
      expect(getMinCacheableTokens('unknown-model')).toBe(1024);
    });
  });

  describe('calculateCachePerformance', () => {
    it('should calculate 100% hit rate when all from cache', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10000,
        input_tokens: 0,
        output_tokens: 100,
      };

      const performance = calculateCachePerformance(usage);
      expect(performance.hitRate).toBe(1);
      expect(performance.tokensFromCache).toBe(10000);
      expect(performance.tokensWrittenToCache).toBe(0);
    });

    it('should calculate 0% hit rate for first request', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
      };

      const performance = calculateCachePerformance(usage);
      expect(performance.hitRate).toBe(0);
      expect(performance.tokensWrittenToCache).toBe(10000);
      expect(performance.regularInputTokens).toBe(100);
    });

    it('should calculate mixed usage correctly', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 9000,
        input_tokens: 100,
        output_tokens: 50,
      };

      const performance = calculateCachePerformance(usage);
      // Hit rate = 9000 / (9000 + 1000 + 100) = 0.89
      expect(performance.hitRate).toBeCloseTo(0.89, 1);
      expect(performance.tokensFromCache).toBe(9000);
    });

    it('should handle zero tokens gracefully', () => {
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      };

      const performance = calculateCachePerformance(usage);
      expect(performance.hitRate).toBe(0);
      expect(performance.costSavingsPercent).toBe(0);
    });

    it('should calculate cost savings correctly', () => {
      // Cache reads save 90% (cost 10%), writes cost 25% extra
      const usage: CacheUsageMetrics = {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10000, // Saves 90% = 9000 tokens worth
        input_tokens: 100,
        output_tokens: 50,
      };

      const performance = calculateCachePerformance(usage);
      // Savings = 10000 * 0.9 = 9000 token-equivalents
      // Total = 10000 + 100 = 10100
      // Savings % = 9000 / 10100 * 100 ≈ 89%
      expect(performance.costSavingsPercent).toBeGreaterThan(80);
    });
  });

  describe('type definitions', () => {
    it('should have correct beta header constant', () => {
      expect(CONTEXT_MANAGEMENT_BETA).toBe('context-management-2025-06-27');
    });

    it('should have PROMPT_CACHING_MODELS array', () => {
      expect(PROMPT_CACHING_MODELS.length).toBeGreaterThan(0);
      expect(PROMPT_CACHING_MODELS).toContain('claude-sonnet-4-5-20250929');
      expect(PROMPT_CACHING_MODELS).toContain('claude-opus-4-8');
      expect(MIN_CACHEABLE_TOKENS['claude-opus-4-8']).toBe(1024);
    });

    it('should define CacheControl type correctly', () => {
      const control: CacheControl = { type: 'ephemeral' };
      expect(control.type).toBe('ephemeral');

      const controlWithTtl: CacheControl = { type: 'ephemeral', ttl: '1h' };
      expect(controlWithTtl.ttl).toBe('1h');
    });

    it('should define ClearToolUsesStrategy type correctly', () => {
      const strategy: ClearToolUsesStrategy = {
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: 100000 },
        keep: { type: 'tool_uses', value: 3 },
      };
      expect(strategy.type).toBe('clear_tool_uses_20250919');
    });

    it('should define ClearThinkingStrategy type correctly', () => {
      const strategyWithValue: ClearThinkingStrategy = {
        type: 'clear_thinking_20251015',
        keep: { type: 'thinking_turns', value: 2 },
      };
      expect(strategyWithValue.type).toBe('clear_thinking_20251015');

      const strategyWithAll: ClearThinkingStrategy = {
        type: 'clear_thinking_20251015',
        keep: 'all',
      };
      expect(strategyWithAll.keep).toBe('all');
    });

    it('should define ContextManagement type correctly', () => {
      const contextMgmt: ContextManagement = {
        edits: [
          { type: 'clear_thinking_20251015', keep: 'all' },
          {
            type: 'clear_tool_uses_20250919',
            trigger: { type: 'input_tokens', value: 50000 },
          },
        ],
      };
      expect(contextMgmt.edits).toHaveLength(2);
    });
  });
});
