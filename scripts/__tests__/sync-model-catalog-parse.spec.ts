import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_PROVIDERS,
  parseModel,
  parseSnapshot,
} from '../sync-model-catalog.parse';

function model(id: string, input: number, output: number, context?: number): unknown {
  return {
    id,
    cost: { input, output },
    ...(context === undefined ? {} : { limit: { context, output: context } }),
  };
}

describe('SUPPORTED_PROVIDERS', () => {
  it('lists resellers after the primary vendors they proxy', () => {
    // The snapshot is keyed by bare model id, so precedence is decided by this
    // order. A reseller placed before a primary vendor would take ownership of
    // the vendor's own id — and its context/output limits with it.
    const order = [...SUPPORTED_PROVIDERS];
    expect(order.indexOf('github-copilot')).toBe(order.length - 1);
    for (const primary of ['anthropic', 'openai', 'google', 'xai'] as const) {
      expect(order.indexOf(primary)).toBeLessThan(order.indexOf('github-copilot'));
    }
  });
});

describe('parseSnapshot', () => {
  it('gives a duplicate id to the primary vendor regardless of upstream key order', () => {
    // models.dev emits `github-copilot` before `anthropic` here — walking the
    // registry's own key order would hand `claude-opus-5` to the reseller,
    // which is exactly the silent reattribution this ordering prevents.
    const raw = JSON.stringify({
      'github-copilot': { models: { a: model('claude-opus-5', 5, 25, 200_000) } },
      anthropic: { models: { a: model('claude-opus-5', 5, 25, 1_000_000) } },
    });

    const snapshot = parseSnapshot(raw)!;

    expect(snapshot['claude-opus-5']).toEqual({
      provider: 'anthropic',
      input: 5,
      output: 25,
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000_000,
    });
  });

  it('keeps a reseller-exclusive model that no primary vendor publishes', () => {
    const raw = JSON.stringify({
      'github-copilot': { models: { a: model('mai-code-1.1-flash', 0.2, 1.2) } },
    });

    expect(parseSnapshot(raw)!['mai-code-1.1-flash']?.provider).toBe('github-copilot');
  });

  it('captures the xai namespace that backs the Grok CLI', () => {
    const raw = JSON.stringify({
      xai: { models: { a: model('grok-4.6', 2, 6, 500_000) } },
    });

    expect(parseSnapshot(raw)!['grok-4.6']).toMatchObject({ provider: 'xai', input: 2, output: 6 });
  });

  it('ignores namespaces outside the supported set', () => {
    const raw = JSON.stringify({
      mistral: { models: { a: model('mistral-large', 2, 6) } },
    });

    expect(parseSnapshot(raw)).toEqual({});
  });

  it('returns null for malformed JSON', () => {
    expect(parseSnapshot('{not json')).toBeNull();
  });
});

describe('parseModel', () => {
  it('skips models without a finite input/output cost', () => {
    expect(parseModel({ id: 'no-cost' }, 'openai')).toBeNull();
    expect(parseModel({ id: 'nan-cost', cost: { input: NaN, output: 1 } }, 'openai')).toBeNull();
    expect(parseModel({ id: 'text-cost', cost: { input: '2', output: 6 } }, 'openai')).toBeNull();
  });

  it('omits limits the registry does not publish', () => {
    expect(parseModel(model('priced-only', 1, 2), 'openai')).toEqual({
      id: 'priced-only',
      snapshot: {
        provider: 'openai',
        input: 1,
        output: 2,
        contextWindow: undefined,
        maxOutputTokens: undefined,
      },
    });
  });
});
