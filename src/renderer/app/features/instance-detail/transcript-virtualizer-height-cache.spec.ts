import { describe, it, expect } from 'vitest';
import { TranscriptHeightCache } from './transcript-virtualizer-height-cache';
import { DEFAULT_ESTIMATED_ROW_HEIGHT_PX } from './transcript-virtualizer-math';

describe('TranscriptHeightCache', () => {
  it('falls back to the default estimate for an unmeasured row', () => {
    const cache = new TranscriptHeightCache();
    expect(cache.get('a', 'msg-1')).toBe(DEFAULT_ESTIMATED_ROW_HEIGHT_PX);
    expect(cache.has('a', 'msg-1')).toBe(false);
  });

  it('stores and retrieves a real measurement', () => {
    const cache = new TranscriptHeightCache();
    cache.set('a', 'msg-1', 240);
    expect(cache.get('a', 'msg-1')).toBe(240);
    expect(cache.has('a', 'msg-1')).toBe(true);
  });

  it('ignores non-finite or non-positive measurements', () => {
    const cache = new TranscriptHeightCache();
    cache.set('a', 'msg-1', 0);
    cache.set('a', 'msg-1', -10);
    cache.set('a', 'msg-1', NaN);
    cache.set('a', 'msg-1', Infinity);
    expect(cache.has('a', 'msg-1')).toBe(false);
  });

  it('keeps sessions isolated: the same message id in another session is unaffected', () => {
    const cache = new TranscriptHeightCache();
    cache.set('a', 'msg-1', 240);
    expect(cache.get('b', 'msg-1')).toBe(DEFAULT_ESTIMATED_ROW_HEIGHT_PX);
  });

  it('invalidate() drops the measurement, reverting to the estimate', () => {
    const cache = new TranscriptHeightCache();
    cache.set('a', 'msg-1', 240);
    cache.invalidate('a', 'msg-1');
    expect(cache.has('a', 'msg-1')).toBe(false);
    expect(cache.get('a', 'msg-1')).toBe(DEFAULT_ESTIMATED_ROW_HEIGHT_PX);
  });

  it('invalidate() on an unknown session/id is a no-op, not a throw', () => {
    const cache = new TranscriptHeightCache();
    expect(() => cache.invalidate('unknown', 'msg-1')).not.toThrow();
  });

  it('boundHeightOf() returns a closure reading the same cache for a fixed instance', () => {
    const cache = new TranscriptHeightCache();
    cache.set('a', 'msg-1', 150);
    const heightOf = cache.boundHeightOf('a');
    expect(heightOf('msg-1')).toBe(150);
    expect(heightOf('msg-2')).toBe(DEFAULT_ESTIMATED_ROW_HEIGHT_PX);

    // A later write through the cache is visible through the already-bound closure.
    cache.set('a', 'msg-2', 300);
    expect(heightOf('msg-2')).toBe(300);
  });

  it('retains measurements across repeated access — a per-session cache persists, it is not cleared on "switch"', () => {
    const cache = new TranscriptHeightCache();
    cache.set('a', 'msg-1', 240);
    // Simulate visiting another session and coming back — nothing in this
    // class ever clears session 'a' implicitly.
    cache.get('b', 'msg-1');
    expect(cache.get('a', 'msg-1')).toBe(240);
  });
});
