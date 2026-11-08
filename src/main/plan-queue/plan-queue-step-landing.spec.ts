import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { landedIntegrationStatus } from './plan-queue-document-status';
import { buildLandingCommit } from './plan-queue-squash';

let repo: string;
const git = (args: string[], cwd = repo): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-step-landing-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'big_plan.md'), '# Big\n\n## Step 1. One\n\n## Step 2. Two\n');
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-qm', 'base']);
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); GitWriteQueue._resetForTesting(); });

/** A worker that renamed its plan to the closed name and committed the rename to its branch. */
function branchThatClosesThePlan(): { worktreePath: string; branchName: string } {
  const branchName = 'queue/big-abc123';
  const worktreePath = join(repo, '.worktrees', 'big');
  git(['worktree', 'add', '-qb', branchName, worktreePath]);
  git(['mv', 'docs/big_plan.md', 'docs/big_plan_completed.md'], worktreePath);
  git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-qm', 'close the plan'], worktreePath);
  return { worktreePath, branchName };
}

describe('a step job landing', () => {
  const landing = (stepPlan?: string) => {
    const { worktreePath, branchName } = branchThatClosesThePlan();
    return buildLandingCommit({ repoRoot: repo, worktreePath, branchName, itemId: 'item', baseTip: git(['rev-parse', 'HEAD']),
      message: 'Plan: big (Step 1)', documents: [], greenTestedTree: null, ...(stepPlan ? { stepPlan } : {}) });
  };

  it('is refused when it renamed its plan to the closed name, and nothing is committed', async () => {
    const result = await landing('docs/big_plan.md');
    expect(result).toMatchObject({ status: 'active-documents', paths: ['docs/big_plan_completed.md'], note: expect.stringContaining('never closes the plan') });
    expect(git(['log', '--oneline', 'main'])).not.toContain('Step 1');
  });

  it('is not held to that rule when the job covers the whole document', async () => {
    expect((await landing()).status).toBe('committed');
  });
});

describe('the "On main" line after a step lands', () => {
  it('says only that the step landed, because the other steps may still be open', () => {
    expect(landedIntegrationStatus('# Plan\n', 'queue/x', 'abc1234', 2)).toBe('Step 2 landed (abc1234); the other steps may still be open');
    expect(landedIntegrationStatus('# Plan\n', 'queue/x', 'abc1234')).toBe('yes (abc1234)');
  });
});
