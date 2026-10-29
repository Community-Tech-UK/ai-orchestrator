import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

class Instances extends EventEmitter {
  live = new Map<string, PlanQueueInstanceRecord>();
  sendInput = vi.fn(async () => undefined);
  terminateInstance = vi.fn(async (id: string) => { this.live.delete(id); });
  getInstance = (id: string) => this.live.get(id);
  getAllInstances = () => [...this.live.values()];
  adoptOrphanInstance = () => false;
  async createInstance(config: InstanceCreateConfig) {
    const id = `fresh-${config.metadata?.['planQueueItemId']}`;
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
let unsafe: PlanQueueItem;
const git = (args: string[], cwd = repo) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

beforeEach(() => {
  PlanQueueCoordinator._resetForTesting();
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-hold-ownership-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']);
  git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'feature.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  mkdirSync(join(repo, '.worktrees', 'queue'), { recursive: true });
  for (const name of ['unsafe', 'healthy']) {
    git(['worktree', 'add', '-qb', `queue/${name}`, join(repo, '.worktrees', 'queue', name)]);
  }
  // Active plans stay untracked, including in this disposable repository.
  writeFileSync(join(repo, 'unsafe_plan.md'), '# Unsafe plan\n');
  writeFileSync(join(repo, 'healthy_plan.md'), '# Healthy plan\n');
  db = new Database(':memory:') as unknown as SqliteDriver;
  runLoopMigrations(db);
  store = new PlanQueueStore(db);
  run = {
    id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo, status: 'paused',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main',
      routing: { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'codex' }] }, startingSessionRoute: { provider: 'claude' } },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null,
  };
  unsafe = newPlanQueueItem('unsafe', run.id, join(repo, 'unsafe_plan.md'), 1, {
    state: 'queued', branchName: 'queue/unsafe', worktreePath: join(repo, '.worktrees', 'queue', 'unsafe'),
    checkpointCommit: git(['rev-parse', 'HEAD']),
  });
  store.upsertRun(run);
  store.upsertItem(unsafe);
  store.upsertItem(newPlanQueueItem('healthy', run.id, join(repo, 'healthy_plan.md'), 2, {
    state: 'queued', branchName: 'queue/healthy', worktreePath: join(repo, '.worktrees', 'queue', 'healthy'),
    checkpointCommit: git(['rev-parse', 'HEAD']),
  }));
  instances = new Instances();
  instances.live.set('parent', { id: 'parent', status: 'idle', outputBuffer: [], provider: 'claude', workingDirectory: repo });
  coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({
    store, instances, skipInstall: true, pumpIntervalMs: null, loadAverage: () => [0, 0, 0],
    worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] },
    selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
    routing: { readSaved: () => ({ workers: [], verifiers: [] }), routeUsage: async () => ({ usable: true, resumeAt: null }),
      readAccountRules: () => ({ never: [], last: [] }), copilotProfileFor: () => null, poolProfiles: () => [], copilotProfiles: () => [],
      defaultProvider: () => null, checkerScopeKind: () => 'none', isProviderExcluded: () => false,
      listInstalledProviders: async () => ['claude', 'codex'] },
  });
});

