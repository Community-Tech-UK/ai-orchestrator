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
});
