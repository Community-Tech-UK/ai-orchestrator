import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueStateChangedEvent } from '@contracts/schemas/plan-queue';
import { coordinator, repo, store } from './plan-queue-coordinator.test-helpers';
import { newPlanQueueItem } from './plan-queue-state';

function run(id: string) {
  store.upsertRun({ id, parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo,
    status: 'paused', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
    workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
  for (let index = 0; index < 5; index++) store.upsertItem(newPlanQueueItem(`${id}-job-${index}`, id, `${repo}/docs/plans/${id}-${index}_plan.md`, index));
}

describe('Plan Queue change announcements', () => {
  it('sends one announcement per run for a burst of changes, with the run built once', async () => {
    run('first'); run('second');
    const events: PlanQueueStateChangedEvent[] = [];
    coordinator.on('state-changed', (event: PlanQueueStateChangedEvent) => events.push(event));
    const build = vi.spyOn(coordinator, 'getRunDto');
    for (const item of [...store.listItems('first'), ...store.listItems('second')]) coordinator.save({ ...item, detail: 'Changed' });
    coordinator.save({ ...coordinator.getItem('first-job-0'), detail: 'Changed again' });
    expect(events).toEqual([]);
    await new Promise(resolve => setImmediate(resolve));
    expect(events.map(event => event.runId)).toEqual(['first', 'second']);
    expect(build).toHaveBeenCalledTimes(2);
    expect(events[0]!.run?.items.find(item => item.id === 'first-job-0')?.detail).toBe('Changed again');
  });

  it('holds announcements until quiet work ends, then sends one per run', async () => {
    run('first');
    const events: PlanQueueStateChangedEvent[] = [];
    coordinator.on('state-changed', (event: PlanQueueStateChangedEvent) => events.push(event));
    await coordinator.quietly(async () => {
      coordinator.save({ ...coordinator.getItem('first-job-0'), detail: 'Before a pause' });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(events).toEqual([]);
      coordinator.save({ ...coordinator.getItem('first-job-1'), detail: 'After a pause' });
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(events.map(event => event.runId)).toEqual(['first']);
  });

  it('announces a run that no longer exists with no run', async () => {
    const events: PlanQueueStateChangedEvent[] = [];
    coordinator.on('state-changed', (event: PlanQueueStateChangedEvent) => events.push(event));
    coordinator.announceRun('gone');
    await coordinator._whenSettledForTesting();
    expect(events).toEqual([{ runId: 'gone', run: null }]);
  });
});
