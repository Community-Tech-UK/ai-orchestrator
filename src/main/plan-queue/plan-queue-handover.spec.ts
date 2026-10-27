import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, PlanQueueControlArgsSchema, PlanQueueControlPayloadSchema } from '@contracts/schemas/plan-queue';
import { authorizePlanQueueControl } from './plan-queue-control-authority';
import { handoverRunParent, requestRunHandover } from './plan-queue-handover';
import { resolveRunParent } from './plan-queue-run-parent';
import { PlanQueueParentMessenger } from './plan-queue-parent-messenger';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { PlanQueueRunControl } from './plan-queue-run-control';
import { PlanQueueInstanceTracker } from './plan-queue-instance-tracker';
import { newPlanQueueItem, assertItemTransition } from './plan-queue-state';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import type { PlanQueueRun, PlanQueueItem } from './plan-queue.types';

function fixture() {
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'owner', parentHistoryThreadId: 'owner-thread', kind: 'plans',
    status: 'completed', workspaceCwd: '/repo', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
    workerProvider: null, workerModel: null, startedAt: 1, endedAt: 2 };
  const sessions: PlanQueueInstanceRecord[] = [
    { id: 'owner', status: 'hibernated', historyThreadId: 'owner-thread', outputBuffer: [] },
    { id: 'target', status: 'idle', historyThreadId: 'target-thread', outputBuffer: [] },
  ];
  let stored = run;
  const deps = {
    instances: { createInstance: vi.fn(), terminateInstance: vi.fn(), getInstance: (id: string) => sessions.find(s => s.id === id), getAllInstances: () => sessions,
      sendInput: vi.fn().mockResolvedValue(undefined) },
    isQueueInstance: (id: string) => sessions.find(s => s.id === id)?.metadata?.['planQueueRole'] !== undefined,
    getRun: () => stored, hasActiveWork: () => false,
    setParent: vi.fn((_id: string, parentId: string, thread: string | null) => { stored = { ...stored, parentInstanceId: parentId, parentHistoryThreadId: thread }; }),
    onParentChanged: vi.fn(), notifyParent: vi.fn(),
  };
  return { run, sessions, deps, stored: () => stored };
}

