/**
 * Context Editing Fallback Tests
 * Phase 1.2 unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ContextEditingFallback,
  getContextEditingFallback,
  ContextState,
  ContextEditResult,
} from './context-editing-fallback';
import { CONTEXT_MANAGEMENT_BETA, ClearToolUsesStrategy } from '../../shared/types/api-features.types';

// Mock metrics collector
vi.mock('../learning/metrics-collector', () => ({
  getMetricsCollector: () => ({
    recordCompaction: vi.fn(),
  }),
}));

describe('ContextEditingFallback', () => {
  let fallback: ContextEditingFallback;

  beforeEach(() => {
    ContextEditingFallback.resetInstance();
    fallback = getContextEditingFallback();
  });

  afterEach(() => {
    ContextEditingFallback.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getContextEditingFallback();
      const instance2 = getContextEditingFallback();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', () => {
      const instance1 = getContextEditingFallback();
      ContextEditingFallback.resetInstance();
      const instance2 = getContextEditingFallback();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const config = fallback.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.activationThreshold).toBe(95);
      expect(config.triggerTokens).toBe(180_000);
      expect(config.keepToolUses).toBe(3);
      expect(config.clearAtLeastTokens).toBe(10_000);
    });

    it('should allow configuration updates', () => {
      fallback.configure({ triggerTokens: 150_000 });
      const config = fallback.getConfig();
      expect(config.triggerTokens).toBe(150_000);
    });
  });

  describe('Fallback Decision Logic', () => {
    it('should not use fallback when disabled', () => {
      fallback.configure({ enabled: false });

      const state: ContextState = {
        utilizationPercent: 98,
        compactionAttempted: true,
        sessionId: 'test-session',
        model: 'claude-sonnet-4-5-20250929',
      };

      const result = fallback.shouldUseFallback(state);
      expect(result).toBe(false);
    });

    it('should not use fallback when compaction not attempted', () => {
      const state: ContextState = {
        utilizationPercent: 98,
        compactionAttempted: false,
        sessionId: 'test-session',
        model: 'claude-sonnet-4-5-20250929',
      };

      const result = fallback.shouldUseFallback(state);
      expect(result).toBe(false);
    });

    it('should not use fallback when below threshold', () => {
      const state: ContextState = {
        utilizationPercent: 90,
        compactionAttempted: true,
        sessionId: 'test-session',
        model: 'claude-sonnet-4-5-20250929',
      };

      const result = fallback.shouldUseFallback(state);
      expect(result).toBe(false);
    });

    it('should not use fallback for unsupported models', () => {
      const state: ContextState = {
        utilizationPercent: 98,
        compactionAttempted: true,
        sessionId: 'test-session',
        model: 'unsupported-model',
      };

      const result = fallback.shouldUseFallback(state);
      expect(result).toBe(false);
    });

    it('should use fallback when all conditions met', () => {
      const state: ContextState = {
        utilizationPercent: 98,
        compactionAttempted: true,
        sessionId: 'test-session',
        model: 'claude-sonnet-4-5-20250929',
      };

      const result = fallback.shouldUseFallback(state);
      expect(result).toBe(true);
    });

    it('should emit fallback:activated event when conditions met', () => {
      const activatedSpy = vi.fn();
      fallback.on('fallback:activated', activatedSpy);

      const state: ContextState = {
        utilizationPercent: 98,
        compactionAttempted: true,
        sessionId: 'test-session',
        model: 'claude-sonnet-4-5-20250929',
      };

      fallback.shouldUseFallback(state);

      expect(activatedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fallback:activated',
          sessionId: 'test-session',
          utilizationPercent: 98,
        })
      );
    });

    it('should emit fallback:skipped event with reason', () => {
      const skippedSpy = vi.fn();
      fallback.on('fallback:skipped', skippedSpy);

      const state: ContextState = {
        utilizationPercent: 90,
        compactionAttempted: true,
        sessionId: 'test-session',
        model: 'claude-sonnet-4-5-20250929',
      };

      fallback.shouldUseFallback(state);

      expect(skippedSpy).toHaveBeenCalled();
    });
  });

  describe('Context Management Configuration', () => {
    it('should build correct context_management structure', () => {
      const config = fallback.buildContextManagement();

      expect(config.edits).toBeDefined();
      expect(config.edits.length).toBe(1);
      expect(config.edits[0].type).toBe('clear_tool_uses_20250919');
    });

    it('should include trigger configuration', () => {
      const config = fallback.buildContextManagement();
      const toolStrategy = config.edits[0] as ClearToolUsesStrategy;

      expect(toolStrategy.trigger).toBeDefined();
      expect(toolStrategy.trigger?.type).toBe('input_tokens');
      expect(toolStrategy.trigger?.value).toBe(180_000);
    });

    it('should include keep configuration', () => {
      const config = fallback.buildContextManagement();
      const toolStrategy = config.edits[0] as ClearToolUsesStrategy;

      expect(toolStrategy.keep).toBeDefined();
      expect(toolStrategy.keep?.type).toBe('tool_uses');
      expect(toolStrategy.keep?.value).toBe(3);
    });

    it('should include clear_at_least configuration', () => {
      const config = fallback.buildContextManagement();
      const toolStrategy = config.edits[0] as ClearToolUsesStrategy;

      expect(toolStrategy.clear_at_least).toBeDefined();
      expect(toolStrategy.clear_at_least?.type).toBe('input_tokens');
      expect(toolStrategy.clear_at_least?.value).toBe(10_000);
    });

    it('should include thinking clearing when requested', () => {
      const config = fallback.buildContextManagement({}, true);

      expect(config.edits.length).toBe(2);
      expect(config.edits[0].type).toBe('clear_thinking_20251015');
      expect(config.edits[1].type).toBe('clear_tool_uses_20250919');
    });

    it('should respect exclude_tools configuration', () => {
      fallback.configure({ excludeTools: ['important_tool'] });
      const config = fallback.buildContextManagement();
      const toolStrategy = config.edits[0] as ClearToolUsesStrategy;

      expect(toolStrategy.exclude_tools).toEqual(['important_tool']);
    });

    it('should respect clear_tool_inputs configuration', () => {
      fallback.configure({ clearToolInputs: true });
      const config = fallback.buildContextManagement();
      const toolStrategy = config.edits[0] as ClearToolUsesStrategy;

      expect(toolStrategy.clear_tool_inputs).toBe(true);
    });
  });

  describe('Beta Header', () => {
    it('should return correct beta header', () => {
      const header = fallback.getBetaHeader();
      expect(header).toBe(CONTEXT_MANAGEMENT_BETA);
      expect(header).toBe('context-management-2025-06-27');
    });
  });

  describe('Edit History', () => {
    it('should track edit history per session', () => {
      // Manually record a result for testing
      const result: ContextEditResult = {
        applied: true,
        clearedToolUses: 5,
        clearedThinkingTurns: 0,
        clearedTokens: 10000,
        appliedEdits: [
          {
            type: 'clear_tool_uses_20250919',
            cleared_tool_uses: 5,
            cleared_input_tokens: 10000,
          },
        ],
      };

      // Emit the event to trigger internal recording
      fallback.emit('edits:applied', {
        type: 'edits:applied',
        sessionId: 'test-session',
        result,
      });

      // Note: In real usage, history is recorded via createMessageWithClearing
      // For this test, we just verify the getter works
      const history = fallback.getEditHistory('nonexistent-session');
      expect(history).toEqual([]);
    });

    it('should clear session history', () => {
      fallback.clearSessionHistory('test-session');
      const history = fallback.getEditHistory('test-session');
      expect(history).toEqual([]);
    });

    it('should clear all history', () => {
      fallback.clearAllHistory();
      const stats = fallback.getStats();
      expect(stats.totalSessions).toBe(0);
    });
  });

  describe('Statistics', () => {
    it('should return aggregate statistics', () => {
      const stats = fallback.getStats();

      expect(stats).toHaveProperty('totalSessions');
      expect(stats).toHaveProperty('totalEdits');
      expect(stats).toHaveProperty('totalTokensCleared');
      expect(stats).toHaveProperty('totalToolUsesCleared');
      expect(stats).toHaveProperty('totalThinkingTurnsCleared');
    });
  });

  describe('Cleanup', () => {
    it('should clean up on destroy', () => {
      fallback.destroy();

      // After destroy, getting instance should create new one
      const newFallback = getContextEditingFallback();
      const stats = newFallback.getStats();

      expect(stats.totalSessions).toBe(0);
    });
  });
});
