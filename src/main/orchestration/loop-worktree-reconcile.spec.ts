/**
 * P3 acceptance (boot reconcile): orphaned worktrees left by terminal loops are
 * reconciled on boot — dirty work harvested to its branch before reap, clean
 * trees reaped, already-gone dirs just cleared, and a worktree whose harvest
 * commit FAILS is preserved (not force-removed) so no agent work is lost.
 *
 * Real git against a temp repo + real worktrees; the store is a small fake so we
 * control exactly which orphan rows the reconcile sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reconcileOrphanedWorktrees,
  type WorktreeReconcileStore,
} from './loop-worktree-reconcile';
import { hermeticGitEnv } from '../workspace/git/git-env';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf-8' });
  return stdout.trim();
}

type Orphan = ReturnType<WorktreeReconcileStore['getTerminalRunsWithWorktreePaths']>[number];

function fakeStore(orphans: Orphan[]): { store: WorktreeReconcileStore; cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    store: {
      getTerminalRunsWithWorktreePaths: () => orphans,
      clearWorktreeInfo: (id: string) => { cleared.push(id); },
    },
  };
}

let repo: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'recon-'));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  writeFileSync(join(repo, 'README.md'), '# seed\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '--no-gpg-sign', '-m', 'seed'], repo);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ }
});

async function addWorktree(branch: string): Promise<string> {
  const wtPath = join(repo, '.worktrees', branch);
  await git(['worktree', 'add', '-q', '-b', branch, wtPath, 'main'], repo);
  return wtPath;
}

function orphan(repoRoot: string, wtPath: string, branch: string, id: string): Orphan {
  return { id, worktreePath: wtPath, branchName: branch, workspaceCwd: repoRoot, status: 'cancelled' };
}

describe('reconcileOrphanedWorktrees', () => {
  it('harvests a dirty orphan to its branch, then reaps the dir and clears the pointer', async () => {
    const branch = 'task-recon-dirty';
    const wt = await addWorktree(branch);
    writeFileSync(join(wt, 'leftover.ts'), 'uncommitted agent work\n');

    const { store, cleared } = fakeStore([orphan(repo, wt, branch, 'run-dirty')]);
    const result = await reconcileOrphanedWorktrees(store);

    expect(result).toEqual({ reaped: 1, total: 1 });
    // The uncommitted work was harvested onto the branch before reap.
    const files = await git(['ls-tree', '-r', '--name-only', branch], repo);
    expect(files).toContain('leftover.ts');
    // Dir removed, DB pointer cleared.
    expect(existsSync(wt)).toBe(false);
    expect(cleared).toEqual(['run-dirty']);
  });

  it('reaps a clean orphan and clears the pointer', async () => {
    const branch = 'task-recon-clean';
    const wt = await addWorktree(branch);

    const { store, cleared } = fakeStore([orphan(repo, wt, branch, 'run-clean')]);
    const result = await reconcileOrphanedWorktrees(store);

    expect(result).toEqual({ reaped: 1, total: 1 });
    expect(existsSync(wt)).toBe(false);
    expect(cleared).toEqual(['run-clean']);
  });

  it('clears the pointer for an orphan whose directory is already gone (no throw)', async () => {
    const ghost = join(repo, '.worktrees', 'task-recon-ghost');
    const { store, cleared } = fakeStore([orphan(repo, ghost, 'task-recon-ghost', 'run-ghost')]);

    const result = await reconcileOrphanedWorktrees(store);

    // Not "reaped" (nothing to remove) but the stale pointer is cleared.
    expect(result).toEqual({ reaped: 0, total: 1 });
    expect(cleared).toEqual(['run-ghost']);
  });

  it('preserves a dirty orphan when the harvest commit fails (does NOT clear or remove)', async () => {
    // A failing pre-commit hook makes the harvest commit fail. The reconcile
    // commit deliberately does NOT pass --no-verify, so the hook runs.
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);

    const branch = 'task-recon-preserve';
    const wt = await addWorktree(branch);
    writeFileSync(join(wt, 'precious.ts'), 'work that must not be lost\n');

    const { store, cleared } = fakeStore([orphan(repo, wt, branch, 'run-preserve')]);
    const result = await reconcileOrphanedWorktrees(store);

    // Harvest failed → tree still dirty → preserve: not reaped, dir intact,
    // pointer left set so it reappears on the next boot for manual recovery.
    expect(result).toEqual({ reaped: 0, total: 1 });
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, 'precious.ts'))).toBe(true);
    expect(cleared).toEqual([]);
  });

  it('processes a mixed batch independently (one failure does not abort the rest)', async () => {
    const okBranch = 'task-recon-ok';
    const okWt = await addWorktree(okBranch);
    writeFileSync(join(okWt, 'ok.ts'), 'committed work\n');
    const ghost = join(repo, '.worktrees', 'task-recon-missing');

    const { store, cleared } = fakeStore([
      orphan(repo, okWt, okBranch, 'run-ok'),
      orphan(repo, ghost, 'task-recon-missing', 'run-missing'),
    ]);
    const result = await reconcileOrphanedWorktrees(store);

    expect(result).toEqual({ reaped: 1, total: 2 });
    expect(existsSync(okWt)).toBe(false);
    expect(cleared.sort()).toEqual(['run-missing', 'run-ok']);
  });
});
