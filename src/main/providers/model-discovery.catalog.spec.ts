import { describe, expect, it } from 'vitest';
import { buildAnthropicKnownModels } from './model-discovery.catalog';

describe('buildAnthropicKnownModels', () => {
  it('does not include removed Claude Fable 5 in known Anthropic models', () => {
    const models = buildAnthropicKnownModels();
    const fable = models.find((model) => model.id === 'claude-fable-5');

    expect(fable).toBeUndefined();
  });
});
