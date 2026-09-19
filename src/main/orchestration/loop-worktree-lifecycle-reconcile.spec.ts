import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { integrateIntoSharedBranch } from '../workspace/git/worktree-integration';
import {
  reconcileManagedWorktreeLifecycles,
  type ManagedLifecycleReconcileStore,
  type PendingManagedWorktreeLifecycle,
} from './loop-worktree-lifecycle-reconcile';
import { GitWriteQueue } from '../workspace/git/git-write-queue';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: hermeticGitEnv(),
    encoding: 'utf-8',
  });
  return stdout.trim();
}

let repo: string;
let worktreePath: string;
let originalSessionTip: string;
let originalIntegrationTip: string;
const branchName = 'task-recovery';

beforeEach(async () => {
  GitWriteQueue._resetForTesting();
  repo = mkdtempSync(join(tmpdir(), 'lifecycle-reconcile-'));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '--no-gpg-sign', '-m', 'base'], repo);

  worktreePath = join(repo, '.worktrees', branchName);
  await git(['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main'], repo);
  writeFileSync(join(worktreePath, 'feature.txt'), 'recovered\n');
  await git(['add', '-A'], worktreePath);
  await git(['commit', '-q', '--no-gpg-sign', '-m', 'session work'], worktreePath);
  originalSessionTip = await git(['rev-parse', branchName], repo);
  await integrateIntoSharedBranch({
    repoRoot: repo,
    baseDir: '.worktrees',
    sessionBranch: branchName,
    integrationBranch: 'integration/main',
    baseBranch: 'main',
    strategy: 'auto',
    nonce: 'reconcile-setup',
  });
  originalIntegrationTip = await git(['rev-parse', 'integration/main'], repo);
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    // noop
  }
});

function fakeStore(): {
  store: ManagedLifecycleReconcileStore;
  row: PendingManagedWorktreeLifecycle;
  cleared: string[];
} {
  const lifecycle: LoopWorktreeLifecycle = {
    managedByAio: true,
    phase: 'integrated',
    baseBranch: 'main',
    sessionBranch: branchName,
    sessionTip: originalSessionTip,
    integrationBranch: 'integration/main',
    integrationTip: originalIntegrationTip,
    updatedAt: 1,
  };
  const row: PendingManagedWorktreeLifecycle = {
    id: 'loop-recovery',
    status: 'completed',
    workspaceCwd: repo,
    worktreePath,
    branchName,
    autoIntegrateWorktree: true,
    lifecycle,
  };
  const cleared: string[] = [];
  return {
    row,
    cleared,
    store: {
      getPendingWorktreeLifecycles: () => [row],
      updateWorktreeLifecycle: (_id, next) => {
        row.lifecycle = next;
      },
      clearWorktreeInfo: (id) => {
        row.worktreePath = null;
        cleared.push(id);
      },
    },
  };
}

