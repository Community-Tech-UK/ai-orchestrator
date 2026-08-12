import { describe, expect, it } from 'vitest';

import { isOccupancyPressureReading } from '../../shared/utils/context-occupancy';
import type { ContextUsage } from '../../shared/types/instance.types';

/**
 * LT-034 (gate round 2, finding 1). `calculateContextBudget` skips RLM and
 * unified-memory injection entirely once `percentage` crosses 90 (95 for
 * children). For an aggregate-only provider that percentage is cumulative
 * spend, which is monotonically non-decreasing — so the threshold trips on
 * tokens billed and then stays tripped, silently disabling context injection
 * for the rest of the session with no visible symptom.
 *
 * The predicate is tested directly rather than through `InstanceContext`
 * because the rule is duplicated across the in-process path
 * (`instance-context.ts`) and the worker path (`context-worker-client.ts`), and
 * the point of extracting it was that the two cannot drift again.
 */
describe('isOccupancyPressureReading (LT-034)', () => {
  const usage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
    used: 190_000,
    total: 200_000,
    percentage: 95,
    occupancyReported: true,
    ...over,
  });

  it('accepts a real provider-reported window occupancy', () => {
    expect(isOccupancyPressureReading(usage())).toBe(true);
  });

  it('rejects cumulative spend, however high', () => {
    expect(isOccupancyPressureReading(usage({ occupancyIsAggregate: true }))).toBe(false);
  });

  it('rejects the create-time placeholder (LT-018)', () => {
    expect(isOccupancyPressureReading({ used: 0, total: 200_000, percentage: 0 })).toBe(false);
  });

  it('rejects a missing reading rather than throwing', () => {
    expect(isOccupancyPressureReading(undefined)).toBe(false);
  });

  it('treats an explicit occupancyIsAggregate:false as a real reading', () => {
    expect(isOccupancyPressureReading(usage({ occupancyIsAggregate: false }))).toBe(true);
  });
});
