import { describe, expect, it } from 'vitest';
import { foldFreshEyesSpend, foldPingPongSpend, noteBuilderSpend, recordLoopSpend } from './loop-spend-ledger';
import type { LoopState } from '../../shared/types/loop.types';
import { spendProvenanceOf } from '../../shared/types/loop-spend.types';
describe('loop spend fold', () => {
  it('folds reviewers into caps even when persistence fails, and records provenance', () => {
    const state = { id: 'run', totalTokens: 10, totalCostCents: 5 } as LoopState;
    recordLoopSpend(state, { purpose: 'review', tokens: 30, costCents: 4, basis: 'provider-reported' }, () => { throw new Error('db unavailable'); });
    expect(state.totalTokens).toBe(40); expect(state.totalCostCents).toBe(9);
    expect(spendProvenanceOf(state.spendByPurpose)).toMatchObject({ label: 'provider-reported', knownCents: 4, totalCents: 4 });
    noteBuilderSpend(state, { tokens: 10, costCents: 5, costKnown: false });
    expect(state.totalCostCents).toBe(9); expect(spendProvenanceOf(state.spendByPurpose).label).toBe('partly-estimated');
  });
  it('preserves unknown calls instead of reporting them free, and avoids legacy double folding', () => {
    const state = { id: 'run', totalTokens: 0, totalCostCents: 0 } as LoopState;
    foldFreshEyesSpend(state, 2, { findings: [], reviewersUsed: [], summary: '', spend: [{ provider: 'codex', tokens: 10, costUsd: null, costSource: 'unknown' }] }, () => undefined);
    expect(state.spendByPurpose?.review?.calls).toBe(1); expect(state.totalTokens).toBe(10);
    expect(spendProvenanceOf(state.spendByPurpose).label).toBe('unknown');
  });
  it('persists mixed ping-pong provenance separately while folding tokens once', () => {
    const state = { id: 'run', totalTokens: 0, totalCostCents: 0 } as LoopState;
    const rows: unknown[] = [];
    foldPingPongSpend(state, 2, 30, 10, undefined, 4, 2, row => rows.push(row));
    expect(state.totalCostCents).toBe(10); expect(state.totalTokens).toBe(30);
    expect(state.spendByPurpose?.review?.knownCents).toBe(4);
    expect(rows).toEqual([expect.objectContaining({costCents:4,tokens:30,basis:'provider-reported'}),expect.objectContaining({costCents:6,tokens:0,basis:'computed'})]);
    foldPingPongSpend(state, 3, 0, 0, undefined, 0, 0, row => rows.push(row));
    expect(rows[2]).toMatchObject({costCents:0,basis:'unknown'});
  });

  it('preserves exact spend when the computed remainder rounds to zero cents', () => {
    const state = { id: 'run', totalTokens: 0, totalCostCents: 0 } as LoopState;
    const rows: unknown[] = [];
    foldPingPongSpend(state, 2, 30, 11, 'computed', 11, 2, row => rows.push(row));
    expect(rows).toEqual([
      expect.objectContaining({ costCents: 11, tokens: 30, basis: 'provider-reported' }),
      expect.objectContaining({ costCents: 0, tokens: 0, basis: 'computed' }),
    ]);
    expect(state.spendByPurpose?.review?.knownCents).toBe(11);
    expect(spendProvenanceOf(state.spendByPurpose).label).toBe('partly-estimated');
  });

  it('keeps unknown pricing visible beside exact cost, including zero cost', () => {
    const state = { id: 'run', totalTokens: 0, totalCostCents: 0 } as LoopState;
    const rows: unknown[] = [];
    foldPingPongSpend(state, 2, 30, 11, 'unknown', 11, 2, row => rows.push(row));
    expect(rows).toEqual([
      expect.objectContaining({ costCents: 11, basis: 'provider-reported' }),
      expect.objectContaining({ costCents: 0, basis: 'unknown' }),
    ]);
    expect(spendProvenanceOf(state.spendByPurpose).label).toBe('partly-estimated');
    const zero = { id: 'zero', totalTokens: 0, totalCostCents: 0 } as LoopState;
    foldPingPongSpend(zero, 2, 10, 0, 'unknown', 0, 1, () => undefined);
    expect(spendProvenanceOf(zero.spendByPurpose).label).toBe('unknown');
  });

  it('keeps the aggregate budget authoritative when breakdown persistence fails', () => {
    const state = { id: 'run', totalTokens: 0, totalCostCents: 0 } as LoopState;
    foldPingPongSpend(state, 2, 30, 11, 'unknown', 11, 2, () => { throw new Error('db unavailable'); }, [
      { tokens: 20, costCents: 11, basis: 'provider-reported' },
      { tokens: 10, costCents: 0, basis: 'unknown' },
    ]);
    expect(state).toMatchObject({ totalTokens: 30, totalCostCents: 11, spendByPurpose: { review: { calls: 2, unknownCalls: 1, knownCents: 11 } } });
  });

});
