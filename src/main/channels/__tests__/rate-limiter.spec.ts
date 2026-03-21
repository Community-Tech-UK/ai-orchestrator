import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10, 60_000); // 10 per 60s
  });

  it('allows messages under the limit', () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('user-1')).toBe(true);
    }
  });

  it('blocks messages over the limit', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);
  });

  it('tracks senders independently', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);
    expect(limiter.check('user-2')).toBe(true);
  });

  it('resets after the window expires', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check('user-1')).toBe(true);
    vi.useRealTimers();
  });

  it('uses sliding window (old entries expire individually)', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      limiter.check('user-1');
    }
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 5; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);

    vi.advanceTimersByTime(30_001);
    expect(limiter.check('user-1')).toBe(true);
    vi.useRealTimers();
  });
});
