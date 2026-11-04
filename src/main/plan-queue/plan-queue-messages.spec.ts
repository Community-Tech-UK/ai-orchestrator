import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { buildRunSummaryMessage } from './plan-queue-messages';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';

describe('cancelled queue summaries', () => {
  it('counts untouched documents as not reached while preserving deliberate skip decisions', () => {
    const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans',
      workspaceCwd: '/repo', status: 'cancelled', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, workerProvider: 'claude',
      workerModel: null, relaxation: null, startedAt: 1, endedAt: 2 };
    const items = [
      newPlanQueueItem('unreached', run.id, '/repo/a_plan.md', 1, { state: 'skipped', detail: 'Run cancelled by James.' }),
      newPlanQueueItem('skipped', run.id, '/repo/b_plan.md', 1, { state: 'skipped', detail: 'Skipped by James.' }),
    ];
    expect(buildRunSummaryMessage(run, items)).toContain('skipped 1, not reached 1.');
    expect(items.map(item => item.detail)).toEqual(['Run cancelled by James.', 'Skipped by James.']);
  });
});
