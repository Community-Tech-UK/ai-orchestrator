import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitState } from './circuit-breaker';

describe('cancelled circuit calls', () => {
  it.each([false, true])('does not count cancelled %s completion as provider health', async succeeds => {
    const breaker = new CircuitBreaker('review-cancellation');
    breaker.forceState(CircuitState.HALF_OPEN);
    const controller = new AbortController();
    await expect(breaker.execute(async () => {
      controller.abort();
      if (!succeeds) throw new Error('Review cancelled');
      return 'late response';
    }, controller.signal)).rejects.toThrow();
    expect(breaker.getStats()).toMatchObject({ totalCalls: 0, failureCount: 0, successCount: 0, state: CircuitState.HALF_OPEN });
    breaker.destroy();
  });

  it('does not count an error the caller marks as not a failure', async () => {
    const breaker = new CircuitBreaker('deliberate-stops', {
      failureThreshold: 1, minimumCalls: 1, ignoreError: (error) => error instanceof RangeError,
    });

    await expect(breaker.execute(async () => { throw new RangeError('stopped on purpose'); })).rejects.toThrow('stopped on purpose');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    await expect(breaker.execute(async () => { throw new Error('real failure'); })).rejects.toThrow('real failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    breaker.destroy();
  });
});
