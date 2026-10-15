import { describe, expect, it } from 'vitest';
import { resolveModelCallCost, recordModelCall } from './model-call-recorder';
import { subscribeCostAttribution } from './cost-attribution';
describe('truthful model call costs', () => {
  it('prefers a valid provider cost including zero', () => {
    expect(resolveModelCallCost('claude', undefined, { cost: 0 })).toEqual({ costUsd: 0, costSource: 'provider' });
    expect(resolveModelCallCost('claude', undefined, { cost: 0.4 })).toEqual({ costUsd: 0.4, costSource: 'provider' });
  });
  it('prices only provider-owned known models and keeps unknowns unknown', () => {
    expect(resolveModelCallCost('claude', 'claude-sonnet-4-20250514', { inputTokens: 1000 }).costSource).toBe('priced');
    expect(resolveModelCallCost('claude', 'unrecognized', { inputTokens: 1000 })).toEqual({ costUsd: null, costSource: 'unknown' });
    expect(resolveModelCallCost('copilot', 'claude-sonnet-4-20250514', {})).toEqual({ costUsd: 0, costSource: 'free' });
  });
  it('does not price a total-only report as zero', () => {
    expect(resolveModelCallCost('claude', 'claude-sonnet-4-20250514', { totalTokens: 100 })).toEqual({ costUsd: null, costSource: 'unknown' });
  });
  it('records normalized cache split and failed sends', () => {
    const rows: unknown[] = []; const stop = subscribeCostAttribution((record) => rows.push(record));
    recordModelCall({ purpose: 'review', provider: 'claude', model: 'unknown', usage: { cache_read_input_tokens: 25 }, outcome: 'error' }); stop();
    expect(rows[0]).toMatchObject({ purpose: 'review', costSource: 'unknown', usage: { cacheReadTokens: 25 }, outcome: 'error' });
  });
});