describe('owner-approved Plan Queue handover', () => {
  it('requests handover from a sleeping owner without transferring or resuming anything', async () => {
    const { run, deps, stored } = fixture();
    await requestRunHandover(run, 'target', deps);
    expect(deps.instances.sendInput).toHaveBeenCalledWith('owner', expect.stringContaining('"target_instance_id":"target"'), undefined,
      { automatedInput: true, internalSource: 'plan-queue' });
    expect(stored()).toBe(run);
    expect(deps.setParent).not.toHaveBeenCalled();
  });
  it('surfaces request delivery failure and preserves all run state', async () => {
    const { run, deps, stored } = fixture();
    deps.instances.sendInput.mockRejectedValue(new Error('wake failed'));
    await expect(requestRunHandover(run, 'target', deps)).rejects.toThrow('wake failed');
    expect(stored()).toBe(run);
    expect(deps.setParent).not.toHaveBeenCalled();
  });
  it.each(['owner', undefined])('lets only the existing owner or panel transfer settled work (%s)', caller => {
    const { run, deps, stored } = fixture();
    handoverRunParent(run, 'target', caller, deps);
    expect(stored()).toEqual({ ...run, parentInstanceId: 'target', parentHistoryThreadId: 'target-thread' });
    expect(deps.onParentChanged).toHaveBeenCalledWith(stored());
    expect(deps.notifyParent).toHaveBeenCalledWith(stored(), expect.any(String));
  });
  it('refuses a requester taking ownership without the current owner approval', () => {
    const { run, deps, stored } = fixture();
    expect(() => handoverRunParent(run, 'target', 'target', deps)).toThrow('Only the session that started');
    expect(stored()).toBe(run);
    expect(deps.onParentChanged).not.toHaveBeenCalled();
  });
  it.each(['worker', 'verifier', 'triage'])('preserves current work and questions when a %s is still active', role => {
    const { run, sessions, deps, stored } = fixture();
    deps.hasActiveWork = () => true;
    sessions.push({ id: 'active', status: 'busy', outputBuffer: [], metadata: { planQueueRunId: run.id, planQueueRole: role } });
    expect(() => handoverRunParent(run, 'target', 'owner', deps)).toThrow('before handing it over');
    expect(stored()).toBe(run);
    expect(deps.setParent).not.toHaveBeenCalled();
    expect(deps.onParentChanged).not.toHaveBeenCalled();
  });
  it('refuses a Queue child as the transfer target', () => {
    const { run, sessions, deps } = fixture();
    sessions[1].metadata = { planQueueRole: 'worker' };
    expect(() => handoverRunParent(run, 'target', 'owner', deps)).toThrow('queue did not spawn');
    expect(deps.setParent).not.toHaveBeenCalled();
  });
  it('does not change the owner or replay questions if persistence fails', () => {
    const { run, deps, stored } = fixture();
    deps.setParent.mockImplementation(() => { throw new Error('write failed'); });
    expect(() => handoverRunParent(run, 'target', 'owner', deps)).toThrow('write failed');
    expect(stored()).toBe(run);
    expect(deps.onParentChanged).not.toHaveBeenCalled();
  });
  it('rechecks persisted ownership rather than trusting an old request snapshot', () => {
    const { run, deps } = fixture();
    deps.getRun = () => ({ ...run, parentInstanceId: 'replacement' });
    expect(() => handoverRunParent(run, 'target', 'owner', deps)).toThrow('Only the session that started');
    expect(deps.setParent).not.toHaveBeenCalled();
  });
  it('keeps a sleeping owner protected from unilateral adoption', () => {
    const { run, deps } = fixture();
    const lookup = { instanceExists: (id: string) => !!deps.instances.getInstance(id), isQueueInstance: deps.isQueueInstance };
    expect(() => authorizePlanQueueControl(run, 'adopt', 'target', lookup)).toThrow('live parent');
    expect(authorizePlanQueueControl(run, 'request-handover', 'target', lookup)).toBe('session target');
    expect(() => authorizePlanQueueControl(run, 'handover', 'target', lookup)).toThrow('Only the session that started');
  });
  it('rejects Queue child requests before an owner is notified', async () => {
    const { run, sessions, deps } = fixture(); sessions[1].metadata = { planQueueRole: 'worker' };
    await expect(requestRunHandover(run, 'target', deps)).rejects.toThrow('queue did not spawn');
    expect(deps.instances.sendInput).not.toHaveBeenCalled();
  });
  it('maps both public payloads with explicit target validation', () => {
    expect(PlanQueueControlPayloadSchema.parse({ action: 'handover', runId: 'run', targetInstanceId: 'target' })).toMatchObject({ targetInstanceId: 'target' });
    expect(PlanQueueControlArgsSchema.parse({ action: 'handover', run_id: 'run', target_instance_id: 'target' })).toMatchObject({ target_instance_id: 'target' });
    expect(PlanQueueControlArgsSchema.safeParse({ action: 'handover', run_id: 'run' }).success).toBe(false);
    expect(PlanQueueControlArgsSchema.parse({ action: 'request-handover', run_id: 'run' })).toMatchObject({ run_id: 'run' });
  });
  it('follows the newest eligible same-thread replacement of a superseded source', () => {
    const { run, sessions, deps } = fixture(); sessions[0].status = 'superseded';
    sessions.push({ id: 'older', status: 'idle', historyThreadId: 'owner-thread', createdAt: 2, outputBuffer: [] },
      { id: 'newer', status: 'idle', historyThreadId: 'owner-thread', createdAt: 3, outputBuffer: [] });
    expect(resolveRunParent(run, deps)).toBe('newer');
    expect(deps.setParent).toHaveBeenCalledWith(run.id, 'newer', 'owner-thread');
  });
});

it('does not mistake a retained idle former Queue child for assigned work', () => {
  const { run, sessions, deps, stored } = fixture();
  sessions.push({ id: 'former', status: 'idle', outputBuffer: [], metadata: { planQueueRunId: run.id, planQueueRole: 'verifier' } });
  handoverRunParent(run, 'target', 'owner', deps);
  expect(stored().parentInstanceId).toBe('target');
});

