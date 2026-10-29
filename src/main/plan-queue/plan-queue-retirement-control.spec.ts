import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import * as queueLanding from './plan-queue-landing';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

class Instances extends EventEmitter {
  live = new Map<string, PlanQueueInstanceRecord>();
  created: InstanceCreateConfig[] = [];
  sendInput = vi.fn(async () => undefined);
  terminateInstance = vi.fn(async (id: string) => { this.live.delete(id); });
  getInstance = (id: string) => this.live.get(id);
  getAllInstances = () => [...this.live.values()];
  adoptOrphanInstance = () => false;
  async createInstance(config: InstanceCreateConfig) {
    this.created.push(config);
    const id = `new-${this.created.length}`;
    this.live.set(id, { id, status: 'busy', outputBuffer: [], provider: config.provider, metadata: config.metadata });
    return { id };
  }
}

let repo: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let instances: Instances;
let coordinator: PlanQueueCoordinator;
let run: PlanQueueRun;
let item: PlanQueueItem;
const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Every test drives real git (worktree, checkpoint, squash landing), so the
// default 5s test / 1s waitFor budgets fail under a loaded full-suite run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const waitBudget = { timeout: 10_000 };

beforeEach(() => {
  PlanQueueCoordinator._resetForTesting(); GitWriteQueue._resetForTesting();
  repo = mkdtempSync(join(tmpdir(), 'queue-pause-control-'));
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'feature.txt'), 'base\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  const worktreePath = join(repo, '.worktrees', 'queue', 'example');
  mkdirSync(join(repo, '.worktrees', 'queue'), { recursive: true });
  git(['worktree', 'add', '-qb', 'queue/example', worktreePath]);
  db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db); store = new PlanQueueStore(db);
  run = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo, status: 'running',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', routing: { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'codex' }] }, startingSessionRoute: { provider: 'claude' } },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null };
  item = newPlanQueueItem('item', run.id, join(repo, 'example_plan.md'), 1, {
    state: 'working', branchName: 'queue/example', worktreePath, checkpointCommit: git(['rev-parse', 'HEAD']), workerInstanceId: 'worker',
  });
  writeFileSync(item.documentPath, '# Active plan\n'); store.upsertRun(run); store.upsertItem(item);
  instances = new Instances();
  instances.live.set('parent', { id: 'parent', status: 'idle', outputBuffer: [], provider: 'claude', workingDirectory: repo });
  instances.live.set('worker', { id: 'worker', status: 'busy', outputBuffer: [], provider: 'claude' });
  coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({ store, instances, skipInstall: true, pumpIntervalMs: null, loadAverage: () => [0, 0, 0],
    worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] },
    selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
    routing: { readSaved: () => ({ workers: [], verifiers: [] }), readAccountRules: () => ({ never: [], last: [] }), copilotProfileFor: () => null, poolProfiles: () => [], copilotProfiles: () => [],
      defaultProvider: () => null, checkerScopeKind: () => 'none', isProviderExcluded: () => false, listInstalledProviders: async () => ['claude', 'codex', 'cursor'] },
  });
  coordinator.registerRole('worker', { role: 'worker', runId: run.id, itemId: item.id });
});

afterEach(async () => {
  coordinator.shutdown(); await coordinator._whenSettledForTesting();
  vi.restoreAllMocks();
  db.close(); rmSync(repo, { recursive: true, force: true });
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function outcome(id: string, role: 'worker' | 'verifier' | 'triage') {
  coordinator.registerRole(id, role === 'triage' ? { role, runId: run.id } : { role, runId: run.id, itemId: item.id });
  coordinator.tracker.track(id);
  instances.emit('instance:event', { instanceId: id, event: { kind: 'status_changed', status: 'error' } });
}

function control(action: 'pause' | 'move' | 'cancel') {
  return action === 'move'
    ? coordinator.control({ action: 'set-routing', runId: run.id, routing: {
      workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'codex' }],
    }, moveInProgress: true })
    : coordinator.control({ action, runId: run.id });
}

