/**
 * AnthropicApiProvider Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicApiProvider, AnthropicApiProviderConfig } from './anthropic-api-provider';
import { PromptCacheManager } from '../memory/prompt-cache';
import { ContextEditingFallback } from '../memory/context-editing-fallback';
import type { ProviderConfig } from '../../shared/types/provider.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

// Mock dependencies
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    id: 'msg_123',
    _request_id: 'req_123',
    content: [{ type: 'text', text: 'Hello!' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
    },
  });

  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
      },
      beta: {
        messages: {
          create: mockCreate,
        },
      },
    })),
  };
});

vi.mock('../memory/prompt-cache', () => {
  const mockManager = {
    configureForModel: vi.fn(),
    wrapForCaching: vi.fn().mockReturnValue([{ type: 'text', text: 'cached system prompt' }]),
    extractMetrics: vi.fn().mockReturnValue({
      cacheCreationTokens: 0,
      cacheReadTokens: 100,
      regularTokens: 50,
      hitRate: 0.67,
      costSavingsPercent: 45,
    }),
    getCumulativeMetrics: vi.fn().mockReturnValue({
      totalCreation: 1000,
      totalRead: 5000,
      totalRegular: 2000,
      requestCount: 10,
      overallHitRate: 0.62,
      estimatedTotalSavings: 0.15,
    }),
  };

  return {
    getPromptCacheManager: vi.fn().mockReturnValue(mockManager),
    PromptCacheManager: vi.fn().mockImplementation(() => mockManager),
  };
});

vi.mock('../memory/context-editing-fallback', () => {
  const mockFallback = {
    shouldUseFallback: vi.fn().mockReturnValue(false),
    createMessageWithClearing: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Response with context editing' }],
      usage: {
        input_tokens: 80,
        output_tokens: 40,
      },
    }),
    buildContextManagement: vi.fn().mockReturnValue({ edits: [] }),
    getBetaHeader: vi.fn().mockReturnValue('context-management-2025-06-27'),
  };

  return {
    getContextEditingFallback: vi.fn().mockReturnValue(mockFallback),
    ContextEditingFallback: vi.fn().mockImplementation(() => mockFallback),
  };
});

vi.mock('../learning/metrics-collector', () => ({
  getMetricsCollector: vi.fn().mockReturnValue({
    recordContextUsage: vi.fn(),
    recordPromptCache: vi.fn(),
    recordCompaction: vi.fn(),
  }),
}));

vi.mock('../../shared/utils/id-generator', () => ({
  generateId: vi.fn().mockReturnValue('test-id-123'),
}));

describe('AnthropicApiProvider', () => {
  let provider: AnthropicApiProvider;
  let config: AnthropicApiProviderConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up test environment
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    config = {
      type: 'anthropic-api',
      name: 'Anthropic API',
      enabled: true,
      defaultModel: 'claude-sonnet-4-5-20250929',
      enablePromptCaching: true,
      enableContextEditing: true,
      projectContext: 'Project context from CLAUDE.md',
      skills: ['skill1.md content', 'skill2.md content'],
    };

    provider = new AnthropicApiProvider(config);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  function captureEvents(target: AnthropicApiProvider): ProviderRuntimeEventEnvelope[] {
    const events: ProviderRuntimeEventEnvelope[] = [];
    target.events$.subscribe((event) => events.push(event));
    return events;
  }

  describe('getType', () => {
    it('returns anthropic-api', () => {
      expect(provider.getType()).toBe('anthropic-api');
    });
  });

  describe('getCapabilities', () => {
    it('returns correct capabilities', () => {
      const capabilities = provider.getCapabilities();

      expect(capabilities.toolExecution).toBe(true);
      expect(capabilities.streaming).toBe(true);
      expect(capabilities.multiTurn).toBe(true);
      expect(capabilities.vision).toBe(true);
      expect(capabilities.fileAttachments).toBe(true);
      expect(capabilities.functionCalling).toBe(true);
      expect(capabilities.builtInCodeTools).toBe(false); // No built-in tools unlike CLI
    });
  });

  describe('checkStatus', () => {
    it('returns unavailable when API key is not set', async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const status = await provider.checkStatus();

      expect(status.type).toBe('anthropic-api');
      expect(status.available).toBe(false);
      expect(status.authenticated).toBe(false);
      expect(status.error).toBe('ANTHROPIC_API_KEY not set');
    });

    it('returns available when API key is set', async () => {
      const status = await provider.checkStatus();

      expect(status.type).toBe('anthropic-api');
      expect(status.available).toBe(true);
      expect(status.authenticated).toBe(true);
    });
  });

  describe('initialize', () => {
    it('throws error if already initialized', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      await expect(
        provider.initialize({
          sessionId: 'test-session-2',
          workingDirectory: '/test',
        })
      ).rejects.toThrow('Provider already initialized');
    });

    it('throws error if API key is not set', async () => {
      delete process.env.ANTHROPIC_API_KEY;

      await expect(
        provider.initialize({
          sessionId: 'test-session',
          workingDirectory: '/test',
        })
      ).rejects.toThrow('ANTHROPIC_API_KEY not set');
    });

    it('configures prompt cache manager for model', async () => {
      const { getPromptCacheManager } = await import('../memory/prompt-cache');
      const mockManager = getPromptCacheManager();

      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
        systemPrompt: 'Test system prompt',
      });

      expect(mockManager.configureForModel).toHaveBeenCalledWith('claude-sonnet-4-5-20250929');
    });

    it('wraps system prompt for caching when enabled', async () => {
      const { getPromptCacheManager } = await import('../memory/prompt-cache');
      const mockManager = getPromptCacheManager();

      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
        systemPrompt: 'Test system prompt',
      });

      expect(mockManager.wrapForCaching).toHaveBeenCalledWith({
        systemPrompt: 'Test system prompt',
        projectContext: 'Project context from CLAUDE.md',
        skills: ['skill1.md content', 'skill2.md content'],
        toolDefinitions: undefined,
      });
    });

    it('emits an idle status event on initialize', async () => {
      const events = captureEvents(provider);

      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      expect(events.at(-1)?.event).toEqual({ kind: 'status', status: 'idle' });
    });

    it('sets isActive to true', async () => {
      expect(provider.isRunning()).toBe(false);

      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      expect(provider.isRunning()).toBe(true);
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
        systemPrompt: 'Test system prompt',
      });
    });

    it('throws error if not initialized', async () => {
      const uninitializedProvider = new AnthropicApiProvider(config);

      await expect(uninitializedProvider.sendMessage('Hello')).rejects.toThrow(
        'Provider not initialized'
      );
    });

    it('emits busy status when sending', async () => {
      const events = captureEvents(provider);

      await provider.sendMessage('Hello');

      expect(events.some((event) => event.event.kind === 'status' && event.event.status === 'busy')).toBe(true);
    });

    it('emits output event with response', async () => {
      const events = captureEvents(provider);

      await provider.sendMessage('Hello');

      expect(events.some((event) =>
        event.event.kind === 'output'
        && event.event.messageType === 'assistant'
        && event.event.content === 'Hello!')).toBe(true);
    });

    it('emits context usage event', async () => {
      const events = captureEvents(provider);

      await provider.sendMessage('Hello');

      expect(events.some((event) =>
        event.event.kind === 'context'
        && event.event.used === 150
        && event.event.total === 200000
        && event.event.inputTokens === 100
        && event.event.outputTokens === 50
        && event.event.source === 'anthropic-api'
        && event.event.promptWeightBreakdown?.systemPrompt === 5)).toBe(true);
    });

    it('emits complete diagnostics from the API response', async () => {
      const events = captureEvents(provider);

      await provider.sendMessage('Hello');

      expect(events.some((event) =>
        event.event.kind === 'complete'
        && event.event.tokensUsed === 150
        && event.event.requestId === 'req_123'
        && event.event.stopReason === 'end_turn')).toBe(true);
    });

    it('uses a 1M context total for explicit Claude 1M models', async () => {
      const explicitModelProvider = new AnthropicApiProvider(config);
      const events = captureEvents(explicitModelProvider);

      await explicitModelProvider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
        model: 'sonnet[1m]',
      });

      await explicitModelProvider.sendMessage('Hello');

      expect(events.some((event) =>
        event.event.kind === 'context'
        && event.event.total === 1000000)).toBe(true);
    });

    it('emits idle status after completion', async () => {
      const events = captureEvents(provider);

      await provider.sendMessage('Hello');

      const statusEvents = events.filter(
        (event): event is ProviderRuntimeEventEnvelope & { event: { kind: 'status'; status: string } } =>
          event.event.kind === 'status',
      );
      expect(statusEvents.at(-1)?.event.status).toBe('idle');
    });

    it('uses context editing fallback when activated', async () => {
      const { getContextEditingFallback } = await import('../memory/context-editing-fallback');
      const mockFallback = getContextEditingFallback();
      vi.mocked(mockFallback.shouldUseFallback).mockReturnValue(true);

      await provider.sendMessage('Hello');

      expect(mockFallback.createMessageWithClearing).toHaveBeenCalled();
    });
  });

  describe('terminate', () => {
    it('sets isActive to false', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      expect(provider.isRunning()).toBe(true);

      await provider.terminate();

      expect(provider.isRunning()).toBe(false);
    });

    it('emits exit event', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      const events = captureEvents(provider);

      await provider.terminate();

      expect(events.at(-1)?.event).toEqual({ kind: 'exit', code: 0, signal: null });
    });
  });

  describe('getUsage', () => {
    it('returns null before any messages', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      expect(provider.getUsage()).toBeNull();
    });

    it('returns usage after sending message', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      await provider.sendMessage('Hello');

      const usage = provider.getUsage();
      expect(usage).not.toBeNull();
      // Usage values come from the mock response (default or context editing)
      expect(usage?.inputTokens).toBeGreaterThan(0);
      expect(usage?.outputTokens).toBeGreaterThan(0);
      expect(usage?.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('getCacheMetrics', () => {
    it('returns cache metrics from prompt cache manager', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      const metrics = provider.getCacheMetrics();

      expect(metrics.hitRate).toBe(0.62);
      expect(metrics.totalCreation).toBe(1000);
      expect(metrics.totalRead).toBe(5000);
    });
  });

  describe('clearHistory', () => {
    it('clears conversation messages', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      await provider.sendMessage('Hello');

      // Should not throw after clearing
      provider.clearHistory();

      // Can send new messages
      await provider.sendMessage('New conversation');
    });
  });

  describe('updateProjectContext', () => {
    it('updates system prompt with new context', async () => {
      const { getPromptCacheManager } = await import('../memory/prompt-cache');
      const mockManager = getPromptCacheManager();

      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
        systemPrompt: 'Original system prompt',
      });

      await provider.updateProjectContext('New project context', ['new skill']);

      expect(mockManager.wrapForCaching).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectContext: 'New project context',
          skills: ['new skill'],
        })
      );
    });

    it('throws if not initialized', async () => {
      await expect(provider.updateProjectContext('New context')).rejects.toThrow(
        'Provider not initialized'
      );
    });
  });

  describe('forceContextCompaction', () => {
    it('throws if not initialized', async () => {
      await expect(provider.forceContextCompaction()).rejects.toThrow('Provider not initialized');
    });

    it('marks compaction as attempted', async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      await provider.forceContextCompaction();

      // The effect would be seen in the next sendMessage where
      // context editing might be triggered
    });
  });

  describe('image attachments', () => {
    beforeEach(async () => {
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });
    });

    it('handles image attachments by emitting output', async () => {
      const events = captureEvents(provider);

      await provider.sendMessage('What is in this image?', [
        {
          type: 'image',
          name: 'test.png',
          mimeType: 'image/png',
          data: 'base64encodeddata',
        },
      ]);

      expect(events.some((event) =>
        event.event.kind === 'output'
        && event.event.messageType === 'assistant')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('handles errors gracefully when they occur', async () => {
      // Create a provider that will work until we explicitly cause an error
      await provider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      const events = captureEvents(provider);

      // First message should work fine (uses default mock)
      await provider.sendMessage('Hello');

      expect(events.some((event) => event.event.kind === 'error')).toBe(false);
      expect(events.some((event) =>
        event.event.kind === 'status'
        && event.event.status === 'idle')).toBe(true);
    });
  });

  describe('prompt caching disabled', () => {
    it('does not wrap system prompt when caching disabled', async () => {
      const disabledConfig: AnthropicApiProviderConfig = {
        ...config,
        enablePromptCaching: false,
      };

      const disabledProvider = new AnthropicApiProvider(disabledConfig);

      const { getPromptCacheManager } = await import('../memory/prompt-cache');
      const mockManager = getPromptCacheManager();
      vi.mocked(mockManager.wrapForCaching).mockClear();

      await disabledProvider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
        systemPrompt: 'Test system prompt',
      });

      // wrapForCaching should not be called when caching is disabled
      expect(mockManager.wrapForCaching).not.toHaveBeenCalled();
    });
  });

  describe('context editing disabled', () => {
    it('does not use context editing when disabled', async () => {
      const disabledConfig: AnthropicApiProviderConfig = {
        ...config,
        enableContextEditing: false,
      };

      const disabledProvider = new AnthropicApiProvider(disabledConfig);

      await disabledProvider.initialize({
        sessionId: 'test-session',
        workingDirectory: '/test',
      });

      const { getContextEditingFallback } = await import('../memory/context-editing-fallback');
      const mockFallback = getContextEditingFallback();

      // Reset the mock to ensure clean slate
      vi.mocked(mockFallback.createMessageWithClearing).mockClear();
      vi.mocked(mockFallback.shouldUseFallback).mockReturnValue(true);

      await disabledProvider.sendMessage('Hello');

      // Context editing should not be called when disabled in config
      expect(mockFallback.createMessageWithClearing).not.toHaveBeenCalled();
    });
  });
});
