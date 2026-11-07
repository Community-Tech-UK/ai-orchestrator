import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueStore } from './plan-queue-store';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { appendParkedNote } from './plan-queue-doc-close';
import { createDocumentOverlapResolver } from './plan-queue-doc-merge';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueGateRunner } from './plan-queue-gate-receipts';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

let repo: string;
let db: SqliteDriver;
beforeAll(() => initSqliteWasm());
const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(async () => {
  GitWriteQueue._resetForTesting();
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  repo = realpathSync(await mkdtemp(join(tmpdir(), 'queue-retry-landing-')));
  await writeFile(join(repo, 'x_plan.md'), '# Plan\n');
});
afterEach(async () => { db.close(); vi.restoreAllMocks(); await rm(repo, { recursive: true, force: true }); GitWriteQueue._resetForTesting(); });
vi.setConfig({ testTimeout: 30_000 });

function fixture(patch: Partial<PlanQueueItem> = {}) {
  let item = newPlanQueueItem('item-1', 'run-1', join(repo, 'x_plan.md'), 1, {
    state: 'parked', parkReason: 'land-blocked', round: 2, branchName: 'queue/item-1',
    verifiedMainCommit: 'base-verified', landedCommit: 'recorded-commit',
    verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] }, ...patch,
  });
  const run: PlanQueueRun = {
    id: 'run-1', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', postMergeGate: [], verifierGates: [] },
    relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null,
  };
  const store = new PlanQueueStore(db); store.upsertRun(run); store.upsertItem(item);
  store.history.recordVerdict({ itemId: item.id, runId: item.runId, round: item.round, verdict: 'PASS',
    findings: [], gatesRun: [], notChecked: [], worktreeHead: item.checkpointCommit,
    documentReview: { version: 1, documentSha256: createHash('sha256').update(readFileSync(item.documentPath)).digest('hex'), linkedSpecSha256: [null, null] },
    documentSha256: createHash('sha256').update(readFileSync(item.documentPath)).digest('hex') });
  const save = (next: PlanQueueItem) => { item = next; store.upsertItem(next); return item; };
  const reattach = vi.fn(async (next: PlanQueueItem) => save({ ...next, worktreePath: join(repo, 'wt') }));
  const worktrees = { reattach, checkpoint: async (next: PlanQueueItem) => next, preflightPlanningFiles: async () => ({ moved: [], beside: [], failed: [] }), };
  const host = {
    store, history: store.history, instances: { getInstance: () => undefined }, tracker: {}, worktrees,
    getRun: () => run, getItem: () => item, save,
    transition: (next: PlanQueueItem, state: PlanQueueItem['state'], values: Partial<PlanQueueItem> = {}) => save({ ...next, ...values, state }),
    requestPump: vi.fn(), resolveRunParent: () => undefined,
  } as unknown as PlanQueueFlowHost;
  const flow = new PlanQueueItemFlow(host);
  return { host, flow, reattach, run, save, get: () => item, worktrees, store };
}

