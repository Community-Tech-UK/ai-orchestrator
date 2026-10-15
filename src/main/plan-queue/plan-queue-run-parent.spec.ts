import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { resolveRunParent } from './plan-queue-run-parent';
import type { PlanQueueRun } from './plan-queue.types';
import type { PlanQueueInstanceRecord } from './plan-queue-host';

function run(thread: string | null = 'thread'): PlanQueueRun {
  return { id: 'run', parentInstanceId: 'old-parent', parentHistoryThreadId: thread, kind: 'plans', workspaceCwd: '/repo',
    status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
}
function deps(instances: PlanQueueInstanceRecord[], stored: PlanQueueRun = run()) {
  return { instances: { getInstance: (id: string) => instances.find((instance) => instance.id === id), getAllInstances: () => instances },
    isQueueInstance: (id: string) => instances.find((instance) => instance.id === id)?.metadata?.['planQueueRole'] !== undefined,
    getRun: () => stored, setParent: vi.fn() };
}
describe('Plan Queue parent resolution', () => {
  it('resolves persisted ownership when an in-flight operation still carries the previous parent snapshot', () => {
    const stale = run();
    const adopted = { ...run('new-thread'), parentInstanceId: 'adopter', status: 'paused' as const };
    const d = { ...deps([{ id: 'adopter', status: 'idle', historyThreadId: 'new-thread', outputBuffer: [] }]),
      getRun: () => adopted };
    expect(resolveRunParent(stale, d)).toBe('adopter');
    expect(stale.parentInstanceId).toBe('adopter');
    expect(d.setParent).not.toHaveBeenCalled();
  });
  it('keeps an existing parent owner even when its provider is errored', () => {
    const s = run(); const d = deps([{ id: 'old-parent', status: 'error', outputBuffer: [] }]);
    expect(resolveRunParent(s, d)).toBe('old-parent');
    expect(d.setParent).not.toHaveBeenCalled();
  });
  it('keeps legacy null-thread rows stranded rather than picking an unrelated session', () => {
    const s = run(null); const d = deps([{ id: 'other', status: 'idle', historyThreadId: 'thread', outputBuffer: [] }], s);
    expect(resolveRunParent(s, d)).toBeUndefined();
    expect(d.setParent).not.toHaveBeenCalled();
  });
  it('rejects a queue session or failed restored session with the same thread', () => {
    const s = run(); const d = deps([
      { id: 'queue', status: 'idle', historyThreadId: 'thread', metadata: { planQueueRole: 'worker' }, outputBuffer: [] },
      { id: 'failed', status: 'terminated', historyThreadId: 'thread', outputBuffer: [] },
    ]);
    expect(resolveRunParent(s, d)).toBeUndefined();
    expect(s.parentInstanceId).toBe('old-parent');
    expect(d.setParent).not.toHaveBeenCalled();
  });
  it('does not mutate caller ownership when persistence fails', () => {
    const s = run(); const d = deps([{ id: 'restored', status: 'idle', historyThreadId: 'thread', outputBuffer: [] }]);
    d.setParent.mockImplementation(() => { throw new Error('write failed'); });
    expect(() => resolveRunParent(s, d)).toThrow('write failed');
    expect(s.parentInstanceId).toBe('old-parent');
  });
});
