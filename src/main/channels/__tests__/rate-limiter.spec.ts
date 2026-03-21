import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests under the limit', () => {
    expect(limiter.tryAcquire('user-1')).toBe(true);
    expect(limiter.tryAcquire('user-1')).toBe(true);
    expect(limiter.tryAcquire('user-1')).toBe(true);
  });

  it('should reject requests over the limit', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    expect(limiter.tryAcquire('user-1')).toBe(false);
  });

  it('should isolate per sender', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    expect(limiter.tryAcquire('user-2')).toBe(true);
  });

  it('should allow requests after window expires', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    expect(limiter.tryAcquire('user-1')).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.tryAcquire('user-1')).toBe(true);
  });

  it('should return remaining time until next available slot', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    const remaining = limiter.getRetryAfterMs('user-1');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it('should reset a specific sender', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.reset('user-1');
    expect(limiter.tryAcquire('user-1')).toBe(true);
  });
});
