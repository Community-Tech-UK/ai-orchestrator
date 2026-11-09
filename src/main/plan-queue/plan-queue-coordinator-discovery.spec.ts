import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import * as queueGit from './plan-queue-git';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { PlanQueueStore } from './plan-queue-store';

let root: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let coordinator: PlanQueueCoordinator;
let instances: ReturnType<typeof makeInstances>;

function makeInstances() {
  const parent: PlanQueueInstanceRecord = { id: 'parent', status: 'idle', provider: 'claude', outputBuffer: [], workingDirectory: root };
  return Object.assign(new EventEmitter(), {
    getInstance: (id: string) => id === parent.id ? parent : undefined,
    getAllInstances: () => [parent],
    createInstance: vi.fn(async () => ({ id: 'unexpected-session' })),
    sendInput: vi.fn(async () => undefined),
    terminateInstance: vi.fn(async () => undefined),
    restartFreshInstance: vi.fn(async () => undefined),
    adoptOrphanInstance: () => false,
  });
}

function write(relative: string, content = '# Plan\n'): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

beforeAll(() => initSqliteWasm());
beforeEach(() => {
  PlanQueueCoordinator._resetForTesting();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-start-discovery-')));
  db = createSqliteWasmDatabase(':memory:');
  runLoopMigrations(db);
  store = new PlanQueueStore(db);
  instances = makeInstances();
  vi.spyOn(queueGit, 'repositoryRoot').mockResolvedValue(root);
  vi.spyOn(queueGit, 'currentBranch').mockResolvedValue('main');
  coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({
    store, instances, skipInstall: true, pumpIntervalMs: null,
    // Synthetic admission input holds worker dispatch, without loading the host.
    loadAverage: () => [9999, 9999, 9999],
    worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] },
    selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
    folderChecklists: () => [],
    routing: {
      readSaved: () => ({ workers: [], verifiers: [] }), readAccountRules: () => ({ never: [], last: [] }),
      poolProfiles: () => [], copilotProfiles: () => [], copilotProfileFor: () => null,
      defaultProvider: () => null, checkerScopeKind: () => 'none', isProviderExcluded: () => false,
      listInstalledProviders: async () => ['claude', 'codex'],
    },
  });
});
afterEach(async () => {
  coordinator.shutdown();
  await coordinator._whenSettledForTesting();
  PlanQueueCoordinator._resetForTesting();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('coordinator document selection', () => {
  it.each(['z-target_plan.md', 'z-[target]{literal}_plan.md', 'z-target_livetest.md'])('queues a ready exact selection without model triage: %s', async (name) => {
    const file = write(`docs/plans/${name}`);
    const { run } = await coordinator.startRun({ parentInstanceId: 'parent', kind: name.endsWith('_livetest.md') ? 'livetests' : 'plans', glob: `docs/plans/${name}` });
    await coordinator._whenSettledForTesting();
    expect(store.listItems(run.id)).toMatchObject([{ sourceRef: file, state: 'queued' }]);
    expect(instances.createInstance).not.toHaveBeenCalled();
    // The direct decision is durable, including after a fresh store read.
    expect(new PlanQueueStore(db).listItems(run.id)[0].state).toBe('queued');
  });

  it('exposes persisted checklist coverage through both single and bulk run reads', async () => {
    vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
    write('docs/plans/summary_plan.md');
    const { run } = await coordinator.startRun({ parentInstanceId: 'parent', kind: 'plans', glob: 'docs/plans/summary_plan.md' });
    expect(run).not.toHaveProperty('checks');
    const [item] = store.listItems(run.id);
    store.history.recordChecklistRun(item, [item.id]);
    store.history.recordChecklistRun(item, [item.id]);
    expect(coordinator.getRunDto(run.id)?.checks).toEqual({ runs: 2, jobs: 1 });
    expect(coordinator.listRunDtos().find(entry => entry.id === run.id)?.checks).toEqual({ runs: 2, jobs: 1 });
  });

  it('queues the selected plan behind 5,000 ignored plans and claims it only once', async () => {
    for (let i = 0; i < 5_000; i++) write(`docs/plans/a-${String(i).padStart(5, '0')}_plan.md`);
    write('.planqueueignore', 'docs/plans/a-*\n');
    const file = write('docs/plans/z-target_plan.md');
    const input = { parentInstanceId: 'parent', kind: 'plans' as const, glob: 'docs/plans/z-target_plan.md' };
    const [first, second] = await Promise.all([coordinator.startRun(input), coordinator.startRun(input)]);
    await coordinator._whenSettledForTesting();
    expect([first, second].flatMap(result => result.run.items)).toMatchObject([{ sourceRef: file, state: 'queued' }]);
    expect([first, second].flatMap(result => result.excluded)).toEqual([file]);
    expect(instances.createInstance).not.toHaveBeenCalled();
  });

  it('blocks an exact selection with a missing linked spec without starting triage', async () => {
    const file = write('docs/plans/blocked_plan.md', '**Spec:** [spec](missing_spec.md)\n');
    const { run } = await coordinator.startRun({ parentInstanceId: 'parent', kind: 'plans', glob: 'docs/plans/blocked_plan.md' });
    await coordinator._whenSettledForTesting();
    expect(new PlanQueueStore(db).listItems(run.id)).toMatchObject([{
      sourceRef: file, state: 'parked', parkReason: 'worker-error', detail: expect.stringContaining('does not exist'),
    }]);
    expect(instances.createInstance).not.toHaveBeenCalled();
  });

  it('retains ordinary model triage for a wildcard selection', async () => {
    vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
    write('docs/plans/target_plan.md');
    const { run } = await coordinator.startRun({ parentInstanceId: 'parent', kind: 'plans', glob: 'docs/plans/*_plan.md' });
    expect(store.listItems(run.id)[0].state).toBe('discovered');
  });

  it('does not persist a run or claim items when wildcard discovery is incomplete', async () => {
    for (let i = 0; i < 5_001; i++) write(`docs/plans/a-${String(i).padStart(5, '0')}_plan.md`);
    await expect(coordinator.startRun({ parentInstanceId: 'parent', kind: 'plans' })).rejects.toThrow(/incomplete/i);
    expect(store.listRunSnapshots(20)).toEqual([]);
    expect(instances.createInstance).not.toHaveBeenCalled();
  });
});
