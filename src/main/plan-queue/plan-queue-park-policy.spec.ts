import { describe, expect, it } from 'vitest';
import { PlanQueueParkReasonSchema } from '@contracts/schemas/plan-queue';
import { isNeverAutoRetried } from './plan-queue-park-policy';

describe('plan queue park policy', () => {
  it('never retries a job Harness stopped on purpose', () => {
    expect(PlanQueueParkReasonSchema.options).toContain('stopped-by-harness');
    expect(isNeverAutoRetried('stopped-by-harness')).toBe(true);
  });

  it('leaves every other reason to the retry rules', () => {
    const others = PlanQueueParkReasonSchema.options.filter((reason) => reason !== 'stopped-by-harness');
    expect(others.length).toBeGreaterThan(0);
    expect(others.some((reason) => isNeverAutoRetried(reason))).toBe(false);
    expect(isNeverAutoRetried(null)).toBe(false);
  });
});
