import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { selectCurrentQueueVerifier } from './plan-queue-checker-routing';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const run: PlanQueueRun = {
  id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo', status: 'running',
  config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, routing: { workers: [{ provider: 'claude', model: 'claude-opus-5' }, { provider: 'codex' }], verifiers: [] } },
  relaxation: null, workerProvider: 'claude', workerModel: 'claude-opus-5', startedAt: 1, endedAt: null,
};

function host(live: { provider?: string; currentModel?: string } | undefined) {
  const selectVerifier = vi.fn().mockResolvedValue({ ok: true, choice: { provider: 'cursor' } });
  const flowHost = {
    getRun: () => run,
    instances: { getInstance: () => live },
    selectVerifier,
  } as unknown as PlanQueueFlowHost;
  return { flowHost, selectVerifier };
}

describe('selectCurrentQueueVerifier', () => {
  const item: PlanQueueItem = { ...newPlanQueueItem('item', 'run', '/repo/a_plan.md', 1, { workerInstanceId: 'gone' }), workerProvider: 'codex', workerModel: 'gpt-6.1-sol' };

  it('judges the live worker session when it is still there', async () => {
    const { flowHost, selectVerifier } = host({ provider: 'opencode', currentModel: 'openai/gpt-5.5' });
    await selectCurrentQueueVerifier(flowHost, item);
    expect(selectVerifier).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'opencode', workerModel: 'openai/gpt-5.5' }));
  });

  it('uses what the item\'s worker ran on once that session is gone, not the run\'s first choice', async () => {
    const { flowHost, selectVerifier } = host(undefined);
    await selectCurrentQueueVerifier(flowHost, item);
    expect(selectVerifier).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'codex', workerModel: 'gpt-6.1-sol' }));
  });

  it('never pairs a recorded or live provider with another choice\'s model', async () => {
    const noModel: PlanQueueItem = { ...item, workerModel: undefined };
    let { flowHost, selectVerifier } = host(undefined);
    await selectCurrentQueueVerifier(flowHost, noModel);
    expect(selectVerifier).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'codex', workerModel: null }));

    ({ flowHost, selectVerifier } = host({ provider: 'opencode' }));
    await selectCurrentQueueVerifier(flowHost, item);
    expect(selectVerifier).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'opencode', workerModel: null }));
  });

  it('turns a failed checker lookup into a refusal with the reason, so the item parks instead of hanging', async () => {
    const { flowHost, selectVerifier } = host(undefined);
    selectVerifier.mockRejectedValueOnce(new Error('database is locked'));
    await expect(selectCurrentQueueVerifier(flowHost, item)).resolves.toMatchObject({
      selection: { ok: false, reason: 'could not choose a checker: database is locked' },
    });
  });

  it('falls back to the run\'s worker for an item recorded before workers were ranked', async () => {
    const { flowHost, selectVerifier } = host(undefined);
    await selectCurrentQueueVerifier(flowHost, newPlanQueueItem('old', 'run', '/repo/b_plan.md', 1));
    expect(selectVerifier).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'claude', workerModel: 'claude-opus-5' }));
  });
});
