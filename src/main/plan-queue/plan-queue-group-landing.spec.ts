import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { PlanQueueItemLanding } from './plan-queue-item-landing';
import { groupCoversMovedBase } from './plan-queue-group-landing';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { assertItemTransition, newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let repo: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let service: PlanQueueWorktreeService;
let run: PlanQueueRun;
let landing: PlanQueueItemLanding;
let base: string;
let gateLog: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function save(item: PlanQueueItem): PlanQueueItem { store.upsertItem(item); return item; }
function transition(item: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}): PlanQueueItem {
  assertItemTransition(item.state, state); return save({ ...item, ...patch, state });
}

beforeAll(() => initSqliteWasm());
beforeEach(() => {
  WorktreeManager._resetForTesting(); GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-group-landing-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.hooksPath', '.git/no-hooks']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n*.md\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
  base = git(['rev-parse', 'main']); gateLog = join(repo, '.git', 'post-merge-runs');
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  run = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', verifierGates: ['npm test'],
      postMergeGate: [`node -e "require('node:fs').appendFileSync(process.argv[1], 'checked\\n')" '${gateLog}'`] },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null };
  store.upsertRun(run);
  service = new PlanQueueWorktreeService({ repoRootForItem: () => repo, creator: WorktreeManager.getInstance(),
    saveItem: save, skipInstall: true, history: store.history, stopLeftoversIn: async () => 0 });
  const host = { store, history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    save, transition, worktrees: service, requestPump: () => undefined } as PlanQueueFlowHost;
  landing = new PlanQueueItemLanding({ host, stopInstance: async () => undefined,
    toFixing: async (item, _prompt, detail) => { transition(item, 'fixing', { detail }); },
    park: async (item, reason, detail) => { transition(item, 'parked', { parkReason: reason, detail }); } });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(repo, { recursive: true, force: true });
  WorktreeManager._resetForTesting(); GitWriteQueue._resetForTesting(); });

async function group(ids = ['one', 'two'], separateFirstRun = false): Promise<PlanQueueItem[]> {
  const members: PlanQueueItem[] = [];
  if (separateFirstRun) store.upsertRun({ ...run, id: 'other-run' });
  for (const id of ids) {
    writeFileSync(join(repo, `${id}_plan.md`), '# Checked plan\n');
    let item = newPlanQueueItem(id, id === 'one' && separateFirstRun ? 'other-run' : run.id,
      join(repo, `${id}_plan.md`), 1, { state: 'preparing', round: 1 });
    item = await service.prepare(item, repo);
    writeFileSync(join(item.worktreePath!, `${id}.txt`), `${id}\n`);
    item = await service.checkpoint(item, 'finished work');
    members.push(item);
  }
  const testedTree = await service.withCombinedCopy(repo, base,
    members.map(item => ({ itemId: item.id, head: item.checkpointCommit! })), async copy => copy.testedTree);
  expect(testedTree).toBeTruthy();
  const checkGroup = { id: 'test-group', baseTip: base, memberItemIds: ids };
  store.history.recordChecklistRun(members[0], ids, checkGroup.id);
  return members.map(item => {
    const verdict: PlanQueueVerdict = { verdict: 'PASS', findings: [], documentComplete: false, needJames: [],
      gatesRun: [{ command: 'npm test', exitCode: 0, head: item.checkpointCommit!, testedTree,
        checkGroup, classification: 'passed', baseline: 'new', timedOut: false }] };
    return save({ ...item, state: 'landing', verifiedMainCommit: base, verdict });
  });
}

async function landFirst(): Promise<void> {
  await landing.land('one', {});
  expect(store.getItem('one')?.state).toBe('landed');
  expect(existsSync(gateLog)).toBe(false);
}
async function landSecondWithGate(): Promise<void> {
  await landing.land('two', {});
  expect(store.getItem('two')?.state).toBe('landed');
  expect(readFileSync(gateLog, 'utf8')).toBe('checked\n');
}

