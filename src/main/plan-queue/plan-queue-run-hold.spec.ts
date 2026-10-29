import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost, PlanQueueRoleRecord } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { recoverPlanQueue, type PlanQueueRecoveryHost } from './plan-queue-recovery';
import { newPlanQueueItem } from './plan-queue-state';
import { holdItem, PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { PlanQueueSpawnOutOfUsage } from './plan-queue-spawn';
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
    tracker: { untrack: vi.fn(), track: vi.fn(), beginTurn: vi.fn(), isShuttingDown: vi.fn(() => false) } as unknown as PlanQueueFlowHost['tracker'],
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
  it('leaves landing to its owner in the low-level worker hold', async () => {
    item = { ...item, state: 'landing' };
    await holdItem(host, item, id => host.instances.terminateInstance(id), async () => undefined);
    expect(item.state).toBe('landing');
    expect(host.instances.terminateInstance).not.toHaveBeenCalled();
  });

  it('refuses a full hold when an unfinished landing cannot be restored or checkpointed', async () => {
    item = { ...item, state: 'landing' };
    writeFileSync(join(directory, '.git'), 'gitdir: /checkout-metadata\n');
    vi.mocked(host.worktrees.checkpoint).mockRejectedValue(new Error('Checkpoint recovery blocked'));
    await expect(flow.hold(item.id)).rejects.toThrow('Checkpoint recovery blocked');
    expect(item.state).toBe('landing');
    expect(host.instances.createInstance).not.toHaveBeenCalled();
  });

  it('lets a Pause that lands while a refused worker start is in flight clear its usage wait', async () => {
    run.status = 'running';
    item = { ...item, state: 'queued', verifierInstanceId: null, workerInstanceId: null };
    vi.mocked(host.instances.createInstance).mockRejectedValueOnce(new PlanQueueSpawnOutOfUsage(null, 'claude'));
    const starting = flow.startItem(item);
    const pausing = flow.hold(item.id);
    await Promise.all([starting, pausing]);
    expect(item.detail).toBe('Paused');
    expect(flow.isWaitingForUsage(item.id)).toBe(false);
  });

  it('holds an item whose folder was half-removed without committing in it', async () => {
    // 26 Oct: only an ignored _scratch was left. Its work is on the branch; Resume checks it out again.
    item = { ...item, state: 'awaiting-slot', verifierInstanceId: null, workerInstanceId: null };
    vi.mocked(host.worktrees.checkpoint).mockRejectedValue(new Error(`${directory} is not this item's checkout`));
    await flow.hold(item.id);
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'awaiting-slot', worktreePath: directory, heldAt: expect.any(Number) });
  });

  it('discards an interrupted check without sending another turn to the live worker', async () => {
    flow.recordVerdict(item, 'checker', fail);
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    expect(host.instances.sendInput).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'awaiting-slot', workerInstanceId: null, parkReason: null, round: 0, erroredRounds: 0, heldAt: expect.any(Number) });
    expect(item.worktreePath).toBe(directory);
  });

  it('holds a verifier that ended without a verdict instead of reminding it', async () => {
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    expect(host.instances.sendInput).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'awaiting-slot', parkReason: null, erroredRounds: 0, heldAt: expect.any(Number) });
    // The same outcome on a running run is reminded, so the pause is what declined it.
    run.status = 'running';
    item = { ...item, state: 'verifying', verifierInstanceId: 'checker', heldAt: null };
    roles.set('checker', { role: 'verifier', runId: run.id, itemId: item.id });
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    expect(host.instances.sendInput).toHaveBeenCalledWith('checker', expect.stringContaining('Plan Queue reminder 1 of 2'), undefined, expect.objectContaining({ internalSource: 'plan-queue' }));
  });

  it('counts an unusable round when a reminder turn fails', async () => {
    run.status = 'running';
    vi.mocked(host.instances.sendInput).mockRejectedValueOnce(new Error('session gone'));
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    await vi.waitFor(() => expect(item).toMatchObject({
      state: 'awaiting-slot', erroredRounds: 1, verifierInstanceId: null, detail: 'the verifier failed: its reminder turn failed: session gone',
    }));
    expect(host.instances.sendInput).toHaveBeenCalledTimes(1);
    expect(host.instances.terminateInstance).toHaveBeenCalledWith('checker', true);
  });

  it('lets Pause stop a verifier at once while its reminder turn is still running', async () => {
    run.status = 'running';
    // Codex app-server settles sendInput only when the turn ends.
    vi.mocked(host.instances.sendInput).mockReturnValueOnce(new Promise<void>(() => undefined));
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    run.status = 'paused';
    await flow.hold(item.id);
    expect(host.instances.terminateInstance).toHaveBeenCalledWith('checker', true);
    expect(item).toMatchObject({ state: 'awaiting-slot', erroredRounds: 0, heldAt: expect.any(Number) });
  });

  it('does not count a round when a reminder send fails because the app is quitting', async () => {
    run.status = 'running';
    vi.mocked(host.tracker.isShuttingDown).mockReturnValue(true);
    vi.mocked(host.instances.sendInput).mockRejectedValueOnce(new Error('app quitting'));
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    await flow.whenSettled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.instances.terminateInstance).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'verifying', verifierInstanceId: 'checker', erroredRounds: 0 });
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
