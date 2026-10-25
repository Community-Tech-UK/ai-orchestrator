import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { pumpPlanQueue } from './plan-queue-pump';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';
import type { PlanQueueStore } from './plan-queue-store';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';

afterEach(() => WorkAdmission._resetForTesting());
describe('Plan Queue admission wiring', () => {
  it('keeps workers, checks and triage waiting during Hold and starts them on Release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'queue-admission-'));
    try {
      const document = join(root, 'work_plan.md'); writeFileSync(document, '# Work');
      const run: PlanQueueRun = { id: 'run', parentInstanceId: 'chat', parentHistoryThreadId: null,
        kind: 'plans', workspaceCwd: root, status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
        relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
      const worker = newPlanQueueItem('worker', 'run', document, 1, { state: 'queued' });
      const check = newPlanQueueItem('check', 'run', document, 2, { state: 'awaiting-slot' });
      const items = [worker, check];
      const starts: string[] = [];
      const host: Parameters<typeof pumpPlanQueue>[0] = {
        store: { listActiveRuns: () => [run], listItems: () => items } as unknown as PlanQueueStore,
        flow: { startItem: async item => { starts.push(item.id); }, startVerification: async item => { starts.push(item.id); } },
        triage: { isStopping: () => false, maybeStart: () => { starts.push('triage'); } },
        getRun: () => run, getItem: id => items.find(item => item.id === id)!,
        transition: (item, state, patch) => Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat',
        loadAverage: () => [0, 0, 0], followParent: value => value,
        isShuttingDown: () => false, isControlling: () => false,
        finishRun: () => { throw new Error('The active run must not finish'); },
        logItemError: (_item, error) => { throw error; },
      };
      getWorkAdmission().setGlobalPhase('holding');
      await pumpPlanQueue(host);
      expect(starts).toEqual([]);
      expect(items.map(item => item.state)).toEqual(['queued', 'awaiting-slot']);
      getWorkAdmission().setGlobalPhase('none');
      await pumpPlanQueue(host);
      expect(starts).toEqual(['triage', 'worker', 'check']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
