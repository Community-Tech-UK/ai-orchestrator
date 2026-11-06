import { describe, expect, it } from 'vitest';
import { summariseFanoutCost, type FanoutInstance } from './fanout-cost';

const node = (id: string, parentId: string | null, costEstimate?: number): FanoutInstance => ({ id, parentId, contextUsage: costEstimate === undefined ? {} : { costEstimate } });

describe('summariseFanoutCost', () => {
  it('is null for a session that started no helpers', () => {
    expect(summariseFanoutCost('lead', [node('lead', null, 5), node('other', null, 1)])).toBeNull();
  });

  it('totals the reported cost of helpers and their helpers, and never the lead or unrelated sessions', () => {
    const fanout = summariseFanoutCost('lead', [
      node('lead', null, 9), node('scout-1', 'lead', 0.4), node('scout-2', 'lead', 0.35), node('grandchild', 'scout-1', 0.1), node('unrelated', null, 3), node('unrelated-child', 'unrelated', 2),
    ]);
    expect(fanout).toEqual({ count: 3, pricedCount: 3, unpricedCount: 0, costUsd: expect.closeTo(0.85, 6) });
  });

  it('counts a helper with no reported cost as unpriced instead of guessing', () => {
    expect(summariseFanoutCost('lead', [node('lead', null), node('a', 'lead', 0.2), node('b', 'lead'), node('c', 'lead', 0), node('d', 'lead', Number.NaN)]))
      .toEqual({ count: 4, pricedCount: 1, unpricedCount: 3, costUsd: 0.2 });
  });

  it('survives a parent cycle', () => {
    expect(summariseFanoutCost('a', [node('a', 'b', 1), node('b', 'a', 1)])).toEqual({ count: 1, pricedCount: 1, unpricedCount: 0, costUsd: 1 });
  });
});