describe('verified retry landing', () => {
  async function interruptedPromotion() {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']);
    git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
    const baseText = '# Register\nBase.\n';
    await writeFile(join(repo, 'register.md'), baseText); git(['add', 'register.md']); git(['commit', '-qm', 'base']);
    const baseTip = git(['rev-parse', 'HEAD']);
    await writeFile(join(repo, 'register.md'), baseText + '\n## Item\nWorker edits.\n');
    git(['add', 'register.md']); git(['commit', '-qm', 'item']); const integrationTip = git(['rev-parse', 'HEAD']);
    git(['branch', 'integration/item', integrationTip]); git(['reset', '--hard', baseTip]);
    await writeFile(join(repo, 'register.md'), baseText + '\n## Ours\nUser edits.\n');
    const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare({ repoRoot: repo, baseTip, integrationTip, overlaps: [{ path: 'register.md', status: ' M' }] });
    expect(prepared.ok).toBe(true);
    git(['merge', '--ff-only', 'integration/item']); // Simulated crash before finish().
    return fixture({ state: 'landing', parkReason: null, branchName: null, baseCommit: baseTip, verifiedMainCommit: baseTip, landedCommit: integrationTip });
  }

  it('restores a pending merged document before finalizing an already-landed retry', async () => {
    const test = await interruptedPromotion();
    await test.flow.enqueueLanding('item-1'); await test.flow.whenSettled();
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toContain('User edits.');
    expect(test.get().state).toBe('landed');
    expect(test.get().detail).toContain('Merged with your uncommitted edits');
  });

  it('keeps an already-promoted item blocked with its backup visible when recovery is unsafe', async () => {
    const test = await interruptedPromotion();
    await writeFile(join(repo, 'register.md'), 'Later independent edit.\n');
    await test.flow.enqueueLanding('item-1'); await test.flow.whenSettled();
    expect(test.get().state).toBe('parked');
    expect(test.get().detail).toContain('Harness kept a copy of your edits');
    expect(test.get().detail).toContain('doc-merge/item-1');
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe('Later independent edit.\n');
    expect(await readFile(join(repo, '.git/aio-plan-queue/doc-merge/item-1/ours-0'), 'utf8')).toContain('User edits.');
  });

  it('reattaches first, retains PASS/round/base, and enqueues without an operator override', async () => {
    const test = fixture();
    const enqueue = vi.spyOn(test.flow, 'enqueueLanding').mockResolvedValue(undefined);
    test.host.history.recordDocumentTransformation(test.get(), await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'land-blocked', commitCount: 2 }));
    await test.flow.retryLanding('item-1');
    expect(test.get()).toMatchObject({ state: 'landing', verdict: { verdict: 'PASS' }, round: 2,
      verifiedMainCommit: 'base-verified', worktreePath: join(repo, 'wt'), parkReason: null, detail: null });
    expect(enqueue).toHaveBeenCalledWith('item-1');
    expect(await readFile(test.get().documentPath, 'utf8')).not.toContain('Plan Queue parked work');
  });

  it.each([
    { state: 'queued' as const }, { parkReason: 'merge-conflict' as const },
    { verdict: null }, { verdict: { verdict: 'FAIL' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] } },
    { branchName: null },
  ])('refuses an ineligible item before worktree side effects (%j)', async (patch) => {
    const test = fixture(patch);
    await expect(test.flow.retryLanding('item-1')).rejects.toThrow(/land-blocked parked item with a verifier PASS/);
    expect(test.reattach).not.toHaveBeenCalled();
    expect(test.get().state).toBe(patch.state ?? 'parked');
  });

  it('serializes concurrent retry requests so the item lands only once', async () => {
    const test = fixture();
    vi.spyOn(test.flow, 'enqueueLanding').mockResolvedValue(undefined);
    const results = await Promise.allSettled([test.flow.retryLanding('item-1'), test.flow.retryLanding('item-1')]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(test.reattach).toHaveBeenCalledTimes(1);
  });

  describe('when a newer attempt has already merged', () => {
    async function oldAttemptAndNewerMerge() {
      git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']);
      git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
      await writeFile(join(repo, 'a.txt'), 'base\n'); git(['add', 'a.txt']); git(['commit', '-qm', 'base']);
      const base = git(['rev-parse', 'HEAD']);
      git(['checkout', '-qb', 'queue/item-1']); await writeFile(join(repo, 'a.txt'), 'old attempt\n');
      git(['add', 'a.txt']); git(['commit', '-qm', 'old attempt']); const checkpoint = git(['rev-parse', 'HEAD']);
      git(['checkout', '-q', 'main']);
      const test = fixture({ baseCommit: base, checkpointCommit: checkpoint, verifiedMainCommit: base, landedCommit: null });
      test.worktrees.reattach.mockImplementation(async (next) => {
        git(['worktree', 'add', '-q', join(repo, 'wt'), next.branchName!]);
        return test.save({ ...next, worktreePath: join(repo, 'wt') });
      });
      test.store.upsertRun({ ...test.run, id: 'run-2' });
      test.store.upsertItem({ ...test.get(), id: 'newer', runId: 'run-2', state: 'landed', createdAt: test.get().createdAt + 1 });
      return { test, base };
    }

    it('refuses at merge time even though the retry was accepted', async () => {
      const { test, base } = await oldAttemptAndNewerMerge();
      await test.flow.retryLanding('item-1'); await test.flow.whenSettled();
      expect(test.get()).toMatchObject({ state: 'parked', parkReason: 'land-blocked', branchName: 'queue/item-1' });
      expect(test.get().detail).toContain('a newer attempt at this document merged first');
      expect(git(['rev-parse', 'main'])).toBe(base);
    });

    it('also refuses when a newer attempt is set aside but its code already reached main', async () => {
      const { test, base } = await oldAttemptAndNewerMerge();
      await writeFile(join(repo, 'b.txt'), 'newer attempt\n'); git(['add', 'b.txt']); git(['commit', '-qm', 'newer attempt']);
      const onMain = git(['rev-parse', 'HEAD']);
      test.store.upsertItem({ ...test.store.getItem('newer')!, state: 'parked', landedCommit: onMain });

      await test.flow.retryLanding('item-1'); await test.flow.whenSettled();

      expect(test.get()).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
      expect(test.get().detail).toContain('a newer attempt at this document merged first');
      expect(git(['rev-parse', 'main'])).toBe(onMain);
      expect(git(['rev-list', '--count', `${base}..main`])).toBe('1');
    });

    it('ignores a newer attempt whose recorded commit never reached main', async () => {
      const { test } = await oldAttemptAndNewerMerge();
      git(['checkout', '-qb', 'unmerged']); await writeFile(join(repo, 'c.txt'), 'never merged\n');
      git(['add', 'c.txt']); git(['commit', '-qm', 'never merged']); const elsewhere = git(['rev-parse', 'HEAD']); git(['checkout', '-q', 'main']);
      test.store.upsertItem({ ...test.store.getItem('newer')!, state: 'parked', landedCommit: elsewhere });
      Object.assign(test.worktrees, {
        removeWithProof: async () => { git(['worktree', 'remove', '-f', join(repo, 'wt')]); test.save({ ...test.get(), worktreePath: null }); return { removed: true }; },
        deleteBranchWithProof: async () => { git(['branch', '-D', 'queue/item-1']); },
      });

      await test.flow.retryLanding('item-1'); await test.flow.whenSettled();

      expect(test.get().state).toBe('landed');
    });

    it('still merges for Merge without checks, which is the deliberate override', async () => {
      const { test, base } = await oldAttemptAndNewerMerge();
      Object.assign(test.worktrees, {
        removeWithProof: async () => { git(['worktree', 'remove', '-f', join(repo, 'wt')]); test.save({ ...test.get(), worktreePath: null }); return { removed: true }; },
        deleteBranchWithProof: async () => { git(['branch', '-D', 'queue/item-1']); },
      });
      await test.flow.landAnyway('item-1'); await test.flow.whenSettled();
      expect(test.get().state).toBe('landed');
      expect(git(['rev-parse', 'main'])).not.toBe(base);
    });
  });

  it('takes the parked note off on Resume, so a checker never reviews it', async () => {
    const test = fixture({ landedCommit: null });
    await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'round-limit', commitCount: 1 });

    await test.flow.resume('item-1');

    expect(test.get().state).toBe('queued');
    expect(await readFile(test.get().documentPath, 'utf8')).not.toContain('Plan Queue parked work');
  });

  it('forgets cached check results on Resume, so the checks really run again', async () => {
    const forget = vi.spyOn(PlanQueueGateRunner.prototype, 'forgetCommit');
    const test = fixture({ landedCommit: null, checkpointCommit: 'checked-commit' });

    await test.flow.resume('item-1');

    expect(forget).toHaveBeenCalledWith('checked-commit');
  });

  it('leaves the note alone while another attempt at the document is being checked', async () => {
    const test = fixture({ landedCommit: null });
    await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'round-limit', commitCount: 1 });
    vi.spyOn(test.store, 'documentBeingChecked').mockReturnValue(true);

    await test.flow.resume('item-1');

    expect(test.get().state).toBe('queued');
    expect(await readFile(test.get().documentPath, 'utf8')).toContain('Plan Queue parked work');
  });

  it('still sets the job aside with the reason when saving its folder fails too', async () => {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']);
    git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
    await writeFile(join(repo, 'a.txt'), 'base\n'); git(['add', 'a.txt']); git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    git(['worktree', 'add', '-q', '-b', 'queue/item-1', join(repo, 'wt')]);
    const test = fixture({ state: 'landing', parkReason: null, landedCommit: null, worktreePath: join(repo, 'wt'),
      baseCommit: base, checkpointCommit: base, verifiedMainCommit: base });
    const checkpoint = vi.fn(async () => { throw new Error('index is locked'); });
    test.worktrees.checkpoint = checkpoint;

    await test.flow.enqueueLanding('item-1'); await test.flow.whenSettled();

    expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(test.get()).toMatchObject({ state: 'parked', parkReason: 'land-blocked', detail: expect.stringContaining('Landing failed') });
  });

  it('builds the commit again when removing the parked note changed the document it was built from', async () => {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']);
    git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
    await writeFile(join(repo, 'a.txt'), 'base\n'); git(['add', 'a.txt']); git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    const test = fixture({ baseCommit: base, checkpointCommit: base, verifiedMainCommit: base, landedCommit: 'f'.repeat(40) });
    test.host.history.recordDocumentTransformation(test.get(), await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'land-blocked', commitCount: 1 }));
    const landings: (string | null)[] = [];
    vi.spyOn(test.flow, 'enqueueLanding').mockImplementation(async () => { landings.push(test.get().landedCommit); });

    await test.flow.retryLanding('item-1');

    expect(landings).toEqual([null]);
  });

  it('keeps a recorded commit that already reached the base, so the retry only finishes closing', async () => {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']);
    git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
    await writeFile(join(repo, 'a.txt'), 'base\n'); git(['add', 'a.txt']); git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    const test = fixture({ baseCommit: base, checkpointCommit: base, verifiedMainCommit: base, landedCommit: base });
    test.host.history.recordDocumentTransformation(test.get(), await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'land-blocked', commitCount: 1 }));
    const landings: (string | null)[] = [];
    vi.spyOn(test.flow, 'enqueueLanding').mockImplementation(async () => { landings.push(test.get().landedCommit); });

    await test.flow.retryLanding('item-1');

    expect(landings).toEqual([base]);
  });

  it('lands real branch work and a completed document without the override or parked note', async () => {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']);
    git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
    await writeFile(join(repo, 'a.txt'), 'base\n'); git(['add', 'a.txt']); git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-qb', 'queue/item-1']); await writeFile(join(repo, 'a.txt'), 'worker\n');
    git(['add', 'a.txt']); git(['commit', '-qm', 'worker']); const checkpoint = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
    const test = fixture({ baseCommit: base, checkpointCommit: checkpoint, verifiedMainCommit: base, landedCommit: null });
    test.worktrees.reattach.mockImplementation(async (next) => {
      git(['worktree', 'add', '-q', join(repo, 'wt'), next.branchName!]);
      return test.save({ ...next, worktreePath: join(repo, 'wt') });
    });
    Object.assign(test.worktrees, {
      removeWithProof: async () => { git(['worktree', 'remove', '-f', join(repo, 'wt')]); test.save({ ...test.get(), worktreePath: null }); return { removed: true }; },
      deleteBranchWithProof: async () => { git(['branch', '-D', 'queue/item-1']); },
    });
    test.host.history.recordDocumentTransformation(test.get(), await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'land-blocked', commitCount: 1 }));
    await test.flow.retryLanding('item-1'); await test.flow.whenSettled();
    expect(test.get().state).toBe('landed');
    expect(test.get().verdict?.verdict).toBe('PASS');
    expect(test.get().detail ?? '').not.toContain('without a verifier PASS');
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('worker\n');
    expect(await readFile(join(repo, 'x_plan_completed.md'), 'utf8')).not.toContain('Plan Queue parked work');
    expect(git(['rev-list', '--count', `${base}..main`])).toBe('1');
    expect(git(['diff', '--cached', '--name-only'])).toBe('');
  });
});
