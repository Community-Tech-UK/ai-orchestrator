import { describe, expect, it } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import { stageMergeHold, type MergeHoldKind } from './loop-merge-hold';

function makeState(): LoopState {
  return { id: 'run-1', endEvidence: { finishChecks: [] } } as unknown as LoopState;
}

describe('stageMergeHold', () => {
  it.each(['stalled', 'final-audit-blocked', 'verified-no-change'] as MergeHoldKind[])('records %s as a review hold', (kind) => {
    const state = makeState();
    stageMergeHold(state, kind);
    expect(state.endEvidence).toMatchObject({ mergeHold: true, mergeHoldKind: kind, finishChecks: [] });
  });

  it('keeps earlier end evidence', () => {
    const state = makeState();
    state.endEvidence = { ...state.endEvidence, secondaryLedgerStallIterations: 3 };
    stageMergeHold(state, 'stalled');
    expect(state.endEvidence?.['secondaryLedgerStallIterations']).toBe(3);
    expect(state.endEvidence?.['mergeHold']).toBe(true);
  });
});
