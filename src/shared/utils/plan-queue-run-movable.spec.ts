import { describe, expect, it } from 'vitest';
import { planQueueRunCanMove } from './plan-queue-run-movable';

const item = (state: string, overrides: { branchName?: string | null; discardedAt?: number | null } = {}) =>
  ({ state, branchName: 'queue/a', worktreePath: null, discardedAt: null, ...overrides });

describe('planQueueRunCanMove', () => {
  it.each(['running', 'paused'] as const)('moves a %s run, even with nothing set aside', status => {
    expect(planQueueRunCanMove({ status, items: [] })).toBe(true);
  });

  it.each(['completed', 'cancelled'] as const)('moves a %s run only while it holds set-aside work its owner can act on', status => {
    expect(planQueueRunCanMove({ status, items: [item('landed'), item('skipped')] })).toBe(false);
    expect(planQueueRunCanMove({ status, items: [item('parked')] })).toBe(true);
    expect(planQueueRunCanMove({ status, items: [item('parked', { branchName: null, discardedAt: 1 })] })).toBe(false);
  });
});
