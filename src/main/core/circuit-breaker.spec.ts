import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitState } from './circuit-breaker';

const slow = (ms: number) => () => new Promise((r) => setTimeout(() => r('ok'), ms));

describe('CircuitBreaker slow-call tracking', () => {
  it('opens on slow-but-SUCCESSFUL calls when slow-call tracking is enabled', async () => {
    const cb = new CircuitBreaker('slow-on', {
      trackSlowCalls: true,
      slowCallThresholdMs: 5,
      slowCallRateThreshold: 50,
      minimumCalls: 3,
      failureWindowMs: 60_000,
      failureThreshold: 100, // isolate slow-call behaviour from failure counting
    });

    // minimumCalls is 3 → the breaker evaluates (and opens) on the 3rd success.
    for (let i = 0; i < 3; i++) {
      await cb.execute(slow(15)); // every call succeeds but is "slow"
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it('stays CLOSED on slow successful calls when slow-call tracking is OFF', async () => {
    // This is the loop-orchestration config: every interactive CLI turn is
    // legitimately slow, so slow-call tracking must not trip the breaker.
    const cb = new CircuitBreaker('slow-off', {
      trackSlowCalls: false,
      slowCallThresholdMs: 5,
      slowCallRateThreshold: 50,
      minimumCalls: 3,
      failureWindowMs: 60_000,
      failureThreshold: 3,
    });

    for (let i = 0; i < 6; i++) {
      await cb.execute(slow(15));
    }

    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('still opens on real failures regardless of slow-call tracking', async () => {
    const cb = new CircuitBreaker('fail', {
      trackSlowCalls: false,
      minimumCalls: 3,
      failureWindowMs: 60_000,
      failureThreshold: 3,
    });

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);
  });
});
