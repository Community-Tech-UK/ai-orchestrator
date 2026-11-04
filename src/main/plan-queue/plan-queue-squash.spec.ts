import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLandingCommit, commitWithHooks, restoreItemCheckout, returnToItemCheckout } from './plan-queue-squash';
import * as gitCommands from '../workspace/git/git-exec';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { InvalidQueueCheckoutError } from './plan-queue-orphan-checkout';
import { PlanQueueCheckoutOwnershipError } from './plan-queue-worktree';

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-squash-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(['add', 'a.txt']);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
  GitWriteQueue._resetForTesting();
});

describe('landing ownership error boundaries', () => {
  const branch = 'queue/owned';
  let wt: string;
  beforeEach(() => {
    git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-qm', 'base']);
    wt = join(repo, '.worktrees', branch);
    git(['worktree', 'add', '-qb', branch, wt]);
  });

  it.each(['return-proof', 'return-branch', 'restore-proof'] as const)('retains an operational %s error and leaves the checkout untouched', async operation => {
    writeFileSync(join(wt, 'a.txt'), 'unsaved evidence\n');
    git(['add', 'a.txt'], wt);
    const index = join(git(['rev-parse', '--absolute-git-dir'], wt), 'index');
    const before = readFileSync(index);
    const failure = Object.assign(new Error('Git executable unavailable'), { code: 'ENOENT' });
    const execute = gitCommands.gitExec;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation((args, cwd, timeout) => {
      const targeted = operation === 'return-branch' ? args[0] === 'symbolic-ref'
        : args[0] === 'rev-parse' && args.includes('--show-toplevel');
      return targeted ? Promise.reject(failure) : execute(args, cwd, timeout);
    });
    await expect(operation === 'restore-proof' ? restoreItemCheckout(wt, branch, repo)
      : returnToItemCheckout(wt, branch, 'item', repo, ['a.txt'])).rejects.toBe(failure);
    expect(readFileSync(index)).toEqual(before);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('unsaved evidence\n');
    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe(branch);
  });

  it('retains a real ownership refusal through the landing restore wrapper', async () => {
    const error = await restoreItemCheckout(repo, branch, repo).catch(error => error);
    expect(error).toBeInstanceOf(PlanQueueCheckoutOwnershipError);
    expect(error.cause).toBeInstanceOf(InvalidQueueCheckoutError);
    expect(error.cause.cause).toBeInstanceOf(Error);
  });

  it('makes no fallback file removals when restore cannot prove ownership', async () => {
    const failure = Object.assign(new Error('Ownership read timed out'), { code: 'ETIMEDOUT' });
    const execute = gitCommands.gitExec;
    let restoring = false;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation((args, cwd, timeout) => {
      if (args[0] === 'merge') {
        writeFileSync(join(wt, 'copied_completed.md'), 'Retain this copied evidence.\n');
        restoring = true;
        return Promise.reject(new Error('Interrupted squash'));
      }
      if (restoring && args[0] === 'rev-parse' && args.includes('--show-toplevel')) return Promise.reject(failure);
      return execute(args, cwd, timeout);
    });
    await expect(buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName: branch, itemId: 'item',
      baseTip: git(['rev-parse', 'HEAD']), message: 'Plan: owned',
      documents: [{ relativePath: 'copied_completed.md', content: 'Retain this copied evidence.\n' }] })).rejects.toBe(failure);
    expect(existsSync(join(wt, 'copied_completed.md'))).toBe(true);
  });

  it('preserves the cause when restoration fails after ownership was proven', async () => {
    const failure = new Error('Read-tree failed during restore');
    const execute = gitCommands.gitExec;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation((args, cwd, timeout) =>
      args[0] === 'read-tree' ? Promise.reject(failure) : execute(args, cwd, timeout));
    const error = await buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName: branch, itemId: 'item',
      baseTip: git(['rev-parse', 'HEAD']), message: 'Plan: owned', documents: [] }).catch(error => error);
    expect(error.message).toContain('Landing stopped part-way');
    expect(error.cause).toBe(failure);
  });

  it('preserves a typed ownership refusal if the checkout disappears during restoration', async () => {
    const execute = gitCommands.gitExec;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation((args, cwd, timeout) => {
      if (args[0] === 'merge') writeFileSync(join(wt, 'copied_completed.md'), 'Retain this copied evidence.\n');
      if (args[0] === 'read-tree') {
        rmSync(join(wt, '.git'));
        return Promise.reject(new Error('Restore interrupted after the checkout disappeared'));
      }
      return execute(args, cwd, timeout);
    });
    const error = await buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName: branch, itemId: 'item',
      baseTip: git(['rev-parse', 'HEAD']), message: 'Plan: owned',
      documents: [{ relativePath: 'copied_completed.md', content: 'Retain this copied evidence.\n' }] }).catch(error => error);
    expect(error).toBeInstanceOf(PlanQueueCheckoutOwnershipError);
    expect(error.cause).toBeInstanceOf(InvalidQueueCheckoutError);
    expect(readFileSync(join(wt, 'copied_completed.md'), 'utf8')).toBe('Retain this copied evidence.\n');
  });
});

describe('commitWithHooks', () => {
  it.skipIf(process.platform === 'win32')('kills the whole hook process tree on a timeout, not just git', async () => {
    const pidFile = join(repo, '.git', 'grandchild.pid');
    const hooks = join(repo, '.git', 'test-hooks');
    mkdirSync(hooks, { recursive: true });
    // The hook starts a long-running descendant (like a generator or vitest) and waits.
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nwait\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);

    const started = Date.now();
    const result = await commitWithHooks(repo, 'timed out', 1_500);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('timed out after 1500ms');
    expect(result.timedOut).toBe(true);
    // Resolves at the timeout, not when an orphan finally lets go of the output pipe.
    expect(Date.now() - started).toBeLessThan(20_000);
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    await vi.waitFor(() => { if (isAlive(grandchild)) throw new Error('hook descendant still running'); }, { timeout: 5_000 });
    expect(() => git(['rev-parse', '-q', '--verify', 'HEAD'])).toThrow();
  }, 20_000);

  it('commits when the hook passes', async () => {
    const result = await commitWithHooks(repo, 'ok');

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeUndefined();
    expect(git(['log', '--format=%s'])).toBe('ok');
  });
});
