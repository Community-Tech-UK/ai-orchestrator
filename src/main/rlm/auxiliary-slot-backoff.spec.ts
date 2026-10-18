import { describe, expect, it } from 'vitest';
import { AuxiliarySlotBackoff } from './auxiliary-slot-backoff';

describe('per-helper outage backoff', () => {
  it('opens after two failures, doubles retries and caps at five minutes', () => {
    let now = 1_000; const backoff = new AuxiliarySlotBackoff(() => now);
    backoff.recordFailure('compression'); expect(backoff.active('compression')).toBeUndefined();
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      backoff.recordFailure('compression');
      expect(backoff.active('compression')?.pausedUntil).toBe(now + delay);
      now += delay;
      expect(backoff.active('compression')).toBeUndefined();
    }
  });
  it('keeps helper types independent; success closes and retryNow allows immediate retry', () => {
    const backoff = new AuxiliarySlotBackoff(() => 1_000);
    backoff.recordFailure('compression'); backoff.recordFailure('compression');
    expect(backoff.active('titleGeneration')).toBeUndefined();
    backoff.recordSuccess('compression'); expect(backoff.snapshot()).toEqual([]);
    backoff.recordFailure('titleGeneration'); backoff.recordFailure('titleGeneration');
    backoff.retryNow('titleGeneration'); expect(backoff.active('titleGeneration')).toBeUndefined();
    backoff.clear(); expect(backoff.snapshot()).toEqual([]);
  });
});
