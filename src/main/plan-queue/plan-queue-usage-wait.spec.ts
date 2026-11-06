import { describe, expect, it } from 'vitest';
import { USAGE_RECHECK_MS } from './plan-queue-spawn';
import { nextUsageWait } from './plan-queue-usage-wait';

const HOUR = 60 * 60_000;
const now = 1_000 * HOUR;

describe('nextUsageWait', () => {
  it('waits longer each time, up to an hour', () => {
    expect(nextUsageWait([], now)).toBe(USAGE_RECHECK_MS);
    expect(nextUsageWait([now - 1], now)).toBe(USAGE_RECHECK_MS * 2);
    expect(nextUsageWait(Array.from({ length: 12 }, (_, index) => now - index), now)).toBe(HOUR);
  });

  it('keeps waiting through a whole day of holds', () => {
    expect(nextUsageWait(Array.from({ length: 23 }, (_, index) => now - (index + 1) * HOUR), now)).toBe(HOUR);
  });

  it('gives up once a limit has held the job for a day', () => {
    expect(nextUsageWait(Array.from({ length: 24 }, (_, index) => now - (index + 1) * HOUR), now)).toBeNull();
  });

  it('gives up only on an unbroken stretch, so one old wait does not park a job on a new limit', () => {
    expect(nextUsageWait([now - 25 * HOUR], now)).toBe(USAGE_RECHECK_MS);
    expect(nextUsageWait([now - 72 * HOUR], now)).toBe(USAGE_RECHECK_MS);
  });

  it('counts a day of hourly waits as one stretch', () => {
    expect(nextUsageWait(Array.from({ length: 25 }, (_, index) => now - index * HOUR), now)).toBeNull();
  });
});
