import { describe, expect, it } from 'vitest';
import { automaticReviewSkipReason } from './automatic-review-skip';
import type { Instance } from '../../shared/types/instance.types';

describe('automatic review session guards', () => {
  it.each([
    ['child', { parentId: 'parent' }],
    ['plan-queue', { metadata: { planQueueRunId: 'run' } }],
    ['automation', { metadata: { automationId: 'automation' } }],
    ['ping-pong-reviewer', { metadata: { pingPongReviewer: true } }],
    ['remote', { executionLocation: { type: 'remote', nodeId: 'worker' } }],
  ])('skips %s sessions', (reason, fields) => {
    expect(automaticReviewSkipReason({ id: 'session', ...fields } as Instance, () => false)).toBe(reason);
  });
  it('skips an active loop and missing sessions but accepts a local main session', () => {
    expect(automaticReviewSkipReason({ id: 'loop' } as Instance, id => id === 'loop')).toBe('active-loop');
    expect(automaticReviewSkipReason(undefined, () => false)).toBe('no-session');
    expect(automaticReviewSkipReason({ id: 'main' } as Instance, () => false)).toBeUndefined();
  });
});
