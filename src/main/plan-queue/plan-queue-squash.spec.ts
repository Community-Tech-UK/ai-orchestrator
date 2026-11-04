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
  vi.unstubAllEnvs();
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
      documents: [{ relativePath: 'copied_completed.md', content: 'Retain this copied evidence.\n' }], greenTestedTree: null })).rejects.toBe(failure);
    expect(existsSync(join(wt, 'copied_completed.md'))).toBe(true);
  });

  it('preserves the cause when restoration fails after ownership was proven', async () => {
    const failure = new Error('Read-tree failed during restore');
    const execute = gitCommands.gitExec;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation((args, cwd, timeout) =>
      args[0] === 'read-tree' ? Promise.reject(failure) : execute(args, cwd, timeout));
    const error = await buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName: branch, itemId: 'item',
      baseTip: git(['rev-parse', 'HEAD']), message: 'Plan: owned', documents: [], greenTestedTree: null }).catch(error => error);
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
      documents: [{ relativePath: 'copied_completed.md', content: 'Retain this copied evidence.\n' }], greenTestedTree: null }).catch(error => error);
    expect(error).toBeInstanceOf(PlanQueueCheckoutOwnershipError);
    expect(error.cause).toBeInstanceOf(InvalidQueueCheckoutError);
    expect(readFileSync(join(wt, 'copied_completed.md'), 'utf8')).toBe('Retain this copied evidence.\n');
  });
});

describe('landing duplicate-test evidence', () => {
  let wt: string;
  let baseTip: string;
  let greenTestedTree: string;
  const branchName = 'queue/checked';
  beforeEach(() => {
    git(['commit', '--no-verify', '-qm', 'base']);
    baseTip = git(['rev-parse', 'HEAD']);
    wt = join(repo, '.worktrees', branchName);
    git(['worktree', 'add', '-qb', branchName, wt]);
    writeFileSync(join(wt, 'feature.txt'), 'checked code\n');
    git(['add', '.'], wt); git(['commit', '--no-verify', '-qm', 'checked'], wt);
    greenTestedTree = git(['rev-parse', 'HEAD^{tree}'], wt);
    const hooks = join(repo, '.git', 'proof-hooks'); mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "%s\\n%s\\n" "${AIO_PLAN_QUEUE_TESTS_COVERED:-unset}" "${AIO_PLAN_QUEUE_TESTS_COVERED_TREE:-unset}" > "$(git rev-parse --git-common-dir)/captured-proof"\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755); git(['config', 'core.hooksPath', hooks]);
  });

  it('passes proof for identical checked code plus only explicit closed documents', async () => {
    const result = await buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName, itemId: 'item', baseTip,
      message: 'Plan: checked', greenTestedTree, documents: [
        { relativePath: 'docs/checked_plan_completed.md', content: '# Done\n' },
        { relativePath: 'docs/checked_plan_closure_completed.json', content: '{}\n' },
      ] });
    expect(result.status).toBe('committed');
    const proof = readFileSync(join(repo, '.git', 'captured-proof'), 'utf8').trim().split('\n');
    expect(proof[0]).toBe('1');
    expect(proof[1]).toBe(git(['rev-parse', `${result.status === 'committed' ? result.commit : ''}^{tree}`]));
  });

  it.each(['feature.txt', 'unrelated_plan_completed.md'])('keeps hook tests when an unapproved path differs: %s', async file => {
    writeFileSync(join(wt, file), 'later untested bytes\n');
    git(['add', file], wt); git(['commit', '--no-verify', '-qm', 'changed after checks'], wt);
    const result = await buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName, itemId: 'item', baseTip,
      message: 'Plan: changed', greenTestedTree, documents: [] });
    expect(result.status).toBe('committed');
    expect(readFileSync(join(repo, '.git', 'captured-proof'), 'utf8')).toBe('unset\nunset\n');
  });

  it('freezes the proved tree before a racing index change can be included', async () => {
    const execute = gitCommands.gitExec;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation(async (args, cwd, timeout) => {
      const result = await execute(args, cwd, timeout);
      if (args[0] === 'diff-index' || args[0] === 'diff-tree') {
        writeFileSync(join(wt, 'feature.txt'), 'changed after the comparison\n');
        git(['add', 'feature.txt'], wt);
      }
      return result;
    });
    const result = await buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName, itemId: 'item', baseTip,
      message: 'Plan: racing index', greenTestedTree, documents: [] });
    expect(result.status).toBe('committed');
    const proof = readFileSync(join(repo, '.git', 'captured-proof'), 'utf8').trim().split('\n');
    expect(proof[0]).toBe('1');
    // The real hook rejects this mismatch and runs its tests (covered in the hook runner spec).
    expect(proof[1]).not.toBe(git(['rev-parse', `${result.status === 'committed' ? result.commit : ''}^{tree}`]));
  });

  it('does not trust inherited duplicate-test flags when evidence is absent', async () => {
    vi.stubEnv('AIO_PLAN_QUEUE_TESTS_COVERED', '1');
    vi.stubEnv('AIO_PLAN_QUEUE_TESTS_COVERED_TREE', greenTestedTree);
    const result = await buildLandingCommit({ repoRoot: repo, worktreePath: wt, branchName, itemId: 'item', baseTip,
      message: 'Plan: no evidence', greenTestedTree: null, documents: [] });
    expect(result.status).toBe('committed');
    expect(readFileSync(join(repo, '.git', 'captured-proof'), 'utf8')).toBe('unset\nunset\n');
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
    const result = await commitWithHooks(repo, 'timed out', null, 1_500);

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
    const result = await commitWithHooks(repo, 'ok', null);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeUndefined();
    expect(git(['log', '--format=%s'])).toBe('ok');
  });
});