it.each(['pause', 'move', 'cancel'] as const)('%s waits for checker outcome retirement before touching its tree', async action => {
  store.upsertItem({ ...item, state: 'verifying', verifierInstanceId: 'checker' });
  instances.live.set('checker', { id: 'checker', status: 'busy', outputBuffer: [] });
  const gate = deferred();
  instances.terminateInstance.mockImplementation(async id => { if (id === 'checker') await gate.promise; instances.live.delete(id); });
  const checkpoint = vi.spyOn(coordinator.worktrees, 'checkpoint');
  const remove = vi.spyOn(coordinator.worktrees, 'removeWithProof');
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  outcome('checker', 'verifier');
  await vi.waitFor(() => expect(instances.terminateInstance).toHaveBeenCalledWith('checker', true), waitBudget);
  writeFileSync(join(item.worktreePath!, 'feature.txt'), 'checker still writing\n');
  let settled = false;
  const controlling = control(action).then(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'), waitBudget);
    await tick();
    expect(settled).toBe(false);
    expect(store.getItem(item.id)).toMatchObject({ state: 'verifying', verifierInstanceId: 'checker', erroredRounds: 0 });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(readFileSync(join(item.worktreePath!, 'feature.txt'), 'utf8')).toBe('checker still writing\n');
    expect(instances.created).toEqual([]);
    gate.release();
    await controlling;
    expect(instances.live.has('checker')).toBe(false);
    expect(store.getRun(run.id)?.status).toBe(action === 'move' ? 'running' : action === 'cancel' ? 'cancelled' : 'paused');
    expect(git(['show', 'queue/example:feature.txt'])).toBe('base');
  } finally { gate.release(); await controlling; }
});

it.each(['resume', 'cancel'] as const)('retains an already failed checker retirement through failed Pause and Resume until %s succeeds', async finish => {
  store.upsertItem({ ...item, state: 'verifying', verifierInstanceId: 'checker' });
  instances.live.set('checker', { id: 'checker', status: 'busy', outputBuffer: [] });
  instances.terminateInstance.mockImplementation(async id => { if (id === 'checker') throw new Error('checker cleanup failed'); instances.live.delete(id); });
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  const checkpoint = vi.spyOn(coordinator.worktrees, 'checkpoint');
  outcome('checker', 'verifier');
  await coordinator._whenSettledForTesting();
  writeFileSync(join(item.worktreePath!, 'feature.txt'), 'checker uncommitted edit\n');
  await expect(control('pause')).rejects.toThrow('checker cleanup failed');
  await expect(coordinator.control({ action: 'resume', runId: run.id })).rejects.toThrow('checker cleanup failed');
  expect(store.getRun(run.id)?.status).toBe('paused');
  expect(store.getItem(item.id)).toMatchObject({ state: 'verifying', verifierInstanceId: 'checker', erroredRounds: 0 });
  expect(checkpoint).not.toHaveBeenCalled();
  expect(instances.created).toEqual([]);
  expect(readFileSync(join(item.worktreePath!, 'feature.txt'), 'utf8')).toBe('checker uncommitted edit\n');
  instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
  await coordinator.control({ action: finish, runId: run.id });
  expect(instances.live.has('checker')).toBe(false);
  expect(store.getItem(item.id)).toMatchObject({ state: finish === 'cancel' ? 'parked' : 'awaiting-slot', verifierInstanceId: null, erroredRounds: 0 });
  expect(git(['show', 'queue/example:feature.txt'])).toBe('base');
});

it('Cancel waits for a failed worker outcome retirement before checkpointing', async () => {
  const gate = deferred();
  instances.terminateInstance.mockImplementation(async id => { if (id === 'worker') await gate.promise; instances.live.delete(id); });
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  const checkpoint = vi.spyOn(coordinator.worktrees, 'checkpoint');
  outcome('worker', 'worker');
  await vi.waitFor(() => expect(instances.terminateInstance).toHaveBeenCalledWith('worker', true), waitBudget);
  let settled = false;
  const cancelling = control('cancel').then(() => { settled = true; });
  try {
    await tick();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    gate.release();
    await cancelling;
    expect(instances.live.has('worker')).toBe(false);
  } finally { gate.release(); await cancelling; }
});

