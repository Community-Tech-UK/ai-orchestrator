import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../rlm/llm-service', () => ({
  getLLMService: () => ({
    configure: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(false),
    summarize: vi.fn().mockResolvedValue('Summary of conversation'),
  }),
}));

vi.mock('../../../shared/constants/limits', () => ({
  LIMITS: {
    DEFAULT_MAX_CONTEXT_TOKENS: 200000,
  },
}));

import { ContextCompactor, buildCompactionPrompt } from '../context-compactor';
import type { ConversationTurn, ToolCallRecord } from '../context-compactor';

function makeTurn(overrides?: Partial<ConversationTurn>): Omit<ConversationTurn, 'id' | 'timestamp'> {
  return {
    role: 'user',
    content: 'Hello',
    tokenCount: 100,
    ...overrides,
  };
}

function makeToolCall(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: `tool-${Math.random().toString(36).slice(2, 8)}`,
    name: 'read_file',
    input: '{"path": "foo.ts"}',
    output: 'file contents here...',
    inputTokens: 50,
    outputTokens: 200,
    ...overrides,
  };
}

describe('ContextCompactor', () => {
  let compactor: ContextCompactor;

  beforeEach(() => {
    ContextCompactor._resetForTesting();
    compactor = ContextCompactor.getInstance();
    compactor.updateConfig({ maxContextTokens: 10000, autoCompact: false });
  });

  describe('singleton pattern', () => {
    it('returns the same instance', () => {
      expect(ContextCompactor.getInstance()).toBe(compactor);
    });

    it('resets for testing', () => {
      ContextCompactor._resetForTesting();
      expect(ContextCompactor.getInstance()).not.toBe(compactor);
    });
  });

  describe('addTurn', () => {
    it('adds a turn and updates token count', () => {
      compactor.addTurn(makeTurn({ tokenCount: 500 }));

      const state = compactor.getState();
      expect(state.turns).toHaveLength(1);
      expect(state.totalTokens).toBe(500);
    });

    it('includes tool call tokens in total', () => {
      const toolCall = makeToolCall({ inputTokens: 50, outputTokens: 200 });
      compactor.addTurn(makeTurn({ tokenCount: 100, toolCalls: [toolCall] }));

      const state = compactor.getState();
      // 100 (turn) + 50 (input) + 200 (output) = 350
      expect(state.totalTokens).toBe(350);
    });

    it('accumulates tokens across multiple turns', () => {
      compactor.addTurn(makeTurn({ tokenCount: 300 }));
      compactor.addTurn(makeTurn({ tokenCount: 400 }));
      compactor.addTurn(makeTurn({ tokenCount: 200 }));

      expect(compactor.getState().totalTokens).toBe(900);
    });

    it('updates fill ratio correctly', () => {
      compactor.updateConfig({ maxContextTokens: 1000 });
      compactor.addTurn(makeTurn({ tokenCount: 500 }));

      expect(compactor.getFillRatio()).toBeCloseTo(0.5, 1);
    });

    it('emits turn-added event', () => {
      const handler = vi.fn();
      compactor.on('turn-added', handler);

      compactor.addTurn(makeTurn({ content: 'test message' }));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toMatchObject({ content: 'test message' });
    });
  });

  describe('shouldCompact', () => {
    it('returns false below threshold', () => {
      compactor.updateConfig({ maxContextTokens: 10000, triggerThreshold: 0.85 });
      compactor.addTurn(makeTurn({ tokenCount: 5000 })); // 50% fill

      expect(compactor.shouldCompact()).toBe(false);
    });

    it('returns true at or above threshold', () => {
      compactor.updateConfig({ maxContextTokens: 10000, triggerThreshold: 0.85 });
      compactor.addTurn(makeTurn({ tokenCount: 8600 })); // 86% fill

      expect(compactor.shouldCompact()).toBe(true);
    });

    it('returns true exactly at threshold', () => {
      compactor.updateConfig({ maxContextTokens: 10000, triggerThreshold: 0.85 });
      compactor.addTurn(makeTurn({ tokenCount: 8500 })); // exactly 85%

      expect(compactor.shouldCompact()).toBe(true);
    });
  });

  describe('pruneToolOutputs', () => {
    it('returns zero when no tool calls exist', () => {
      compactor.addTurn(makeTurn({ tokenCount: 100 }));

      const result = compactor.pruneToolOutputs();
      expect(result.prunedTokens).toBe(0);
      expect(result.prunedTurns).toBe(0);
    });

    it('does not prune when total tool output is below minimum threshold', () => {
      // PRUNE_MINIMUM_TOKENS is 20000, PRUNE_PROTECT_TOKENS is 40000
      // We need tool output > 40000 (protect) + 20000 (minimum) = 60000 to trigger pruning
      const toolCall = makeToolCall({ outputTokens: 5000 });
      compactor.addTurn(makeTurn({ tokenCount: 100, toolCalls: [toolCall] }));

      const result = compactor.pruneToolOutputs();
      expect(result.prunedTokens).toBe(0);
    });

    it('prunes old tool outputs while protecting recent ones', () => {
      compactor.updateConfig({ maxContextTokens: 500000 });

      // Add many turns with large tool outputs to exceed protection + minimum thresholds
      // PRUNE_PROTECT_TOKENS = 40000, PRUNE_MINIMUM_TOKENS = 20000
      // Need total tool output > 60000
      for (let i = 0; i < 10; i++) {
        const toolCall = makeToolCall({ outputTokens: 10000, output: 'x'.repeat(1000) });
        compactor.addTurn(makeTurn({ tokenCount: 100, toolCalls: [toolCall] }));
      }
      // Total tool output = 100,000 tokens
      // Protected: 40,000 (most recent turns)
      // Prunable: 60,000 (> 20,000 minimum)

      const tokensBefore = compactor.getState().totalTokens;
      const result = compactor.pruneToolOutputs();

      expect(result.prunedTokens).toBeGreaterThan(0);
      expect(result.prunedTurns).toBeGreaterThan(0);
      expect(compactor.getState().totalTokens).toBeLessThan(tokensBefore);
    });

    it('replaces pruned tool outputs with placeholder text', () => {
      compactor.updateConfig({ maxContextTokens: 500000 });

      for (let i = 0; i < 10; i++) {
        const toolCall = makeToolCall({ outputTokens: 10000, output: 'original content' });
        compactor.addTurn(makeTurn({ tokenCount: 100, toolCalls: [toolCall] }));
      }

      compactor.pruneToolOutputs();

      // Check that some older turns have pruned output
      const state = compactor.getState();
      const prunedTurns = state.turns.filter(
        (t) => t.toolCalls?.some((tc) => tc.output === '[Output pruned for context optimization]')
      );
      expect(prunedTurns.length).toBeGreaterThan(0);
    });
  });

  describe('config management', () => {
    it('applies partial config updates', () => {
      compactor.updateConfig({ triggerThreshold: 0.9 });

      const config = compactor.getConfig();
      expect(config.triggerThreshold).toBe(0.9);
      // Other defaults preserved
      expect(config.preserveRecent).toBe(5);
    });

    it('emits config-updated event', () => {
      const handler = vi.fn();
      compactor.on('config-updated', handler);

      compactor.updateConfig({ autoCompact: true });

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('getState', () => {
    it('returns a defensive copy', () => {
      compactor.addTurn(makeTurn());
      const state1 = compactor.getState();
      const state2 = compactor.getState();

      expect(state1).toEqual(state2);
      expect(state1.turns).not.toBe(state2.turns); // Different array instances
    });
  });

  describe('buildCompactionPrompt (anchored template)', () => {
    it('includes all required section headers in the prompt', () => {
      const prompt = buildCompactionPrompt('some conversation text', null);
      expect(prompt).toContain('## Objective');
      expect(prompt).toContain('## Current State');
      expect(prompt).toContain('## Key Decisions');
      expect(prompt).toContain('## Files Touched');
      expect(prompt).toContain('## Pending Work');
      expect(prompt).toContain('## Blockers');
      expect(prompt).toContain('## Commands Run');
      expect(prompt).toContain('## Verification Status');
    });

    it('embeds conversation text in the prompt', () => {
      const prompt = buildCompactionPrompt('user said hello', null);
      expect(prompt).toContain('user said hello');
    });

    it('omits anchor section when no prior summary', () => {
      const prompt = buildCompactionPrompt('text', null);
      expect(prompt).not.toContain('<prior_summary>');
    });

    it('embeds prior summary as anchor when provided', () => {
      const prior = '## Objective\nRefactor auth module';
      const prompt = buildCompactionPrompt('new turns text', prior);
      expect(prompt).toContain('<prior_summary>');
      expect(prompt).toContain('## Objective\nRefactor auth module');
      expect(prompt).toContain('Preserve all decisions and state from the prior summary');
    });

    it('instructs LLM to add only deltas when a prior summary is present', () => {
      const prompt = buildCompactionPrompt('new conversation', '## Objective\nFix bug');
      expect(prompt).toContain('Only add deltas for what changed');
    });
  });

  describe('local fallback generateLocalSummary (via compact)', () => {
    // Helper that creates a config where compaction will fire and the local
    // summary will be smaller than the compacted turns.  We use 10 turns of
    // 100 tokens each (1000 total) and preserve only the last 2.  The local
    // summary is ~70 tokens; newTotal ≈ 70 + 200 = 270 < 1000 → passes
    // post-compaction verification.
    function largeCompactionConfig() {
      return {
        maxContextTokens: 1100,
        autoCompact: false,
        triggerThreshold: 0.85,
        preserveRecent: 2,
      };
    }

    function addManyTurns(content = 'implement the new auth flow') {
      for (let i = 0; i < 10; i++) {
        compactor.addTurn(makeTurn({
          tokenCount: 100,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content,
        }));
      }
    }

    it('produces a structured summary with section headers', async () => {
      compactor.updateConfig(largeCompactionConfig());
      addManyTurns();

      const result = await compactor.compact();
      expect(result.summaryGenerated).toBe(true);

      const state = compactor.getState();
      expect(state.summaries).toHaveLength(1);
      expect(state.summaries[0].content).toContain('## Objective');
      expect(state.summaries[0].content).toContain('## Current State');
      expect(state.summaries[0].content).toContain('## Commands Run');
      expect(state.summaries[0].content).toContain('## Verification Status');
    });

    it('includes tool invocations in the Commands Run section', async () => {
      compactor.updateConfig(largeCompactionConfig());

      const toolCall = makeToolCall({ name: 'bash', output: 'exit 0' });
      for (let i = 0; i < 10; i++) {
        compactor.addTurn(makeTurn({
          tokenCount: 100,
          role: i % 2 === 0 ? 'user' : 'assistant',
          toolCalls: i === 0 ? [toolCall] : undefined,
        }));
      }

      const result = await compactor.compact();
      expect(result.summaryGenerated).toBe(true);

      const summary = compactor.getState().summaries[0].content;
      expect(summary).toContain('## Commands Run');
      expect(summary).toContain('bash');
    });

    it('anchors subsequent summaries on the previous one', async () => {
      compactor.updateConfig(largeCompactionConfig());
      addManyTurns('first objective: fix login');
      await compactor.compact();

      expect(compactor.getState().summaries).toHaveLength(1);

      // After compaction, totalTokens ≈ 270.  Add 10 more turns of 100 to
      // push back over threshold (270 + 1000 = 1270 > 0.85 * 1100 = 935).
      addManyTurns('second objective: add tests');
      await compactor.compact();

      const state = compactor.getState();
      expect(state.summaries.length).toBeGreaterThanOrEqual(2);
      const latestSummary = state.summaries[state.summaries.length - 1].content;
      expect(latestSummary).toContain('prior compaction');
    });
  });
});
