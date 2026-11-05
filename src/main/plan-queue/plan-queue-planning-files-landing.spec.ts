import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { PlanQueueItemLanding } from './plan-queue-item-landing';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { assertItemTransition, newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let repo: string;
let dataDir: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let service: PlanQueueWorktreeService;
let landing: PlanQueueItemLanding;
let base: string;
let parked: { reason: string; detail: string }[];

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function save(item: PlanQueueItem): PlanQueueItem { store.upsertItem(item); return item; }
function transition(item: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}): PlanQueueItem {
  assertItemTransition(item.state, state); return save({ ...item, ...patch, state });
}

beforeAll(() => initSqliteWasm());
beforeEach(() => {
  WorktreeManager._resetForTesting(); GitWriteQueue._resetForTesting();
  parked = [];
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'queue-planning-data-')));
  _setPlanQueueDataDirForTesting(dataDir);
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-planning-landing-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.hooksPath', '.git/no-hooks']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
  base = git(['rev-parse', 'main']);
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', verifierGates: [], postMergeGate: [] },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null };
  store.upsertRun(run);
  service = new PlanQueueWorktreeService({ repoRootForItem: () => repo, creator: WorktreeManager.getInstance(),
    saveItem: save, skipInstall: true, history: store.history, stopLeftoversIn: async () => 0 });
  const host = { store, history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    save, transition, worktrees: service, requestPump: () => undefined } as PlanQueueFlowHost;
  landing = new PlanQueueItemLanding({ host, stopInstance: async () => undefined,
    toFixing: async (item, _prompt, detail) => { transition(item, 'fixing', { detail }); },
    park: async (item, reason, detail) => { parked.push({ reason, detail }); transition(item, 'parked', { parkReason: reason, detail }); } });
});
afterEach(() => {
  vi.restoreAllMocks(); db.close(); rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true }); _setPlanQueueDataDirForTesting(null);
  WorktreeManager._resetForTesting(); GitWriteQueue._resetForTesting();
});

/** An item in `landing` whose worker made `files` in its folder (never checkpointed yet). */
async function itemInLanding(files: Record<string, string>): Promise<PlanQueueItem> {
  let item = newPlanQueueItem('one', 'run', join(repo, 'one_plan.md'), 1, { state: 'preparing', round: 1 });
  item = await service.prepare(item, repo);
  write(item.worktreePath!, 'one.txt', 'one\n');
  for (const [rel, content] of Object.entries(files)) write(item.worktreePath!, rel, content);
  const verdict: PlanQueueVerdict = { verdict: 'PASS', findings: [], documentComplete: false, needJames: [], gatesRun: [] };
  return save({ ...item, state: 'landing', verifiedMainCommit: base, verdict });
}

describe('landing with planning files in the work folder', () => {
  it('moves a worker-created _history.md to the root, lands the code, and never commits the file', async () => {
    await itemInLanding({ 'docs/plans/one_history.md': 'journal\n', 'docs/plans/one_livetest.md': '# live\n' });

    await landing.land('one', {});

    expect(store.getItem('one')?.state).toBe('landed');
    expect(git(['show', 'main:one.txt'])).toBe('one');
    expect(git(['ls-tree', '-r', '--name-only', 'main']).split('\n').filter((file) => file.includes('docs/plans'))).toEqual([]);
    expect(readFileSync(join(repo, 'docs/plans/one_history.md'), 'utf8')).toBe('journal\n');
    expect(readFileSync(join(repo, 'docs/plans/one_livetest.md'), 'utf8')).toBe('# live\n');
    expect(parked).toEqual([]);
  });

  it('parks before the squash, naming the file, when a planning file cannot be moved', async () => {
    write(repo, 'blocked', 'a file where the folder should be\n');
    const item = await itemInLanding({ 'blocked/plans/one_history.md': 'journal\n' });

    await landing.land('one', {});

    expect(parked).toHaveLength(1);
    expect(parked[0].reason).toBe('land-blocked');
    expect(parked[0].detail).toContain('Nothing was landed.');
    expect(parked[0].detail).toContain('blocked/plans/one_history.md');
    expect(git(['rev-parse', 'main'])).toBe(base);
    // No squash ran, so no landing cleanup ran: the file is still in the folder, and a rescue copy exists.
    expect(readFileSync(join(item.worktreePath!, 'blocked/plans/one_history.md'), 'utf8')).toBe('journal\n');
    expect(existsSync(join(git(['rev-parse', '--absolute-git-dir'], item.worktreePath!), 'plan-queue-landing'))).toBe(false);
    expect(git(['branch', '--show-current'], item.worktreePath!)).toBe(item.branchName);
    const rescue = join(dataDir, 'planning-rescue', 'one');
    expect(existsSync(rescue)).toBe(true);
  });
});
