import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { createPlanQueueToolOperations } from './plan-queue-tool-operations';

vi.mock('../core/config/settings-manager', () => ({
  // The run summary's account-rules line reads these; none are set here.
  getSettingsManager: () => ({
    getAll: () => ({ planQueueAccountRules: { never: [], last: [] }, providerAccountProfiles: [], copilotAccountProfiles: [] }),
  }),
}));

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
      workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null, items: [] }, excluded: ['/repo/owned_plan.md'], routingSetAside: [], accountNotes: [] });
    const result = await createPlanQueueToolOperations(() => coordinator).start('caller', { kind: 'plans' }) as { message: string };
    expect(result).toMatchObject({ excluded: ['/repo/owned_plan.md'], message: expect.stringContaining('adopt that run instead of starting again') });
    expect(result.message).not.toContain('saved Plan Queue choice');
  });
  it('passes ranked worker choices through and says when James\'s saved lists were used instead', async () => {
    const coordinator = new PlanQueueCoordinator();
    const startRun = vi.spyOn(coordinator, 'startRun').mockResolvedValue({ run: { id: 'new-run', parentInstanceId: 'caller', kind: 'plans',
      workspaceCwd: '/repo', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
      workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null, items: [] }, excluded: [], routingSetAside: ['workers', 'checkers'], accountNotes: [] });
    const result = await createPlanQueueToolOperations(() => coordinator).start('caller', {
      kind: 'plans', workers: [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', account_ids: ['max-a'] }],
    }) as { message: string };
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      routing: { workers: [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', accountProfileIds: ['max-a'] }] },
    }));
    expect(result.message).toContain('James\'s saved Plan Queue choice for workers and checkers was used instead of the one you passed.');
  });
});


it('maps nested snake_case routing and preserves authenticated identity', async () => {
  const coordinator = new PlanQueueCoordinator();
  const control = vi.spyOn(coordinator, 'control').mockResolvedValue();
  await createPlanQueueToolOperations(() => coordinator).control('parent', {
    action: 'set-routing', run_id: 'run', routing: { workers: [{ provider: 'codex', account_ids: ['account'] }], verifiers: [{ provider: 'claude' }] }, move_in_progress: true,
  });
  expect(control).toHaveBeenCalledWith({ action: 'set-routing', runId: 'run', routing: { workers: [{ provider: 'codex', accountProfileIds: ['account'] }], verifiers: [{ provider: 'claude' }] }, moveInProgress: true }, 'parent');
});

it('keeps the authenticated caller for request and approved handover routes', async () => {
  const coordinator = new PlanQueueCoordinator();
  const control = vi.spyOn(coordinator, 'control').mockResolvedValue();
  const ops = createPlanQueueToolOperations(() => coordinator);
  await ops.control('requester', { action: 'request-handover', run_id: 'run' });
  await ops.control('owner', { action: 'handover', run_id: 'run', target_instance_id: 'requester' });
  expect(control.mock.calls).toEqual([
    [{ action: 'request-handover', runId: 'run' }, 'requester'],
    [{ action: 'handover', runId: 'run', targetInstanceId: 'requester' }, 'owner'],
  ]);
});

it('passes a step-up choice through start and set-routing, and names it when James\'s saved one won', async () => {
  const coordinator = new PlanQueueCoordinator();
  const startRun = vi.spyOn(coordinator, 'startRun').mockResolvedValue({ run: { id: 'new-run', parentInstanceId: 'caller', kind: 'plans',
    workspaceCwd: '/repo', status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, routing: { workers: [{ provider: 'claude', model: 'haiku' }], verifiers: [], stepUp: { provider: 'claude', model: 'opus' } } },
    workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null,
    items: [{ id: 'item', runId: 'new-run', documentPath: '/repo/a_plan.md', state: 'fixing', round: 0, erroredRounds: 0, branchName: 'queue/a', worktreePath: null,
      baseCommit: null, checkpointCommit: null, landedCommit: null, workerInstanceId: null, verifierInstanceId: null, question: null, answer: null,
      parkReason: null, detail: null, verdict: null, steppedUpAt: Date.UTC(2026, 9, 27), createdAt: 1, updatedAt: 1 }] },
  excluded: [], routingSetAside: ['workers', 'step-up'], accountNotes: [] });
  const ops = createPlanQueueToolOperations(() => coordinator);
  const result = await ops.start('caller', { kind: 'plans', step_up: { provider: 'codex', account_ids: ['pro'] } }) as {
    message: string; routing: { stepUp: string }; items: { handedToStepUpAt?: string }[];
  };
  expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ routing: { stepUp: { provider: 'codex', accountProfileIds: ['pro'] } } }));
  expect(result.message).toContain('James\'s saved Plan Queue choice for workers and the step-up worker was used instead of the one you passed.');
  expect(result.routing.stepUp).toBe('claude / opus');
  expect(result.items[0].handedToStepUpAt).toBe('2026-10-27T00:00:00.000Z');

  const control = vi.spyOn(coordinator, 'control').mockResolvedValue();
  await ops.control('parent', { action: 'set-routing', run_id: 'run', routing: { workers: [], verifiers: [], step_up: { provider: 'claude', model: 'opus' } } });
  expect(control).toHaveBeenCalledWith({ action: 'set-routing', runId: 'run', routing: { workers: [], verifiers: [], stepUp: { provider: 'claude', model: 'opus' } } }, 'parent');
});