describe('landing a member of a passing combined check', () => {
  it('still syncs and checkpoints the second member while skipping its covered post-merge check', async () => {
    const [, second] = await group();
    await landFirst();
    await landing.land('two', {});
    const landed = store.getItem('two')!;
    expect(landed.state).toBe('landed');
    expect(landed.checkpointCommit).not.toBe(second.checkpointCommit);
    expect(git(['show', `${landed.checkpointCommit}:one.txt`])).toBe('one');
    expect(git(['show', 'main:two.txt'])).toBe('two');
    expect(existsSync(gateLog)).toBe(false);
  });

  it('runs the post-merge check again when an unrelated commit lands in between', async () => {
    await group(); await landFirst();
    writeFileSync(join(repo, 'outside.txt'), 'outside\n'); git(['add', 'outside.txt']); git(['commit', '-qm', 'outside job']);
    await landSecondWithGate();
    expect(git(['show', 'main:outside.txt'])).toBe('outside');
  });

  it('runs the post-merge check when a member left the round and later returned', async () => {
    await group(['one', 'two', 'three']); await landFirst();
    let other = transition(store.getItem('three')!, 'fixing');
    other = transition(other, 'awaiting-slot'); transition(other, 'verifying');
    await landSecondWithGate();
  });

  it('does not mistake an empty commit range after a backward base move for covered work', async () => {
    await group(); await landFirst();
    const newerBase = git(['rev-parse', 'main']);
    for (const id of ['one', 'two']) {
      const item = store.getItem(id)!;
      for (const receipt of item.verdict!.gatesRun) receipt.checkGroup!.baseTip = newerBase;
      save(item);
    }
    await expect(groupCoversMovedBase(store.getItem('two')!, run, base, { store, history: store.history })).resolves.toBe(false);
  });

  it('keeps the post-merge check when uncommitted code changed after the combined check', async () => {
    const [, second] = await group(); await landFirst();
    writeFileSync(join(second.worktreePath!, 'two.txt'), 'changed after checking\n');
    await landSecondWithGate();
    expect(git(['show', 'main:two.txt'])).toBe('changed after checking');
  });

  it('keeps the post-merge check when an earlier member landed code changed after the combined check', async () => {
    const [first] = await group();
    writeFileSync(join(first.worktreePath!, 'one.txt'), 'changed after checking\n');
    await landFirst(); await landSecondWithGate();
  });

  it('also skips the third member after the second member was synced and checkpointed', async () => {
    await group(['one', 'two', 'three']); await landFirst();
    await landing.land('two', {}); await landing.land('three', {});
    expect(store.getItem('three')?.state).toBe('landed');
    expect(existsSync(gateLog)).toBe(false);
    expect(git(['show', 'main:one.txt'])).toBe('one');
    expect(git(['show', 'main:two.txt'])).toBe('two');
    expect(git(['show', 'main:three.txt'])).toBe('three');
  });

  it('keeps the post-merge check when another participating run is cancelled during syncing', async () => {
    await group(['one', 'two'], true); await landFirst();
    const checkpoint = service.checkpoint.bind(service);
    vi.spyOn(service, 'checkpoint').mockImplementation(async (item, label) => {
      const updated = await checkpoint(item, label);
      store.upsertRun({ ...store.getRun('other-run')!, status: 'cancelled' });
      return updated;
    });
    await landSecondWithGate();
  });

  it.each(['missing-command', 'different-tree', 'different-group', 'cancelled-run', 'failed-receipt'] as const)(
    'keeps the post-merge check for %s evidence', async condition => {
      await group(['one', 'two'], condition === 'cancelled-run'); await landFirst();
      const second = store.getItem('two')!;
      if (condition === 'missing-command') { run.config.verifierGates.push('npm run lint'); store.upsertRun(run); }
      else if (condition === 'cancelled-run') {
        store.upsertRun({ ...store.getRun('other-run')!, status: 'cancelled' });
      } else {
        const verdict = second.verdict!;
        const receipt = verdict.gatesRun[0];
        if (condition === 'different-tree') receipt.testedTree = git(['rev-parse', 'main^{tree}']);
        if (condition === 'different-group') receipt.checkGroup!.id = 'another-group';
        if (condition === 'failed-receipt') { receipt.exitCode = 1; receipt.classification = 'failed'; }
        save({ ...second, verdict });
      }
      await landSecondWithGate();
    },
  );
});