describe('reconcileManagedWorktreeLifecycles', () => {
  it('resumes after harvest, integrates, promotes, and cleans up', async () => {
    const { store, row } = fakeStore();
    await git(['branch', '-D', 'integration/main'], repo);
    await git(['update-ref', '-d', 'refs/aio/managed-integrations/integration/main'], repo);
    row.lifecycle.phase = 'harvested';
    row.lifecycle.integrationBranch = undefined;

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('resumes an interrupted integrated phase, promotes main, and cleans up', async () => {
    const { store, row, cleared } = fakeStore();
    const integrationTip = await git(['rev-parse', 'integration/main'], repo);

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(await git(['rev-parse', 'main'], repo)).toBe(integrationTip);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(cleared).toEqual(['loop-recovery']);
  });

  it('finishes cleanup after promotion even when the session branch is already gone', async () => {
    const { store, row } = fakeStore();
    await git(['merge', '--ff-only', 'integration/main'], repo);
    await git(['worktree', 'remove', '--force', worktreePath], repo);
    await git(['branch', '-D', branchName], repo);
    row.worktreePath = null;
    row.lifecycle.phase = 'promoted';

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(await git(['rev-parse', 'main'], repo)).toBe(
      await git(['rev-parse', 'integration/main'], repo),
    );
  });

  it('retries promoted cleanup after a transient pointer-clear failure', async () => {
    const { store, row } = fakeStore();
    let clearAttempts = 0;
    store.clearWorktreeInfo = () => {
      clearAttempts++;
      if (clearAttempts === 1) {
        throw new Error('database temporarily unavailable');
      }
      row.worktreePath = null;
    };

    const first = await reconcileManagedWorktreeLifecycles(store);

    expect(first).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle.phase).toBe('promoted');
    expect(existsSync(worktreePath)).toBe(false);
    expect(await git(['branch', '--list', branchName], repo)).toBe('');

    const second = await reconcileManagedWorktreeLifecycles(store);

    expect(second).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(clearAttempts).toBe(2);
  });

  it('recovers a missing worktree when its durable session branch survives', async () => {
    const { store, row } = fakeStore();
    await git(['branch', '-D', 'integration/main'], repo);
    await git(['update-ref', '-d', 'refs/aio/managed-integrations/integration/main'], repo);
    await git(['worktree', 'remove', '--force', worktreePath], repo);
    row.lifecycle.phase = 'harvesting';

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
  });

  it('blocks a missing-worktree recovery when the recorded branch name was reused', async () => {
    const { store, row, cleared } = fakeStore();
    row.lifecycle.sessionTip = await git(['rev-parse', branchName], repo);
    await git(['worktree', 'remove', '--force', worktreePath], repo);
    await git(['branch', '-D', branchName], repo);
    await git(['branch', branchName, 'main'], repo);
    const replacementTip = await git(['rev-parse', branchName], repo);
    expect(replacementTip).not.toBe(row.lifecycle.sessionTip);

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'Managed session branch identity could not be verified',
    });
    expect(await git(['rev-parse', branchName], repo)).toBe(replacementTip);
    expect(cleared).toEqual([]);
  });

  it('blocks promotion when a persisted integration ref was rewritten', async () => {
    const { store, row, cleared } = fakeStore();
    const mainBefore = await git(['rev-parse', 'main'], repo);
    await git(['update-ref', 'refs/heads/integration/main', mainBefore], repo);

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'Managed integration branch identity could not be verified',
    });
    expect(await git(['rev-parse', 'main'], repo)).toBe(mainBefore);
    expect(existsSync(worktreePath)).toBe(true);
    expect(cleared).toEqual([]);
  });

  it('blocks and retains a worktree when its live ownership cannot be inspected', async () => {
    const { store, row, cleared } = fakeStore();
    await git(['worktree', 'remove', '--force', worktreePath], repo);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), 'gitdir: /definitely/missing/gitdir\n');
    writeFileSync(join(worktreePath, 'unharvested.txt'), 'must survive\n');
    row.lifecycle.phase = 'harvesting';

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'Managed worktree ownership could not be verified',
    });
    expect(existsSync(join(worktreePath, 'unharvested.txt'))).toBe(true);
    expect(cleared).toEqual([]);
  });

  it('promotes past an unrelated untracked root file', async () => {
    const { store, row } = fakeStore();
    const operatorFile = join(repo, 'operator_plan.md');
    writeFileSync(operatorFile, 'operator work\n');

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(await git(['rev-parse', 'main'], repo)).toBe(
      await git(['rev-parse', 'integration/main'], repo),
    );
    expect(existsSync(operatorFile)).toBe(true);
  });

  it('keeps a promotion that overlaps dirty root work blocked and retries it on the next boot', async () => {
    const { store, row } = fakeStore();
    // The session added feature.txt; an untracked root copy of the same path
    // is operator work the promotion would collide with.
    const operatorFile = join(repo, 'feature.txt');
    writeFileSync(operatorFile, 'operator work\n');

    const first = await reconcileManagedWorktreeLifecycles(store);

    expect(first).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'root checkout has uncommitted changes to a promoted path: feature.txt',
    });
    expect(await git(['rev-parse', 'main'], repo)).not.toBe(
      await git(['rev-parse', 'integration/main'], repo),
    );
    expect(existsSync(operatorFile)).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);

    unlinkSync(operatorFile);
    const second = await reconcileManagedWorktreeLifecycles(store);

    expect(second).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(await git(['rev-parse', 'main'], repo)).toBe(
      await git(['rev-parse', 'integration/main'], repo),
    );
  });

  it('captures a dirty worktree at boot even when a pre-commit hook refuses the commit', async () => {
    const { store, row } = fakeStore();
    await git(['branch', '-D', 'integration/main'], repo);
    await git(['update-ref', '-d', 'refs/aio/managed-integrations/integration/main'], repo);
    const hooksDir = join(repo, '.worktrees', 'refusing-hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await git(['config', 'core.hooksPath', hooksDir], repo);
    writeFileSync(join(worktreePath, 'late-output.txt'), 'late\n');
    row.lifecycle = {
      ...row.lifecycle,
      phase: 'harvesting',
      integrationBranch: undefined,
      integrationTip: undefined,
    };

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(await git(['ls-tree', '--name-only', 'main'], repo)).toContain('late-output.txt');
  });

  it('keeps a blocked run blocked when its clean session branch moved outside AIO', async () => {
    const { store, row, cleared } = fakeStore();
    await git(['branch', '-D', 'integration/main'], repo);
    await git(['update-ref', '-d', 'refs/aio/managed-integrations/integration/main'], repo);
    const mainBefore = await git(['rev-parse', 'main'], repo);
    // An operator safety commit on a run whose own harvest had failed.
    writeFileSync(join(worktreePath, 'rescued.txt'), 'rescued\n');
    await git(['add', '-A'], worktreePath);
    await git(['commit', '-q', '--no-gpg-sign', '-m', 'rescue'], worktreePath);
    const rescuedTip = await git(['rev-parse', branchName], repo);
    row.lifecycle = {
      ...row.lifecycle,
      phase: 'blocked',
      integrationBranch: undefined,
      integrationTip: undefined,
      lastError: 'Harvest failed with uncommitted work',
    };

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle).toMatchObject({
      phase: 'blocked',
      sessionTip: originalSessionTip,
      lastError: 'Session branch changed outside AIO; review it before landing',
    });
    expect(await git(['rev-parse', 'main'], repo)).toBe(mainBefore);
    expect(await git(['branch', '--list', 'integration/main'], repo)).toBe('');
    expect(await git(['rev-parse', branchName], repo)).toBe(rescuedTip);
    expect(existsSync(worktreePath)).toBe(true);
    expect(cleared).toEqual([]);
  });

  it('refuses to integrate a session branch that adds active plan documents', async () => {
    const { store, row } = fakeStore();
    await git(['branch', '-D', 'integration/main'], repo);
    await git(['update-ref', '-d', 'refs/aio/managed-integrations/integration/main'], repo);
    const mainBefore = await git(['rev-parse', 'main'], repo);
    mkdirSync(join(worktreePath, 'docs'));
    writeFileSync(join(worktreePath, 'docs', 'feature_plan.md'), '# active plan\n');
    await git(['add', '-A'], worktreePath);
    await git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'plan'], worktreePath);
    row.lifecycle = {
      ...row.lifecycle,
      phase: 'harvested',
      sessionTip: await git(['rev-parse', branchName], repo),
      integrationBranch: undefined,
      integrationTip: undefined,
    };

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'Session adds active plan/spec/livetest documents; land it manually',
    });
    expect(await git(['rev-parse', 'main'], repo)).toBe(mainBefore);
    expect(await git(['branch', '--list', 'integration/main'], repo)).toBe('');
    expect(await git(['branch', '--list', branchName], repo)).toContain(branchName);
  });

  it('preserves a cancelled run branch and removes only its managed directory', async () => {
    const { store, row } = fakeStore();
    await git(['branch', '-D', 'integration/main'], repo);
    await git(['update-ref', '-d', 'refs/aio/managed-integrations/integration/main'], repo);
    row.status = 'cancelled';
    row.lifecycle.phase = 'harvested';

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 1, blocked: 0, total: 1 });
    expect(row.lifecycle.phase).toBe('cleaned');
    expect(existsSync(worktreePath)).toBe(false);
    expect(await git(['branch', '--list', branchName], repo)).toContain(branchName);
  });

  it.each([
    ['a sibling worktree', 'sibling'],
    ['a .claude worktree', 'claude'],
  ])('blocks without removing %s even when persisted metadata claims ownership', async (_label, kind) => {
    const { store, row, cleared } = fakeStore();
    await git(['worktree', 'remove', '--force', worktreePath], repo);
    const externalPath = kind === 'sibling'
      ? `${repo}-pre-existing`
      : join(repo, '.claude', 'worktrees', 'pre-existing');
    const externalBranch = `pre-existing-${kind}`;
    await git(['worktree', 'add', '-q', '-b', externalBranch, externalPath, 'main'], repo);
    row.status = 'cancelled';
    row.worktreePath = externalPath;
    row.branchName = externalBranch;
    row.lifecycle = {
      ...row.lifecycle,
      phase: 'harvested',
      sessionBranch: externalBranch,
    };

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(row.lifecycle).toMatchObject({
      phase: 'blocked',
      lastError: 'Managed worktree ownership could not be verified',
    });
    expect(existsSync(externalPath)).toBe(true);
    expect(await git(['branch', '--list', externalBranch], repo)).toContain(externalBranch);
    expect(cleared).toEqual([]);
    if (kind === 'sibling') {
      rmSync(externalPath, { recursive: true, force: true });
    }
  });

  it('blocks an unowned lifecycle record without touching its managed-looking worktree or branch', async () => {
    const { store, row, cleared } = fakeStore();
    row.status = 'cancelled';
    row.lifecycle = {
      ...row.lifecycle,
      managedByAio: undefined,
      phase: 'harvested',
    };

    const result = await reconcileManagedWorktreeLifecycles(store);

    expect(result).toEqual({ reconciled: 0, blocked: 1, total: 1 });
    expect(existsSync(worktreePath)).toBe(true);
    expect(await git(['branch', '--list', branchName], repo)).toContain(branchName);
    expect(cleared).toEqual([]);
  });
});
