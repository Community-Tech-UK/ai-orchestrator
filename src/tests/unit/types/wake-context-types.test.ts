import { describe, it, expect } from 'vitest';
import type {
  WakeContext,
  WakeHint,
  ContextLayer,
  WakeContextConfig,
} from '../../../shared/types/wake-context.types';

describe('wake-context types', () => {
  it('should create a wake hint', () => {
    const hint: WakeHint = {
      id: 'hint_001',
      content: 'User prefers TypeScript over Python',
      importance: 8,
      room: 'preferences',
      sourceReflectionId: 'ref_123',
      createdAt: Date.now(),
      lastUsed: Date.now(),
      usageCount: 3,
    };
    expect(hint.importance).toBe(8);
  });

  it('should create a layered context', () => {
    const layer: ContextLayer = {
      level: 'L1',
      content: '## Essential Story\n[backend] User prefers event-driven...',
      tokenEstimate: 450,
      generatedAt: Date.now(),
    };
    expect(layer.level).toBe('L1');
  });

  it('should create full wake context', () => {
    const ctx: WakeContext = {
      identity: { level: 'L0', content: 'AI orchestrator assistant', tokenEstimate: 25, generatedAt: Date.now() },
      essentialStory: { level: 'L1', content: '## L1\n...', tokenEstimate: 500, generatedAt: Date.now() },
      totalTokens: 525,
      wing: 'project_a',
      generatedAt: Date.now(),
    };
    expect(ctx.totalTokens).toBe(525);
  });

  it('should create config with token budgets', () => {
    const config: WakeContextConfig = {
      l0MaxTokens: 100,
      l1MaxTokens: 800,
      l1MaxHints: 15,
      l1SnippetMaxChars: 200,
      regenerateIntervalMs: 5 * 60 * 1000,
    };
    expect(config.l1MaxHints).toBe(15);
  });
});
