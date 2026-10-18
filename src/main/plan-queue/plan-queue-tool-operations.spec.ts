import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { createPlanQueueToolOperations } from './plan-queue-tool-operations';

describe('Plan Queue tool operation adoption routing', () => {
  it('maps adopt to a run action and keeps authenticated caller identity', async () => {
    const coordinator = new PlanQueueCoordinator();
    const control = vi.spyOn(coordinator, 'control').mockResolvedValue();
    const ops = createPlanQueueToolOperations(() => coordinator);
    await ops.control('authenticated-session', { action: 'adopt', run_id: 'stranded-run' });
    expect(control).toHaveBeenCalledWith({ action: 'adopt', runId: 'stranded-run' }, 'authenticated-session');
    await expect(ops.control('authenticated-session', { action: 'adopt', item_id: 'item' })).rejects.toThrow('adopt needs run_id');
    expect(control).toHaveBeenCalledTimes(1);
  });
  it('tells a new caller to adopt rather than start over when documents are already owned', async () => {
    const coordinator = new PlanQueueCoordinator();
    vi.spyOn(coordinator, 'startRun').mockResolvedValue({ run: { id: 'new-run', parentInstanceId: 'caller', kind: 'plans',
      workspaceCwd: '/repo', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
      workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null, items: [] }, excluded: ['/repo/owned_plan.md'] });
    const result = await createPlanQueueToolOperations(() => coordinator).start('caller', { kind: 'plans' });
    expect(result).toMatchObject({ excluded: ['/repo/owned_plan.md'], message: expect.stringContaining('adopt that run instead of starting again') });
  });
});


it('maps nested snake_case routing and preserves authenticated identity', async () => {
  const coordinator = new PlanQueueCoordinator();
  const control = vi.spyOn(coordinator, 'control').mockResolvedValue();
  await createPlanQueueToolOperations(() => coordinator).control('parent', {
    action: 'set-routing', run_id: 'run', routing: { worker: { provider: 'codex', account_ids: ['account'] }, verifiers: [{ provider: 'claude' }] }, move_in_progress: true,
  });
  expect(control).toHaveBeenCalledWith({ action: 'set-routing', runId: 'run', routing: { worker: { provider: 'codex', accountProfileIds: ['account'] }, verifiers: [{ provider: 'claude' }] }, moveInProgress: true }, 'parent');
});
