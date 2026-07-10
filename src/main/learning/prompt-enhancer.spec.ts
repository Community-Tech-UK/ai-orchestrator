import { beforeEach, describe, expect, it, vi } from 'vitest';

const tracker = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ enableAutoEnhancement: true, maxEnhancementTokens: 2_000 })),
  getExperience: vi.fn(() => ({
    id: 'experience-1',
    avgSuccessRate: 0.43,
    sampleSize: 12,
    successfulPatterns: [],
    failurePatterns: [],
    examplePrompts: [{ prompt: 'SECRET PRIOR PROMPT FRAGMENT', outcome: 'success' }],
  })),
  getInsights: vi.fn(() => []),
}));

vi.mock('./outcome-tracker', () => ({
  OutcomeTracker: { getInstance: () => tracker },
}));

vi.mock('./strategy-learner', () => ({
  StrategyLearner: { getInstance: () => ({}) },
}));

import { PromptEnhancer } from './prompt-enhancer';

describe('PromptEnhancer learned-hint hygiene', () => {
  beforeEach(() => {
    PromptEnhancer._resetForTesting();
  });

  it('does not prime with historical rates or replay prior prompt fragments', () => {
    const result = PromptEnhancer.getInstance().enhance(
      'Implement the requested change.',
      'unknown-task',
      'Prefer the existing parser seam.',
    );

    expect(result.enhancedPrompt).not.toContain('Historical success rate');
    expect(result.enhancedPrompt).not.toContain('SECRET PRIOR PROMPT FRAGMENT');
    expect(result.enhancedPrompt).toContain('<learned_hints>');
    expect(result.enhancedPrompt).toContain('subordinate to the user request');
  });
});
