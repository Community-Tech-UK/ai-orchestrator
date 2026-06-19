import { describe, it, expect, beforeEach } from 'vitest';
import {
  RespawnCircuitBreaker,
  getOrCreateCircuitBreaker,
  deleteCircuitBreaker,
  _resetAllCircuitBreakersForTesting,
} from './respawn-circuit-breaker';

describe('RespawnCircuitBreaker', () => {
  let breaker: RespawnCircuitBreaker;

  beforeEach(() => {
    breaker = new RespawnCircuitBreaker('test-instance');
  });

  describe('backoff schedule', () => {
    it('returns 0ms delay for the first two attempts', () => {
      expect(breaker.recordAttempt()).toBe(0);
      expect(breaker.recordAttempt()).toBe(0);
    });

    it('returns 10s delay on the 3rd attempt', () => {
      breaker.recordAttempt();
      breaker.recordAttempt();
      expect(breaker.recordAttempt()).toBe(10_000);
    });

    it('returns 30s delay on the 4th attempt', () => {
      breaker.recordAttempt();
      breaker.recordAttempt();
      breaker.recordAttempt();
      expect(breaker.recordAttempt()).toBe(30_000);
    });

    it('caps at the last backoff schedule entry (900s) for many attempts', () => {
      for (let i = 0; i < 10; i++) breaker.recordAttempt();
      expect(breaker.recordAttempt()).toBe(900_000);
    });
  });

  describe('isOpen / remainingDelayMs', () => {
    it('is not open after a zero-delay attempt', () => {
      breaker.recordAttempt();
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.remainingDelayMs()).toBe(0);
    });

    it('is open immediately after a non-zero-delay attempt', () => {
      breaker.recordAttempt();
      breaker.recordAttempt();
      breaker.recordAttempt(); // 10s delay
      expect(breaker.isOpen()).toBe(true);
      expect(breaker.remainingDelayMs()).toBeGreaterThan(0);
      expect(breaker.remainingDelayMs()).toBeLessThanOrEqual(10_000);
    });
  });

  describe('1-hour reset window', () => {
    it('resets counter when more than 1h has elapsed since the last attempt', () => {
      const ONE_HOUR_MS = 60 * 60 * 1_000;
      const now = Date.now();
      breaker.recordAttempt(now - ONE_HOUR_MS - 1); // 4 minutes past the window
      breaker.recordAttempt(now - ONE_HOUR_MS - 1);
      breaker.recordAttempt(now - ONE_HOUR_MS - 1);
      // 4th attempt is > 1h after the last, so the window has lapsed — reset
      const delay = breaker.recordAttempt(now);
      expect(delay).toBe(0); // starts from scratch (attempt #1)
    });

    it('does NOT reset within the 1-hour window', () => {
      const now = Date.now();
      breaker.recordAttempt(now - 30 * 60_000); // 30 min ago
      breaker.recordAttempt(now - 30 * 60_000);
      // 3rd attempt within window → should still apply backoff
      const delay = breaker.recordAttempt(now);
      expect(delay).toBe(10_000);
    });
  });

  describe('recordSuccess', () => {
    it('resets the counter when window has elapsed', () => {
      const ONE_HOUR_MS = 60 * 60 * 1_000;
      const past = Date.now() - ONE_HOUR_MS - 1;
      breaker.recordAttempt(past);
      breaker.recordAttempt(past);
      breaker.recordAttempt(past);
      breaker.recordSuccess(Date.now());
      // After success reset, next attempt starts fresh
      expect(breaker.recordAttempt()).toBe(0);
    });
  });

  describe('snapshot', () => {
    it('returns accurate attempt count', () => {
      breaker.recordAttempt();
      breaker.recordAttempt();
      const snap = breaker.snapshot();
      expect(snap.attempt).toBe(2);
      expect(snap.lastAttemptAt).toBeGreaterThan(0);
    });
  });

  describe('_resetForTesting', () => {
    it('clears all state', () => {
      breaker.recordAttempt();
      breaker.recordAttempt();
      breaker.recordAttempt();
      breaker._resetForTesting();
      expect(breaker.recordAttempt()).toBe(0);
    });
  });
});

describe('circuit breaker registry', () => {
  beforeEach(() => {
    _resetAllCircuitBreakersForTesting();
  });

  it('getOrCreateCircuitBreaker returns the same instance on repeated calls', () => {
    const a = getOrCreateCircuitBreaker('inst-1');
    const b = getOrCreateCircuitBreaker('inst-1');
    expect(a).toBe(b);
  });

  it('deleteCircuitBreaker removes the entry so a new one is created next call', () => {
    const a = getOrCreateCircuitBreaker('inst-1');
    deleteCircuitBreaker('inst-1');
    const b = getOrCreateCircuitBreaker('inst-1');
    expect(a).not.toBe(b);
  });

  it('different instance IDs get independent breakers', () => {
    const a = getOrCreateCircuitBreaker('inst-1');
    const b = getOrCreateCircuitBreaker('inst-2');
    a.recordAttempt();
    a.recordAttempt();
    a.recordAttempt(); // puts inst-1 into backoff
    expect(b.recordAttempt()).toBe(0); // inst-2 starts fresh
  });
});
