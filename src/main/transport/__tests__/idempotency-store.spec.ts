import { describe, it, expect } from 'vitest';
import { IdempotencyStore } from '../idempotency-store';

describe('IdempotencyStore (B2 at-most-once)', () => {
  it('first sight is fresh, second sight is a duplicate', () => {
    const s = new IdempotencyStore();
    const key = IdempotencyStore.compose('terminate', 'inst-1', 'abc');
    expect(s.isDuplicate(key)).toBe(false);
    expect(s.isDuplicate(key)).toBe(true);
    expect(s.isDuplicate(key)).toBe(true);
  });

  it('different verbs / instances / client keys do not collide', () => {
    const s = new IdempotencyStore();
    expect(s.isDuplicate(IdempotencyStore.compose('input', 'i1', 'k'))).toBe(false);
    expect(s.isDuplicate(IdempotencyStore.compose('terminate', 'i1', 'k'))).toBe(false);
    expect(s.isDuplicate(IdempotencyStore.compose('input', 'i2', 'k'))).toBe(false);
    expect(s.isDuplicate(IdempotencyStore.compose('input', 'i1', 'k2'))).toBe(false);
    // ...and each is now a duplicate on the second sight
    expect(s.isDuplicate(IdempotencyStore.compose('input', 'i1', 'k'))).toBe(true);
  });

  it('expires keys after the TTL so a much-later retry is treated as fresh', () => {
    let clock = 1_000;
    const s = new IdempotencyStore(1000, () => clock);
    const key = IdempotencyStore.compose('respond', 'i1', 'k');
    expect(s.isDuplicate(key)).toBe(false);
    expect(s.isDuplicate(key)).toBe(true);
    clock += 1001; // past TTL
    expect(s.isDuplicate(key)).toBe(false); // fresh again
  });

  it('sweeps expired entries so the map does not grow unbounded', () => {
    let clock = 0;
    const s = new IdempotencyStore(100, () => clock);
    for (let i = 0; i < 50; i++) {
      clock += 200; // each well past the prior TTL → prior entries sweepable
      s.isDuplicate(`k${i}`);
    }
    // After many far-apart inserts, the store should not retain all 50.
    expect(s._sizeForTesting()).toBeLessThan(50);
  });
});
