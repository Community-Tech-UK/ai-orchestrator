import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost, PlanQueueRoleRecord } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { recoverPlanQueue, type PlanQueueRecoveryHost } from './plan-queue-recovery';
import { newPlanQueueItem } from './plan-queue-state';
import * as queueGit from './plan-queue-git';
import * as gitCommands from '../workspace/git/git-exec';
import { holdItem, PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { PlanQueueSpawnOutOfUsage } from './plan-queue-spawn';
import { spawnQueueChecker } from './plan-queue-checker-spawn';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';
import { PlanQueueUsageWaits } from './plan-queue-usage-wait';
import { InvalidQueueCheckoutError } from './plan-queue-orphan-checkout';
import { describePlanningMoves } from './plan-queue-planning-files';
import { PlanQueueVerification } from './plan-queue-verification';
import { getLogger } from '../logging/logger';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

vi.mock('./plan-queue-git', async (original) => ({
  ...await original<typeof import('./plan-queue-git')>(),
  branchExists: vi.fn(async () => true), unresolvedMergeFiles: vi.fn(async () => []),
  snapshotTree: vi.fn(async () => ({ head: 'checkpoint', status: [] })),
  revertToSnapshot: vi.fn(async () => undefined),
}));
vi.mock('./plan-queue-planning-files', async original => ({
  ...await original<typeof import('./plan-queue-planning-files')>(), describePlanningMoves: vi.fn(async () => null),
}));
vi.mock('./plan-queue-landing', async original => ({
  ...await original<typeof import('./plan-queue-landing')>(), syncItemWithBase: vi.fn(async () => ({ status: 'current' })),
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
    status: 'paused', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, checkBatchSize: 1, baseBranch: 'main' }, relaxation: null,
    workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null };
  item = newPlanQueueItem('item', run.id, join(directory, 'example_plan.md'), 1, {
    state: 'verifying', branchName: 'queue/example', worktreePath: directory, checkpointCommit: 'checkpoint', workerInstanceId: 'worker', verifierInstanceId: 'checker',
  });
  roles = new Map([['worker', { role: 'worker', runId: run.id, itemId: item.id }], ['checker', { role: 'verifier', runId: run.id, itemId: item.id }]]);
  host = {
    store: { listActiveRuns: () => [run], listItems: () => [item], listWorkspaceRoots: () => [directory],
      listRunsWithRelaxation: () => [] } as unknown as PlanQueueFlowHost['store'],
    history: { getPin: () => null, recordPinIfAbsent: vi.fn(), listEvents: () => [], listVerdicts: () => [] } as unknown as PlanQueueFlowHost['history'],
    checksAdmitted: () => true, setRunHold: vi.fn(),
    getRun: () => run, getItem: () => item,
    save: vi.fn((next) => (item = next)), transition: vi.fn((next, state, patch) => (item = { ...next, ...patch, state })),
    instances: { createInstance: vi.fn(async () => ({ id: 'fresh' })), sendInput: vi.fn(async () => undefined),
      restartFreshInstance: vi.fn(async () => undefined),
      terminateInstance: vi.fn(async () => undefined), getInstance: vi.fn((id: string) => ({ id, status: 'idle' as const, outputBuffer: [] })), getAllInstances: () => [] },
    worktrees: { checkpoint: vi.fn(async (next: PlanQueueItem) => (item = next)), reattach: vi.fn(async (next: PlanQueueItem) => next),
      cleanupScratchCopies: vi.fn(async () => undefined) } as unknown as PlanQueueFlowHost['worktrees'],
    tracker: { untrack: vi.fn(), track: vi.fn(), beginTurn: vi.fn(), isShuttingDown: vi.fn(() => false) } as unknown as PlanQueueFlowHost['tracker'],
    registerRole: (id, role) => { roles.set(id, role); }, unregisterRole: (id) => { roles.delete(id); }, roleOf: (id) => roles.get(id),
    notifyParent: vi.fn(), liveParentId: () => 'parent', resolveRunParent: () => 'parent', requestPump: vi.fn(), selectVerifier: vi.fn(), livetestPortsInUse: () => [],
  };
  writeFileSync(item.documentPath, '# Test plan\n');
  flow = new PlanQueueItemFlow(host);
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('paused runs never continue work or park it', () => {
  it('cleans abandoned check copies before reconciling and recovering jobs', async () => {
    const order: string[] = [];
    vi.mocked(host.worktrees.cleanupScratchCopies).mockImplementation(async roots => {
      expect(roots).toEqual([directory]); order.push('copies');
    });
    const recoveryHost = Object.assign(host, { refreshAlerts: async () => { order.push('reconcile'); },
      applyRelaxation: vi.fn(), restoreRelaxation: (saved: PlanQueueRun) => saved }) as PlanQueueRecoveryHost;
    await recoverPlanQueue(recoveryHost, flow);
    expect(order).toEqual(['copies', 'reconcile']);
  });

  it('reports a failed abandoned-copy cleanup and still recovers jobs', async () => {
    const warning = vi.spyOn(getLogger('PlanQueueRecovery'), 'warn');
    vi.mocked(host.worktrees.cleanupScratchCopies).mockRejectedValueOnce(new Error('Ownership read failed'));
    const recoveryHost = Object.assign(host, { refreshAlerts: vi.fn(async () => undefined),
      applyRelaxation: vi.fn(), restoreRelaxation: (saved: PlanQueueRun) => saved }) as PlanQueueRecoveryHost;
    await recoverPlanQueue(recoveryHost, flow);
    expect(warning).toHaveBeenCalledWith('Plan queue check-copy cleanup failed', { error: 'Ownership read failed' });
    expect(recoveryHost.refreshAlerts).toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'awaiting-slot', workerInstanceId: null, verifierInstanceId: null });
  });

  it.each(['park', 'hold'] as const)('sets aside a refused verifier restore without writes during %s', async action => {
    vi.spyOn(queueGit, 'isOwnCheckout').mockResolvedValue(true);
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new InvalidQueueCheckoutError());
    const remove = vi.fn(); Object.assign(host.worktrees, { removeWithProof: remove });
    if (action === 'hold') await expect(flow.hold(item.id)).resolves.toBeUndefined();
    else await expect(flow.park(item.id, 'cancelled', 'Run cancelled by James.')).resolves.toBeUndefined();
    expect(item).toMatchObject({ state: 'parked', parkReason: 'worktree-error', worktreePath: directory,
      workerInstanceId: null, verifierInstanceId: null, detail: expect.stringContaining('checkout is invalid') });
    if (action === 'park') expect(item.detail).toContain('Run cancelled by James.');
    expect(host.instances.terminateInstance).toHaveBeenCalledWith('worker', true);
    expect(host.instances.terminateInstance).toHaveBeenCalledWith('checker', true);
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it('sets aside a refused restore after the checker is closed while spawning', async () => {
    run.status = 'running';
    vi.spyOn(gitCommands, 'gitExec').mockResolvedValue('checkpoint');
    vi.mocked(host.instances.createInstance).mockRejectedValueOnce(new PlanQueueSpawnStoppedByUser('checker'));
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new Error('The saved queue checkout is invalid'));
    const snapshots = new Map();
    const forgetCheck = vi.fn();
    await expect(spawnQueueChecker({ host, snapshots, checkedBase: () => 'checkpoint', usageWaits: new PlanQueueUsageWaits(),
      prompt: async () => 'Review', hold: vi.fn(), select: vi.fn(), stop: id => flow.stopInstance(id),
      forgetCheck, erroredRound: vi.fn(), onVerifierOutcome: vi.fn() }, item, run, 'main', { provider: 'codex' })).resolves.toBeUndefined();
    expect(item).toMatchObject({ state: 'parked', parkReason: 'worktree-error', worktreePath: directory,
      workerInstanceId: null, verifierInstanceId: null, detail: expect.stringContaining('checkout is invalid') });
    expect(snapshots.size).toBe(0);
    expect(forgetCheck).toHaveBeenCalledWith(item.id);
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled();
    expect(host.instances.terminateInstance).toHaveBeenCalledWith('worker', true);
  });

  it('never checkpoints or removes a checkout whose restore failed when the checker finished', async () => {
    run = { ...run, status: 'running', config: { ...run.config, verifierGates: [] } };
    item = { ...item, state: 'awaiting-slot', verifierInstanceId: null };
    writeFileSync(join(directory, '.git'), 'gitdir: /checkout-metadata\n');
    vi.spyOn(gitCommands, 'gitExec').mockResolvedValue('checkpoint');
    vi.mocked(host.selectVerifier).mockResolvedValue({ ok: true, choice: { provider: 'codex' } });
    const remove = vi.fn(async () => ({ removed: false, reason: 'kept', detail: '' }));
    Object.assign(host.worktrees, { removeWithProof: remove });
    await flow.startVerification(item);
    expect(item.verifierInstanceId).toBe('fresh');
    flow.recordVerdict(item, 'fresh', fail);
    vi.mocked(queueGit.snapshotTree).mockResolvedValueOnce({ head: 'checker-changed-head', status: [] });
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new Error('Restore refused'));
    await flow.onVerifierOutcome('fresh', { kind: 'turn-complete', lastAssistantOutput: null });
    expect(item).toMatchObject({ state: 'parked', parkReason: 'worktree-error', worktreePath: directory,
      verifierInstanceId: null, workerInstanceId: null, detail: expect.stringContaining('Restore refused') });
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it('retains ownership and the original snapshot when a finished checker restore and worker stop both fail', async () => {
    run = { ...run, status: 'running', config: { ...run.config, verifierGates: [] } };
    item = { ...item, state: 'awaiting-slot', verifierInstanceId: null };
    writeFileSync(join(directory, '.git'), 'gitdir: /checkout-metadata\n');
    vi.spyOn(gitCommands, 'gitExec').mockResolvedValue('checkpoint');
    vi.mocked(host.selectVerifier).mockResolvedValue({ ok: true, choice: { provider: 'codex' } });
    const original = { head: 'before-checker', status: ['?? pre-existing-note.txt'] };
    vi.mocked(queueGit.snapshotTree).mockResolvedValueOnce(original);
    await flow.startVerification(item);
    flow.recordVerdict(item, 'fresh', fail);
    vi.mocked(queueGit.snapshotTree).mockResolvedValueOnce({ head: 'checker-changed-head', status: [] });
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new Error('Restore refused'));
    vi.mocked(host.instances.terminateInstance).mockImplementation(async id => {
      if (id === 'worker') throw new Error('worker stop failed');
    });
    await expect(flow.onVerifierOutcome('fresh', { kind: 'turn-complete', lastAssistantOutput: null })).rejects.toThrow('worker stop failed');
    expect(item).toMatchObject({ state: 'verifying', workerInstanceId: 'worker', worktreePath: directory });
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled();
    vi.mocked(host.instances.terminateInstance).mockResolvedValue(undefined);
    run.status = 'paused';
    await flow.hold(item.id);
    expect(queueGit.revertToSnapshot).toHaveBeenLastCalledWith(directory, original, run.workspaceCwd, item.branchName);
    expect(item).toMatchObject({ state: 'awaiting-slot', workerInstanceId: null, heldAt: expect.any(Number) });
  });

  it('does not count a checker startup failure after app shutdown begins', async () => {
    run.status = 'running';
    item = { ...item, verifierInstanceId: null };
    let savedAtShutdown: PlanQueueItem | undefined;
    vi.mocked(host.instances.createInstance).mockImplementationOnce(async () => {
      savedAtShutdown = structuredClone(item);
      vi.mocked(host.tracker.isShuttingDown).mockReturnValue(true);
      throw new Error('Plan Queue is shutting down');
    });
    const snapshots = new Map<string, queueGit.TreeSnapshot>();
    const erroredRound = vi.fn(async () => undefined);
    await spawnQueueChecker({ host, snapshots, checkedBase: () => 'checkpoint', usageWaits: new PlanQueueUsageWaits(),
      prompt: async () => 'Review', hold: vi.fn(), select: vi.fn(), stop: id => flow.stopInstance(id),
      forgetCheck: vi.fn(), erroredRound, onVerifierOutcome: vi.fn() }, item, run, 'main', { provider: 'codex' });
    expect(host.instances.createInstance).toHaveBeenCalledTimes(1);
    expect(erroredRound).not.toHaveBeenCalled();
    expect(item).toEqual(savedAtShutdown);
    expect(snapshots.size).toBe(0);
    expect(host.requestPump).not.toHaveBeenCalled();
  });

  it('handles a failed checker startup whose outcome cannot stop the checker, then lets Pause retry', async () => {
    const warning = vi.spyOn(getLogger('PlanQueueCheckerSpawn'), 'warn');
    run.status = 'running';
    vi.spyOn(gitCommands, 'gitExec').mockResolvedValue('checkpoint');
    const ready = Promise.reject(new Error('startup failed'));
    void ready.catch(() => undefined);
    vi.mocked(host.instances.createInstance).mockResolvedValueOnce({ id: 'fresh', ...{ readyPromise: ready } });
    vi.mocked(host.instances.terminateInstance).mockRejectedValueOnce(new Error('checker stop failed'));
    await spawnQueueChecker({ host, snapshots: new Map(), checkedBase: () => 'checkpoint', usageWaits: new PlanQueueUsageWaits(),
      prompt: async () => 'Review', hold: vi.fn(), select: vi.fn(), stop: id => flow.stopInstance(id),
      forgetCheck: vi.fn(), erroredRound: vi.fn(), onVerifierOutcome: (id, outcome) => flow.onVerifierOutcome(id, outcome) }, item, run, 'main', { provider: 'codex' });
    await flow.whenSettled();
    await new Promise(resolve => setImmediate(resolve));
    expect(warning).toHaveBeenCalledWith('Plan queue: handling checker startup failure failed', expect.objectContaining({ instanceId: 'fresh', error: 'checker stop failed' }));
    expect(item).toMatchObject({ state: 'verifying', verifierInstanceId: 'fresh' });
    run.status = 'paused';
    await flow.hold(item.id);
    expect(item).toMatchObject({ state: 'awaiting-slot', verifierInstanceId: null, heldAt: expect.any(Number) });
  });

  it('retries a transient hold restore against the exact original checker snapshot', async () => {
    run = { ...run, status: 'running', config: { ...run.config, verifierGates: [] } };
    item = { ...item, state: 'awaiting-slot', verifierInstanceId: null };
    writeFileSync(join(directory, '.git'), 'gitdir: /checkout-metadata\n');
    vi.spyOn(gitCommands, 'gitExec').mockResolvedValue('checkpoint');
    vi.mocked(host.selectVerifier).mockResolvedValue({ ok: true, choice: { provider: 'codex' } });
    const original = { head: 'before-checker', status: ['?? pre-existing-note.txt'] };
    vi.mocked(queueGit.snapshotTree).mockResolvedValueOnce(original);
    await flow.startVerification(item);
    run.status = 'paused';
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new Error('Temporary restore error'));
    await expect(flow.hold(item.id)).rejects.toThrow('Temporary restore error');
    expect(item).toMatchObject({ state: 'verifying', verifierInstanceId: 'fresh' });
    vi.mocked(queueGit.snapshotTree).mockResolvedValueOnce({ head: 'different-checkpoint', status: [] });
    await flow.hold(item.id);
    expect(vi.mocked(queueGit.revertToSnapshot).mock.calls.slice(-2).map(call => call[1])).toEqual([original, original]);
    expect(item).toMatchObject({ state: 'awaiting-slot', heldAt: expect.any(Number), parkReason: null });
  });

  it('keeps the pending fix instruction when a paused checker cannot be restored', async () => {
    item = { ...item, verdict: fail, round: 1 };
    vi.spyOn(queueGit, 'isOwnCheckout').mockResolvedValue(true);
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new InvalidQueueCheckoutError());
    await flow.hold(item.id);
    expect(item.pendingInstruction).toContain('Fix missing guard');
    expect(item.detail).toMatch(/^Paused\. Could not restore/);
  });

  it('keeps ownership and avoids restoration when a cancel cannot stop the checker', async () => {
    const forgotten = vi.spyOn(PlanQueueVerification.prototype, 'forgetCheck');
    vi.mocked(host.instances.terminateInstance).mockImplementation(async id => { if (id === 'checker') throw new Error('Stop refused'); });
    await expect(flow.park(item.id, 'cancelled', 'Run cancelled by James.')).rejects.toThrow('Stop refused');
    expect(item).toMatchObject({ state: 'verifying', verifierInstanceId: 'checker', workerInstanceId: 'worker' });
    expect(queueGit.revertToSnapshot).not.toHaveBeenCalled();
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled();
    expect(forgotten).not.toHaveBeenCalled();
  });

  it('retains the checker snapshot and worker ownership if stopping the worker fails after a refused spawn restore', async () => {
    run.status = 'running';
    vi.spyOn(gitCommands, 'gitExec').mockResolvedValue('checkpoint');
    vi.mocked(host.instances.createInstance).mockRejectedValueOnce(new PlanQueueSpawnStoppedByUser('checker'));
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new Error('Restore refused'));
    vi.mocked(host.instances.terminateInstance).mockImplementation(async id => { if (id === 'worker') throw new Error('Worker stop refused'); });
    const snapshots = new Map();
    const forgetCheck = vi.fn();
    await expect(spawnQueueChecker({ host, snapshots, checkedBase: () => 'checkpoint', usageWaits: new PlanQueueUsageWaits(),
      prompt: async () => 'Review', hold: vi.fn(), select: vi.fn(), stop: id => flow.stopInstance(id),
      forgetCheck, erroredRound: vi.fn(), onVerifierOutcome: vi.fn() }, item, run, 'main', { provider: 'codex' })).rejects.toThrow('Worker stop refused');
    expect(item).toMatchObject({ state: 'verifying', workerInstanceId: 'worker' });
    expect(snapshots.has(item.id)).toBe(true);
    expect(forgetCheck).not.toHaveBeenCalled();
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled();
  });
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
  it('tells a held fixing worker where its moved planning files went, as the normal fix path does', async () => {
    vi.mocked(describePlanningMoves).mockResolvedValue('notes_history.md is now at /root/notes_history.md\nEdit planning files at those root paths, not in your worktree.');
    item = { ...item, state: 'fixing', verdict: fail, verifierInstanceId: null, round: 1 };
    await flow.hold(item.id);
    expect(describePlanningMoves).toHaveBeenCalledWith(directory, item.id);
    expect(item.pendingInstruction).toContain('notes_history.md is now at /root/notes_history.md');
    run.status = 'running';
    await flow.startItem(item);
    expect(host.instances.createInstance).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: expect.stringContaining('Edit planning files at those root paths') }));
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

  it('handles a failed reminder whose outcome cannot stop the checker, then lets Pause retry', async () => {
    const warning = vi.spyOn(getLogger('PlanQueueItemFlow'), 'warn');
    run.status = 'running';
    vi.mocked(host.instances.sendInput).mockRejectedValueOnce(new Error('reminder failed'));
    vi.mocked(host.instances.terminateInstance).mockRejectedValueOnce(new Error('checker stop failed'));
    await flow.onVerifierOutcome('checker', { kind: 'turn-complete', lastAssistantOutput: null });
    await flow.whenSettled();
    await new Promise(resolve => setImmediate(resolve));
    expect(warning).toHaveBeenCalledWith('Plan queue: handling checker reminder failure failed', expect.objectContaining({ instanceId: 'checker', error: 'checker stop failed' }));
    expect(item).toMatchObject({ state: 'verifying', verifierInstanceId: 'checker' });
    run.status = 'paused';
    await flow.hold(item.id);
    expect(item).toMatchObject({ state: 'awaiting-slot', verifierInstanceId: null, heldAt: expect.any(Number) });
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
      store: { listRunsWithRelaxation: () => [], listActiveRuns: () => [run], listItems: () => [item], listWorkspaceRoots: () => [directory] },
      refreshAlerts: vi.fn(), applyRelaxation: vi.fn(), restoreRelaxation: (r: PlanQueueRun) => r,
    }) as unknown as PlanQueueRecoveryHost;
    await recoverPlanQueue(recoveryHost, flow);
    expect(host.instances.createInstance).not.toHaveBeenCalled();
    expect(host.worktrees.reattach).not.toHaveBeenCalled();
    expect(item).toMatchObject({ state: 'queued', workerInstanceId: null, parkReason: null, heldAt: expect.any(Number) });
  });

  it.each([null, 'worker'])('sets aside an unsafe interrupted check and stops retained worker %s', async workerInstanceId => {
    run.status = 'running'; item = { ...item, workerInstanceId };
    host.history.recordEvent = vi.fn();
    vi.spyOn(queueGit, 'isOwnCheckout').mockResolvedValueOnce(true);
    vi.mocked(queueGit.revertToSnapshot).mockRejectedValueOnce(new Error('The saved queue checkout is invalid'));
    const recoveryHost = Object.assign(host, {
      store: { listRunsWithRelaxation: () => [], listActiveRuns: () => [run], listItems: () => [item], listWorkspaceRoots: () => [directory] },
      refreshAlerts: vi.fn(), applyRelaxation: vi.fn(), restoreRelaxation: (r: PlanQueueRun) => r,
    }) as unknown as PlanQueueRecoveryHost;
    await recoverPlanQueue(recoveryHost, flow);
    expect(item).toMatchObject({ state: 'parked', parkReason: 'worktree-error', verifierInstanceId: null, workerInstanceId: null,
      worktreePath: directory, detail: expect.stringContaining('The saved queue checkout is invalid') });
    expect(host.instances.terminateInstance).toHaveBeenCalledWith('checker', true);
    if (workerInstanceId) expect(host.instances.terminateInstance).toHaveBeenCalledWith(workerInstanceId, true);
    expect(host.worktrees.checkpoint).not.toHaveBeenCalled();
    expect(host.instances.createInstance).not.toHaveBeenCalled();
  });

  it('keeps ownership of a checking session that cannot be stopped after restart', async () => {
    run.status = 'running'; item = { ...item, workerInstanceId: null };
    host.history.recordEvent = vi.fn();
    vi.mocked(host.instances.terminateInstance).mockRejectedValueOnce(new Error('checker stop failed'));
    const recoveryHost = Object.assign(host, {
      store: { listRunsWithRelaxation: () => [], listActiveRuns: () => [run], listItems: () => [item], listWorkspaceRoots: () => [directory] },
      refreshAlerts: vi.fn(), applyRelaxation: vi.fn(), restoreRelaxation: (r: PlanQueueRun) => r,
    }) as unknown as PlanQueueRecoveryHost;
    await recoverPlanQueue(recoveryHost, flow);
    expect(item).toMatchObject({ state: 'verifying', verifierInstanceId: 'checker' });
    expect(queueGit.revertToSnapshot).not.toHaveBeenCalled();
    expect(host.instances.createInstance).not.toHaveBeenCalled();
  });
});
