import { describe, expect, it } from 'vitest';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { CLAUDE_MODELS, GROK_MODELS, OPENAI_MODELS, PROVIDER_MODEL_LIST } from '../../../../shared/types/provider.types';
import { buildModelRowFacts } from './model-row-facts';

const model: ModelDisplayInfo = { id: 'opus', name: 'Opus', tier: 'powerful', contextWindow: 200_000,
  pricing: { inputPerMillion: 3, outputPerMillion: 15 }, pricingSource: 'models-dev' };

describe('model row facts', () => {
  it('shows tier, context, and sourced list price', () => {
    expect(buildModelRowFacts(model, 'claude')).toEqual({
      tierLabel: 'Powerful', contextLabel: '200K context',
      price: { text: '$3 in / $15 out per 1M tokens', note: 'API list price from models-dev. Your plan may be billed differently.' },
    });
    expect(buildModelRowFacts({ ...model, tier: 'fast', contextWindow: 1_000_000 }, 'codex').tierLabel).toBe('Fast');
    expect(buildModelRowFacts({ ...model, tier: 'balanced', contextWindow: 1_000_000 }, 'gemini').contextLabel).toBe('1M context');
  });

  it('does not invent a free price when pricing is missing or plan-based', () => {
    expect(buildModelRowFacts({ ...model, pricing: undefined }, 'claude').price.text).toBe('Price unknown');
    expect(buildModelRowFacts(model, 'copilot').price.text).toBe('Billed through your plan');
    expect(buildModelRowFacts(model, 'cursor').price.text).toBe('Billed through your plan');
    expect(buildModelRowFacts(model, 'local-model').price.text).toBe('Runs on your machine');
  });

  const priceOf = (inputPerMillion: number, outputPerMillion: number) =>
    buildModelRowFacts({ ...model, pricing: { inputPerMillion, outputPerMillion } }, 'gemini').price.text;

  it('keeps sub-dime prices exact instead of rounding them to cents', () => {
    expect(priceOf(0.075, 0.3)).toBe('$0.075 in / $0.3 out per 1M tokens');
    expect(priceOf(0.0375, 0.15)).toBe('$0.0375 in / $0.15 out per 1M tokens');
    expect(priceOf(0.025, 0.1)).toBe('$0.025 in / $0.1 out per 1M tokens');
  });

  it('shows dollar prices with at most two decimals and no trailing zeros', () => {
    expect(priceOf(3, 15)).toBe('$3 in / $15 out per 1M tokens');
    expect(priceOf(1.25, 10)).toBe('$1.25 in / $10 out per 1M tokens');
    expect(priceOf(0.5, 2.5)).toBe('$0.5 in / $2.5 out per 1M tokens');
    expect(priceOf(0.99, 1.005)).toBe('$0.99 in / $1 out per 1M tokens');
  });

  describe('size fallback for rows the catalogue has not sized (plan Step 12a Done-when)', () => {
    const bare = (id: string): ModelDisplayInfo => ({ id, name: id, tier: 'balanced' });
    const labelOf = (id: string, provider: string) => buildModelRowFacts(bare(id), provider).contextLabel;

    it('shows a size for representative aliases and defaults with no contextWindow set', () => {
      expect(labelOf(CLAUDE_MODELS.OPUS, 'claude')).toBe('1M context');
      expect(labelOf(CLAUDE_MODELS.SONNET_1M, 'claude')).toBe('1M context');
      expect(labelOf(CLAUDE_MODELS.HAIKU, 'claude')).toBe('200K context');
      expect(labelOf(OPENAI_MODELS.GPT55, 'codex')).toBe('200K context');
      expect(labelOf('gemini-2.5-pro', 'gemini')).toBe('1M context');
      expect(labelOf(GROK_MODELS.GROK_47, 'grok')).toBe('500K context');
    });

    it('sizes every default Claude, Codex, Gemini and Grok row', () => {
      for (const provider of ['claude', 'codex', 'gemini', 'grok']) {
        for (const m of PROVIDER_MODEL_LIST[provider] ?? []) {
          expect(buildModelRowFacts(m, provider).contextLabel, `${provider}:${m.id}`).not.toBeNull();
        }
      }
    });

    it('lets a catalogue or models.dev window win over the fallback', () => {
      expect(buildModelRowFacts({ ...bare('opus'), contextWindow: 123_000 }, 'claude').contextLabel).toBe('123K context');
    });

    it('leaves the size blank rather than guessing for providers the tables do not cover', () => {
      expect(labelOf('some-model', 'copilot')).toBeNull();
      expect(labelOf('auto', 'cursor')).toBeNull();
    });
  });
});
