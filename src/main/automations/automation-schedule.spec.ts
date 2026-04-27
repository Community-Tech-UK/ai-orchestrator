import { describe, expect, it } from 'vitest';
import {
  computeMissedFireTimes,
  computeNextFireAt,
} from './automation-schedule';

describe('automation schedule helpers', () => {
  it('computes cron missed fire times using schedule history', () => {
    const missed = computeMissedFireTimes(
      { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      Date.UTC(2026, 3, 26, 8, 30),
      Date.UTC(2026, 3, 26, 11, 30),
    );

    expect(missed).toEqual([
      Date.UTC(2026, 3, 26, 9, 0),
      Date.UTC(2026, 3, 26, 10, 0),
      Date.UTC(2026, 3, 26, 11, 0),
    ]);
  });

  it('returns a past one-time fire when baseline is before runAt', () => {
    expect(computeMissedFireTimes(
      { type: 'oneTime', runAt: 1_000, timezone: 'UTC' },
      999,
      2_000,
    )).toEqual([1_000]);
  });

  it('uses paused Croner jobs for next fire calculation', () => {
    const next = computeNextFireAt(
      { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      Date.UTC(2026, 3, 26, 8, 0),
    );

    expect(next).toBe(Date.UTC(2026, 3, 26, 9, 0));
  });
});
