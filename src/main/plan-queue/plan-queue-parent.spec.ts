import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { findRestoredSessionId, PlanQueueParentTracker } from './plan-queue-parent';

function session(id: string, overrides: Partial<PlanQueueInstanceRecord> = {}): PlanQueueInstanceRecord {
  return { id, status: 'idle', outputBuffer: [], historyThreadId: `thread-${id}`, createdAt: 1, ...overrides };
}

describe('findRestoredSessionId', () => {
  const archived = [{ originalInstanceId: 'old-parent', historyThreadId: 'thread-a' }];

  it('finds the live session that reopened the gone session\'s conversation', () => {
    const restored = session('new-parent', { historyThreadId: 'thread-a' });

    expect(findRestoredSessionId('old-parent', archived, [session('other'), restored])).toBe('new-parent');
  });

  it('finds nothing without an archived entry or a live session on that thread', () => {
    expect(findRestoredSessionId('never-archived', archived, [session('x', { historyThreadId: 'thread-a' })])).toBeUndefined();
    expect(findRestoredSessionId('old-parent', archived, [session('other')])).toBeUndefined();
    expect(findRestoredSessionId('old-parent', [{ originalInstanceId: 'old-parent' }], [session('x')])).toBeUndefined();
  });

  it('never picks a queue session or an edit-superseded source, and prefers the newest', () => {
    const instances = [
      session('worker', { historyThreadId: 'thread-a', createdAt: 9, metadata: { planQueueRole: 'worker' } }),
      session('superseded', { historyThreadId: 'thread-a', createdAt: 8, status: 'superseded' }),
      session('older', { historyThreadId: 'thread-a', createdAt: 2 }),
      session('newer', { historyThreadId: 'thread-a', createdAt: 5 }),
    ];

    expect(findRestoredSessionId('old-parent', archived, instances)).toBe('newer');
  });
});

describe('PlanQueueParentTracker.followActiveRuns', () => {
  it('logs instead of throwing into the instance event that triggered it', () => {
    const tracker = new PlanQueueParentTracker({
      instances: {} as never,
      store: {
        getRun: vi.fn(),
        setRunParent: vi.fn(),
        listActiveRuns: () => { throw new Error('database is locked'); },
      },
      announce: vi.fn(),
    });

    expect(() => tracker.followActiveRuns()).not.toThrow();
  });
});
