import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import * as queueGit from './plan-queue-git';
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
    routing: { readSaved: () => ({ workers: [], verifiers: [] }), poolProfiles: () => [], copilotProfiles: () => [],
      defaultProvider: () => null, checkerScopeKind: () => 'none', isProviderExcluded: () => false, listInstalledProviders: async () => ['claude', 'codex', 'cursor'] },
  });
  coordinator.registerRole('worker', { role: 'worker', runId: run.id, itemId: item.id });
});

afterEach(async () => {
  coordinator.shutdown(); await coordinator._whenSettledForTesting();
  vi.restoreAllMocks();
  db.close(); rmSync(repo, { recursive: true, force: true });
});

describe('Plan Queue pause controls in the coordinator', () => {
  it('keeps old running and paused runs in the page snapshot beyond fifty terminal runs', async () => {
    const paused = { ...run, id: 'old-paused', status: 'paused' as const, startedAt: 2, kind: 'livetests' as const };
    store.upsertRun(paused);
    store.upsertItem(newPlanQueueItem('paused-question', paused.id, item.documentPath, 2, {
      state: 'needs-answer', question: { question: 'Continue?', options: [{ id: 'go', label: 'Go' }, { id: 'stay', label: 'Stay' }] },
    }));
    for (let index = 0; index < 55; index++) {
      store.upsertRun({ ...run, id: `terminal-${index}`, status: index % 2 ? 'completed' : 'cancelled', startedAt: 100 + index, endedAt: 200 + index });
    }
    // Keep the ordinary bounded-history API unchanged.
    expect(store.listRuns(50)).toHaveLength(50);
    expect(store.listRuns(50).every(entry => entry.status === 'completed' || entry.status === 'cancelled')).toBe(true);
    const snapshot = coordinator.listRunDtos(50);
    expect(snapshot.filter(entry => entry.status === 'running').map(entry => entry.id)).toEqual([run.id]);
    expect(snapshot.filter(entry => entry.status === 'paused').map(entry => entry.id)).toEqual([paused.id]);
    expect(snapshot.filter(entry => entry.status === 'completed' || entry.status === 'cancelled')).toHaveLength(50);
    expect(snapshot.at(-1)?.items[0].id).toBe(item.id);
    expect(snapshot.find(entry => entry.id === paused.id)?.kind).toBe('livetests');
    expect(snapshot.map(entry => entry.startedAt)).toEqual([...snapshot.map(entry => entry.startedAt)].sort((a, b) => b - a));

    await coordinator.control({ action: 'pause-all' });
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(store.getRun(paused.id)?.status).toBe('paused');
    expect(instances.live.has('worker')).toBe(false);
    await coordinator.control({ action: 'resume-all' });
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(store.getRun(paused.id)?.status).toBe('running');
  });

  it('lists old completed and cancelled runs with parked work beyond fifty inert terminal runs', () => {
    const completed = { ...run, id: 'old-completed', status: 'completed' as const, startedAt: 2, endedAt: 10 };
    const cancelled = { ...run, id: 'old-cancelled', status: 'cancelled' as const, kind: 'livetests' as const, startedAt: 3, endedAt: 11 };
    store.upsertRun(completed); store.upsertRun(cancelled);
    store.upsertItem(newPlanQueueItem('retained-work', completed.id, item.documentPath, 2, {
      state: 'parked', branchName: 'queue/retained', worktreePath: item.worktreePath, parkReason: 'round-limit',
    }));
    store.upsertItem(newPlanQueueItem('branchless-triage', cancelled.id, item.documentPath, 3, {
      state: 'parked', parkReason: 'triage-failed',
    }));
    for (let index = 0; index < 55; index++) {
      store.upsertRun({ ...run, id: `inert-${index}`, status: index % 2 ? 'completed' : 'cancelled', startedAt: 100 + index, endedAt: 200 + index });
    }
    expect(coordinator.getRunDto(completed.id)?.items[0].branchName).toBe('queue/retained');
    expect(coordinator.getRunDto(cancelled.id)?.items[0]).toMatchObject({ state: 'parked', branchName: null, parkReason: 'triage-failed' });
    const snapshot = coordinator.listRunDtos(50);
    expect(snapshot.find(entry => entry.id === completed.id)).toMatchObject({ status: 'completed', kind: 'plans', items: [{ id: 'retained-work', branchName: 'queue/retained' }] });
    expect(snapshot.find(entry => entry.id === cancelled.id)).toMatchObject({ status: 'cancelled', kind: 'livetests', items: [{ id: 'branchless-triage', branchName: null }] });
    expect(snapshot.filter(entry => entry.id.startsWith('inert-'))).toHaveLength(50);
    expect(snapshot.filter(entry => entry.status === 'running')).toHaveLength(1);
    expect(snapshot.filter(entry => entry.status === 'paused')).toHaveLength(0);
    expect(new Set(snapshot.map(entry => entry.id)).size).toBe(snapshot.length);
  });

  it('publishes paused while checkpointing and serializes concurrent Resume until the saved work is safe', async () => {
    const checkpoint = coordinator.worktrees.checkpoint.bind(coordinator.worktrees);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blockedCheckpoint = vi.spyOn(coordinator.worktrees, 'checkpoint').mockImplementationOnce(async (...args) => {
      await gate;
      return checkpoint(...args);
    });
    writeFileSync(join(item.worktreePath!, 'feature.txt'), 'saved before resume\n');
    const pausing = coordinator.control({ action: 'pause', runId: run.id });
    try {
      await vi.waitFor(() => expect(blockedCheckpoint).toHaveBeenCalledTimes(1));
      expect(store.getRun(run.id)?.status).toBe('paused');
      expect(instances.live.has('worker')).toBe(false);
      let resumed = false;
      const resuming = coordinator.control({ action: 'resume', runId: run.id }).then(() => { resumed = true; });
      // Drain queued control/pump callbacks while the checkpoint deliberately remains blocked.
      await new Promise(resolve => setImmediate(resolve));
      expect(resumed).toBe(false);
      expect(store.getRun(run.id)?.status).toBe('paused');
      expect(instances.created).toEqual([]);
      release();
      await Promise.all([pausing, resuming]);
      await coordinator._whenSettledForTesting();
      expect(store.getRun(run.id)?.status).toBe('running');
      expect(instances.created).toHaveLength(1);
      expect(instances.created[0].workingDirectory).toBe(item.worktreePath);
      expect(git(['show', 'HEAD:feature.txt'], item.worktreePath!)).toBe('saved before resume');
      expect(store.getItem(item.id)).toMatchObject({ state: 'working', heldAt: null, parkReason: null });
    } finally { release(); await pausing; }
  });

  it('retries a failed checker restore before Resume rechecks without consuming or parking a round', async () => {
    store.upsertItem({ ...item, state: 'verifying', verifierInstanceId: 'checker', round: 1 });
    instances.live.set('checker', { id: 'checker', status: 'busy', outputBuffer: [] });
    writeFileSync(join(item.worktreePath!, 'feature.txt'), 'checker edit\n');
    const restore = vi.spyOn(queueGit, 'revertToSnapshot').mockRejectedValueOnce(new Error('transient restore failure'));
    await expect(coordinator.control({ action: 'pause', runId: run.id })).rejects.toThrow('transient restore failure');
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(instances.live.has('checker')).toBe(false);
    expect(instances.created).toEqual([]);
    expect(store.getItem(item.id)).toMatchObject({ state: 'verifying', round: 1, erroredRounds: 0, parkReason: null });
    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(item.worktreePath!, 'feature.txt'), 'utf8')).toBe('base\n');
    expect(instances.created).toHaveLength(1);
    expect(instances.created[0].metadata?.['planQueueRole']).toBe('verifier');
    expect(store.getItem(item.id)).toMatchObject({ state: 'verifying', round: 1, erroredRounds: 0, parkReason: null, heldAt: null });
  });

  it.each(['working', 'fixing', 'preparing'] as const)('checkpoints %s work, stops the worker and keeps its working folder', async (state) => {
    store.upsertItem({ ...item, state });
    writeFileSync(join(item.worktreePath!, 'feature.txt'), 'saved work\n');
    await coordinator.control({ action: 'pause', runId: run.id });
    expect(instances.live.has('worker')).toBe(false);
    expect(store.getItem(item.id)).toMatchObject({ state: 'queued', workerInstanceId: null, heldAt: expect.any(Number), parkReason: null });
    expect(git(['status', '--porcelain'], item.worktreePath!)).toBe('');
    expect(git(['show', 'HEAD:feature.txt'], item.worktreePath!)).toBe('saved work');
    expect(existsSync(item.worktreePath!)).toBe(true);
    expect(instances.created).toEqual([]);
  });

  it('resumes from the same branch and pending findings with no reinstallation', async () => {
    store.upsertItem({ ...item, state: 'fixing', verdict: { verdict: 'FAIL', findings: [{ severity: 'high', confidence: 90, summary: 'Repair the retry guard' }], gatesRun: [], documentComplete: false, needJames: [] } });
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(instances.created).toHaveLength(1);
    expect(instances.created[0]).toMatchObject({ workingDirectory: item.worktreePath, initialPrompt: expect.stringContaining('Repair the retry guard') });
    expect(store.getItem(item.id)).toMatchObject({ state: 'working', branchName: item.branchName, heldAt: null, pendingInstruction: null });
  });

  it('restores the checkpoint after stopping a checker without consuming a round', async () => {
    store.upsertItem({ ...item, state: 'verifying', verifierInstanceId: 'checker', round: 1 });
    instances.live.set('checker', { id: 'checker', status: 'busy', outputBuffer: [] });
    writeFileSync(join(item.worktreePath!, 'feature.txt'), 'checker edit\n');
    writeFileSync(join(item.worktreePath!, 'checker-created.txt'), 'unwanted\n');
    await coordinator.control({ action: 'pause', runId: run.id });
    expect(store.getItem(item.id)).toMatchObject({ state: 'awaiting-slot', round: 1, erroredRounds: 0, workerInstanceId: null, verifierInstanceId: null, heldAt: expect.any(Number) });
    expect(readFileSync(join(item.worktreePath!, 'feature.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(join(item.worktreePath!, 'checker-created.txt'))).toBe(false);
    expect(instances.live.has('checker')).toBe(false);
  });

  it('cancels a paused item by retaining its branch and parking the work', async () => {
    writeFileSync(join(item.worktreePath!, 'feature.txt'), 'saved work\n');
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator.control({ action: 'cancel', runId: run.id });
    expect(store.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'cancelled', branchName: 'queue/example', heldAt: null });
    expect(git(['show', 'queue/example:feature.txt'])).toBe('saved work');
    expect(store.getRun(run.id)?.status).toBe('cancelled');
  });

  it('retries a failed triage stop before cancelling a paused run', async () => {
    const documentPath = join(repo, 'triage_plan.md');
    writeFileSync(documentPath, '# Check this plan\n');
    store.upsertItem(newPlanQueueItem('triage-item', run.id, documentPath, 2));
    coordinator.requestPump();
    await vi.waitFor(() => expect(instances.created.some(config => config.metadata?.['planQueueRole'] === 'triage')).toBe(true));
    const triage = [...instances.live.values()].find(session => session.metadata?.['planQueueRole'] === 'triage')!;
    instances.terminateInstance.mockImplementation(async id => {
      if (id === triage.id) throw new Error('triage stop failed');
      instances.live.delete(id);
    });
    await expect(coordinator.control({ action: 'pause', runId: run.id })).rejects.toThrow('triage stop failed');
    instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
    await coordinator.control({ action: 'cancel', runId: run.id });
    expect(instances.live.has(triage.id)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('cancelled');
  });

  it('holds a landing refused by a real hook while paused and keeps the repair instruction for Resume', async () => {
    writeFileSync(join(item.worktreePath!, 'feature.txt'), 'ready to land\n');
    git(['add', 'feature.txt'], item.worktreePath!);
    git(['commit', '-qm', 'worker change'], item.worktreePath!);
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    git(['config', 'core.hooksPath', join(repo, '.git', 'hooks')]);
    writeFileSync(hook, '#!/bin/sh\necho "Landing gate refused" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    store.upsertRun({ ...run, status: 'paused' });
    store.upsertItem({ ...item, state: 'parked', workerInstanceId: null, parkReason: 'cancelled' });
    instances.live.delete('worker');
    await coordinator.control({ action: 'land-anyway', itemId: item.id });
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(store.getItem(item.id)).toMatchObject({
      state: 'queued', parkReason: null, heldAt: expect.any(Number), workerInstanceId: null,
      pendingInstruction: expect.stringContaining('Landing gate refused'), landingRefusals: 1,
    });
    expect(instances.created).toEqual([]);
    expect(instances.sendInput).not.toHaveBeenCalledWith('worker', expect.anything(), undefined, expect.anything());
    expect(existsSync(item.worktreePath!)).toBe(true);
    rmSync(hook);
    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(instances.created).toHaveLength(1);
    expect(instances.created[0].initialPrompt).toContain('Landing gate refused');
    expect(store.getItem(item.id)).toMatchObject({ state: 'working', heldAt: null, pendingInstruction: null, parkReason: null });
  });

  it('pauses one run independently and supports Pause all / Resume all', async () => {
    store.upsertRun({ ...run, id: 'other', startedAt: 2 });
    store.upsertItem(newPlanQueueItem('other-item', 'other', join(repo, 'other_plan.md'), 2, { state: 'needs-answer' }));
    await coordinator.control({ action: 'pause', runId: run.id });
    expect(store.getRun('other')?.status).toBe('running');
    await coordinator.control({ action: 'pause-all' });
    expect(store.listActiveRuns().every(r => r.status === 'paused')).toBe(true);
    await expect(coordinator.control({ action: 'resume-all' }, 'parent')).rejects.toThrow('Only James');
    await coordinator.control({ action: 'resume-all' });
    expect(store.listActiveRuns().every(r => r.status === 'running')).toBe(true);
  });

  it('changes routing on a paused run, then starts the resumed worker on the new provider', async () => {
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator.control({ action: 'set-routing', runId: run.id, routing: { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'codex' }] } });
    expect(instances.created).toEqual([]);
    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(instances.created[0]?.provider).toBe('cursor');
    expect(instances.sendInput).toHaveBeenCalledWith('parent', expect.stringContaining('James changed'), undefined, expect.anything());
  });

  it('moves live documents on opt-in and preserves the original session route', async () => {
    await coordinator.control({ action: 'set-routing', runId: run.id, routing: { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'codex' }] }, moveInProgress: true });
    await coordinator._whenSettledForTesting();
    expect(instances.live.has('worker')).toBe(false);
    expect(instances.created[0]?.provider).toBe('cursor');
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator.control({ action: 'set-routing', runId: run.id, routing: { workers: [], verifiers: [{ provider: 'codex' }] } });
    expect(store.getRun(run.id)?.workerProvider).toBe('claude');
  });

  it('uses the latest checker choice when routing changes during selection', async () => {
    store.upsertItem({ ...item, state: 'awaiting-slot' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let selecting = false;
    vi.spyOn(coordinator, 'selectVerifier').mockImplementation(async input => {
      if (!selecting) { selecting = true; await gate; }
      return { ok: true, choice: { provider: input.choices?.[0]?.provider ?? 'codex' } };
    });
    coordinator.requestPump();
    await vi.waitFor(() => expect(selecting).toBe(true));
    await coordinator.control({ action: 'set-routing', runId: run.id, routing: { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'cursor' }] } });
    release();
    await coordinator._whenSettledForTesting();
    expect(instances.created.find(c => c.metadata?.['planQueueRole'] === 'verifier')?.provider).toBe('cursor');
  });

  it('retries a failed pause checkpoint before Resume starts fresh work', async () => {
    vi.spyOn(coordinator.worktrees, 'checkpoint').mockRejectedValueOnce(new Error('transient checkpoint failure'));
    await expect(coordinator.control({ action: 'pause', runId: run.id })).rejects.toThrow('transient checkpoint');
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(instances.live.has('worker')).toBe(false);
    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(instances.created).toHaveLength(1);
    expect(store.getItem(item.id)).toMatchObject({ state: 'working', heldAt: null });
  });
});


