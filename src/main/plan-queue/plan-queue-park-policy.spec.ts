import { describe, expect, it } from 'vitest';
import { PlanQueueParkReasonSchema } from '@contracts/schemas/plan-queue';
import { isNeverAutoRetried } from './plan-queue-park-policy';

describe('plan queue park policy', () => {
  it('never retries a job Harness stopped on purpose, or one that would undo a change made directly on main', () => {
    for (const reason of ['stopped-by-harness', 'undoes-direct-change'] as const) {
      expect(PlanQueueParkReasonSchema.options).toContain(reason);
      expect(isNeverAutoRetried(reason)).toBe(true);
    }
  });

  it('leaves every other reason to the retry rules', () => {
    const others = PlanQueueParkReasonSchema.options.filter((reason) => reason !== 'stopped-by-harness' && reason !== 'undoes-direct-change');
    expect(others.length).toBeGreaterThan(0);
    expect(others.some((reason) => isNeverAutoRetried(reason))).toBe(false);
    expect(isNeverAutoRetried(null)).toBe(false);
  });
});
