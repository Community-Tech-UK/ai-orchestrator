import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueRun, PlanQueueItem } from './plan-queue.types';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueItemFlow } from './plan-queue-item-flow';

function harness() {
  let item = newPlanQueueItem('item', 'run', '/fixture/task_plan.md', 1, { state: 'working', workerInstanceId: 'worker' });
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/fixture', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
  const sendInput = vi.fn(async () => undefined);
  const notifyParent = vi.fn();
  const host = { getItem: () => item, getRun: () => run, save: (next: PlanQueueItem) => (item = next),
    roleOf: () => ({ role: 'worker', runId: 'run', itemId: 'item' }), registerRole: vi.fn(),
    instances: { getInstance: () => ({ id: 'worker', status: 'idle', outputBuffer: [] }), sendInput },
    tracker: { beginTurn: vi.fn() }, notifyParent,
  } as unknown as PlanQueueFlowHost;
  return { flow: new PlanQueueItemFlow(host), sendInput, notifyParent, item: () => item };
}

describe('unattended worker questions', () => {
  it('returns a routine clarification to the worker once without inventing human approval', async () => {
    const test = harness();
    const question = { kind: 'needs-input' as const, status: 'waiting_for_input' as const, lastAssistantOutput: 'Should I use the existing quiet test runner?' };
    await test.flow.onWorkerOutcome('worker', question);
    expect(test.sendInput).toHaveBeenCalledWith('worker', expect.stringContaining('does not grant new authority'), undefined, { automatedInput: true, internalSource: 'plan-queue' });
    expect(test.notifyParent).not.toHaveBeenCalled();
    expect(test.item().detail).toMatch(/^Routine question returned to the worker in round \d+; no new authority granted\.$/);
    await test.flow.onWorkerOutcome('worker', question);
    expect(test.notifyParent).toHaveBeenCalledTimes(1);
  });
  it.each(['May I deploy the release?', 'Please provide the account password.',
    'Which retention period has James approved?', 'Should the retention period be 30 or 90 days?',
    'Has the data owner signed off on the export?', 'Who authorised the new policy?',
  ])('keeps genuine human boundaries open: %s', async (text) => {
    const test = harness();
    await test.flow.onWorkerOutcome('worker', { kind: 'needs-input', status: 'waiting_for_input', lastAssistantOutput: text });
    expect(test.sendInput).not.toHaveBeenCalled();
    expect(test.item().question).not.toBeNull();
  });
});