it('Pause waits for retirement started by a triage outcome and retries a completed failure', async () => {
  store.upsertItem({ ...item, state: 'discovered', branchName: null, worktreePath: null, workerInstanceId: null });
  coordinator.requestPump();
  await vi.waitFor(() => expect(instances.created.some(config => config.metadata?.['planQueueRole'] === 'triage')).toBe(true), waitBudget);
  const triage = [...instances.live.values()].find(session => session.metadata?.['planQueueRole'] === 'triage')!;
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  const gate = deferred();
  let failing = true;
  instances.terminateInstance.mockImplementation(async id => {
    if (id === triage.id) { await gate.promise; if (failing) throw new Error('triage outcome cleanup failed'); }
    instances.live.delete(id);
  });
  outcome(triage.id, 'triage');
  await vi.waitFor(() => expect(instances.terminateInstance).toHaveBeenCalledWith(triage.id, true), waitBudget);
  let settled = false;
  const pausing = control('pause').then(() => { settled = true; });
  const rejected = expect(pausing).rejects.toThrow('triage outcome cleanup failed');
  try {
    await tick();
    expect(settled).toBe(false);
    gate.release();
    await rejected;
    await expect(coordinator.control({ action: 'resume', runId: run.id })).rejects.toThrow('triage outcome cleanup failed');
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(instances.live.has(triage.id)).toBe(true);
    failing = false;
    await coordinator.control({ action: 'resume', runId: run.id });
    expect(instances.live.has(triage.id)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('running');
  } finally { gate.release(); await pausing.catch(() => undefined); await rejected; }
});

it('Pause does not lose the old worker when sendInput fails before replacement', async () => {
  store.upsertItem({ ...item, state: 'working', question: { question: 'Continue?', options: [{ id: 'continue', label: 'Continue' }] } });
  const gate = deferred();
  let failing = true;
  instances.sendInput.mockImplementation(async () => { throw new Error('worker send failed'); });
  instances.terminateInstance.mockImplementation(async id => {
    if (id === 'worker') { await gate.promise; if (failing) throw new Error('old worker stop failed'); }
    instances.live.delete(id);
  });
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  const answering = coordinator.answer(item.id, 'continue').catch(error => error);
  await vi.waitFor(() => expect(instances.terminateInstance).toHaveBeenCalledWith('worker', true), waitBudget);
  const pausing = control('pause');
  const rejected = expect(pausing).rejects.toThrow('old worker stop failed');
  try {
    await tick();
    expect(instances.created).toEqual([]);
    gate.release();
    await rejected;
    expect(await answering).toBeInstanceOf(Error);
    expect(store.getItem(item.id)).toMatchObject({ workerInstanceId: 'worker', pendingInstruction: expect.stringContaining('carry on') });
    expect(store.getRun(run.id)?.status).toBe('paused');
    failing = false;
    await coordinator.control({ action: 'resume', runId: run.id });
    expect(instances.live.has('worker')).toBe(false);
  } finally { gate.release(); await answering; await pausing.catch(() => undefined); await rejected; }
});

it('keeps scheduling and completion blocked after a triage outcome stop has already failed', async () => {
  store.upsertItem({ ...item, state: 'discovered', branchName: null, worktreePath: null, workerInstanceId: null });
  coordinator.requestPump();
  await vi.waitFor(() => expect(instances.created.some(config => config.metadata?.['planQueueRole'] === 'triage')).toBe(true), waitBudget);
  const triage = [...instances.live.values()].find(session => session.metadata?.['planQueueRole'] === 'triage')!;
  instances.terminateInstance.mockImplementation(async id => {
    if (id === triage.id) throw new Error('completed triage stop failure');
    instances.live.delete(id);
  });
  outcome(triage.id, 'triage');
  await tick();
  store.upsertItem({ ...store.getItem(item.id)!, state: 'queued' });
  const prepare = vi.spyOn(coordinator.worktrees, 'prepare');
  coordinator.requestPump();
  await coordinator._whenSettledForTesting();
  expect(instances.created).toHaveLength(1);
  expect(prepare).not.toHaveBeenCalled();
  store.upsertItem({ ...store.getItem(item.id)!, state: 'skipped' });
  coordinator.requestPump();
  await coordinator._whenSettledForTesting();
  expect(store.getRun(run.id)?.status).toBe('running');
  await expect(control('pause')).rejects.toThrow('completed triage stop failure');
  expect(store.getRun(run.id)?.status).toBe('paused');
  instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
  await control('cancel');
  expect(instances.live.has(triage.id)).toBe(false);
  expect(store.getRun(run.id)?.status).toBe('cancelled');
});

it('preserves a spawned checker snapshot through failed cleanup and restores it on Resume', async () => {
  store.upsertItem({ ...item, state: 'awaiting-slot' });
  writeFileSync(join(item.worktreePath!, 'worker-untracked.txt'), 'worker snapshot\n');
  coordinator.requestPump();
  await vi.waitFor(() => expect(store.getItem(item.id)?.verifierInstanceId).toBeTruthy(), waitBudget);
  const checkerId = store.getItem(item.id)!.verifierInstanceId!;
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  coordinator.reportVerdict(checkerId, { item_id: item.id, verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [] });
  instances.terminateInstance.mockImplementation(async id => {
    if (id === checkerId) throw new Error('spawned checker stop failure');
    instances.live.delete(id);
  });
  writeFileSync(join(item.worktreePath!, 'checker-untracked.txt'), 'checker edit\n');
  outcome(checkerId, 'verifier');
  await coordinator._whenSettledForTesting();
  await expect(control('pause')).rejects.toThrow('spawned checker stop failure');
  expect(store.getItem(item.id)).toMatchObject({ state: 'verifying', verifierInstanceId: checkerId, round: 0 });
  instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
  await coordinator.control({ action: 'resume', runId: run.id });
  expect(store.getItem(item.id)).toMatchObject({ state: 'awaiting-slot', verifierInstanceId: null, round: 0, erroredRounds: 0 });
  expect(readFileSync(join(item.worktreePath!, 'worker-untracked.txt'), 'utf8')).toBe('worker snapshot\n');
  expect(existsSync(join(item.worktreePath!, 'checker-untracked.txt'))).toBe(false);
});

it.each([false, true])('keeps an all-skipped run operational until active triage cleanup succeeds (failure=%s)', async fail => {
  store.upsertItem({ ...item, state: 'discovered', branchName: null, worktreePath: null, workerInstanceId: null });
  coordinator.requestPump();
  await vi.waitFor(() => expect(instances.created.some(config => config.metadata?.['planQueueRole'] === 'triage')).toBe(true), waitBudget);
  const triage = [...instances.live.values()].find(session => session.metadata?.['planQueueRole'] === 'triage')!;
  const gate = deferred();
  instances.terminateInstance.mockImplementation(async id => {
    if (id === triage.id) { await gate.promise; if (fail) throw new Error('active triage stop failed'); }
    instances.live.delete(id);
  });
  coordinator.reportTriage(triage.id, { run_id: run.id, records: [
    { documentPath: item.documentPath, disposition: 'skip', reason: 'no work needed' },
  ] });
  await vi.waitFor(() => expect(instances.terminateInstance).toHaveBeenCalledWith(triage.id, true), waitBudget);
  try {
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(instances.live.has(triage.id)).toBe(true);
    gate.release();
    await coordinator._whenSettledForTesting();
    if (fail) {
      expect(store.getRun(run.id)?.status).toBe('running');
      await expect(control('pause')).rejects.toThrow('active triage stop failed');
      expect(store.getRun(run.id)?.status).toBe('paused');
      instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
      await control('cancel');
    }
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe(fail ? 'cancelled' : 'completed'), waitBudget);
    expect(instances.live.has(triage.id)).toBe(false);
  } finally { gate.release(); await coordinator._whenSettledForTesting(); }
});

