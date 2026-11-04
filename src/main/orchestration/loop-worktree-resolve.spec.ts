import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { resolveBlockedLoopWorktree, type LoopWorktreeResolveStore } from './loop-worktree-resolve';

vi.setConfig({ testTimeout: 30_000 });

let dir: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: hermeticGitEnv(), stdio: 'ignore' });
}

function blocked(): LoopWorktreeLifecycle {
  return {
    managedByAio: true,
    phase: 'blocked',
    baseBranch: 'main',
    sessionBranch: 'task-loop',
    sessionTip: 'abc',
    lastError: 'Harvest failed with uncommitted work',
    updatedAt: 1,
  };
}

function fakeStore(record: ReturnType<LoopWorktreeResolveStore['getWorktreeRecord']>) {
  const updates: LoopWorktreeLifecycle[] = [];
  const cleared: string[] = [];
  const store: LoopWorktreeResolveStore = {
    getWorktreeRecord: () => record,
    updateWorktreeLifecycle: (_id, lifecycle) => {
      updates.push(lifecycle);
    },
    clearWorktreeInfo: (id) => {
      cleared.push(id);
    },
  };
  return { store, updates, cleared };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-resolve-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'base'], dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveBlockedLoopWorktree', () => {
  it('marks a blocked run with a clean worktree folder resolved without touching Git', async () => {
    const { store, updates } = fakeStore({ worktreePath: dir, workspaceCwd: null, lifecycle: blocked() });

    const result = await resolveBlockedLoopWorktree(store, 'loop-1', 500);

    expect(result).toEqual({ status: 'resolved', lifecycle: updates[0] });
    expect(updates).toEqual([{
      ...blocked(),
      phase: 'cleaned',
      resolvedByOperatorAt: 500,
      updatedAt: 500,
    }]);
  });

  it('removes the clean folder of a blocked run it can prove is its own, keeping the branch', async () => {
    const worktree = join(dir, '.worktrees', 'task-loop');
    git(['worktree', 'add', '-q', '-b', 'task-loop', worktree, 'main'], dir);
    const lifecycle = { ...blocked(), managedByAio: true as const };
    const { store, updates, cleared } = fakeStore({ worktreePath: worktree, workspaceCwd: dir, lifecycle });

    await expect(resolveBlockedLoopWorktree(store, 'loop-1', 9)).resolves.toMatchObject({ status: 'resolved' });

    expect(existsSync(worktree)).toBe(false);
    expect(cleared).toEqual(['loop-1']);
    expect(execFileSync('git', ['branch', '--list', 'task-loop'], { cwd: dir, encoding: 'utf8' })).toContain('task-loop');
    expect(updates[0]).toMatchObject({ phase: 'cleaned', resolvedByOperatorAt: 9 });
  });

  it('leaves a folder it cannot prove is its own and still resolves the run', async () => {
    // A clean checkout of this branch, but outside Harness's managed .worktrees folder.
    const outside = join(mkdtempSync(join(tmpdir(), 'loop-resolve-outside-')), 'checkout');
    git(['worktree', 'add', '-q', '-b', 'task-loop', outside, 'main'], dir);
    try {
      const { store, updates, cleared } = fakeStore({ worktreePath: outside, workspaceCwd: dir, lifecycle: blocked() });
      await expect(resolveBlockedLoopWorktree(store, 'loop-1')).resolves.toMatchObject({ status: 'resolved' });
      expect(existsSync(outside)).toBe(true);
      expect(cleared).toEqual([]);
      expect(updates[0]).toMatchObject({ phase: 'cleaned' });
    } finally { rmSync(join(outside, '..'), { recursive: true, force: true }); }
  });

  it('resolves a blocked run whose worktree folder is already gone', async () => {
    const { store, updates } = fakeStore({
      worktreePath: join(dir, 'removed-folder'),
      workspaceCwd: dir,
      lifecycle: blocked(),
    });

    await expect(resolveBlockedLoopWorktree(store, 'loop-1', 7)).resolves.toMatchObject({
      status: 'resolved',
    });
    expect(updates[0]).toMatchObject({ phase: 'cleaned', resolvedByOperatorAt: 7 });
  });

  it('refuses while the worktree folder still holds uncommitted work', async () => {
    writeFileSync(join(dir, 'unsaved.txt'), 'work\n');
    const { store, updates } = fakeStore({ worktreePath: dir, workspaceCwd: null, lifecycle: blocked() });

    await expect(resolveBlockedLoopWorktree(store, 'loop-1')).resolves.toEqual({
      status: 'refused',
      reason: 'The worktree folder still has uncommitted changes; commit or discard them first',
    });
    expect(updates).toEqual([]);
  });

  it.each<[string, ReturnType<LoopWorktreeResolveStore['getWorktreeRecord']>, string]>([
    ['an unknown run', null, 'Loop run not found'],
    ['a run without a managed worktree', { worktreePath: null, workspaceCwd: null }, 'Only a blocked managed worktree can be marked resolved'],
    [
      'a run that is not blocked',
      { worktreePath: null, workspaceCwd: null, lifecycle: { ...blocked(), phase: 'integrating' } },
      'Only a blocked managed worktree can be marked resolved',
    ],
  ])('refuses %s', async (_label, record, reason) => {
    const { store, updates } = fakeStore(record);

    await expect(resolveBlockedLoopWorktree(store, 'loop-1')).resolves.toEqual({
      status: 'refused',
      reason,
    });
    expect(updates).toEqual([]);
  });
});
