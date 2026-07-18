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

    expect(store.consumeContextReset('a')).toBe(true);
    expect(store.consumeContextReset('a')).toBe(false);
    expect(store.consumePendingFailover('a')).toBe('claude');
    expect(store.consumePendingFailover('a')).toBeUndefined();
  });

  it('tracks quota downshifts, cap wrap-up state, and envelope repairs', () => {
    const store = new LoopCompletionContextStore();
    store.setDownshiftModel('a', 'small-model');
    store.setCapWrapUp('a', 'tokens');
    store.setEnvelopeRewrapCount('a', 2);

    expect(store.getDownshiftModel('a')).toBe('small-model');
    expect(store.getCapWrapUp('a')).toBe('tokens');
    expect(store.getEnvelopeRewrapCount('a')).toBe(2);
  });

  it('clears every completion hint for one terminal run without touching peers', () => {
    const store = new LoopCompletionContextStore();
    for (const id of ['a', 'b']) {
      store.setConvergenceNote(id, id);
      store.setPlanRegenerationCount(id, 1);
      store.requestContextReset(id);
      store.setPendingFailover(id, 'codex');
      store.setDownshiftModel(id, 'small-model');
      store.setCapWrapUp(id, 'cost');
      store.setEnvelopeRewrapCount(id, 1);
    }

    store.clearRun('a');

    expect(store.getConvergenceNote('a')).toBeUndefined();
    expect(store.getPlanRegenerationCount('a')).toBe(0);
    expect(store.consumeContextReset('a')).toBe(false);
    expect(store.consumePendingFailover('a')).toBeUndefined();
    expect(store.getDownshiftModel('a')).toBeUndefined();
    expect(store.getCapWrapUp('a')).toBeUndefined();
    expect(store.getEnvelopeRewrapCount('a')).toBe(0);
    expect(store.getConvergenceNote('b')).toBe('b');
  });
});