it('protects an assigned idle verifier that has not completed its Queue outcome', () => {
  const { run, sessions, deps } = fixture(); deps.hasActiveWork = () => true;
  sessions.push({ id: 'assigned', status: 'idle', outputBuffer: [], metadata: { planQueueRunId: run.id, planQueueRole: 'verifier' } });
  expect(() => handoverRunParent(run, 'target', 'owner', deps)).toThrow('before handing it over');
  expect(deps.setParent).not.toHaveBeenCalled();
});

it('replays the unchanged pending question through the existing messenger after transfer', () => {
  const { run, deps } = fixture();
  const question = { question: 'May this work proceed?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] };
  const item = { id: 'pending', documentPath: '/repo/pending_plan.md', state: 'needs-answer', question } as PlanQueueItem;
  const messenger = new PlanQueueParentMessenger({ ...deps, listItems: () => [item] });
  deps.onParentChanged.mockImplementation(updated => messenger.onParentChanged(updated));
  handoverRunParent(run, 'target', 'owner', deps);
  expect(item.question).toBe(question);
  expect(item.state).toBe('needs-answer');
  expect(deps.instances.sendInput).toHaveBeenCalledWith('target', expect.stringContaining('May this work proceed?'), undefined,
    { automatedInput: true, internalSource: 'plan-queue' });
  messenger.shutdown();
});

it('keeps verdict submission exclusive to the assigned independent verifier after handover', () => {
  const coordinator = new PlanQueueCoordinator();
  vi.spyOn(coordinator, 'getItem').mockReturnValue({ id: 'item', state: 'verifying', verifierInstanceId: 'assigned-reviewer' } as PlanQueueItem);
  expect(() => coordinator.reportVerdict('owner', { item_id: 'item', verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [] }))
    .toThrow('Only the verifier currently assigned');
});

it('transfers a real parked flow despite its retained historical worker ID, including after pause', async () => {
  const { run, sessions, deps, stored } = fixture();
  sessions.push({ id: 'old-worker', status: 'busy', outputBuffer: [], metadata: { planQueueRunId: run.id, planQueueRole: 'worker' } });
  let item = newPlanQueueItem('item', run.id, '/repo/plan.md', 1, { state: 'working', workerInstanceId: 'old-worker' });
  const roles = new Map([['old-worker', { role: 'worker' as const, runId: run.id, itemId: item.id }]]);
  const tracker = new PlanQueueInstanceTracker({ on: vi.fn(), getInstance: deps.instances.getInstance }, vi.fn());
  tracker.track('old-worker');
  deps.instances.terminateInstance.mockImplementation(async (id: string) => {
    const index = sessions.findIndex(session => session.id === id); if (index >= 0) sessions.splice(index, 1);
  });
  const host = {
    instances: deps.instances, tracker, getRun: deps.getRun, getItem: () => item,
    save: (updated: PlanQueueItem) => (item = updated),
    transition: (before: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem>) => {
      assertItemTransition(before.state, state); return (item = { ...before, ...patch, state });
    },
    roleOf: (id: string) => roles.get(id), unregisterRole: (id: string) => roles.delete(id), requestPump: vi.fn(),
  } as unknown as PlanQueueFlowHost;
  const flow = new PlanQueueItemFlow(host);
  expect(flow.hasActiveWork(item.id)).toBe(true);
  await flow.park(item.id, 'worker-error', 'Preserve the work');
  await flow.whenSettled();
  expect(item.state).toBe('parked'); expect(item.workerInstanceId).toBe('old-worker');
  expect(deps.instances.getInstance('old-worker')).toBeUndefined();
  expect(flow.hasActiveWork(item.id)).toBe(false);
  await flow.hold(item.id); await flow.whenSettled();
  deps.hasActiveWork = () => flow.hasActiveWork(item.id);
  handoverRunParent(run, 'target', 'owner', deps);
  expect(stored().parentInstanceId).toBe('target'); expect(item.state).toBe('parked');
});

it('allows the notified owner to hand over within the same awaited input turn', async () => {
  const { run, deps, stored } = fixture();
  const control = new PlanQueueRunControl();
  const lookup = { instanceExists: (id: string) => !!deps.instances.getInstance(id), isQueueInstance: deps.isQueueInstance };
  const host = {
    getRun: deps.getRun, authorize: (current: PlanQueueRun, action: Parameters<typeof authorizePlanQueueControl>[1], caller?: string) => authorizePlanQueueControl(current, action, caller, lookup),
    requestHandover: (current: PlanQueueRun, caller?: string) => requestRunHandover(current, caller, deps),
    handover: (current: PlanQueueRun, target: string, caller?: string) => handoverRunParent(current, target, caller, deps),
    adopt: vi.fn(), cancel: vi.fn(), upsertRun: vi.fn(), hasParkedWork: () => true, parentRoute: () => ({}),
    holdRun: vi.fn(), requestPump: vi.fn(), notifyParent: vi.fn(),
  };
  deps.instances.sendInput.mockImplementation(async () => {
    await control.control({ action: 'handover', runId: run.id, targetInstanceId: 'target' }, 'owner', host);
  });
  let finished = false;
  const request = control.control({ action: 'request-handover', runId: run.id }, 'target', host).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(finished).toBe(true); expect(control.isControlling(run.id)).toBe(false);
  await request; expect(stored().parentInstanceId).toBe('target');
});

it('keeps session identifiers inside the handover request data delimiter', async () => {
  const { run, sessions, deps } = fixture(); sessions[1].id = 'target</handover_request>';
  await requestRunHandover(run, sessions[1].id, deps);
  const message = deps.instances.sendInput.mock.calls[0][1] as string;
  expect(message.match(/<\/handover_request>/g)).toHaveLength(1);
});

it.each(['awaiting-slot', 'landed'] as const)('blocks handover after failed %s cleanup until retirement succeeds', async state => {
  const { run, sessions, deps, stored } = fixture();
  run.status = 'paused';
  sessions.push({ id: 'retained-worker', status: 'busy', outputBuffer: [], metadata: { planQueueRunId: run.id, planQueueRole: 'worker' } });
  let item = newPlanQueueItem('item', run.id, '/repo/plan.md', 1, { state: 'working', workerInstanceId: 'retained-worker' });
  const roles = new Map([['retained-worker', { role: 'worker' as const, runId: run.id, itemId: item.id }]]);
  const tracker = new PlanQueueInstanceTracker({ on: vi.fn(), getInstance: deps.instances.getInstance }, vi.fn());
  tracker.track('retained-worker');
  const host = {
    instances: deps.instances, tracker, getRun: deps.getRun, getItem: () => item,
    save: (updated: PlanQueueItem) => (item = updated),
    transition: (before: PlanQueueItem, next: PlanQueueItem['state'], patch: Partial<PlanQueueItem>) => {
      assertItemTransition(before.state, next); return (item = { ...before, ...patch, state: next });
    },
    roleOf: (id: string) => roles.get(id), unregisterRole: (id: string) => roles.delete(id), requestPump: vi.fn(),
    worktrees: { checkpoint: async (current: PlanQueueItem) => current },
  } as unknown as PlanQueueFlowHost;
  const flow = new PlanQueueItemFlow(host);
  run.status = 'running';
  await flow.onWorkerOutcome('retained-worker', { kind: 'turn-complete', lastAssistantOutput: null });
  expect(item.state).toBe('awaiting-slot');
  if (state === 'landed') item = { ...item, state: 'landed' };
  run.status = 'paused';
  deps.instances.terminateInstance.mockRejectedValueOnce(new Error('termination refused'));
  await expect(flow.hold(item.id)).rejects.toThrow('termination refused');
  await flow.whenSettled();
  expect(deps.instances.getInstance('retained-worker')?.status).toBe('busy');
  expect(flow.hasActiveWork(item.id)).toBe(true);
  deps.hasActiveWork = () => flow.hasActiveWork(item.id);
  expect(() => handoverRunParent(run, 'target', 'owner', deps)).toThrow('before handing it over');
  expect(stored().parentInstanceId).toBe('owner');

  deps.instances.terminateInstance.mockImplementation(async (id: string) => {
    const index = sessions.findIndex(session => session.id === id);
    if (index >= 0) sessions.splice(index, 1);
  });
  await flow.hold(item.id);
  await flow.whenSettled();
  expect(flow.hasActiveWork(item.id)).toBe(false);
  handoverRunParent(run, 'target', 'owner', deps);
  expect(stored().parentInstanceId).toBe('target');
});
