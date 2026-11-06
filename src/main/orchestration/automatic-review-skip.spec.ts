import { describe, expect, it } from 'vitest';
import { automaticReviewSkipReason } from './automatic-review-skip';
import { machineSessionReasonOf } from '../../shared/utils/machine-session';
import type { Instance } from '../../shared/types/instance.types';

describe('automatic review session guards', () => {
  it.each([
    ['child', { parentId: 'parent' }],
    ['plan-queue', { metadata: { planQueueRunId: 'run' } }],
    ['automation', { metadata: { automationId: 'automation' } }],
    ['ping-pong-review', { metadata: { pingPongReviewer: true } }],
    ['plan-queue', { metadata: { planQueueRole: 'triage' } }],
    ['plan-queue', { metadata: { spendPurpose: 'plan-queue' } }],
    ['automation', { metadata: { spendPurpose: 'automation' } }],
    ['repo-job', { metadata: { spendPurpose: 'repo-job' } }],
    ['node-run', { metadata: { spawnParentInstanceId: 'p' } }],
    ['node-run', { metadata: { spendPurpose: 'remote-node' } }],
    ['remote', { executionLocation: { type: 'remote', nodeId: 'worker' } }],
  ])('skips %s sessions', (reason, fields) => {
    expect(automaticReviewSkipReason({ id: 'session', ...fields } as Instance, () => false)).toBe(reason);
  });
  it('uses the single machine-session classifier, so the two definitions cannot drift', () => {
    const markers: Record<string, unknown>[] = [
      { planQueueRunId: 'run' }, { planQueueRole: 'triage' }, { automationId: 'a' }, { pingPongReviewer: true },
      { spendPurpose: 'repo-job' }, { spendPurpose: 'plan-queue' }, { spendPurpose: 'automation' },
      { spendPurpose: 'remote-node' }, { spawnParentInstanceId: 'p' },
    ];
    for (const metadata of markers) {
      const session = { id: 'session', metadata } as Instance;
      expect(automaticReviewSkipReason(session, () => false)).toBe(machineSessionReasonOf(session));
    }
  });
  it('lets a person-started session with only an unrelated spend purpose through', () => {
    expect(automaticReviewSkipReason({ id: 'main', metadata: { spendPurpose: 'chat' } } as unknown as Instance, () => false)).toBeUndefined();
  });
  it('skips an active loop and missing sessions but accepts a local main session', () => {
    expect(automaticReviewSkipReason({ id: 'loop' } as Instance, id => id === 'loop')).toBe('active-loop');
    expect(automaticReviewSkipReason(undefined, () => false)).toBe('no-session');
    expect(automaticReviewSkipReason({ id: 'main' } as Instance, () => false)).toBeUndefined();
  });
});
