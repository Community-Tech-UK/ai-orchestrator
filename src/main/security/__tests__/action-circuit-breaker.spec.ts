import { describe, it, expect, beforeEach } from 'vitest';
import {
  ActionCircuitBreaker,
  getActionCircuitBreaker,
  _resetActionCircuitBreakerForTesting,
} from '../action-circuit-breaker';

describe('ActionCircuitBreaker', () => {
  let breaker: ActionCircuitBreaker;

  beforeEach(() => {
    breaker = new ActionCircuitBreaker();
  });

  it('is disabled by default and never trips', () => {
    expect(breaker.enabled).toBe(false);
    for (let i = 0; i < 100; i++) {
      expect(breaker.recordAction('i1').tripped).toBe(false);
    }
  });

  it('trips on the Nth action when maxActions is set, then resets', () => {
    breaker.configure({ maxActions: 3 });
    expect(breaker.recordAction('i1').tripped).toBe(false); // 1
    expect(breaker.recordAction('i1').tripped).toBe(false); // 2
    const trip = breaker.recordAction('i1'); // 3 -> trips
    expect(trip.tripped).toBe(true);
    expect(trip.reason).toMatch(/3 actions/);
    // Counters reset after a trip: next two are fine, third trips again.
    expect(breaker.recordAction('i1').tripped).toBe(false);
    expect(breaker.recordAction('i1').tripped).toBe(false);
    expect(breaker.recordAction('i1').tripped).toBe(true);
  });

  it('tracks instances independently', () => {
    breaker.configure({ maxActions: 2 });
    expect(breaker.recordAction('a').tripped).toBe(false);
    expect(breaker.recordAction('b').tripped).toBe(false);
    expect(breaker.recordAction('a').tripped).toBe(true); // a hits 2
    expect(breaker.recordAction('b').tripped).toBe(true); // b hits 2 independently
  });

  it('trips on accumulated cost when maxCostUsd is set', () => {
    breaker.configure({ maxCostUsd: 1.0 });
    expect(breaker.recordCost('i1', 0.4).tripped).toBe(false);
    expect(breaker.recordCost('i1', 0.4).tripped).toBe(false);
    const trip = breaker.recordCost('i1', 0.4); // 1.2 >= 1.0
    expect(trip.tripped).toBe(true);
    expect(trip.reason).toMatch(/\$1\.20 spent/);
  });

  it('ignores non-positive cost', () => {
    breaker.configure({ maxCostUsd: 1.0 });
    expect(breaker.recordCost('i1', 0).tripped).toBe(false);
    expect(breaker.recordCost('i1', -5).tripped).toBe(false);
  });

  it('acknowledge and reset clear counters', () => {
    breaker.configure({ maxActions: 5 });
    breaker.recordAction('i1');
    breaker.recordAction('i1');
    breaker.acknowledge('i1');
    expect(breaker.evaluate('i1').tripped).toBe(false);
    breaker.recordAction('i1');
    breaker.reset('i1');
    expect(breaker.evaluate('i1').tripped).toBe(false);
  });

  it('clamps invalid config values', () => {
    breaker.configure({ maxActions: -3, maxCostUsd: -1 });
    expect(breaker.getConfig()).toEqual({ maxActions: 0, maxCostUsd: 0 });
    expect(breaker.enabled).toBe(false);
  });

  it('exposes a singleton with a test reset', () => {
    _resetActionCircuitBreakerForTesting();
    const a = getActionCircuitBreaker();
    const b = getActionCircuitBreaker();
    expect(a).toBe(b);
    _resetActionCircuitBreakerForTesting();
    expect(getActionCircuitBreaker()).not.toBe(a);
  });
});