it.each([false, true])('waits for invalidated in-flight triage cleanup before completing an all-skipped run (failure=%s)', async fail => {
  store.upsertItem({ ...item, state: 'discovered', branchName: null, worktreePath: null, workerInstanceId: null });
  const spawn = deferred();
  const stop = deferred();
  const create = instances.createInstance.bind(instances);
  let triageId: string | undefined;
  vi.spyOn(instances, 'createInstance').mockImplementation(async config => {
    const created = await create(config);
    triageId = created.id;
    await spawn.promise;
    return created;
  });
  instances.terminateInstance.mockImplementation(async id => { await stop.promise; if (fail) throw new Error('in-flight triage stop failed'); instances.live.delete(id); });
  coordinator.requestPump();
  await vi.waitFor(() => expect(triageId).toBeDefined(), waitBudget);
  try {
    await coordinator.control({ action: 'skip-item', itemId: item.id });
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('running');
    spawn.release();
    await vi.waitFor(() => expect(instances.terminateInstance).toHaveBeenCalledWith(triageId, true), waitBudget);
    expect(store.getRun(run.id)?.status).toBe('running');
    stop.release();
    await tick();
    if (fail) {
      expect(store.getRun(run.id)?.status).toBe('running');
      await expect(control('pause')).rejects.toThrow('in-flight triage stop failed');
      expect(store.getRun(run.id)?.status).toBe('paused');
      instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
      await coordinator.control({ action: 'resume', runId: run.id });
    }
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('completed'), waitBudget);
    expect(instances.live.has(triageId!)).toBe(false);
  } finally { spawn.release(); stop.release(); await coordinator._whenSettledForTesting(); }
});

