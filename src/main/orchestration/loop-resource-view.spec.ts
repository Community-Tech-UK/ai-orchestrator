import { describe, expect, it } from 'vitest';
import {
  budgetUtilization,
  knownCapacity,
  summarizeSpendByPurpose,
  unknownCapacity,
  type LoopRunBudget,
  type LoopSpendEntry,
} from './loop-resource-view';

describe('LoopContextCapacity (B1)', () => {
  it('builds a known capacity from a provider-reported sample', () => {
    const capacity = knownCapacity(64_000, 128_000);
    expect(capacity).toEqual({
      status: 'known',
      usedTokens: 64_000,
      windowTokens: 128_000,
      utilization: 0.5,
      provenance: 'provider-reported',
    });
  });

  // The 3500%-utilisation class: a catalog window of 0/absent must never turn
  // into a percentage.
  it('refuses to fabricate a percentage from an unusable window', () => {
    expect(knownCapacity(5_000, 0).status).toBe('unknown');
    expect(knownCapacity(5_000, Number.NaN).status).toBe('unknown');
    expect(knownCapacity(-1, 128_000).status).toBe('unknown');
  });

  it('makes unknown carry a reason rather than a zero', () => {
    expect(unknownCapacity('adapter is aggregate-only')).toEqual({
      status: 'unknown',
      reason: 'adapter is aggregate-only',
    });
  });
});

describe('LoopRunBudget vs context capacity (B1)', () => {
  const budget: LoopRunBudget = {
    maxTokens: null,
    maxCostCents: null,
    usedTokens: 2_989,
    usedCostCents: 12,
  };

  // The acceptance criterion: a run cap and a calibrated window are independent
  // quantities, and an unbounded run has NO percentage.
  it('reports no budget percentage when the run is unbounded', () => {
    expect(budgetUtilization(budget)).toEqual({ tokens: null, cost: null });
  });

  it('reports a budget percentage only against a real user-set cap', () => {
    expect(budgetUtilization({ ...budget, maxTokens: 10_000, maxCostCents: 100 }))
      .toEqual({ tokens: 0.2989, cost: 0.12 });
  });

  it('keeps a calibrated window independent of the run budget', () => {
    const capacity = knownCapacity(2_989, 128_000);
    expect(capacity.status).toBe('known');
    // 2,989 of a 128k window is ~2%; the same number against the phantom 1M
    // "budget" is 0.3%. They are different questions and must not be shared.
    if (capacity.status === 'known') {
      expect(capacity.utilization).toBeCloseTo(0.02335, 4);
    }
    expect(budgetUtilization(budget).tokens).toBeNull();
  });
});

describe('summarizeSpendByPurpose (B1)', () => {
  const entry = (over: Partial<LoopSpendEntry>): LoopSpendEntry => ({
    purpose: 'builder',
    tokens: { total: 100 },
    costCents: 1,
    provenance: 'provider-reported',
    at: 0,
    ...over,
  });

  it('attributes spend so a bill reads as builder vs reviewer vs verify', () => {
    const summary = summarizeSpendByPurpose([
      entry({ purpose: 'builder', tokens: { total: 620, input: 600, output: 20 }, costCents: 62 }),
      entry({ purpose: 'review', tokens: { total: 310 }, costCents: 31 }),
      entry({ purpose: 'verify', tokens: { total: 70 }, costCents: 7 }),
    ]);

    expect(summary.builder).toEqual({ tokens: 620, costCents: 62 });
    expect(summary.review).toEqual({ tokens: 310, costCents: 31 });
    expect(summary.verify).toEqual({ tokens: 70, costCents: 7 });
    expect(summary.housekeeping).toEqual({ tokens: 0, costCents: null });
  });

  // An unpriced spend must stay unpriced, not silently become £0.00.
  it('keeps cost null when nothing in a bucket was priced', () => {
    const summary = summarizeSpendByPurpose([
      entry({ purpose: 'classification', costCents: null, tokens: { total: 40 } }),
    ]);
    expect(summary.classification).toEqual({ tokens: 40, costCents: null });
  });
});
