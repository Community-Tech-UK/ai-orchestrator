import { describe, expect, it } from 'vitest';
import { sessionKindOf } from './session-kind.types';

describe('sessionKindOf', () => {
  it.each([
    [null, 'chat'],
    ['loop', 'loop'],
    ['plan-queue', 'plan-queue'],
    ['automation', 'automation'],
    ['repo-job', 'automation'],
    ['child', 'child'],
    ['node-run', 'child'],
    ['review', 'review'],
    ['verification', 'review'],
    ['consensus', 'review'],
    ['workflow', 'review'],
    ['failover', 'review'],
    ['internal', 'review'],
    ['ping-pong-review', 'review'],
  ] as const)('maps %s to %s', (reason, expected) => {
    expect(sessionKindOf(reason)).toBe(expected);
  });
});
