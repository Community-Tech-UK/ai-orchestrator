import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { buildRunSummaryMessage, runToDto } from './plan-queue-messages';
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
    expect(buildRunSummaryMessage(run, items, undefined)).toContain('skipped 1, not reached 1.');
    expect(items.map(item => item.detail)).toEqual(['Run cancelled by James.', 'Skipped by James.']);
  });
});

describe('queue checklist summaries', () => {
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans',
    workspaceCwd: '/repo', status: 'completed', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, workerProvider: 'claude',
    workerModel: null, relaxation: null, startedAt: 1, endedAt: 2 };

  it.each([
    [{ runs: 3, jobs: 10 }, '3 test runs covered 10 jobs'],
    [{ runs: 1, jobs: 1 }, '1 test run covered 1 job'],
  ])('reports actual checklist coverage in the message and DTO: %s', (checks, label) => {
    expect(buildRunSummaryMessage(run, [], checks)).toContain(label);
    expect(runToDto(run, [], checks).checks).toEqual(checks);
  });

  it('omits the checklist line and DTO field when no checklist executed', () => {
    expect(buildRunSummaryMessage(run, [], undefined)).not.toContain('test run');
    expect(runToDto(run, [], undefined)).not.toHaveProperty('checks');
  });
});
