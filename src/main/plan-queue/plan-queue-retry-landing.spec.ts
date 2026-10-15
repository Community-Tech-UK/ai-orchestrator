import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { appendParkedNote } from './plan-queue-doc-close';
import { createDocumentOverlapResolver } from './plan-queue-doc-merge';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

let repo: string;
const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(async () => {
  GitWriteQueue._resetForTesting();
  repo = await mkdtemp(join(tmpdir(), 'queue-retry-landing-'));
  await writeFile(join(repo, 'x_plan.md'), '# Plan\n');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(repo, { recursive: true, force: true }); GitWriteQueue._resetForTesting(); });
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
  const save = (next: PlanQueueItem) => { item = next; return item; };
  const reattach = vi.fn(async (next: PlanQueueItem) => save({ ...next, worktreePath: join(repo, 'wt') }));
  const worktrees = { reattach, checkpoint: async (next: PlanQueueItem) => next };
  const host = {
    instances: { getInstance: () => undefined }, tracker: {}, worktrees,
    getRun: () => run, getItem: () => item, save,
    transition: (next: PlanQueueItem, state: PlanQueueItem['state'], values: Partial<PlanQueueItem> = {}) => save({ ...next, ...values, state }),
    requestPump: vi.fn(), resolveRunParent: () => undefined,
  } as unknown as PlanQueueFlowHost;
  const flow = new PlanQueueItemFlow(host);
  return { host, flow, reattach, run, save, get: () => item, worktrees };
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

  it('reattaches first, retains PASS/round/base/commit, and enqueues without an operator override', async () => {
    const test = fixture();
    const enqueue = vi.spyOn(test.flow, 'enqueueLanding').mockResolvedValue(undefined);
    await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'land-blocked', commitCount: 2 });
    await test.flow.retryLanding('item-1');
    expect(test.get()).toMatchObject({ state: 'landing', verdict: { verdict: 'PASS' }, round: 2,
      verifiedMainCommit: 'base-verified', landedCommit: 'recorded-commit', worktreePath: join(repo, 'wt'), parkReason: null, detail: null });
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
    await appendParkedNote(test.get().documentPath, { branchName: 'queue/item-1', reason: 'land-blocked', commitCount: 1 });
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
