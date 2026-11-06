import { describe, expect, it, vi } from 'vitest';
import { AuxiliarySlotBackoff } from './auxiliary-slot-backoff';

describe('AuxiliarySlotBackoff', () => {
  it('pauses each slot after two failures, retries at the deadline, and caps the delay', () => {
    let now = 1_000;
    const backoff = new AuxiliarySlotBackoff(() => now);
    backoff.recordFailure('compression');
    expect(backoff.active('compression')).toBeUndefined();
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      backoff.recordFailure('compression');
      expect(backoff.active('compression')).toMatchObject({
        slot: 'compression', pausedUntil: now + delay,
      });
      expect(backoff.active('titleGeneration')).toBeUndefined();
      now += delay;
      expect(backoff.active('compression')).toBeUndefined();
      expect(backoff.snapshot()).toEqual([]);
    }
  });

  it('publishes one pause and recovery transition, while manual retry retains delay history', () => {
    let now = 1_000;
    const changed = vi.fn();
    const backoff = new AuxiliarySlotBackoff(() => now, changed);
    backoff.recordFailure('compression');
    backoff.recordFailure('compression');
    expect(changed).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ kind: 'paused' }));
    expect(backoff.snapshot()).toHaveLength(1);
    backoff.retryNow('compression');
    expect(backoff.snapshot()).toEqual([]);
    backoff.recordFailure('compression');
    backoff.recordFailure('compression');
    expect(backoff.active('compression')?.pausedUntil).toBe(now + 120_000);
    expect(changed.mock.calls.filter(([, transition]) => transition?.kind === 'paused')).toHaveLength(1);
    now += 120_000;
    backoff.recordSuccess('compression');
    expect(backoff.snapshot()).toEqual([]);
    expect(changed.mock.calls.filter(([, transition]) => transition?.kind === 'resumed')).toHaveLength(1);
    backoff.recordFailure('titleGeneration');
    backoff.recordFailure('titleGeneration');
    backoff.clear();
    expect(backoff.snapshot()).toEqual([]);
  });
});
