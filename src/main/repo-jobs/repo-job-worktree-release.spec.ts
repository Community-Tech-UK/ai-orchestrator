import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoJobRecord } from '../../shared/types/repo-job.types';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { finishedRepoJobs, releaseFinishedRepoJobFolders } from './repo-job-worktree-release';

vi.setConfig({ testTimeout: 30_000 });

let repo: string;
const git = (args: string[], cwd = repo): string =>
  execFileSync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf8' }).trim();

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'repo-job-release-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

function job(id: string, overrides: Partial<RepoJobRecord> = {}, worktreePath = join(repo, '.worktrees', `repo-job-${id}`)): RepoJobRecord {
  const branchName = `repo-job-${id}`;
  if (!existsSync(worktreePath)) git(['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
  return {
    id, status: 'completed', workingDirectory: repo, repoContext: { gitRoot: repo, isRepo: true },
    resumeWorktree: { sessionId: 'gone-after-restart', worktreePath, branchName, baseBranch: 'main', filesChanged: [], totalAdditions: 0, totalDeletions: 0 },
    ...overrides,
  } as unknown as RepoJobRecord;
}

describe('releaseFinishedRepoJobFolders', () => {
  it('saves leftover output to the branch, removes the folder and keeps the branch', async () => {
    const done = job('done');
    const failed = job('failed', { status: 'failed' });
    writeFileSync(join(failed.resumeWorktree!.worktreePath, 'partial.txt'), 'half-finished output\n');
    const folders = [done, failed].map((j) => j.resumeWorktree!.worktreePath);
    const persisted: string[] = [];

    await expect(releaseFinishedRepoJobFolders([done, failed], (j) => persisted.push(j.id))).resolves.toBe(2);

    expect(folders.map(existsSync)).toEqual([false, false]);
    expect(git(['branch', '--list', 'repo-job-done', 'repo-job-failed']).split('\n').map((b) => b.trim())).toEqual(['repo-job-done', 'repo-job-failed']);
    expect(git(['show', 'repo-job-failed:partial.txt'])).toBe('half-finished output');
    expect([done.resumeWorktree, failed.resumeWorktree]).toEqual([undefined, undefined]);
    expect(persisted).toEqual(['done', 'failed']);
  });

  it('never saves the files Harness copied into the folder to the branch', async () => {
    const copied = job('copied', { status: 'failed' });
    writeFileSync(join(copied.resumeWorktree!.worktreePath, '.env.local'), 'EXAMPLE_PLACEHOLDER=not-a-secret\n');
    writeFileSync(join(copied.resumeWorktree!.worktreePath, '.mise.local.toml'), '[env]\n');
    writeFileSync(join(copied.resumeWorktree!.worktreePath, '.env.production.local'), 'EXAMPLE_PLACEHOLDER=still-not-a-secret\n');
    writeFileSync(join(copied.resumeWorktree!.worktreePath, 'output.txt'), 'job output\n');

    await expect(releaseFinishedRepoJobFolders([copied], () => undefined)).resolves.toBe(1);

    expect(existsSync(copied.resumeWorktree?.worktreePath ?? join(repo, '.worktrees', 'repo-job-copied'))).toBe(false);
    expect(git(['ls-tree', '--name-only', 'repo-job-copied'])).toBe(['.gitignore', 'base.txt', 'output.txt'].join('\n'));
  });

  it('saves an edit to a file the project itself tracks, even when Harness would copy one with that name', async () => {
    writeFileSync(join(repo, 'docker-compose.override.yml'), 'services: {}\n');
    git(['add', 'docker-compose.override.yml']);
    git(['commit', '-q', '-m', 'tracked override']);
    const edited = job('tracked', { status: 'failed' });
    writeFileSync(join(edited.resumeWorktree!.worktreePath, 'docker-compose.override.yml'), 'services: { web: {} }\n');

    await expect(releaseFinishedRepoJobFolders([edited], () => undefined)).resolves.toBe(1);

    expect(git(['show', 'repo-job-tracked:docker-compose.override.yml'])).toBe('services: { web: {} }');
  });

  it('leaves a folder whose merge is still in progress', async () => {
    const merging = job('merging', { status: 'failed' });
    const folder = merging.resumeWorktree!.worktreePath;
    writeFileSync(join(repo, 'base.txt'), 'main side\n');
    git(['commit', '-qam', 'main side']);
    writeFileSync(join(folder, 'base.txt'), 'job side\n');
    git(['commit', '-qam', 'job side'], folder);
    expect(() => git(['merge', 'main'], folder)).toThrow();

    await expect(releaseFinishedRepoJobFolders([merging], () => undefined)).resolves.toBe(0);

    expect(existsSync(folder)).toBe(true);
    expect(merging.resumeWorktree?.worktreePath).toBe(folder);
  });

  it('leaves a folder whose cherry-pick stopped on a conflict', async () => {
    const picking = job('picking', { status: 'failed' });
    const folder = picking.resumeWorktree!.worktreePath;
    writeFileSync(join(repo, 'base.txt'), 'main side\n');
    git(['commit', '-qam', 'main side']);
    writeFileSync(join(folder, 'base.txt'), 'job side\n');
    git(['commit', '-qam', 'job side'], folder);
    expect(() => git(['cherry-pick', 'main'], folder)).toThrow();

    await expect(releaseFinishedRepoJobFolders([picking], () => undefined)).resolves.toBe(0);

    expect(existsSync(folder)).toBe(true);
    expect(git(['log', '-1', '--format=%s', 'repo-job-picking'])).toBe('job side');
  });

  it('leaves a job held for the global pause in its folder', async () => {
    const held = job('held', { status: 'queued', globalPauseHeld: true });
    await expect(releaseFinishedRepoJobFolders([held], () => undefined)).resolves.toBe(0);
    expect(existsSync(held.resumeWorktree!.worktreePath)).toBe(true);
  });

  it('keeps a folder it cannot prove belongs to the job', async () => {
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'repo-job-outside-'))), 'checkout');
    try {
      const stray = job('stray', {}, outside);
      await expect(releaseFinishedRepoJobFolders([stray], () => undefined)).resolves.toBe(0);
      expect(existsSync(outside)).toBe(true);
      expect(stray.resumeWorktree?.worktreePath).toBe(outside);
    } finally { rmSync(join(outside, '..'), { recursive: true, force: true }); }
  });

  it('forgets a folder that is already gone', async () => {
    const gone = job('gone');
    git(['worktree', 'remove', '--force', gone.resumeWorktree!.worktreePath]);
    const persisted: string[] = [];
    await expect(releaseFinishedRepoJobFolders([gone], (j) => persisted.push(j.id))).resolves.toBe(0);
    expect(gone.resumeWorktree).toBeUndefined();
    expect(persisted).toEqual(['gone']);
  });
});

describe('finishedRepoJobs', () => {
  const record = (id: string, status: string) => ({ id, status }) as unknown as RepoJobRecord;

  it('treats a stored running job as finished unless it is live, and prefers the live record', () => {
    const liveDone = record('live-done', 'completed');
    const live = new Map([['live-running', record('live-running', 'running')], ['live-done', liveDone]]);
    const stored = [record('crashed', 'running'), record('live-running', 'running'), record('live-done', 'running'), record('old', 'failed')];

    expect(finishedRepoJobs(stored, live).map((job) => job.id)).toEqual(['crashed', 'live-done', 'old']);
    expect(finishedRepoJobs(stored, live)[1]).toBe(liveDone);
  });
});