it.each(['pause', 'cancel'] as const)('%s cannot overtake cleanup initiated by terminal triage reports', async action => {
  store.upsertItem({ ...item, state: 'discovered', branchName: null, worktreePath: null, workerInstanceId: null });
  coordinator.requestPump();
  await vi.waitFor(() => expect(instances.created.some(config => config.metadata?.['planQueueRole'] === 'triage')).toBe(true), waitBudget);
  const triage = [...instances.live.values()].find(session => session.metadata?.['planQueueRole'] === 'triage')!;
  const stop = deferred();
  instances.terminateInstance.mockImplementation(async id => { if (id === triage.id) await stop.promise; instances.live.delete(id); });
  coordinator.reportTriage(triage.id, { run_id: run.id, records: [
    { documentPath: item.documentPath, disposition: 'skip', reason: 'no work needed' },
  ] });
  await vi.waitFor(() => expect(instances.terminateInstance).toHaveBeenCalledWith(triage.id, true), waitBudget);
  let settled = false;
  const controlling = control(action).then(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'), waitBudget);
    await tick();
    expect(settled).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('paused');
    stop.release();
    await controlling;
    expect(instances.live.has(triage.id)).toBe(false);
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe(action === 'cancel' ? 'cancelled' : 'completed');
  } finally { stop.release(); await controlling; }
});

async function normalPassLanding(withSibling = true) {
  const retirementStarted = deferred();
  const retire = instances.terminateInstance.getMockImplementation()!;
  instances.terminateInstance.mockImplementation((...args) => {
    if (args[0] === 'worker') retirementStarted.release();
    return retire(...args);
  });
  if (withSibling) {
    const waiting = join(repo, 'waiting_plan.md');
    writeFileSync(waiting, '# Waiting for James\n');
    store.upsertItem(newPlanQueueItem('waiting', run.id, waiting, 2, { state: 'needs-answer' }));
  }
  writeFileSync(join(item.worktreePath!, 'feature.txt'), 'worker completed work\n');
  instances.live.set('worker', { id: 'worker', status: 'idle', provider: 'claude',
    outputBuffer: [{ type: 'assistant', content: 'Implemented the work.' }] });
  coordinator.tracker.track('worker');
  await vi.waitFor(() => expect(store.getItem(item.id)?.verifierInstanceId).toBeTruthy(), waitBudget);
  const checker = store.getItem(item.id)!.verifierInstanceId!;
  coordinator.reportVerdict(checker, { item_id: item.id, verdict: 'PASS', findings: [], gates_run: [], document_complete: false, need_james: [] });
  instances.emit('provider:normalized-event', { instanceId: checker, event: { kind: 'output', messageType: 'assistant', content: 'Verified PASS.' } });
  instances.emit('instance:event', { instanceId: checker, event: { kind: 'status_changed', status: 'idle' } });
  await retirementStarted.promise;
  expect(instances.terminateInstance).toHaveBeenCalledWith('worker', true);
  expect(store.getItem(item.id)).toMatchObject({ state: 'landed', verdict: { verdict: 'PASS' }, workerInstanceId: 'worker' });
  expect(git(['show', 'main:feature.txt'])).toBe('worker completed work');
  return git(['rev-parse', 'main']);
}

