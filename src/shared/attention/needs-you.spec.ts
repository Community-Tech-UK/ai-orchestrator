import { describe, expect, it } from 'vitest';
import { ALL_INSTANCE_STATUSES } from './attention-level';
import { instanceNeedsYouKind, sortNeedsYou, type NeedsYouEntry } from './needs-you';

describe('needs-you rules', () => {
  it.each(ALL_INSTANCE_STATUSES)('classifies %s using the shared attention scale', (status) => {
    expect(instanceNeedsYouKind(status)).toBe(
      ['waiting_for_input', 'waiting_for_permission'].includes(status) ? 'answer'
        : ['error', 'failed', 'degraded'].includes(status) ? 'check' : null,
    );
    expect(instanceNeedsYouKind(status, { pendingApprovals: 1 })).toBe('answer');
    expect(instanceNeedsYouKind(status, { toolLoopCritical: true })).toBe('answer');
  });
  it('orders answers by deadline then oldest, applied next, checks newest first without mutating input', () => {
    const entry = (key: string, kind: NeedsYouEntry['kind'], since: number, deadlineAt?: number): NeedsYouEntry =>
      ({ key, kind, since, deadlineAt, title: key, source: 'session', version: key });
    const entries = [entry('old-check', 'check', 1), entry('answer', 'answer', 1), entry('applied', 'applied', 1),
      entry('deadline', 'answer', 5, 10), entry('new-check', 'check', 9)];
    expect(sortNeedsYou(entries).map((item) => item.key)).toEqual(['deadline', 'answer', 'applied', 'new-check', 'old-check']);
    expect(entries[0].key).toBe('old-check');
  });
});
