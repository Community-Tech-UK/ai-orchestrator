/**
 * P4 acceptance: integration runs in a dedicated detached worktree, never the
 * root checkout. A clean merge produces an isolated integration branch holding
 * the session work; a conflicting merge reports conflict files and leaves no
 * stray worktree or branch behind. Runs against a real temp git repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  integrateViaWorktree,
  integrateIntoSharedBranch,
  tryAdvanceBaseBranch,
  isBranchCheckedOut,
} from './worktree-integration';
import { GitWriteQueue } from './git-write-queue';
import { hermeticGitEnv } from './git-env';

const execFileAsync = promisify(execFile);

// Real git worktree add/merge/remove per test — generous timeout so a loaded
// pre-commit `vitest related` run doesn't trip the default 5s per-test budget.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf-8' });
  return stdout.trim();
}

let repo: string;

async function commitFile(file: string, content: string, msg: string): Promise<void> {
  writeFileSync(join(repo, file), content);
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '--no-gpg-sign', '-m', msg], repo);
}

beforeEach(async () => {
  GitWriteQueue._resetForTesting();
  repo = mkdtempSync(join(tmpdir(), 'wt-integration-'));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  await commitFile('base.txt', 'base\n', 'base commit');
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('integrateViaWorktree', () => {
  it('integrates a session branch onto main without touching the root checkout', async () => {
    // The root worktree stays on `main` the entire time.
    const rootHeadBefore = await git(['rev-parse', 'HEAD'], repo);

    // Create a session branch with new work.
    await git(['checkout', '-q', '-b', 'task-feature'], repo);
    await commitFile('feature.txt', 'feature work\n', 'add feature');
    await git(['checkout', '-q', 'main'], repo);

    const result = await integrateViaWorktree({
      repoRoot: repo,
      baseDir: '.worktrees',
      sessionBranch: 'task-feature',
      targetBranch: 'main',
      strategy: 'auto',
      nonce: 'test1',
    });

    expect(result.success).toBe(true);
    expect(result.integrationBranch).toBe('integration/task-feature');
    expect(result.mergeCommit).toBeTruthy();

    // Root checkout is untouched: still on main, still at the same commit.
    expect(await git(['branch', '--show-current'], repo)).toBe('main');
    expect(await git(['rev-parse', 'HEAD'], repo)).toBe(rootHeadBefore);

    // The integration branch contains the feature work.
    const intFiles = await git(['ls-tree', '--name-only', 'integration/task-feature'], repo);
    expect(intFiles).toContain('feature.txt');

    // The throwaway integration worktree was removed.
    const worktreeList = await git(['worktree', 'list'], repo);
    expect(worktreeList).not.toContain('.integration-');
  });

  it('squash strategy produces a single squashed commit on the integration branch', async () => {
    await git(['checkout', '-q', '-b', 'task-squash'], repo);
    await commitFile('a.txt', 'a\n', 'commit a');
    await commitFile('b.txt', 'b\n', 'commit b');
    await git(['checkout', '-q', 'main'], repo);

    const result = await integrateViaWorktree({
      repoRoot: repo,
      baseDir: '.worktrees',
      sessionBranch: 'task-squash',
      targetBranch: 'main',
      strategy: 'squash',
      nonce: 'test2',
    });

    expect(result.success).toBe(true);
    // integration branch = main + exactly one squash commit.
    const count = await git(['rev-list', '--count', 'main..integration/task-squash'], repo);
    expect(Number(count)).toBe(1);
  });

  it('reports conflict files and cleans up on a conflicting merge', async () => {
    // Both branches edit base.txt differently → conflict.
    await git(['checkout', '-q', '-b', 'task-conflict'], repo);
    await commitFile('base.txt', 'session change\n', 'session edits base');
    await git(['checkout', '-q', 'main'], repo);
    await commitFile('base.txt', 'main change\n', 'main edits base');

    const result = await integrateViaWorktree({
      repoRoot: repo,
      baseDir: '.worktrees',
      sessionBranch: 'task-conflict',
      targetBranch: 'main',
      strategy: 'auto',
      nonce: 'test3',
    });

    expect(result.success).toBe(false);
    expect(result.conflictFiles).toContain('base.txt');

    // No stray integration branch left behind.
    const branches = await git(['branch', '--list', 'integration/task-conflict'], repo);
    expect(branches.trim()).toBe('');

    // No stray worktree dir left behind.
    const wtDir = join(repo, '.worktrees');
    if (existsSync(wtDir)) {
      expect(readdirSync(wtDir).filter((d) => d.startsWith('.integration-'))).toHaveLength(0);
    }
    // Root still clean on main.
    expect(await git(['status', '--porcelain'], repo)).toBe('');
  });

  it('rejects the manual strategy without creating a worktree', async () => {
    const result = await integrateViaWorktree({
      repoRoot: repo,
      baseDir: '.worktrees',
      sessionBranch: 'whatever',
      targetBranch: 'main',
      strategy: 'manual',
      nonce: 'test4',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/manual/i);
  });
});

async function makeSessionBranch(name: string, file: string, content: string): Promise<void> {
  await git(['checkout', '-q', '-b', name, 'main'], repo);
  await commitFile(file, content, `${name}: ${file}`);
  await git(['checkout', '-q', 'main'], repo);
}

describe('integrateIntoSharedBranch (auto-integration)', () => {
  it('creates integration/main and accumulates multiple sessions without touching root', async () => {
    const rootHeadBefore = await git(['rev-parse', 'HEAD'], repo);
    await makeSessionBranch('task-a', 'a.txt', 'a\n');
    await makeSessionBranch('task-b', 'b.txt', 'b\n');

    const r1 = await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-a',
      integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: 'a',
    });
    const r2 = await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-b',
      integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: 'b',
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // Both sessions' files are on the integration branch.
    const files = await git(['ls-tree', '-r', '--name-only', 'integration/main'], repo);
    expect(files).toContain('a.txt');
    expect(files).toContain('b.txt');

    // Root checkout is untouched: still on main, same commit, clean.
    expect(await git(['branch', '--show-current'], repo)).toBe('main');
    expect(await git(['rev-parse', 'HEAD'], repo)).toBe(rootHeadBefore);
    expect(await git(['status', '--porcelain'], repo)).toBe('');

    // No leftover integration worktree.
    expect(await git(['worktree', 'list'], repo)).not.toContain('.integration-');
  });

  it('is idempotent — re-integrating the same branch is a no-op', async () => {
    await makeSessionBranch('task-once', 'once.txt', 'once\n');
    const first = await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-once',
      integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: 'o1',
    });
    const second = await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-once',
      integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: 'o2',
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.alreadyIntegrated).toBe(true);
  });

  it('preserves the integration branch on conflict (does not corrupt it)', async () => {
    // First session integrates cleanly.
    await makeSessionBranch('task-clean', 'shared.txt', 'v1\n');
    await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-clean',
      integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: 'c1',
    });
    const intTipAfterClean = await git(['rev-parse', 'integration/main'], repo);

    // Second session edits the same file differently → conflict against integration.
    await git(['checkout', '-q', '-b', 'task-conflict2', 'main'], repo);
    await commitFile('shared.txt', 'v2-conflict\n', 'conflicting edit');
    await git(['checkout', '-q', 'main'], repo);

    const conflict = await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-conflict2',
      integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: 'c2',
    });

    expect(conflict.success).toBe(false);
    expect(conflict.conflictFiles).toContain('shared.txt');
    // Integration branch is unchanged — the aborted merge left no partial commit.
    expect(await git(['rev-parse', 'integration/main'], repo)).toBe(intTipAfterClean);
    expect(await git(['worktree', 'list'], repo)).not.toContain('.integration-');
  });

  it('serializes concurrent integrations without "branch already checked out" races', async () => {
    await makeSessionBranch('task-x', 'x.txt', 'x\n');
    await makeSessionBranch('task-y', 'y.txt', 'y\n');
    await makeSessionBranch('task-z', 'z.txt', 'z\n');

    const results = await Promise.all(
      ['task-x', 'task-y', 'task-z'].map((b, i) =>
        integrateIntoSharedBranch({
          repoRoot: repo, baseDir: '.worktrees', sessionBranch: b,
          integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: `cc${i}`,
        }),
      ),
    );

    expect(results.every((r) => r.success)).toBe(true);
    const files = await git(['ls-tree', '-r', '--name-only', 'integration/main'], repo);
    for (const f of ['x.txt', 'y.txt', 'z.txt']) expect(files).toContain(f);
  });
});

describe('tryAdvanceBaseBranch', () => {
  it('does NOT advance a base branch that is checked out at root', async () => {
    await makeSessionBranch('task-ff', 'ff.txt', 'ff\n');
    await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-ff',
      integrationBranch: 'integration/main', baseBranch: 'main', strategy: 'auto', nonce: 'ff1',
    });
    const mainBefore = await git(['rev-parse', 'main'], repo);

    await expect(isBranchCheckedOut(repo, 'main')).resolves.toBe(true);
    const advanced = await tryAdvanceBaseBranch(repo, 'main', 'integration/main');
    expect(advanced).toBe(false);
    expect(await git(['rev-parse', 'main'], repo)).toBe(mainBefore); // unchanged
  });

  it('fast-forwards a base branch that is NOT checked out anywhere', async () => {
    // `release` exists but is never checked out (root stays on main).
    await git(['branch', 'release', 'main'], repo);
    await makeSessionBranch('task-rel', 'rel.txt', 'rel\n');
    await integrateIntoSharedBranch({
      repoRoot: repo, baseDir: '.worktrees', sessionBranch: 'task-rel',
      integrationBranch: 'integration/release', baseBranch: 'release', strategy: 'auto', nonce: 'rel1',
    });
    const intTip = await git(['rev-parse', 'integration/release'], repo);

    await expect(isBranchCheckedOut(repo, 'release')).resolves.toBe(false);
    const advanced = await tryAdvanceBaseBranch(repo, 'release', 'integration/release');
    expect(advanced).toBe(true);
    expect(await git(['rev-parse', 'release'], repo)).toBe(intTip); // fast-forwarded
  });
});
