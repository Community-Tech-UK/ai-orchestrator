import { describe, expect, it, vi } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import {
  finishCapWrapUpTurn,
  hydrateCapWrapUpStore,
  resolveCapWrapUpIntent,
} from './loop-cap-wrap-up-runtime';

function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    id: 'loop-1',
    capWrapUpIntent: undefined,
    endEvidence: undefined,
    ...overrides,
  } as LoopState;
}

describe('loop-cap-wrap-up-runtime', () => {
  it('prefers the stored wrap-up intent over the state copy', () => {
    const stored = {
      cap: 'iterations' as const,
      originalReason: 'stored',
      triggerIteration: 50,
      phase: 'pending-turn' as const,
    };
    const state = baseState({
      capWrapUpIntent: {
        cap: 'tokens',
        originalReason: 'state',
        triggerIteration: 12,
        phase: 'pending-turn',
      },
    });
    expect(resolveCapWrapUpIntent(state, stored)?.originalReason).toBe('stored');
    expect(resolveCapWrapUpIntent(state, undefined)?.originalReason).toBe('state');
  });

  it('hydrates the store from state when the store is empty', () => {
    const intent = {
      cap: 'wall-time' as const,
      originalReason: '50 hours',
      triggerIteration: 8,
      phase: 'pending-turn' as const,
    };
    const setStored = vi.fn();
    hydrateCapWrapUpStore(baseState({ capWrapUpIntent: intent }), undefined, setStored);
    expect(setStored).toHaveBeenCalledWith(intent);
    hydrateCapWrapUpStore(baseState({ capWrapUpIntent: intent }), intent, setStored);
    expect(setStored).toHaveBeenCalledTimes(1);
  });

  it('seals the wrap-up turn, records evidence, and terminates as cap-reached', () => {
    const emit = vi.fn();
    const terminate = vi.fn();
    const state = baseState();
    const intent = {
      cap: 'cost' as const,
      originalReason: 'cost cap',
      triggerIteration: 4,
      measurement: 900,
      limit: 800,
      phase: 'pending-turn' as const,
    };
    finishCapWrapUpTurn({
      state,
      intent,
      extraEvidence: { wrapUpFailure: 'child died' },
      extraCapReached: { secondaryFailure: 'child died' },
      emit,
      terminate,
    });
    expect(state.capWrapUpIntent?.phase).toBe('turn-complete');
    expect(state.endEvidence).toMatchObject({
      cap: 'cost',
      capTriggerIteration: 4,
      wrapUpFailure: 'child died',
    });
    expect(emit).toHaveBeenCalledWith('loop:cap-reached', expect.objectContaining({
      loopRunId: 'loop-1',
      cap: 'cost',
      secondaryFailure: 'child died',
    }));
    expect(terminate).toHaveBeenCalledWith(state, 'cap-reached', 'cost cap');
  });
});
