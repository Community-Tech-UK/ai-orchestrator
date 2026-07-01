import { describe, expect, it } from 'vitest';
import { buildAnthropicKnownModels } from './model-discovery.catalog';

describe('buildAnthropicKnownModels', () => {
  it('includes Claude Fable 5 with documented API limits and pricing', () => {
    const models = buildAnthropicKnownModels();
    const fable = models.find((model) => model.id === 'claude-fable-5');

    expect(fable).toBeDefined();
    expect(fable!.displayName).toBe('Claude Fable 5');
    expect(fable!.contextLength).toBe(1_000_000);
    expect(fable!.maxOutputTokens).toBe(128_000);
    expect(fable!.pricing?.inputPer1kTokens).toBe(0.01);
    expect(fable!.pricing?.outputPer1kTokens).toBe(0.05);
    expect(fable!.isAvailable).toBe(true);
  });
});
