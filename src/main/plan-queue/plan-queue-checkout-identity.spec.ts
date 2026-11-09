import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import { newPlanQueueItem } from './plan-queue-state';
import { revertToSnapshot } from './plan-queue-git';
import { syncItemWithBase } from './plan-queue-landing';
import { restoreCheckpointAfterVerification } from './plan-queue-run-hold';
import { returnToItemCheckout, restoreItemCheckout } from './plan-queue-squash';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let dir: string;
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repository(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Queue Fixture');
  git(repo, 'config', 'user.email', 'queue@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  return repo;
}
function snapshot(repo: string) {
  return { head: git(repo, 'rev-parse', 'HEAD'), index: readFileSync(git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index')),
    status: git(repo, 'status', '--porcelain'), file: readFileSync(join(repo, 'base.txt'), 'utf8') };
}
beforeEach(() => {
  GitWriteQueue._resetForTesting();
  dir = realpathSync(mkdtempSync(join(process.cwd(), '_scratch', 'checkout-identity-')));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); GitWriteQueue._resetForTesting(); });

describe('queue ownership is proven before any mutation', () => {
  it('checkpoints a valid item without following a symlink in its root history', async () => {
    const repo = repository('owner');
    const branch = 'queue/example-item';
    const wt = join(repo, '.worktrees', branch);
    git(repo, 'worktree', 'add', '-qb', branch, wt);
    const sourceRef = join(repo, 'example_plan.md');
    const document = '# Plan\n## Status\nActive\n## Status\nActive\n## As-built\n### 3 November\nKeep this journal.\n';
    const unrelated = join(dir, 'unrelated.md');
    const history = join(repo, 'example_history.md');
    writeFileSync(sourceRef, document); writeFileSync(unrelated, 'Unrelated bytes\n'); symlinkSync(unrelated, history);
    const before = snapshot(repo);
    writeFileSync(join(wt, 'base.txt'), 'item work\n');
    const service = new PlanQueueWorktreeService({ repoRootForItem: () => repo, saveItem: () => undefined,
      creator: { getAllSessions: () => [], createWorktree: async () => { throw new Error('unused'); }, cleanupWorktree: async () => undefined } });
    const item = newPlanQueueItem('item', 'run', sourceRef, 1, { branchName: branch, worktreePath: wt });
    const checkpoint = await service.checkpoint(item, 'paused');
    expect(checkpoint.checkpointCommit).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(git(wt, 'show', 'HEAD:base.txt')).toBe('item work');
    expect(snapshot(repo)).toEqual(before);
    expect(readFileSync(sourceRef, 'utf8')).toBe(document);
    expect(readFileSync(unrelated, 'utf8')).toBe('Unrelated bytes\n');
    expect(lstatSync(history).isSymbolicLink()).toBe(true);
  });

  it.each(['revert', 'restore', 'sync', 'landing', 'landing-restore'] as const)('refuses %s before verification or parking can write to a foreign checkout', async operation => {
    const repo = repository('owner');
    const foreign = repository('foreign');
    const branch = 'queue/example-item';
    const wt = join(repo, '.worktrees', branch);
    git(foreign, 'worktree', 'add', '-qb', branch, wt);
    const head = git(wt, 'rev-parse', 'HEAD');
    writeFileSync(join(wt, 'base.txt'), 'foreign edit\n');
    git(wt, 'add', 'base.txt');
    const item = newPlanQueueItem('item', 'run', join(repo, 'example_plan.md'), 1,
      { branchName: branch, worktreePath: wt, checkpointCommit: head });
    const before = [snapshot(repo), snapshot(foreign), snapshot(wt)];
    const refused = await (operation === 'revert' ? revertToSnapshot(wt, { head, status: [] }, repo, branch)
      : operation === 'restore' ? restoreCheckpointAfterVerification(item, repo)
      : operation === 'landing' ? returnToItemCheckout(wt, branch, item.id, repo)
      : operation === 'landing-restore' ? restoreItemCheckout(wt, branch, repo, 'item-1') : syncItemWithBase(item, 'main', repo))
      .then(() => false, () => true);
    expect([snapshot(repo), snapshot(foreign), snapshot(wt)]).toEqual(before);
    expect(refused).toBe(true);
  });

  it.each(['checkpoint', 'reattach', 'remove', 'remove-clean'] as const)('refuses %s in a foreign repository on the same branch', async operation => {
    const repo = repository('owner');
    const foreign = repository('foreign');
    const branch = 'queue/example-item';
    const wt = join(repo, '.worktrees', branch);
    git(foreign, 'worktree', 'add', '-qb', branch, wt);
    const sourceRef = join(repo, 'example_plan.md');
    const document = '# Plan\n## Status\nActive\n## Status\nActive\n## As-built\n### 2026-11-02\nKeep this journal.\n';
    writeFileSync(sourceRef, document);
    // A landing marker makes the old recovery path mutate even before its late ownership check.
    writeFileSync(join(git(wt, 'rev-parse', '--absolute-git-dir'), 'plan-queue-landing'), git(wt, 'rev-parse', 'HEAD'));
    if (operation !== 'remove-clean') {
      writeFileSync(join(wt, 'base.txt'), 'foreign edit\n');
      git(wt, 'add', 'base.txt');
    }
    const item = newPlanQueueItem('item', 'run', sourceRef, 1, { branchName: branch, worktreePath: wt,
      checkpointCommit: git(wt, 'rev-parse', 'HEAD'), state: 'parked' });
    const before = [snapshot(repo), snapshot(foreign), snapshot(wt)];
    const stopLeftoversIn = vi.fn(async () => 0);
    const cleanupWorktree = vi.fn(async () => undefined);
    const service = new PlanQueueWorktreeService({ repoRootForItem: () => repo, saveItem: () => undefined,
      stopLeftoversIn, creator: { getAllSessions: () => [], createWorktree: async () => { throw new Error('unused'); }, cleanupWorktree } });
    const outcome = await (operation === 'checkpoint' ? service.checkpoint(item, 'paused')
      : operation === 'reattach' ? service.reattach(item, repo) : service.removeWithProof(item, repo))
      .then(result => 'removed' in result && !result.removed ? 'refused' : 'accepted', () => 'refused');
    expect([snapshot(repo), snapshot(foreign), snapshot(wt)]).toEqual(before);
    expect(readFileSync(sourceRef, 'utf8')).toBe(document);
    expect(existsSync(join(repo, 'example_history.md'))).toBe(false);
    expect(stopLeftoversIn).not.toHaveBeenCalled(); expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(outcome).toBe('refused');
  });

  it.each(['half-removed', 'invalid-registration'] as const)('refuses a %s checkout before moving the root journal', async scenario => {
    const repo = repository('owner');
    const branch = 'queue/example-item';
    const wt = join(repo, '.worktrees', branch);
    git(repo, 'worktree', 'add', '-qb', branch, wt);
    if (scenario === 'half-removed') {
      for (const file of ['.git', 'base.txt']) rmSync(join(wt, file));
      mkdirSync(join(wt, 'node_modules'));
    } else {
      writeFileSync(join(git(wt, 'rev-parse', '--absolute-git-dir'), 'gitdir'), `${join(dir, 'absent', '.git')}\n`);
    }
    const sourceRef = join(repo, 'example_plan.md');
    const document = '# Plan\n## Status\nActive\n## Status\nActive\n## As-built\n### 2026-11-02\nKeep this journal.\n';
    writeFileSync(sourceRef, document);
    const before = snapshot(repo);
    const service = new PlanQueueWorktreeService({ repoRootForItem: () => repo, saveItem: () => undefined,
      creator: { getAllSessions: () => [], createWorktree: async () => { throw new Error('unused'); }, cleanupWorktree: async () => undefined } });
    const item = newPlanQueueItem('item', 'run', sourceRef, 1, { branchName: branch, worktreePath: wt });
    const refused = await service.checkpoint(item, 'paused').then(() => false, () => true);
    expect(snapshot(repo)).toEqual(before);
    expect(readFileSync(sourceRef, 'utf8')).toBe(document);
    expect(existsSync(join(repo, 'example_history.md'))).toBe(false);
    expect(refused).toBe(true);
  });
});