it.each(['pause', 'move', 'cancel'] as const)('%s waits for normal PASS landing retirement without removing a live worker tree', async action => {
  const stop = deferred();
  instances.terminateInstance.mockImplementation(async id => { if (id === 'worker') await stop.promise; instances.live.delete(id); });
  let controlling: Promise<void> | undefined;
  try {
    const landedCommit = await normalPassLanding();
    const checkpoint = vi.spyOn(coordinator.worktrees, 'checkpoint');
    let settled = false;
    controlling = control(action).then(() => { settled = true; });
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'), waitBudget);
    await tick();
    expect(settled).toBe(false);
    expect(instances.live.has('worker')).toBe(true);
    expect(existsSync(item.worktreePath!)).toBe(true);
    expect(git(['branch', '--list', 'queue/example'])).toContain('queue/example');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(instances.created).toHaveLength(1);
    stop.release();
    await controlling;
    await coordinator._whenSettledForTesting();
    expect(instances.live.has('worker')).toBe(false);
    expect(store.getItem(item.id)).toMatchObject({ state: 'landed', workerInstanceId: null, verifierInstanceId: null, landedCommit, branchName: null, worktreePath: null });
    expect(git(['rev-parse', 'main'])).toBe(landedCommit);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(store.getRun(run.id)?.status).toBe(action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'running');
  } finally { stop.release(); await controlling; }
});

it.each(['resume', 'cancel'] as const)('retains failed normal landing cleanup for Pause/Resume/Cancel/move until %s succeeds without remerging', async finish => {
  instances.terminateInstance.mockImplementation(async id => {
    if (id === 'worker') throw new Error('landed worker stop failed');
    instances.live.delete(id);
  });
  const landedCommit = await normalPassLanding();
  await coordinator._whenSettledForTesting();
  const checkpoint = vi.spyOn(coordinator.worktrees, 'checkpoint');
  await expect(control('move')).rejects.toThrow('landed worker stop failed');
  await expect(control('pause')).rejects.toThrow('landed worker stop failed');
  await expect(coordinator.control({ action: 'resume', runId: run.id })).rejects.toThrow('landed worker stop failed');
  await expect(control('cancel')).rejects.toThrow('landed worker stop failed');
  expect(store.getRun(run.id)?.status).toBe('paused');
  expect(store.getItem(item.id)).toMatchObject({ state: 'landed', workerInstanceId: 'worker', landedCommit });
  expect(existsSync(item.worktreePath!)).toBe(true);
  expect(checkpoint).not.toHaveBeenCalled();
  expect(git(['rev-parse', 'main'])).toBe(landedCommit);
  instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
  await coordinator.control({ action: finish, runId: run.id });
  await coordinator._whenSettledForTesting();
  expect(store.getItem(item.id)).toMatchObject({ state: 'landed', workerInstanceId: null, landedCommit });
  expect(git(['rev-parse', 'main'])).toBe(landedCommit);
  expect(git(['rev-list', '--count', `${item.checkpointCommit}..main`])).toBe('1');
  expect(checkpoint).not.toHaveBeenCalled();
});

it('does not auto-end or schedule another item while a normal landed worker cleanup is unfinished', async () => {
  const stop = deferred();
  let failing = true;
  instances.terminateInstance.mockImplementation(async id => {
    if (id === 'worker') { await stop.promise; if (failing) throw new Error('landing final stop failed'); }
    instances.live.delete(id);
  });
  try {
    const landedCommit = await normalPassLanding(false);
    coordinator.requestPump();
    await tick();
    expect(store.getRun(run.id)?.status).toBe('running');
    stop.release();
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('running');
    store.upsertItem(newPlanQueueItem('next', run.id, join(repo, 'next_plan.md'), 2, { state: 'queued' }));
    const prepare = vi.spyOn(coordinator.worktrees, 'prepare');
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(prepare).not.toHaveBeenCalled();
    await expect(control('pause')).rejects.toThrow('landing final stop failed');
    store.upsertItem({ ...store.getItem('next')!, state: 'skipped' });
    failing = false;
    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(instances.live.has('worker')).toBe(false);
    expect(git(['rev-parse', 'main'])).toBe(landedCommit);
  } finally { stop.release(); await coordinator._whenSettledForTesting(); }
});

