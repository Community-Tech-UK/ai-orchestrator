import { describe, expect, it } from 'vitest';
import { LoopCompletionContextStore } from './loop-completion-context-store';

describe('LoopCompletionContextStore', () => {
  it('stores convergence notes and plan-regeneration counts per run', () => {
    const store = new LoopCompletionContextStore();

    store.setConvergenceNote('a', 'verify failed');
    store.setPlanRegenerationCount('a', 2);

    expect(store.getConvergenceNote('a')).toBe('verify failed');
    expect(store.hasConvergenceNote('a')).toBe(true);
    expect(store.getPlanRegenerationCount('a')).toBe(2);
    expect(store.getConvergenceNote('b')).toBeUndefined();
  });

  it('consumes one-shot context resets and failover tags exactly once', () => {
    const store = new LoopCompletionContextStore();
    store.requestContextReset('a');
    store.setPendingFailover('a', 'claude');

    expect(store.peekContextReset('a')).toBe(true);
    expect(store.consumeContextReset('a')).toBe(true);
    expect(store.peekContextReset('a')).toBe(false);
    expect(store.consumeContextReset('a')).toBe(false);
    expect(store.consumePendingFailover('a')).toBe('claude');
    expect(store.consumePendingFailover('a')).toBeUndefined();
  });

  it('tracks quota downshifts, cap wrap-up state, and envelope repairs', () => {
    const store = new LoopCompletionContextStore();
    store.setDownshiftModel('a', 'small-model');
    store.setCapWrapUp('a', {
      cap: 'tokens',
      originalReason: 'token limit reached',
      triggerIteration: 4,
      measurement: 100,
      limit: 100,
      phase: 'pending-turn',
    });
    store.setEnvelopeRewrapCount('a', 2);
    store.setAutoUnstickCount('a', 1);

    expect(store.getDownshiftModel('a')).toBe('small-model');
    expect(store.getCapWrapUp('a')).toEqual({
      cap: 'tokens',
      originalReason: 'token limit reached',
      triggerIteration: 4,
      measurement: 100,
      limit: 100,
      phase: 'pending-turn',
    });
    expect(store.getEnvelopeRewrapCount('a')).toBe(2);
    expect(store.getAutoUnstickCount('a')).toBe(1);
  });

  it('clears every completion hint for one terminal run without touching peers', () => {
    const store = new LoopCompletionContextStore();
    for (const id of ['a', 'b']) {
      store.setConvergenceNote(id, id);
      store.setPlanRegenerationCount(id, 1);
      store.requestContextReset(id);
      store.setPendingFailover(id, 'codex');
      store.setDownshiftModel(id, 'small-model');
      store.setCapWrapUp(id, {
        cap: 'cost',
        originalReason: 'cost limit reached',
        triggerIteration: 1,
        phase: 'pending-turn',
      });
      store.setEnvelopeRewrapCount(id, 1);
      store.setAutoUnstickCount(id, 1);
    }

    store.clearRun('a');

    expect(store.getConvergenceNote('a')).toBeUndefined();
    expect(store.getPlanRegenerationCount('a')).toBe(0);
    expect(store.consumeContextReset('a')).toBe(false);
    expect(store.consumePendingFailover('a')).toBeUndefined();
    expect(store.getDownshiftModel('a')).toBeUndefined();
    expect(store.getCapWrapUp('a')).toBeUndefined();
    expect(store.getEnvelopeRewrapCount('a')).toBe(0);
    expect(store.getAutoUnstickCount('a')).toBe(0);
    expect(store.getConvergenceNote('b')).toBe('b');
  });
});
