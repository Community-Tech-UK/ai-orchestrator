import { describe, it, expect } from 'vitest';
import {
  fuseHybrid,
  overFetchCount,
  DEFAULT_VEC_WEIGHT,
  DEFAULT_BM25_WEIGHT,
} from './hybrid-recall-fusion';

describe('hybrid-recall-fusion / overFetchCount', () => {
  it('over-fetches factor× the top-k (default 3×)', () => {
    expect(overFetchCount(5)).toBe(15);
    expect(overFetchCount(10, 2)).toBe(20);
    expect(overFetchCount(0)).toBe(0);
    expect(overFetchCount(4, 1)).toBe(4);
  });
});

describe('hybrid-recall-fusion / fuseHybrid', () => {
  it('fuses with the documented 0.6/0.4 default weighting', () => {
    expect(DEFAULT_VEC_WEIGHT).toBe(0.6);
    expect(DEFAULT_BM25_WEIGHT).toBe(0.4);
    // Single shared id at top score in both → normalized 1/1 → fused 1.0.
    const out = fuseHybrid(
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.1 }],
      [{ id: 'a', score: 12 }, { id: 'b', score: 2 }],
    );
    const a = out.find((c) => c.id === 'a')!;
    expect(a.vec).toBe(1);
    expect(a.bm25).toBe(1);
    expect(a.score).toBeCloseTo(1.0, 6);
  });

  it('lets BM25 re-rank within the vector-driven set (default, no union)', () => {
    // Vector prefers a; BM25 strongly prefers b. Both in vec list.
    const out = fuseHybrid(
      [{ id: 'a', score: 1.0 }, { id: 'b', score: 0.9 }],
      [{ id: 'a', score: 0 }, { id: 'b', score: 100 }],
    );
    // a: 0.6*1 + 0.4*0 = 0.6 ; b: 0.6*0 + 0.4*1 = 0.4 → a still wins (vec-weighted)
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('excludes BM25-only candidates by default', () => {
    const out = fuseHybrid(
      [{ id: 'a', score: 1 }],
      [{ id: 'a', score: 1 }, { id: 'z', score: 5 }],
    );
    expect(out.map((c) => c.id)).toEqual(['a']);
  });

  it('union mode pulls in BM25-only candidates the vector index missed', () => {
    const out = fuseHybrid(
      [{ id: 'a', score: 1 }, { id: 'b', score: 0.5 }],
      [{ id: 'z', score: 10 }, { id: 'a', score: 1 }],
      { unionMode: true },
    );
    const ids = out.map((c) => c.id);
    expect(ids).toContain('z'); // BM25-only, now included
    // z has bm25=1, vec=0 → 0.4 ; a has vec=1,bm25=1 → 1.0 ; b vec≈0,bm25=0 → small
    expect(out.find((c) => c.id === 'z')!.vec).toBe(0);
    expect(out[0]?.id).toBe('a');
  });

  it('respects custom weights', () => {
    const out = fuseHybrid(
      [{ id: 'a', score: 1 }, { id: 'b', score: 0 }],
      [{ id: 'a', score: 0 }, { id: 'b', score: 1 }],
      { vecWeight: 0.2, bm25Weight: 0.8 },
    );
    // a: 0.2*1 + 0.8*0 = 0.2 ; b: 0.2*0 + 0.8*1 = 0.8 → b wins
    expect(out.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('handles equal scores (all normalized to 1) and empty lists', () => {
    const eq = fuseHybrid([{ id: 'a', score: 5 }, { id: 'b', score: 5 }], []);
    expect(eq.every((c) => c.vec === 1)).toBe(true);
    expect(fuseHybrid([], [])).toEqual([]);
  });

  it('applies the limit after sorting', () => {
    const out = fuseHybrid(
      [{ id: 'a', score: 0.3 }, { id: 'b', score: 0.9 }, { id: 'c', score: 0.6 }],
      [],
      { limit: 2 },
    );
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('breaks ties deterministically by id', () => {
    const out = fuseHybrid([{ id: 'y', score: 1 }, { id: 'x', score: 1 }], []);
    expect(out.map((c) => c.id)).toEqual(['x', 'y']);
  });
});
