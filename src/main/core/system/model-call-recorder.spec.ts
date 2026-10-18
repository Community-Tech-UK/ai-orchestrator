import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProviderModelRates, clearModelRateOverlay } from '../../../shared/data/model-pricing';
import { recordModelCall, resolveModelCallCost } from './model-call-recorder';
import { subscribeCostAttribution, type CostAttributionRecord } from './cost-attribution';
import { withLocalAiCostCorrelation } from '../../local-ai-guard/local-ai-cost-correlation';

describe('recordModelCall', () => {
  let records: CostAttributionRecord[];
  let unsubscribe: () => void;
  beforeEach(() => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    records = [];
    unsubscribe = subscribeCostAttribution(record => records.push(record));
    registerProviderModelRates([{ provider: 'claude', id: 'fixture-model', rate: { input: 2, output: 10 } }]);
  });
  afterEach(() => { unsubscribe(); clearModelRateOverlay(); vi.unstubAllEnvs(); });

  it('uses the provider-reported cost before token pricing', () => {
    recordModelCall({ purpose: 'review', provider: 'claude', model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 20, cost: 0.42 } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'review', provider: 'claude', costSource: 'provider', costKnown: true, usage: { inputTokens: 100, outputTokens: 20, cost: 0.42 } });
  });

  it('prices normalized tokens with read and write caches kept separate', () => {
    recordModelCall({ purpose: 'review', provider: 'claude', model: 'fixture-model', usage: { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 500000, cache_creation_input_tokens: 200000 } });
    expect(records[0]).toMatchObject({ costSource: 'priced', costKnown: true, usage: { inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 500000, cacheWriteTokens: 200000 } });
    expect(records[0]?.usage?.cost).toBeCloseTo(3.5);
  });

  it.each([
    { byModel: [{ model: 'fixture-model' }] },
    { providerModelUsage: { 'fixture-model': { inputTokens: 1000000 } } },
  ])('prices a sole reported model without a requested model (%j)', modelUsage => {
    recordModelCall({ purpose: 'consensus', provider: 'claude', usage: { inputTokens: 1000000, ...modelUsage } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ model: 'fixture-model', costSource: 'priced', usage: { cost: 2 } });
  });

  it('prefers actual sole model telemetry over a requested alias', () => {
    recordModelCall({ purpose: 'consensus', provider: 'claude', model: 'requested-alias', usage: { inputTokens: 1000000, byModel: [{ model: 'fixture-model' }] } });
    expect(records[0]).toMatchObject({ model: 'fixture-model', costSource: 'priced', usage: { cost: 2 } });
  });

  it.each([
    { byModel: [{ model: 'fixture-model' }, { model: 'another-fixture-model' }] },
    { byModel: [{ model: 'fixture-model' }, { model: null }] },
    { byModel: [], providerModelUsage: { 'fixture-model': {} } },
    { providerModelUsage: { 'fixture-model': {}, 'another-fixture-model': {} } },
    { providerModelUsage: { 'fixture-model': null } },
  ])('does not price aggregate usage as one model when telemetry is ambiguous or incomplete (%j)', modelUsage => {
    recordModelCall({ purpose: 'consensus', provider: 'claude', model: 'fixture-model', usage: { inputTokens: 1000000, ...modelUsage } });
    expect(records[0]?.model).toBeUndefined();
    expect(records[0]).toMatchObject({ costSource: 'unknown', costKnown: false });
    expect(records[0]?.usage?.cost).toBeUndefined();
  });

  it('retains reported dollars without assigning a multi-model total to one model', () => {
    recordModelCall({ purpose: 'consensus', provider: 'claude', model: 'fixture-model', usage: { cost: 0.09, byModel: [{ model: 'fixture-model' }, { model: 'another-fixture-model' }] } });
    expect(records[0]?.model).toBeUndefined();
    expect(records[0]).toMatchObject({ costSource: 'provider', costKnown: true, usage: { cost: 0.09 } });
  });

  it('retains the provider estimate qualifier when resolving a reported model', () => {
    recordModelCall({ purpose: 'consensus', provider: 'claude', usage: { inputTokens: 1000000, isEstimated: true, byModel: [{ model: 'fixture-model' }] } });
    expect(records[0]).toMatchObject({ model: 'fixture-model', costSource: 'priced', costKnown: false, isEstimated: true, usage: { cost: 2 } });
  });

  it.each([undefined, { total_tokens: 900 }, { input_tokens: 90 }])('keeps absent or unpriceable usage unknown (%j)', usage => {
    recordModelCall({ purpose: 'council', provider: 'unknown-provider', model: 'unknown-model', usage });
    expect(records[0]).toMatchObject({ costSource: 'unknown', costKnown: false });
    expect(records[0]?.usage?.cost).toBeUndefined();
  });

  it('does not price totals without a billed token breakdown, even for a known model', () => {
    recordModelCall({ purpose: 'review', provider: 'claude', model: 'fixture-model', usage: { totalTokens: 200 } });
    expect(records[0]).toMatchObject({ costSource: 'unknown', costKnown: false });
  });

  it('records explicit free fallbacks as known zero and preserves inherited correlation', async () => {
    await withLocalAiCostCorrelation('correlation-example', async () => {
      recordModelCall({ purpose: 'helper', provider: 'aio-basic-summary', costSource: 'free' });
    });
    expect(records[0]).toMatchObject({ source: 'auxiliary', correlationId: 'correlation-example', purpose: 'helper', costSource: 'free', costKnown: true, usage: { cost: 0 } });
  });

  it('books a known free provider as a known zero without an explicit override', () => {
    recordModelCall({ purpose: 'review', provider: 'copilot', model: 'local-fixture', usage: { inputTokens: 100, outputTokens: 20 } });
    expect(records[0]).toMatchObject({ costSource: 'free', costKnown: true, usage: { cost: 0 } });
  });

  it.each(['error', 'cancelled', 'budget-exceeded'] as const)('records %s without inventing a price', outcome => {
    recordModelCall({ purpose: 'review', provider: 'claude', model: 'fixture-model', usage: { inputTokens: 100 }, outcome });
    expect(records[0]).toMatchObject({ outcome, costSource: 'unknown', costKnown: false });
  });

  it.each(['error', 'budget-exceeded'] as const)('preserves settled provider billing for %s', outcome => {
    recordModelCall({ purpose: 'review', provider: 'claude', model: 'fixture-model', outcome, usage: { inputTokens: 100, cost: 0.25 } });
    expect(records[0]).toMatchObject({ outcome, costSource: 'provider', costKnown: true, usage: { cost: 0.25 } });
  });

  it('never propagates malformed usage or listener failures to the caller', () => {
    const broken = { get inputTokens(): number { throw new Error('malformed usage'); } };
    const stop = subscribeCostAttribution(() => { throw new Error('broken listener'); });
    try {
      expect(() => recordModelCall({ purpose: 'review', provider: 'claude', usage: broken })).not.toThrow();
      expect(() => recordModelCall({ purpose: 'review', provider: 'claude', usage: { cost: 0 } })).not.toThrow();
    } finally { stop(); }
  });
});

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
