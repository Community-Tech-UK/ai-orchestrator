import { describe, expect, it } from 'vitest';

import { clearInFlightIteration } from './loop-state-helpers';
import type { LoopState } from '../../shared/types/loop.types';

function stateWith(seq: number | undefined): LoopState {
  return { inFlightIteration: seq === undefined ? undefined : { seq } } as unknown as LoopState;
}

describe('clearInFlightIteration', () => {
  it('clears the iteration it was asked about', () => {
    const state = stateWith(4);
    clearInFlightIteration(state, 4);
    expect(state.inFlightIteration).toBeUndefined();
  });

  /**
   * The guard is the whole point: a late cleanup from an abandoned attempt must
   * not wipe the record of the attempt that replaced it.
   */
  it('leaves a newer in-flight iteration alone', () => {
    const state = stateWith(5);
    clearInFlightIteration(state, 4);
    expect(state.inFlightIteration).toEqual({ seq: 5 });
  });

  it('is a no-op when nothing is in flight', () => {
    const state = stateWith(undefined);
    clearInFlightIteration(state, 4);
    expect(state.inFlightIteration).toBeUndefined();
  });
});
