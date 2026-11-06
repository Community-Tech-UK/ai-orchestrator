import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordModelCall, resolveModelCallCost } from './model-call-recorder';

afterEach(() => vi.unstubAllEnvs());
describe('model-call cache lifetime transport', () => {
  it('prices lifetime-only usage without inventing a zero or losing its breakdown', () => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    expect(recordModelCall({ purpose: 'helper', provider: 'claude', model: 'sonnet', usage: {
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000 },
    } })).toMatchObject({ costSource: 'priced', costUsd: 2.5 });
  });
  it('retains native cache_creation lifetime counts in recorded usage and fallback pricing', () => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    const usage = { cache_creation_input_tokens: 1_000_000, cache_creation: {
      ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000,
    } };
    const record = recordModelCall({ purpose: 'helper', provider: 'claude', model: 'sonnet', usage });
    expect(record?.usage).toMatchObject({ cacheWrite5mTokens: 600_000, cacheWrite1hTokens: 400_000 });
    expect(record?.costUsd).toBeCloseTo(3.1);
    expect(resolveModelCallCost('claude', 'sonnet', record?.usage).costUsd).toBeCloseTo(3.1);
  });
});
