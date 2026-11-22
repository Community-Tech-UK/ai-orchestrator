import { describe, expect, it } from 'vitest';
import type { ContextUsage } from '../types/instance.types';
import { trustedContextTokens } from './claude-cache-economics';
import {
  POST_COMPACTION_ESTIMATE_SOURCE,
  formatTokensK,
  isOccupancyPressureReading,
  selfCompactThreshold,
} from './context-occupancy';

describe('Claude context note helpers', () => {
  it('uses the smaller of the model window and configured ceiling, less Claude’s 33K reserve', () => {
    expect(selfCompactThreshold(1_000_000)).toBe(967_000);
    expect(selfCompactThreshold(1_000_000, 400_000)).toBe(367_000);
    expect(selfCompactThreshold(200_000, 400_000)).toBe(167_000);
    expect(selfCompactThreshold(20_000)).toBe(0);
  });

  it('formats a compact token count for the near-limit note', () => {
    expect(formatTokensK(412_000)).toBe('412K');
    expect(formatTokensK(999)).toBe('999');
  });
});

describe('isOccupancyPressureReading', () => {
  const measured: ContextUsage = { used: 180_000, total: 200_000, percentage: 90, occupancyReported: true };

  it('trusts a measured window occupancy', () => {
    expect(isOccupancyPressureReading(measured)).toBe(true);
    expect(trustedContextTokens(measured)).toBe(180_000);
  });

  it('treats the reading kept after a compaction as unknown until a measured reply', () => {
    const kept: ContextUsage = { ...measured, source: POST_COMPACTION_ESTIMATE_SOURCE, isEstimated: true };
    expect(isOccupancyPressureReading(kept)).toBe(false);
    expect(trustedContextTokens(kept)).toBeNull();
  });

  it('still ignores aggregate spend and unreported occupancy', () => {
    expect(isOccupancyPressureReading({ ...measured, occupancyIsAggregate: true })).toBe(false);
    expect(isOccupancyPressureReading({ ...measured, occupancyReported: false })).toBe(false);
    expect(isOccupancyPressureReading(undefined)).toBe(false);
  });
});