afterEach(async () => {
  coordinator.shutdown();
  await coordinator._whenSettledForTesting();
  vi.restoreAllMocks();
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

/** Ownership failures must not change the index, files, saved checkpoint, or any refused checkout refs. */
function refusedCheckoutSnapshot() {
  const cwd = unsafe.worktreePath!;
  return {
    tracked: readFileSync(join(cwd, 'feature.txt')),
    untracked: readFileSync(join(cwd, 'untracked.txt')),
    document: readFileSync(unsafe.documentPath),
    head: git(['rev-parse', 'HEAD'], cwd),
    headLog: git(['reflog', 'show', '--format=%H', 'HEAD'], cwd),
    branch: git(['rev-parse', 'queue/unsafe']),
    branchLog: git(['reflog', 'show', '--format=%H', 'queue/unsafe']),
    main: git(['rev-parse', 'main']),
    index: readFileSync(join(git(['rev-parse', '--absolute-git-dir'], cwd), 'index')),
    rootStatus: git(['status', '--porcelain']),
    rootFeature: readFileSync(join(repo, 'feature.txt')),
  };
}

describe('run hold checkpoint ownership', () => {
  // Removing the typed refusal catch strands Resume; weakening the guard changes this snapshot.
  it.each(['queued', 'working'] as const)('parks only a refused %s checkout and resumes healthy work without modifying refused work', async state => {
    const cwd = unsafe.worktreePath!;
    // The saved branch and detached HEAD differ, as in the observed failure.
    writeFileSync(join(cwd, 'feature.txt'), 'saved on the branch\n');
    git(['commit', '-qam', 'branch work'], cwd);
    unsafe = { ...unsafe, state, checkpointCommit: git(['rev-parse', 'HEAD'], cwd) };
    git(['checkout', '-q', '--detach', 'HEAD~1'], cwd);
    writeFileSync(join(cwd, 'feature.txt'), 'dirty tracked work\n');
    writeFileSync(join(cwd, 'untracked.txt'), 'untracked work\n');
    writeFileSync(join(repo, 'feature.txt'), 'other root work\n');
    if (state === 'working') {
      unsafe = { ...unsafe, workerInstanceId: 'worker', verifierInstanceId: 'checker', pendingInstruction: 'Keep the remaining work' };
      for (const [id, role] of [['worker', 'worker'], ['checker', 'verifier']] as const) {
        instances.live.set(id, { id, status: 'busy', outputBuffer: [] });
        coordinator.registerRole(id, { role, runId: run.id, itemId: unsafe.id });
      }
    }
    store.upsertItem(unsafe);
    const before = refusedCheckoutSnapshot();

    await coordinator.control({ action: 'resume', runId: run.id });
    await coordinator._whenSettledForTesting();

    expect(store.getRun(run.id)?.status).toBe('running');
    expect(store.getItem(unsafe.id)).toMatchObject({
      state: 'parked', parkReason: 'worktree-error', heldAt: null,
      branchName: 'queue/unsafe', worktreePath: cwd, checkpointCommit: unsafe.checkpointCommit,
      workerInstanceId: null, verifierInstanceId: null, pendingInstruction: unsafe.pendingInstruction,
      detail: expect.stringContaining(`${cwd} is not this item's checkout of queue/unsafe`),
    });
    expect(instances.live.has('worker')).toBe(false);
    expect(instances.live.has('checker')).toBe(false);
    expect(coordinator.roleOf('worker')).toBeUndefined();
    expect(coordinator.roleOf('checker')).toBeUndefined();
    expect(store.getItem('healthy')).toMatchObject({ state: 'working', workerInstanceId: 'fresh-healthy' });
    expect(refusedCheckoutSnapshot()).toEqual(before);
    expect(() => git(['symbolic-ref', '-q', 'HEAD'], cwd)).toThrow();
    expect(git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${cwd}\n`);
  });

  // A message-shaped ordinary error must never be mistaken for the typed pre-write refusal.
  it.each(['disk write failed', "not this item's checkout of queue/unsafe, so nothing was committed"])(
    'keeps Resume paused and propagates an unrelated checkpoint failure: %s', async message => {
      const failure = new Error(message);
      vi.spyOn(coordinator.worktrees, 'checkpoint').mockRejectedValue(failure);

      await expect(coordinator.control({ action: 'resume', runId: run.id })).rejects.toBe(failure);
      await coordinator._whenSettledForTesting();

      expect(store.getRun(run.id)?.status).toBe('paused');
      expect(store.getItem('unsafe')).toMatchObject({ state: 'queued', parkReason: null, checkpointCommit: unsafe.checkpointCommit });
      expect(store.getItem('healthy')?.state).toBe('queued');
      expect([...instances.live.keys()]).toEqual(['parent']);
    },
  );
});