it('recovers active landed cleanup with a stale instance ID without changing the promoted commit', async () => {
  instances.terminateInstance.mockImplementation(async id => { if (id === 'worker') throw new Error('landing stop unavailable'); instances.live.delete(id); });
  const landedCommit = await normalPassLanding();
  await coordinator._whenSettledForTesting();
  instances.live.delete('worker'); // The process did not survive the restart.
  const checkpoint = vi.spyOn(coordinator.worktrees, 'checkpoint');
  await coordinator.recover();
  await coordinator._whenSettledForTesting();
  expect(store.getItem(item.id)).toMatchObject({ state: 'landed', workerInstanceId: null, landedCommit });
  expect(git(['rev-parse', 'main'])).toBe(landedCommit);
  expect(checkpoint).not.toHaveBeenCalled();
});

it('Cancel arriving during Git promotion retries a subsequent failed landed-worker stop', async () => {
  const promotion = deferred();
  const promote = queueLanding.landItemBranch;
  let entering = false;
  vi.spyOn(queueLanding, 'landItemBranch').mockImplementationOnce(async (...args) => {
    entering = true;
    await promotion.promise;
    return promote(...args);
  });
  instances.terminateInstance.mockImplementation(async id => {
    if (id === 'worker') throw new Error('worker stop after promotion failed');
    instances.live.delete(id);
  });
  const landing = normalPassLanding();
  let cancelling: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(entering).toBe(true), waitBudget);
    expect(store.getItem(item.id)?.state).toBe('landing');
    cancelling = control('cancel');
    const rejected = expect(cancelling).rejects.toThrow('worker stop after promotion failed');
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'), waitBudget);
    promotion.release();
    const landedCommit = await landing;
    await rejected;
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(store.getItem(item.id)).toMatchObject({ state: 'landed', workerInstanceId: 'worker', landedCommit });
    instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
    await control('cancel');
    expect(git(['rev-parse', 'main'])).toBe(landedCommit);
    expect(instances.live.has('worker')).toBe(false);
  } finally { promotion.release(); await landing; await cancelling?.catch(() => undefined); }
});

it('keeps late worker edits after normal landing when clean-tree proof refuses removal', async () => {
  const stop = deferred();
  instances.terminateInstance.mockImplementation(async id => { if (id === 'worker') await stop.promise; instances.live.delete(id); });
  try {
    const landedCommit = await normalPassLanding();
    writeFileSync(join(item.worktreePath!, 'late-edit.txt'), 'keep this unlanded work\n');
    stop.release();
    await coordinator._whenSettledForTesting();
    expect(store.getItem(item.id)).toMatchObject({ state: 'landed', workerInstanceId: null,
      worktreePath: item.worktreePath, branchName: item.branchName, detail: expect.stringContaining('dirty-tree') });
    expect(readFileSync(join(item.worktreePath!, 'late-edit.txt'), 'utf8')).toBe('keep this unlanded work\n');
    expect(git(['rev-parse', 'main'])).toBe(landedCommit);
  } finally { stop.release(); await coordinator._whenSettledForTesting(); }
});

it('lands a legitimately parked stopped worker through operator override', async () => {
  writeFileSync(join(item.worktreePath!, 'feature.txt'), 'operator accepted work\n');
  await control('cancel');
  expect(instances.live.has('worker')).toBe(false);
  expect(store.getItem(item.id)?.state).toBe('parked');
  await coordinator.control({ action: 'land-anyway', itemId: item.id });
  await coordinator._whenSettledForTesting();
  expect(store.getItem(item.id)).toMatchObject({ state: 'landed', workerInstanceId: null, branchName: null,
    worktreePath: null, detail: expect.stringContaining('without a verifier PASS') });
  expect(git(['show', 'main:feature.txt'])).toBe('operator accepted work');
  expect(instances.created).toEqual([]);
});
