import { describe, it, expect, beforeEach } from 'vitest';
import { IpRateLimiter } from '../ip-rate-limiter';

describe('IpRateLimiter', () => {
  let limiter: IpRateLimiter;

  beforeEach(() => {
    limiter = new IpRateLimiter({
      windowMs: 60_000,
      maxAttemptsPerIp: 5,
      baseBanMs: 10_000,
      maxBanMs: 60_000,
    });
  });

  it('allows connections under the limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.allowConnection('192.168.1.1').ok).toBe(true);
    }
  });

  it('bans IP after exceeding limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.allowConnection('192.168.1.1');
    }
    const result = limiter.allowConnection('192.168.1.1');
    expect(result.ok).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not affect other IPs', () => {
    for (let i = 0; i < 6; i++) {
      limiter.allowConnection('192.168.1.1');
    }
    expect(limiter.allowConnection('192.168.1.2').ok).toBe(true);
  });

  it('escalates ban duration on repeat offenses', () => {
    const now = 1000000;
    // First ban
    for (let i = 0; i < 6; i++) limiter.allowConnection('10.0.0.1', now);
    const first = limiter.allowConnection('10.0.0.1', now);
    expect(first.ok).toBe(false);
    expect(first.retryAfterMs).toBeLessThanOrEqual(10_000);

    // After first ban expires, trigger second ban
    const afterFirstBan = now + 10_001;
    for (let i = 0; i < 6; i++) limiter.allowConnection('10.0.0.1', afterFirstBan);
    const second = limiter.allowConnection('10.0.0.1', afterFirstBan);
    expect(second.ok).toBe(false);
    expect(second.retryAfterMs!).toBeGreaterThan(first.retryAfterMs!);
  });

  it('resets state on clear', () => {
    for (let i = 0; i < 6; i++) limiter.allowConnection('10.0.0.1');
    expect(limiter.allowConnection('10.0.0.1').ok).toBe(false);
    limiter.clear();
    expect(limiter.allowConnection('10.0.0.1').ok).toBe(true);
  });
});
