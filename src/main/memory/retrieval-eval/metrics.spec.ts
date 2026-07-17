import { describe, expect, it } from 'vitest';
import {
  buildRetrievalReport,
  compareToBaseline,
  ndcgAtK,
  recallAtK,
  type RetrievalReport,
} from './metrics';

describe('recallAtK — hand-computed', () => {
  const relevant = new Set(['a', 'b']);

  it('counts hits within the cutoff over |relevant|', () => {
    // top-5 = [x, a, y, b, z] → both relevant found → 2/2
    expect(recallAtK(['x', 'a', 'y', 'b', 'z'], relevant, 5)).toBe(1);
    // top-1 = [x] → 0/2
    expect(recallAtK(['x', 'a', 'y', 'b', 'z'], relevant, 1)).toBe(0);
    // top-3 = [x, a, y] → 1/2
    expect(recallAtK(['x', 'a', 'y', 'b', 'z'], relevant, 3)).toBe(0.5);
  });

  it('is 0 for empty results and empty relevant sets', () => {
    expect(recallAtK([], relevant, 5)).toBe(0);
    expect(recallAtK(['a'], new Set<string>(), 5)).toBe(0);
  });
});

describe('ndcgAtK — hand-computed', () => {
  it('is 1.0 when all relevant items occupy the top ranks', () => {
    expect(ndcgAtK(['a', 'b', 'x'], new Set(['a', 'b']), 10)).toBeCloseTo(1, 10);
  });

  it('matches the hand-computed value for a displaced hit', () => {
    // relevant = {a}; returned = [x, a]: DCG = 1/log2(3) ≈ 0.6309; IDCG = 1.
    expect(ndcgAtK(['x', 'a'], new Set(['a']), 10)).toBeCloseTo(1 / Math.log2(3), 10);
  });

  it('matches the hand-computed value for two hits at ranks 1 and 3', () => {
    // relevant = {a,b}; returned = [a, x, b]:
    // DCG  = 1/log2(2) + 1/log2(4) = 1 + 0.5 = 1.5
    // IDCG = 1/log2(2) + 1/log2(3) = 1 + 0.63093
    expect(ndcgAtK(['a', 'x', 'b'], new Set(['a', 'b']), 10)).toBeCloseTo(
      1.5 / (1 + 1 / Math.log2(3)),
      10,
    );
  });

  it('ignores hits beyond the cutoff', () => {
    expect(ndcgAtK(['x', 'y', 'a'], new Set(['a']), 2)).toBe(0);
  });
});

describe('buildRetrievalReport', () => {
  it('averages across queries and breaks down per type', () => {
    const report = buildRetrievalReport([
      { queryId: 'q1', type: 'code', returned: ['a'], relevant: new Set(['a']) },
      { queryId: 'q2', type: 'code', returned: ['x'], relevant: new Set(['a']) },
      { queryId: 'q3', type: 'lesson', returned: ['l1'], relevant: new Set(['l1']) },
    ]);
    expect(report.queries).toBe(3);
    expect(report.r1).toBeCloseTo(2 / 3, 10);
    expect(report.perType['code'].queries).toBe(2);
    expect(report.perType['code'].r1).toBeCloseTo(0.5, 10);
    expect(report.perType['lesson'].r1).toBe(1);
  });
});

describe('compareToBaseline', () => {
  const base = (r1: number): RetrievalReport => ({
    queries: 10, r1, r5: r1, r10: r1, ndcg10: r1, perType: {},
  });

  it('passes improvements and within-tolerance dips; flags real regressions', () => {
    expect(compareToBaseline(base(0.9), base(0.8)).ok).toBe(true);
    expect(compareToBaseline(base(0.79), base(0.8)).ok).toBe(true); // within 0.02
    const failed = compareToBaseline(base(0.7), base(0.8));
    expect(failed.ok).toBe(false);
    expect(failed.regressions.length).toBeGreaterThan(0);
  });
});
