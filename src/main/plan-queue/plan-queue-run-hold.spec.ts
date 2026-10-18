import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost, PlanQueueRoleRecord } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { recoverPlanQueue, type PlanQueueRecoveryHost } from './plan-queue-recovery';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

vi.mock('./plan-queue-git', async (original) => ({
  ...await original<typeof import('./plan-queue-git')>(),
  branchExists: vi.fn(async () => true), unresolvedMergeFiles: vi.fn(async () => []),
  snapshotTree: vi.fn(async () => ({ head: 'checkpoint', status: [] })),
  revertToSnapshot: vi.fn(async () => undefined),
}));

let directory: string;
let run: PlanQueueRun;
let item: PlanQueueItem;
let host: PlanQueueFlowHost;
let flow: PlanQueueItemFlow;
let roles: Map<string, PlanQueueRoleRecord>;
const fail: PlanQueueVerdict = { verdict: 'FAIL', findings: [{ severity: 'high', confidence: 95, summary: 'Fix missing guard' }], gatesRun: [], documentComplete: false, needJames: [] };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'queue-hold-'));
  run = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: directory,
    status: 'paused', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main' }, relaxation: null,
    workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null };
  item = newPlanQueueItem('item', run.id, join(directory, 'example_plan.md'), 1, {
    state: 'verifying', branchName: 'queue/example', worktreePath: directory, checkpointCommit: 'checkpoint', workerInstanceId: 'worker', verifierInstanceId: 'checker',
  });
  roles = new Map([['worker', { role: 'worker', runId: run.id, itemId: item.id }], ['checker', { role: 'verifier', runId: run.id, itemId: item.id }]]);
  host = {
    getRun: () => run, getItem: () => item,
    save: vi.fn((next) => (item = next)), transition: vi.fn((next, state, patch) => (item = { ...next, ...patch, state })),
    instances: { createInstance: vi.fn(async () => ({ id: 'fresh' })), sendInput: vi.fn(async () => undefined),
      terminateInstance: vi.fn(async () => undefined), getInstance: vi.fn((id: string) => ({ id, status: 'idle' as const, outputBuffer: [] })), getAllInstances: () => [] },
    worktrees: { checkpoint: vi.fn(async (next: PlanQueueItem) => (item = next)), reattach: vi.fn(async (next: PlanQueueItem) => next) } as unknown as PlanQueueFlowHost['worktrees'],
    tracker: { untrack: vi.fn(), track: vi.fn(), beginTurn: vi.fn() } as unknown as PlanQueueFlowHost['tracker'],
    registerRole: (id, role) => { roles.set(id, role); }, unregisterRole: (id) => { roles.delete(id); }, roleOf: (id) => roles.get(id),
    notifyParent: vi.fn(), liveParentId: () => 'parent', resolveRunParent: () => 'parent', requestPump: vi.fn(), selectVerifier: vi.fn(),
  };
  flow = new PlanQueueItemFlow(host);
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('paused runs never continue work or park it', () => {
  it('leaves a document which has never started in its original waiting state', async () => {
    item = { ...item, state: 'queued', branchName: null, worktreePath: null, workerInstanceId: null, verifierInstanceId: null };
    await flow.hold(item.id);
    expect(item).toMatchObject({ state: 'queued', heldAt: null });
    expect(host.save).not.toHaveBeenCalled();
  });
  it('holds instead of parking when Pause wins the worker spawn race', async () => {
    run.status = 'running'; item = { ...item, state: 'queued', verifierInstanceId: null, workerInstanceId: null };
    vi.mocked(host.instances.createInstance).mockImplementationOnce(async () => { run.status = 'paused'; throw new PlanQueueSpawnRunPaused(); });
    await flow.startItem(item);
    expect(item).toMatchObject({ state: 'queued', parkReason: null, heldAt: expect.any(Number) });
    expect(item.worktreePath).toBe(directory);
  });
  it('retains the last FAIL findings when holding a fixing worker and clears them after resume', async () => {
    item = { ...item, state: 'fixing', verdict: fail, verifierInstanceId: null, round: 1 };
    await flow.hold(item.id);
    expect(item).toMatchObject({ state: 'queued', heldAt: expect.any(Number), pendingInstruction: expect.stringContaining('Fix missing guard') });
    run.status = 'running';
    await flow.startItem(item);
    expect(host.instances.createInstance).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: expect.stringContaining('Fix missing guard') }));
    expect(item).toMatchObject({ state: 'working', pendingInstruction: null, heldAt: null });
  });
  it('leaves landing alone', async () => {
    item = { ...item, state: 'landing' };
    await flow.hold(item.id);
    expect(item.state).toBe('landing');
    expect(host.instances.terminateInstance).not.toHaveBeenCalled();
  });

  it('discards an interrupted check without sending another turn to the live worker', async () => {
    flow.recordVerdict(item, 'checker', fail);
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    expect(host.instances.sendInput).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'awaiting-slot', workerInstanceId: null, parkReason: null, round: 0, erroredRounds: 0, heldAt: expect.any(Number) });
    expect(item.worktreePath).toBe(directory);
  });

  it('holds instead of parking when the worker is gone at the fix round', async () => {
    vi.mocked(host.instances.getInstance).mockReturnValue(undefined);
    vi.mocked(host.instances.createInstance).mockRejectedValue(new Error('paused spawn must not be reached'));
    flow.recordVerdict(item, 'checker', fail);
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    expect(host.instances.createInstance).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'awaiting-slot', parkReason: null });
  });

  it.each(['preparing', 'working', 'fixing'] as const)('recovers a paused %s item without starting or parking it', async (state) => {
    item = { ...item, state, worktreePath: null, verifierInstanceId: null };
    vi.mocked(host.instances.getInstance).mockReturnValue(undefined);
    const recoveryHost = Object.assign(host, {
      store: { listRunsWithRelaxation: () => [], listActiveRuns: () => [run], listItems: () => [item] },
      refreshAlerts: vi.fn(), applyRelaxation: vi.fn(), restoreRelaxation: (r: PlanQueueRun) => r,
    }) as unknown as PlanQueueRecoveryHost;
    await recoverPlanQueue(recoveryHost, flow);
    expect(host.instances.createInstance).not.toHaveBeenCalled();
    expect(host.worktrees.reattach).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'queued', workerInstanceId: null, parkReason: null, heldAt: expect.any(Number) });
  });
});
