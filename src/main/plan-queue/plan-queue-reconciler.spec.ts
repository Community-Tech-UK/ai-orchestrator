import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcilePlanQueueWorktrees } from './plan-queue-reconciler';
import type { PlanQueueItem } from './plan-queue.types';

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function addWorktree(branch: string): string {
  const worktreePath = join(repo, '.worktrees', branch);
  git(['worktree', 'add', '-q', '-b', branch, worktreePath, 'main']);
  return worktreePath;
}

function makeItem(overrides: Partial<PlanQueueItem>): PlanQueueItem {
  return {
    id: 'item-1',
    runId: 'run-1',
    documentPath: join(repo, 'docs/a_plan.md'),
    state: 'working',
    round: 0,
    erroredRounds: 0,
    landingRefusals: 0,
    branchName: null,
    worktreePath: null,
    baseCommit: null,
    checkpointCommit: null,
    verifiedMainCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question: null,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-rec-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('reconcilePlanQueueWorktrees', () => {
  it('reports nothing when every queue worktree and branch has a row', async () => {
    const worktreePath = addWorktree('queue/owned-abc123');

    const alerts = await reconcilePlanQueueWorktrees(
      [repo],
      [makeItem({ branchName: 'queue/owned-abc123', worktreePath })],
    );

    expect(alerts).toEqual([]);
  });

  it('reports a queue worktree and branch that no row owns', async () => {
    const worktreePath = addWorktree('queue/stray-000000');

    const alerts = await reconcilePlanQueueWorktrees([repo], []);

    expect(alerts).toEqual([
      { kind: 'unowned-worktree', path: worktreePath, branchName: 'queue/stray-000000' },
      { kind: 'unowned-branch', branchName: 'queue/stray-000000' },
    ]);
  });

  it('ignores loop and hand-made worktrees entirely, even with uncommitted work', async () => {
    const loopWorktree = addWorktree('task-please-work-through-mt76ztv1');
    writeFileSync(join(loopWorktree, 'stranded.txt'), 'not ours\n');
    git(['branch', 'feature/something']);
    // A sibling directory whose name merely starts with the queue's: a plain
    // prefix match would claim it, but the queue never created it.
    addWorktree('queue-manual-experiment');

    const alerts = await reconcilePlanQueueWorktrees([repo], []);

    expect(alerts).toEqual([]);
  });

  it('reports a row whose worktree directory has vanished', async () => {
    const worktreePath = addWorktree('queue/gone-abc123');
    git(['worktree', 'remove', '--force', worktreePath]);

    const alerts = await reconcilePlanQueueWorktrees(
      [repo],
      [makeItem({ branchName: 'queue/gone-abc123', worktreePath })],
    );

    expect(alerts).toEqual([
      { kind: 'missing-worktree', path: worktreePath, branchName: 'queue/gone-abc123', itemId: 'item-1' },
    ]);
  });

  it('does not report a parked item, which keeps its branch and has no worktree', async () => {
    git(['branch', 'queue/parked-abc123']);

    const alerts = await reconcilePlanQueueWorktrees(
      [repo],
      [makeItem({ state: 'parked', branchName: 'queue/parked-abc123', worktreePath: null })],
    );

    expect(alerts).toEqual([]);
  });

  it('resolves a workspace that is a subdirectory, and skips one that no longer exists', async () => {
    addWorktree('queue/stray-000000');
    execFileSync('mkdir', ['-p', join(repo, 'packages/app')]);

    const alerts = await reconcilePlanQueueWorktrees(
      [join(repo, 'packages/app'), join(repo, 'packages/app'), '/nonexistent/plan-queue'],
      [],
    );

    expect(alerts.map((a) => a.kind)).toEqual(['unowned-worktree', 'unowned-branch']);
  });

  it('never changes the repository', async () => {
    const worktreePath = addWorktree('queue/stray-000000');
    writeFileSync(join(worktreePath, 'dirty.txt'), 'keep me\n');
    const before = git(['worktree', 'list', '--porcelain']) + git(['for-each-ref']);

    await reconcilePlanQueueWorktrees([repo], []);

    expect(git(['worktree', 'list', '--porcelain']) + git(['for-each-ref'])).toBe(before);
    expect(git(['status', '--porcelain'], worktreePath)).toBe('?? dirty.txt');
  });
});
