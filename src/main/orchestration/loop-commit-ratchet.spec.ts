import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hermeticGitEnv } from '../workspace/git/git-env';
import {
  createLoopCommitRatchetHook,
  runLoopCommitRatchet,
  type LoopCommitRatchetRuntimeConfig,
} from './loop-commit-ratchet';
import type { LoopIteration, LoopState } from '../../shared/types/loop.types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: hermeticGitEnv(),
    encoding: 'utf-8',
  });
  return stdout.trim();
}

const enabledConfig = (): LoopCommitRatchetRuntimeConfig => ({
  enabled: true,
  worktreeOnly: true,
  keepPolicy: 'score-improvement',
  resetOnRegression: true,
});

let repo: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'loop-ratchet-'));
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

describe('runLoopCommitRatchet', () => {
  it('does nothing when disabled', async () => {
    const baseline = await git(['rev-parse', 'HEAD'], repo);
    const wt = await addWorktree('ratchet-disabled');
    writeFileSync(join(wt, 'feature.ts'), 'work\n');

    const result = await runLoopCommitRatchet({
      loopRunId: 'loop-disabled',
      workspaceCwd: repo,
      executionCwd: wt,
      lastKeptCommit: baseline,
      previousScore: 0,
      candidateScore: 10,
      message: 'ratchet disabled',
      config: { ...enabledConfig(), enabled: false },
    });

    expect(result.status).toBe('disabled');
    expect(await git(['status', '--porcelain'], wt)).toContain('feature.ts');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(baseline);
  });

  it('refuses to commit or reset the normal checkout', async () => {
    const baseline = await git(['rev-parse', 'HEAD'], repo);
    writeFileSync(join(repo, 'root-change.ts'), 'do not commit this\n');

    const result = await runLoopCommitRatchet({
      loopRunId: 'loop-root',
      workspaceCwd: repo,
      executionCwd: repo,
      lastKeptCommit: baseline,
      previousScore: 0,
      candidateScore: 10,
      message: 'ratchet root',
      config: enabledConfig(),
    });

    expect(result.status).toBe('refused');
    expect(await git(['status', '--porcelain'], repo)).toContain('root-change.ts');
    expect(await git(['rev-parse', 'HEAD'], repo)).toBe(baseline);
  });

  it('refuses a normal checkout subdirectory even when it differs from the workspace path', async () => {
    const baseline = await git(['rev-parse', 'HEAD'], repo);
    const subdir = join(repo, 'nested');
    mkdirSync(subdir);
    writeFileSync(join(subdir, 'sub-change.ts'), 'do not commit this either\n');

    const result = await runLoopCommitRatchet({
      loopRunId: 'loop-subdir',
      workspaceCwd: repo,
      executionCwd: subdir,
      lastKeptCommit: baseline,
      previousScore: 0,
      candidateScore: 10,
      message: 'ratchet subdir',
      config: enabledConfig(),
    });

    expect(result.status).toBe('refused');
    expect(await git(['status', '--porcelain'], repo)).toContain('nested/');
    expect(await git(['rev-parse', 'HEAD'], repo)).toBe(baseline);
  });

  it('commits and keeps a dirty worktree candidate when the score improves', async () => {
    const baseline = await git(['rev-parse', 'HEAD'], repo);
    const wt = await addWorktree('ratchet-keep');
    writeFileSync(join(wt, 'feature.ts'), 'better work\n');

    const result = await runLoopCommitRatchet({
      loopRunId: 'loop-keep',
      workspaceCwd: repo,
      executionCwd: wt,
      lastKeptCommit: baseline,
      previousScore: 0,
      candidateScore: 10,
      message: 'loop loop-keep iteration 1 ratchet',
      config: enabledConfig(),
    });

    expect(result.status).toBe('kept');
    expect(await git(['status', '--porcelain'], wt)).toBe('');
    expect(await git(['log', '-1', '--pretty=%s'], wt)).toBe('loop loop-keep iteration 1 ratchet');
  });

  it('commits then resets a regressing worktree candidate to the last kept commit', async () => {
    const baseline = await git(['rev-parse', 'HEAD'], repo);
    const wt = await addWorktree('ratchet-reset');
    writeFileSync(join(wt, 'bad.ts'), 'regression\n');

    const result = await runLoopCommitRatchet({
      loopRunId: 'loop-reset',
      workspaceCwd: repo,
      executionCwd: wt,
      lastKeptCommit: baseline,
      previousScore: 10,
      candidateScore: 0,
      message: 'loop loop-reset iteration 2 ratchet',
      config: enabledConfig(),
    });

    expect(result.status).toBe('reset');
    expect(await git(['status', '--porcelain'], wt)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(baseline);
    expect(existsSync(join(wt, 'bad.ts'))).toBe(false);
  });
});

describe('createLoopCommitRatchetHook', () => {
  it('passes loop worktree state into the ratchet runner only when the gate is enabled', async () => {
    const calls: unknown[] = [];
    const hook = createLoopCommitRatchetHook({
      run: async (input) => {
        calls.push(input);
        return { status: 'kept', candidateCommit: 'abc123' };
      },
    });
    const state = {
      id: 'loop-hook',
      config: {
        workspaceCwd: repo,
        executionCwd: '/tmp/worktree',
        phase4: { commitRatchet: enabledConfig() },
      },
    } as unknown as LoopState;
    const iteration = {
      seq: 2,
      verifyStatus: 'passed',
      progressVerdict: 'OK',
      testPassCount: 4,
      testFailCount: 0,
    } as unknown as LoopIteration;

    await hook({ state, iteration });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      loopRunId: 'loop-hook',
      workspaceCwd: repo,
      executionCwd: '/tmp/worktree',
      previousScore: 0,
      config: enabledConfig(),
    });
  });
});
