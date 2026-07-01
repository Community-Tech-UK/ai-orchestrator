import { describe, expect, it, vi } from 'vitest';
import { combineAbortSignals } from './abort-signals';

describe('combineAbortSignals', () => {
  it('returns a non-aborted signal when no source signals are supplied', () => {
    const signal = combineAbortSignals([]);

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('returns the original signal when only one source signal is supplied', () => {
    const controller = new AbortController();

    expect(combineAbortSignals([controller.signal])).toBe(controller.signal);
  });

  it('aborts immediately with the first already-aborted source reason', () => {
    const first = new AbortController();
    const second = new AbortController();
    first.abort('first reason');
    second.abort('second reason');

    const signal = combineAbortSignals([first.signal, second.signal]);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('first reason');
  });

  it('aborts when any source signal aborts and preserves the first reason', () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals([first.signal, second.signal]);

    second.abort(new Error('stop now'));
    first.abort('too late');

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toEqual(new Error('stop now'));
  });

  it('removes all source listeners after the combined signal aborts', () => {
    const first = new AbortController();
    const second = new AbortController();
    const firstAdd = vi.spyOn(first.signal, 'addEventListener');
    const secondAdd = vi.spyOn(second.signal, 'addEventListener');
    const firstRemove = vi.spyOn(first.signal, 'removeEventListener');
    const secondRemove = vi.spyOn(second.signal, 'removeEventListener');

    combineAbortSignals([first.signal, second.signal]);
    const firstListener = firstAdd.mock.calls[0]?.[1];
    const secondListener = secondAdd.mock.calls[0]?.[1];

    first.abort('done');

    expect(firstRemove).toHaveBeenCalledWith('abort', firstListener);
    expect(secondRemove).toHaveBeenCalledWith('abort', secondListener);
  });
});