async function startPendingTriage() {
  const documentPath = join(repo, 'triage_plan.md');
  writeFileSync(documentPath, '# Check this plan\n');
  store.upsertItem(newPlanQueueItem('triage-item', run.id, documentPath, 2));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const create = instances.createInstance.bind(instances);
  let lateId: string | undefined;
  vi.spyOn(instances, 'createInstance').mockImplementation(async config => {
    const created = await create(config);
    if (config.metadata?.['planQueueRole'] === 'triage' && !lateId) {
      lateId = created.id;
      await gate;
    }
    return created;
  });
  coordinator.requestPump();
  await vi.waitFor(() => expect(lateId).toBeDefined());
  return { release, id: lateId! };
}

describe('pending triage creation during run controls', () => {
  it('keeps Pause and a concurrent Resume waiting until the late triage is stopped', async () => {
    const late = await startPendingTriage();
    let paused = false;
    const pausing = coordinator.control({ action: 'pause', runId: run.id }).then(() => { paused = true; });
    try {
      await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'));
      let resumed = false;
      const resuming = coordinator.control({ action: 'resume', runId: run.id }).then(() => { resumed = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(paused).toBe(false);
      expect(resumed).toBe(false);
      expect(store.getRun(run.id)?.status).toBe('paused');
      expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(1);
      late.release();
      await Promise.all([pausing, resuming]);
      await coordinator._whenSettledForTesting();
      expect(instances.live.has(late.id)).toBe(false);
      expect(store.getRun(run.id)?.status).toBe('running');
      expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(2);
      expect(store.getItem('triage-item')).toMatchObject({ state: 'discovered', parkReason: null });
    } finally { late.release(); await pausing; }
  });

  it('refuses Pause and Resume while a late triage cannot stop, then retries successfully', async () => {
    const late = await startPendingTriage();
    instances.terminateInstance.mockImplementation(async id => {
      if (id === late.id) throw new Error('late triage stop failed');
      instances.live.delete(id);
    });
    const pausing = coordinator.control({ action: 'pause', runId: run.id });
    const rejected = expect(pausing).rejects.toThrow('late triage stop failed');
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'));
    late.release();
    await rejected;
    expect(store.getRun(run.id)?.status).toBe('paused');
    await expect(coordinator.control({ action: 'resume', runId: run.id })).rejects.toThrow('late triage stop failed');
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(1);
    instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(instances.live.has(late.id)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(2);
    expect(store.getItem('triage-item')).toMatchObject({ state: 'discovered', parkReason: null });
  });
});


describe('other controls wait for pending triage cleanup', () => {
  it.each(['cancel', 'move'] as const)('%s waits for a pending triage before completing', async action => {
    const late = await startPendingTriage();
    let finished = false;
    const controlling = (action === 'cancel'
      ? coordinator.control({ action: 'cancel', runId: run.id })
      : coordinator.control({ action: 'set-routing', runId: run.id,
        routing: { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'codex' }] }, moveInProgress: true }))
      .then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'));
      await new Promise(resolve => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(1);
      late.release();
      await controlling;
      await coordinator._whenSettledForTesting();
      expect(instances.live.has(late.id)).toBe(false);
      expect(store.getRun(run.id)?.status).toBe(action === 'cancel' ? 'cancelled' : 'running');
      expect(store.getItem('triage-item')?.state).toBe(action === 'cancel' ? 'skipped' : 'discovered');
      if (action === 'move') {
        const nextTriage = instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')[1];
        expect(nextTriage?.provider).toBe('cursor');
      }
    } finally { late.release(); await controlling; }
  });

  it.each(['cancel', 'move'] as const)('%s refuses to finish until a failed late cleanup is retried', async action => {
    const late = await startPendingTriage();
    instances.terminateInstance.mockImplementation(async id => {
      if (id === late.id) throw new Error('late cleanup unavailable');
      instances.live.delete(id);
    });
    const controlling = action === 'cancel'
      ? coordinator.control({ action: 'cancel', runId: run.id })
      : coordinator.control({ action: 'set-routing', runId: run.id,
        routing: { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'codex' }] }, moveInProgress: true });
    const rejected = expect(controlling).rejects.toThrow('late cleanup unavailable');
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'));
    late.release();
    await rejected;
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(instances.live.has(late.id)).toBe(true);
    expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(1);
    expect(store.getItem('triage-item')).toMatchObject({ state: 'discovered', parkReason: null });
    instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
    await coordinator.control({ action: action === 'cancel' ? 'cancel' : 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();
    expect(instances.live.has(late.id)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe(action === 'cancel' ? 'cancelled' : 'running');
  });
});


it('keeps a concurrent Pause failed and held when Close all changes the late spawn error', async () => {
  const late = await startPendingTriage();
  instances.terminateInstance.mockImplementation(async id => {
    if (id === late.id) throw new Error('concurrent Close all stop failed');
    instances.live.delete(id);
  });
  const pausing = coordinator.control({ action: 'pause', runId: run.id });
  const rejected = expect(pausing).rejects.toThrow('concurrent Close all stop failed');
  await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'));
  coordinator.noteUserClosing([], 'all');
  late.release();
  await rejected;
  await expect(coordinator.control({ action: 'resume', runId: run.id })).rejects.toThrow('concurrent Close all stop failed');
  expect(store.getRun(run.id)?.status).toBe('paused');
  expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(1);
  instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
  await coordinator.control({ action: 'resume', runId: run.id });
  await coordinator._whenSettledForTesting();
  expect(instances.live.has(late.id)).toBe(false);
  expect(instances.created.filter(config => config.metadata?.['planQueueRole'] === 'triage')).toHaveLength(2);
});


it.each(['worker', 'verifier'] as const)('retains and stops a late %s before checkpoint or restore when Close all overtakes Pause', async role => {
  instances.live.delete('worker');
  store.upsertItem({ ...item, state: role === 'worker' ? 'queued' : 'awaiting-slot', workerInstanceId: null });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const create = instances.createInstance.bind(instances);
  let lateId: string | undefined;
  vi.spyOn(instances, 'createInstance').mockImplementation(async config => {
    const created = await create(config);
    if (config.metadata?.['planQueueRole'] === role && !lateId) {
      lateId = created.id;
      writeFileSync(join(item.worktreePath!, 'feature.txt'), 'late writer edit\n');
      await gate;
    }
    return created;
  });
  coordinator.requestPump();
  await vi.waitFor(() => expect(lateId).toBeDefined());
  instances.terminateInstance.mockImplementation(async id => {
    if (id === lateId) throw new Error('late writer stop failed');
    instances.live.delete(id);
  });
  const checkpoint = vi.spyOn(coordinator.worktrees, 'checkpoint');
  const pausing = coordinator.control({ action: 'pause', runId: run.id });
  const rejected = expect(pausing).rejects.toThrow('late writer stop failed');
  await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'));
  coordinator.noteUserClosing([], 'all');
  release();
  await rejected;
  expect(store.getRun(run.id)?.status).toBe('paused');
  expect(store.getItem(item.id)).toMatchObject({
    [role === 'worker' ? 'workerInstanceId' : 'verifierInstanceId']: lateId,
    erroredRounds: 0, parkReason: null,
  });
  expect(checkpoint).not.toHaveBeenCalled();
  expect(readFileSync(join(item.worktreePath!, 'feature.txt'), 'utf8')).toBe('late writer edit\n');
  instances.terminateInstance.mockImplementation(async id => { instances.live.delete(id); });
  await coordinator.control({ action: 'resume', runId: run.id });
  await coordinator._whenSettledForTesting();
  expect(instances.live.has(lateId!)).toBe(false);
  expect(store.getRun(run.id)?.status).toBe('running');
  expect(store.getItem(item.id)).toMatchObject({ erroredRounds: 0, parkReason: null, branchName: item.branchName });
  expect(readFileSync(join(item.worktreePath!, 'feature.txt'), 'utf8')).toBe(role === 'worker' ? 'late writer edit\n' : 'base\n');
});


it.each(['worker', 'verifier'] as const)('keeps normal Close all semantics for a successfully stopped late %s during Pause', async role => {
  instances.live.delete('worker');
  store.upsertItem({ ...item, state: role === 'worker' ? 'queued' : 'awaiting-slot', workerInstanceId: null });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const create = instances.createInstance.bind(instances);
  let lateId: string | undefined;
  vi.spyOn(instances, 'createInstance').mockImplementation(async config => {
    const created = await create(config);
    if (!lateId && config.metadata?.['planQueueRole'] === role) {
      lateId = created.id;
      writeFileSync(join(item.worktreePath!, 'feature.txt'), 'interrupted edit\n');
      await gate;
    }
    return created;
  });
  coordinator.requestPump();
  await vi.waitFor(() => expect(lateId).toBeDefined());
  const pausing = coordinator.control({ action: 'pause', runId: run.id });
  await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('paused'));
  coordinator.noteUserClosing([], 'all');
  release();
  await pausing;
  expect(instances.live.has(lateId!)).toBe(false);
  // A parked worker is terminal, so this otherwise empty run can finish.
  expect(store.getRun(run.id)?.status).toBe(role === 'worker' ? 'completed' : 'paused');
  expect(store.getItem(item.id)).toMatchObject({
    state: role === 'worker' ? 'parked' : 'awaiting-slot',
    parkReason: role === 'worker' ? 'cancelled' : null, erroredRounds: 0,
  });
  if (role === 'verifier') expect(readFileSync(join(item.worktreePath!, 'feature.txt'), 'utf8')).toBe('base\n');
});
