import { describe, expect, it, vi } from 'vitest';
import { callWithDeadline } from '../deadline';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('callWithDeadline', () => {
  it('resolves with the operation result when it settles before the deadline', async () => {
    const result = await callWithDeadline(async () => 'value', { ms: 50, fallback: 'fallback' });
    expect(result).toBe('value');
  });

  it('accepts a promise directly, not just a thunk', async () => {
    const result = await callWithDeadline(Promise.resolve(42), { ms: 50, fallback: -1 });
    expect(result).toBe(42);
  });

  it('returns the fallback and fires onTimeout when the operation is too slow', async () => {
    const onTimeout = vi.fn();
    const result = await callWithDeadline(() => delay(100).then(() => 'late'), {
      ms: 10,
      fallback: 'fallback',
      onTimeout,
    });
    expect(result).toBe('fallback');
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('returns the fallback and fires onError when the operation rejects', async () => {
    const onError = vi.fn();
    const result = await callWithDeadline(() => Promise.reject(new Error('boom')), {
      ms: 50,
      fallback: null,
      onError,
    });
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('treats a synchronously throwing thunk like a rejected operation', async () => {
    const onError = vi.fn();
    const result = await callWithDeadline(
      () => {
        throw new Error('sync boom');
      },
      { ms: 50, fallback: 'fallback', onError },
    );
    expect(result).toBe('fallback');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not raise an unhandled rejection when the operation rejects after the deadline', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const result = await callWithDeadline(
        () => delay(15).then(() => Promise.reject(new Error('late boom'))),
        { ms: 5, fallback: 'fallback' },
      );
      expect(result).toBe('fallback');
      // Give the late rejection time to fire so a missing swallow would be caught.
      await delay(40);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('surfaces a late success to onLateResult after the deadline fired', async () => {
    const onLateResult = vi.fn();
    const result = await callWithDeadline(() => delay(20).then(() => 'late-value'), {
      ms: 5,
      fallback: 'fallback',
      onLateResult,
    });
    expect(result).toBe('fallback');
    expect(onLateResult).not.toHaveBeenCalled(); // not yet — op still in flight
    await delay(40);
    expect(onLateResult).toHaveBeenCalledWith('late-value');
  });

  it('does not call onLateResult when the operation rejects after the deadline', async () => {
    const onLateResult = vi.fn();
    const result = await callWithDeadline(
      () => delay(15).then(() => Promise.reject(new Error('late boom'))),
      { ms: 5, fallback: 'fallback', onLateResult },
    );
    expect(result).toBe('fallback');
    await delay(40);
    expect(onLateResult).not.toHaveBeenCalled();
  });

  it('returns promptly on timeout rather than waiting for the slow operation', async () => {
    const started = Date.now();
    await callWithDeadline(() => delay(500), { ms: 20, fallback: undefined });
    expect(Date.now() - started).toBeLessThan(200);
  });
});
