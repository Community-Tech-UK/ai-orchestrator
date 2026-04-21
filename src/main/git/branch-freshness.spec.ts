import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BranchFreshness } from './branch-freshness';

const tempDirs: string[] = [];

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeAndCommit(repoDir: string, fileName: string, content: string, message: string): void {
  fs.writeFileSync(path.join(repoDir, fileName), content);
  runGit(repoDir, 'add', fileName);
  runGit(repoDir, 'commit', '-m', message);
}

describe('BranchFreshness', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies fresh, stale, and diverged branches', async () => {
    const remoteDir = createRepo('branch-freshness-remote-');
    const repoDir = createRepo('branch-freshness-repo-');
    const contributorDir = createRepo('branch-freshness-contrib-');

    runGit(repoDir, 'init', '-b', 'main');
    runGit(repoDir, 'config', 'user.name', 'Test User');
    runGit(repoDir, 'config', 'user.email', 'test@example.com');
    writeAndCommit(repoDir, 'README.md', 'hello\n', 'initial');

    runGit(remoteDir, 'init', '--bare');
    runGit(repoDir, 'remote', 'add', 'origin', remoteDir);
    runGit(repoDir, 'push', '-u', 'origin', 'main');

    const freshness = new BranchFreshness();

    await expect(freshness.inspect(repoDir)).resolves.toMatchObject({
      state: 'fresh',
      branch: 'main',
      upstream: 'origin/main',
      behind: 0,
    });

    runGit(contributorDir, 'clone', remoteDir, '.');
    runGit(contributorDir, 'config', 'user.name', 'Contributor');
    runGit(contributorDir, 'config', 'user.email', 'contrib@example.com');
    writeAndCommit(contributorDir, 'upstream.txt', 'remote change\n', 'remote change');
    runGit(contributorDir, 'push', 'origin', 'main');

    runGit(repoDir, 'fetch', 'origin');

    await expect(freshness.inspect(repoDir)).resolves.toMatchObject({
      state: 'stale',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
    });

    writeAndCommit(repoDir, 'local.txt', 'local change\n', 'local change');

    await expect(freshness.inspect(repoDir)).resolves.toMatchObject({
      state: 'diverged',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 1,
    });
  });

  it('returns not_repo outside git worktrees', async () => {
    const dir = createRepo('branch-freshness-plain-');
    const freshness = new BranchFreshness();

    await expect(freshness.inspect(dir)).resolves.toMatchObject({
      state: 'not_repo',
      branch: null,
      upstream: null,
    });
  });
});
