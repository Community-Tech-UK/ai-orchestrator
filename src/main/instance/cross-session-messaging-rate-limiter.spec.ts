import { describe, expect, it } from 'vitest';
import { CrossSessionRateLimiter } from './cross-session-messaging-rate-limiter';

describe('CrossSessionRateLimiter', () => {
  describe('tryConsume', () => {
    it('allows up to ratePerMinute sends per (source, target) pair', () => {
      const limiter = new CrossSessionRateLimiter({ ratePerMinute: 2, maxHops: 1 });
      expect(limiter.tryConsume('a', 'b')).toBe(true);
      expect(limiter.tryConsume('a', 'b')).toBe(true);
      expect(limiter.tryConsume('a', 'b')).toBe(false);
    });

    it('tracks buckets independently per (source, target) pair', () => {
      const limiter = new CrossSessionRateLimiter({ ratePerMinute: 1, maxHops: 1 });
      expect(limiter.tryConsume('a', 'b')).toBe(true);
      expect(limiter.tryConsume('a', 'c')).toBe(true);
      expect(limiter.tryConsume('b', 'c')).toBe(true);
      expect(limiter.tryConsume('a', 'b')).toBe(false);
    });

    it('refills the bucket once a minute has elapsed', () => {
      let now = 0;
      const limiter = new CrossSessionRateLimiter({ ratePerMinute: 1, maxHops: 1, now: () => now });
      expect(limiter.tryConsume('a', 'b')).toBe(true);
      expect(limiter.tryConsume('a', 'b')).toBe(false);

      now += 59_000;
      expect(limiter.tryConsume('a', 'b')).toBe(false);

      now += 2_000; // past the 60s mark
      expect(limiter.tryConsume('a', 'b')).toBe(true);
    });

    it('reset() clears all bucket state', () => {
      const limiter = new CrossSessionRateLimiter({ ratePerMinute: 1, maxHops: 1 });
      expect(limiter.tryConsume('a', 'b')).toBe(true);
      expect(limiter.tryConsume('a', 'b')).toBe(false);
      limiter.reset();
      expect(limiter.tryConsume('a', 'b')).toBe(true);
    });
  });

  describe('exceedsHopCap', () => {
    it('rejects a hop count above maxHops', () => {
      const limiter = new CrossSessionRateLimiter({ ratePerMinute: 10, maxHops: 1 });
      expect(limiter.exceedsHopCap(0)).toBe(false);
      expect(limiter.exceedsHopCap(1)).toBe(false);
      expect(limiter.exceedsHopCap(2)).toBe(true);
    });

    it('a maxHops of 0 only allows the initial send', () => {
      const limiter = new CrossSessionRateLimiter({ ratePerMinute: 10, maxHops: 0 });
      expect(limiter.exceedsHopCap(0)).toBe(false);
      expect(limiter.exceedsHopCap(1)).toBe(true);
    });
  });
});
