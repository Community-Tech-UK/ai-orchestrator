import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { landItemBranch, runPostMergeGate, syncItemWithBase } from './plan-queue-landing';
import type { PlanQueueItem } from './plan-queue.types';

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitOnMain(file: string, content: string): void {
  writeFileSync(join(repo, file), content);
  git(['add', file]);
  git(['commit', '-q', '-m', `main: ${file}`]);
}

/** An item whose worktree holds `files`, committed the way a checkpoint would. */
function makeItemWithWork(files: Record<string, string>, id = 'item-abc123'): PlanQueueItem {
  const branchName = `queue/sample-${id.slice(-6)}`;
  const worktreePath = join(repo, '.worktrees', branchName);
  git(['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(worktreePath, file), content);
  }
  if (Object.keys(files).length > 0) {
    git(['add', '-A'], worktreePath);
    git(['commit', '-q', '--no-verify', '-m', 'checkpoint'], worktreePath);
  }
  return {
    id,
    runId: 'run-1',
    documentPath: join(repo, 'docs/sample_plan.md'),
    state: 'landing',
    round: 1,
    erroredRounds: 0,
    landingRefusals: 0,
    branchName,
    worktreePath,
    baseCommit: git(['rev-parse', 'main']),
    checkpointCommit: git(['rev-parse', 'HEAD'], worktreePath),
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
  };
}

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-land-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  commitOnMain('a.txt', 'base\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  GitWriteQueue._resetForTesting();
});

describe('syncItemWithBase', () => {
  it('reports up-to-date when main has not moved', async () => {
    const item = makeItemWithWork({ 'work.txt': 'work\n' });

    expect(await syncItemWithBase(item, 'main')).toEqual({ status: 'up-to-date' });
  });

  it('merges a moved main into the item branch', async () => {
    const item = makeItemWithWork({ 'work.txt': 'work\n' });
    commitOnMain('other.txt', 'landed by someone else\n');

    const result = await syncItemWithBase(item, 'main');

    expect(result.status).toBe('merged');
    expect(existsSync(join(item.worktreePath ?? '', 'other.txt'))).toBe(true);
    expect(await syncItemWithBase(item, 'main')).toEqual({ status: 'up-to-date' });
  });

  it('leaves a conflict in the worktree for the worker and names the files', async () => {
    const item = makeItemWithWork({ 'a.txt': 'item version\n' });
    commitOnMain('a.txt', 'main version\n');

    const result = await syncItemWithBase(item, 'main');

    expect(result).toEqual({ status: 'conflict', conflictFiles: ['a.txt'] });
    expect(readFileSync(join(item.worktreePath ?? '', 'a.txt'), 'utf8')).toContain('<<<<<<<');
  });
});

describe('runPostMergeGate', () => {
  it('passes when every command exits 0 and stops at the first failure', async () => {
    expect(await runPostMergeGate(['true', 'true'], repo)).toEqual({ ok: true });

    const result = await runPostMergeGate(['true', 'echo broken >&2; exit 3', 'touch never.txt'], repo);

    expect(result).toMatchObject({ ok: false, command: 'echo broken >&2; exit 3' });
    expect(result.ok === false && result.output).toContain('broken');
    expect(existsSync(join(repo, 'never.txt'))).toBe(false);
  });

  it('runs in the given directory', async () => {
    mkdirSync(join(repo, 'sub'));
    await runPostMergeGate(['touch here.txt'], join(repo, 'sub'));

    expect(existsSync(join(repo, 'sub/here.txt'))).toBe(true);
  });
});

describe('landItemBranch', () => {
  it('lands the item as exactly one commit on main, past untracked root documents', async () => {
    const item = makeItemWithWork({ 'one.txt': '1\n' });
    writeFileSync(join(item.worktreePath ?? '', 'two.txt'), '2\n');
    git(['add', '-A'], item.worktreePath ?? '');
    git(['commit', '-q', '--no-verify', '-m', 'checkpoint 2'], item.worktreePath ?? '');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs/sample_plan.md'), '# untracked plan\n');
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'feat: sample (plan queue)');

    expect(result.status).toBe('landed');
    expect(git(['rev-list', '--count', `${mainBefore}..main`])).toBe('1');
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('feat: sample (plan queue)');
    expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual(['one.txt', 'two.txt']);
    expect(existsSync(join(repo, 'one.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'docs/sample_plan.md'), 'utf8')).toBe('# untracked plan\n');
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  it('is a no-op landing when the item changed no tracked files', async () => {
    const item = makeItemWithWork({});
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'unused');

    expect(result).toEqual({ status: 'landed', commit: mainBefore });
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
  });

  it('blocks, changing nothing, when a root file would be overwritten', async () => {
    const item = makeItemWithWork({ 'clash.txt': 'from item\n' });
    writeFileSync(join(repo, 'clash.txt'), 'operator copy\n');
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'feat: clash');

    expect(result).toEqual({
      status: 'blocked',
      reason: 'root checkout has uncommitted changes to a promoted path: clash.txt',
    });
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
    expect(readFileSync(join(repo, 'clash.txt'), 'utf8')).toBe('operator copy\n');
    expect(git(['rev-parse', item.branchName ?? ''])).toBe(item.checkpointCommit);
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  it('reports a conflict when main moved under an unsynced branch', async () => {
    const item = makeItemWithWork({ 'a.txt': 'item version\n' });
    commitOnMain('a.txt', 'main version\n');
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'feat: conflict');

    expect(result).toEqual({ status: 'conflict', conflictFiles: ['a.txt'] });
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  it('converges when re-run after a crash that followed promotion', async () => {
    const item = makeItemWithWork({ 'one.txt': '1\n' });
    const first = await landItemBranch(item, repo, 'main', 'feat: once');
    expect(first.status).toBe('landed');
    const landedCommit = first.status === 'landed' ? first.commit : '';
    const mainAfter = git(['rev-parse', 'main']);

    const again = await landItemBranch({ ...item, landedCommit }, repo, 'main', 'feat: once');

    expect(again).toEqual({ status: 'landed', commit: landedCommit });
    expect(git(['rev-parse', 'main'])).toBe(mainAfter);
  });

  it('rebuilds a stale integration branch left by an interrupted attempt', async () => {
    const item = makeItemWithWork({ 'one.txt': '1\n' });
    git(['branch', `integration/${item.branchName}`, 'main']);
    commitOnMain('other.txt', 'main moved\n');
    await syncItemWithBase(item, 'main');

    const result = await landItemBranch(item, repo, 'main', 'feat: after stale');

    expect(result.status).toBe('landed');
    expect(existsSync(join(repo, 'one.txt'))).toBe(true);
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  describe('the landing commit is made with the repository hooks', () => {
    /** A repo-local hook that overrides the global hooks path for this test repo. */
    function installHook(script: string): void {
      const hooks = join(repo, 'test-hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${script}\n`);
      chmodSync(join(hooks, 'pre-commit'), 0o755);
      git(['config', 'core.hooksPath', hooks]);
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'test-hooks/\n');
    }

    function checkoutState(item: PlanQueueItem): { head: string; branch: string; status: string } {
      const wt = item.worktreePath ?? '';
      return {
        head: git(['rev-parse', 'HEAD'], wt),
        branch: git(['branch', '--show-current'], wt),
        status: git(['status', '--porcelain'], wt),
      };
    }

    it('runs the pre-commit hook, and what the hook stages lands with the commit', async () => {
      installHook('echo generated > generated.txt && git add generated.txt');
      const item = makeItemWithWork({ 'one.txt': '1\n' });

      const result = await landItemBranch(item, repo, 'main', 'feat: hooked');

      expect(result.status).toBe('landed');
      expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual(['generated.txt', 'one.txt']);
      expect(checkoutState(item)).toEqual({ head: item.checkpointCommit, branch: item.branchName, status: '' });
    });

    it('reports a refusing hook with its output, lands nothing, and restores the item checkout', async () => {
      installHook('echo "related tests failed: 2" >&2; exit 1');
      const item = makeItemWithWork({ 'one.txt': '1\n' });
      const mainBefore = git(['rev-parse', 'main']);

      const result = await landItemBranch(item, repo, 'main', 'feat: refused', [
        { relativePath: 'docs/x_plan_completed.md', content: 'closed\n' },
      ]);

      expect(result).toEqual({ status: 'hook-failed', output: expect.stringContaining('related tests failed: 2') });
      expect(git(['rev-parse', 'main'])).toBe(mainBefore);
      expect(checkoutState(item)).toEqual({ head: item.checkpointCommit, branch: item.branchName, status: '' });
      expect(existsSync(join(item.worktreePath ?? '', 'docs/x_plan_completed.md'))).toBe(false);
    });

    it('refuses an item branch carrying active planning documents, but not a standing register', async () => {
      const item = makeItemWithWork({ 'one.txt': '1\n', 'q_plan.md': '# active\n' });
      const mainBefore = git(['rev-parse', 'main']);

      expect(await landItemBranch(item, repo, 'main', 'feat: docs')).toEqual({ status: 'active-documents', paths: ['q_plan.md'] });
      expect(git(['rev-parse', 'main'])).toBe(mainBefore);

      const register = makeItemWithWork({ 'r_livetest.md': '# R\n**Type: standing register**\n' }, 'item-reg999');
      expect((await landItemBranch(register, repo, 'main', 'feat: register')).status).toBe('landed');
    });

    it('lands the closed documents in the same commit as the code', async () => {
      const item = makeItemWithWork({ 'one.txt': '1\n' });

      const result = await landItemBranch(item, repo, 'main', 'Plan: x', [
        { relativePath: 'docs/plans/x_plan_completed.md', content: 'spec: x_spec_completed.md\n' },
        { relativePath: 'docs/plans/x_spec_completed.md', content: 'plan: x_plan_completed.md\n' },
      ]);

      expect(result.status).toBe('landed');
      expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: x', 'main: a.txt']);
      expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual([
        'docs/plans/x_plan_completed.md', 'docs/plans/x_spec_completed.md', 'one.txt',
      ]);
      expect(git(['show', 'main:docs/plans/x_plan_completed.md'])).toBe('spec: x_spec_completed.md');
      expect(checkoutState(item).status).toBe('');
    });

    it('promotes the recorded commit again after a crash between building it and promoting it', async () => {
      const item = makeItemWithWork({ 'clash.txt': 'from item\n' });
      writeFileSync(join(repo, 'clash.txt'), 'operator copy\n');
      let built = '';
      const first = await landItemBranch(item, repo, 'main', 'feat: once', [], (commit) => { built = commit; });
      expect(first.status).toBe('blocked');
      expect(built).not.toBe('');
      rmSync(join(repo, 'clash.txt'));

      const again = await landItemBranch({ ...item, landedCommit: built }, repo, 'main', 'feat: once');

      expect(again).toEqual({ status: 'landed', commit: built });
      expect(git(['rev-parse', 'main'])).toBe(built);
    });

    it('recovers a worktree a crash left on the detached squash state', async () => {
      const item = makeItemWithWork({ 'one.txt': '1\n' });
      const wt = item.worktreePath ?? '';
      git(['checkout', '-q', '--detach', 'main'], wt);
      git(['merge', '--squash', '-q', item.branchName ?? ''], wt);

      const result = await landItemBranch(item, repo, 'main', 'feat: after crash');

      expect(result.status).toBe('landed');
      expect(checkoutState(item)).toEqual({ head: item.checkpointCommit, branch: item.branchName, status: '' });
    });
  });
});
